import type { DeviceType } from "./devices";

export interface ReagentSpec {
  name: string;
  reagentId?: string;
  concentration?: number;
  /**
   * 浓度的单位（发布前外部验收补）。
   *
   * 原来 `extractConcentration()` **把单位丢了**——`%` 和 `mol/L` 都只返回一个裸数字，
   * 于是 `concentration_limit` 在**比较自己不知道单位的数**。这比「阈值定错」更深一层：
   * 101% 和 101 mol/L 在下游完全无法区分。
   *
   * 本字段先把单位如实带下来。**没有借此编造任何阈值**——单位口径本身是既有未决问题
   * （见 BACKLOG）。当前只用它做一件无歧义的判断：**百分比 > 100 物理上不存在**。
   */
  concentrationUnit?: "percent" | "molar" | "other" | "unspecified";
  volume?: number;
}

export interface ProtocolStep {
  id: string;
  action: string;
  device: DeviceType;
  params: Record<string, unknown>;
  expectedOutput: string;
  /**
   * V60（BACKLOG）：词表外试剂的原文兜底。这一步引用的试剂**一个都不在
   * REAGENT_PATTERNS 词表内**时，把从原句里抠出来的候选原文（不是整句——整句
   * 含体积数字、动作词等噪音）放在这里；`opentrons_protocol.ts` 用它给占位符
   * 加注（`未识别试剂#step-1（原文：硝酸）`），CLI/前端审批面据此显示原文并标
   * 「词表外，安全规则未覆盖」。
   *
   * 刻意**不**放进 `ProtocolStep.params.reagents`（`ReagentSpec[]`）——那个数组是
   * `safety.ts` 四条规则的输入源，塞一条没有 `reagentId` 的假条目会改变它们的
   * 迭代对象。只是因为两条规则都在缺 `reagentId`/`concentration` 时天然跳过
   * 才不会误伤，但这属于「恰好没坏」，不是「设计上安全」。原文单独放在这里，
   * 规则代码一行不用改，也不会被误读成"这试剂已经被安全门看过了"。
   */
  unrecognizedReagentText?: string;
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
  // P10-d · D-8 → V25：「未消费」告警——协议原文里出现了量纲/试剂/浓度/生物安全等级之类的
  // 信号，但没有被任何一步 / 任何一条安全规则读取。安全门只吃编译产物，这里列的就是
  // 「用户写了但安全门根本看不到」的部分，绝不能让它悄悄消失在编译过程里。
  // **口径（V25 更新）**：安全门四条规则里，`volume_capacity` 全程接编译产物核对；
  // `chemical_compatibility` 认识的试剂表有限（见 REAGENT_PATTERNS）；`concentration_limit` /
  // `biosafety` 需要的 concentration / biosafetyLevel 字段，这条主管线**现在会尝试解析**
  // （见 `extractConcentration` / `extractBiosafetyLevel`）——解析成功且能明确归属到某个
  // 试剂/步骤时，字段会真的写进编译产物，规则不再空转；解析失败（信号存在但抠不出值，
  // 或同句里试剂不止一种、归属歧义，或没有任何步骤可挂）时仍然只报 unconsumed 告警，
  // 不假装消费了。这仍然不是完整的自然语言浓度/生物安全解析器——跨句归属、复杂表达式
  // 依旧不认，见 safety.ts 顶部注释与 README「安全门当前的真实覆盖范围」。
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
//   - 浓度 / 生物安全等级（V25 更新）：编译器主管线**会尝试解析**这两类字段
//     （`extractConcentration` / `extractBiosafetyLevel`），解析成功且能确定归属
//     （浓度：同句里恰好一种试剂；生物安全：有步骤可挂）时就真的写进编译产物，
//     concentration_limit / biosafety 规则吃得到，这里就不报。解析失败——信号在但抠不出
//     数值、或同句多种试剂导致归属歧义、或没有任何步骤可挂——仍然报，且报的原因跟以前
//     不一样了：不是「主管线完全不解析」，是「这次没能确定性地解析/归属」（见 D-8 → V25 devlog）。
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

// **窄范围验收 B-5**：原正则只认 % 与 mol 系单位，于是 `g/L` / `mg/L` / `ppm` / `1:10 稀释`
// 这些写法**连未消费告警都不落**——用户写了浓度、规则没看见、还静默 ✅。
// 这直接违反 README 自己立的口径「『用户写了但安全门没看见』的内容绝不静默绿灯通过」。
// SIGNAL 的职责只是「这句话疑似有浓度描述」，宁可宽一点：抠不出可比的值就落告警，
// 那正是这个机制存在的理由。
const CONCENTRATION_SIGNAL =
  /(\d+(?:\.\d+)?)\s*(?:%|mol\/l|mmol\/l|mM|M(?![a-z])|g\/l|mg\/l|µg\/ml|ug\/ml|ppm|ppb)|摩尔浓度|质量浓度|\d+\s*[:：]\s*\d+\s*(?:稀释|dilution)|稀释\s*\d+\s*[:：]\s*\d+|浓度\s*(?:为|是|：|:)?\s*\d/i;
// 收窄到**明确的配液/试剂措辞**：原来把「加入」「取 N µL」也算进来，于是
// 「取样品50µL加入96孔板」这种干净协议也报警——正是窄范围验收警告的那种误杀。
const REAGENT_MENTION_SIGNAL = /配制|试剂(?!盒)|溶液/;
// 通用实验室液体：它们本来就不是受管化学品，报「不在试剂词表内」只会制造噪音。
// （窄范围验收的教训是两头都要防：漏放要报，误杀也是问题。）
const GENERIC_LIQUIDS = /样品|稀释液|缓冲液|培养基|上清|洗涤液|去离子水|蒸馏水|纯水|PBS/i;
const BIOSAFETY_SIGNAL = /BSL[-\s]?[1-4]|生物安全[一二三四1234]级|biosafety\s*level\s*[1-4]/i;

// 只有这几种动作会往 opentrons_protocol.ts 里的 `reservoir.wellFor(name)` 送一个
// 试剂名——只有这些动作产出的步骤需要"识别不出试剂就把原文带下来"这件事。
// serialDilute 的试剂显示走另一条既有的 "stock" 兜底（BACKLOG V60 原文只点了
// opentrons_protocol.ts:215/241 这两行），不在这次改动范围内。
const REAGENT_BEARING_ACTIONS = new Set<string>(["prepareReagent", "addSample"]);

// V60：词表外试剂的原文兜底。**不**建化学品数据库、不猜试剂身份——只从句子里减掉
// 已经确定识别出的结构（体积数字、命中这条规则的动作关键词），剩下的残留文本当作
// 候选原文。动作关键词可能互为子串（ACTION_RULES 里 "配" 是 "配制" 的前缀），
// 挑命中的里最长的那个删，否则短关键词会啃掉长关键词的一部分，留下断头的残留。
// 抠不出非空残留、或残留恰好是通用液体（样品/PBS/…，那些本就不是受管化学品）时
// 不猜——同一条纪律：宁可漏、不瞎报（见文件顶部 REAGENT_MENTION_SIGNAL 附近注释）。
function extractReagentRawText(clause: string, ruleKeywords: readonly string[]): string | undefined {
  let residual = clause;
  const volumeMatch = /\d+(?:\.\d+)?\s*(?:mL|uL|µL|μL|毫升|微升)/i.exec(residual);
  if (volumeMatch) residual = residual.replace(volumeMatch[0], "");
  const matchedKeywords = ruleKeywords.filter((k) => residual.includes(k));
  if (matchedKeywords.length > 0) {
    const longest = matchedKeywords.reduce((a, b) => (b.length > a.length ? b : a));
    residual = residual.replace(longest, "");
  }
  residual = residual
    .replace(/[，,、。；;：:]/g, "")
    .replace(/^(?:每步|每级|每次|每个梯度|每孔|其中|即每)/, "")
    .replace(/(试剂盒|缓冲液|溶液|试剂)$/, "")
    .trim();
  if (!residual) return undefined;
  if (GENERIC_LIQUIDS.test(residual)) return undefined;
  return residual;
}

// V25：SIGNAL 正则只负责「这句话疑似有这类描述」；下面两个函数负责「能不能确定性地
// 抠出一个可用的数值」。两者刻意不是同一个正则——SIGNAL 里的「摩尔浓度」分支就没有数字，
// 天然抠不出值，属于「有信号、解析失败」的合法情形，不是 bug。
const CHINESE_LEVEL_DIGIT: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4 };

