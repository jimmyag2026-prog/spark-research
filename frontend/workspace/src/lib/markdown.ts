// 极简 Markdown 渲染 + 引用高亮。
//
// 为什么自己写：正文来自 LLM，**必须先整体转义再套白名单标记**。
// 拉一个通用 Markdown 库进来就得连带处理它的 HTML 透传（大多数默认允许），
// 那才是真正的风险面。这里的顺序是死的：escape → 行内替换 → 块级组装，
// 任何时候都不会有未转义的原文进入 innerHTML。
//
// 支持的子集刚好够渲染精读卡/综述/novelty 报告：标题、列表、表格、代码块、
// 行内代码、粗斜体、引用块、`[@key]` 引用标记。链接刻意不解析成 <a>——
// 报告里的 URL 保持纯文本，不给「点开一个模型编出来的地址」这条路。

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MarkdownOptions {
  // 库内可用的 bibtex key。给了就把引用分成「可回链」与「库外」两色。
  knownKeys?: Set<string>;
}

const CITE = /\[@([A-Za-z0-9][A-Za-z0-9_\-:]*)\]/g;

// 行内标记。输入必须**已经**转义过。
function inline(escaped: string, options: MarkdownOptions): string {
  let out = escaped;

  // 行内代码先抽走：代码里的 * 不该被当成强调。
  // 占位符用 `<<N>>` —— escapeHtml 之后正文里绝不可能再出现 `<`，所以这个记号一定是我们放的。
  // 用「空格+数字+空格」会把正文里的「第 3 段」误当占位符。
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `<<${codes.length - 1}>>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  out = out.replace(CITE, (_m, key: string) => {
    const known = options.knownKeys;
    // 没给白名单时不下「库外」的判断——不知道就不说，别把中性情况染红。
    const unknown = known ? !known.has(key) : false;
    const cls = unknown ? "cite cite-unknown" : "cite";
    const title = unknown
      ? `库外引用 ${key}：无法回链到项目文献库`
      : `库内引用 ${key}（点击跳到证据图对应 record）`;
    // V79①：只有确认在库内（能回链到一条 paper record）的引用才带 data-key——
    // 库外引用没有 record 可跳，标了反而让用户点了没反应。key 的合法字符集固定是
    // `[A-Za-z0-9_\-:]`（见上面 CITE 正则），不含任何 HTML 特殊字符，可以直接嵌进属性值，
    // 不需要额外转义。Markdown.onCiteClick（ui.tsx）读的就是这个属性。
    const dataKey = unknown ? "" : ` data-key="${key}"`;
    return `<span class="${cls}" title="${title}"${dataKey}>[@${key}]</span>`;
  });

  out = out.replace(/<<(\d+)>>/g, (_m, i: string) => codes[Number(i)] ?? "");
  return out;
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

interface ListBuffer {
  type: "ul" | "ol";
  items: string[];
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = escapeHtml(source ?? "").split("\n");
  const html: string[] = [];
  let list: ListBuffer | null = null;
  let i = 0;

  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // 代码块
    if (/^```/.test(line)) {
      flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      html.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    // 表格：`| a | b |` 后跟一行分隔符
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      flushList();
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) {
        rows.push(tableRow(lines[i]!));
        i++;
      }
      const thead = head.map((cell) => `<th>${inline(cell, options)}</th>`).join("");
      const tbody = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, options)}</td>`).join("")}</tr>`)
        .join("");
      // 宽表在自己的滚动容器里横向滚，页面主体永远不横向滚。
      html.push(
        `<div class="table-scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!, options)}</h${level}>`);
      i++;
      continue;
    }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inline(quote[1]!, options)}</blockquote>`);
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(inline(bullet[1]!, options));
      i++;
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(inline(numbered[1]!, options));
      i++;
      continue;
    }

    if (line.trim() === "") {
      flushList();
      i++;
      continue;
    }

    // 段落：连续非空行合成一段
    flushList();
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s|&gt;\s?|\|)/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!);
      i++;
    }
    html.push(`<p>${inline(paragraph.join(" "), options)}</p>`);
  }

  flushList();
  return html.join("\n");
}

// 从正文里抽出全部引用 key（顺序去重）。
export function citedKeys(source: string): string[] {
  const keys = [...(source ?? "").matchAll(CITE)].map((m) => m[1]!);
  return [...new Set(keys)];
}
