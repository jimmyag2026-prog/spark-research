---
name: good-skill
description: 演示 ext verify 如何校验技能扩展的 frontmatter，并在用户想知道"怎么装一个技能扩展"时被加载参考，仅用于测试。
category: literature
domain: A
triggers: [怎么写一个技能扩展, ext verify 的技能测试夹具]
connectors: []
validation: [tests/hello.test.ts]
---

# good-skill

这是 `tests/unit/extensions.test.ts` 的测试夹具，演示一个合规的 SKILL.md frontmatter
长什么样，不承担任何真实能力。

## 反模式

不要在生产环境里依赖这个技能——它只是 `ext verify` 的正向测试素材。
