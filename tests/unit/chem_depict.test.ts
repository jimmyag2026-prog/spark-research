import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeSvg, depictSmiles } from "../../backend/src/chem/depict";
import { ProjectManager } from "../../backend/src/project/manager";

// C5-②（v0.5 W5-1-c）：`depictSmiles` 核心单测——真跑 rdkit（零 fixture 回放，
// depict 是本地子进程，不是网络 connector，没有什么好录像回放的）。
//
// rdkit 装在共享的仓库 .venv 里（VIRTUAL_ENV=.venv uv pip install rdkit，v0.5 W5-1-c
// 新增；worktree 用符号链接 .venv -> 主仓 .venv，见 devlog）。

function workspace(slug = "chem-unit") {
  const root = mkdtempSync(join(tmpdir(), "chem-depict-"));
  const manager = new ProjectManager(root);
  const project = manager.create(slug);
  return { root, manager, project };
}

// 测试注入点：把 DepictDeps.python 换成一个不调用真 rdkit 的假解释器，用来确定性地
// 触发 rdkit_unavailable / timeout / bad_output 分支——不依赖「本机真的没装 rdkit」
// 这种环境态。假解释器忽略传给它的 depict.py 路径参数，直接吃掉 stdin 后吐固定 stdout。
function fakePython(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chem-fakepy-"));
  const path = join(dir, "python");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("chem/depict.ts · depictSmiles", () => {
  test("合法 SMILES → SVG 合法 + artifact（image/svg+xml）+ computed record", async () => {
    const { project } = workspace();
    try {
      const result = await depictSmiles(
        { smiles: "CCO", name: "ethanol" },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.svg.startsWith("<svg")).toBe(true);
      expect(result.canonicalSmiles).toBe("CCO");
      expect(result.formula).toBe("C2H6O");
      expect(result.molWeight).toBeGreaterThan(0);
      expect(result.rdkitVersion.length).toBeGreaterThan(0);

      const artifact = project.artifacts().get(result.artifactId);
      expect(artifact?.contentType).toBe("image/svg+xml");
      expect(artifact?.filename).toBe("ethanol.svg");
      expect(artifact?.content.startsWith("<svg")).toBe(true);

      const record = project.records().get(result.recordId);
      expect(record?.type).toBe("artifact");
      expect(record?.evidence).toBe("computed");
      expect(record?.artifactId).toBe(result.artifactId);
      expect((record?.metadata as Record<string, unknown>).kind).toBe("chem_depiction");
      expect((record?.metadata as Record<string, unknown>).canonicalSmiles).toBe("CCO");
    } finally {
      project.close();
    }
  });

  test("没给 --name：默认文件名由 canonical SMILES 派生，重复 depict 同一分子递增版本", async () => {
    const { project } = workspace();
    try {
      const r1 = await depictSmiles(
        { smiles: "CCO" },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug },
      );
      const r2 = await depictSmiles(
        { smiles: "OCC" }, // 非 canonical 写法，canonical 后与 CCO 是同一个分子
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug },
      );
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) throw new Error("unreachable");
      const a1 = project.artifacts().get(r1.artifactId);
      const a2 = project.artifacts().get(r2.artifactId);
      expect(a1?.filename).toBe(a2?.filename);
      expect(a2?.version).toBeGreaterThan(a1?.version ?? 0);
    } finally {
      project.close();
    }
  });

  test("非法 SMILES：可见的失败（kind + 下一步指引），不落任何 artifact/record", async () => {
    const { project } = workspace();
    try {
      const before = project.artifacts().listByProjectSlug(project.slug).length;
      const beforeRecords = project.records().list().length;

      const result = await depictSmiles(
        { smiles: "not a smiles(((" },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("invalid_smiles");
      // 不是「解析失败」四个字了事——message 里必须带得出下一步该查什么。
      expect(result.error.message).toContain("检查");

      expect(project.artifacts().listByProjectSlug(project.slug).length).toBe(before);
      expect(project.records().list().length).toBe(beforeRecords);
    } finally {
      project.close();
    }
  });

  test("空 SMILES：同样是可见失败，不打真子进程", async () => {
    const { project } = workspace();
    try {
      const result = await depictSmiles(
        { smiles: "   " },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("invalid_smiles");
    } finally {
      project.close();
    }
  });

  test("rdkit 缺失：可操作的错误信息（带安装指引），不是裸错误码", async () => {
    const { project } = workspace();
    try {
      const python = fakePython(
        `cat > /dev/null; echo '{"ok": false, "error": {"kind": "rdkit_unavailable", ` +
          `"message": "rdkit 未安装。安装：VIRTUAL_ENV=.venv uv pip install rdkit"}}'`,
      );
      const result = await depictSmiles(
        { smiles: "CCO" },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug, python },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("rdkit_unavailable");
      expect(result.error.message).toContain("uv pip install rdkit");
    } finally {
      project.close();
    }
  });

  test("子进程超时：被 kill，kind=timeout", async () => {
    const { project } = workspace();
    try {
      // `exec sleep` 而不是 `sleep`（各自另开一行）很重要：`sleep` 作为独立语句会被
      // shell fork 成子进程，kill 只杀得掉外层 sh，孤儿 sleep 进程还留着继承来的
      // stdout 管道 fd 不放——`new Response(proc.stdout).text()` 就要等那个孤儿进程
      // 5 秒后自然退出才能读到 EOF，实测会把这条用例拖到 bun test 的默认超时。
      // `exec` 让 sleep 替换掉当前进程（不 fork，同一个 pid），kill 才是真的立刻生效。
      const python = fakePython(`cat > /dev/null\nexec sleep 5`);
      const result = await depictSmiles(
        { smiles: "CCO" },
        {
          artifacts: project.artifacts(),
          records: project.records(),
          projectSlug: project.slug,
          python,
          timeoutMs: 200,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("timeout");
    } finally {
      project.close();
    }
  });

  // 阴性对照②（任务书要求）：depict.py 对非法/异常输入吐「ok:true 但空 svg」而不是
  // ok:false——这条必须变红：assertSafeSvg 拦下空字符串（不以 "<svg" 开头），
  // depictSmiles 把它转成 kind=bad_output 的失败，并且不落任何 artifact/record。
  test("depict.py 吐空 SVG 却报 ok:true → 必须被拦下（不是把空图当成功存进库）", async () => {
    const { project } = workspace();
    try {
      const python = fakePython(
        `cat > /dev/null; echo '{"ok": true, "svg": "", "canonicalSmiles": "C", ` +
          `"formula": "CH4", "molWeight": 16.04, "rdkitVersion": "fake"}'`,
      );
      const before = project.artifacts().listByProjectSlug(project.slug).length;
      const beforeRecords = project.records().list().length;

      const result = await depictSmiles(
        { smiles: "C" },
        { artifacts: project.artifacts(), records: project.records(), projectSlug: project.slug, python },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("bad_output");
      expect(project.artifacts().listByProjectSlug(project.slug).length).toBe(before);
      expect(project.records().list().length).toBe(beforeRecords);
    } finally {
      project.close();
    }
  });
});

describe("chem/depict.ts · assertSafeSvg", () => {
  test("放行合法 SVG（以 <svg 开头，没有危险内容）", () => {
    expect(() => assertSafeSvg("<svg><circle /></svg>")).not.toThrow();
  });

  test("拒绝空字符串 / 不以 <svg 开头（含带 XML 声明前缀的原始 rdkit 输出）", () => {
    expect(() => assertSafeSvg("")).toThrow();
    expect(() => assertSafeSvg("<?xml version='1.0'?><svg></svg>")).toThrow();
  });

  test("拒绝 <script>", () => {
    expect(() => assertSafeSvg('<svg><script>alert(1)</script></svg>')).toThrow();
  });

  test("拒绝 on* 事件属性与 <foreignObject>", () => {
    expect(() => assertSafeSvg('<svg onload="alert(1)"></svg>')).toThrow();
    expect(() => assertSafeSvg("<svg><foreignObject></foreignObject></svg>")).toThrow();
  });
});
