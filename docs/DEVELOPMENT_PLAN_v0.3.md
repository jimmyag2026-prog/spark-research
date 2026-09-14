# Spark Research v0.3.0 Development Plan

> Drafted: 2026-09-09 (PDT)
> Inputs: `spark-research_review报告.md` (external review, target main `b4aab02` + P8),
> `ClaudeScience_vs_OpenScience_架构与功能对比.md` (reference-frame research), full v0.2 code re-verification
> Baseline: main `4b0ebd5` (P8 merged) + `feat/p9-extensibility` (config / capabilities / MCP server /
> SKILL frontmatter already committed, scaffold in progress) — **this plan assumes work starts after P9 is merged and `v0.2.0` is cut**
> Target scope (user's own words): *achieve the same functionality and ease of use as OpenScience, and on that basis develop our own distinctive character,
> with extensibility that measures up to OpenScience and has a better design*

---

> ## ⚠️ Superseded by `DEVELOPMENT_PLAN_v0.4.md` (2026-09-10)
>
> **P10 (Gate D) is complete and v0.3.0 / v0.3.1 have been released.** The P11–P16 sections of this document
> (the architecture design remains valid) have been carried forward and revised by **`docs/DEVELOPMENT_PLAN_v0.4.md`** —
> that document folds in the lessons from P10's three incidents, parallel real-world measurement data, and new findings left over from v0.3 (V20–V25).
> **Follow the v0.4 document for execution**; this document is retained as the source of the architecture design and as the historical record of P10.

> ## ⚠️ The version line has been re-split (2026-09-10)
>
> The original draft of this plan assumed that "v0.3.0 would be cut all at once at the end of P16." In actual execution this changed to:
> **`v0.3.0` = Gate D (P10) released on its own** — it contains genuinely breaking changes
> (the `wet_run` state was split, the shape of `/api/lab/machine` changed, write requests now require `application/json`,
> cross-site write requests are rejected); per SemVer these should not be crammed into a patch release, nor held back until all three main lines are done.
>
> **The three main lines (P11–P16) are deferred to become the content of `v0.4.0`.** The phase numbering, dependency order,
> file ownership, and verification plan are all unchanged — only the version label has changed.
> Wherever the text below says "v0.3.0 release" or "v0.3 target state," read it as **v0.4.0**.

---

## 0. One-sentence summary

**v0.2 made "data and discipline" solid; v0.3 fills in "runtime and ecosystem," the shortest plank —
matching OpenScience's ease of use with its form factor (npx install in seconds, Web by default, model-neutral, real delegation, plugin extensibility),
then overtaking it on the same form factor with spark's own deterministic discipline (completion judged against the graph, contract-based acceptance for extensions, machine-verifiable capability claims).**

The review's strategic conclusion is that "the advantage is entirely in the data layer, which appreciates with years of accumulation; the disadvantage is entirely in the runtime layer, which depreciates at the speed of the industry."
v0.3 is the only window in which we pay off the runtime debt in one shot — **every feature domain added after this point would otherwise be built on a bad foundation, over and over again.**

---

## I. From the review to the version theme

### 1.1 The review's three core judgments, and v0.3's response to each

| Review judgment | v0.3 response |
|---|---|
| **Crack one: narrative ahead of implementation** — the Agent layer's three big selling points (swarm / subagents / permit set) remain data structures | Main line A: turn subagents into real delegation (ToolBus + tool loop); make the permit set a real consumer; delete swarm; and add a new **CI-level "narrative-consistency gate"** so this kind of gap can never again go unnoticed until review time |
| **Crack two: gaps in basic concurrency and timeout engineering** — single-threaded tests can never catch these | Gate D: P0 races / end-to-end timeouts / CAS / stderr draining all cleared in one pass, plus a new `tests/concurrency/` and a "fake upstream hang" test layer, permanently folding this dimension into CI |
| **The direction of differentiation is judged correct and worth sticking with** | Main line C: extend "deterministic discipline" from the domain pipelines to the **orchestration layer** (completion judged against the graph) and the **extension layer** (contract-based acceptance) — neither reference system has an equivalent for either of these |

### 1.2 What v0.3 explicitly does NOT do (to prevent scope creep)

| Not doing | Reason |
|---|---|
| Chasing OpenScience's count of 313 skills / 46 connectors | AD-5 "few but deep" is unchanged. What v0.3 solves is **letting the user add one in 30 minutes themselves**, not us adding 46 |
| Real multi-user identity authentication (BACKLOG V10) | In the single-user local scenario `actorSource` is already honest; before adding multi-user support the agent layer needs to be made real, otherwise we're adding a lock to an empty shell |
| Physical Opentrons integration (V6) | **Hard precondition**: the safety-gate claim must be made good on first (Gate D-8). In the review's own words: "an over-claimed safety gate is more dangerous than no safety gate" |
| Plugin marketplace / remote extension repository | Loading and acceptance mechanisms must exist first before distribution is worth discussing. v0.3 only does local directory loading |
| Real implementation of remote compute (V4) | Build it when real demand pulls for it; without a driving use case, don't build it |

---

## II. Overall structure: one gate + three main lines + one side line

```
                    ┌──────────────── Gate D: debt settlement (work does not start until cleared) ─────────────────┐
                    │ concurrency races · end-to-end timeouts · silent failures · permission scope · safety-gate claim convergence │
                    └────────────────────────────┬──────────────────────────────────┘
                                                 │
                              ┌──────────────────┴──────────────────┐
                              │  P11 LLM Runtime v2 (shared foundation for A/B/C)  │
                              │  provider adapter layer · tool calling ·      │
                              │  usage accounting · timeout/retry · streaming · JSON mode │
                              └──────────────────┬──────────────────┘
                     ┌───────────────────────────┼───────────────────────────┐
                     │                           │                           │
        ┌────────────▼───────────┐  ┌────────────▼───────────┐  ┌────────────▼───────────┐
        │ Main line A: Agent Runtime │  │ Main line B: closing the onboarding gap │  │ Main line C: overtaking on extensibility │
        │ P12 ToolBus + real subagents │  │ P14 npx/single binary        │  │ P15 extension loading + declarative │
        │ P13 contract/replan/     │  │     zero-arg UI startup · wizard    │  │     connector · MCP     │
        │     accounting · findings │  │     tiered dependencies · demo    │  │     client · contract-based acceptance │
        │     state machine        │  │     local model · SSE streaming    │  │                         │
        └────────────┬───────────┘  └────────────┬───────────┘  └────────────┬───────────┘
                     └───────────────────────────┼───────────────────────────┘
                                    ┌────────────▼───────────┐
                                    │ Side line E: P16 literature domain hardening │
                                    │ (also serves as main line C's │
                                    │   first real user: arXiv/PubMed │
                                    │   added via declarative connector) │
                                    └────────────┬───────────┘
                                            v0.3.0 release
```

**Why this order**:
1. Gate D comes first, because **orchestration is concurrency** — if we don't fix the C-1 race, every concurrent delegation in main line A silently fails, and it's untestable.
2. P11 comes before the three main lines, because tool calling (A), streaming output (B), external tool registration (C), and structured output (BACKLOG V12) **all share the same LLM abstraction**. Building three separate adapter layers first would be the easiest mistake in this plan.
3. Side line E is placed last not because it's unimportant, but because it serves as **the acceptance test case for main line C**: if arXiv/PubMed cannot be added via a declarative manifest, that means the extension mechanism's design has failed — this is a harder acceptance bar than any unit test.

---

## III. Gate D: debt settlement (P10)

> **Gate semantics**: until D is entirely green, no feature code for P11 or beyond may be merged into main.
> All items are the review's first/second priority items. Scale: 2–3 sessions, 4 lanes in parallel (see §6.3.2).

| # | Item | Location | Approach | Acceptance |
|---|---|---|---|---|
| D-1 | **P0 concurrency race**: instance-level `__handlingTool` state silently bypasses argument mapping under concurrency | `connectors/base.ts:56,78-86` | Remove the "same-named method is the handler" magic dispatch, switch to an **explicit handler registry** (subclass constructor calls `this.handle("search", this.searchImpl)`); `call()` no longer depends on any mutable instance state | `tests/concurrency/connector_race.test.ts`: 100 concurrent mixed tool calls against a single instance, assert that the final URL/args for every request match the serial result bit-for-bit |
| D-2 | **End-to-end timeouts**: `http/client.ts` bare fetch, LLM calls, `PythonKernel.execute`, and TaskRegistry all have no timeouts | `http/client.ts` · `llm/` · `kernels/` · `server/tasks.ts` | An explicit `timeoutMs` at every layer (default lives in `config.json`; HTTP 30s / LLM 120s / kernel supplied by the caller); use `AbortController`; a timeout is a **visible error**, not a silent return | "Fake upstream hang" test layer: inject an HttpClient / LLM / kernel that never responds, assert all four entry points return a `timeout` error within N seconds instead of hanging forever |
| D-3 | **Kernel stderr is never drained** → after a long session fills the 64KB pipe buffer, it deadlocks permanently | `kernels/manager.ts:37-49` | Copy the correct pattern already present in `lab/wet_backend.ts:206` | Unit test: still able to `execute` normally after pushing 1MB of stderr to the kernel |
| D-4 | **LLM failures are silently treated as success** | `agents/orchestrator.ts:290,318,412` | **Fix at the type level** (not just adding `if`s): when `LlmResponse.ok=false`, `content` is always the empty string — errors live only in the `error` field, so "treating error text as output" becomes impossible at compile time. See §4.1 | Unit test: FakeLLM returns failure → the orchestrator task is `ok:false`, the summary contains no error text, review does not pass it |
| D-5 | `kernelManager.dispose()` globally destroys kernels, so concurrent sessions kill each other | `agents/orchestrator.ts:325-335` | `dispose(kernelId)` for a single kernel | `tests/concurrency/kernel_isolation.test.ts`: two sessions executing interleaved, each session's kernel survives |
| D-6 | **`config.json` stores the LLM API key at 0644** (even weaker than the 0600 used for connector credentials) | `index.ts:55-58,71` · `config/index.ts:177` | Copy the `mode: 0o600 + chmodSync` pattern already used in `daemon/credentials.ts`; detect and warn about overly permissive file modes at startup | Unit test asserts `stat` shows 0600 after write; existing overly permissive files are tightened |
| D-7 | **No Origin/Host validation + `jsonBody` doesn't check Content-Type** → a malicious webpage can POST cross-site to `/approve` via `text/plain` | `server/app.ts` · `http/` | By default, locally, only trust an Origin whitelist of `localhost`/`127.0.0.1` (configurable); write endpoints require `application/json` | Adversarial test: three kinds of cross-site write requests — forged Origin, missing Content-Type, `text/plain` — all get 403 |
| D-8 | **Safety-gate claim convergence** (hard threshold before connecting to real hardware) | `lab/` | Choose one, and commit to it in both docs and CLI output: **(a)** add NL→concentration/BSL parsing + expand the reagent vocabulary to English/molecular formulas + merge continuation-sentence reagents + **warn on unconsumed parameters**; **(b)** downgrade the claim to "the safety gate currently only works on reagents and volumes matched by Chinese-language keywords." **Recommended: minimal version of (a) plus mandatory (b) warning**: the parser adds "this sentence contains a quantity/reagent not consumed by any rule" → compiled output carries an `unconsumed` warning, which the approval UI must display | The adversarial matrix is extended to English/molecular-formula protocols; the case of "the user wrote it but the safety gate never saw it" must produce a visible warning, not a silent green light |
| D-9 | **The state machine has no optimistic concurrency control** → a single approval can be executed twice concurrently | `project/records.ts:181-192` | `UPDATE ... WHERE id=? AND rev=?` with `rev` auto-incrementing; writes to the experiment record's `state`/`approval` gain source validation | `tests/concurrency/approve_once.test.ts`: N concurrent `POST /simulate` calls against the same approved protocol, assert exactly 1 execution and the rest 409 |
| D-10 | The wet-lab state machine's `wet_run` conflates "approved, pending execution" with "executing"; approval survives crashes → a restart re-runs without re-approval | `lab/` | Split into two states, `approved` / `executing`; approval is **consumed once** (a rerun requires re-approval) | Crash-recovery test case: approve → SIGKILL → restart → assert re-approval is required |
| D-11 | Clean up documentation drift in one pass | `docs/` `README` `SKILL.md` | Connector count 17 (not 18); the EuropePMC dead endpoint in SKILL.md that has already been falsified by the code; unify the version number (which currently has two different values across three places) into `version.ts` | Automatically caught by the narrative-consistency test in §7 (see D-12) |
| D-12 | **New: narrative-consistency gate** | `tests/unit/narrative_parity.test.ts` | Every capability claim in README/DESIGN must have a corresponding entry in `capabilities --json` whose `status` matches the actual registry; orphan modules (no production caller, referenced only by their own tests) cause a CI error | Use the current `swarm.ts` as a negative control: before it is deleted, this test must be able to catch it |

**Gate exit criteria**: D-1…D-12 all green + the new `tests/concurrency/` suite all green + the existing 655 test cases show no regressions.

---

## IV. Main-line code architecture design

### 4.1 P11 · LLM Runtime v2 (shared foundation for A/B/C)

**Why this must be done first**: a new gap between narrative and implementation that the review didn't point out but that our re-verification found —
`SUPPORTED_PROVIDERS` declares 6 providers (kimi/openai/anthropic/deepseek/qwen/openrouter), but `call()`
**only actually implements `callOpenRouter` and `callKimi`**; the other four silently fall through to OpenRouter or fail.
This is the widest gap between DESIGN §5.4 "stay model-agnostic" and OpenScience's "model neutrality" — and **model neutrality happens to be OpenScience's most-cited selling point**.

At the same time, tool calling (a prerequisite for main line A), streaming (main line B's SSE token stream),
external tool registration (main line C), `response_format` JSON mode (BACKLOG V12),
and usage accounting (main line A's frame-level ledger) — **all five things share the same abstraction**.

```
backend/src/llm/
  types.ts            # ChatMessage(+tool role) / ToolSpec / ToolCall / Usage / LlmResponse
  router.ts           # Facade: model name → provider adapter; keeps the existing call() signature backward compatible
  providers/
    registry.ts       # provider declaration table: baseUrl / envKey / capability bits (the data source behind capabilities self-description)
    openai_compat.ts  # one codebase covering openai / deepseek / qwen / kimi / openrouter /
                      # ollama / vLLM / any self-hosted baseUrl — the real anchor point of "model neutrality"
    anthropic.ts      # native messages API (tool_use / tool_result shape differs from OpenAI, must be separate)
  budget.ts           # budget handle: token / cost / call-count caps, passed across subagents
```

```ts
// types.ts —— the key design point is "no content available on failure"
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export interface CallOptions {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  responseFormat?: "text" | "json_object" | { jsonSchema: JsonSchema };  // fixes BACKLOG V12 at the root
  timeoutMs?: number;          // calling without a default is not allowed (D-2's enforcement point)
  maxRetries?: number;         // only for retryable errors
  signal?: AbortSignal;
  budget?: BudgetHandle;
  onDelta?: (chunk: string) => void;   // streaming; if not passed, non-streaming (main line B's SSE hooks in here)
}

export interface LlmResponse {
  ok: boolean;
  provider: string; model: string;
  /** always the empty string when ok=false. Errors live only in the error field — the type-level fix for F-2 */
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  finishReason?: string;
  error?: { kind: "auth"|"rate_limit"|"timeout"|"parse"|"upstream"; message: string; retryable: boolean };
}
```

**Provider capability bits** are surfaced via `capabilities --json`:
`{ toolCalling, jsonMode, streaming, usageReported }` — an external agent knows **before** choosing a model
whether it can run a tool loop, instead of finding out halfway through that it can't. This follows the same philosophy as P9's `caveat` field.

**Local-model fallback** (main line B's key-free path, following OpenScience's "local endpoints are never blocked from BYOK"):
`config.json` supports `providers.local = { baseUrl, model, apiKey?: null }`;
`spark-research doctor` actively probes `localhost:11434` (Ollama) and surfaces this in the wizard.

**Cost table**: `registry.ts` has built-in per-model prices (overridable via config); when usage can't be obtained,
`costUsd: null` is set along with `usageUnavailable` — **never fill in 0 to pretend it's free** (an extension of the culture of honest disclosure).

---

### 4.2 P12 · AgentToolBus + real subagents (main line A, step one)

#### 4.2.1 ToolBus: wiring up the pipe that P9 already built

P9's `McpToolRunner` (`backend/src/mcp/server.ts`) is already a **unified in-process tool bus** —
every tool is just one `app.fetch()` call against the P7 HTTP app, with CLI/HTTP/UI/MCP all sharing the same service layer through four entry points.
**Main line A doesn't reinvent the wheel — it just wraps three layers around it: authorization, budget, audit.**

```
backend/src/agents/toolbus.ts
```

```ts
export interface ToolBusOptions {
  runner: McpToolRunner;        // already exists from P9
  grants: string[];             // whitelisted tool names — the first real consumer of the permit set (making good on AD-2)
  budget: BudgetLedger;         // caps on call count / wall-clock / tokens
  audit: (e: ToolAuditEntry) => void;   // one execution record logged per call
  timeoutMs: number;
  extraTools?: ExternalToolSpec[];      // main line C: tools registered by an external MCP server
}

export class AgentToolBus {
  /** tools definition handed to the LLM. **Same source** as capabilities --json / the MCP server (MCP_TOOLS) — not a separate copy */
  specs(): ToolSpec[];
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}
```

**Three hard rules** (all adversarially testable):

1. **An unauthorized tool → a structured rejection, not a thrown exception**:
   returns `{ ok:false, denied:"not_granted", granted:[...] }` — something the model can read and route around,
   rather than stuffing an exception stack trace back into context.
2. **`MCP_WITHHELD` dangerous actions (`lab_approve` / `conclusion_review` / `project_archive`)
   are likewise rejected at the ToolBus layer** — **a subagent can never approve its own work**.
   This extends AD-6's "human approval gate" from the HTTP layer to the agent layer, and is v0.3's one non-negotiable red line.
3. **One execution record is logged per call** (who called it / argument summary / duration / result size / whether it was rejected).
   Claude Science's frame-level accounting is, in spark, naturally **a node on the graph** — see §4.4.

#### 4.2.2 Subagents: from bare `llm.call` to a real tool loop

```ts
// backend/src/agents/subagent.ts (rewrite of sub_agent.ts)
export interface SubAgentSpec {
  name: string;
  type: "explore" | "execute" | "review" | "lab" | "literature";
  model: string;                 // an independent model per type — DESIGN §5.4's dead field finally has a consumer
  promptFile: string;            // agents/prompt/<type>.txt, no longer inlined in TS
  grants: string[];              // ToolBus whitelist
  budget: { maxToolCalls: number; maxTokens: number; maxWallMs: number };
  readOnly: boolean;             // review = true, a hard constraint (read-only tool set + rejects write tools)
}

export interface SubAgentResult {
  finalText: string;
  toolCalls: ToolAuditEntry[];
  usage: Usage;
  /** done | budget | timeout | denied | error —— **budget exhaustion ≠ completion**, it must flow back */
  stopReason: StopReason;
}
```

Loop: `llm.call(messages, {tools: bus.specs()})` → if there are `toolCalls`, execute them (with bounded concurrency)
→ feed results back as `role:"tool"` messages → call again → repeat until there are no tool calls or the budget is hit.

**Default grants (secure-by-default)**:

| Subagent | grants | deliberately not granted |
|---|---|---|
| explore | `lit_search` `lit_list` `lit_read_cards` `records_timeline` `record_get` | all writes |
| literature | full explore set + `lit_add` `lit_export` `lit_review_draft` | experiments and the wet-lab domain |
| execute | `exp_design` `exp_run` `exp_list` `task_status` `kernel_exec` (new) | wet-lab domain, approvals |
| lab | `lab_compile` `lab_status` | **`lab_approve` / `lab_simulate` — execution must be human-approved** |
| review | read-only: `record_get` `records_timeline` `conclusion_list` `conclusion_get` `report_export` | all writes and execution |

#### 4.2.3 Disposition of swarm: delete it

`grep` re-verification: `agents/swarm.ts` has **zero callers** in production code, referenced only by `tests/unit/swarm.test.ts`;
`dependsOn` is unimplemented; `decompose` is three regexes.

**Decision: delete `swarm.ts` / `swarm_types.ts` and their tests**; concurrency capability is provided by ToolBus's bounded concurrency pool.
The reasoning is structurally identical to P8's deletion of `compute/providers.ts` — "keeping two 'submit a task' abstractions around only makes the next person pick the wrong one."
The "100 concurrent swarm" marketing line in the README must likewise come down, under the D-12 narrative gate.

---

### 4.3 P13 · Research Contract + Replan (main line A, step two, **an overtaking point**)

#### 4.3.1 Completion judgment: borrow OpenScience's form, keep spark's soul

OpenScience's completion boundary is `contract.stages.every(status === 'completed')` — the form is right,
but the stage's `completed` **is self-reported by the agent**. spark has an evidence graph and can make this harder:

```ts
// backend/src/agents/contract.ts
export interface ContractStage {
  id: string;
  description: string;
  /** the completion criterion doesn't ask the model, it asks the graph: a zero-IO, read-only query against the evidence graph */
  check(q: EvidenceQuery): StageStatus;
}
export interface StageStatus { done: boolean; evidence: string[]; reason: string }
```

Taking the `literature-review` contract as an example:

| stage | deterministic criterion (query against the evidence graph) |
|---|---|
| `searched` | at least 1 new `paper` record was added in this session |
| `read_cards` | every paper included in the review has a corresponding `reading` record (a set-inclusion relationship) |
| `citations_verified` | a `citation-integrity` review record exists, with zero hard findings |

> **To be written into DESIGN as AD-10**: *task completion must be determined by deterministic code querying the evidence graph,
> and must not be self-reported by the model.* This is the direct corollary, at the **orchestration layer**, of AD-8 (wherever the model draws a conclusion, there must be a deterministic constraint layer) —
> neither reference system has an equivalent: Claude Science is state-machine-driven but the criterion sits on the model side,
> OpenScience relies on stage self-reporting.

#### 4.3.2 Observe-feedback loop: from a one-shot pipeline to a real agent

```
round = 0
while round < maxRounds:
    plan         = planner(goal, contract.progress(), lastObservations)
    outcomes     = execute(plan)              # subagent / ToolBus
    observations = distill(outcomes)          # a structured object, not a truncated 200-character string
    if contract.allDone(): break
    if noProgress(2 rounds): break("no_progress")
    round += 1
```

Two key design points:

- **`distill` produces a structured observation** (hit count / newly added record ids / error type / stopReason),
  no longer `output.slice(0,200)` stuffed into the summary. **Task output must be able to flow back into decisions**;
  this is a direct response to the review's comment about the "overstated research agent."
- **`noProgress` is a deterministic criterion**: two consecutive rounds with no new nodes in the evidence graph → stop and honestly report
  "N rounds with no progress; the stage of the contract that remains unfinished is X." **It is better to report incompleteness than to burn money spinning idle, or pretend to be done**.
  Neither reference system spells out this guardrail.

#### 4.3.3 Frame-level accounting: land it in the graph, not a separate table

Claude Science's `frames` table carries `model`/`effort`/token/`total_cost`;
OpenScience has a harness `fingerprint`. spark already has an evidence graph — **the accounting lands directly in the graph**:

A new, 9th record kind, `agent_run`:

```
{ kind: "agent_run",
  agent, model, provider,
  systemHash, promptHash,              // ← also fills OpenScience's "harness fingerprint" gap
  usage: { inputTokens, outputTokens, costUsd | null, usageUnavailable? },
  toolCalls: n, stopReason, parentRunId }
```
Edge: `derives_from` (parent run → child run); artifact records attach to the `agent_run`'s id.

**Three birds, one stone**:
1. Claude Science's frame-level cost accounting → now exists, and **is queryable for free by `report` / lineage / the UI timeline** (they already read the graph);
2. OpenScience's model-fingerprint reproducibility → now exists; the novelty report and reading cards can finally answer "which model, which prompt version produced this";
3. The marginal cost of the evidence graph's 15th record kind is far lower than the 5th — the architecture's compounding return finally pays off for the agent layer here.

#### 4.3.4 The findings state machine: absorbing Claude Science's one clear lead

```
backend/src/reviewer/findings_store.ts
findings(id, project, session, target, checker, severity, fingerprint,
         state: open|addressed|resolved|reflagged,
         evidence, note, reflagCount, firstSeenAt, lastSeenAt, resolvedBy)
```

- the reviewer upserts and deduplicates on `(checker, target, fingerprint)` every round
- CLI: `spark-research review findings [--open]` / `mark-addressed <id> --note "..."`
- **re-verification closed loop**: if the next round still hits → `reflagged` + `reflagCount++`; if it no longer hits → `resolved`
- a soft finding still does not interrupt the session, but `findings --open` is now the equivalent of Claude's `host.findings()`
  — filling the review's noted gap of "soft findings have no active query entry point"

---

### 4.4 P14 · Closing the onboarding gap (main line B)

| Item | current state | v0.3 target | benchmark |
|---|---|---|---|
| Installation | clone + `bun install` + uv + manually installing openmm/opentrons | `npx spark-research` / single binary (the `bun build --compile` script **already exists**, package.json:12) / Homebrew tap / curl one-liner | OpenScience `npx synsci` |
| Default entry point | `bun run dev` (developer-facing) | `spark-research` zero-arg → starts the server + opens the browser; the CLI becomes an advanced entry point | OpenScience's default behavior |
| Python dependencies | heavy and mandatory | **three tiers**: `core` (zero Python) / `science` (openmm) / `lab` (opentrons); prompt for which command to install only when first needed; `spark-research doctor` reports which tier is missing | pyref is already a zero-dependency template |
| First run | when no key is present, the whole chain "succeeds" while returning error text | already fixed at the root by Gate D-4; `spark-research init` wizard: create a project → probe providers (including local Ollama) → run one real search → display the evidence graph → print the next three commands | — |
| Key-free experience | none | `spark-research demo`: a fixture-driven offline sample project, **zero network, zero key**, see the full evidence graph + report in 30 seconds | — |
| Key-free model | none | P11's `providers.local` (Ollama / OpenAI-compatible endpoint); BYOK is never blocked | OpenScience PR #135 |
| Web as a first-class citizen | the UI is a projection; novelty / dry experiments require going back to the CLI | initiate novelty checks / dry experiments directly within the UI; long-running task handles persisted to disk (V11); **SSE token streaming** (hooks into P11's `onDelta`) | OpenScience workspace |

---

### 4.5 P15 · The extension surface (main line C, **a change of track**)

OpenScience's extensibility advantage is "46 connectors + a plugin runtime + an OpenAPI SDK + LSP + an MCP client + a skill-pack catalog."
**Competing head-on on quantity is a losing game** (already asserted in the review's §10.3). v0.3 changes track:
**Not who ships more built in, but who lets users add their own faster, and trust what they added once it's added.**

#### 4.5.1 Three loading strengths

```
~/.spark-research/extensions/<name>/
  extension.json     # manifest: kind / name / version / entry / requires / grants
  connector.json     # the **declarative definition** when kind=connector (zero TS code)
  index.ts           # the implementation when kind=skill|platform|backend|rule
  SKILL.md           # reuses P9's frontmatter spec directly
  tests/             # verification cases shipped with the extension (run by ext verify)
```

| Strength | Form | Coverage | Security |
|---|---|---|---|
| ① **Declarative connector (recommended default)** | `connector.json`: baseUrl / tools / argument mapping / response-normalization mapping (a restricted JSONPath subset) | the vast majority of REST literature and database sources | **executes no arbitrary code**, only runs restricted mappings; outbound URLs pass a whitelist check (`file://` forbidden, private IP ranges forbidden, guarding against SSRF) |
| ② **TS extension** | skill / `SimulationPlatform` / `WetLabBackend` / safety-gate rules | scenarios that need real logic | same-UID code execution → loading requires explicit `--trust`, the sha256 fingerprint is printed and confirmation required the first time, the fingerprint is recorded in the manifest |
| ③ **External MCP server integration (reverse MCP client)** | `spark-research ext add-mcp <name> --cmd "..."` | one-time integration with the entire MCP ecosystem | external tools are registered into ToolBus and `capabilities`; **every call likewise produces an execution record** |

> ③ is a **net gain** relative to OpenScience: it has an MCP client, but external tool calls don't enter its provenance record;
> because spark's ToolBus provides unified auditing, every call to an external tool naturally lands in the evidence graph.

#### 4.5.2 Contract-based acceptance: spark's unique design

```
spark-research ext verify <path>
```

| Extension type | What runs |
|---|---|
| connector | Connector contract tests: correctness of argument mapping, **concurrency invariants** (directly reuses D-1's regression suite), credentials never persisted to disk, error messages don't echo the response body |
| platform | **directly reuses the existing P5 `SimulationPlatform` contract test suite** (prepare/submit/poll/collect) — AD-4's original investment in "two implementations validate an interface" pays off a second time here |
| rule | pure-function checks: zero IO, deterministic (same input twice, same output), no external state |
| skill | P9's frontmatter schema validation + verifying the declared e2e exists and runs (a mechanization of AD-5) |

> **To be written into DESIGN as AD-11**: *for an extension, "it loads" doesn't count as "it works" — only "it passes its contract tests" counts as working.*
> This turns AD-5 (a skill must have an e2e to count as done) from a **development-side discipline** into a **runtime gate**,
> and is also a structural answer to OpenScience's "313 skills of uneven quality" —
> we're not limiting the count, we're limiting the count of **unverified** ones.

#### 4.5.3 Extension credential and permission boundaries (an extension of AD-2)

- Extensions **have no access to any credentials by default**; they must declare `requires.credentials: ["<id>"]` in the manifest,
  and only after the user runs `ext grant <name>` does the CredentialStore proxy access on their behalf — **the value itself still never leaves the daemon**.
- Extensions' ToolBus grants likewise require manifest declaration + user approval, running through the same authorization code path as subagents.
- An extension throwing an exception / crashing **must not take down the main process**: both loading and invocation are inside an error boundary; on failure it degrades to
  "this extension is unavailable + reason," and honestly marks `status: "failed"` in `capabilities`.

---

### 4.6 P16 · Literature-domain hardening (side line E, doubles as main line C's acceptance test)

Review verdict: **first among the three in the literature-review step, third in search breadth**. Two pieces of engineering close the gap.

| # | Item | Approach | Notes |
|---|---|---|---|
| E-1 | **arXiv / PubMed integration** (BACKLOG V1) | **implemented using the declarative connector manifest from §4.5**, no TS written | this is main line C's hardest acceptance test: *if the two most basic sources can't be added via a manifest, the extension mechanism has failed* |
| E-2 | reduce citation-judge cost | dedup by `(key, sentence hash)` + concurrency throttling + one retry on failure | cuts a 30-citation review from 30 serial round trips by an order of magnitude; combined with P11's `response_format` this fixes V12 at the root |
| E-3 | `mergeAuthors` pairs affiliations by index (mismatched attribution has already been reproduced) | switch to pairing by normalized name; add a year gate for exact-name matches | metadata trustworthiness is the foundation of a literature library |
| E-4 | S2's "automatic downgrade without a key" promise is unimplemented | add the credential path (make `apiKeyRequired` a true value); no longer repeatedly hits 429 when there's no key | BACKLOG D2 |
| E-5 | CJK metadata | keep Unicode in bibtex keys (`\p{Script=Han}`); bigram dedup for Chinese titles | this is where AMiner's Chinese-language advantage finally pays off |
| E-6 | deleting a paper leaves orphan records | cascade cleanup or mark as `retracted` | the evidence graph must not lie (paired with lineage returning 404 for phantom ids) |

---

## V. Verification plan

> The project's existing principles — "adversarial tests before happy path," "record one real run → CI replays it forever" — remain unchanged.
> v0.3 **adds four new test layers**, all covering dimensions that "single-threaded happy-path tests can never catch."

### 5.1 New test layers

| Layer | Directory | Content | What it locks down |
|---|---|---|---|
| **Concurrency adversarial** | `tests/concurrency/` | ① 100 concurrent mixed tool calls against a single connector instance → argument mapping matches the serial result bit-for-bit (D-1) ② N concurrent `/simulate` calls against the same approved protocol → exactly 1 execution, the rest 409 (D-9) ③ two sessions executing interleaved → kernels don't destroy each other (D-5) | the review's P0 and "one approval, multiple executions" |
| **Hang/timeout** | `tests/timeout/` | inject an HttpClient / LLM / kernel that never responds, assert all four entry points — CLI / HTTP / MCP / subagent — return a visible `timeout` error within N seconds | E-2 "any upstream hang = permanent stuck state" |
| **Agent-loop adversarial** | `tests/unit/agent_loop/` | FakeLLM scripts a sequence of tool calls: ① an unauthorized tool is structurally rejected ② budget exhaustion → `stopReason:"budget"` rather than `done` ③ tool results are genuinely fed back in (assert the second-round prompt contains the first round's result) ④ **a subagent calling `lab_approve` must be rejected** (red line) ⑤ LLM returns failure → the task is `ok:false` and the summary contains no error text (D-4) | all of main line A's promises |
| **Extension malice matrix** | `tests/unit/extensions/` | ① manifest declares A but calls tool B → rejected ② takes a credential without a grant → rejected ③ a declarative connector embeds `file://` / a private-network address → rejected (SSRF) ④ an extension throws an exception → main process survives, `capabilities` marked `failed` ⑤ loading an extension that hasn't passed `ext verify` produces an explicit warning | main line C's security boundary |

### 5.2 Adversarial tests for the deterministic criterion (self-proof of AD-10)

- **Fake completion**: FakeLLM claims "the review is complete," but there is no `reading` record in the graph → `contract.allDone()` must be false.
- **No-progress stop**: two consecutive rounds of tool calls produce no new record → the loop stops at round 2, and the report states the stage that remains incomplete.
- **Honest accounting**: when the provider doesn't return usage, `costUsd` is `null` and marked `usageUnavailable`, **must not be filled in as 0**.

### 5.3 Narrative-implementation consistency gate (D-12, the root fix for this review's biggest finding)

`tests/unit/narrative_parity.test.ts`:
1. every capability claim in README / DESIGN → has a corresponding entry in `capabilities --json`, whose `status` matches the actual registry;
2. **orphan-module detection**: a module with zero callers in production code, referenced only by its own tests → CI error
   (uses `swarm.ts`, before its deletion, as a negative control, proving this test can really catch it);
3. numeric claims (connector count / skill count / endpoint count) are generated by a script — **hand-writing them is not allowed**.

> **To be written into DESIGN as AD-12**: *every capability claimed externally must be machine-verifiable.*
> The review's biggest finding was that "narrative runs ahead of implementation." Relying on people's self-discipline is not sustainable — it must be a gate.

### 5.4 External acceptance (version-level exit criteria)

Continuing the "external acceptance" format already established in P9, v0.3 raises the bar further:

1. **A brand-new Claude Code session (no context on this repo)**, using only `npx spark-research mcp` + `llms.txt`,
   completes: search literature into the library → create an idea → run a novelty check → **launch one dry experiment and read back the conclusion**.
2. **A clean machine (no bun / no Python / no API key)**: `npx spark-research` →
   the `demo` project shows the evidence graph and report within 30 seconds.
3. **A third-party perspective adds a connector**: following `docs/EXTENDING.md`, add a
   brand-new data source using a declarative manifest and pass `ext verify`, without touching the repo's source code at all — **performed by someone who was not part of the development**.
4. `tests/concurrency/` and `tests/timeout/` are all green; zero regressions in existing test cases.

---

## VI. Roadmap, schedule, and execution approach

### 6.0 A note on schedule units (important)

**This plan does not use "week" as a unit.** v0.2's measured pace was: from the final design of P0 to the wrap-up of P9
(18.6k lines of backend TS + 3.1k frontend + 13.5k lines of tests + 655 test cases) **completed within a single day, 2026-09-09**,
including one night's sleep, with roughly 15 hours of actual work time. Phase-by-phase wall clock:

```
00:52 P0 design  →  01:08 P1(16m)  →  01:40 P2(32m)  →  02:07 P3(27m)  →  02:43 P4(36m)
      ⋯ overnight ⋯
09:12 P5  →  10:01 P6(49m)  →  13:24 P7(3h23, 56 endpoints + SolidJS + Playwright)
20:22 P8  →  21:33–22:09 P9 five commits(36m)
```

At this tempo, "week" is not a meaningful unit. **Phase scale is uniformly measured in "sessions"**
(one session ≈ one complete cycle of "confirm scope → delegate implementation → run tests → review code → check against the design → PR,"
corresponding to the 30 minutes to 3 hours seen across P1–P9).

v0.3 carries more work per unit than v0.2 (concurrency, new abstraction layers, more adversarial tests),
but a comparable number of phases — **overall scale: 2–4 working days**.

### 6.1 Phase table

| Phase | Content | Scale | Parallel lanes | Primary model | Dependency | Phase gate |
|---|---|---|---|---|---|---|
| **P10** | Gate D: D-1…D-12 | 2–3 sessions | **4** | **Sonnet 5** | P9 merged + `v0.2.0` tag | new concurrency/timeout suite all green; 655 test cases show zero regressions |
| **P11** | LLM Runtime v2 | 2 sessions | 3 (interface-first) | **Opus 5** | P10 | provider matrix contract tests; one real recorded/replayed test each for tool calling / JSON mode / streaming / usage |
| **P12** | ToolBus + real subagents; delete swarm | 2 sessions | 2 | **Opus 5** | P11 | all five agent-loop adversarial tests pass; README marketing copy matches implementation (D-12 gate) |
| **P13** | contract + replan + frame-level accounting + findings state machine | 2 sessions | 2 | **Opus 5** | P12 | AD-10 adversarial tests (fake completion / no-progress stop / honest accounting) all pass |
| **P14** | Onboarding: npx/single binary/zero-arg UI/wizard/tiered dependencies/demo/local model/SSE streaming | 2 sessions | 2 | **Sonnet 5** | P11 (streaming) | clean-machine external acceptance ② passes |
| **P15** | Extension loading + declarative connector + MCP client + `ext verify` | 2 sessions | 2 | **Opus 5** | P12 (ToolBus) | malicious-extension matrix all pass; all three `EXTENDING.md` examples green in CI |
| **P16** | Literature-domain hardening (arXiv/PubMed via manifest) + close-out + `v0.3.0` | 1–2 sessions | 3 | **Sonnet 5** | P15 | external acceptance ①③④ all pass |

**Critical path**: P10 → P11 → P12 → P13 → P16.
**P14 runs in parallel with P12/P13** (depends only on P11's streaming); **P15 runs in parallel with P13** (depends only on P12's ToolBus) —
neither is on the critical path.

**Trimmable order** (if an earlier release is needed): P15's ③ MCP client → P14's Homebrew/curl → P13's findings state machine.
**Not trimmable**: all of P10, P11, P12, and AD-10's deterministic completion criterion — these four are v0.3's theme itself.

### 6.2 Basis for model allocation

No global switch — split by **task shape**. This is based on the review's own findings:

> "The closer the code is to the core of trustworthiness, the higher its quality; the closer it is to the 'AI Agent platform' marketing copy, the more hollow it becomes"

Translated into model selection: in v0.2, the places with high quality were **mechanical work with a clear spec** (state machines, fixture discipline, adversarial tests),
while the problems all sat at **the boundary of design judgment** — the connector's magic dispatch was judged a "bad abstraction" (the root cause of P0),
zero end-to-end timeouts, LLM failures silently treated as success, the Agent-layer abstraction built but never wired up.
**These aren't cases of "can't write the code" — they're matters of taste and blind spots.**

| Shape | Phase | Model | Reason |
|---|---|---|---|
| Follow the recipe (the review already spells out which file and line to change) | P10 · P16 | Sonnet 5 | 10 of 12 items have a complete spec; Opus would be wasted here; and these two phases have the most parallel lanes |
| Clearly specified engineering work (packaging / wizard / dependency tiering) | P14 | Sonnet 5 | — |
| Abstraction design (getting it wrong means reworking all three main lines) | P11 | Opus 5 | one abstraction simultaneously carries tool calling / streaming / accounting / JSON mode |
| Abstraction design (the successor to the one layer in v0.2 that was judged a "bad abstraction") | P12 | Opus 5 | the same spot has already tripped once before |
| Original design (AD-10, "completion judged by asking the graph, not the model") | P13 | Opus 5 | the most original idea in v0.3 |
| Security boundary design | P15 | Opus 5 | getting it wrong is the kind of over-claim that produced S-3, "the sandbox has a one-line escape" |

**On single-turn wait times**: v0.2's overall throughput isn't slow; if the pain point is "waiting too long for one reply,"
try Opus's `/fast` first (the same Opus, faster output, **not a downgrade to a smaller model**), rather than switching models.

### 6.3 Parallel development plan

#### 6.3.1 The foundation is already in place (measured)

| Check item | Conclusion |
|---|---|
| Test-state isolation | all tests build a temp workspace via `mkdtempSync`, `SPARK_RESEARCH_DATA_DIR` can be injected, **not a single test touches `~/.spark-research`** |
| Port usage | unit / MCP / server tests go through `app.fetch()`, an **in-process call, no listening port** |
| Sole shared resource | Playwright is pinned to port 4399, but the `SPARK_E2E_PORT` environment variable already provides a fallback |

**Conclusion: it is safe for N agents to run `bun test` at the same time**, as long as each lane is assigned a different `SPARK_E2E_PORT`.

#### 6.3.2 Lane division and file ownership

> **Iron rule: a file belongs to exactly one lane at any given moment.** The table below is the ownership registry — crossing it is a conflict.

**P10 (4 lanes, Sonnet 5)**

| Lane | Responsible for | Exclusive files |
|---|---|---|
| `D-a` connectors | D-1 | `connectors/base.ts` `connectors/registry.ts` `connectors/*.ts` `tests/concurrency/connector_race.test.ts` |
| `D-b` runtime pipeline | D-2 D-3 D-5 D-4(tactical version) V3 | `http/client.ts` `kernels/manager.ts` `server/tasks.ts` `agents/orchestrator.ts` `tests/timeout/**` |
| `D-c` security surface | D-6 D-7 | `index.ts`(auth-write section) `config/index.ts` `server/app.ts` `http/body.ts` |
| `D-d` wet-lab domain and state machine | D-8 D-9 D-10 | `lab/**` `project/records.ts` `tests/concurrency/approve_once.test.ts` |

> D-4 only gets a tactical version in P10 (three `res.ok` checks in the orchestrator);
> **the type-level root fix in AD-13 is completed in P11** (`ok=false ⇒ content=""`) — split into two steps because the type change belongs to P11's abstraction.

**P11 (interface-first → 3 lanes, Opus 5)**

| Lane | Exclusive files |
|---|---|
| **Interface-first** (must be merged on its own first) | `llm/types.ts` + `llm/router.ts` facade |
| `R-a` OpenAI-compatible base (including ollama / vLLM / local endpoints) | `llm/providers/openai_compat.ts` |
| `R-b` Anthropic native | `llm/providers/anthropic.ts` |
| `R-c` accounting and capability bits | `llm/budget.ts` `llm/providers/registry.ts` |

**P12 (2 lanes, Opus 5)**: `agents/toolbus.ts` ‖ `agents/subagent.ts` + `agents/prompt/*.txt` + delete swarm
**P13 (2 lanes, Opus 5)**: `agents/contract.ts` + replan + `agents/ledger.ts` ‖ `reviewer/findings_store.ts` + CLI (**fully independent**)
**P14 (2 lanes, Sonnet 5)**: distribution and packaging ‖ wizard + demo + SSE streaming
**P15 (2 lanes, Opus 5)**: extension loading + `ext verify` ‖ declarative connector + MCP client
**P16 (3 lanes, Sonnet 5)**: E-1 manifest source ‖ E-2 judge cost reduction ‖ E-3…E-6 metadata fixes

#### 6.3.3 Four disciplines (the first three are a direct extension of the P6 incident)

1. **One lane, one worktree**: `~/Desktop/AI4S/spark-research-<lane>`, following the same convention already used for `-p9` / `-v03`.
   **Never share a working tree** — that's exactly what happened in the P6 incident, where the main session switched branches in a shared working tree and dragged a subagent's half-finished work into a docs PR that got pushed to main
   (already added to the repo's engineering discipline as item 7).
2. **Interface-first**: when two lanes touch the same type, land a small, **interface-only** PR to main first, then fan out.
   Two places already known in this plan: P10's `HttpClient.RequestOptions.timeoutMs` (D-a depends on D-b), and
   P11's `llm/types.ts` (all three lanes depend on it).
3. **High-conflict files off limits to lanes**: `CHANGELOG.md` / `BACKLOG.md` / `README.md` are always written by the **close-out commit only**;
   devlogs are written per-lane to their own `docs/devlog/P10-<lane>.md` (separate files = zero conflicts).
4. **Multi-lane phases go through an integration branch**: `lane → feat/P10-integration` (full test suite runs here) → **a single PR into main**.
   Otherwise you get "every PR is individually green, but main goes red after merging" — exactly the kind of **semantic conflict that single-threaded testing can't catch** that the review called out.

#### 6.3.4 Two exceptions to keep in mind

- **The D-12 narrative-consistency gate must run in the serial tail.** It is a global test that
  will false-positive-fail on any lane branch, since it can't see the changes made in other lanes. The same applies to D-11's documentation-drift fix.
- **The real bottleneck is review bandwidth, not the number of agents.** The current workflow is "the main session reviews code + checks against the design → PR";
  4 lanes producing simultaneously means 4 PRs waiting for review. **This is the ceiling on parallelism** — which is why this plan caps out at 4 lanes, not 6–8.

#### 6.3.5 Lane startup checklist (to be written into every subagent task brief)

```
① git worktree add ~/Desktop/AI4S/spark-research-<lane> -b feat/<phase>-<lane> origin/main
② export SPARK_E2E_PORT=<4400 + lane index>
③ only modify files belonging to this lane per the ownership table; report back before overstepping, don't self-expand scope
④ don't touch CHANGELOG / BACKLOG / README; write devlog only to docs/devlog/<phase>-<lane>.md
⑤ before opening a PR, run the **full** bun test suite (not just this lane's tests) + bun run typecheck
⑥ the target branch is feat/<phase>-integration, not main
```

### 6.4 Milestones and externally visible value

| Milestone | What we can honestly say externally once it's done |
|---|---|
| End of P10 | "Under concurrency and timeouts, nothing fails silently" — the safety claim now matches the implementation |
| End of P12 | "Subagents are real agents that actually use tools" — every overstated marketing claim comes down |
| End of P13 | "Completion is judged by the evidence graph, not self-reported by the model" — **the single most publishable claim** |
| End of P14 | "One `npx` command, see the full picture in 30 seconds with zero key" — ease of use has caught up |
| End of P15 | "The data source you add yourself runs the contract tests the moment it's installed" — overtaking on extensibility |
| P16 / v0.3.0 | five feature domains + a real agent runtime + self-service extensibility — the only one of the three with both a dry-lab and wet-lab closed loop |

---

## VII. Convergence table against the two reference systems (v0.3 target state)

| Dimension | OpenScience | Claude Science | v0.2 current state | **v0.3 target** |
|---|---|---|---|---|
| Install/distribution | `npx synsci`, install in seconds | macOS App | clone + bun install | npx / single binary / brew　**✅ at parity** |
| Default entry point | starts a Web workspace | App | `bun run dev` | zero-arg starts the UI　**✅ at parity** |
| Model neutrality | all providers | locked to Anthropic | 6 declared, 2 actually implemented | OpenAI-compat base + Anthropic + local　**✅ at parity** |
| Subagent delegation | `task` tool, real delegation | `host.delegate()` frame tree | bare `llm.call`, no tools | ToolBus real delegation + budget + audit　**✅ at parity** |
| Completion judgment | `contract.stages` (agent self-reported) | state machine (criterion on the model side) | none | **deterministic criterion against the graph (AD-10)　🚀 surpasses both** |
| Frame-level accounting | session-level | per-frame model/token/cost | none | **lands in the evidence graph, free to query via report/lineage/UI　🚀 surpasses** |
| Model fingerprint | harness fingerprint | — | none | `agent_run` record carries systemHash/promptHash　**✅ at parity** |
| Review persistence | provenance claim | `verification_checks` state machine | one-shot pass | findings state machine + re-verification closed loop　**✅ at parity with Claude** |
| Connectors | 46, key-free | no registry | 17 | **not competing on count: declarative manifest + external extensions + MCP client　🚀 changes track** |
| Extension mechanism | plugin runtime / SDK / LSP | agents table + MCP | none | loading + **contract-based acceptance (AD-11)　🚀 surpasses** |
| Capability self-description | docs / llms.txt | — | P9 `capabilities --json` | + **narrative-consistency CI gate (AD-12)　🚀 surpasses both** |
| Dry/wet-lab closed loop | none | none | present (safety gate under-delivers) | safety gate delivers on its claim　**🚀 sole occupant of this track** |

---

## VIII. New architecture decisions (to be written into DESIGN §5.2)

> **Numbering starts at AD-10**: P9 already used up AD-9 ("the MCP exposure surface is cut by 'who bears the consequences'"),
> so this plan's original draft, which used AD-9…AD-13, had a numbering collision and has been shifted back by one.

| # | Decision | Reason |
|---|---|---|
| **AD-10** | Task completion must be determined by deterministic code querying the evidence graph, and must not be self-reported by the model | a direct corollary of AD-8 at the orchestration layer; both OpenScience's stage self-reporting and Claude's model-side criterion share the same flaw: *an agent can declare itself done* |
| **AD-11** | For an extension, "it loads" doesn't count as working — only "it passes its contract tests" counts as working | upgrades AD-5 from a development-side discipline to a runtime gate; a structural answer to OpenScience's "quality unevenness from scaling up quantity" — we don't limit the count, we limit the count of **unverified** ones |
| **AD-12** | Every capability claimed externally must be machine-verifiable (`capabilities --json` is authoritative, enforced by a CI gate) | this review's biggest finding was "narrative running ahead of implementation." Relying on self-discipline isn't sustainable — it must be a gate |
| **AD-13** | On LLM call failure, **there is no content available** (`ok=false ⇒ content=""`, errors live only in the `error` field) | the type-level fix for F-2: makes "error text being treated as output" impossible at compile time, instead of relying on three scattered `if`s being remembered |
| **AD-14** | A subagent can **never execute an action that requires human approval** (`lab_approve` / `conclusion_review` / `project_archive` are hard-rejected at the ToolBus layer) | extends AD-6 from the HTTP layer to the agent layer. The stronger an agent's capabilities, the more this red line matters |

---

## VIII·Addendum · Disposition of existing BACKLOG items

> Give the v0.3 candidates in `docs/BACKLOG.md` a clear disposition, so it's no longer a table that only ever grows.

| BACKLOG | Disposition | Notes |
|---|---|---|
| V1 arXiv/PubMed integration | **P16 (E-1)** | switched to implementation via P15's declarative connector, doubling as the extension-mechanism acceptance test |
| V2 novelty similarity semantics (embedding) | v0.4 | requires an embedding-provider decision; P11's provider abstraction paves the way for it, but it's not done in this release |
| V3 cross-checking poll process start-time | **P10 (bundled with the D-2 timeout work)** | current state ("only over-reports running") is safe in direction; do it opportunistically while adding timeouts |
| V4 real implementation of remote compute | not doing | §1.2: build it when a real use case drives it |
| V5 R kernel | not doing | the permit set has a slot but there's no demand; the marginal cost of adding one kernel is lower after P12 anyway, wait for demand |
| V6 physical Opentrons | not doing (hard precondition unmet) | §1.2: making good on the D-8 safety-gate claim is the hard threshold |
| V7 Agent Swarm integration | **P12: deleted** | §4.2.3 — structurally identical to P8's deletion of `compute/providers.ts` |
| V8 optimization of Chinese-language retrieval recall | **P16 (bundled with E-5)** | done together with the CJK metadata fix |
| V9 real-key verification of AMiner `getPaper` | **P16** | just needs a fixture recorded once |
| V10 real identity at the HTTP layer | not doing | §1.2: make the agent layer real first |
| V11 persisting long-running task handles to disk | **P14** | lets the UI see running tasks across restarts, part of the onboarding work |
| V12 LLM structured output | **fixed at the root in P11** | via `CallOptions.responseFormat`, no longer papered over by "retry once on parse failure" |
| V13 the judge prompt's stance on "attribution out of thin air" | **P16 (bundled with E-2)** | changed together with the judge cost reduction, then re-measured on G5 |
| V14 change positional weighting exemption to a whitelist scheme | **P13** | done together with the findings-state-machine refactor of the reviewer (the threshold has already been reached) |
| V15 remove deprecated aliases like `MCPConnector` | **P10 (lane D-a)** | confirm there are no external references while refactoring connector dispatch in D-1, then delete; if it can't be done, leave it for v0.4 |
| V16 expose the subagent's independent model as a user config option | **P12** | making the subagent real requires `SubAgentSpec.model` to have a real consumer anyway, so expose it as config while we're at it |
| V17 MCP long-task progress reporting | **P14** | done together with SSE streaming (both belong to "seeing the agent actually working") |
| V18 caching `capabilities --probe` results | **P14** | part of onboarding; the cache must carry an invalidation condition (venv changes), otherwise it will lie |
| V19 requiring an interactive terminal for approval actions | **P12 (same batch as AD-14)** | AD-14 ("a subagent can never self-approve") is the default-path defense; V19 is the technical defense — the two together form a complete pair |
| D1 a third simulation platform | pending | the contract has already been validated by two implementations; P15's `ext verify` makes it more worthwhile to let a third party add it themselves |
| D2 Semantic Scholar key | **P16 (E-4)** | land the credential path |
| D3 real CNKI / Wanfang API | pending | no access channel; AMiner remains the primary path for Chinese-language sources |

---

## IX. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Scope too large, timeline gets out of control | still not shipped by v0.4 | the three main lines are **decoupled from each other** (aside from sharing P11); §6.1 already gives a trimmable order and critical path; P14 can ship on its own as v0.2.1 |
| Tool calling has poor compatibility on domestic providers | main line A falls through | P11's `toolCalling` capability bit is **queryable at runtime**: if unsupported, degrade to a "JSON plan + code execution" mode and disclose this honestly, don't pretend |
| The declarative connector's mapping DSL keeps growing more like a programming language | complexity gets out of control | hard constraint: only a restricted JSONPath subset + fixed normalization fields are supported; **if it can't be expressed, write a TS extension** — this is a feature, not a bug |
| External extensions = same-UID code execution | expands the security surface | default to declarative (executes no code); TS extensions require `--trust` + fingerprint confirmation; both credentials and tool authorization require explicit grants; **the docs must state plainly that this is not a sandbox** (so as not to repeat the over-claim of S-3, "the sandbox has a one-line escape") |
| Accounting landing in the graph causes the record table to bloat | graph queries slow down | `agent_run` by default only logs at the run level, not per tool call (tool calls go into the execution-record table); retention and compaction policy go into config |
| Fixing D-8's safety gate in P10 turns out to take far more work than estimated | blocks the whole line | D-8 allows falling back to option (b), the downgraded claim + mandatory `unconsumed` warning, first; completing the parser can be pushed to P16 or v0.4, **but the bar for connecting to real hardware does not get relaxed** |

---

## X. A word to maintainers

The review's line — "the closer the code is to the core of trustworthiness, the higher its quality; the closer it is to the 'AI Agent platform' marketing copy, the more hollow it becomes" —
is the entire reason this release exists.

v0.3 adds no new feature domains — **not a single one**. It does three things:
turns the agent layer from a data structure into something that actually uses tools; brings the onboarding bar down to a single `npx`;
and turns extension from "edit the repo's source code" into "write a manifest and pass the contract tests."

At the same time, it pushes the deterministic discipline the project has already proven effective up two more layers:
the **orchestration layer** (completion judged by asking the graph, not the model) and the **extension layer** (loading doesn't count, passing the contract does),
plus one more AD, AD-12, that turns this review's finding into a permanent gate.

Once these three things are done, the first sentence of the README will finally be true.

---

*This plan is drafted based on the 2026-09-09 external review report + the Claude Science / OpenScience comparison research + a full re-verification of the v0.2 code.*
*A new finding from re-verification, not listed in the review: `LLMRouter` declares 6 providers but only implements 2 (§4.1) — already folded into P11.*
