// V27 · 非 TS 资产的静态 import 类型声明。
//
// `bun build --compile` 不会把 `.sql` / `.py` / `.txt` 一起打进单二进制——运行期
// `readFileSync(join(import.meta.dir, "x.sql"))` 在产物里解析成 `/$bunfs/root/x.sql`，
// 一个只有 Bun 运行时自己认识的虚拟路径，`fs` 打不开（见 docs/devlog/F-c.md §1）。
// 修法是把资产**内容**在编译期静态 import 进来：
//
//     import SCHEMA_SQL from "./schema.sql" with { type: "text" };
//
// tsc 不认识这些扩展名，所以这里给三类资产各补一条 ambient 声明。
// 注意：这只解决"内容进得来"，**不解决"外部子进程按路径读得到"**——`.py` 还要
// 多做一步运行期解包（见 ./embedded.ts）。

declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.py" {
  const content: string;
  export default content;
}
