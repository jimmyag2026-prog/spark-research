import { afterEach, describe, expect, test } from "bun:test";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";
import { ServerContext } from "../../backend/src/server/context";
import { saveConfig } from "../../backend/src/config";

// V126（A7 Blocker-2）：HTTP 请求体里的 `model` 被静默忽略，且 configuredDefaultModel() 不带 root
// 读的是默认数据目录而不是本 server 的 deps.root——「显式传 model」与「config 配默认模型」双双失效。
// 阴性对照（已验红）：ctx.model() 忽略 override 参数 → 第一条红。

let fx: ServerFixture | null = null;
afterEach(async () => {
  await fx?.stop();
  fx = null;
});

describe("V126 · ctx.model 的优先级", () => {
  test("请求体 override > 注入的 deps.model", () => {
    const ctx = new ServerContext({ model: "injected-model" });
    expect(ctx.model("z-ai/glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
    expect(ctx.model(undefined)).toBe("injected-model");
    expect(ctx.model()).toBe("injected-model");
  });

  test("没有 override / deps.model 时，读的是**本 server 数据目录**的 config，而不是默认数据目录", () => {
    const fixture = makeServer({ slug: "m1" });
    fx = fixture;
    // 在这个 server 自己的数据目录里配一个独特的 defaultModel
    saveConfig({ defaultModel: "test-only/model-from-this-root" }, { root: fixture.root });
    const ctx = new ServerContext({ root: fixture.root });
    expect(ctx.model()).toBe("test-only/model-from-this-root");
    // override 仍然最高优先级
    expect(ctx.model("explicit")).toBe("explicit");
  });
});
