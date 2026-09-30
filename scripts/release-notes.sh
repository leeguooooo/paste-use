#!/bin/sh
# 从 CHANGELOG.md 取出某个版本那一节作为 GitHub Release 说明，末尾附安装命令。
#   scripts/release-notes.sh v0.1.0 > notes.md
# 找不到这一节时退出码 1：发版说明为空的 release 不许出去。
set -eu
version=${1#v}
section=$(awk -v v="$version" '
  /^## / { if (found) exit; h=$2; sub(/^v/, "", h); if (h == v) { found=1; next } }
  found { print }
' CHANGELOG.md)
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 1
fi
printf '%s\n' "$section" | sed -e '/./,$!d'
cat <<'NOTES'

---

**Install / upgrade**

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.sh | sh          # macOS
irm https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.ps1 | iex              # Windows (PowerShell)
paste-use upgrade   # already installed
```

Needs the [Pastyx](https://paste.leeguoo.com/download) app, whose history it reads. macOS binaries are Developer ID signed and notarized. Part of the [*-use family](https://github.com/leeguooooo/plugins).
NOTES
