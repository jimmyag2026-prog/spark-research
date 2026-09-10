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

echo "== 构建 =="
bun run build >/dev/null

echo "== ① 版本一致性 =="
PKG_VERSION=$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')
BIN_VERSION=$("$BIN" --version | tr -d '[:space:]')
if [ "$BIN_VERSION" != "$PKG_VERSION" ] || [ "$BIN_VERSION" = "0.0.0" ]; then
  echo "❌ 版本不一致: binary=$BIN_VERSION package.json=$PKG_VERSION"; exit 1
fi
echo "   ok: $BIN_VERSION"

echo "== ② capabilities 技能数 =="
CAP_OUT=$("$BIN" capabilities --json 2>&1 || true)
SKILLS=$(printf '%s' "$CAP_OUT" | bun -e 'try{const d=JSON.parse(await new Response(Bun.stdin.stream()).text());console.log((d.skills??[]).length)}catch{console.log("PARSE_FAIL")}')
if [ "$SKILLS" = "PARSE_FAIL" ] || [ "$SKILLS" -lt 1 ]; then
  echo "❌ 二进制报告技能 $SKILLS（V27 形状）。capabilities 原始输出前 800 字节："
  printf '%s' "$CAP_OUT" | head -c 800; echo
  exit 1
fi
echo "   ok: $SKILLS 个技能"

echo "== ③ server 起得来且有真 UI =="
DATA_DIR=$(mktemp -d)
SPARK_RESEARCH_DATA_DIR="$DATA_DIR" "$BIN" server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$DATA_DIR"' EXIT
for i in $(seq 1 30); do
  sleep 0.2
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 30 ]; then echo "❌ server 6 秒内没起来"; exit 1; fi
done

HEALTH_VERSION=$(curl -sf "http://127.0.0.1:$PORT/api/health" | bun -e 'const d=JSON.parse(await new Response(Bun.stdin.stream()).text());console.log(d.version??"")')
if [ "$HEALTH_VERSION" != "$PKG_VERSION" ]; then
  echo "❌ /api/health 版本 $HEALTH_VERSION ≠ package.json $PKG_VERSION（v0.2.1 事故的形状）"; exit 1
fi
echo "   ok: /api/health = $HEALTH_VERSION"

HOME_STATUS=$(curl -s -o /tmp/spark-smoke-home.html -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$HOME_STATUS" != "200" ]; then echo "❌ 首页 HTTP $HOME_STATUS（V43①：二进制没有前端产物？）"; exit 1; fi
if ! grep -q "Spark Research 工作台" /tmp/spark-smoke-home.html; then
  echo "❌ 首页 200 但不是工作台 HTML（可能是 503 指引页被当成功）"; exit 1
fi
# 首页引用的 JS bundle 也必须真的能拿到——index.html 在而 assets 缺是嵌入清单漏文件的形状
ASSET=$(grep -o '/assets/[^"]*\.js' /tmp/spark-smoke-home.html | head -1)
if [ -n "$ASSET" ]; then
  if ! curl -sf "http://127.0.0.1:$PORT$ASSET" >/dev/null; then echo "❌ 首页引用的 $ASSET 404"; exit 1; fi
  echo "   ok: 首页 200 + $ASSET 可达"
else
  echo "❌ 首页 HTML 里找不到 JS bundle 引用"; exit 1
fi

echo "✅ 二进制冒烟全过（version=$BIN_VERSION, skills=$SKILLS, UI ok）"
