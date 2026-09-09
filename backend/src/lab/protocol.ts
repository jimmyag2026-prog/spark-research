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
  // P10-d · D-8：「未消费」告警——协议原文里出现了量纲/试剂/浓度/生物安全等级之类的信号，
  // 但没有被任何一步 / 任何一条安全规则读取。安全门只吃编译产物，这里列的就是
  // 「用户写了但安全门根本看不到」的部分，绝不能让它悄悄消失在编译过程里。
  // **口径**：安全门四条规则里，只有 `volume_capacity` 全程接编译产物核对；
  // `chemical_compatibility` 认识的试剂表有限（见 REAGENT_PATTERNS）；`concentration_limit` /
  // `biosafety` 需要的 concentration / biosafetyLevel 字段，这条主管线目前完全不解析——
  // 这两条规则在正常调用路径上永远是空转的（对抗测试里用 `withReagents()` 手工注入的输入
  // 除外，那是在测规则本身，不是在测编译器产不产得出这种输入）。
  warnings: string[];
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

// P10-d · D-8 最小补强：中文关键词是原有的（v0.1 起，`name` 取 `keywords[0]`，不能改顺序——
// 对抗测试断言 detail 里的中文名），英文名/分子式是这次加的。评审原话是「英文/分子式协议
// 整体免疫」：NaOH、HCl、ethanol 这类写法之前一个都不识别。
// 匹配大小写不敏感（见 extractReagents）——分子式常见小写误输入（naoh），中文关键词不受影响。
// 没有扩到「所有能想到的试剂」：这是「常见项补一补」而不是造一个化学品数据库，
// 词表之外的东西一律靠下面的 unconsumed 信号兜底（列出来但不假装认识）。
const REAGENT_PATTERNS: Array<{ id: string; keywords: string[] }> = [
  { id: "strong_acid", keywords: ["盐酸", "硫酸", "HCl", "H2SO4", "hydrochloric acid", "sulfuric acid"] },
  { id: "hypochlorite", keywords: ["次氯酸钠", "次氯酸盐", "NaClO", "sodium hypochlorite", "bleach"] },
  { id: "hydroxide", keywords: ["氢氧化钠", "氢氧化钾", "NaOH", "KOH", "sodium hydroxide", "potassium hydroxide"] },
  { id: "ethanol", keywords: ["乙醇", "ethanol", "EtOH"] },
  { id: "peroxide", keywords: ["过氧化氢", "H2O2", "hydrogen peroxide"] },
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

// P10-d · D-8：续句自己的试剂**曾经**被静默丢弃——「加盐酸50µL，其中再补加次氯酸钠10µL」
// 里第二种试剂从没进过 `step.params.reagents`，chemical_compatibility 规则根本看不到它。
// 修法是往上一步的 reagents 列表里**追加**（按 reagentId/name 去重），不是覆盖。
function mergeReagents(step: ProtocolStep, reagents: ReagentSpec[]): boolean {
  if (reagents.length === 0) return false;
  const existing = (step.params.reagents as ReagentSpec[] | undefined) ?? [];
  const seen = new Set(existing.map((r) => r.reagentId ?? r.name));
  const additions = reagents.filter((r) => !seen.has(r.reagentId ?? r.name));
  if (additions.length === 0) return false;
  step.params.reagents = [...existing, ...additions];
  return true;
}

// ── P10-d · D-8：「未消费」信号扫描 ────────────────────────────────────────────
//
// 方针（评审明确要求）：**不**把自然语言解析做完美，只做「有信号但没被吃掉就一定要喊出来」。
// 下面几个检测都刻意保守（宁可漏报也不批量误报）：
//   - 体积：只在**同一句里出现 ≥2 处**体积数字时报——extractVolume/mergeContinuation
//     的实现就是正则 exec 一次只拿第一个匹配，第二个往后一定被扔了，这是结构性的、
//     不用猜。只出现一处、只是落进了别的字段名（如 serialDilute 的 transferVolume）
//     不算未消费，那是「消费了，只是换了个名字」。
//   - 温度 / 时长：句子里有温度或时长的文字描述，但这一句最终产出的 step.params
//     里没有对应字段——说明这句话被识别成了一个根本不认温度/时长的动作（比如整句被
//     addSample 抢走），描述被静默吞掉了。
//   - 浓度 / 生物安全等级：编译器主管线**完全不解析**这两类字段（安全门的
//     concentration_limit / biosafety 规则永远空转，见 D-8 devlog），只要句子里出现
//     类似表达就无条件报——不判断"有没有被用到"，因为压根不会被用到。
//   - 试剂：不做"看起来像化学式就报"的通用启发式——"OD"这种常见缩写会被误伤成
//     两两分开的元素符号。只用扩过的 REAGENT_PATTERNS 词表；词表之外的化学品
//     暂时没有专门信号，这是本次收敛里明确承认没做的部分（见 devlog）。
function allVolumeMentions(sentence: string): string[] {
  const re = /(\d+(?:\.\d+)?)\s*(mL|uL|µL|μL|毫升|微升)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) out.push(m[0]);
  return out;
}

