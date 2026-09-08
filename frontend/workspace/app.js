"use strict";

const API = {
  health: "/api/health",
  connectors: "/api/connectors",
  chat: "/api/chat",
  artifacts: (sid) => `/api/artifacts/${encodeURIComponent(sid)}`,
  lineage: (vid) => `/api/lineage/${encodeURIComponent(vid)}`,
  devices: "/api/lab/devices",
  protocol: "/api/lab/protocol",
};

const SESSIONS_CACHE = "spark-research.sessions";
const ACTIVE_CACHE = "spark-research.active";

let currentSessionId = null;

function el(id) {
  return document.getElementById(id);
}

function storageSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistSessions(list) {
  localStorage.setItem(SESSIONS_CACHE, JSON.stringify(list));
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    if (contentType.includes("application/json")) {
      const body = await res.json();
      detail = body.error || body.message || detail;
    }
    throw new Error(detail);
  }
  return contentType.includes("application/json") ? res.json() : res.text();
}

export async function initApp() {
  const health = await apiFetch(API.health).catch(() => null);
  renderHealth(health);

  const conn = await apiFetch(API.connectors).catch(() => ({ connectors: [] }));
  renderConnectorCount(conn.connectors ?? []);

  const dev = await apiFetch(API.devices).catch(() => ({ devices: [] }));
  renderDevices(dev.devices ?? []);

  const sessions = storageSessions();
  renderSessionList(sessions);
  const active = localStorage.getItem(ACTIVE_CACHE);
  if (active && sessions.includes(active)) {
    selectSession(active);
  } else if (sessions.length > 0) {
    selectSession(sessions[sessions.length - 1]);
  } else {
    newSession();
  }

  wireEvents();
}

function renderHealth(health) {
  const ok = health && health.status === "ok";
  const indicator = el("health-indicator");
  indicator.classList.toggle("ok", ok);
  indicator.classList.toggle("down", !ok);
  el("health-text").textContent = ok ? `${health.service} v${health.version}` : "服务不可用";
}

function renderConnectorCount(connectors) {
  el("connector-count").textContent = `连接器 ${connectors.length}`;
}

export function renderDevices(devices) {
  const grid = el("devices");
  grid.innerHTML = "";
  if (!devices.length) {
    grid.innerHTML = '<p class="placeholder">没有可用设备</p>';
    return;
  }
  for (const d of devices) {
    const card = document.createElement("div");
    card.className = "device-card";
    const caps = d.capabilities ?? {};
    const actions = (caps.actions ?? []).join(" / ") || "—";
    const temp = caps.temperatureRange
      ? `${caps.temperatureRange.min}–${caps.temperatureRange.max}°C`
      : caps.maxVolume
        ? `≤${caps.maxVolume} µL`
        : "";
    card.innerHTML = `
      <div class="device-card-head">
        <span class="device-name">${escapeHtml(d.name ?? d.id)}</span>
        <span class="badge status-${d.status ?? "idle"}">${d.status ?? "idle"}</span>
      </div>
      <div class="device-meta">
        <span class="mono">${escapeHtml(d.type ?? "")}</span>
        ${temp ? `<span>${escapeHtml(temp)}</span>` : ""}
      </div>
      <div class="device-caps">${escapeHtml(actions)}</div>`;
    grid.appendChild(card);
  }
}

function wireEvents() {
  el("new-session-btn").addEventListener("click", newSession);
  el("chat-form").addEventListener("submit", onChatSubmit);
  el("protocol-form").addEventListener("submit", onProtocolSubmit);
}

export function newSession() {
  const id = `session-${Date.now().toString(36)}`;
  const list = storageSessions();
  list.push(id);
  persistSessions(list);
  renderSessionList(list);
  selectSession(id);
}

export function selectSession(sessionId) {
  currentSessionId = sessionId;
  localStorage.setItem(ACTIVE_CACHE, sessionId);
  for (const item of document.querySelectorAll(".session-item")) {
    item.classList.toggle("active", item.dataset.sessionId === sessionId);
  }
  el("chat-messages").innerHTML = "";
  appendMessage("assistant", `已进入会话 ${sessionId.slice(0, 16)}…，请开始提问。`);
  loadArtifacts(sessionId);
}

