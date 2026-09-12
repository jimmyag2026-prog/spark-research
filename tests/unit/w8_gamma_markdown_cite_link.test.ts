import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../frontend/workspace/src/lib/markdown";

// V79①（BACKLOG 行 180/195，A5 遗留三条 UI 低危之一）：综述/精读卡/Idea 卡里的
// `[@key]` 引用 span 看着可点（CSS 早就写了 `cursor: help`、注释说「库内引用是可点的
// 锚」），实际没有接任何跳转。
//
// 修法分两半：
//   - `markdown.ts`（这里测的）：只给**库内可回链**的引用打 `data-key="<key>"`；
//     库外引用没有 record 可跳，不该假装可点。
//   - `components/ui.tsx` 的 `Markdown` 组件用事件委托把 `data-key` 接到
//     `onCiteClick`，`components/cards.tsx` 用 `ws.recordIdForKey()` 把 key 解到
//     record id 再 `ws.selectRecord()` 跳转——这一半是 DOM/Solid 状态相关的行为，
//     不方便在 bun:test 的无浏览器环境里断言，留给 e2e／人工核对渲染结果。
describe("V79① · renderMarkdown 给库内引用打 data-key（供点击跳转用）", () => {
  test("库内 key（knownKeys 命中）→ 带 data-key，可点", () => {
    const html = renderMarkdown("参见 [@jumper2021highly]", { knownKeys: new Set(["jumper2021highly"]) });
    expect(html).toContain('data-key="jumper2021highly"');
    expect(html).toContain('class="cite"');
  });

  test("库外 key（knownKeys 未命中）→ 不带 data-key，标红且不可点", () => {
    const html = renderMarkdown("参见 [@vaswani2017attention]", { knownKeys: new Set(["jumper2021highly"]) });
    expect(html).not.toContain("data-key=");
    expect(html).toContain("cite-unknown");
  });

  test("没给 knownKeys（未知白名单）→ 保守不标「库外」，按现有纪律等同「未知不算库外」，带 data-key", () => {
    // 与既有纪律一致（inline() 里的注释：「没给白名单时不下库外的判断」）——不知道就
    // 不说库外，`unknown` 恒为 false，因此走的是与「库内」相同的分支。这不新造风险：
    // 真实产物里 cards.tsx 的四处 Markdown 调用点都恒定传了 `knownKeys`（见
    // state.tsx `ws.knownKeys()`），这个分支只在没传白名单的边界场景触发；即便触发，
    // `onCiteClick` 落到 `recordIdForKey()` 找不到对应 record 时也是空操作，不会跳转
    // 到错误的地方。
    const html = renderMarkdown("参见 [@somekey2020x]");
    expect(html).not.toContain("cite-unknown");
    expect(html).toContain('data-key="somekey2020x"');
  });
});
