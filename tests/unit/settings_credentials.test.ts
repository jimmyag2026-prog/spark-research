import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { CONFIG_FILE } from "../../backend/src/config";
import { CREDENTIALS_FILE } from "../../backend/src/daemon/credentials";
import { clearRegisteredSecrets, redactSecrets } from "../../backend/src/llm/types";
import { ServerContext } from "../../backend/src/server/context";
import { settingsRoutes } from "../../backend/src/server/routes/settings";
import { DELETE_NOTE } from "../../backend/src/server/routes/settings/credentials";
import type { RemoteAddressResolver } from "../../backend/src/server/routes/settings/shared";

// AD-18 的牙齿。六条硬约束各一条，缺一条不许合（LANE_gamma.md「凭据路由的硬约束」）。
//
// 用一个**不像凭据**的值来测：形状匹配（`sk-` / `Bearer` / `api_key:`）对它一个字都挡不住，
// 只有「写入即登记进 redactSecrets」这条约束能挡。拿 `sk-xxx` 来测等于给自己放水。
const SECRET = "9f4c2a7e51b83d06c7e2a4f8b1d093ae";
const CONNECTOR_ID = "aminer";
const PROVIDER_ID = "KIMI_API_KEY";

let root: string;
let logs: string[];
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

/**
 * 进程内的 `app.fetch` 拿不到传输层地址，而 loopback 闸是 **fail-closed** 的——
 * 所以单测必须显式注入。两种注入各有用处：
 *   · 不传参 → `assumeLoopback: true`（构造参数，请求方拿不到）：测正常路径；
 *   · 传 resolver → 伪造一个远端地址：测②的拒绝路径。
 * `makeRawApp()` 两个都不给，用来测「取不到地址时是不是真的拒绝」。
 */
function makeApp(remoteAddress?: RemoteAddressResolver): Hono {
  const ctx = new ServerContext({ root });
  const app = new Hono();
  app.route(
    "/api/settings",
    settingsRoutes(ctx, remoteAddress ? { remoteAddress } : { assumeLoopback: true }),
  );
  return app;
}

/** 完全不注入：等价于生产挂载点在一个拿不到连接信息的运行时上跑。 */
function makeRawApp(): Hono {
  const ctx = new ServerContext({ root });
  const app = new Hono();
  app.route("/api/settings", settingsRoutes(ctx));
  return app;
}

async function put(app: Hono, id: string, fields: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1/api/settings/credentials/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields }),
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spark-cred-"));
  clearRegisteredSecrets();
  logs = [];
  // ⑥ 的探针：把三个输出口都接到数组里，凭据值一旦经过任何一个就抓得到。
  const spy = (...args: unknown[]) => void logs.push(args.map((a) => String(a)).join(" "));
  console.log = spy;
  console.warn = spy;
  console.error = spy;
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  clearRegisteredSecrets();
});

describe("AD-18 ① write-only：值永不回到响应里", () => {
  test("PUT 之后 GET 只见字段名，两条响应体里都没有值", async () => {
    const app = makeApp();
    const writeRes = await put(app, CONNECTOR_ID, { api_key: SECRET });
    expect(writeRes.status).toBe(200);
    const writeBody = await writeRes.text();
    expect(writeBody).not.toContain(SECRET);
    expect(JSON.parse(writeBody).item.value).toBeNull();

    const listRes = await app.fetch(new Request("http://127.0.0.1/api/settings/credentials"));
    const listBody = await listRes.text();
    expect(listBody).not.toContain(SECRET);

    const item = JSON.parse(listBody).items.find((i: { key: string }) => i.key === CONNECTOR_ID);
    // 看得到的只有「哪些字段已设」这件事。
    expect(item.fieldsSet).toEqual(["api_key"]);
    expect(item.configured).toBe(true);
    expect(item.value).toBeNull();
  });

  test("值确实落盘了——不是靠不写入来通过①", () => {
    // 这条是①的对照：上一条断言「响应里没有」，这条断言「盘上真有」，
    // 两条一起才说明是 write-only 而不是 write-nothing。
    return (async () => {
      const app = makeApp();
      await put(app, CONNECTOR_ID, { api_key: SECRET });
      const onDisk = readFileSync(join(root, CREDENTIALS_FILE), "utf8");
      expect(onDisk).toContain(SECRET);
    })();
  });
});

