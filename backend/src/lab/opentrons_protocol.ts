import { createHash } from "node:crypto";
import type { Protocol, ProtocolStep } from "./protocol";

// 协议编译目标：现有 protocol compiler 的 `Protocol` → **Opentrons Python Protocol API v2 脚本**
//（DESIGN 域 B2 / DEVELOPMENT_PLAN P6）。
//
// 三条编译纪律：
//
// 1. **不猜硬件**。Opentrons 上没有的设备（离心机、340 nm 酶标）不假装有：编译成
//    `[spark-note]` 注释，明确标成「离机人工步骤」。把离心编译成一个 delay 会让 run log
//    看起来「跑通了」，那是最糟的一种假成功。
// 2. **每一步都有锚点**。每个协议步骤前注入 `protocol.comment("[spark-step] <id> <action>")`。
//    run log 的结构化解析靠这个锚点把每条命令绑回编译产物里的某一步，不依赖 opentrons 的文案措辞。
// 3. **源码不含时间戳**。`protocolHash` = sha256(源码)。approve gate 批的是这个 hash，
//    源码里带编译时间的话每次编译都换 hash，approve 就永远失效了。
//
// 机型选择：**Flex**。opentrons 9.x 已经移除 OT-2 支持（`simulate()` 对 OT-2 协议直接
// RuntimeError），而且 OT-2 没有吸光度读板模块——协议 A 的「600 nm 读 OD」在 Flex 上
// 才有真模块可用，不必退化成注释。详见 devlog P6。

export const OPENTRONS_API_LEVEL = "2.21";
export const OPENTRONS_ROBOT_TYPE = "Flex";

// 一次编译用到的 deck 资源。全部是 Opentrons 官方 labware 定义名。
export const DECK = {
  tipRack200: "opentrons_flex_96_tiprack_200ul",
  tipRack1000: "opentrons_flex_96_tiprack_1000ul",
  reservoir: "nest_12_reservoir_15ml",
  plate: "corning_96_wellplate_360ul_flat",
  pipette: "flex_1channel_1000",
  mount: "left",
  slots: {
    plate: "D1",
    reservoir: "D2",
    tips: "C1",
    reader: "C3",
    trash: "A3",
  },
} as const;

// 容量上限：safety gate 的「超体积/超孔板容量」规则拿它当基准（不是编译器自己拍的数）。
export const PLATE_WELL_CAPACITY_UL = 360;
export const RESERVOIR_WELL_CAPACITY_UL = 15_000;
export const PIPETTE_MAX_VOLUME_UL = 1000;
export const PIPETTE_MIN_VOLUME_UL = 5;
// Opentrons Flex 吸光度读板模块支持的波长（官方固定四档）。
export const ABSORBANCE_WAVELENGTHS = [450, 562, 600, 650] as const;
// Heater-Shaker 的加热区间（官方规格）。低于下限只能靠环境温度，不假装能控温。
export const HEATER_SHAKER_TEMP_RANGE = { min: 37, max: 95 } as const;
export const HEATER_SHAKER_RPM_RANGE = { min: 200, max: 3000 } as const;

export interface DeckSlotPlan {
  slot: string;
  role: "tips" | "reservoir" | "plate" | "reader" | "trash";
  loadName: string;
  onModule: string | null;
}

export interface CompiledTransfer {
  stepId: string;
  from: string;
  to: string;
  volumeUl: number;
}

export interface CompiledStep {
  stepId: string;
  action: string;
  device: string;
  // 该步骤在 Opentrons 侧的落地方式。
  //   deck    真的动了机器人
  //   module  用了模块（加热/震荡/读板）
  //   manual  Opentrons 上没有这个硬件，编译成离机人工步骤注释
  execution: "deck" | "module" | "manual";
  summary: string;
  transfers: CompiledTransfer[];
  // 该步骤结束后每个孔的累计体积（µL）。safety gate 的容量规则读它。
  wellVolumesUl: Record<string, number>;
  notes: string[];
}