function extractConcentration(sentence: string): { value: number; unit: ReagentSpec["concentrationUnit"] } | undefined {
  // 单位必须带下来：原实现返回裸数字，让下游规则在比较自己不知道单位的数（见 ReagentSpec）。
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(sentence);
  if (pct) return { value: Number(pct[1]), unit: "percent" };
  const molar = /(\d+(?:\.\d+)?)\s*(?:mol\/l|mmol\/l|mM|M(?![a-z]))/i.exec(sentence);
  if (molar) return { value: Number(molar[1]), unit: "molar" };
  // 质量/体积浓度等：数值抠得出，但**不是百分比口径**，所以标 unknown 让下游据实说明
  // （告警里说「单位不认识」而不是「抠不出数字」——窄范围验收发现后者是假话）。
  const other = /(\d+(?:\.\d+)?)\s*(?:g\/l|mg\/l|µg\/ml|ug\/ml|ppm|ppb)/i.exec(sentence);
  if (other) return { value: Number(other[1]), unit: "other" };
  const explicit = /浓度\s*(?:为|是|：|:)?\s*(\d+(?:\.\d+)?)/.exec(sentence);
  // 裸数字（「浓度为500」，没给单位）：按限值表的口径理解——V25 起的既有行为。
  // 跨单位比较的问题出在**认识但不同口径**的单位上（mol/L、g/L），不在这里。
  if (explicit) return { value: Number(explicit[1]), unit: "unspecified" };
  return undefined;
}

