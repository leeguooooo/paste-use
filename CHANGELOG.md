# Changelog

## 0.1.2

- `paste-use skill install` (also run by the installer and `upgrade`) no longer writes `~/.claude/skills/paste-use` or `~/.codex/skills/paste-use` when the Claude Code or Codex plugin already provides the skill, so it is not listed twice. A copy it wrote earlier (a lone, unchanged `SKILL.md`) is removed; anything else in that folder is left alone.

## 0.1.1

- The Skill moved to `skills/paste-use/`, the standard folder Claude Code and Codex enumerate. `paste-use skill install` still installs the embedded copy offline.

## 0.1.0

First release. The Pastyx clipboard history for agents, read straight from the app's local database (read-only, no sign-in, works offline): `list`, `search` (text, titles, links and text recognised in images), `get`, `last`, `pinboards`, `status`; `copy` puts text on the system clipboard or re-copies an old clip (text, image, files). Secret-looking values are masked in every read command unless `--no-redact` / `get --raw` is passed; clips from apps Pastyx is set to ignore are hidden. macOS (direct and App Store builds) and Windows; *-use family upgrade convention (`upgrade --check/--json`, daily notice); Developer ID signed and notarized macOS binaries.
