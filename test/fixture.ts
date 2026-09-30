// Fixture Pastyx databases in the three shapes paste-use has to read:
//   mac      — current macOS schema (title, clip_ocr, source app + file refs inside `extra`)
//   mac-old  — first-release macOS schema: no `title` column, no `clip_ocr` table
//   windows  — Windows schema (source_app_* / image_width / file_refs columns, absolute image paths)
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Shape = "mac" | "mac-old" | "windows";

export const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

// 1x1 PNG.
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// Assembled at run time so no secret-shaped literal sits in the repository.
export const FAKE_GITHUB_TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`.slice(0, 40);
export const FAKE_OPENAI_KEY = `sk-${"proj"}-${"Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"}`;
export const FAKE_CARD = ["4242", "4242", "4242", "4242"].join(" ");
export const FAKE_PASSWORD = "Tr0ub4dor&Horse!";

interface Seed {
  id: string;
  type: string;
  content: string | null;
  ageMs: number;
  title?: string;
  app?: [name: string, id: string];
  tags?: string[];
  favorite?: boolean;
  deleted?: boolean;
  url?: string;
  ocr?: string;
  image?: boolean;
  files?: string[];
}

export interface Fixture {
  dir: string;
  db: string;
  env: NodeJS.ProcessEnv;
  existingFile: string;
}

export function makeFixture(shape: Shape, options: { ignoredApps?: string[]; skipConcealed?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `paste-use-${shape}-`));
  const dbPath = join(dir, shape === "windows" ? "history.db" : "local-history.sqlite");
  mkdirSync(join(dir, "images"));
  const existingFile = join(dir, "report.pdf");
  writeFileSync(existingFile, "pdf");

  const seeds: Seed[] = [
    { id: "aaaa1111-0000-4000-8000-000000000001", type: "text", content: "hello from the clipboard\nsecond line", ageMs: 1 * MIN, app: ["Safari", "com.apple.Safari"], tags: ["auto"] },
    { id: "bbbb2222-0000-4000-8000-000000000002", type: "code", content: `export GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\ncurl -H "Authorization: Bearer ${FAKE_OPENAI_KEY}" https://api.example.com`, ageMs: 5 * MIN, app: ["Terminal", "com.apple.Terminal"], tags: ["auto", "Snippets"], title: "deploy env" },
    { id: "cccc3333-0000-4000-8000-000000000003", type: "link", content: "https://example.com/docs/install", url: "https://example.com/docs/install", ageMs: 30 * MIN, app: ["Safari", "com.apple.Safari"], tags: ["auto"], favorite: true, title: "Install guide" },
    { id: "dddd4444-0000-4000-8000-000000000004", type: "image", content: null, ageMs: 2 * HOUR, app: ["Preview", "com.apple.Preview"], tags: ["auto", "Work"], image: true, ocr: "Quarterly revenue chart\nTotal 1,234" },
    { id: "eeee5555-0000-4000-8000-000000000005", type: "file", content: "report.pdf\ngone.txt", ageMs: 3 * HOUR, app: ["Finder", "com.apple.finder"], tags: ["auto"], files: [existingFile, join(dir, "gone.txt")] },
    { id: "ffff6666-0000-4000-8000-000000000006", type: "text", content: FAKE_PASSWORD, ageMs: 4 * HOUR, app: ["1Password", "com.1password.1password"], tags: ["auto"] },
    { id: "abab7777-0000-4000-8000-000000000007", type: "text", content: `card ${FAKE_CARD} exp 12/29, order 1234567890123456`, ageMs: 26 * HOUR, app: ["Notes", "com.apple.Notes"], tags: ["snippets"] },
    { id: "abab8888-0000-4000-8000-000000000008", type: "html", content: "A long article. ".repeat(400), ageMs: 50 * HOUR, app: ["Chrome", "com.google.Chrome"], tags: ["auto"] },
    { id: "dead9999-0000-4000-8000-000000000009", type: "text", content: "deleted clip must never show", ageMs: 2 * MIN, tags: ["auto"], deleted: true },
  ];

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  if (shape === "windows") {
    db.exec(`CREATE TABLE clips (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, user_id TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL, summary TEXT, content TEXT, content_html TEXT, source_url TEXT, image_path TEXT, image_mime TEXT,
      image_preview_data_url TEXT, image_url TEXT, image_width INTEGER, image_height INTEGER, image_hash TEXT, text_key TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
      client_updated_at INTEGER, server_updated_at INTEGER, created_at INTEGER NOT NULL,
      source_app_id TEXT, source_app_name TEXT, source_app_path TEXT, title TEXT, file_refs TEXT);
      CREATE TABLE clip_ocr (clip_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } else {
    db.exec(`CREATE TABLE clips (
      id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL DEFAULT 0, user_id TEXT, device_id TEXT, type TEXT, summary TEXT,
      content TEXT, content_html TEXT, source_url TEXT, image_path TEXT, image_mime TEXT, image_preview_data_url TEXT,
      image_url TEXT, is_favorite INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]', client_updated_at INTEGER, server_updated_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0, extra TEXT${shape === "mac" ? ", title TEXT" : ""});`);
    if (shape === "mac") db.exec("CREATE TABLE clip_ocr (clip_id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0);");
  }

  let seq = seeds.length;
  for (const s of seeds) {
    const created = NOW - s.ageMs;
    const row: Record<string, string | number | null> = {
      id: s.id, seq: seq--, device_id: "device-1", type: s.type, summary: s.content?.slice(0, 40) ?? null, content: s.content,
      content_html: s.type === "html" ? "<p>A long article.</p>" : null, source_url: s.url ?? null,
      is_favorite: s.favorite ? 1 : 0, is_deleted: s.deleted ? 1 : 0, tags: JSON.stringify(s.tags ?? []), created_at: created,
      image_path: null, image_mime: null, image_preview_data_url: null,
    };
    if (s.image) {
      const name = `${s.id}.png`;
      writeFileSync(join(dir, "images", name), PNG);
      row.image_path = shape === "windows" ? join(dir, "images", name) : name;
      row.image_mime = "image/png";
      row.image_preview_data_url = `data:image/png;base64,${PNG.toString("base64")}`;
    }
    if (shape === "windows") {
      row.source_app_name = s.app?.[0] ?? null;
      row.source_app_id = s.app ? `${s.app[0].toLowerCase()}.exe` : null;
      row.title = s.title ?? null;
      if (s.image) Object.assign(row, { image_width: 1, image_height: 1 });
      row.file_refs = s.files ? JSON.stringify(s.files.map((p) => ({ Name: p.split("/").pop(), Path: p, Size: 3, IsDirectory: false }))) : null;
    } else {
      // Swift encodes `extra` as [String: String]: numbers and nested JSON are strings.
      const extra: Record<string, string> = {};
      if (s.app) Object.assign(extra, { sourceAppName: s.app[0], sourceAppBundleId: s.app[1] });
      if (s.image) Object.assign(extra, { imageWidth: "1", imageHeight: "1" });
      if (s.files) extra.fileRefs = JSON.stringify(s.files.map((p) => ({ name: p.split("/").pop(), path: p, isDirectory: false })));
      row.extra = JSON.stringify(extra);
      if (shape === "mac") row.title = s.title ?? null;
    }
    const keys = Object.keys(row);
    db.query(`INSERT INTO clips (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]!));
    if (s.ocr && shape !== "mac-old") db.query("INSERT INTO clip_ocr (clip_id, text, updated_at) VALUES (?, ?, ?)").run(s.id, s.ocr, created);
  }
  db.close();

  writeFileSync(join(dir, "config.json"), JSON.stringify({
    authToken: "must-never-be-printed",
    ignoredApps: options.ignoredApps ?? [],
    pinboards: ["Snippets", "Empty board"],
    ...(options.skipConcealed === undefined ? {} : { skipConcealed: options.skipConcealed }),
  }));

  return { dir, db: dbPath, existingFile, env: { ...process.env, PASTE_USE_DB: dbPath, PASTE_USE_UPGRADE_CHECK: "0" } };
}
