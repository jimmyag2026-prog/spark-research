import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_VERSION } from "../version";

// δ-2（V162）：`/api/health` 的载荷。
//
// 为什么单拎一个文件：`server/app.ts` 是收口专属，这条 lane 只能往它里塞一行调用；
// 真正的判定逻辑住在这里，门禁也打在这里（`tests/unit/w10_delta_doctor.test.ts`）。
//
// 为什么加 `frontendBuilt`：V162 的现场是 `doctor` 报「前端未构建」，而浏览器打开 4321
// 看到的是一个**好端端的工作台**——因为 doctor 判的是**当前 checkout 的 cwd** 下有没有
// `frontend/workspace/dist/index.html`，而跑在 4321 上的是另一个 checkout 的实例，
// 那边早就构建过了。两句话都没说谎，但它们回答的是两个不同的问题，而用户问的只有一个：
// 「我现在打开浏览器会看到什么」。只有实例自己答得了这个问题，所以让它自己报。
//
// **刻意不把 frontendDir 放进载荷**：`/api/health` 是无鉴权端点，把一个绝对路径
// （里面通常有用户名）无条件吐给任何能连上这个端口的人，换来的只是 doctor 少打一行字。
// 不值。verdict=orphan_cwd 那条路径已经能从 lsof 拿到工作目录，那是本机 lsof，不是网络回答。
export interface HealthResponse {
  status: "ok";
  service: "spark-research";
  version: string;
  /** 这个**实例**托管的前端产物在不在（不是问 doctor 自己的 cwd）。 */
  frontendBuilt: boolean;
}

export function frontendBuiltAt(frontendDir: string): boolean {
  return existsSync(join(frontendDir, "index.html"));
}

export function healthPayload(frontendDir: string): HealthResponse {
  return {
    status: "ok",
    service: "spark-research",
    version: PACKAGE_VERSION,
    frontendBuilt: frontendBuiltAt(frontendDir),
  };
}