const CONCENTRATION_SIGNAL = /(\d+(?:\.\d+)?)\s*(?:%|mol\/l|mmol\/l|mM|M(?![a-z]))|摩尔浓度|浓度\s*(?:为|是|：|:)?\s*\d/i;
const BIOSAFETY_SIGNAL = /BSL[-\s]?[1-4]|生物安全[一二三四1234]级|biosafety\s*level\s*[1-4]/i;

function scanUnconsumedSignals(
  clause: string,
  outcome: { params: Record<string, unknown> | null; mergedInto: ProtocolStep | null },
): string[] {
  const warnings: string[] = [];
  const volumes = allVolumeMentions(clause);
  if (volumes.length > 1) {
    warnings.push(
      `「${clause}」里出现了 ${volumes.length} 处体积数值（${volumes.join(" / ")}），` +
        `编译器只按第一处记账，其余未被任何步骤消费——volume_capacity 规则算不到它们。`,
    );
  }
  const targetParams = outcome.params ?? outcome.mergedInto?.params ?? null;
  if (targetParams) {
    if (extractTemperature(clause) !== undefined && targetParams.temperature === undefined) {
      warnings.push(`「${clause}」提到了温度，但这句话最终没有落在带温度参数的步骤上——温度信息未被消费。`);
    }
    if (extractDurationSec(clause) !== undefined && targetParams.durationSec === undefined) {
      warnings.push(`「${clause}」提到了时长，但这句话最终没有落在带时长参数的步骤上——时长信息未被消费。`);
    }
  }
  if (CONCENTRATION_SIGNAL.test(clause)) {
    warnings.push(
      `「${clause}」疑似包含浓度描述，但编译器当前不解析试剂浓度——concentration_limit 规则对这句话空转` +
        `（P10-d D-8：这条规则在主管线里还没接通，见 devlog）。`,
    );
  }
  if (BIOSAFETY_SIGNAL.test(clause)) {
    warnings.push(
      `「${clause}」疑似包含生物安全等级描述，但编译器当前不解析 biosafetyLevel——biosafety 规则对这句话空转` +
        `（P10-d D-8：这条规则在主管线里还没接通，见 devlog）。`,
    );
  }
  return warnings;
}

export class ProtocolCompiler {
  compile(naturalLanguageProtocol: string, options: ProtocolCompileOptions = {}): Protocol {
    const clauses = naturalLanguageProtocol
      .split(/[，,；;。\n]/)
      .map((c) => c.trim())
      .filter(Boolean);

    const steps: ProtocolStep[] = [];
    const warnings: string[] = [];
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
        const paramsMerged = mergeContinuation(previous, clause);
        const reagentsMerged = mergeReagents(previous, reagents);
        if (paramsMerged || reagentsMerged) {
          warnings.push(...scanUnconsumedSignals(clause, { params: null, mergedInto: previous }));
          continue;
        }
      }
      if (!rule) {
        // 整句一个动作都没认出来、也没能合并进上一步——最彻底的「静默丢弃」，
        // 更要扫一遍：至少浓度/生物安全/多体积这几类信号不能因为整句被跳过就消失。
        warnings.push(...scanUnconsumedSignals(clause, { params: null, mergedInto: null }));
        continue;
      }
      const params = rule.paramBuilder(clause);
      if (reagents.length) params.reagents = reagents;
      warnings.push(...scanUnconsumedSignals(clause, { params, mergedInto: null }));
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
      warnings,
    };
  }

  private extractReagents(sentence: string): ReagentSpec[] {
    const lower = sentence.toLowerCase();
    return REAGENT_PATTERNS.filter((r) => r.keywords.some((k) => lower.includes(k.toLowerCase()))).map(
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