function renderSessionList(list) {
  const ul = el("session-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = '<li class="placeholder">暂无会话</li>';
    return;
  }
  for (const sid of list) {
    const li = document.createElement("li");
    li.className = "session-item";
    li.dataset.sessionId = sid;
    li.textContent = sid.slice(0, 24);
    li.title = sid;
    li.addEventListener("click", () => selectSession(sid));
    ul.appendChild(li);
  }
}

async function onChatSubmit(e) {
  e.preventDefault();
  const input = el("chat-input");
  const text = input.value.trim();
  if (!text || !currentSessionId) return;
  input.value = "";
  autoGrow(input);
  appendMessage("user", text);
  await sendMessage(currentSessionId, text);
}

export async function sendMessage(sessionId, text) {
  const typingId = appendMessage("assistant", "…", true);
  try {
    const data = await apiFetch(API.chat, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });
    const bubble = document.getElementById(typingId);
    if (bubble) {
      bubble.innerHTML = renderMarkdown(data.response ?? "(无响应)");
      bubble.classList.remove("typing");
    }
    if (data.reviewResult || data.review) {
      renderReview(data.reviewResult ?? data.review);
    }
    loadArtifacts(sessionId);
  } catch (err) {
    const bubble = document.getElementById(typingId);
    if (bubble) {
      bubble.textContent = `请求失败: ${err.message}`;
      bubble.classList.add("error");
      bubble.classList.remove("typing");
    }
  }
}

export async function loadArtifacts(sessionId) {
  const wrap = el("artifact-content");
  wrap.innerHTML = '<p class="placeholder">加载中…</p>';
  try {
    const data = await apiFetch(API.artifacts(sessionId));
    const artifacts = data.artifacts ?? [];
    wrap.innerHTML = "";
    if (!artifacts.length) {
      wrap.innerHTML = '<p class="placeholder">此会话暂无产物</p>';
      return;
    }
    for (const a of artifacts) {
      wrap.appendChild(renderArtifactCard(a));
    }
  } catch (err) {
    wrap.innerHTML = `<p class="placeholder">加载失败: ${escapeHtml(err.message)}</p>`;
  }
}

function renderArtifactCard(a) {
  const card = document.createElement("div");
  card.className = "card artifact-card";
  const id = a.id ?? "";
  const head = document.createElement("div");
  head.className = "artifact-head";
  const name = document.createElement("span");
  name.className = "artifact-name";
  name.textContent = a.filename ?? id.slice(0, 8);
  const ver = document.createElement("span");
  ver.className = "badge";
  ver.textContent = `v${a.version ?? "?"}`;
  head.append(name, ver);

  const desc = document.createElement("div");
  desc.className = "artifact-desc";
  desc.textContent = a.codeDescription || a.contentType || "";

  const link = document.createElement("button");
  link.className = "btn subtle small";
  link.textContent = "查看依赖图";
  link.addEventListener("click", () => loadLineage(id));

  card.append(head, desc, link);
  return card;
}

export async function loadLineage(versionId) {
  const wrap = el("artifact-content");
  wrap.innerHTML = '<p class="placeholder">加载依赖图…</p>';
  try {
    const data = await apiFetch(API.lineage(versionId));
    const graph = data.graph ?? {};
    const nodes = graph.nodes ?? [];
    const edges = graph.edges ?? [];

    wrap.innerHTML = "";
    const back = document.createElement("button");
    back.className = "btn subtle small";
    back.textContent = "← 返回产物列表";
    back.addEventListener("click", () => loadArtifacts(currentSessionId));
    wrap.appendChild(back);

    const title = document.createElement("div");
    title.className = "lineage-title";
    title.textContent = `依赖图 ${versionId.slice(0, 8)}`;
    wrap.appendChild(title);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map();
    for (const e of edges) {
      const list = children.get(e.targetVersionId) ?? [];
      list.push(e.sourceVersionId);
      children.set(e.targetVersionId, list);
    }

    const meta = byId.get(graph.versionId) ?? nodes[nodes.length - 1];
    const root = document.createElement("div");
    root.innerHTML = lineageNodeHtml(graph.versionId, meta);
    wrap.appendChild(root);

    const walk = (vid, depth) => {
      const deps = children.get(vid) ?? [];
      if (!deps.length) return;
      const ul = document.createElement("ul");
      ul.className = "lineage-children";
      ul.style.marginLeft = `${depth * 14}px`;
      for (const d of deps) {
        const li = document.createElement("li");
        li.innerHTML = lineageNodeHtml(d, byId.get(d));
        const sub = walk(d, depth + 1);
        if (sub) li.appendChild(sub);
        ul.appendChild(li);
      }
      return ul;
    };
    const tree = walk(graph.versionId, 1);
    if (tree) root.appendChild(tree);
  } catch (err) {
    wrap.innerHTML = `<p class="placeholder">加载失败: ${escapeHtml(err.message)}</p>`;
  }
}

