import type { DeviceType } from "./devices";

export interface ReagentSpec {
  name: string;
  reagentId?: string;
  concentration?: number;
  volume?: number;
}

export interface ProtocolStep {
  id: string;
  action: string;
  device: DeviceType;
  params: Record<string, unknown>;
  expectedOutput: string;
}

export interface SafetyCheckResult {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface Protocol {
  id: string;
  name: string;
  steps: ProtocolStep[];
  safetyChecks: SafetyCheckResult[];
  createdAt: string;
}

export interface ProtocolCompileOptions {
  name?: string;
  protocolId?: string;
}

interface ActionRule {
  keywords: string[];
  exclude?: string[];
  action: string;
  device: DeviceType;
  expectedOutput: string;
  paramBuilder: (sentence: string) => Record<string, unknown>;
}

function extractVolume(sentence: string): { volume?: number; unit?: string } {
  const m = /(\d+(?:\.\d+)?)\s*(mL|uL|µL|μL|毫升|微升)/i.exec(sentence);
  if (!m) return {};
  const raw = m[2].toLowerCase();
  const unit =
    raw === "毫升" ? "mL" : raw === "微升" ? "uL" : raw.startsWith("m") ? "mL" : "uL";
  return { volume: Number(m[1]), unit };
}

function extractTemperature(sentence: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*°?\s*(?:c|摄氏度|度)/i.exec(sentence);
  return m ? Number(m[1]) : undefined;
}

function extractDurationSec(sentence: string): number | undefined {
  if (/过夜|隔夜/.test(sentence)) return 12 * 60 * 60;
  const minutes = /(\d+(?:\.\d+)?)\s*(?:分钟|min)/i.exec(sentence);
  if (minutes) return Math.round(Number(minutes[1]) * 60);
  const hours = /(\d+(?:\.\d+)?)\s*(?:小时|h(?![a-z]))/i.exec(sentence);
  if (hours) return Math.round(Number(hours[1]) * 3600);
  const seconds = /(\d+(?:\.\d+)?)\s*(?:秒|sec|s(?![a-z]))/i.exec(sentence);
  if (seconds) return Math.round(Number(seconds[1]));
  return undefined;
}

const ACTION_RULES: ActionRule[] = [
  {
    keywords: ["配", "配置", "配制", "制备"],
    action: "prepareReagent",
    device: "liquid_handler",
    expectedOutput: "solution volume confirmed",
    paramBuilder: (sentence) => extractVolume(sentence),
  },
  {
    keywords: ["加", "加入", "添加", "转移"],
    action: "addSample",
    device: "liquid_handler",
    expectedOutput: "sample dispensed into well",
    paramBuilder: (sentence) => extractVolume(sentence),
  },
  {
    keywords: ["孵育", "培养", "恒温", "37°c", "37℃"],
    exclude: ["培养基"],
    action: "incubate",
    device: "incubator",
    expectedOutput: "incubation completed",
    paramBuilder: (sentence) => {
      const params: Record<string, unknown> = {
        temperature: extractTemperature(sentence) ?? 37,
      };
      const durationSec = extractDurationSec(sentence);
      if (durationSec != null) params.durationSec = durationSec;
      return params;
    },
  },
  {
    keywords: ["震荡", "振荡", "摇床", "摇动"],
    action: "shake",
    device: "shaker",
    expectedOutput: "mixing completed",
    paramBuilder: (sentence) => {
      const rpm = /(\d+(?:\.\d+)?)\s*rpm/i.exec(sentence);
      const params: Record<string, unknown> = { rpm: rpm ? Number(rpm[1]) : 800 };
      const temperature = extractTemperature(sentence);
      if (temperature != null) params.temperature = temperature;
      return params;
    },
  },
  {
    keywords: ["离心"],
    action: "centrifuge",
    device: "centrifuge",
    expectedOutput: "pellet separated",
    paramBuilder: (sentence) => {
      const rcf = /(\d+(?:\.\d+)?)\s*(?:x\s*g|g|rcf)/i.exec(sentence);
      const durationSec = extractDurationSec(sentence);
      return { rcf: rcf ? Number(rcf[1]) : 12000, duration: durationSec ?? 60 };
    },
  },
  {
    keywords: ["读数", "读取", "测定", "检测", "酶标"],
    action: "read",
    device: "plate_reader",
    expectedOutput: "OD readings collected",
    paramBuilder: (sentence) => {
      const wl = /(\d{3,4})\s*nm/i.exec(sentence);
      return { wavelength: wl ? Number(wl[1]) : 600 };
    },
  },
];

const REAGENT_PATTERNS: Array<{ id: string; keywords: string[] }> = [
  { id: "strong_acid", keywords: ["盐酸", "硫酸"] },
  { id: "hypochlorite", keywords: ["次氯酸钠", "次氯酸盐"] },
  { id: "hydroxide", keywords: ["氢氧化钠", "氢氧化钾"] },
  { id: "ethanol", keywords: ["乙醇"] },
];

export class ProtocolCompiler {
  compile(naturalLanguageProtocol: string, options: ProtocolCompileOptions = {}): Protocol {
    const clauses = naturalLanguageProtocol
      .split(/[，,；;。\n]/)
      .map((c) => c.trim())
      .filter(Boolean);

    const steps: ProtocolStep[] = [];
    for (const clause of clauses) {
      const reagents = this.extractReagents(clause);
      const rule = ACTION_RULES.find(
        (r) =>
          r.keywords.some((k) => clause.includes(k)) &&
          !(r.exclude ?? []).some((k) => clause.includes(k)),
      );
      if (!rule) continue;
      const params = rule.paramBuilder(clause);
      if (reagents.length) params.reagents = reagents;
      steps.push({
        id: `step-${steps.length + 1}`,
        action: rule.action,
        device: rule.device,
        params,
        expectedOutput: rule.expectedOutput,
      });
    }

    return {
      id: options.protocolId ?? `protocol-${Date.now()}`,
      name: options.name ?? naturalLanguageProtocol.slice(0, 40),
      steps,
      safetyChecks: [],
      createdAt: new Date().toISOString(),
    };
  }

  private extractReagents(sentence: string): ReagentSpec[] {
    return REAGENT_PATTERNS.filter((r) => r.keywords.some((k) => sentence.includes(k))).map(
      (r) => ({
        name: r.keywords[0],
        reagentId: r.id,
      }),
    );
  }
}

export function validateProtocol(protocol: Protocol): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (protocol.steps.length === 0) {
    issues.push("protocol has no steps");
  }
  const hasLiquidPreparation = protocol.steps.some(
    (s) => s.device === "liquid_handler" && s.action === "prepareReagent",
  );
  for (const step of protocol.steps) {
    if (step.device === "centrifuge" && !hasLiquidPreparation) {
      issues.push(`step ${step.id}: centrifugation requires liquid preparation first`);
    }
  }
  return { valid: issues.length === 0, issues };
}
