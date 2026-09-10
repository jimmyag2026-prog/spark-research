# V66：PDF → 纯文本抽取（供精读卡吃全文）。
# 用法: python pdf_text.py <pdf路径> <最大字符数>
# 输出: 单行 JSON {ok, text, pages, truncated} 或 {ok: false, error}
# 纪律: 任何失败都走 ok:false + 可读 error——上游据此优雅降级回摘要，绝不静默假装有全文。
import json
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: pdf_text.py <pdf> <maxChars>"}))
        return 1
    path, max_chars = sys.argv[1], int(sys.argv[2])
    try:
        from pypdf import PdfReader
    except Exception as exc:  # pypdf 未安装：报可操作的原因，不是裸 traceback
        print(json.dumps({"ok": False, "error": f"pypdf 不可用: {exc}。安装：VIRTUAL_ENV=.venv uv pip install pypdf"}))
        return 1
    try:
        reader = PdfReader(path)
        parts = []
        total = 0
        truncated = False
        for page in reader.pages:
            t = page.extract_text() or ""
            if not t:
                continue
            remain = max_chars - total
            if remain <= 0:
                truncated = True
                break
            if len(t) > remain:
                t = t[:remain]
                truncated = True
            parts.append(t)
            total += len(t)
        text = "\n".join(parts).strip()
        if not text:
            print(json.dumps({"ok": False, "error": "PDF 无可抽取文本（可能是扫描件/纯图像）"}))
            return 1
        print(json.dumps({"ok": True, "text": text, "pages": len(reader.pages), "truncated": truncated}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"解析失败: {type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