function lineageNodeHtml(vid, meta) {
  const label = meta && meta.filename ? `${escapeHtml(meta.filename)} v${meta.version}` : escapeHtml(vid);
  return `<span class="lineage-node mono" title="${escapeHtml(vid)}">${label}</span>`;
}

function renderReview(review) {
  const section = document.createElement("div");
  section.className = "review-box";
  const lines = [];
  if (typeof review === "string") {
    lines.push(review);
  } else if (review && typeof review === "object") {
    lines.push(`**评审结果** ${review.passed ? "通过" : "存在问题"}`);
    if (review.summary) lines.push(review.summary);
    if (Array.isArray(review.issues)) {
      for (const i of review.issues) lines.push(`- ${typeof i === "string" ? i : JSON.stringify(i)}`);
    }
  }
  section.innerHTML = renderMarkdown(lines.join("\n"));
  el("chat-messages").appendChild(section);
  el("chat-messages").scrollTop = el("chat-messages").scrollHeight;
}

async function onProtocolSubmit(e) {
  e.preventDefault();
  const input = el("protocol-input");
  const text = input.value.trim();
  if (!text) return;
  const result = el("protocol-result");
  result.innerHTML = '<p class="placeholder">编译中…</p>';
  try {
    const data = await apiFetch(API.protocol, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    renderProtocolResult(data);
  } catch (err) {
    result.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderProtocolResult(data) {
  const wrap = el("protocol-result");
  wrap.innerHTML = "";
  const protocol = data.protocol ?? {};

  const banner = document.createElement("div");
  banner.className = data.valid ? "valid" : "invalid";
  banner.textContent = data.valid ? "协议通过编译与安全校验" : "协议存在校验问题";
  wrap.appendChild(banner);

  if (protocol.steps?.length) {
    const ol = document.createElement("ol");
    ol.className = "protocol-steps";
    for (const s of protocol.steps) {
      const li = document.createElement("li");
      const params = Object.entries(s.params ?? {})
        .filter(([k]) => k !== "reagents")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      const reagents = Array.isArray(s.params?.reagents)
        ? `试剂: ${s.params.reagents.map((r) => r.name).join(", ")}`
        : "";
      li.textContent = `${s.action} @ ${s.device}${params ? ` [${params}]` : ""}${reagents ? ` — ${reagents}` : ""}`;
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
  }

  const safety = document.createElement("div");
  safety.className = "safety-checks";
  const checks = data.safety?.checks ?? protocol.safetyChecks ?? [];
  for (const c of checks) {
    const row = document.createElement("div");
    row.className = `safety-check ${c.passed ? "ok" : "fail"}`;
    row.textContent = `${c.passed ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`;
    safety.appendChild(row);
  }
  wrap.appendChild(safety);
}

function appendMessage(role, content, typing) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;
  if (typing) msg.classList.add("typing");
  msg.id = typing ? `typing-${Date.now()}` : "";
  msg.innerHTML = typing ? escapeHtml(content) : renderMarkdown(content);
  el("chat-messages").appendChild(msg);
  el("chat-messages").scrollTop = el("chat-messages").scrollHeight;
  return msg.id;
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, (_, body) => {
    const lines = body.split("\n");
    const lang = (lines[0] ?? "").trim();
    const code = lines.slice(lang ? 1 : 0).join("\n").trim();
    return `<pre><code${lang ? ` class="lang-${escapeAttr(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`;
  });
  return withCode
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .split("\n")
    .map((line) => (line.trim() ? `<p>${line}</p>` : ""))
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return String(str ?? "").replace(/["'`<>]/g, "");
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

const chatInput = el("chat-input");
if (chatInput) {
  chatInput.addEventListener("input", () => autoGrow(chatInput));
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el("chat-form").requestSubmit();
    }
  });
}

if (typeof document !== "undefined" && document.readyState === "complete") {
  initApp();
} else if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initApp);
}
