// γ-1（V173 / U43）：检索源的**三态**——「勾没勾」「有没有凭据」「本次会不会真查」。
//
// U43 现场（2026-09-15 晚，用户问「现在会使用到 AMiner 么」）：
//
//   $ spark-research config get searchSources
//     openalex,crossref,europepmc,semanticscholar,arxiv,pubmed,biorxiv   ← 没有 aminer
//   $ spark-research lit sources
//     semanticscholar  凭据未配置
//     aminer           凭据已配置
//
// 也就是：**配了凭据的源不在检索清单里，在检索清单里的源没有凭据。**
// 两件事各自都「没报错」，于是谁都看不出这次检索到底谁参与了。
//
// 病根是这两件事在界面上从来没被放在一起过：凭据面板只说「配没配」，
// 检索源面板只说「勾没勾」。**第三件事——「本次会不会真查」——是它们的合取，
// 而这个合取此前没有任何地方算过。** 这个文件就是那个合取，且只有这一份：
// HTTP 面板（settings/scientific-tools.ts）、凭据写入响应（settings/credentials.ts）、
// CLI（`lit sources`）三个出口全部读它，不许各写一份文案。

export type SourceParticipation =
  /** 已勾选 + （免 key 或已配凭据）→ 这次真的会查它。 */
  | "will_search"
  /** 已勾选 + 需要 key 但没配 → 每次检索都被静默 skip。U43 的左半边。 */
  | "missing_credential"
  /** 未勾选 + 已配凭据 → 用户配了 key 却从没用上。U43 的右半边。 */
  | "configured_not_selected"
  /** 未勾选 + 没配（或免 key）→ 本来就不查，不是问题。 */
  | "not_selected";

export interface SourceParticipationInput {
  selected: boolean;
  apiKeyRequired: boolean;
  credentialConfigured: boolean;
}

export function sourceParticipation(input: SourceParticipationInput): SourceParticipation {
  if (input.selected) {
    return input.apiKeyRequired && !input.credentialConfigured ? "missing_credential" : "will_search";
  }
  return input.credentialConfigured ? "configured_not_selected" : "not_selected";
}

/** 一行给人看的状态。**这是唯一一份文案**，三个出口共用。 */
export function participationLabel(p: SourceParticipation): string {
  switch (p) {
    case "will_search":
      return "本次会真查";
    case "missing_credential":
      return "已勾选，但缺凭据 → 本次会被跳过";
    case "configured_not_selected":
      return "已配凭据，但没勾选 → 本次不查";
    case "not_selected":
      return "未勾选 → 本次不查";
  }
}

/**
 * 一句**可执行**的下一步。
 *
 * U6 点名过这件事：只显示状态不说去哪做，违反本项目自己的约定。
 * `will_search` / `not_selected` 两态没有下一步（前者已经对了，后者是用户自己的选择），
 * 返回 null——不许为了「每行都有话说」编一句。
 */
export function participationNextStep(p: SourceParticipation, id: string): string | null {
  switch (p) {
    case "missing_credential":
      return `在「凭据」面板直填，或在终端执行 \`spark-research auth --connector ${id}\``;
    case "configured_not_selected":
      return `去检索源面板勾选 ${id}（或 \`spark-research config set searchSources <逗号分隔清单，含 ${id}>\`）`;
    case "will_search":
    case "not_selected":
      return null;
  }
}

/** 三态 + 文案 + 下一步，一次算齐。 */
export function describeSourceState(
  id: string,
  input: SourceParticipationInput,
): {
  id: string;
  selected: boolean;
  apiKeyRequired: boolean;
  credentialConfigured: boolean;
  participation: SourceParticipation;
  participationLabel: string;
  participationNextStep: string | null;
} {
  const participation = sourceParticipation(input);
  return {
    id,
    ...input,
    participation,
    participationLabel: participationLabel(participation),
    participationNextStep: participationNextStep(participation, id),
  };
}
