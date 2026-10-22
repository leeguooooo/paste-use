#!/usr/bin/env bun
// paste-use — the Pastyx clipboard history for agents: list, search, read and re-copy what the
// user copied, straight from the app's local database (read-only). Part of the *-use family.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ClipboardError, copyFiles, copyImage, copyText } from "./clipboard.ts";
import {
  CLIP_TYPES,
  PasteDbError,
  candidateInstalls,
  clipHtml,
  clipImagePreview,
  counts,
  listClips,
  listPinboards,
  openPasteDb,
  resolveClip,
  type Clip,
  type ClipFilter,
  type ClipType,
  type PasteDb,
} from "./db.ts";
import { redact } from "./redact.ts";
import {
  checkUpgrade,
  detectSkillChannels,
  installerCommand,
  maybeUpdateNotice,
  pluginProvidesSkill,
  refreshSkills,
  runInstaller,
  runUpdateCheck,
  UPDATE_CHECK_COMMAND,
} from "./upgrade.ts";
import { SKILL_MD } from "./skill.ts";

export const VERSION = "0.1.1";
export const DOWNLOAD_URL = "https://paste.leeguoo.com/download";

const HELP = `paste-use ${VERSION} — your Pastyx clipboard history, for agents.

Usage:
  paste-use list [filters] [--limit N] [--chars N] [--json]
      Clips, newest first, one line each: id, age, type, source app, title or first text.
  paste-use search <query> [filters] [--limit N] [--json]
      Clips whose text, title, link or recognised image text contains <query>.
  paste-use get <id|index> [--raw] [--html] [--out <path>] [--json]
      One clip in full. index 1 is the newest clip. Image clips are written to a file
      (--out, or a temp file) and the path is printed; file clips print their paths.
  paste-use last [N] [--json]
      The newest clip in full ("what I just copied"), or the newest N.
  paste-use copy <text> | - | --file <path> | --clip <id|index>
      Put text on the system clipboard (- reads stdin). --clip re-copies an old clip:
      text, an image, or files that are still on disk. Never prints what it copied.
  paste-use pinboards [--json]      Pinboards with clip counts.
  paste-use status [--json]         Which Pastyx history was found, clip counts, whether the
                                    app is running. \`doctor\` is the same command.
  paste-use skill install           Install the agent skill for Claude Code, Codex and ~/.agents.
  paste-use upgrade [--check | --json]
  paste-use version | help

Filters (list, search):
  --type text|link|html|code|image|color|file   (comma-separated for several)
  --app <name>         source app, by part of its name or bundle id
  --pinboard <name>    only clips on that pinboard
  --favorites          only favorites
  --since 2h | 2026-09-30    a duration (s, m, h, d) or a date

Secrets: anything that looks like an API key, token, private key, password or card number is
masked as [redacted:kind] in every read command. --no-redact (or \`get --raw\`, which prints
the clip exactly as copied) turns that off: use it only after the user says so.

paste-use reads the app's local database read-only and never writes it; no sign-in, works
offline. Opt out of the daily update notice: PASTE_USE_NO_UPDATE_CHECK=1.`;

