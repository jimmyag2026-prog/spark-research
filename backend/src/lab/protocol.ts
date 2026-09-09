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

function extractCount(sentence: string): number | undefined {
  const m =
    /(\d+)\s*(?:个|级|步|档)?\s*(?:梯度|稀释度|倍比稀释|dilutions?|points?)/i.exec(sentence) ??
    /(?:稀释|dilut\w*)\D{0,6}?(\d+)\s*(?:个|级|步|档|次)/i.exec(sentence);
  return m ? Number(m[1]) : undefined;
}

function extractFactor(sentence: string): number | undefined {
  const ratio = /1\s*[:：]\s*(\d+(?:\.\d+)?)/.exec(sentence);
  if (ratio) return Number(ratio[1]);
  const times = /(\d+(?:\.\d+)?)\s*(?:倍比|倍)/.exec(sentence);
  return times ? Number(times[1]) : undefined;
}

const ACTION_RULES: ActionRule[] = [
  {
    // 梯度稀释必须排在「加/转移」之前：「每步转移 100µL」里的「转移」会先命中 addSample。
    // 这条规则是 P6 新增的（协议 B 的入口），既有规则一条没动。
    // 刻意**不**收「稀释」单字：「配制稀释液」说的是配液不是做梯度。
    keywords: ["梯度稀释", "连续稀释", "倍比稀释", "系列稀释", "serial dilution"],
    action: "serialDilute",
    device: "liquid_handler",
    expectedOutput: "dilution series prepared",
    paramBuilder: (sentence) => {
      const { volume, unit } = extractVolume(sentence);
      const params: Record<string, unknown> = {
        // 默认 6 个梯度、每步 100 µL、混匀 3 次 —— 都是可被句子里的数字覆盖的保守值。
        dilutionSteps: extractCount(sentence) ?? 6,
        transferVolume: volume ?? 100,
        unit: unit ?? "uL",
        diluentVolume: volume ?? 100,
        mixVolume: Math.round((volume ?? 100) * 0.8),
        mixRepetitions: 3,
        factor: extractFactor(sentence) ?? 2,
      };
      return params;
    },
  },
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

// 「参数续句」：只在补充上一步的参数，不是新的一步。
// 「每步转移 100µL 并混匀 3 次」里的「转移」会命中 addSample，凭空多出一步移液；
// 而这句话说的其实是上一步梯度稀释的参数。P6 新增，是协议 B 能被正确编译的前提。
const CONTINUATION_MARKERS = /每步|每级|每次|每个梯度|每孔|其中|即每/;

// 续句参数 → 上一步 params 的映射。按上一步的**动作**决定同一个数字该落到哪个键：
// 「100 µL」对 serialDilute 是每级转移体积，对 addSample 就是加样体积。
function mergeContinuation(step: ProtocolStep, clause: string): boolean {
  let merged = false;
  const { volume, unit } = extractVolume(clause);
  if (volume != null) {
    if (step.action === "serialDilute") {
      step.params.transferVolume = volume;
      step.params.diluentVolume = volume;
      step.params.mixVolume = Math.round(volume * 0.8);
    } else {
      step.params.volume = volume;
    }
    if (unit) step.params.unit = unit;
    merged = true;
  }
  const repetitions = /(?:混匀|混合|吹打|mix)\D{0,4}?(\d+)\s*(?:次|times)/i.exec(clause);
  if (repetitions) {
    step.params.mixRepetitions = Number(repetitions[1]);
    merged = true;
  }
  const temperature = extractTemperature(clause);
  if (temperature != null && step.params.temperature != null) {
    step.params.temperature = temperature;
    merged = true;
  }
  const durationSec = extractDurationSec(clause);
  if (durationSec != null && step.params.durationSec != null) {
    step.params.durationSec = durationSec;
    merged = true;
  }
  return merged;
}

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
      // 续句（或压根不含动作词但带参数的句子）合并进上一步，而不是新起一步。
      // 「不认识就跳过」会把参数**静默丢掉**，那比多一步更糟——用户写了却没生效。
      const previous = steps[steps.length - 1];
      if (previous && (!rule || CONTINUATION_MARKERS.test(clause))) {
        if (mergeContinuation(previous, clause)) continue;
      }
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
