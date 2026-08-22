export type DeviceType =
  | "liquid_handler"
  | "shaker"
  | "incubator"
  | "centrifuge"
  | "plate_reader"
  | "spectrometer"
  | "purification";

export type DeviceStatus = "idle" | "busy" | "error";

export interface DeviceCapabilities {
  actions: string[];
  maxVolume?: number;
  temperatureRange?: { min: number; max: number };
}

export interface DeviceActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  message?: string;
}

export interface LabDevice {
  id: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  capabilities: DeviceCapabilities;
  execute(action: string, params?: Record<string, unknown>): Promise<DeviceActionResult>;
}

export interface DeviceDriverConfig {
  host?: string;
  port?: number;
  apiKey?: string;
  [key: string]: unknown;
}

export interface DeviceDriver {
  connect(config: DeviceDriverConfig): Promise<void>;
  executeAction(action: string, params?: Record<string, unknown>): Promise<DeviceActionResult>;
  disconnect(): Promise<void>;
}

export interface OpentronsCommand {
  command: string;
  params?: Record<string, unknown>;
}

export class OpentronsDriver implements DeviceDriver {
  private host: string | null = null;
  private connected = false;

  async connect(config: DeviceDriverConfig): Promise<void> {
    if (!config.host) {
      throw new Error("OpentronsDriver: OPENTRONS_HOST not configured; cannot connect");
    }
    this.host = config.host;
    this.connected = true;
    // TODO: real Opentrons integration requires a reachable OPENTRONS_HOST.
    //       Only the HTTP API contract is defined here; no device is contacted.
  }

  async executeAction(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<DeviceActionResult> {
    if (!this.connected) {
      throw new Error("OpentronsDriver: not connected; call connect() first");
    }
    const command: OpentronsCommand = { command: action, params };
    // TODO: a real driver would POST { command, params } to `${this.host}/commands`
    //       per the Opentrons HTTP API contract. This is an interface stub only.
    return { success: true, data: { driver: "opentrons", command } };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.host = null;
  }
}

function makeDevice(
  id: string,
  name: string,
  type: DeviceType,
  capabilities: DeviceCapabilities,
  simulate: (action: string, params: Record<string, unknown>) => Record<string, unknown>,
): LabDevice {
  return {
    id,
    name,
    type,
    status: "idle",
    capabilities,
    async execute(action, params = {}) {
      return { success: true, data: simulate(action, params) };
    },
  };
}

export const OPENTRONS_LIQUID_HANDLER: LabDevice = makeDevice(
  "opentrons-ot2",
  "Opentrons OT-2 Liquid Handler",
  "liquid_handler",
  { actions: ["dispenseLiquid", "addSample", "mix"], maxVolume: 1000 },
  (action, params) => ({
    action,
    volumeDispensed: params.volume ?? 0,
    unit: params.unit ?? "uL",
  }),
);

export const THERMAL_SHAKER: LabDevice = makeDevice(
  "thermal-shaker-01",
  "Eppendorf ThermoMixer",
  "shaker",
  { actions: ["shake", "heat"], temperatureRange: { min: 4, max: 95 } },
  (action, params) => ({
    action,
    rpm: params.rpm ?? 800,
    temperature: params.temperature ?? 37,
  }),
);

export const PLATE_READER: LabDevice = makeDevice(
  "plate-reader-01",
  "BioTek Synergy H1 Plate Reader",
  "plate_reader",
  { actions: ["read"], temperatureRange: { min: 4, max: 45 } },
  () => ({
    od600: Number((0.05 + Math.random() * 1.8).toFixed(3)),
    wavelength: 600,
    readings: Array.from({ length: 96 }, () => Number((0.05 + Math.random() * 1.8).toFixed(3))),
  }),
);

export const CENTRIFUGE: LabDevice = makeDevice(
  "centrifuge-01",
  "Eppendorf 5418R Centrifuge",
  "centrifuge",
  { actions: ["centrifuge"], temperatureRange: { min: 4, max: 40 } },
  (action, params) => ({
    action,
    rcf: params.rcf ?? 12000,
    durationSec: params.duration ?? 60,
  }),
);