function extractBiosafetyLevel(sentence: string): number | undefined {
  const bsl = /BSL[-\s]?([1-4])/i.exec(sentence);
  if (bsl) return Number(bsl[1]);
  const zh = /生物安全([一二三四1234])级/.exec(sentence);
  if (zh) return CHINESE_LEVEL_DIGIT[zh[1]!] ?? Number(zh[1]);
  const en = /biosafety\s*level\s*([1-4])/i.exec(sentence);
  if (en) return Number(en[1]);
  return undefined;
}

/** 说出**这一次**真正的原因，不枚举一串可能性（窄范围验收 C）。 */
function concentrationMissReason(
  reason?: { reagentCount: number; unit?: "percent" | "molar" | "other" | "unspecified"; hasValue: boolean },
): string {
  if (!reason) return "原因未记录。";
  if (!reason.hasValue) {
    return "这句话里抠不出一个确定的浓度数值（比如只写了「摩尔浓度」而没给数）。下一步：把数值和单位写全，例如「配制 10% 次氯酸钠溶液」。";
  }
  if (reason.unit === "molar" || reason.unit === "other") {
    return (
      `数值抠出来了，但单位是${reason.unit === "molar" ? " mol 系（mol/L · mmol/L · mM）" : "本规则不认识的口径"}，` +
      `而限值表是**百分比口径**（见 BACKLOG V52）——**跨单位比大小会得出错误结论，所以宁可不比**。` +
      "下一步：若这个浓度需要受管，把它换算成百分比再写；否则人工核对。"
    );
  }
  if (reason.reagentCount === 0) {
    return "这句话里没有一个**词表内**的试剂——试剂词表只覆盖有限几类，词表外的试剂本规则完全看不见（这不是「相容」也不是「安全」）。下一步：人工核对该试剂的浓度是否安全。";
  }
  if (reason.reagentCount > 1) {
    return `同句里出现了 ${reason.reagentCount} 种试剂，浓度该挂给谁无法从句法上确定——**编译器不瞎猜**。下一步：把每种试剂的浓度分句写。`;
  }
  return "未能确定归属。";
}

