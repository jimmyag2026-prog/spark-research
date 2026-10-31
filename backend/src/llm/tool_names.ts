/**
 * Provider 函数名约束（OpenAI / DeepSeek / Kimi 等兼容端点：`^[a-zA-Z0-9_-]{1,64}$`）与
 * Spark 内部工具名之间的双向映射。
 *
 * 外部 MCP 工具名是 `mcp:<扩展>:<工具>`——冒号是 Spark 用来防撞名的结构，但上游 API
 * 会以 HTTP 400 整次拒绝（真实现场：接入 provena 时 `tools[4].function.name` 不匹配）。
 * 这里只在**发往 provider 的那一刻**编码、**拿回响应的那一刻**解码；Spark 内部（ToolBus
 * 授权、审计、证据图）始终只见原名。
 */
import type { ChatMessage, LlmResponse, ToolSpec } from "./types";

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolNameMap {
  toWire: Map<string, string>;
  fromWire: Map<string, string>;
}

/** 只为不合规的名字建映射；合规的名字原样走（没装外部扩展的调用逐字节不变）。 */
export function buildToolNameMap(tools: ToolSpec[] | undefined): ToolNameMap {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  const taken = new Set((tools ?? []).map((t) => t.name).filter((n) => WIRE_NAME.test(n)));
  for (const t of tools ?? []) {
    if (WIRE_NAME.test(t.name)) continue;
    let wire = t.name.replace(/[^a-zA-Z0-9_-]/g, "__").slice(0, 64);
    for (let i = 2; taken.has(wire); i++) wire = `${wire.slice(0, 60)}_${i}`;
    taken.add(wire);
    toWire.set(t.name, wire);
    fromWire.set(wire, t.name);
  }
  return { toWire, fromWire };
}

export function encodeTools(tools: ToolSpec[] | undefined, map: ToolNameMap): ToolSpec[] | undefined {
  if (!tools || map.toWire.size === 0) return tools;
  return tools.map((t) => (map.toWire.has(t.name) ? { ...t, name: map.toWire.get(t.name)! } : t));
}

/** 历史消息里 assistant 发过的工具调用也要编码，否则多轮 tool loop 的第二轮同样被拒。 */
export function encodeMessages(messages: ChatMessage[], map: ToolNameMap): ChatMessage[] {
  if (map.toWire.size === 0) return messages;
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return { ...m, toolCalls: m.toolCalls.map((c) => ({ ...c, name: map.toWire.get(c.name) ?? c.name })) };
    }
    if (m.role === "tool" && map.toWire.has(m.name)) return { ...m, name: map.toWire.get(m.name)! };
    return m;
  });
}

export function decodeResponse(response: LlmResponse, map: ToolNameMap): LlmResponse {
  if (map.fromWire.size === 0 || !response.ok || response.toolCalls.length === 0) return response;
  return { ...response, toolCalls: response.toolCalls.map((c) => ({ ...c, name: map.fromWire.get(c.name) ?? c.name })) };
}
