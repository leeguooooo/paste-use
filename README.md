# paste-use

**Your Pastyx clipboard history for AI agents: list, search and read what you copied, re-copy an old clip, put text on your clipboard.** Part of the [*-use family](https://github.com/leeguooooo/plugins).

[中文文档](./README.zh-CN.md)

[Pastyx](https://paste.leeguoo.com) keeps everything you copy — text, links, code, images, files — in a local database on your Mac or PC. `paste-use` lets Claude Code, Codex, or any agent read it, so "use the thing I copied earlier" just works. It reads the local file, not the sync API: no sign-in, works offline, and it keeps working when sync becomes end-to-end encrypted.

```bash
paste-use last                       # what I just copied, in full
paste-use list --limit 10            # one line per clip: id, age, type, app, text
paste-use list --since 2h --app Safari --type link
paste-use search "docker run"        # text, titles, links, and text inside images
paste-use get 3f2a9c1e               # one clip in full (or an index: 1 = newest)
paste-use get 3f2a9c1e --out shot.png   # image clips are written to a file
paste-use pinboards                  # pinboards with clip counts
paste-use copy "text"                # put text on the clipboard
paste-use copy --clip 3f2a9c1e       # re-copy an old clip
```

`list` prints one short line per clip, so an agent can scan a history for a few hundred tokens and `get` only the clip it needs:

```
3f2a9c1e    2m  text   Safari  hello from the clipboard second line
8b41d7aa    5m  code   Terminal  #Snippets deploy env — export GITHUB_TOKEN=[redacted:github-token] curl -H …
c90e1f22    2h  image  Preview  #Work [image 1280x720] Quarterly revenue chart
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.ps1 | iex
```

macOS 14+ (Apple silicon or Intel) and Windows 10/11 x64. macOS binaries are Developer ID signed and notarized. You need the [Pastyx app](https://paste.leeguoo.com/download); `paste-use status` says which history it found.

Claude Code: `/plugin install paste-use@leeguooooo-plugins` (or the whole family: `use-family@leeguooooo-plugins`).

## Privacy

A clipboard history holds whatever was copied, passwords and API keys included. paste-use is built so an agent doesn't pull those into a chat by accident:

- **Secrets are masked by default** in every read command (`list`, `search`, `get`, `last`, and their `--json`). What looks like a secret prints as `[redacted:kind]`, and a line on stderr says how many were masked:
  - private key blocks, JWTs, GitHub / OpenAI / Anthropic / Stripe / Slack / AWS / Google / GitLab / npm / Hugging Face tokens, `Bearer …` values
  - `password=…`, `api_key: …`, `密码：…` and similar key–value pairs (the key stays, the value goes)
  - passwords inside URLs (`postgres://user:…@host`)
  - card numbers (13–19 digits that pass the Luhn check)
  - long opaque strings (40+ characters mixing upper case, lower case and digits)
  - a clip that is a single password-shaped word (8–64 characters with lower case, upper case, a digit and a symbol)
- `--no-redact` turns masking off; `get --raw` prints one clip exactly as it was copied. The skill tells agents to ask you first.
- `paste-use copy --clip <id>` puts an old clip back on the clipboard **without printing it**, so a secret can be moved without entering the conversation.
- Clips from apps you told Pastyx to ignore are hidden, including ones stored before you added the app.
- The heuristic errs towards masking and is not a guarantee. Turn on "Skip passwords & sensitive items" in Pastyx so password managers' copies are never stored; `paste-use status` warns when it is off.
- The database is opened **read-only**; paste-use never writes it. `copy` goes through the system clipboard, where Pastyx records it like any other copy.
- Clip text is treated as data: the skill tells agents not to follow instructions found inside clips.

## Commands

| Command | Does |
|---|---|
| `list` | Clips, newest first. Filters: `--type`, `--app`, `--pinboard`, `--favorites`, `--since 2h\|2026-09-30`; `--limit` (20), `--chars` (100) |
| `search <query>` | Same output and filters; matches text, titles, links and text recognised in images |
| `get <id\|index>` | One clip in full. `--raw` exact content, `--html` the HTML it was copied with, `--out <path>` for images |
| `last [N]` | The newest clip in full, or the newest N |
| `copy` | `<text>`, `-` (stdin), `--file <path>`, or `--clip <id\|index>` (text, image, files still on disk) |
| `pinboards` | Pinboards with clip counts |
| `status` / `doctor` | Which history was found, clip counts, app version, whether Pastyx is running |
| `upgrade` | Self-upgrade (`--check`, `--json`), family convention |

All read commands take `--json`. Exit codes: 3 no Pastyx history on this machine, 4 no such clip, 5 clipboard write failed.

Where the history lives:

| | Path |
|---|---|
| macOS | `~/Library/Application Support/paste/local-history.sqlite` |
| macOS, App Store build | `~/Library/Containers/com.paste.native/Data/Library/Application Support/paste/local-history.sqlite` |
| Windows | `%LOCALAPPDATA%\Pastyx\history.db` |

`PASTE_USE_DB=<file>` points it somewhere else.

Not there yet: pinning a clip from the CLI. Pastyx has no entry point for it, and paste-use won't write the app's database.

## License

MIT

## Author

Built by **郭立 (Guo Li / leeguoo)** — [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · more tools in the [*-use family](https://github.com/leeguooooo/plugins).
