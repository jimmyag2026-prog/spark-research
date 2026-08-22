#!/usr/bin/env bash
# 开发日志记录器：所有开发/测试活动追加到 logs/YYYY-MM-DD.md
# 用法: ./scripts/log.sh "模块名" "活动描述" "状态(OK/FAIL/WARN)"
set -e
MODULE="$1"
ACTIVITY="$2"
STATUS="${3:-OK}"
LOG_DIR="$(cd "$(dirname "$0")/.." && pwd)/logs"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)
LOG_FILE="$LOG_DIR/$DATE.md"

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

echo "| $TIME | $MODULE | $ACTIVITY | $STATUS |" >> "$LOG_FILE"
echo "✅ [$STATUS] $TIME $MODULE: $ACTIVITY"
