// kind=skill 扩展的 index.ts：目录布局要求它存在（见任务书顶部的扩展目录结构），
// 但技能的真正契约在 SKILL.md 的 frontmatter 里（skill_verify.ts 校验的是那个）。
// 这里留一个最小的、无副作用的具名导出即可——不承担任何行为契约。
export const registered = true;
