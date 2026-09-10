import pkg from "../../package.json";

// 版本号的单一真源是仓库根的 package.json。
//
// **这里原先是 `readFileSync(join(import.meta.dir, "../../package.json"))`**，
// 注释写的理由是「静态 import 会把 package.json 整个打进产物，而这里只要一个字段」。
// v0.4 W1-d 的单二进制实测把这个理由证伪了：
//
//   ./dist/spark-research --version      → 0.3.1   （index.ts 用的是静态 import）
//   ./dist/spark-research capabilities   → 0.0.0   （这里读文件失败，落到兜底值）
//
// `bun build --compile` 产出的二进制里 `import.meta.dir` 指向虚拟的 `/$bunfs/root/`，
// 运行期拼路径读不到真实文件，于是静默落到 "0.0.0"。**同一个二进制对外报两个版本号**
// ——而这正是 AD-12「对外声称必须机器可核」要防的那种事。
//
// 权衡重算：package.json 几 KB vs 62MB 的二进制，省下来的体积可以忽略；
// 换来的是两个入口报同一个版本。原决定的成本/收益判断当时就是错的。
export const PACKAGE_VERSION: string =
  typeof pkg.version === "string" ? pkg.version : "0.0.0";
