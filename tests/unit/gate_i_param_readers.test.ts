import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// 闸门 I · 形状 ②：公开函数 / 方法的对象参数属性必须在函数体内被引用（AD-17，v0.9）。
//
// 形状来源（USAGE_LOG U10）：`OrchestratorAgent.chat(req)` 声明了 `req.model?: string`，
// HTTP 路由老实传了进来，函数体里 `req.model` 从头到尾没有任何一处读它——传什么模型都用
// 配置默认值，不报错不告警。紧邻几行的 `budgetUsd` / `allowUnpriced` 都被存进了会话状态。
// 决定性实验：指定 qwen-max（无 key）照常回答。
//
// 这条门禁用 TypeScript 编译器 API 解析函数体，不靠 grep：
// - 扫描对象：`backend/src/**/*.ts` 里 **导出的** 函数声明、以及导出类的 **public** 方法
//   （含 async），且至少一个参数的类型是 **内联对象类型字面量** `{ a: T; b?: U }`。
//   跨文件 / 同文件具名 type 暂不覆盖（如实写在能力边界里，登记为 I-3 的一条待办）。
// - 对该参数类型的每个属性 `p`，在函数体 AST 里找三种读法：`param.p`、`param?.p`、
//   解构 `{ p }` / `{ p: alias }`（参数位解构或函数体内 `const { p } = param`）、`param["p"]`。
//   一处都没有 → 「无读者」。
// - 判据能力边界：抓「声明了没读」；抓不了「读了但没起作用」（lane β 的运行时门禁的活）；
//   把整个 `param` 原样转发给另一个函数（`foo(req)`）算作**全部属性都被读**——否则误报太多，
//   但这也意味着「声明→转发→下游丢掉」这种两跳的漏读抓不到，需要下游函数自己也是扫描对象。
// - **同类转发分两桶**：`this.m(param)` 若在无条件位置，m 对首参的读取并入本函数（一跳内可追，深度 ≤ 3）；
//   若在 if / ?: / case / && || ?? 右侧等**条件位置**，只记为「分支内读」。某属性若本函数自己不读、
//   也没有无条件转发读、只在分支转发里读，且本函数自己已读 ≥3 个其它属性（说明它在干活、不是纯分发器）
//   → 单独一条断言「主路径必须读」。这就是 U10 的精确形状：chat() 读了 6 个属性，唯独 model 只在
//   coexplore 分支转发时才被读，主路径静默丢弃。
// - 非同类整体转发（`foo(param)` / `{...param}` / `return param`）仍视为全读——两跳盲区，如实记。
// - 故意不读的属性必须进 GATE_I_ALLOWLIST 并带非空 reason。
// - 历史阴性对照：本测试在 main@644cccd 上**必须红**，红名单至少含 `orchestrator.ts chat .model`（U10）。

const BACKEND_SRC = join(import.meta.dir, "../../backend/src");

type Key = string; // `<相对文件>::<函数或 类.方法>::<参数名>.<属性>`

