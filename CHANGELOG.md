# Changelog

## 0.1.0

First release. The Pastyx clipboard history for agents, read straight from the app's local database (read-only, no sign-in, works offline): `list`, `search` (text, titles, links and text recognised in images), `get`, `last`, `pinboards`, `status`; `copy` puts text on the system clipboard or re-copies an old clip (text, image, files). Secret-looking values are masked in every read command unless `--no-redact` / `get --raw` is passed; clips from apps Pastyx is set to ignore are hidden. macOS (direct and App Store builds) and Windows; *-use family upgrade convention (`upgrade --check/--json`, daily notice); Developer ID signed and notarized macOS binaries.
