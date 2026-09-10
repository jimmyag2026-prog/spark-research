// V27 · 内嵌资产的运行期解包（`.py` 专用）。
//
// 为什么需要这一层，而不是像 `.sql`/`.txt` 那样静态 import 完事：
//
//   `.sql` / `.txt` 是**进程内**读内容——静态 `import x from "./x.sql" with { type: "text" }`
//   把内容编译进二进制，直接就能用。
//   `.py` 不是。`opentrons_backend.py` / `python_kernel.py` / 两个 `runner.py` 都要被
//   `Bun.spawn([python, scriptPath])` 当成**外部进程的命令行参数**——外部 python 面对的是
//   操作系统真实的文件系统，需要一个磁盘上真实存在的路径。
//
// F-c 实测过 Bun 的 embedded-file 机制（`with { type: "file" }`）：它给的是
// `/$bunfs/root/runner-xxxx.py` 这种 Bun 运行时内部的虚拟路径，外部 python 报
// `can't open file`，exit=2（docs/devlog/F-c.md §3.2）。**单靠 `type: "file"` 不行。**
//
// 所以走 F-c §3.3 验证过的组合修法：
//   静态 import 文本（内容进二进制）→ 运行期写到真实临时文件 → spawn 指向那个真实路径。
//
// 另外一条约束是 F-c 没提、但实现时躲不掉的：两个 `runner.py` 都做
// `sys.path.insert(0, str(Path(__file__).resolve().parents[2]))` 然后
// `from simulation.sim_runtime import ...`——它们不是孤立脚本，是一棵 python 包树里的模块。
// 只解包 `runner.py` 一个文件，python 会在 import 阶段就 ModuleNotFoundError。
// 因此这里的单位是**资产树**（`materializeAssetTree`），不是单文件；单文件（
// `opentrons_backend.py` / `python_kernel.py`，两者只 import 标准库）是它的退化情形。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 编译产物里 `import.meta.dir` 恒为 `/$bunfs/root`；这是"我在不在单二进制里"唯一无歧义的判据。 */
export const RUNNING_IN_COMPILED_BINARY = import.meta.dir.startsWith("/$bunfs");

/** 相对路径 → 文件内容。相对路径用 `/` 分隔，会被 join 成宿主机的分隔符。 */
export type AssetTree = Readonly<Record<string, string>>;

// 解包完成的标记文件。用"先写进 staging 目录、最后一步 rename"的方式落盘，
// 所以看到这个标记就意味着整棵树都写完了——不会让并发的另一个进程读到半棵树。
const COMPLETE_MARKER = ".spark-asset-complete";

// 进程内缓存：同一棵树在一次运行里只探一次盘。
const materialized = new Map<string, string>();

/** 解包根目录。指纹进目录名，所以内容变了自然换目录，不存在"读到上一个版本"的陈旧问题。 */
export function assetCacheRoot(): string {
  return join(tmpdir(), "spark-research-assets");
}

function fingerprint(key: string, files: AssetTree): string {
  const hash = createHash("sha256");
  hash.update(key);
  for (const rel of Object.keys(files).sort()) {
    hash.update("\0");
    hash.update(rel);
    hash.update("\0");
    hash.update(files[rel] ?? "");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * 把一棵内嵌资产树解包到磁盘上一个真实目录，返回该目录的绝对路径。
 *
 * 幂等：目录名带内容指纹，已经解包过（`COMPLETE_MARKER` 在）就直接返回，不重写盘。
 * 源码模式与二进制模式走**同一条**代码路径——不搞 `if (RUNNING_IN_COMPILED_BINARY)` 分叉，
 * 否则单测在源码模式下永远走不到二进制那条分支，就又变成"测试跑绿、产物照坏"（V28）。
 */
export function materializeAssetTree(key: string, files: AssetTree): string {
  const fp = fingerprint(key, files);
  const cacheKey = `${key}-${fp}`;

  const cached = materialized.get(cacheKey);
  if (cached && existsSync(join(cached, COMPLETE_MARKER))) return cached;

  const target = join(assetCacheRoot(), cacheKey);
  if (existsSync(join(target, COMPLETE_MARKER))) {
    materialized.set(cacheKey, target);
    return target;
  }

  mkdirSync(assetCacheRoot(), { recursive: true });
  const staging = mkdtempSync(join(assetCacheRoot(), `.staging-${key}-`));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(staging, ...rel.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    // 标记必须最后写：它是"这棵树完整了"的唯一凭据。
    writeFileSync(join(staging, COMPLETE_MARKER), fp, "utf8");
    try {
      renameSync(staging, target);
    } catch (error) {
      // 并发：另一个进程抢先 rename 成功了。它写的内容和我们的逐字节相同（指纹一致），
      // 直接用它的即可；只有目标确实不完整时才是真错误。
      if (!existsSync(join(target, COMPLETE_MARKER))) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  materialized.set(cacheKey, target);
  return target;
}

/** 单文件资产的便捷形式：解包后返回那个文件本身的绝对路径。 */
export function materializeAsset(key: string, relPath: string, content: string): string {
  return join(materializeAssetTree(key, { [relPath]: content }), ...relPath.split("/"));
}