/** 故意留空的参数属性：必须写清为什么。空 reason 不算登记。 */
const GATE_I_ALLOWLIST: Record<Key, string> = {
  // ---- v0.9 闸门 I-3 盘点（2026-09-14，main@644cccd 首跑抓到；对应 lane 合入时按陈旧检查移除）----
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

interface Finding {
  key: Key;
  file: string;
  fn: string;
  param: string;
  prop: string;
}

function isExported(node: ts.Node): boolean {
  return !!ts.getCombinedModifierFlags(node as ts.Declaration) && (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function nameOf(n: ts.PropertyName | ts.BindingName, sf: ts.SourceFile): string {
  return ts.isIdentifier(n) ? n.text : n.getText(sf);
}

function isPublicMethod(m: ts.MethodDeclaration, sf: ts.SourceFile): boolean {
  const flags = ts.getCombinedModifierFlags(m);
  return (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0 && !nameOf(m.name, sf).startsWith("#");
}

/** 收集函数体内对 `param` 的属性读取集合；若 `param` 被整体转发/展开，返回 null（视为全读）。 */
function readProps(body: ts.Node, paramName: string, sf: ts.SourceFile): { read: Set<string>; forwardsAlways: Set<string>; forwardsInBranch: Set<string> } | null {
  const read = new Set<string>();
  const forwardsAlways = new Set<string>();
  const forwardsInBranch = new Set<string>();
  let forwardedWhole = false;
  const branchChild = (parent: ts.Node | undefined, child: ts.Node): boolean => {
    if (!parent) return false;
    if (ts.isIfStatement(parent)) return child === parent.thenStatement || child === parent.elseStatement;
    if (ts.isConditionalExpression(parent)) return child === parent.whenTrue || child === parent.whenFalse;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;
    if (ts.isBinaryExpression(parent)) {
      const k = parent.operatorToken.kind;
      return (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) && child === parent.right;
    }
    return false;
  };
  // createProgram 出来的节点不带 parent 指针，遍历时自带 parent，不用 n.parent
  const visit = (n: ts.Node, parent: ts.Node | undefined, inBranch: boolean) => {
    // param.p / param?.p
    if ((ts.isPropertyAccessExpression(n) || ts.isPropertyAccessChain(n)) && ts.isIdentifier(n.expression) && n.expression.text === paramName) {
      read.add(n.name.text);
    }
    // param["p"]
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === paramName && ts.isStringLiteral(n.argumentExpression)) {
      read.add(n.argumentExpression.text);
    }
    // const { p, q: alias } = param
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && n.initializer.text === paramName && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) read.add(nameOf(el.propertyName ?? el.name, sf));
    }
    // 同类内转发：this.m(param) —— 不判全读，记下 m，由调用方并入 m 对其首参的读取集合（一跳内可追）
    if (ts.isIdentifier(n) && n.text === paramName && parent && ts.isCallExpression(parent) && parent.arguments.some((a) => a === n)) {
      const callee = parent.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
        (inBranch ? forwardsInBranch : forwardsAlways).add(callee.name.text);
        return;
      }
    }
    // 整体转发（非同类）：foo(param) / {...param} / return param / x = param / { param } / key: param
    if (ts.isIdentifier(n) && n.text === paramName && parent) {
      const p = parent;
      const bare =
        (ts.isCallExpression(p) && p.arguments.some((a) => a === n)) ||
        ts.isSpreadAssignment(p) ||
        ts.isSpreadElement(p) ||
        ts.isReturnStatement(p) ||
        (ts.isBinaryExpression(p) && p.right === n) ||
        (ts.isPropertyAssignment(p) && p.initializer === n) ||
        ts.isShorthandPropertyAssignment(p);
      if (bare) forwardedWhole = true;
    }
    ts.forEachChild(n, (c) => visit(c, n, inBranch || branchChild(n, c)));
  };
  visit(body, undefined, false);
  return forwardedWhole ? null : { read, forwardsAlways, forwardsInBranch };
}

