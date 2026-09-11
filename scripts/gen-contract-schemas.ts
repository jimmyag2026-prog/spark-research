#!/usr/bin/env bun
// W8-2 · runtime contract 的 JSON Schema 生成器（构建期）。
//
// 为什么是构建期而不是运行期：`typescript` 编译器 ~10MB，不该进单二进制；HTTP 响应类型
// （server/types.ts）与导出 manifest（data/manifest.ts）是 TS 接口，运行期没有影子。
// 这里用 TS 的 checker 把**导出的接口/类型别名**翻成 JSON Schema（draft-07 子集），写到
// `backend/src/contract/schemas.generated.json`，运行期 `contract --json` 静态 import 它。
// 门禁：`tests/unit/contract.test.ts` 重新生成一遍与提交的文件逐字节比对（llms.txt 同款幂等）。
//
// 用法：bun scripts/gen-contract-schemas.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
export const SCHEMA_SOURCES: Array<{ file: string; group: "http" | "data" }> = [
  { file: "backend/src/server/types.ts", group: "http" },
  { file: "backend/src/data/manifest.ts", group: "data" },
];
export const SCHEMA_OUTPUT = "backend/src/contract/schemas.generated.json";

type Schema = Record<string, unknown>;

export interface GeneratedSchemas {
  $comment: string;
  sources: string[];
  /** 组 → 类型名 → schema（引用其它类型用 `$ref: "#/definitions/<Name>"`）。 */
  groups: Record<string, Record<string, Schema>>;
  definitions: Record<string, Schema>;
}

export function generateSchemas(root = ROOT): GeneratedSchemas {
  const files = SCHEMA_SOURCES.map((s) => join(root, s.file));
  const program = ts.createProgram(files, { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noEmit: true });
  const checker = program.getTypeChecker();
  const definitions: Record<string, Schema> = {};
  const groups: Record<string, Record<string, Schema>> = {};

  const inProgress = new Set<string>();

  function nameOf(type: ts.Type): string | null {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (!sym) return null;
    const name = sym.getName();
    if (name === "__type" || name === "__object" || name === "Array" || name === "ReadonlyArray" || name === "Record") return null;
    return name;
  }

  function schemaOf(type: ts.Type, depth: number): Schema {
    if (depth > 12) return { $comment: "depth-limit" };
    const flags = type.getFlags();
    if (flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === "true" };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.Undefined || flags & ts.TypeFlags.Void) return { $comment: "undefined" };
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (type.isUnion()) {
      const members = type.types.filter((t) => !(t.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      // boolean 在 checker 里是 true|false 的 union，收回成 boolean
      if (members.length === 2 && members.every((t) => t.getFlags() & ts.TypeFlags.BooleanLiteral)) return { type: "boolean" };
      const literals = members.filter((t) => t.isLiteral());
      if (literals.length === members.length) return { enum: literals.map((t) => (t as ts.LiteralType).value) };
      return { anyOf: members.map((t) => schemaOf(t, depth + 1)) };
    }
    if (type.isIntersection()) return { allOf: type.types.map((t) => schemaOf(t, depth + 1)) };
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: args[0] ? schemaOf(args[0], depth + 1) : {} };
    }
    const name = nameOf(type);
    if (name && !(flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous)) {
      if (!definitions[name] && !inProgress.has(name)) {
        inProgress.add(name);
        definitions[name] = objectSchema(type, depth + 1);
        inProgress.delete(name);
      }
      return { $ref: `#/definitions/${name}` };
    }
    if (flags & ts.TypeFlags.Object) return objectSchema(type, depth + 1);
    return { $comment: `unhandled:${checker.typeToString(type)}` };
  }

  function objectSchema(type: ts.Type, depth: number): Schema {
    const props: Record<string, Schema> = {};
    const required: string[] = [];
    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getDeclaredTypeOfSymbol(prop);
      const optional = Boolean(prop.getFlags() & ts.SymbolFlags.Optional);
      const nonUndefined = propType.isUnion() ? checker.getNonNullableType(propType) : propType;
      // 可选属性：去掉 undefined 后再翻；`x?: string | null` 保留 null
      const target = optional && propType.isUnion()
        ? (() => {
            const kept = propType.types.filter((t) => !(t.getFlags() & ts.TypeFlags.Undefined));
            return kept.length === 1 ? kept[0]! : propType;
          })()
        : propType;
      void nonUndefined;
      const s = schemaOf(target, depth + 1);
      const doc = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
      props[prop.getName()] = doc ? { ...s, description: doc } : s;
      if (!optional) required.push(prop.getName());
    }
    const out: Schema = { type: "object", properties: props, additionalProperties: false };
    if (required.length) out.required = required;
    const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      out.additionalProperties = schemaOf(stringIndex.type, depth + 1);
    }
    return out;
  }

  for (const { file, group } of SCHEMA_SOURCES) {
    const sf = program.getSourceFile(join(root, file));
    if (!sf) throw new Error(`读不到 ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) throw new Error(`${file} 不是模块`);
    const out: Record<string, Schema> = {};
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const decl = exp.declarations?.[0];
      if (!decl) continue;
      const resolved = exp.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      const rdecl = resolved.declarations?.[0];
      if (!rdecl) continue;
      if (!ts.isInterfaceDeclaration(rdecl) && !ts.isTypeAliasDeclaration(rdecl)) continue;
      const type = checker.getDeclaredTypeOfSymbol(resolved);
      const name = resolved.getName();
      inProgress.add(name);
      const schema = ts.isInterfaceDeclaration(rdecl) || type.getFlags() & ts.TypeFlags.Object ? objectSchema(type, 0) : schemaOf(type, 0);
      inProgress.delete(name);
      definitions[name] = schema;
      out[name] = { $ref: `#/definitions/${name}` };
    }
    groups[group] = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  }

  return {
    $comment: "由 scripts/gen-contract-schemas.ts 从 TS 接口生成；手改无效，改源类型后重跑。",
    sources: SCHEMA_SOURCES.map((s) => s.file),
    groups,
    definitions: Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function renderSchemas(root = ROOT): string {
  return JSON.stringify(generateSchemas(root), null, 2) + "\n";
}

if (import.meta.main) {
  const text = renderSchemas();
  const target = join(ROOT, SCHEMA_OUTPUT);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // 不存在 → 视为不一致
    }
    if (current !== text) {
      console.error(`❌ ${SCHEMA_OUTPUT} 与源类型不一致——跑 bun scripts/gen-contract-schemas.ts 后提交`);
      process.exit(1);
    }
    console.log("✅ contract schemas 一致");
  } else {
    writeFileSync(target, text);
    console.log(`✅ 写入 ${SCHEMA_OUTPUT}`);
  }
}