function scanUnconsumedSignals(
  clause: string,
  outcome: { params: Record<string, unknown> | null; mergedInto: ProtocolStep | null },
  consumed: { concentration: boolean; biosafety: boolean },
  // **窄范围验收 C**：原来的告警把两个原因**枚举死**（「抠不出数字」/「同句多试剂」），
  // 而验收实测的场景里**两个都不成立**——真实原因是「试剂名不在词表里」。
  // 用户照着那条提示改写句子，改多少遍都没用。所以把真实原因传进来，说实话。
  reason?: { reagentCount: number; unit?: "percent" | "molar" | "other" | "unspecified"; hasValue: boolean },
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
  // V25：只在解析失败/归属不了时报——解析成功并且已经写进 ReagentSpec.concentration /
  // ProtocolStep.params.biosafetyLevel 的，不再报（那是真消费了，不是空转）。
  if (CONCENTRATION_SIGNAL.test(clause) && !consumed.concentration) {
    warnings.push(
      `「${clause}」疑似包含浓度描述，但 concentration_limit 规则看不到它——` +
        concentrationMissReason(reason),
    );
  }
  // **窄范围验收 A**：整句认出了一个「要用某种试剂」的动作，却一个词表内试剂都没匹配上时，
  // 编译产物里只剩一个占位符——用户无从核对自己批准的是什么，而
  // `chemical_compatibility` / `concentration_limit` 两条规则也**完全看不见它**（不是「相容」）。
  // 之前这种情形**零告警**，直接进 awaiting_approval。这是「安全门没看见的东西绝不静默通过」
  // 的直接违反，所以在这里补一条。
  if (
    reason &&
    reason.reagentCount === 0 &&
    REAGENT_MENTION_SIGNAL.test(clause) &&
    !GENERIC_LIQUIDS.test(clause)
  ) {
    warnings.push(
      // V60：编译产物现在会尽量把你写的原文带下去（未识别试剂#step-N（原文：…）），
      // 人在审批时能看见自己写的是什么——但这**只是把原文如实显示出来**，
      // chemical_compatibility 与 concentration_limit 两条规则依旧完全读不到它
      // （没有 reagentId，规则代码一行没改）。这条告警措辞因此改了一版，
      // 但告警本身没删：「安全门看不见」这件事仍然要喊出来。
      `「${clause}」提到了要用某种试剂，但**没有一个在试剂词表内**——` +
        `编译产物会把你写的原文保留下来（未识别试剂 + 原文），但 chemical_compatibility 与` +
        ` concentration_limit 两条规则**依旧完全看不见它**（这不是「相容」也不是「安全」）。` +
        `下一步：人工核对该试剂的相容性与浓度；若它应当受管，把它加进试剂词表再重新编译。`,
    );
  }
  if (BIOSAFETY_SIGNAL.test(clause) && !consumed.biosafety) {
    warnings.push(
      `「${clause}」疑似包含生物安全等级描述，但没能把它挂到任何一个步骤上——` +
        `biosafety 规则看不到它。`,
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
      // V25：浓度只在这句话恰好点名一种试剂时才挂上去——同句多种试剂时浓度归谁
      // 没法从句法上确定，宁可报未消费也不瞎猜（同一条纪律见 chemical_compatibility
      // 「表外试剂不设上限」、以及体积信号「≥2 处才报」的保守方针）。
      // **窄范围验收 B-1（我上一轮修了一半）**：`200mmol/L 乙醇` 曾被拦下并报
      // 「over-limit reagents: 乙醇 (200)」——0.2 M 乙醇是实验室最普通的东西。
      // 病根不是阈值，是**跨单位比较**：规则把单位剥掉，拿裸数字去撞百分比限值表。
      // 而最恶劣的是**理由撒谎**：说「超标」，真相是「我把 mmol/L 读成了 %」。
      // 用户会去改浓度，改到 0.09 M 才过关，全程不知道发生了什么。
      //
      // 上一轮我已经把单位解析出来了，却只用它做了「>100% 必拦」这一半。这里补另一半：
      // **只有百分比口径的浓度才挂上去**（`MAX_CONCENTRATION` 是百分比表，见 BACKLOG V52）。
      // 非百分比单位不是「安全」也不是「超标」，是**这条规则看不懂它**——
      // 走未消费告警，与「同句多试剂」「跨句归属」同一条纪律：宁可说看不懂，不瞎比。
      const concentrationValue = extractConcentration(clause);
      const concentrationComparable =
        concentrationValue?.unit === "percent" || concentrationValue?.unit === "unspecified";
      const concentrationAttachable =
        concentrationValue !== undefined && concentrationComparable && reagents.length === 1;
      if (concentrationAttachable) {
        reagents[0]!.concentration = concentrationValue.value;
        reagents[0]!.concentrationUnit = concentrationValue.unit;
      }
      const biosafetyValue = extractBiosafetyLevel(clause);
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
        // V25：biosafetyLevel 挂到「这句话最终归属的步骤」——续句里没有动作词，
        // 归属的就是上一步（与温度/时长续句同一套逻辑）。
        let biosafetyMerged = false;
        if (biosafetyValue !== undefined) {
          previous.params.biosafetyLevel = biosafetyValue;
          biosafetyMerged = true;
        }
        if (paramsMerged || reagentsMerged || biosafetyMerged) {
          warnings.push(
            ...scanUnconsumedSignals(
              clause,
              { params: null, mergedInto: previous },
              { concentration: concentrationAttachable && reagentsMerged, biosafety: biosafetyMerged },
              { reagentCount: reagents.length, unit: concentrationValue?.unit, hasValue: concentrationValue !== undefined },
            ),
          );
          continue;
        }
      }
      if (!rule) {
        // 整句一个动作都没认出来、也没能合并进上一步——最彻底的「静默丢弃」，
        // 更要扫一遍：至少浓度/生物安全/多体积这几类信号不能因为整句被跳过就消失。
        // 没有任何步骤可挂，浓度/生物安全无论解析成功与否都算未消费。
        warnings.push(
          ...scanUnconsumedSignals(
            clause,
            { params: null, mergedInto: null },
            { concentration: false, biosafety: false },
            { reagentCount: reagents.length, unit: concentrationValue?.unit, hasValue: concentrationValue !== undefined },
          ),
        );
        continue;
      }
      const params = rule.paramBuilder(clause);
      if (reagents.length) params.reagents = reagents;
      if (biosafetyValue !== undefined) params.biosafetyLevel = biosafetyValue;
      warnings.push(
        ...scanUnconsumedSignals(
          clause,
          { params, mergedInto: null },
          { concentration: concentrationAttachable, biosafety: biosafetyValue !== undefined },
          { reagentCount: reagents.length, unit: concentrationValue?.unit, hasValue: concentrationValue !== undefined },
        ),
      );
      // V60：这一步一个词表内试剂都没匹配上、但动作本身需要试剂身份（装载/加样）——
      // 把原文残留带下去，供 opentrons_protocol.ts 与 CLI/前端审批面显示。
      const unrecognizedReagentText =
        reagents.length === 0 && REAGENT_BEARING_ACTIONS.has(rule.action)
          ? extractReagentRawText(clause, rule.keywords)
          : undefined;
      steps.push({
        id: `step-${steps.length + 1}`,
        action: rule.action,
        device: rule.device,
        params,
        expectedOutput: rule.expectedOutput,
        ...(unrecognizedReagentText !== undefined ? { unrecognizedReagentText } : {}),
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
    const out: ReagentSpec[] = [];
    for (const pattern of REAGENT_PATTERNS) {
      // **发布前外部验收（BLOCKER-1）**：这里原来是 `name: r.keywords[0]`——
      // 于是同一分类下的任何试剂都被显示成组内第一个关键词：
      //     写「硫酸」→ 编译产物是「盐酸」（strong_acid 组的 keywords[0]）
      //
      // 这不是显示瑕疵，是**改写试剂身份**，而且落在物理世界路径上：
      //   · 人在 `lab approve` 时读的是「协议原文」（硫酸），批准的是编译产物的 hash（盐酸）
      //     ——**他批的不是他读的那个东西**，AD-6 的署名审批在这里失去意义；
      //   · 审计记录里会出现实验方案中根本不存在的化学品，证据链溯源到的是错的；
      //   · 拦截报告也跟着错（验收者原话：「我从没写过盐酸」）。
      //
      // 修法：**`name` 用真正匹配上的那个关键词**（用户写什么就是什么），
      // `reagentId` 仍是分类 id（规则匹配靠它，不受影响）。
      const matched = pattern.keywords.find((k) => lower.includes(k.toLowerCase()));
      if (matched === undefined) continue;
      out.push({ name: matched, reagentId: pattern.id });
    }
    return out;
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
