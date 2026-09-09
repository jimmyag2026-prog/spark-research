import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../frontend/workspace/src/lib/markdown";

// 这是全仓库唯一往 innerHTML 写东西的地方，输入是 LLM 正文与文献元数据。
// 主会话 P7 验收补的回归测试：把「转义 → 行内替换 → 块级组装」这个顺序钉死。
// 将来若有人加链接渲染（[text](url) → <a href>），下面的 javascript: 用例会立刻变红。

describe("markdown 渲染 · XSS 边界", () => {
  test("标签被转义，不产生可执行节点", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("事件处理器无法成为真实属性（转义后只是文本）", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    // 关键：引号已转义，onerror 不可能被解析成属性
    expect(html).not.toMatch(/onerror="/);
    expect(html).toContain("&quot;alert(1)&quot;");
  });

  test("javascript: 链接不会变成锚点（当前无链接渲染面）", () => {
    const html = renderMarkdown("[点我](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  test("引号被转义，无法逃出属性值", () => {
    const html = renderMarkdown('他说 "危险" 与 \'单引号\'');
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
  });

  test("& 先于其他字符转义，不产生二次转义", () => {
    expect(renderMarkdown("a & b")).toContain("a &amp; b");
    expect(renderMarkdown("&lt;")).toContain("&amp;lt;");
  });

  test("行内代码里的尖括号同样被转义", () => {
    const html = renderMarkdown("`<script>`");
    expect(html).toContain("<code>&lt;script&gt;</code>");
  });

  test("畸形引用 key 不生成 cite 节点，保持为纯文本", () => {
    // key 正则只收 [A-Za-z0-9][A-Za-z0-9_\-:]*，带引号的 key 整体不匹配 →
    // 不会进 title 属性，退化成已转义的普通文本
    const html = renderMarkdown('[@evil"onmouseover="alert(1)]');
    expect(html).not.toContain('class="cite"');
    expect(html).not.toMatch(/onmouseover="/);
    expect(html).toContain("&quot;");
  });
});

describe("markdown 渲染 · 正常功能", () => {
  test("强调与行内代码", () => {
    expect(renderMarkdown("**粗** 与 *斜*")).toContain("<strong>粗</strong>");
    expect(renderMarkdown("`code`")).toContain("<code>code</code>");
  });

  test("库内外引用分色", () => {
    const known = new Set(["vaswani2017attention"]);
    const inLib = renderMarkdown("见 [@vaswani2017attention]", { knownKeys: known });
    expect(inLib).toContain('class="cite"');

    const outLib = renderMarkdown("见 [@fabricated2099ghost]", { knownKeys: known });
    expect(outLib).toContain("cite-unknown");
    expect(outLib).toContain("库外引用");
  });

  test("没给白名单时不把中性引用染红", () => {
    expect(renderMarkdown("见 [@anykey]")).not.toContain("cite-unknown");
  });
});