describe("AD-18 ② loopback 硬限，且不受 originAllowlist 影响", () => {
  test("伪造非 loopback 远端地址 → PUT / DELETE 都是 403", async () => {
    const app = makeApp(() => "203.0.113.7");
    const res = await put(app, CONNECTOR_ID, { api_key: SECRET });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; nextStep: string };
    expect(body.nextStep.length).toBeGreaterThan(0);

    const del = await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, { method: "DELETE" }),
    );
    expect(del.status).toBe(403);
  });

  test("originAllowlist 里写上那个地址，仍然 403", async () => {
    // 白名单是给「可信前端域名」开的口子（app.ts 的 D-7），凭据写入不在那个口子里。
    // 谁把 shared.ts 的 loopback 判定改成去查 allowlist，这条就会红。
    writeFileSync(
      join(root, CONFIG_FILE),
      JSON.stringify({ originAllowlist: "203.0.113.7" }, null, 2) + "\n",
      { mode: 0o600 },
    );
    const app = makeApp(() => "203.0.113.7");
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://203.0.113.7:4321" },
        body: JSON.stringify({ fields: { api_key: SECRET } }),
      }),
    );
    expect(res.status).toBe(403);
    // 而且值一个字都没写进去。
    expect(() => statSync(join(root, CREDENTIALS_FILE))).toThrow();
  });

  test("取不到远端地址（且无注入）→ 403，不放行", async () => {
    // fail-closed：「解析不出来就放行」本身就是一条隐性放开路径。一旦某个部署形态
    // 让 getConnInfo 拿不到地址，这条硬限会静默失效——而且失效时没有任何信号。
    const app = makeRawApp();
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: { api_key: SECRET } }),
      }),
    );
    expect(res.status).toBe(403);
    expect(() => statSync(join(root, CREDENTIALS_FILE))).toThrow();

    const del = await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, { method: "DELETE" }),
    );
    expect(del.status).toBe(403);
  });

  test("assumeLoopback 是构造参数：请求方发什么头都拿不到它", async () => {
    // 不是「NODE_ENV=test 时认某个请求头」——那种开关一旦生产 NODE_ENV 被设错，
    // 就变成一个人人可发的绕过头。这里试着用最像的几个头去绕，全部应当仍是 403。
    const app = makeRawApp();
    const probes: Array<Record<string, string>> = [
      { "x-spark-test-loopback": "1" },
      { "x-forwarded-for": "127.0.0.1" },
      { host: "127.0.0.1" },
      { "assume-loopback": "true" },
    ];
    for (const headers of probes) {
      const res = await app.fetch(
        new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ fields: { api_key: SECRET } }),
        }),
      );
      expect(res.status).toBe(403);
    }
  });

  test("loopback 地址（含 IPv6 与 IPv4-mapped）放行", async () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await put(makeApp(() => address), CONNECTOR_ID, { api_key: SECRET });
      expect(res.status).toBe(200);
    }
  });
});

describe("AD-18 ③ 永不进 process.env", () => {
  test("写入之后 process.env 里没有这个值", async () => {
    const before = Object.keys(process.env).length;
    await put(makeApp(), CONNECTOR_ID, { api_key: SECRET });
    await put(makeApp(), PROVIDER_ID, { value: SECRET });
    expect(Object.values(process.env)).not.toContain(SECRET);
    expect(process.env[PROVIDER_ID]).toBeUndefined();
    // 也没有偷偷塞一个别名进去。
    expect(Object.keys(process.env).length).toBe(before);
  });
});

describe("AD-18 ④ 写入即登记进 redactSecrets", () => {
  test("写后把值塞进一条假 LLM 错误消息 → 经 redactSecrets 后不可见", async () => {
    // 先确认这个值**不是**靠形状能被认出来的：没登记之前原样透出。
    expect(redactSecrets(`HTTP 401: ${SECRET}`)).toContain(SECRET);

    await put(makeApp(), CONNECTOR_ID, { api_key: SECRET });

    const fakeUpstreamError = `HTTP 401: {"error":{"message":"invalid credential ${SECRET}"}}`;
    const redacted = redactSecrets(fakeUpstreamError);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("[redacted]");
  });

  test("provider 类凭据同样登记", async () => {
    await put(makeApp(), PROVIDER_ID, { value: SECRET });
    expect(redactSecrets(`网络层失败：${SECRET}`)).not.toContain(SECRET);
  });
});

describe("AD-18 ⑤ 文件 0600", () => {
  test("connector 与 provider 两条写入路径落的文件都是 0600", async () => {
    const app = makeApp();
    await put(app, CONNECTOR_ID, { api_key: SECRET });
    await put(app, PROVIDER_ID, { value: SECRET });
    for (const file of [CREDENTIALS_FILE, CONFIG_FILE]) {
      const mode = statSync(join(root, file)).mode & 0o777;
      expect(mode.toString(8).padStart(3, "0")).toBe("600");
    }
  });

  test("写后校验会把被外部改宽的权限收紧回来", async () => {
    const app = makeApp();
    await put(app, CONNECTOR_ID, { api_key: SECRET });
    const { chmodSync } = await import("node:fs");
    chmodSync(join(root, CREDENTIALS_FILE), 0o644);
    const res = await put(app, CONNECTOR_ID, { api_key: SECRET });
    const body = (await res.json()) as { item: { extra: { fileMode: string } } };
    expect(body.item.extra.fileMode).toBe("600");
    expect((statSync(join(root, CREDENTIALS_FILE)).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("AD-18 ⑥ 删除有确认语义", () => {
  test("DELETE 返回 { removed, note }，文案说清只删本机的值", async () => {
    const app = makeApp();
    await put(app, CONNECTOR_ID, { api_key: SECRET });
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; note: string; item: { fieldsSet: string[] } };
    expect(body.removed).toBe(true);
    expect(body.note).toBe(DELETE_NOTE);
    expect(body.note).toContain("不影响外部账户");
    expect(body.item.fieldsSet).toEqual([]);
  });

  test("删一个没配过的 id：removed=false，不假装删了什么", async () => {
    const res = await makeApp().fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, { method: "DELETE" }),
    );
    expect(((await res.json()) as { removed: boolean }).removed).toBe(false);
  });
});

describe("AD-18 ⑥+ 值不出现在 server 日志里", () => {
  test("一整轮写 / 读 / 删下来，console 的三个口都没见过这个值", async () => {
    const app = makeApp();
    await put(app, CONNECTOR_ID, { api_key: SECRET });
    await app.fetch(new Request("http://127.0.0.1/api/settings/credentials"));
    await app.fetch(
      new Request(`http://127.0.0.1/api/settings/credentials/${CONNECTOR_ID}`, { method: "DELETE" }),
    );
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  test("422 的错误消息里点的是字段名，不是值", async () => {
    const res = await put(makeApp(), CONNECTOR_ID, { not_a_field: SECRET });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(body).toContain("not_a_field");
  });
});
