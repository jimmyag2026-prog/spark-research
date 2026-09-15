import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_CONNECTOR_HELP,
  parseAuthConnectorArgs,
  runAuthConnector,
} from "../../backend/src/cli/auth_connector";
import { CREDENTIALS_FILE, CredentialStore } from "../../backend/src/daemon/credentials";
import { clearRegisteredSecrets, redactSecrets } from "../../backend/src/llm/types";
import { ServerContext } from "../../backend/src/server/context";
import { settingsRoutes } from "../../backend/src/server/routes/settings";
import { Hono } from "hono";

// γ-5（U6）：`spark-research auth --connector <id>`。
// 数据源面板显示的下一步就是这条命令——它必须真的能把 key 写进去，
// 而且必须与 HTTP 写入路径**共用同一个 CredentialStore**。

const SECRET = "3c9a71fe40d8b625ae13f7c0925d4b8f";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "spark-authc-"));
}

/** 假的不回显读入口：按字段名喂值。 */
function prompter(answers: Record<string, string>): (label: string) => Promise<string> {
  return async (label: string) => {
    const field = label.trim().split(/[（:]/)[0]!.trim();
    return answers[field] ?? "";
  };
}

afterEach(() => clearRegisteredSecrets());

describe("auth --connector · 参数解析", () => {
  test("不给 --field 时默认 api_key", () => {
    expect(parseAuthConnectorArgs(["--connector", "aminer"])).toEqual({
      connector: "aminer",
      fields: ["api_key"],
      help: false,
    });
  });

  test("--field 可重复（Modal 要两个字段）", () => {
    const args = parseAuthConnectorArgs(["--connector", "modal", "--field", "tokenId", "--field", "tokenSecret"]);
    expect(args.fields).toEqual(["tokenId", "tokenSecret"]);
  });

  test("--help 不做任何副作用", async () => {
    const lines: string[] = [];
    const code = await runAuthConnector(["--help"], { out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toBe(AUTH_CONNECTOR_HELP);
  });

  test("不给 --connector 时报错并给出下一步", async () => {
    const errs: string[] = [];
    const code = await runAuthConnector([], { err: (l) => errs.push(l) });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("下一步");
  });
});

describe("auth --connector · 真的把 key 写进去", () => {
  test("写进 credentials.json，文件 0600，输出里没有值", async () => {
    const root = workspace();
    const out: string[] = [];
    const code = await runAuthConnector(["--connector", "aminer"], {
      root,
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      prompt: prompter({ api_key: SECRET }),
    });
    expect(code).toBe(0);

    const file = join(root, CREDENTIALS_FILE);
    expect(readFileSync(file, "utf8")).toContain(SECRET);
    expect((statSync(file).mode & 0o777).toString(8).padStart(3, "0")).toBe("600");
    // V115 的延伸：录入不回显，落地之后更不该打印。
    expect(out.join("\n")).not.toContain(SECRET);
    expect(out.join("\n")).toContain("api_key");
  });

  test("多字段：只重录一个不会把另一个清掉", async () => {
    const root = workspace();
    await runAuthConnector(["--connector", "modal", "--field", "tokenId", "--field", "tokenSecret"], {
      root,
      out: () => {},
      prompt: prompter({ tokenId: "id-0001", tokenSecret: SECRET }),
    });
    await runAuthConnector(["--connector", "modal", "--field", "tokenSecret"], {
      root,
      out: () => {},
      prompt: prompter({ tokenSecret: "rotated-9999" }),
    });
    const values = new CredentialStore({ root }).get("modal");
    expect(values).toEqual({ tokenId: "id-0001", tokenSecret: "rotated-9999" });
  });

  test("全部留空 = 什么都不改，不是清空", async () => {
    const root = workspace();
    const store = new CredentialStore({ root });
    store.set("aminer", { api_key: SECRET });
    const out: string[] = [];
    await runAuthConnector(["--connector", "aminer"], {
      root,
      out: (l) => out.push(l),
      prompt: prompter({}),
    });
    expect(store.get("aminer")).toEqual({ api_key: SECRET });
    expect(out.join("\n")).toContain("未做改动");
  });

  test("CLI 写入同样登记进 redactSecrets（AD-18 ④ 两条路径同一套约束）", async () => {
    const root = workspace();
    expect(redactSecrets(`HTTP 401: ${SECRET}`)).toContain(SECRET);
    await runAuthConnector(["--connector", "aminer"], {
      root,
      out: () => {},
      prompt: prompter({ api_key: SECRET }),
    });
    expect(redactSecrets(`HTTP 401: ${SECRET}`)).not.toContain(SECRET);
  });
});

describe("auth --connector 与 HTTP 写入路径共用同一份存储", () => {
  test("CLI 写进去的，凭据面板立刻看得到（只看得到字段名）", async () => {
    const root = workspace();
    await runAuthConnector(["--connector", "aminer"], {
      root,
      out: () => {},
      prompt: prompter({ api_key: SECRET }),
    });

    const app = new Hono();
    app.route("/api/settings", settingsRoutes(new ServerContext({ root })));
    const res = await app.fetch(new Request("http://127.0.0.1/api/settings/credentials"));
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const item = JSON.parse(text).items.find((i: { key: string }) => i.key === "aminer");
    expect(item.configured).toBe(true);
    expect(item.fieldsSet).toEqual(["api_key"]);
  });

  test("面板写进去的，CLI 侧的 CredentialStore 也读得到", async () => {
    const root = workspace();
    const app = new Hono();
    app.route("/api/settings", settingsRoutes(new ServerContext({ root })));
    await app.fetch(
      new Request("http://127.0.0.1/api/settings/credentials/aminer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: { api_key: SECRET } }),
      }),
    );
    expect(new CredentialStore({ root }).get("aminer")).toEqual({ api_key: SECRET });
  });
});