// ───────────────────────── args ─────────────────────────

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["limit", "type", "app", "pinboard", "since", "chars", "out", "file", "clip"]);
const BOOL_FLAGS = new Set(["json", "favorites", "redact", "no-redact", "raw", "html", "check"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(key)) {
        const value = inline ?? argv[++i];
        if (value === undefined) fail(`--${key} needs a value`);
        flags.set(key, value);
      } else if (BOOL_FLAGS.has(key)) {
        flags.set(key, true);
      } else {
        fail(`unknown flag --${key}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message: string, code = 1): never {
  process.stderr.write(`paste-use: ${message}\n`);
  process.exit(code);
}

function flagString(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagInt(p: Parsed, name: string, fallback: number, min = 1): number {
  const raw = flagString(p, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}`);
  return n;
}

/** "30s" / "10m" / "2h" / "7d" → a timestamp that long ago; "2026-09-30" / an ISO time → that moment (local time). */
export function parseSince(raw: string, now = Date.now()): number | null {
  const text = raw.trim();
  const duration = /^(\d+)\s*(s|m|h|d|w)$/i.exec(text);
  if (duration !== null) {
    const unit = duration[2]!.toLowerCase();
    const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return now - Number(duration[1]) * ms;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day !== null) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
    const t = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function filterFrom(p: Parsed): ClipFilter {
  const filter: ClipFilter = {};
  const type = flagString(p, "type");
  if (type !== undefined) {
    const types = type.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
    for (const t of types) {
      if (!(CLIP_TYPES as readonly string[]).includes(t)) fail(`--type takes ${CLIP_TYPES.join(", ")} (got ${t})`);
    }
    filter.types = types as ClipType[];
  }
  const since = flagString(p, "since");
  if (since !== undefined) {
    const ms = parseSince(since);
    if (ms === null) fail(`--since takes a duration (30s, 10m, 2h, 7d) or a date (2026-09-30), got ${since}`);
    filter.sinceMs = ms;
  }
  const app = flagString(p, "app");
  if (app !== undefined) filter.app = app;
  const pinboard = flagString(p, "pinboard");
  if (pinboard !== undefined) filter.pinboard = pinboard;
  if (p.flags.has("favorites")) filter.favorites = true;
  return filter;
}

/** Masking is on unless the caller turned it off. */
function redacting(p: Parsed): boolean {
  return !(p.flags.has("no-redact") || p.flags.has("raw"));
}

// ───────────────────────── rendering ─────────────────────────

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function age(createdAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(createdAt).toISOString().slice(0, 10);
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function cut(text: string, chars: number): string {
  const units = [...text];
  return chars > 0 && units.length > chars ? `${units.slice(0, chars).join("")}…` : text;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Tracks what was masked across one command, for the closing note on stderr. */
class Masker {
  count = 0;
  kinds = new Set<string>();
  constructor(readonly on: boolean) {}

  text(value: string | null): string | null {
    if (value === null || !this.on) return value;
    const r = redact(value);
    this.count += r.count;
    for (const k of r.kinds) this.kinds.add(k);
    return r.text;
  }

  note(): void {
    if (this.count === 0) return;
    process.stderr.write(
      `paste-use: masked ${this.count} secret-looking value${this.count > 1 ? "s" : ""} (${[...this.kinds].join(", ")}). ` +
        "Ask the user before using --no-redact / get --raw.\n",
    );
  }
}

export interface ClipView {
  id: string;
  type: ClipType;
  created_at: string;
  age: string;
  app: string | null;
  title: string | null;
  /** Masked text, cut to the preview length (list/search) or whole (get/last). */
  text: string | null;
  length: number;
  truncated: boolean;
  url: string | null;
  pinboards: string[];
  favorite: boolean;
  /** Text recognised in an image clip. */
  ocr: string | null;
  image: { width: number | null; height: number | null; mime: string | null; on_disk: boolean } | null;
  files: { name: string; path: string; exists: boolean }[] | null;
  /** How many secret-looking values were masked in this clip. */
  redacted: number;
}

/** What a clip looks like on the way out: masked first, then cut — so a cut never exposes half a token. */
export function viewClip(clip: Clip, chars: number, masker: Masker, now = Date.now()): ClipView {
  const before = masker.count;
  const masked = masker.text(clip.content);
  const text = masked === null ? null : cut(masked, chars);
  const ocr = masker.text(clip.ocr);
  const url = clip.source_url !== null && clip.source_url !== clip.content ? masker.text(clip.source_url) : null;
  return {
    id: clip.id,
    type: clip.type,
    created_at: new Date(clip.created_at).toISOString(),
    age: age(clip.created_at, now),
    app: clip.app,
    title: masker.text(clip.title),
    text,
    length: clip.length,
    truncated: text !== null && (text !== masked || clip.length > [...(clip.content ?? "")].length),
    url,
    pinboards: clip.pinboards,
    favorite: clip.favorite,
    ocr: ocr === null ? null : cut(ocr, chars),
    image: clip.image === null ? null : { width: clip.image.width, height: clip.image.height, mime: clip.image.mime, on_disk: clip.image.path !== null },
    files: clip.files,
    redacted: masker.count - before,
  };
}

/** One line per clip: id, age, type, app, then the most useful text. Built to be cheap to read. */
export function compactLine(v: ClipView): string {
  let body: string;
  if (v.type === "image") {
    const size = v.image?.width && v.image.height ? ` ${v.image.width}x${v.image.height}` : "";
    const about = v.title ?? v.ocr;
    body = `[image${size}]${about ? ` ${oneLine(about)}` : ""}`;
  } else if (v.type === "file") {
    body = `[files] ${(v.files && v.files.length > 0 ? v.files.map((f) => f.name) : (v.text ?? "").split("\n")).join(", ")}`;
  } else {
    const text = oneLine(v.text ?? "");
    body = v.title && v.title !== text ? `${oneLine(v.title)} — ${text}` : text;
    if (v.truncated) body += ` (${v.length} chars)`;
  }
  const marks = `${v.favorite ? "★ " : ""}${v.pinboards.map((t) => `#${t} `).join("")}`;
  return `${shortId(v.id)}  ${v.age.padStart(4)}  ${v.type.padEnd(5)}  ${v.app ?? "-"}  ${marks}${body}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function notInstalled(detail: string): never {
  fail(
    `${detail}\nPastyx keeps your clipboard history on this machine; paste-use reads it.\n` +
      `Install Pastyx and copy something once: ${DOWNLOAD_URL}\n(\`paste-use status\` shows where it looked.)`,
    3,
  );
}

function withDb<T>(fn: (p: PasteDb) => T): T {
  let p: PasteDb;
  try {
    p = openPasteDb();
  } catch (error) {
    if (error instanceof PasteDbError && error.code === "missing") notInstalled(error.message);
    fail(error instanceof Error ? error.message : String(error), 3);
  }
  try {
    return fn(p);
  } finally {
    p.db.close();
  }
}

// ───────────────────────── commands ─────────────────────────

function cmdList(p: Parsed, query?: string): void {
  const chars = flagInt(p, "chars", 100, 0);
  const masker = new Masker(redacting(p));
  withDb((db) => {
    const clips = listClips(db, {
      ...filterFrom(p),
      ...(query !== undefined ? { query } : {}),
      limit: flagInt(p, "limit", 20),
      // Mask over a window wider than what is shown, so a secret is never cut in two.
      ...(chars === 0 ? {} : { contentWindow: Math.max(4000, chars * 4) }),
    });
    const views = clips.map((c) => viewClip(c, chars, masker));
    if (p.flags.has("json")) printJson(views);
    else if (views.length === 0) console.log(query !== undefined ? `no clips match "${query}"` : "no clips");
    else for (const v of views) console.log(compactLine(v));
  });
  masker.note();
}

function pick(db: PasteDb, ref: string): Clip {
  const found = resolveClip(db, ref);
  if ("clip" in found) return found.clip;
  if (found.error === "ambiguous") {
    fail(`${ref} matches ${found.matches.length} clips — use more of the id:\n${found.matches.map((c) => `  ${c.id}`).join("\n")}`, 4);
  }
  fail(`no clip ${ref} (see \`paste-use list\`; index 1 is the newest)`, 4);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/bmp": "bmp", "image/tiff": "tiff", "image/svg+xml": "svg", "image/heic": "heic", "image/avif": "avif",
};

/** Copies the clip's image out of the app's folder (never hands out a path inside it). */
function exportImage(db: PasteDb, clip: Clip, out: string | undefined): { path: string; preview_only: boolean } | null {
  const target = (ext: string): string => {
    if (out !== undefined) return resolve(out);
    const dir = join(tmpdir(), "paste-use");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${shortId(clip.id)}.${ext}`);
  };
  if (clip.image?.path) {
    const path = target(extname(clip.image.path).slice(1) || EXT_BY_MIME[clip.image.mime ?? ""] || "png");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(clip.image.path, path);
    return { path, preview_only: false };
  }
  const preview = clipImagePreview(db, clip.id);
  if (preview === null) return null;
  const path = target(EXT_BY_MIME[preview.mime] ?? "png");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, preview.bytes);
  return { path, preview_only: true };
}

function printClip(db: PasteDb, clip: Clip, p: Parsed, masker: Masker, chars: number): void {
  const v = viewClip(clip, chars, masker);
  const head = [shortId(v.id), v.type, v.app, localTime(clip.created_at), v.type === "image" || v.type === "file" ? null : `${v.length} chars`]
    .concat(v.favorite ? ["★"] : [], v.pinboards.map((t) => `#${t}`))
    .filter((x) => x !== null && x !== "");
  console.log(`# ${head.join(" · ")}`);
  if (v.title) console.log(`title: ${v.title}`);
  if (v.url) console.log(`url: ${v.url}`);
  if (v.type === "image") {
    const image = exportImage(db, clip, flagString(p, "out"));
    const size = v.image?.width && v.image.height ? ` (${v.image.width}x${v.image.height})` : "";
    console.log(image === null
      ? "image: not on this machine (synced from another device and not downloaded)"
      : `image: ${image.path}${size}${image.preview_only ? " — small preview only; the full image is not on this machine" : ""}`);
    if (v.ocr) console.log(`text in image:\n${v.ocr}`);
    return;
  }
  if (v.type === "file") {
    if (v.files && v.files.length > 0) for (const f of v.files) console.log(`${f.path}${f.exists ? "" : "  (no longer there)"}`);
    else console.log(`${v.text ?? ""}\n(copied on another device: only the file names are known here)`);
    return;
  }
  console.log(v.text ?? "");
  if (v.truncated) console.log(`… (${v.length} chars in all: paste-use get ${shortId(v.id)})`);
}

function cmdGet(p: Parsed): void {
  const ref = p.positional[0];
  if (ref === undefined) fail("usage: paste-use get <id|index> [--raw] [--html] [--out <path>] [--json]");
  const masker = new Masker(redacting(p));
  withDb((db) => {
    const clip = pick(db, ref);
    if (p.flags.has("html")) {
      const html = clipHtml(db, clip.id);
      if (html === null) fail(`clip ${shortId(clip.id)} has no HTML`, 4);
      process.stdout.write(masker.text(html)!);
      return;
    }
    if (p.flags.has("json")) {
      const image = clip.type === "image" ? exportImage(db, clip, flagString(p, "out")) : null;
      printJson({ ...viewClip(clip, 0, masker), ...(image ? { image_file: image.path, image_preview_only: image.preview_only } : {}) });
      return;
    }
    if (p.flags.has("raw") && clip.type !== "image" && clip.type !== "file") {
      // Exactly what was copied, nothing added: safe to pipe into a file.
      process.stdout.write(clip.content ?? "");
      return;
    }
    printClip(db, clip, p, masker, 0);
  });
  masker.note();
}

function cmdLast(p: Parsed): void {
  const raw = p.positional[0] ?? "1";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail("usage: paste-use last [N] [--json]");
  const chars = flagInt(p, "chars", 2000, 0);
  const masker = new Masker(redacting(p));
  withDb((db) => {
    const clips = listClips(db, { ...filterFrom(p), limit: n });
    if (p.flags.has("json")) return printJson(clips.map((c) => viewClip(c, chars, masker)));
    if (clips.length === 0) return console.log("no clips");
    clips.forEach((clip, i) => {
      if (i > 0) console.log("");
      printClip(db, clip, p, masker, chars);
    });
  });
  masker.note();
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function cmdCopy(p: Parsed): Promise<void> {
  const clipRef = flagString(p, "clip");
  const file = flagString(p, "file");
  const usage = "usage: paste-use copy <text> | - | --file <path> | --clip <id|index>";
  try {
    if (clipRef !== undefined) {
      if (file !== undefined || p.positional.length > 0) fail(usage);
      const done = withDb((db) => {
        const clip = pick(db, clipRef);
        if (clip.type === "image") {
          if (!clip.image?.path) fail(`clip ${shortId(clip.id)}: the full image is not on this machine`, 4);
          copyImage(clip.image.path);
          return `image clip ${shortId(clip.id)}`;
        }
        if (clip.type === "file") {
          const paths = (clip.files ?? []).filter((f) => f.exists).map((f) => f.path);
          copyFiles(paths);
          return `${paths.length} file${paths.length > 1 ? "s" : ""} from clip ${shortId(clip.id)}`;
        }
        copyText(clip.content ?? "");
        return `clip ${shortId(clip.id)} (${clip.type}, ${clip.length} chars)`;
      });
      console.log(`copied ${done} to the clipboard`);
      return;
    }
    let text: string;
    if (file !== undefined) {
      if (p.positional.length > 0) fail(usage);
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (p.positional.length === 1 && p.positional[0] === "-") {
      text = await readStdin();
    } else if (p.positional.length > 0) {
      text = p.positional.join(" ");
    } else {
      fail(usage);
    }
    copyText(text);
    console.log(`copied ${[...text].length} chars to the clipboard`);
  } catch (error) {
    if (error instanceof ClipboardError) fail(error.message, 5);
    throw error;
  }
}

function cmdPinboards(p: Parsed): void {
  withDb((db) => {
    const boards = listPinboards(db);
    if (p.flags.has("json")) return printJson(boards);
    if (boards.length === 0) return console.log("no pinboards");
    for (const b of boards) console.log(`${String(b.clips).padStart(5)}  ${b.name}`);
  });
}

function appRunning(): boolean | null {
  if (process.platform === "darwin") {
    const out = spawnSync("/usr/bin/pgrep", ["-x", "Pastyx"], { encoding: "utf8" });
    return out.error ? null : out.status === 0;
  }
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Pastyx.exe", "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
    return out.error ? null : /Pastyx\.exe/i.test(String(out.stdout));
  }
  return null;
}

function appVersion(): { path: string; version: string | null } | null {
  if (process.platform !== "darwin") return null;
  for (const app of ["/Applications/Pastyx.app", join(homedir(), "Applications", "Pastyx.app")]) {
    const plist = join(app, "Contents", "Info.plist");
    if (!existsSync(plist)) continue;
    const out = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], { encoding: "utf8" });
    return { path: app, version: out.status === 0 ? String(out.stdout).trim() : null };
  }
  return null;
}

function cmdStatus(p: Parsed): void {
  const app = appVersion();
  const running = appRunning();
  const looked = candidateInstalls().map((c) => c.db);
  let db: PasteDb | null = null;
  let problem: string | null = null;
  try {
    db = openPasteDb();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const base = { name: "paste-use", version: VERSION, app: app?.path ?? null, app_version: app?.version ?? null, app_running: running, looked_in: looked };
  if (db === null) {
    if (p.flags.has("json")) printJson({ ...base, found: false, error: problem, download: DOWNLOAD_URL });
    else {
      console.log(`paste-use ${VERSION}`);
      console.log(`  ✗  ${problem}`);
      for (const path of looked) console.log(`     looked in ${path}`);
      console.log(app === null
        ? `  →  Pastyx isn't installed. Get it: ${DOWNLOAD_URL}`
        : `  →  ${app.path} is installed; open it and copy something once, then run this again.`);
    }
    process.exitCode = 3;
    return;
  }
  try {
    const c = counts(db);
    const boards = listPinboards(db).length;
    const size = statSync(db.install.db).size;
    const { privacy, schema, install } = db;
    if (p.flags.has("json")) {
      printJson({
        ...base,
        found: true,
        install: install.kind,
        database: install.db,
        database_bytes: size,
        read_only: true,
        clips: c.clips,
        favorites: c.favorites,
        by_type: c.by_type,
        pinboards: boards,
        newest_clip_at: c.newest === null ? null : new Date(c.newest).toISOString(),
        image_text_search: schema.hasOcr,
        titles: schema.columns.has("title"),
        ignored_apps: privacy.ignoredApps.length,
        app_skips_concealed: privacy.skipConcealed,
      });
      return;
    }
    const ok = (line: string) => console.log(`  ✓  ${line}`);
    const warn = (line: string) => console.log(`  !  ${line}`);
    console.log(`paste-use ${VERSION}`);
    ok(`Pastyx history (${install.kind}): ${install.db} — ${(size / 1_048_576).toFixed(1)} MB, opened read-only`);
    ok(`${c.clips} clips (${Object.entries(c.by_type).map(([t, n]) => `${n} ${t}`).join(", ")}), ${c.favorites} favorites, ${boards} pinboards`);
    if (c.newest !== null) ok(`newest clip ${age(c.newest)} ago`);
    if (app !== null) ok(`${app.path}${app.version ? ` ${app.version}` : ""}`);
    if (running === true) ok("Pastyx is running: new copies are being recorded");
    else if (running === false) warn("Pastyx is not running: the history stops at the last time it ran, and `paste-use copy` won't be recorded");
    if (!schema.hasOcr) warn("this history has no image text yet (older Pastyx): search won't look inside images");
    if (privacy.ignoredApps.length > 0) ok(`clips from the ${privacy.ignoredApps.length} apps Pastyx is set to ignore are hidden`);
    if (privacy.skipConcealed === false) {
      warn("Pastyx's \"Skip passwords & sensitive items\" is off, so passwords copied from password managers are in the history; paste-use masks what looks like a secret, but turning that setting on is safer");
    }
  } finally {
    db.db.close();
  }
}

function installSkill(): void {
  const home = homedir();
  for (const [host, dir] of [["claude", join(home, ".claude", "skills", "paste-use")], ["codex", join(home, ".codex", "skills", "paste-use")]] as const) {
    const path = join(dir, "SKILL.md");
    if (pluginProvidesSkill(host, home)) {
      // Remove only a copy this command wrote: a lone SKILL.md identical to the embedded one.
      try {
        if (readdirSync(dir).join() === "SKILL.md" && readFileSync(path, "utf8") === SKILL_MD) {
          rmSync(dir, { recursive: true });
          console.log(`skill copy removed: ${dir} (the ${host === "claude" ? "Claude Code" : "Codex"} plugin provides it)`);
          continue;
        }
      } catch {
        // no earlier copy
      }
      console.log(`skill skipped: ${dir} (the ${host === "claude" ? "Claude Code" : "Codex"} plugin provides it)`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (readFileSync(path, "utf8") === SKILL_MD) {
        console.log(`skill up to date: ${path}`);
        continue;
      }
    } catch {
      // missing: write it
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, SKILL_MD, { flag: "wx", mode: 0o644 });
      renameSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // renamed
      }
    }
    console.log(`skill installed: ${path}`);
  }
}

async function cmdUpgrade(p: Parsed): Promise<void> {
  const check = await checkUpgrade(VERSION);
  if (p.flags.has("json")) {
    printJson({
      name: "paste-use",
      current: VERSION,
      latest: check.status === "unknown" ? null : check.latest.replace(/^v/, ""),
      update_available: check.status === "behind",
      skills: detectSkillChannels(),
      ...(check.status === "unknown" ? { error: check.error } : {}),
    });
    if (check.status === "unknown") process.exitCode = 2;
    return;
  }
  if (check.status === "unknown") fail(`could not determine the latest release: ${check.error}`, 2);
  if (p.flags.has("check")) {
    console.log(check.status === "behind"
      ? `paste-use ${VERSION} -> ${check.latest.replace(/^v/, "")}`
      : `paste-use ${VERSION} is up to date`);
    return;
  }
  if (check.status !== "behind") {
    console.log(`paste-use ${VERSION} is up to date`);
    return;
  }
  console.log(`paste-use ${VERSION} -> ${check.latest}; running ${installerCommand().slice(-1)[0]}`);
  const run = runInstaller();
  if (run.code !== 0) fail(`installer failed (exit ${run.code ?? "spawn-failed"}); the installed binary is unchanged`, run.code ?? 1);
  for (const line of refreshSkills(detectSkillChannels())) console.log(line);
  console.log("upgrade complete");
}

function selfCommand(): string[] {
  const script = process.argv[1];
  const runtime = process.execPath.split(/[\\/]/).pop()!.toLowerCase();
  return (runtime === "bun" || runtime === "bun.exe") && typeof script === "string" && existsSync(script)
    ? [process.execPath, script]
    : [process.execPath];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const p = parseArgs(rest);
  maybeUpdateNotice(VERSION, command, selfCommand());
  switch (command) {
    case "list":
    case "ls":
      return cmdList(p);
    case "search": {
      const query = p.positional.join(" ");
      if (query === "") fail("usage: paste-use search <query> [filters] [--limit N] [--json]");
      return cmdList(p, query);
    }
    case "get": return cmdGet(p);
    case "last": return cmdLast(p);
    case "copy": return cmdCopy(p);
    case "pinboards": return cmdPinboards(p);
    case "pin":
      fail("pinning isn't available: Pastyx has no entry point for it yet, and paste-use never writes the app's database. Pin the clip in Pastyx.");
    case "status":
    case "doctor":
      return cmdStatus(p);
    case "skill":
      if (p.positional[0] !== "install") fail("usage: paste-use skill install");
      return installSkill();
    case "upgrade": return cmdUpgrade(p);
    case UPDATE_CHECK_COMMAND: return runUpdateCheck();
    case "version":
    case "--version":
      console.log(`paste-use ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

if (import.meta.main) await main();
