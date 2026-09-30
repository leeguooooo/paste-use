// Read-only access to the Pastyx local history database.
//
// Pastyx keeps the full clipboard history in SQLite on each desktop. paste-use reads that file
// and never the sync API: no sign-in, works offline, and it keeps working once sync is
// end-to-end encrypted and the server only holds ciphertext.
//
//   macOS direct build   ~/Library/Application Support/paste/local-history.sqlite
//   macOS App Store      ~/Library/Containers/com.paste.native/Data/Library/Application Support/paste/…
//   Windows              %LOCALAPPDATA%\Pastyx\history.db
//
// The two desktop schemas differ (the Mac keeps the source app and file references inside the
// `extra` JSON, Windows has columns for them) and older databases lack `title` / `clip_ocr`,
// so every query is built from the columns that are actually there.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const MAC_BUNDLE_ID = "com.paste.native";
export const CLIP_TYPES = ["text", "link", "html", "code", "image", "color", "file"] as const;
export type ClipType = (typeof CLIP_TYPES)[number];
/** Added to automatically captured clips; every other tag is a pinboard. */
export const RESERVED_TAG = "auto";

export type InstallKind = "mac-direct" | "mac-appstore" | "windows" | "custom";

export interface Install {
  kind: InstallKind;
  dir: string;
  db: string;
  images: string;
  config: string;
}

export class PasteDbError extends Error {
  constructor(public code: "missing" | "no-access" | "unreadable", message: string) {
    super(message);
  }
}

function install(kind: InstallKind, dir: string, dbName: string): Install {
  return { kind, dir, db: join(dir, dbName), images: join(dir, "images"), config: join(dir, "config.json") };
}

/** Every place a Pastyx database can live on this platform, whether or not it exists. */
export function candidateInstalls(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Install[] {
  const override = env.PASTE_USE_DB;
  if (typeof override === "string" && override !== "") {
    return [install("custom", dirname(override), basename(override))];
  }
  if (platform === "darwin") {
    return [
      install("mac-direct", join(home, "Library", "Application Support", "paste"), "local-history.sqlite"),
      install(
        "mac-appstore",
        join(home, "Library", "Containers", MAC_BUNDLE_ID, "Data", "Library", "Application Support", "paste"),
        "local-history.sqlite",
      ),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && env.LOCALAPPDATA !== "" ? env.LOCALAPPDATA : join(home, "AppData", "Local");
    return [install("windows", join(local, "Pastyx"), "history.db")];
  }
  return [];
}

function lastWrite(path: string): number {
  let newest = 0;
  for (const p of [path, `${path}-wal`]) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      // absent
    }
  }
  return newest;
}

