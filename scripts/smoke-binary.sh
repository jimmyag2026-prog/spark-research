#!/usr/bin/env bash
# G-2（v0.6，V28）：二进制冒烟。测试套件跑在 `bun backend/src/index.ts` 上，
# 二进制是另一个运行时——V27 那类问题只有真跑二进制才抓得到。
#
# 检查：① --version 三处一致且非 0.0.0 ② capabilities 技能数 >0
#       ③ 干净数据目录 server 起来 → 首页 200 且是真工作台 HTML → /api/health 版本一致
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=dist/spark-research
PORT="${SMOKE_PORT:-4399}"

echo "== build =="
bun run build >/dev/null

echo "== 1) version consistency =="
PKG_VERSION=$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')
BIN_VERSION=$("$BIN" --version | tr -d '[:space:]')
if [ "$BIN_VERSION" != "$PKG_VERSION" ] || [ "$BIN_VERSION" = "0.0.0" ]; then
  echo "FAIL: version mismatch binary=$BIN_VERSION package.json=$PKG_VERSION"; exit 1
fi
echo "   ok: $BIN_VERSION"

echo "== 2) capabilities skill count =="
CAP_FILE=$(mktemp)
"$BIN" capabilities --json >"$CAP_FILE" 2>&1 || true
SKILLS=$(bun -e 'try{const d=JSON.parse(await Bun.file(process.argv[1]).text());console.log((d.skills??[]).length)}catch{console.log("PARSE_FAIL")}' "$CAP_FILE")
if [ "$SKILLS" = "PARSE_FAIL" ] || [ "$SKILLS" -lt 1 ]; then
  echo "FAIL: binary reports $SKILLS skills (V27 shape). First 800 bytes of capabilities output:"
  head -c 800 "$CAP_FILE" || true
  echo
  exit 1
fi
rm -f "$CAP_FILE"
echo "   ok: $SKILLS skills"

echo "== 3) server up with real UI =="
DATA_DIR=$(mktemp -d)
SPARK_RESEARCH_DATA_DIR="$DATA_DIR" "$BIN" server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$DATA_DIR"' EXIT
for i in $(seq 1 30); do
  sleep 0.2
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 30 ]; then echo "FAIL: server not up within 6s"; exit 1; fi
done

HEALTH_VERSION=$(curl -sf "http://127.0.0.1:$PORT/api/health" | bun -e 'const d=JSON.parse(await new Response(Bun.stdin.stream()).text());console.log(d.version??"")')
if [ "$HEALTH_VERSION" != "$PKG_VERSION" ]; then
  echo "FAIL: /api/health version $HEALTH_VERSION != package.json $PKG_VERSION (v0.2.1 incident shape)"; exit 1
fi
echo "   ok: /api/health = $HEALTH_VERSION"

HOME_STATUS=$(curl -s -o /tmp/spark-smoke-home.html -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$HOME_STATUS" != "200" ]; then echo "FAIL: home HTTP $HOME_STATUS (V43-1: no frontend in binary?)"; exit 1; fi
if ! grep -q "Spark Research" /tmp/spark-smoke-home.html; then
  echo "FAIL: home is 200 but not the workbench HTML (503 guidance page mistaken as success?)"; exit 1
fi
ASSET=$(grep -o '/assets/[^"]*\.js' /tmp/spark-smoke-home.html | head -1)
if [ -n "$ASSET" ]; then
  if ! curl -sf "http://127.0.0.1:$PORT$ASSET" >/dev/null; then echo "FAIL: referenced bundle $ASSET is 404"; exit 1; fi
  echo "   ok: home 200 + $ASSET reachable"
else
  echo "FAIL: no JS bundle reference found in home HTML"; exit 1
fi

echo "OK: binary smoke passed (version=$BIN_VERSION, skills=$SKILLS, UI ok)"
