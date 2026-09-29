#!/usr/bin/env bash
# 把 Hermes 版 skill 同步到 ~/.hermes/skills/research/cross-domain-bridge/（真实目录，不能 symlink——
# hermes 的 skill 扫描器不跟 symlink）。源码真源在 spark-research 仓库，这里只做单向拷贝。
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
REFS="$SRC/../references"
DST="${HERMES_HOME:-$HOME/.hermes}/skills/research/cross-domain-bridge"
mkdir -p "$DST/scripts" "$DST/references"
rsync -a --delete --exclude 'sync-to-hermes.sh' "$SRC/" "$DST/"
rsync -a --delete "$REFS/" "$DST/references/"
chmod +x "$DST/scripts/bridge_tools.py"
python3 "$DST/scripts/bridge_tools.py" selftest >/dev/null
echo "synced → $DST"
ls -1 "$DST" "$DST/scripts" "$DST/references"
