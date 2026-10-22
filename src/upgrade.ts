// Self-upgrade and the daily "new version" notice, per the *-use family convention
// (leeguooooo/plugins docs/upgrade.md): `upgrade`, `upgrade --check`, `upgrade --json`,
// skill refresh after upgrading, one stderr line a day when a newer release exists.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REPO = "leeguooooo/paste-use";
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
export const INSTALL_PS1_URL = `https://raw.githubusercontent.com/${REPO}/main/install.ps1`;
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Override the latest-release URL (tests point it at a local fake). */
export const PASTE_USE_UPGRADE_LATEST_URL_ENV = "PASTE_USE_UPGRADE_LATEST_URL";
/** Override the installer with a local script run as `sh <path>` instead of `curl … | sh`. */
export const PASTE_USE_UPGRADE_INSTALLER_ENV = "PASTE_USE_UPGRADE_INSTALLER";
/** "0" disables the version check (offline, CI, tests). */
export const PASTE_USE_UPGRADE_CHECK_ENV = "PASTE_USE_UPGRADE_CHECK";

const LATEST_TIMEOUT_MS = 3000;

export type Version = readonly [number, number, number];

/** "v0.4.3" / "0.4.3" → [0,4,3]; anything else → null. */
export function parseVersion(raw: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export type UpgradeCheck =
  | { status: "current" | "behind" | "ahead"; current: string; latest: string }
  | { status: "unknown"; current: string; error: string };

function latestReleaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env[PASTE_USE_UPGRADE_LATEST_URL_ENV];
  return typeof override === "string" && override !== "" ? override : LATEST_RELEASE_URL;
}

/** Latest release tag. Any failure (offline, rate limit, odd payload) is reported, never thrown. */
export async function fetchLatestVersion(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LATEST_TIMEOUT_MS,
): Promise<{ tag: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(latestReleaseUrl(env), {
      signal: controller.signal,
      // The GitHub API answers 403 without a User-Agent.
      headers: { "user-agent": "paste-use-upgrade", accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const body = (await response.json()) as unknown;
    const tag = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).tag_name
      : undefined;
    if (typeof tag !== "string" || parseVersion(tag) === null) {
      return { error: `unexpected release payload (tag_name=${JSON.stringify(tag)})` };
    }
    return { tag };
  } catch (error) {
    const e = error as { name?: string; message?: string };
    return { error: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkUpgrade(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeCheck> {
  const cur = parseVersion(current);
  if (cur === null) return { status: "unknown", current, error: `current version is not semver: ${current}` };
  const latest = await fetchLatestVersion(env);
  if ("error" in latest) return { status: "unknown", current, error: latest.error };
  const lat = parseVersion(latest.tag)!;
  const order = compareVersions(cur, lat);
  return { status: order < 0 ? "behind" : order > 0 ? "ahead" : "current", current, latest: latest.tag };
}

export function upgradeCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PASTE_USE_UPGRADE_CHECK_ENV] !== "0";
}

/** The installer this platform upgrades through, as a command line. */
export function installerCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const local = env[PASTE_USE_UPGRADE_INSTALLER_ENV];
  if (typeof local === "string" && local !== "") return ["sh", local];
  if (platform === "win32") {
    return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS1_URL} | iex`];
  }
  return ["sh", "-c", `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`];
}

/**
 * Run the installer: `curl -fsSL <install.sh> | sh` (Windows: `irm <install.ps1> | iex`), or
 * `sh <path>` when PASTE_USE_UPGRADE_INSTALLER points at a local script (tests). stdio is
 * inherited so the user sees download/verify/replace.
 * Returns the installer's exit code, or null if it could not start.
 */
export function runInstaller(env: NodeJS.ProcessEnv = process.env): { code: number | null; command: string } {
  const argv = installerCommand(env);
  const proc = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", env });
  return { code: proc.status, command: argv.join(" ") };
}

// ───────────────────── skill refresh + daily notice ─────────────────────

export const TOOL_NAME = "paste-use";
export const PLUGIN_ID = "paste-use@leeguooooo-plugins";
const DAY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_COMMAND = "_update-check";

export interface SkillChannel {
  channel: "claude-plugin" | "git-checkout" | "copied" | "installer";
  path: string;
  update: string;
}

function gitRoot(dir: string): string | null {
  const out = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  return out.status === 0 && typeof out.stdout === "string" && out.stdout.trim() !== "" ? out.stdout.trim() : null;
}

/** Whether a host plugin already provides the paste-use skill, so a personal copy there would list it twice. */
export function pluginProvidesSkill(host: "claude" | "codex", home: string = homedir()): boolean {
  try {
    if (host === "claude") return readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8").includes(`"${PLUGIN_ID}`);
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const at = config.indexOf(`[plugins."${PLUGIN_ID}"]`);
    if (at < 0) return false;
    const section = config.slice(at).split(/\n(?=\[)/)[0]!;
    return /^\s*enabled\s*=\s*true\s*$/m.test(section);
  } catch {
    return false;
  }
}

/** Convention §3: every copy of the paste-use skill on this machine and how to refresh it. */
export function detectSkillChannels(home: string = homedir()): SkillChannel[] {
  const found: SkillChannel[] = [];
  const plugins = join(home, ".claude", "plugins", "installed_plugins.json");
  try {
    if (readFileSync(plugins, "utf8").includes(`"${PLUGIN_ID}`)) {
      found.push({ channel: "claude-plugin", path: plugins, update: `claude plugin update ${PLUGIN_ID}` });
    }
  } catch {
    // no Claude Code plugins installed
  }
  const managed = new Set([join(home, ".claude", "skills", "paste-use"), join(home, ".codex", "skills", "paste-use")]);
  for (const dir of [join(home, ".agents", "skills", "paste-use"), ...managed]) {
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // dangling link: treat as absent
      continue;
    }
    const root = gitRoot(real);
    if (root !== null) found.push({ channel: "git-checkout", path: dir, update: `git -C ${root} pull --ff-only` });
    else if (managed.has(dir)) found.push({ channel: "installer", path: dir, update: "paste-use skill install" });
    else found.push({ channel: "copied", path: dir, update: "npx skills update paste-use" });
  }
  return found;
}

/** After upgrading: update the Claude plugin, pull git checkouts; installer copies are already fresh, copied folders get a hint. */
export function refreshSkills(channels: readonly SkillChannel[]): string[] {
  const lines: string[] = [];
  for (const skill of channels) {
    if (skill.channel === "claude-plugin") {
      const out = spawnSync("claude", ["plugin", "update", PLUGIN_ID], { encoding: "utf8", windowsHide: true });
      lines.push(out.error === undefined && out.status === 0
        ? `skill (claude-plugin): updated — restart Claude Code or /reload-plugins`
        : `skill (claude-plugin): run \`${skill.update}\``);
    } else if (skill.channel === "git-checkout") {
      const root = skill.update.split(" ")[2]!;
      const out = spawnSync("git", ["-C", root, "pull", "-q", "--ff-only"], { encoding: "utf8", windowsHide: true });
      lines.push(out.status === 0
        ? `skill (git-checkout ${skill.path}): updated`
        : `skill (git-checkout ${skill.path}): not updated (${(out.stderr ?? "").trim() || "local changes?"})`);
    } else if (skill.channel === "copied") {
      lines.push(`skill (copied ${skill.path}): run \`${skill.update}\``);
    } else {
      lines.push(`skill (${skill.path}): refreshed by the installer`);
    }
  }
  return lines;
}

function updateCachePath(env: NodeJS.ProcessEnv): string {
  const base = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME !== ""
    ? env.XDG_CACHE_HOME
    : join(homedir(), ".cache");
  return join(base, TOOL_NAME, "update-check.json");
}

/** Convention §2 skip conditions, plus PASTE_USE_UPGRADE_CHECK=0. */
export function updateNoticeDisabled(env: NodeJS.ProcessEnv, command: string | undefined): boolean {
  if (env.CI || env.PASTE_USE_NO_UPDATE_CHECK || env.USE_NO_UPDATE_CHECK || env[PASTE_USE_UPGRADE_CHECK_ENV] === "0") return true;
  return command === undefined || command.startsWith("_") ||
    ["upgrade", "version", "--version", "help", "--help"].includes(command);
}

function readUpdateCache(env: NodeJS.ProcessEnv): { checked_at: number; latest: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(updateCachePath(env), "utf8")) as { checked_at?: unknown; latest?: unknown };
    if (typeof raw.checked_at !== "number") return null;
    return { checked_at: raw.checked_at, latest: typeof raw.latest === "string" ? raw.latest : null };
  } catch {
    return null;
  }
}

