# V65 残余：中文分词（jieba，可选依赖）。
# 用法: 从 stdin 读原始查询文本（UTF-8），输出单行 JSON 到 stdout。
# 输出: {"terms": [...]} 或 {"terms": null, "reason": "..."}
# 纪律：任何失败都走 terms:null + reason——上游（search.ts 的 AMiner 拆词兜底）据此
# 退回 v0.6 的空格拆词行为，绝不静默假装分出了词。
import json
import sys


def main() -> int:
    text = sys.stdin.read()
    if not text.strip():
        print(json.dumps({"terms": None, "reason": "空输入"}))
        return 1
    try:
        import jieba
    except Exception as exc:  # jieba 未安装：报可操作的原因，不是裸 traceback
        print(json.dumps({"terms": None, "reason": f"jieba 不可用: {exc}。安装：VIRTUAL_ENV=.venv uv pip install jieba"}))
        return 1
    try:
        terms = [t.strip() for t in jieba.cut(text.strip()) if t.strip()]
        if not terms:
            print(json.dumps({"terms": None, "reason": "分词结果为空"}))
            return 1
        print(json.dumps({"terms": terms}))
        return 0
    except Exception as exc:
        print(json.dumps({"terms": None, "reason": f"分词失败: {type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
