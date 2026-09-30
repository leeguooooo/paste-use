import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateInstalls, findInstall, listClips, listPinboards, openPasteDb, resolveClip } from "../src/db.ts";
import { age, compactLine, parseSince, shortId } from "../src/cli.ts";
import { looksLikeBarePassword, luhnValid, redact } from "../src/redact.ts";
import { compareVersions, installerCommand, parseVersion } from "../src/upgrade.ts";
import { SKILL_MD } from "../src/skill.ts";
import { FAKE_CARD, FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY, FAKE_PASSWORD, PNG, makeFixture, type Shape } from "./fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function run(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const out = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", input });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

// ───────────────────────── redaction ─────────────────────────

describe("redact", () => {
  test("masks known token shapes and says what they were", () => {
    const r = redact(`token ${FAKE_GITHUB_TOKEN} and ${FAKE_OPENAI_KEY}`);
    expect(r.text).not.toContain(FAKE_GITHUB_TOKEN);
    expect(r.text).not.toContain(FAKE_OPENAI_KEY);
    expect(r.text).toContain("[redacted:github-token]");
    expect(r.count).toBe(2);
  });

  test("key=value keeps the key and drops the value", () => {
    expect(redact("DB_PASSWORD=hunter2hunter2").text).toBe("DB_PASSWORD=[redacted:credential]");
    expect(redact('{"api_key": "abcd1234efgh"}').text).toBe('{"api_key": "[redacted:credential]"}');
    expect(redact("密码：abc12345").text).toBe("密码：[redacted:credential]");
  });

  test("private keys, JWTs, bearer tokens, URL passwords", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`key:\n${pem}\nend`).text).toBe("key:\n[redacted:private-key]\nend");
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
    expect(redact(jwt).text).toBe("[redacted:jwt]");
    expect(redact("Authorization: Bearer abcdefghij0123456789").text).not.toContain("abcdefghij0123456789");
    expect(redact("postgres://admin:s3cretpw@db.internal:5432/app").text).toBe("postgres://admin:[redacted:url-password]@db.internal:5432/app");
  });

  test("card numbers need a valid Luhn checksum", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(redact(`pay with ${FAKE_CARD} today`).text).toBe("pay with [redacted:card-number] today");
    expect(redact("order 1234567890123456").count).toBe(0);
  });

  test("a bare password-shaped clip is masked whole; code and prose are not", () => {
    expect(looksLikeBarePassword(FAKE_PASSWORD)).toBe(true);
    expect(redact(FAKE_PASSWORD).text).toBe("[redacted:possible-password]");
    for (const plain of ["getItem(0)", "HistoryStore.swift", "hello world", "https://example.com/A1?b=2", "paste-use@0.1.0"]) {
      expect(looksLikeBarePassword(plain)).toBe(false);
    }
  });

  test("leaves ordinary text, git SHAs and UUIDs alone", () => {
    for (const plain of [
      "The quick brown fox, 2026-09-30, call 555-0100.",
      "commit 402bcaf9d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
      "aaaa1111-0000-4000-8000-000000000001",
      "const total = items.reduce((sum, item) => sum + item.price, 0);",
    ]) {
      expect(redact(plain)).toEqual({ text: plain, count: 0, kinds: [] });
    }
  });
});

// ───────────────────────── database shapes ─────────────────────────