/**
 * Every call: if the cached latest is newer, print one line to stderr (stdout may be JSON).
 * Cache missing or older than 24h: spawn a detached `paste-use _update-check` and don't wait —
 * agents call this CLI a lot, the foreground never waits on a version check.
 */
export function maybeUpdateNotice(
  current: string,
  command: string | undefined,
  selfCommand: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): void {
  if (updateNoticeDisabled(env, command)) return;
  const cache = readUpdateCache(env);
  if (cache?.latest != null) {
    const cur = parseVersion(current);
    const lat = parseVersion(cache.latest);
    if (cur !== null && lat !== null && compareVersions(cur, lat) < 0) {
      process.stderr.write(`paste-use ${lat.join(".")} is available (you have ${current}). Upgrade: paste-use upgrade\n`);
    }
  }
  if (cache !== null && now - cache.checked_at * 1000 < DAY_MS) return;
  try {
    // Claim checked_at first so concurrent calls spawn a single checker.
    writeUpdateCache(env, now, cache?.latest ?? null);
    const [cmd, ...args] = selfCommand;
    const child = spawn(cmd!, [...args, UPDATE_CHECK_COMMAND], { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
  } catch {
    // Silent on failure, per the convention.
  }
}

function writeUpdateCache(env: NodeJS.ProcessEnv, now: number, latest: string | null): void {
  const path = updateCachePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ checked_at: Math.floor(now / 1000), latest })}\n`);
}

/** `paste-use _update-check`: one 2 s lookup; checked_at is written either way so offline machines aren't retried every call. */
export async function runUpdateCheck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const latest = await fetchLatestVersion(env, 2000);
  const previous = readUpdateCache(env)?.latest ?? null;
  writeUpdateCache(env, Date.now(), "tag" in latest ? latest.tag.replace(/^v/, "") : previous);
}
