# `e_coli_core.xml` 的来历

`cobra` 包自带的教科书模型 `cobra/data/textbook.xml.gz`（模型 id `e_coli_core`），
用下面这一句解压成明文 SBML 放进来（cobra 0.32.1，2026-09-10）：

```python
import cobra, gzip, os, shutil
src = os.path.join(os.path.dirname(cobra.__file__), "data", "textbook.xml.gz")
with gzip.open(src, "rb") as f, open("e_coli_core.xml", "wb") as o:
    shutil.copyfileobj(f, o)
```

**为什么不直接引 `cobra.io.load_model("textbook")`**：那条路径在没有本地缓存时会联网取，
而 VALIDATION_PLAN 明确禁止测试期下载。fixture 必须是自带的。

**为什么存明文而不是 18 KB 的 `.gz`**：二进制 fixture 审起来是黑盒。
代价是这份文件 351 KB，是本仓库最大的一份 fixture。真嫌大就换回 `.gz`——
`simulation/cobrapy/runner.py` 的 `load_model()` 本来就认 `.xml.gz`。

规模：95 反应 · 72 代谢物 · 137 基因。
tests/unit/cobrapy_e2e.test.ts 断言的四个公开定值都基于这份模型。