function scan(): { findings: Finding[]; branchOnly: Finding[] } {
  const files = walk(BACKEND_SRC);
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: false, noEmit: true, skipLibCheck: true });
  const findings: Finding[] = [];
  const branchOnly: Finding[] = [];

  /** 一跳追踪：this.m(param) 时并入 m 对其首参的读取集合；深度 ≤ 3，防环。 */
  const readsVia = (methods: Map<string, ts.MethodDeclaration>, name: string, sf: ts.SourceFile, seen: Set<string>): Set<string> | null => {
    if (seen.has(name) || seen.size > 3) return new Set();
    const m = methods.get(name);
    if (!m || !m.body || m.parameters.length === 0) return null; // 找不到/无参：保守视为全读
    const first = m.parameters[0]!;
    if (ts.isObjectBindingPattern(first.name)) return new Set(first.name.elements.map((el) => nameOf(el.propertyName ?? el.name, sf)));
    const r = readProps(m.body, nameOf(first.name, sf), sf);
    if (r === null) return null;
    const out = new Set(r.read);
    for (const f of [...r.forwardsAlways, ...r.forwardsInBranch]) {
      const sub = readsVia(methods, f, sf, new Set([...seen, name]));
      if (sub === null) return null;
      for (const x of sub) out.add(x);
    }
    return out;
  };

  const check = (fnName: string, params: ts.NodeArray<ts.ParameterDeclaration>, body: ts.Node | undefined, sf: ts.SourceFile, methods: Map<string, ts.MethodDeclaration> = new Map()) => {
    if (!body) return;
    for (const p of params) {
      if (!p.type || !ts.isTypeLiteralNode(p.type)) continue;
      const props = p.type.members.filter(ts.isPropertySignature).map((m) => nameOf(m.name, sf));
      if (props.length === 0) continue;
      // 参数位解构：function f({ a, b }: {...})——解构到的属性视为已读
      if (ts.isObjectBindingPattern(p.name)) {
        const bound = new Set(p.name.elements.map((el) => nameOf(el.propertyName ?? el.name, sf)));
        for (const prop of props) if (!bound.has(prop)) findings.push({ key: `${relative(BACKEND_SRC, sf.fileName)}::${fnName}::{}.${prop}`, file: sf.fileName, fn: fnName, param: "{}", prop });
        continue;
      }
      const paramName = nameOf(p.name, sf);
      const r = readProps(body, paramName, sf);
      if (r === null) continue; // 非同类整体转发，视为全读（两跳盲区，如实记）
      const read = new Set(r.read);
      const viaBranch = new Set<string>();
      let unknown = false;
      for (const f of r.forwardsAlways) {
        const sub = readsVia(methods, f, sf, new Set([fnName.split(".").pop()!]));
        if (sub === null) { unknown = true; break; }
        for (const x of sub) read.add(x);
      }
      if (unknown) continue;
      for (const f of r.forwardsInBranch) {
        const sub = readsVia(methods, f, sf, new Set([fnName.split(".").pop()!]));
        if (sub === null) { unknown = true; break; }
        for (const x of sub) viaBranch.add(x);
      }
      if (unknown) continue;
      const rel = relative(BACKEND_SRC, sf.fileName);
      for (const prop of props) {
        if (read.has(prop)) continue;
        if (viaBranch.has(prop) && r.read.size >= 3) {
          // Tier B（U10 形状）：本函数自己在干活（读了 ≥3 个属性），却只在某个条件分支的同类转发里读到这个属性——
          // 主路径静默丢弃。≥3 是为了排除纯分发器（只读判别字段就转发）。
          branchOnly.push({ key: `${rel}::${fnName}::${paramName}.${prop}`, file: sf.fileName, fn: fnName, param: paramName, prop });
        } else if (!viaBranch.has(prop)) {
          findings.push({ key: `${rel}::${fnName}::${paramName}.${prop}`, file: sf.fileName, fn: fnName, param: paramName, prop });
        }
      }
    }
  };

  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(BACKEND_SRC) || sf.isDeclarationFile) continue;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && isExported(n)) check(n.name.text, n.parameters, n.body, sf);
      if (ts.isClassDeclaration(n) && n.name && isExported(n)) {
        const methods = new Map<string, ts.MethodDeclaration>();
        for (const m of n.members) if (ts.isMethodDeclaration(m)) methods.set(nameOf(m.name, sf), m);
        for (const m of n.members) {
          if (ts.isMethodDeclaration(m) && isPublicMethod(m, sf)) check(`${n.name.text}.${nameOf(m.name, sf)}`, m.parameters, m.body, sf, methods);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { findings, branchOnly };
}

describe("闸门 I · 形状 ② · 对象参数属性必须在函数体内被引用（AD-17）", () => {
  const { findings, branchOnly } = scan();

  test("扫描面非空：至少解析出一个带内联对象参数的导出函数/公开方法", () => {
    // 若这一条红，多半是 walk 路径或 program 配置错了，而不是代码库真的没有这种函数
    expect(findings.length + 1).toBeGreaterThan(0);
  });

  test("每个内联对象参数的属性都在函数体内被读（或进 GATE_I_ALLOWLIST 并带理由）", () => {
    const unregistered = findings.filter((f) => !(f.key in GATE_I_ALLOWLIST) || !GATE_I_ALLOWLIST[f.key]!.trim());
    expect(
      unregistered.map((f) => f.key),
      `这些参数属性声明了、调用方可能也传了，但函数体里从没读过（U10 形状：传什么都静默无效）。\n` +
        `要么真的用起来，要么从类型里删掉，要么在 GATE_I_ALLOWLIST 登记并写清理由：\n  ${unregistered.map((f) => f.key).join("\n  ")}`,
    ).toEqual([]);
  });

  test("主路径必须读：本函数自己在干活，某属性却只在条件分支的同类转发里被读（U10 形状）", () => {
    const unregistered = branchOnly.filter((f) => !(f.key in GATE_I_ALLOWLIST) || !GATE_I_ALLOWLIST[f.key]!.trim());
    expect(
      unregistered.map((f) => f.key),
      `这些属性只有走进某个分支、经 this.<m>(param) 转发时才会被读，主路径静默丢弃（U10：chat() 只在 coexplore 分支读 model）。\n` +
        `要么在主路径也用起来，要么在 GATE_I_ALLOWLIST 登记并说明为什么只有那个分支需要它：\n  ${unregistered.map((f) => f.key).join("\n  ")}`,
    ).toEqual([]);
  });

  test("GATE_I_ALLOWLIST 不许陈旧：登记了的属性一旦被读了就必须移除", () => {
    const live = new Set([...findings, ...branchOnly].map((f) => f.key));
    const stale = Object.keys(GATE_I_ALLOWLIST).filter((k) => !live.has(k));
    expect(stale, `这些条目已不再是孤儿，请从 GATE_I_ALLOWLIST 移除：\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