describe.each(["mac", "mac-old", "windows"] as Shape[])("%s database", (shape) => {
  const fx = makeFixture(shape);
  const open = () => openPasteDb(fx.env);

  test("lists newest first and never shows deleted clips", () => {
    const p = open();
    const clips = listClips(p);
    p.db.close();
    expect(clips.map((c) => c.id.slice(0, 4))).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "abab", "abab"]);
    expect(clips[0]!.app).toBe("Safari");
    expect(clips[2]!.favorite).toBe(true);
  });

  test("filters: type, app, pinboard (case-insensitive), favorites, since", () => {
    const p = open();
    const ids = (f: Parameters<typeof listClips>[1]) => listClips(p, f).map((c) => c.id.slice(0, 4));
    expect(ids({ types: ["link", "code"] })).toEqual(["bbbb", "cccc"]);
    expect(ids({ app: "safari" })).toEqual(["aaaa", "cccc"]);
    expect(ids({ pinboard: "snippets" })).toEqual(["bbbb", "abab"]);
    expect(ids({ favorites: true })).toEqual(["cccc"]);
    expect(ids({ sinceMs: Date.UTC(2026, 8, 30, 11, 0, 0) })).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(ids({ limit: 2 })).toEqual(["aaaa", "bbbb"]);
    p.db.close();
  });

  test("search matches content, link and — where the schema has them — title and image text", () => {
    const p = open();
    const ids = (query: string) => listClips(p, { query }).map((c) => c.id.slice(0, 4));
    expect(ids("clipboard")).toEqual(["aaaa"]);
    expect(ids("docs/install")).toEqual(["cccc"]);
    expect(ids("100%")).toEqual([]);
    expect(ids("deploy env")).toEqual(shape === "mac-old" ? [] : ["bbbb"]);
    expect(ids("revenue")).toEqual(shape === "mac-old" ? [] : ["dddd"]);
    p.db.close();
  });

  test("resolves by index and by id prefix", () => {
    const p = open();
    expect(resolveClip(p, "1")).toMatchObject({ clip: { id: "aaaa1111-0000-4000-8000-000000000001" } });
    expect(resolveClip(p, "cccc3333")).toMatchObject({ clip: { type: "link" } });
    expect(resolveClip(p, "abab")).toMatchObject({ error: "ambiguous" });
    expect(resolveClip(p, "dead9999")).toEqual({ error: "not-found" });
    expect(resolveClip(p, "99")).toEqual({ error: "not-found" });
    p.db.close();
  });

  test("image and file clips carry their local paths", () => {
    const p = open();
    const image = resolveClip(p, "dddd4444");
    const file = resolveClip(p, "eeee5555");
    p.db.close();
    if (!("clip" in image) || !("clip" in file)) throw new Error("not found");
    expect(image.clip.image).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    expect(existsSync(image.clip.image!.path!)).toBe(true);
    expect(file.clip.files).toEqual([
      { name: "report.pdf", path: fx.existingFile, exists: true },
      { name: "gone.txt", path: join(fx.dir, "gone.txt"), exists: false },
    ]);
  });

  test("pinboards: tags except `auto`, merged without regard to case, plus empty ones from config", () => {
    const p = open();
    expect(listPinboards(p)).toEqual([
      { name: "Empty board", clips: 0 },
      { name: "Snippets", clips: 2 },
      { name: "Work", clips: 1 },
    ]);
    p.db.close();
  });

  test("the connection cannot write", () => {
    const p = open();
    expect(() => p.db.exec("DELETE FROM clips")).toThrow();
    expect(() => p.db.exec("UPDATE clips SET is_favorite = 1")).toThrow();
    p.db.close();
  });
});

test("clips from apps Pastyx is set to ignore are hidden everywhere", () => {
  const fx = makeFixture("mac", { ignoredApps: ["com.1password.1password"] });
  const p = openPasteDb(fx.env);
  expect(listClips(p).some((c) => c.app === "1Password")).toBe(false);
  expect(resolveClip(p, "ffff6666")).toEqual({ error: "not-found" });
  p.db.close();
  const win = makeFixture("windows", { ignoredApps: ["1Password.exe"] });
  const w = openPasteDb(win.env);
  expect(listClips(w).some((c) => c.app === "1Password")).toBe(false);
  w.db.close();
});

