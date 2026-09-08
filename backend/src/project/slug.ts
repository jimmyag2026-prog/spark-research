// project slug 的规则集中在这里：slug 直接参与路径拼接，必须严格校验，杜绝 ../ 穿越。
// 独立成模块是为了让 artifacts/store.ts 能复用而不与 project/manager.ts 形成循环依赖。

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new ProjectError(
      `无效的 project slug '${slug}'：只允许小写字母、数字、'.'、'-'、'_'，1-64 字符且以字母或数字开头`,
    );
  }
  return slug;
}

// 把自由字符串归一化为合法 slug（用于旧 artifact 的 project 字段兼容）。
export function slugify(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return SLUG_RE.test(s) ? s : null;
}