export interface OpentronsProgram {
  protocolId: string;
  name: string;
  apiLevel: string;
  robotType: string;
  source: string;
  protocolHash: string;
  deck: DeckSlotPlan[];
  pipette: { loadName: string; mount: string; maxVolumeUl: number; tipRack: string };
  modules: { heaterShaker: boolean; absorbanceReader: boolean };
  steps: CompiledStep[];
  // 编译期就知道的问题（不是安全门的职责，但用户该看到）。
  warnings: string[];
  // 反应板每个孔的最终累计体积（µL）——safety gate 与报告都读它。
  finalWellVolumesUl: Record<string, number>;
  // 每个转移动作的体积（µL），safety gate 的移液器量程规则读它。
  transfers: CompiledTransfer[];
}

export class ProtocolCompileError extends Error {
  constructor(message: string) {
    super(`协议编译失败：${message}`);
    this.name = "ProtocolCompileError";
  }
}

const ROW_A = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12"];
const RESERVOIR_WELLS = ROW_A;

function toMicroliters(value: unknown, unit: unknown): number | null {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return null;
  const u = String(unit ?? "uL").toLowerCase();
  if (u === "ml") return raw * 1000;
  if (u === "l") return raw * 1_000_000;
  return raw;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function pyNumber(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

// 试剂名 → reservoir 孔位。按首次出现顺序分配，保证同一份协议编译两次得到同一张映射
//（protocolHash 的确定性依赖这一点）。
class ReservoirMap {
  private assigned = new Map<string, string>();

  wellFor(name: string): string {
    const existing = this.assigned.get(name);
    if (existing) return existing;
    const index = this.assigned.size;
    if (index >= RESERVOIR_WELLS.length) {
      throw new ProtocolCompileError(
        `试剂种类超过 reservoir 孔数（${RESERVOIR_WELLS.length}）：第 ${index + 1} 种是 '${name}'`,
      );
    }
    const well = RESERVOIR_WELLS[index]!;
    this.assigned.set(name, well);
    return well;
  }

  entries(): Array<{ name: string; well: string }> {
    return [...this.assigned.entries()].map(([name, well]) => ({ name, well }));
  }
}

function reagentNamesOf(step: ProtocolStep): string[] {
  const list = (step.params.reagents ?? []) as Array<{ name?: string }>;
  const names = list.map((r) => String(r?.name ?? "")).filter(Boolean);
  return names.length > 0 ? names : [];
}

export interface CompileToOpentronsOptions {
  // 默认目标孔（协议里没说加到哪一孔时用）。
  defaultWell?: string;
  apiLevel?: string;
}

export function compileToOpentrons(
  protocol: Protocol,
  options: CompileToOpentronsOptions = {},
): OpentronsProgram {
  if (protocol.steps.length === 0) {
    throw new ProtocolCompileError("协议没有任何步骤，无法编译成可执行脚本");
  }
  const apiLevel = options.apiLevel ?? OPENTRONS_API_LEVEL;
  const defaultWell = options.defaultWell ?? "A1";
  const reservoir = new ReservoirMap();
  const warnings: string[] = [];
  const steps: CompiledStep[] = [];
  const wellVolumes: Record<string, number> = {};
  const allTransfers: CompiledTransfer[] = [];
  const body: string[] = [];

  const needsHeaterShaker = protocol.steps.some(
    (s) => s.action === "incubate" || s.action === "shake",
  );
  const readSteps = protocol.steps.filter((s) => s.action === "read");
  const readableWavelength = (step: ProtocolStep): number | null => {
    const wl = Number(step.params.wavelength ?? 600);
    return (ABSORBANCE_WAVELENGTHS as readonly number[]).includes(wl) ? wl : null;
  };
  const needsReader = readSteps.some((s) => readableWavelength(s) !== null);

  const plateRef = needsHeaterShaker ? "plate" : "plate";
  const addVolume = (well: string, delta: number) => {
    wellVolumes[well] = Number(((wellVolumes[well] ?? 0) + delta).toFixed(3));
  };

  for (const step of protocol.steps) {
    const notes: string[] = [];
    const transfers: CompiledTransfer[] = [];
    body.push("");
    body.push(`    # ── ${step.id} · ${step.action}（${step.device}）`);
    body.push(`    protocol.comment("[spark-step] ${step.id} ${step.action}")`);

    switch (step.action) {
      case "prepareReagent": {
        // 「配制缓冲液 / 配 50 mL 培养基」是**离机配液**：Flex 不会自己配缓冲液，
        // 人把配好的液体放进 reservoir。编译成装载说明 + reservoir 分配，
        // 不假装机器人做了配液，也不会把 50 mL 往 360 µL 的孔里倒。
        const volumeUl = toMicroliters(step.params.volume, step.params.unit);
        const names = reagentNamesOf(step);
        const reagentName = names[0] ?? "reagent";
        const well = reservoir.wellFor(reagentName);
        const amount = volumeUl === null ? "（未给体积）" : `${volumeUl} µL`;
        notes.push("离机配液：把配好的试剂放进 reservoir 对应孔位，模拟器不执行配液本身");
        body.push(
          `    protocol.comment(${pyString(`[spark-note] ${step.id} 装载 ${reagentName} ${amount} → reservoir ${well}`)})`,
        );
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "manual",
          summary: `离机配液并装载 ${reagentName} ${amount} 至 reservoir ${well}`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "addSample": {
        const volumeUl = toMicroliters(step.params.volume, step.params.unit);
        if (volumeUl === null) {
          throw new ProtocolCompileError(`${step.id}: 缺少可解析的体积（params.volume）`);
        }
        const names = reagentNamesOf(step);
        const sourceName = names[0] ?? "sample";
        const sourceWell = reservoir.wellFor(sourceName);
        const target = String(step.params.well ?? defaultWell);
        // 超过移液器量程就分次转移。这是**编译期**的物理约束，不是安全问题；
        // 「一次吸 5 mL」这种超孔板容量的事由 safety gate 判。
        const chunks = splitVolume(volumeUl);
        if (chunks.length > 1) {
          notes.push(
            `体积 ${volumeUl} µL 超过移液器量程 ${PIPETTE_MAX_VOLUME_UL} µL，拆成 ${chunks.length} 次转移`,
          );
        }
        body.push(
          `    pipette.transfer([${chunks.map(pyNumber).join(", ")}], ` +
            `[reservoir[${pyString(sourceWell)}]] * ${chunks.length}, ` +
            `[${plateRef}[${pyString(target)}]] * ${chunks.length}, new_tip="once")`,
        );
        for (const chunk of chunks) {
          const transfer: CompiledTransfer = {
            stepId: step.id,
            from: `reservoir:${sourceWell}`,
            to: `plate:${target}`,
            volumeUl: chunk,
          };
          transfers.push(transfer);
          allTransfers.push(transfer);
          addVolume(target, chunk);
        }
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "deck",
          summary: `${sourceName}（reservoir ${sourceWell}）→ 板孔 ${target}，共 ${volumeUl} µL`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "serialDilute": {
        const count = Math.max(2, Math.trunc(Number(step.params.dilutionSteps ?? 6)));
        const transferVolume = toMicroliters(step.params.transferVolume ?? 100, step.params.unit) ?? 100;
        const diluentVolume = toMicroliters(step.params.diluentVolume ?? transferVolume, step.params.unit) ?? transferVolume;
        const mixVolume = toMicroliters(step.params.mixVolume ?? Math.round(transferVolume * 0.8), step.params.unit) ?? transferVolume;
        const repetitions = Math.max(1, Math.trunc(Number(step.params.mixRepetitions ?? 3)));
        if (count > ROW_A.length) {
          throw new ProtocolCompileError(
            `${step.id}: 稀释梯度 ${count} 超过 96 孔板一行的孔数（${ROW_A.length}）`,
          );
        }
        const wells = ROW_A.slice(0, count);
        const stockName = reagentNamesOf(step)[0] ?? "stock";
        const stockWell = reservoir.wellFor(stockName);
        const diluentWell = reservoir.wellFor("diluent");

        // ① 先给 2..N 孔分装稀释液（第 1 孔是原液，不加）
        body.push(
          `    pipette.transfer(${pyNumber(diluentVolume)}, reservoir[${pyString(diluentWell)}], ` +
            `[${wells.slice(1).map((w) => `${plateRef}[${pyString(w)}]`).join(", ")}], new_tip="once")`,
        );
        for (const well of wells.slice(1)) {
          const transfer: CompiledTransfer = {
            stepId: step.id,
            from: `reservoir:${diluentWell}`,
            to: `plate:${well}`,
            volumeUl: diluentVolume,
          };
          transfers.push(transfer);
          allTransfers.push(transfer);
          addVolume(well, diluentVolume);
        }
        // ② 原液进第 1 孔。体积是 `稀释液 + 每级转移量`：转走一份之后第 1 孔仍留
        //    与其余孔相同的体积，整排才是可比的（否则 A1 会被抽空，曲线第一点就没了）。
        const stockVolume = Number((diluentVolume + transferVolume).toFixed(3));
        body.push(
          `    pipette.transfer(${pyNumber(stockVolume)}, reservoir[${pyString(stockWell)}], ` +
            `${plateRef}[${pyString(wells[0]!)}], new_tip="once")`,
        );
        const stockTransfer: CompiledTransfer = {
          stepId: step.id,
          from: `reservoir:${stockWell}`,
          to: `plate:${wells[0]}`,
          volumeUl: stockVolume,
        };
        transfers.push(stockTransfer);
        allTransfers.push(stockTransfer);
        addVolume(wells[0]!, stockVolume);
        // ③ 逐孔连续转移 + 混匀。每一步换新 tip：连续稀释里 tip 复用会把上一级
        //    的浓度带下去，整条曲线就废了。
        for (let i = 1; i < wells.length; i++) {
          const from = wells[i - 1]!;
          const to = wells[i]!;
          body.push(`    pipette.pick_up_tip()`);
          body.push(`    pipette.aspirate(${pyNumber(transferVolume)}, ${plateRef}[${pyString(from)}])`);
          body.push(`    pipette.dispense(${pyNumber(transferVolume)}, ${plateRef}[${pyString(to)}])`);
          body.push(
            `    pipette.mix(${repetitions}, ${pyNumber(mixVolume)}, ${plateRef}[${pyString(to)}])`,
          );
          body.push(`    pipette.drop_tip()`);
          const transfer: CompiledTransfer = {
            stepId: step.id,
            from: `plate:${from}`,
            to: `plate:${to}`,
            volumeUl: transferVolume,
          };
          transfers.push(transfer);
          allTransfers.push(transfer);
          addVolume(from, -transferVolume);
          addVolume(to, transferVolume);
        }
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "deck",
          summary:
            `${count} 级连续稀释（${wells[0]} → ${wells[count - 1]}），每级转移 ${transferVolume} µL、` +
            `稀释液 ${diluentVolume} µL、混匀 ${repetitions} 次`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "incubate": {
        const temperature = Number(step.params.temperature ?? 37);
        const durationSec = Number(step.params.durationSec ?? 0);
        if (temperature < HEATER_SHAKER_TEMP_RANGE.min) {
          // 低于加热下限：Heater-Shaker 只能加热不能制冷，不假装能控温。
          notes.push(
            `目标温度 ${temperature} °C 低于 Heater-Shaker 加热下限 ${HEATER_SHAKER_TEMP_RANGE.min} °C，` +
              `编译成计时等待（室温孵育），未设温控`,
          );
          body.push(
            `    protocol.comment(${pyString(`[spark-note] ${step.id} 室温孵育 ${temperature} °C（模块不支持制冷）`)})`,
          );
          body.push(`    protocol.delay(seconds=${pyNumber(durationSec)}, msg=${pyString(`${step.id} incubate`)})`);
          steps.push({
            stepId: step.id,
            action: step.action,
            device: step.device,
            execution: "manual",
            summary: `室温孵育 ${durationSec} 秒（${temperature} °C 低于模块加热下限）`,
            transfers,
            wellVolumesUl: { ...wellVolumes },
            notes,
          });
          break;
        }
        if (temperature > HEATER_SHAKER_TEMP_RANGE.max) {
          throw new ProtocolCompileError(
            `${step.id}: 目标温度 ${temperature} °C 超过 Heater-Shaker 上限 ${HEATER_SHAKER_TEMP_RANGE.max} °C`,
          );
        }
        body.push(`    heater_shaker.set_and_wait_for_temperature(${pyNumber(temperature)})`);
        body.push(
          `    protocol.delay(seconds=${pyNumber(durationSec)}, msg=${pyString(`${step.id} incubate ${temperature}C`)})`,
        );
        body.push(`    heater_shaker.deactivate_heater()`);
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "module",
          summary: `Heater-Shaker ${temperature} °C 孵育 ${durationSec} 秒`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "shake": {
        const rpm = Number(step.params.rpm ?? 800);
        const durationSec = Number(step.params.durationSec ?? 60);
        const clamped = Math.min(
          HEATER_SHAKER_RPM_RANGE.max,
          Math.max(HEATER_SHAKER_RPM_RANGE.min, rpm),
        );
        if (clamped !== rpm) {
          notes.push(
            `转速 ${rpm} rpm 超出 Heater-Shaker 区间 ` +
              `${HEATER_SHAKER_RPM_RANGE.min}–${HEATER_SHAKER_RPM_RANGE.max}，已夹到 ${clamped} rpm`,
          );
          warnings.push(`${step.id}: 转速 ${rpm} rpm 被夹到 ${clamped} rpm`);
        }
        const temperature = step.params.temperature != null ? Number(step.params.temperature) : null;
        if (temperature != null && temperature >= HEATER_SHAKER_TEMP_RANGE.min) {
          body.push(`    heater_shaker.set_and_wait_for_temperature(${pyNumber(temperature)})`);
        }
        body.push(`    heater_shaker.set_and_wait_for_shake_speed(${Math.round(clamped)})`);
        body.push(`    protocol.delay(seconds=${pyNumber(durationSec)}, msg=${pyString(`${step.id} shake`)})`);
        body.push(`    heater_shaker.deactivate_shaker()`);
        if (temperature != null && temperature >= HEATER_SHAKER_TEMP_RANGE.min) {
          body.push(`    heater_shaker.deactivate_heater()`);
        }
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "module",
          summary: `Heater-Shaker ${Math.round(clamped)} rpm 震荡 ${durationSec} 秒`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "read": {
        const wavelength = readableWavelength(step);
        if (wavelength === null) {
          const wanted = Number(step.params.wavelength ?? 600);
          notes.push(
            `波长 ${wanted} nm 不在 Flex 吸光度读板模块支持的四档` +
              `（${ABSORBANCE_WAVELENGTHS.join("/")}）内，编译成离机读数步骤`,
          );
          warnings.push(`${step.id}: ${wanted} nm 需要离机酶标仪，Opentrons 上无对应硬件`);
          body.push(
            `    protocol.comment(${pyString(`[spark-note] ${step.id} 离机读数 ${wanted} nm（Opentrons 无此硬件）`)})`,
          );
          steps.push({
            stepId: step.id,
            action: step.action,
            device: step.device,
            execution: "manual",
            summary: `离机读数 ${wanted} nm`,
            transfers,
            wellVolumesUl: { ...wellVolumes },
            notes,
          });
          break;
        }
        // 官方要求的次序：先在关盖状态 initialize，再开盖把板移进去，关盖读，开盖移回。
        // 次序错了模拟器直接报 CommandPreconditionViolated（实测过）。
        body.push(`    reader.close_lid()`);
        body.push(`    reader.initialize("single", [${wavelength}])`);
        body.push(`    reader.open_lid()`);
        if (needsHeaterShaker) body.push(`    heater_shaker.open_labware_latch()`);
        body.push(`    protocol.move_labware(${plateRef}, reader, use_gripper=True)`);
        body.push(`    reader.close_lid()`);
        body.push(`    _reading = reader.read()`);
        body.push(`    reader.open_lid()`);
        body.push(
          `    protocol.move_labware(${plateRef}, ${needsHeaterShaker ? "heater_shaker" : pyString(DECK.slots.plate)}, use_gripper=True)`,
        );
        if (needsHeaterShaker) body.push(`    heater_shaker.close_labware_latch()`);
        body.push(
          `    protocol.comment("[spark-read] " + json.dumps({"stepId": ${pyString(step.id)}, ` +
            `"wavelength": ${wavelength}, "wells": _summarize_reading(_reading)}))`,
        );
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "module",
          summary: `吸光度读板模块 ${wavelength} nm 读数`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      case "centrifuge": {
        // Opentrons 上没有离心机。编译成离机人工步骤 —— 绝不假装跑过。
        const rcf = Number(step.params.rcf ?? 12000);
        const duration = Number(step.params.duration ?? 60);
        notes.push("Opentrons 无离心模块，编译为离机人工步骤（run log 里是 note，不是执行记录）");
        warnings.push(`${step.id}: 离心是离机人工步骤，模拟器不会执行`);
        body.push(
          `    protocol.comment(${pyString(`[spark-note] ${step.id} 离机离心 ${rcf} × g / ${duration} s`)})`,
        );
        steps.push({
          stepId: step.id,
          action: step.action,
          device: step.device,
          execution: "manual",
          summary: `离机离心 ${rcf} × g，${duration} 秒`,
          transfers,
          wellVolumesUl: { ...wellVolumes },
          notes,
        });
        break;
      }

      default:
        throw new ProtocolCompileError(
          `${step.id}: 不支持的动作 '${step.action}'（可编译：prepareReagent / addSample / serialDilute / incubate / shake / read / centrifuge）`,
        );
    }
  }

  const deck: DeckSlotPlan[] = [
    { slot: DECK.slots.tips, role: "tips", loadName: DECK.tipRack200, onModule: null },
    { slot: DECK.slots.reservoir, role: "reservoir", loadName: DECK.reservoir, onModule: null },
    {
      slot: DECK.slots.plate,
      role: "plate",
      loadName: DECK.plate,
      onModule: needsHeaterShaker ? "heaterShakerModuleV1" : null,
    },
    { slot: DECK.slots.trash, role: "trash", loadName: "trash_bin", onModule: null },
  ];
  if (needsReader) {
    deck.push({
      slot: DECK.slots.reader,
      role: "reader",
      loadName: "absorbance_reader",
      onModule: "absorbanceReaderV1",
    });
  }

  const header: string[] = [];
  header.push(`# 本文件由 Spark Research protocol compiler 生成 —— 请勿手改。`);
  header.push(`# 源协议: ${protocol.id} · ${protocol.name}`);
  header.push(`# 编译目标: Opentrons Python Protocol API v${apiLevel}（${OPENTRONS_ROBOT_TYPE}）`);
  header.push(`# 注：源码里刻意不写编译时间戳——protocolHash 是 approve gate 批的对象，`);
  header.push(`#     带时间戳的话每次编译都换 hash，approve 就永远失效了。`);
  header.push(`import json`);
  header.push("");
  header.push(
    `requirements = {"robotType": ${pyString(OPENTRONS_ROBOT_TYPE)}, "apiLevel": ${pyString(apiLevel)}}`,
  );
  header.push(`metadata = {`);
  header.push(`    "protocolName": ${pyString(protocol.name)},`);
  header.push(`    "author": "Spark Research (compiled)",`);
  header.push(`    "source": ${pyString(`spark-research:${protocol.id}`)},`);
  header.push(`}`);
  header.push("");
  header.push(`def _summarize_reading(reading):`);
  header.push(`    """读板结果 → 可 JSON 化的摘要。读不到就给 None，不编造数字。"""`);
  header.push(`    if not reading:`);
  header.push(`        return None`);
  header.push(`    out = {}`);
  header.push(`    for wavelength, wells in reading.items():`);
  header.push(`        values = [float(v) for v in wells.values()]`);
  header.push(`        out[str(wavelength)] = {`);
  header.push(`            "wells": len(values),`);
  header.push(`            "min": round(min(values), 4) if values else None,`);
  header.push(`            "max": round(max(values), 4) if values else None,`);
  header.push(`        }`);
  header.push(`    return out`);
  header.push("");
  header.push("");
  header.push(`def run(protocol):`);
  header.push(`    # ── deck 布局 ──`);
  header.push(`    tips = protocol.load_labware(${pyString(DECK.tipRack200)}, ${pyString(DECK.slots.tips)})`);
  header.push(
    `    reservoir = protocol.load_labware(${pyString(DECK.reservoir)}, ${pyString(DECK.slots.reservoir)})`,
  );
  if (needsHeaterShaker) {
    header.push(
      `    heater_shaker = protocol.load_module("heaterShakerModuleV1", ${pyString(DECK.slots.plate)})`,
    );
    header.push(`    plate = heater_shaker.load_labware(${pyString(DECK.plate)})`);
  } else {
    header.push(`    plate = protocol.load_labware(${pyString(DECK.plate)}, ${pyString(DECK.slots.plate)})`);
  }
  if (needsReader) {
    header.push(`    reader = protocol.load_module("absorbanceReaderV1", ${pyString(DECK.slots.reader)})`);
  }
  header.push(`    protocol.load_trash_bin(${pyString(DECK.slots.trash)})`);
  header.push(
    `    pipette = protocol.load_instrument(${pyString(DECK.pipette)}, ${pyString(DECK.mount)}, tip_racks=[tips])`,
  );
  if (needsHeaterShaker) header.push(`    heater_shaker.close_labware_latch()`);
  for (const { name, well } of reservoir.entries()) {
    header.push(`    protocol.comment(${pyString(`[spark-note] reservoir ${well} = ${name}`)})`);
  }

  const source = [...header, ...body, ""].join("\n");
  const protocolHash = createHash("sha256").update(source).digest("hex").slice(0, 16);

  return {
    protocolId: protocol.id,
    name: protocol.name,
    apiLevel,
    robotType: OPENTRONS_ROBOT_TYPE,
    source,
    protocolHash,
    deck,
    pipette: {
      loadName: DECK.pipette,
      mount: DECK.mount,
      maxVolumeUl: PIPETTE_MAX_VOLUME_UL,
      tipRack: DECK.tipRack200,
    },
    modules: { heaterShaker: needsHeaterShaker, absorbanceReader: needsReader },
    steps,
    warnings,
    finalWellVolumesUl: wellVolumes,
    transfers: allTransfers,
  };
}

// 超过移液器量程就等分成 N 次（每次都不超量程）。返回的每一份都 > 0。
function splitVolume(volumeUl: number): number[] {
  if (volumeUl <= PIPETTE_MAX_VOLUME_UL) return [Number(volumeUl.toFixed(3))];
  const chunks = Math.ceil(volumeUl / PIPETTE_MAX_VOLUME_UL);
  const each = Number((volumeUl / chunks).toFixed(3));
  return Array.from({ length: chunks }, () => each);
}