test("install discovery: per-platform paths, newest database wins, override", () => {
  const mac = candidateInstalls({}, "darwin", "/Users/x");
  expect(mac.map((c) => c.db)).toEqual([
    "/Users/x/Library/Application Support/paste/local-history.sqlite",
    "/Users/x/Library/Containers/com.paste.native/Data/Library/Application Support/paste/local-history.sqlite",
  ]);
  const win = candidateInstalls({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32", "C:\\Users\\x");
  expect(win[0]!.kind).toBe("windows");
  expect(win[0]!.db).toContain("Pastyx");
  expect(win[0]!.db.endsWith("history.db")).toBe(true);
  expect(candidateInstalls({}, "linux", "/home/x")).toEqual([]);
  expect(findInstall({}, "darwin", mkdtempSync(join(tmpdir(), "paste-use-empty-")))).toBeNull();
  const fx = makeFixture("mac");
  expect(findInstall(fx.env)).toMatchObject({ kind: "custom", db: fx.db });
});

// ───────────────────────── helpers ─────────────────────────

test("parseSince: durations and dates", () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  expect(parseSince("2h", now)).toBe(now - 7_200_000);
  expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
  expect(parseSince("2026-09-30", now)).toBe(new Date(2026, 8, 30).getTime());
  expect(parseSince("yesterday", now)).toBeNull();
  expect(parseSince("2", now)).toBeNull();
});

test("age and short id", () => {
  const now = 1_800_000_000_000;
  expect(age(now - 30_000, now)).toBe("30s");
  expect(age(now - 5 * 60_000, now)).toBe("5m");
  expect(age(now - 3 * 3_600_000, now)).toBe("3h");
  expect(age(now - 40 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(shortId("aaaa1111-0000-4000-8000-000000000001")).toBe("aaaa1111");
});

test("upgrade plumbing: version order and the per-platform installer", () => {
  expect(compareVersions(parseVersion("v0.1.0")!, parseVersion("0.2.0")!)).toBe(-1);
  expect(installerCommand({}, "darwin").join(" ")).toContain("install.sh | sh");
  expect(installerCommand({}, "win32").join(" ")).toContain("install.ps1 | iex");
});

test("the embedded skill is SKILL.md", () => {
  expect(SKILL_MD).toBe(readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8"));
  expect(SKILL_MD.startsWith("---\nname: paste-use\n")).toBe(true);
});

// ───────────────────────── the CLI, end to end ─────────────────────────

describe("cli", () => {
  const fx = makeFixture("mac", { skipConcealed: false });

  test("list is one line per clip and masks secrets by default", () => {
    const out = run(fx.env, ["list"]);
    expect(out.code).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^aaaa1111 +\d+\w+ +text +Safari +hello from the clipboard second line$/);
    expect(out.stdout).not.toContain(FAKE_GITHUB_TOKEN);
    expect(out.stdout).not.toContain(FAKE_OPENAI_KEY);
    expect(out.stdout).not.toContain(FAKE_PASSWORD);
    expect(out.stdout).not.toContain(FAKE_CARD);
    expect(out.stdout).toContain("[redacted:");
    expect(out.stdout).toContain("#Snippets");
    expect(out.stdout).toContain("[image 1x1] Quarterly revenue chart");
    expect(out.stdout).toContain("[files] report.pdf, gone.txt");
    expect(out.stdout).toContain("(6400 chars)");
    expect(out.stderr).toContain("masked");
    expect(out.stdout + out.stderr).not.toContain("must-never-be-printed");
  });

  test("--no-redact shows the real values", () => {
    const out = run(fx.env, ["list", "--no-redact", "--chars", "0"]);
    expect(out.stdout).toContain(FAKE_GITHUB_TOKEN);
    expect(out.stdout).toContain(FAKE_PASSWORD);
    expect(out.stderr).not.toContain("masked");
  });

  test("list --json is structured and still masked", () => {
    const out = run(fx.env, ["list", "--json", "--limit", "2"]);
    const clips = JSON.parse(out.stdout) as { id: string; text: string; redacted: number; app: string; pinboards: string[] }[];
    expect(clips).toHaveLength(2);
    expect(clips[1]).toMatchObject({ id: "bbbb2222-0000-4000-8000-000000000002", app: "Terminal", pinboards: ["Snippets"] });
    expect(clips[1]!.redacted).toBeGreaterThan(0);
    expect(out.stdout).not.toContain(FAKE_GITHUB_TOKEN);
  });

  test("search finds text inside images", () => {
    const out = run(fx.env, ["search", "revenue"]);
    expect(out.stdout.trim().split("\n")).toHaveLength(1);
    expect(out.stdout).toContain("dddd4444");
    expect(run(fx.env, ["search", "no-such-thing"]).stdout).toContain("no clips match");
  });

  test("get: masked by default, --raw is the clip exactly as copied", () => {
    const masked = run(fx.env, ["get", "bbbb2222"]);
    expect(masked.stdout).toContain("# bbbb2222 · code · Terminal");
    expect(masked.stdout).toContain("title: deploy env");
    expect(masked.stdout).toContain("export GITHUB_TOKEN=[redacted:");
    expect(masked.stdout).not.toContain(FAKE_GITHUB_TOKEN);
    expect(masked.stderr).toContain("Ask the user");
    const raw = run(fx.env, ["get", "2", "--raw"]);
    expect(raw.stdout).toBe(`export GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\ncurl -H "Authorization: Bearer ${FAKE_OPENAI_KEY}" https://api.example.com`);
    expect(raw.stderr).toBe("");
  });

  test("get prints long clips whole; last cuts them and says so", () => {
    expect(run(fx.env, ["get", "abab8888"]).stdout.length).toBeGreaterThan(6400);
    const last = run(fx.env, ["last", "8"]);
    expect(last.stdout).toContain("6400 chars in all: paste-use get abab8888");
  });

  test("last is the newest clip in full", () => {
    const out = run(fx.env, ["last"]);
    expect(out.stdout).toContain("# aaaa1111 · text · Safari");
    expect(out.stdout).toContain("hello from the clipboard\nsecond line");
  });

  test("get on an image writes a copy and prints its path; --out chooses it", () => {
    const out = run(fx.env, ["get", "dddd4444"]);
    const path = /^image: (\S+) \(1x1\)$/m.exec(out.stdout)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(fx.dir)).toBe(false);
    expect(readFileSync(path!).equals(PNG)).toBe(true);
    expect(out.stdout).toContain("text in image:\nQuarterly revenue chart");
    const target = join(mkdtempSync(join(tmpdir(), "paste-use-out-")), "shot.png");
    expect(run(fx.env, ["get", "dddd4444", "--out", target]).stdout).toContain(`image: ${target}`);
    expect(readFileSync(target).equals(PNG)).toBe(true);
  });

  test("get on a file clip prints the paths and which are gone", () => {
    const out = run(fx.env, ["get", "eeee5555"]);
    expect(out.stdout).toContain(`${fx.existingFile}\n`);
    expect(out.stdout).toContain("gone.txt  (no longer there)");
  });

  test("pinboards, and pin is refused with the reason", () => {
    expect(run(fx.env, ["pinboards"]).stdout).toBe("    0  Empty board\n    2  Snippets\n    1  Work\n");
    const pin = run(fx.env, ["pin", "aaaa1111", "Work"]);
    expect(pin.code).toBe(1);
    expect(pin.stderr).toContain("never writes the app's database");
  });

  test("status reports the history and warns when the app keeps concealed items", () => {
    const out = run(fx.env, ["status"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("8 clips");
    expect(out.stdout).toContain("opened read-only");
    expect(out.stdout).toContain("Skip passwords & sensitive items");
    const json = JSON.parse(run(fx.env, ["status", "--json"]).stdout);
    expect(json).toMatchObject({ found: true, install: "custom", clips: 8, favorites: 1, pinboards: 3, image_text_search: true, app_skips_concealed: false });
    expect(JSON.stringify(json)).not.toContain("must-never-be-printed");
  });

  test("exit codes: 4 unknown clip, 3 with a download link when Pastyx isn't there", () => {
    expect(run(fx.env, ["get", "zzzz"]).code).toBe(4);
    const missing = { ...fx.env, PASTE_USE_DB: join(tmpdir(), "paste-use-nope", "local-history.sqlite") };
    const out = run(missing, ["list"]);
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("https://paste.leeguoo.com/download");
    const status = run(missing, ["status"]);
    expect(status.code).toBe(3);
    expect(status.stdout).toContain("looked in");
  });

  test("bad input is rejected", () => {
    expect(run(fx.env, ["list", "--type", "video"]).code).toBe(1);
    expect(run(fx.env, ["list", "--since", "soon"]).code).toBe(1);
    expect(run(fx.env, ["list", "--bogus"]).code).toBe(1);
    expect(run(fx.env, ["frobnicate"]).code).toBe(1);
  });

  test("reading leaves the database byte-for-byte alone", () => {
    const before = { size: statSync(fx.db).size, mtime: statSync(fx.db).mtimeMs, bytes: readFileSync(fx.db) };
    for (const args of [["list"], ["search", "a"], ["get", "1"], ["last", "3"], ["pinboards"], ["status"]]) run(fx.env, args);
    expect(statSync(fx.db).size).toBe(before.size);
    expect(statSync(fx.db).mtimeMs).toBe(before.mtime);
    expect(readFileSync(fx.db).equals(before.bytes)).toBe(true);
    const db = new Database(fx.db, { readonly: true });
    expect((db.query("SELECT COUNT(*) AS n FROM clips").get() as { n: number }).n).toBe(9);
    db.close();
  });

  test("an old database (no title, no image text) still works", () => {
    const old = makeFixture("mac-old");
    const list = run(old.env, ["list"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim().split("\n")).toHaveLength(8);
    expect(list.stdout).toContain("[image 1x1]");
    expect(run(old.env, ["get", "bbbb2222"]).stdout).not.toContain("title:");
    expect(run(old.env, ["status"]).stdout).toContain("no image text yet");
  });
});

// ───────────────────────── clipboard (macOS, on a private pasteboard) ─────────────────────────

// A uniquely named pasteboard: the test never touches the user's real clipboard, and Pastyx
// (which watches the general pasteboard) records nothing.
describe.skipIf(process.platform !== "darwin")("copy", () => {
  const board = `paste-use-test-${process.pid}-${Date.now()}`;
  const fx = makeFixture("mac");
  const env = { ...fx.env, PASTE_USE_PASTEBOARD: board };
  const read = (what: "string" | "types" | "files"): string => {
    const script = `ObjC.import('AppKit'); function run(argv) { var pb = $.NSPasteboard.pasteboardWithName(argv[0]);
      if (argv[1] === 'string') return ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
      if (argv[1] === 'files') return ObjC.unwrap(pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $())).map(function (u) { return ObjC.unwrap(u.path); }).join('\\n');
      return ObjC.unwrap(pb.types).map(function (t) { return ObjC.unwrap(t); }).join(','); }`;
    return spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, board, what], { encoding: "utf8" }).stdout.replace(/\n$/, "");
  };

  afterAll(() => {
    spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); function run(argv) { $.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally; }", board]);
  });

  test("text from an argument, stdin and a file — without echoing it", () => {
    const out = run(env, ["copy", "hello", "世界 ✓"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("copied 10 chars to the clipboard\n");
    expect(read("string")).toBe("hello 世界 ✓");
    expect(run(env, ["copy", "-"], "from stdin\nline 2").code).toBe(0);
    expect(read("string")).toBe("from stdin\nline 2");
    expect(run(env, ["copy", "--file", join(import.meta.dir, "..", "LICENSE")]).code).toBe(0);
    expect(read("string")).toContain("MIT License");
  });

  test("--clip re-copies the original, secrets included, and prints none of it", () => {
    const out = run(env, ["copy", "--clip", "bbbb2222"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("copied clip bbbb2222 (code,");
    expect(out.stdout).not.toContain(FAKE_GITHUB_TOKEN);
    expect(read("string")).toContain(FAKE_GITHUB_TOKEN);
  });

  test("--clip on an image and on files", () => {
    expect(run(env, ["copy", "--clip", "dddd4444"]).stdout).toContain("copied image clip dddd4444");
    expect(read("types")).toMatch(/public\.tiff|public\.png/);
    expect(run(env, ["copy", "--clip", "eeee5555"]).stdout).toContain("copied 1 file from clip eeee5555");
    expect(read("files").endsWith("/report.pdf")).toBe(true);
  });

  test("nothing to copy is an error", () => {
    expect(run(env, ["copy"]).code).toBe(1);
    expect(run(env, ["copy", "-"], "").code).toBe(5);
  });
});