/** The install to read: the existing database written most recently (direct and App Store builds can coexist). */
export function findInstall(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Install | null {
  const found = candidateInstalls(env, platform, home).filter((c) => existsSync(c.db));
  found.sort((a, b) => lastWrite(b.db) - lastWrite(a.db));
  return found[0] ?? null;
}

// ───────────────────────── app config (privacy settings only) ─────────────────────────

export interface AppPrivacy {
  /** Apps the user told Pastyx to ignore (bundle ids on macOS, exe names on Windows), lower-cased. */
  ignoredApps: string[];
  /** Pastyx's "Skip passwords & sensitive items" setting; null when the config doesn't say. */
  skipConcealed: boolean | null;
  /** Pinboards the app knows, including empty ones. */
  pinboards: string[];
}

/**
 * config.json also holds the sync tokens. Only these three settings are read; nothing else
 * from the file is kept or printed.
 */
export function readAppPrivacy(inst: Install): AppPrivacy {
  const out: AppPrivacy = { ignoredApps: [], skipConcealed: null, pinboards: [] };
  try {
    const raw = JSON.parse(readFileSync(inst.config, "utf8")) as Record<string, unknown>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    out.ignoredApps = strings(raw.ignoredApps).map((s) => s.toLowerCase());
    out.pinboards = strings(raw.pinboards);
    if (typeof raw.skipConcealed === "boolean") out.skipConcealed = raw.skipConcealed;
  } catch {
    // no config, or not JSON: no extra rules
  }
  return out;
}

// ───────────────────────── open ─────────────────────────

export interface Schema {
  columns: Set<string>;
  hasOcr: boolean;
}

export interface PasteDb {
  db: Database;
  install: Install;
  schema: Schema;
  privacy: AppPrivacy;
}

/**
 * Opens the history read-only. The app writes to this file in WAL mode while we read; a
 * read-only connection sees a consistent snapshot and can never change the database.
 * `query_only` is a second lock on the same door.
 */
export function openPasteDb(env: NodeJS.ProcessEnv = process.env): PasteDb {
  const inst = findInstall(env);
  if (inst === null) {
    const where = candidateInstalls(env).map((c) => c.db);
    throw new PasteDbError(
      "missing",
      where.length > 0
        ? `no Pastyx history found (looked in ${where.join(", ")})`
        : "Pastyx runs on macOS and Windows; there is no local history on this platform",
    );
  }
  try {
    const db = new Database(inst.db, { readonly: true });
    db.exec("PRAGMA query_only = 1");
    db.exec("PRAGMA busy_timeout = 3000");
    const columns = new Set((db.query("PRAGMA table_info(clips)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("id")) {
      db.close();
      throw new PasteDbError("unreadable", `${inst.db} has no clips table — not a Pastyx history database`);
    }
    const hasOcr = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'clip_ocr'").get() !== null;
    return { db, install: inst, schema: { columns, hasOcr }, privacy: readAppPrivacy(inst) };
  } catch (error) {
    if (error instanceof PasteDbError) throw error;
    const text = error instanceof Error ? error.message : String(error);
    const code = /unable to open|authorization|not authorized|permission/i.test(text) ? "no-access" : "unreadable";
    throw new PasteDbError(code, `cannot read ${inst.db}: ${text}`);
  }
}

// ───────────────────────── clips ─────────────────────────

export interface FileRef {
  name: string;
  path: string;
  exists: boolean;
}

export interface Clip {
  id: string;
  type: ClipType;
  title: string | null;
  summary: string | null;
  /** Text content; possibly cut to `contentWindow` characters in listings (see `length`). */
  content: string | null;
  /** Full length of the stored content, in characters. */
  length: number;
  source_url: string | null;
  app: string | null;
  app_id: string | null;
  pinboards: string[];
  favorite: boolean;
  device_id: string | null;
  created_at: number;
  /** Text recognised in an image clip (local only). */
  ocr: string | null;
  image: { path: string | null; mime: string | null; width: number | null; height: number | null } | null;
  files: FileRef[] | null;
}

export interface ClipFilter {
  limit?: number;
  types?: ClipType[];
  app?: string;
  pinboard?: string;
  favorites?: boolean;
  sinceMs?: number;
  query?: string;
  /** Characters of content to load per clip; undefined = all. */
  contentWindow?: number;
}

const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
export const isPinboard = (tag: string): boolean => tag !== "" && !same(tag, RESERVED_TAG);

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function selectList(schema: Schema, contentWindow: number | undefined): string {
  const has = (c: string) => schema.columns.has(c);
  const col = (c: string) => (has(c) ? `c.${c}` : `NULL AS ${c}`);
  const content = contentWindow === undefined ? "c.content AS content" : `substr(c.content, 1, ${Math.floor(contentWindow)}) AS content`;
  return [
    "c.id", "c.type", "c.summary", content, "length(c.content) AS content_length",
    "c.source_url", "c.image_path", "c.image_mime", "c.is_favorite", "c.tags", "c.device_id", "c.created_at",
    col("title"), col("extra"), col("source_app_id"), col("source_app_name"), col("source_app_path"),
    col("image_width"), col("image_height"), col("file_refs"),
    schema.hasOcr ? "(SELECT o.text FROM clip_ocr o WHERE o.clip_id = c.id) AS ocr" : "NULL AS ocr",
  ].join(", ");
}

type Row = Record<string, unknown>;

function rowToClip(row: Row, inst: Install): Clip {
  // macOS: `extra` is a JSON object of strings; fileRefs is itself JSON inside it.
  const extra = parseJson<Record<string, unknown>>(row.extra, {});
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const type = (CLIP_TYPES as readonly string[]).includes(String(row.type)) ? (row.type as ClipType) : "text";
  const appPath = str(row.source_app_path);
  const app = str(row.source_app_name) ?? str(extra.sourceAppName);
  const appId = str(row.source_app_id) ?? str(extra.sourceAppBundleId) ?? (appPath ? basename(appPath.replace(/\\/g, "/")) : null);

  let image: Clip["image"] = null;
  if (type === "image") {
    const stored = str(row.image_path);
    // macOS stores a file name inside images/, Windows an absolute path.
    const path = stored === null ? null : isAbsolute(stored) || /^[A-Za-z]:[\\/]/.test(stored) ? stored : join(inst.images, stored);
    image = {
      path: path !== null && existsSync(path) ? path : null,
      mime: str(row.image_mime),
      width: num(row.image_width) ?? num(extra.imageWidth),
      height: num(row.image_height) ?? num(extra.imageHeight),
    };
  }

  let files: FileRef[] | null = null;
  if (type === "file") {
    const refs = parseJson<unknown[]>(str(row.file_refs) ?? str(extra.fileRefs), []);
    files = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (typeof ref !== "object" || ref === null) continue;
      const r = ref as Record<string, unknown>;
      // Swift encodes `name`/`path`, System.Text.Json `Name`/`Path`.
      const path = str(r.path) ?? str(r.Path);
      if (path === null) continue;
      files.push({ name: str(r.name) ?? str(r.Name) ?? basename(path), path, exists: existsSync(path) });
    }
  }

  const content = typeof row.content === "string" ? row.content : null;
  return {
    id: String(row.id),
    type,
    title: str(row.title),
    summary: str(row.summary),
    content,
    length: num(row.content_length) ?? content?.length ?? 0,
    source_url: str(row.source_url),
    app,
    app_id: appId,
    pinboards: parseJson<unknown[]>(row.tags, []).filter((t): t is string => typeof t === "string" && isPinboard(t)),
    favorite: Number(row.is_favorite) === 1,
    device_id: str(row.device_id),
    created_at: num(row.created_at) ?? 0,
    ocr: str(row.ocr),
    image,
    files,
  };
}

/** A clip from an app the user has since told Pastyx to ignore is treated as if it had never been stored. */
function ignored(clip: Clip, privacy: AppPrivacy): boolean {
  if (privacy.ignoredApps.length === 0 || clip.app_id === null) return false;
  return privacy.ignoredApps.includes(clip.app_id.toLowerCase());
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Newest first. Filters that live in JSON (app, pinboard, ignored apps) are applied while streaming rows. */
export function listClips(p: PasteDb, filter: ClipFilter = {}): Clip[] {
  const { schema } = p;
  const where = ["c.is_deleted = 0"];
  const params: (string | number)[] = [];
  if (filter.types && filter.types.length > 0) {
    where.push(`c.type IN (${filter.types.map(() => "?").join(", ")})`);
    params.push(...filter.types);
  }
  if (filter.favorites) where.push("c.is_favorite = 1");
  if (filter.sinceMs !== undefined) {
    where.push("c.created_at >= ?");
    params.push(Math.floor(filter.sinceMs));
  }
  if (filter.query !== undefined && filter.query !== "") {
    const fields = ["c.content", "c.summary", "c.source_url"];
    if (schema.columns.has("title")) fields.push("c.title");
    const parts = fields.map((f) => `${f} LIKE ? ESCAPE '\\'`);
    if (schema.hasOcr) parts.push("EXISTS (SELECT 1 FROM clip_ocr o WHERE o.clip_id = c.id AND o.text LIKE ? ESCAPE '\\')");
    where.push(`(${parts.join(" OR ")})`);
    const needle = `%${likeEscape(filter.query)}%`;
    for (let i = 0; i < parts.length; i++) params.push(needle);
  }
  const order = schema.columns.has("seq") ? "c.created_at DESC, c.seq DESC" : "c.created_at DESC";
  const sql = `SELECT ${selectList(schema, filter.contentWindow)} FROM clips c WHERE ${where.join(" AND ")} ORDER BY ${order}`;
  const limit = filter.limit ?? Number.POSITIVE_INFINITY;
  const app = filter.app?.toLowerCase();
  const out: Clip[] = [];
  for (const row of p.db.query(sql).iterate(...params) as Iterable<Row>) {
    const clip = rowToClip(row, p.install);
    if (ignored(clip, p.privacy)) continue;
    if (app !== undefined && !(clip.app?.toLowerCase().includes(app) || clip.app_id?.toLowerCase().includes(app))) continue;
    if (filter.pinboard !== undefined && !clip.pinboards.some((t) => same(t, filter.pinboard!))) continue;
    out.push(clip);
    if (out.length >= limit) break;
  }
  return out;
}

export type Resolved = { clip: Clip } | { error: "not-found" } | { error: "ambiguous"; matches: Clip[] };

/** `ref` is an index (1 = newest, up to 4 digits) or an id / unique id prefix. Always loads the full content. */
export function resolveClip(p: PasteDb, ref: string): Resolved {
  if (/^\d{1,4}$/.test(ref)) {
    const index = Number(ref);
    if (index < 1) return { error: "not-found" };
    const clip = listClips(p, { limit: index })[index - 1];
    return clip ? { clip } : { error: "not-found" };
  }
  const rows = p.db
    .query(`SELECT ${selectList(p.schema, undefined)} FROM clips c WHERE c.is_deleted = 0 AND c.id LIKE ? ESCAPE '\\' ORDER BY c.created_at DESC LIMIT 9`)
    .all(`${likeEscape(ref)}%`) as Row[];
  const clips = rows.map((r) => rowToClip(r, p.install)).filter((c) => !ignored(c, p.privacy));
  const exact = clips.find((c) => c.id === ref);
  if (exact) return { clip: exact };
  if (clips.length === 0) return { error: "not-found" };
  if (clips.length > 1) return { error: "ambiguous", matches: clips };
  return { clip: clips[0]! };
}

/** The HTML a clip was copied with, when the app kept it. */
export function clipHtml(p: PasteDb, id: string): string | null {
  if (!p.schema.columns.has("content_html")) return null;
  const row = p.db.query("SELECT content_html FROM clips WHERE id = ?").get(id) as { content_html: string | null } | null;
  return row?.content_html ? row.content_html : null;
}

/** The small inline preview of an image clip (a data: URL), for clips whose full image is not on this machine. */
export function clipImagePreview(p: PasteDb, id: string): { mime: string; bytes: Uint8Array } | null {
  if (!p.schema.columns.has("image_preview_data_url")) return null;
  const row = p.db.query("SELECT image_preview_data_url AS u FROM clips WHERE id = ?").get(id) as { u: string | null } | null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(row?.u ?? "");
  if (m === null) return null;
  return { mime: m[1]!.toLowerCase(), bytes: new Uint8Array(Buffer.from(m[2]!, "base64")) };
}

export interface PinboardCount {
  name: string;
  clips: number;
}

/** Pinboards are tags (every tag but `auto`), named without regard to case; empty ones come from the app's config. */
export function listPinboards(p: PasteDb): PinboardCount[] {
  const boards: PinboardCount[] = [];
  const bump = (name: string, by: number) => {
    const found = boards.find((b) => same(b.name, name));
    if (found) found.clips += by;
    else boards.push({ name, clips: by });
  };
  for (const clip of listClips(p, { contentWindow: 0 })) for (const tag of clip.pinboards) bump(tag, 1);
  for (const name of p.privacy.pinboards) if (isPinboard(name)) bump(name, 0);
  return boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export interface Counts {
  clips: number;
  favorites: number;
  newest: number | null;
  by_type: Record<string, number>;
}

export function counts(p: PasteDb): Counts {
  const rows = p.db.query("SELECT type, COUNT(*) AS n, SUM(is_favorite) AS f, MAX(created_at) AS newest FROM clips WHERE is_deleted = 0 GROUP BY type").all() as
    { type: string | null; n: number; f: number | null; newest: number | null }[];
  const out: Counts = { clips: 0, favorites: 0, newest: null, by_type: {} };
  for (const r of rows) {
    out.clips += r.n;
    out.favorites += r.f ?? 0;
    out.by_type[r.type ?? "text"] = r.n;
    if (r.newest !== null && (out.newest === null || r.newest > out.newest)) out.newest = r.newest;
  }
  return out;
}
