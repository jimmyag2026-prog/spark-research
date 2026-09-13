# Spark Research v0.5 · Module Design and Construction Plan

> Drafted: 2026-09-10 (PDT) · Starting point: `main` v0.4.0 (`feb3c8a`, including v0.5 proposal #30)
> Upstream document: `docs/DEVELOPMENT_PLAN_v0.5.md` (the construction source of truth; this document **defers** to its §2 three hard rules and §5 wave shape)
> Material library: `~/Desktop/AI4S/spark-research-v0.5-plan/` (not checked in; paths cited here are relative to that directory)
> Baseline measurement (as of the day this document was drafted, main repo `main`): `bun test tests/unit` → **1396 pass / 0 fail / 0 skip**, 82 files, 49.8s
>
> This document is a **design that can be dispatched directly to lanes**, not a restatement of the proposal. Wherever the repository's current state is cited, a file path and line number are given (AD-12 convention),
> with line numbers as of `feb3c8a`.

---

## 0. Conclusions up front

### 0.1 Five key design decisions

| # | Decision | One-line rationale |
|---|---|---|
| **K-1** | `backend/src/compute/` sits **alongside, not inside,** `SimulationPlatform`; the only connection between the two is a single bridge, `compute/sim_bridge.ts` | The two contracts live at different layers: `SimulationPlatform` (`simulation/models.ts:95-105`) is a discipline-domain contract (normalized parameters / expected outputs / the `deterministic` flag), while `ComputeAdapter` is an execution-site contract (which machine / what environment / how approval works / how results are harvested). Stuffing a target into `SimulationPlatform.submit()` would break contract #2, "submit returns a runId immediately, non-blocking" — with an approval gate in the middle, submit could never return immediately. See §1.1.9 for details |
| **K-2** | **Approval semantics (decision record + one-time digest consumption + pre-execution re-verification) are moved forward from CB-5 into CB-1**; CB-5 is left with only "wiring" (CLI/HTTP/MCP_WITHHELD/TTY/ToolBus pricing) | `planned → awaiting_approval → approved → queued` is the backbone of the lifecycle; CB-1's "exhaustive transition test" is only half a table if it doesn't include approval consumption. Moreover, if W5-1 first builds a broker that "can dispatch without approval," it will inevitably need a test backdoor, and that backdoor will live on into production. This is objection X-1; see §7 |
| **K-3** | Compute execution state is the **disk source of truth** (`<project>/compute/jobs/<jobId>/job.json`), **not a record**; the evidence graph only gets written to in two places: when a human makes a decision (`decision`) and when a result enters the graph (`observation` + `artifact`) | v0.4 W3 close-out ran into this for real: once bookkeeping-type records enter the graph, `NoProgressGuard` always sees "there's new activity," and the stop condition meant to prevent runaway spending is silently defeated (`agents/contract.ts:137-152`). A compute job that writes a record on every poll would replay the exact same failure |
| **K-4** | Embedding lives in `backend/src/llm/embeddings/`, **at the same layer as, but under a different contract from,** `llm/providers/`; novelty keeps a dual trace (lexical + semantic); **the semantic threshold is calibrated per embedding model**, and any uncalibrated model falls back to lexical matching across the board | The planning directory `workstreams/provider/V05_PROVIDER_DESIGN.md` §(b) already established that the chat contract doesn't fit embedding; cosine-similarity distributions vary by model, so a single cross-model constant threshold would just be one more "0.75 pulled out of thin air" |
| **K-5** | Hub files are decided **wave by wave** rather than via one fixed cross-version list: if only one lane needs to touch a given file in this wave, it's assigned to that lane; if ≥2 lanes need it, it's pulled out into close-out | Two v0.4 lessons pull against each other: not pulling it out → `index.ts` conflicted three times; pulling everything out → "built but nobody wired it up" happened six times. Wave-by-wave assignment is the intersection of the two. See §3.4 |

### 0.2 Critical path

```
Gate F ──► W5-1 α (CB-1 contract + approval semantics · CB-2 local · CB-3 upload surface)
              ──► W5-2 β (CB-5 wiring: CLI/HTTP/withheld/TTY/ToolBus pricing) ┐
              ──► W5-2 α (CB-4 Modal adapter, needs token)                    ┤──► W5-3 α (CB-6 bridge + real SIGKILL e2e) ──► close-out
```

Everything else runs around it in parallel. **W5-2 α and β are mutually independent** (β's wiring faces CB-1's interface and doesn't need Modal to exist; CI walks the full approval chain using the local adapter).

### 0.3 List of objections (see §7 for detail)

- **X-1** CB-5's approval semantics should be moved forward into CB-1 (the proposal §3.1 places it in W5-2) — not to lower its priority, but to make it part of the state machine itself.
- **X-2** The hub-file list in proposal §5.1 cannot be locked down for the whole version; it should be assigned wave by wave (K-5).
- **X-3** `daemon/daemon.ts:72-91` carries a v0.1 legacy `ComputeService`/`DefaultCompute` and a `compute_submit` permit (`daemon/permissions.ts:8`), which neither the proposal nor COMPUTE_DESIGN mentions; once v0.5 introduces a real compute layer, the repository will have two "computes" — one must be chosen over the other at close-out.
- **X-4** Proposal §5's W5-3 δ, "runtime contract + Python SDK," **has no definition anywhere** in either the full text of the proposal or the planning directory (`grep -in "runtime contract\|python sdk"` only hits line 261 of the proposal itself). This document does not design for it; W5-3 δ is turned into a floating slot plus BACKLOG cleanup.
- **X-5** C5-②'s "kernel side" should be read as "the Python side (the same `.venv`)" rather than "via `PythonKernel`/daemon" — the simulation layer already has a precedent of "zero dependency on the daemon" (`simulation/platform.ts:23-26`).

---

## 1. Module design

### 1.1 C1 · Remote compute `backend/src/compute/`

#### 1.1.0 Positioning and three prior facts

1. **The directory name can simply be `compute/`.** v0.1's `compute/providers.ts` was already deleted along with its tests in P8-G6 (the comment at `simulation/platform.ts:112-116` preserves a record of the deletion); `backend/src/compute/` does not exist today (confirmed with `find backend/src -maxdepth 1`). The `compute2/` proposed in COMPUTE_DESIGN §2.1 is unnecessary.
2. **But there is another concept with the same name inside the daemon**: `daemon/daemon.ts:16` `interface ComputeService { submit / getFrames / libraries }`, `:72-91` `DefaultCompute` (an in-memory-Map fake implementation), `:194` `case "compute_submit"`, plus `daemon/permissions.ts:8` putting `compute_submit` into the control_repl permit set, called from `kernels/control_repl.ts:66`. This is a v0.1 leftover mock. **Its disposition is covered in objection X-3**; W5-1 α does not touch the daemon.
3. **Its relationship to `SimulationPlatform` is one of sitting alongside it** (K-1). `SubprocessSimulationPlatform.submit()` (`simulation/platform.ts:204-251`) today calls `Bun.spawn` directly on local python; it is effectively a special-case implementation of "target=local," but it **is not changed** — CB-2's local adapter is an independent implementation of `ComputeAdapter`, and the two share only the idea behind `RunStore`'s disk layout, not code (the AD-4 lesson: when contracts differ, don't force them together).

#### 1.1.1 File breakdown

| File | Slice | Contents | Dependencies |
|---|---|---|---|
| `compute/lifecycle.ts` | CB-1 | Three-axis state machine: constant tables + a pure `transition()` function + invariants. **Zero IO, zero imports from other modules in the repo** | — |
| `compute/plan.ts` | CB-1 | `ComputePlan` schema, `planDigest()` (canonical JSON, excluding `workspaceRoot`), `validatePlan()`, the shape of the cost-estimate fields | `simulation/platform.ts`'s `canonicalJson` (today a module-private function at `:34-42`, **needs to be exported**, a 1-line change owned by α) |
| `compute/target.ts` | CB-1 | `TargetRef` union, the `ComputeAdapter` interface, `AdapterCapabilities`, the `SshHost` schema (validation only, `available:false`) | — |
| `compute/approval.ts` | CB-1 (moved forward, X-1) | `ComputeApproval`: writes a `decision` record, writes `job.json.approval`, `consume()` atomic consumption, `verifyDigest()` pre-execution re-verification. **Semantics only, no entry point** | `project/records.ts`'s `RecordStore` (uses only the existing `create/link/update`) |
| `compute/job_store.ts` | CB-1 | Disk source of truth: the `<experimentsDir>/compute/jobs/<jobId>/` directory layout, atomic writes of `job.json` (temp file + rename), `rev` CAS | — |
| `compute/uploads.ts` | CB-3 | deny-list / gitignore awareness / dual limits on file count and bytes / sha256 / symlink rejection / `preflight()` re-verification. **Pure functions + read-only fs** | — |
| `compute/broker.ts` | CB-1/2 | `ComputeBroker`: orchestrates `plan → approve → dispatch → poll → collect → release`; admission limit; `recover()`; writes the adapter's handle into job_store | Everything above + `llm/budget.ts`'s `BudgetLedger` (optionally injected) |
| `compute/adapters/local.ts` | CB-2 | The first `ComputeAdapter`: a local subprocess with the `job` directory acting as a "persistent volume"; `recover()` has three branches (still running / already finished / lost), following the order used by `SubprocessSimulationPlatform.poll()` (**check the exit-code file before the pid**, `platform.ts:258-300`) | `simulation/platform.ts`'s `resolvePython()`, `isProcessAlive` |
| `compute/adapters/modal.ts` | CB-4 | The `modal` npm SDK (pinned to 0.9.0); clients pooled by credential digest (cap of 4); Volume name `sha256(project\0jobId)[:32]`; ownership tags `spark_job=<jobId>` / `spark_project=<sha256(slug)[:20]>`; a readiness sentinel; harvest/reconcile/recover/release; `recoveryFailure()` classification | `target.ts` + `connectors/base.ts`'s `CredentialProvider` |
| `compute/sim_bridge.ts` | CB-6 | `planFromPrepared(prepared, target)`, `materializeHarvest(runDir, harvest)`: translates a `PreparedRun` into a `ComputePlan`, and writes harvested results back in the form of `done.json` plus output files that `RunStore` understands | `simulation/models.ts` types + `plan.ts` |
| `compute/cli.ts` | CB-5 wiring | `spark-research compute plan/approve/reject/run/status/list/collect/cancel/release/targets` | `approval/gate.ts` (see below) |
| `approval/gate.ts` | CB-5 wiring | The V19 TTY gate `requireApprovalGate()`, **moved out of `lab/cli.ts:150-251`**, with the env variable name parameterized; shared by lab and compute | — |
| `server/routes/compute.ts` | CB-5 wiring | HTTP projection: `/api/compute/machine` (derived from the lifecycle transition table, following `server/routes/lab.ts:52-68`'s `/machine`), `/jobs`, `/jobs/:id`, `/jobs/:id/approve` (actor required, following `lab.ts:32-37`), `/jobs/:id/reject`, `/jobs/:id/collect` | — |
| `tests/helpers/compute_contract.ts` | CB-1 | A parameterized contract-test suite (following the `SimulationContractCase` shape at `tests/helpers/simulation_contract.ts:17-37`): the same set of assertions run against local and modal (via record-and-replay) | — |
| `tests/helpers/compute_driver.ts` | CB-6 | The process killed in the SIGKILL e2e (following `tests/helpers/experiment_driver.ts` / `wet_driver.ts`) | — |

**Explicitly not built**: `compute/adapters/ssh.ts`. `target.ts` contains only the `SshHost` schema and the `{ kind: "ssh" }` union member; the registry marks it `available:false, reason:"v0.5 leaves only a placeholder slot"`. Volcano Engine / RunPod don't even get a schema written; they go into BACKLOG.

#### 1.1.2 The three-axis lifecycle (one deviation from COMPUTE_DESIGN §1.5)

```
execution: planned → awaiting_approval → approved → queued → starting → running
                  ↘ (approvalRequired=false) ↗
           running → succeeded | failed | timed_out | cancelled | interrupted
           awaiting_approval → rejected
           interrupted → running | succeeded | failed     (decided by the adapter after recover)
delivery:  none → pending → complete | rejected | failed ; failed → pending (retry_delivery)
resource:  none → starting → active → closed | unknown
recoverable: boolean
```

**Deviation**: upstream has `awaiting_approval → queued`; this document inserts `approved`. The rationale matches wet-experiment D-10 (`lab/wet_models.ts:30-35`): "approved" and "actually started" must be two distinct states, and the approval is **consumed exactly once**, in the single `approved → queued` transition (archived as `consumedApproval`) — after a crash and restart, the approval is no longer present, so it cannot be re-dispatched out of thin air.

**Invariants** (one adversarial test per row, written in `tests/unit/compute_lifecycle.test.ts`):

| # | Invariant | On violation |
|---|---|---|
| L-1 | Any (state, event) pair not in the transition table must `throw ComputeStateError`, never be silently corrected | — |
| L-2 | `dispatch` has only two valid in-edges: `approved` (must carry an unconsumed approval, and `approval.planDigest === job.plan.digest`) or `planned` (only when `plan.approvalRequired === false`) | Any billable plan going `planned → queued` must fail |
| L-3 | `plan.approvalRequired` is a **derived value**: `adapter.capabilities().billable || plan.network !== "none" || plan.secretRefs.length > 0`; callers cannot pass it in | Constructing a modal plan with `approvalRequired:false` → `validatePlan` must fail |
| L-4 | `resource: active → closed` must throw when `recoverable === true` ("must not close a resource that is the sole holder of a recoverable artifact copy," upstream lifecycle.ts:200-205) | — |
| L-5 | `delivery` can only leave `none` after `execution` has entered a terminal state | — |
| L-6 | Once `execution` is terminal, `recoverable` can only be set to false by `delivery=complete` or by `release` | — |
| L-7 | The full combination space of the three axes plus `recoverable` is **exhaustively enumerated** by tests (Cartesian product × event table), asserting "the legal set = the explicit table" | Any reachable path outside the table → must fail |

#### 1.1.3 Plan and digest

Copied from COMPUTE_DESIGN §1.2's field set, Spark-ified in four places:

1. **`command` is a `string[]` (argv), not a shell string**. Upstream uses `bash -lc '<cmd>'`; this document rejects that — what gets approved should not go through another round of shell expansion. On the remote side, the adapter generates an `exec`-style call.
2. **`env` only allows non-secrets**: `validatePlan()` runs the key names through a pattern sourced from the same place as `redactSecrets` (`llm/types.ts:78-83`), rejecting on any hit. Secrets can only travel via `secretRefs` (symbolic names).
3. **The digest excludes `workspaceRoot` (an absolute path)**, following the same thinking as upstream plan.ts:358-360 and Spark's `protocolHash` excluding timestamps. **Everything else goes into the digest, including `estimate`** — if the pricing table changes, re-approval should be required.
4. **`estimate` follows PRICING discipline** (`llm/providers/registry.ts:19-37`): `unitPriceUsd` must carry a `source` and a `verifiedDate`; if it can't be looked up, it is `null`, and `upperBoundUsd` follows suit as `null`; **never filled with 0**.

#### 1.1.4 Approval: a line-by-line comparison with `WetLabLoop` (this is where CB-5's pass/fail criteria land)

| Wet experiment (a verified mechanism) | Compute (this design) | Location |
|---|---|---|
| `approve()` only valid in `awaiting_approval`; rejects if `protocolHash` is missing; `actor` is required (`wet_loop.ts:371-386`) | Same; rejects if `plan.digest` is missing; `actor` is required | `compute/approval.ts` |
| Writes a `decision` record: `evidence:"inferred"`, `origin:{kind:"manual"}`, `metadata.kind:"approval"`, `protocolHash` (`wet_loop.ts:387-418`) | Same shape; `metadata` replaced with `planDigest` / `jobId` / `target` / `estimate` / `warningShown:true` / `uploadsCount` / `uploadBytes`; a `derives_from` edge points at the experiment record (if one exists) | Same as above |
| `approval` stored in experiment meta (`wet_models.ts:129`) | Stored in `job.json.approval` (disk source of truth, K-3) | `job_store.ts` |
| Recompiling invalidates the old approval (`wet_loop.ts:262-304`) | Re-running `plan()` yields a new digest → the old approval is invalidated (`job.json.approval=null`, kept as `supersededApproval`) | `broker.ts` |
| `execute()`: state must be `approved`, hash re-verified, CAS claims the right to execute and consumes the approval (`wet_loop.ts:508-560`) | `dispatch()`: the same four steps; CAS uses `job.json.rev`; **plus a fifth step**: `uploads.preflight()` re-verifies path/size/sha256 file by file (upstream adapter.ts:399-415, `input_changed`) | `broker.ts` + `uploads.ts` |
| Concurrent hits on `executing` → `WetExecutionConflictError` (409) | Concurrent hits on `queued/starting/running` → `ComputeDispatchConflictError` (409) | — |
| Rejection writes a `decision`, `approval=null` (`wet_loop.ts:438-487`) | Same | — |
| MCP does not expose approve/reject/simulate (`mcp/tools.ts:704-732`) | `MCP_WITHHELD` additionally covers `compute_approve` / `compute_run` / `compute_release` (rationale in §1.1.8) | Close-out wiring |
| CLI approval requires a TTY (`lab/cli.ts:150-251`) | The same code moved to `approval/gate.ts`; compute's bypass env name is `SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN` | W5-2 β |
| HTTP approval requires `actor`, `actorSource:"http:explicit"` (`server/routes/lab.ts:32-37`) | Same | W5-2 β |

**How to check "which version was approved, how many times, and how much it cost"**: via the `decision` record's `metadata.planDigest` + `jobId`; `spark-research compute status <jobId>` prints the three sections `approval`/`consumedApproval`/`supersededApproval`; `records timeline --type decision` can be queried directly. The `observation` record's `metadata` carries `planDigest`, `decisionRecordId`, and `actualCostUsd | null`.

#### 1.1.5 Disk source-of-truth layout

```
<project>/experiments/compute/jobs/<jobId>/
  plan.json        the approval object itself (includes the digest; written only at plan() time, read-only after that)
  job.json         three-axis state + rev + approval/consumedApproval/supersededApproval + adapterHandle
  uploads.json     the {path,size,sha256} snapshot taken at preflight time (reconciled entry-by-entry against plan.uploads)
  run.log          remote output tee'd back locally (local adapter writes here directly)
  exit-code        the terminal-state marker (written by the runner for the local adapter; pulled back by harvest for modal)
  harvest/         the harvested outputs
```

`jobId` looks like `cj-<base36 timestamp>-<uuid8>`, matching the style of `RunStore`'s runId (`platform.ts:211`).

#### 1.1.6 Adapters

- **local** (CB-2): `run()` = `Bun.spawn(command, { cwd: <job>/workspace, stdout/stderr → fd files })`, for the same "write to files, don't pipe" reason as `platform.ts:218-233`. `recover()` order: `exit-code` exists → harvest; else pid alive → reattach (poll only); else → `interrupted → failed(recoverable=true)`. **It carries the full contract-test suite** (zero credentials in CI). `capabilities()` = `{ billable:false, persistentVolume:false, recovery:true, secretRefs:false }`.
- **modal** (CB-4): implemented item-by-item per COMPUTE_DESIGN §1.3-1.4; `check()` uses a read-only call such as `apps.list()` for connectivity probing (for `capabilities --probe`). Two tiers of e2e: `tests/fixtures/compute/modal/*.json` record-and-replay (CI); a real manual smoke test. **Recording layer**: the SDK is gRPC, not `HttpClient`, so `http/fixture.ts`'s mechanism doesn't fit — all SDK calls inside the adapter go through a `ModalGateway` interface (`createSandbox / getSandbox / readVolume / writeVolume / deleteVolume / listByTag`), and tests inject a `RecordedModalGateway`. This is CB-4's only new mechanism, and it must be written into the lane's task brief.
- **ssh**: only the `SshHost` schema exists (host key fingerprint pinned, `ProxyJump` hop-by-hop, identity path forbids `%$`, user forbids `@`, concurrency 1-100), with `validateSshHost()` unit-tested; `targets()` lists it but with `available:false`.

#### 1.1.7 Upload surface (CB-3)

A pure-function layer: input is `workspaceRoot + requested paths` → output is `UploadEntry[]` or a structured rejection:

- Deny-list directories (`.git .ssh .aws .kube node_modules .venv __pycache__ …`), path regexes (`.config/(gcloud|gh)`), secret-filename regexes (`.env* .netrc credentials.json *.pem|key|p12`) — **fail-closed**: an explicit request that hits one of these throws `UploadDeniedError` rather than being silently skipped.
- gitignore awareness: prefer batched `git check-ignore --no-index`; without git, fall back to self-parsing `.gitignore` + `.git/info/exclude`.
- Dual limits: `COUNT_LIMIT=200` / `BYTES_LIMIT=256 MiB` (the numbers are written as constants and surfaced in capabilities, shown on the approval screen).
- symlinks are never followed (traversal through one is rejected).
- `preflight(entries)`: before dispatch, re-verifies each file's canonical path, size, and sha256; any mismatch → `UploadChangedError` (`input_changed`).

#### 1.1.8 Wiring surface

| Entry point | Contents | Owner |
|---|---|---|
| CLI `compute` | `plan` (from `--command/--upload/--output/--gpu/--timeout` or `--from-experiment <id>`) · `approve <jobId>` (TTY gate; `--run` dispatches in the same step) · `reject` · `run <jobId>` (dispatch) · `status` · `list` · `collect` · `cancel` · `release` · `targets` | W5-2 β |
| HTTP | `server/routes/compute.ts`, `app.route("/api/compute", …)` (the section at `server/app.ts:223-239`) | W5-2 β writes the file; the one line in `app.ts` is wired up at close-out |
| MCP exposed | `compute_plan` (no side effects; returns digest + warning + a per-file listing + `humanAction`) · `compute_status` · `compute_list` · `compute_collect` (only meaningful when `delivery=pending`) | wired into `mcp/tools.ts` at close-out |
| **MCP withheld** | `compute_approve` (an approval that spends real money, isomorphic to AD-6) · `compute_run` (dispatch = the billable action itself, isomorphic to `lab_simulate`: "only allowed to enter from `approved` via a human") · `compute_release` (deleting a remote volume = destructive, isomorphic to `project_archive`) | wired into `MCP_WITHHELD` at close-out; `sub_agent.ts:137-147`'s `assertNoWithheldGrants` is derived from the same table, **automatically covering AD-14** |
| ToolBus pricing | `ToolCallCost.unit: "call" \| "computeSeconds"` (`agents/toolbus.ts:72-93`); `costOf()` still returns `null` for `compute_*` — **an agent going through MCP can only plan / check status, never dispatch**; the real spend is recorded by the broker after harvest via `BudgetLedger.record({ costUsd })` (`llm/budget.ts:134`). The broker's ledger is injected by the caller (the orchestrator's `sessionBudget`, `agents/orchestrator.ts:806`) | W5-2 β |
| capabilities | `CapabilityManifest.compute: { targets: ComputeTargetCapability[] }`, derived from the adapter registry; `narrative_parity` gains an assertion that "the target count claimed in docs = the registry" | wired into `capabilities/index.ts` at close-out |
| Evidence graph | Bridge path: reuses `ExperimentLoop.ingestOutputs()` (`experiment/loop.ts:290-335`) and observation (`:354-384`), with `metadata` gaining `computeTarget / planDigest / computeJobId / decisionRecordId / actualCostUsd`; generic path (`compute run` outside of an experiment): one `observation` (`kind:"compute_output"`, `evidence:"computed"`) plus one artifact record per harvested file | W5-3 α |

#### 1.1.9 The CB-6 call: sits alongside, plus a bridge, without adding a new experiment state

**Conclusion: build it, as a "bridge," and do not touch `EXPERIMENT_STATES`.** Rationale:

1. `SimulationPlatform.submit()`'s contract #2 is non-blocking (`simulation/models.ts:90-94`), which is incompatible with an approval gate (K-1).
2. Adding `awaiting_compute_approval` to the dry-experiment state machine would trigger the full consumer-side sweep required by discipline rule 13 (frontend state-name string comparisons, MCP descriptions, llms.txt, SKILL.md) — that is exactly how v0.3.0 regressed. **v0.5 does not take this risk.**

**The shape of the bridge** (`compute/sim_bridge.ts` + one branch in `experiment/loop.ts` + two fields in `experiment/models.ts`):

- `ExperimentMeta` (`experiment/models.ts:48-70`) gains `computeTarget: "local" | "modal" | null` and `computeJobId: string | null` (optional fields; old records default to local, with no migration needed).
- `exp new --target modal` writes `computeTarget`.
- In `ExperimentLoop.run()`'s `dry_run` branch: if `computeTarget` is null, the original path is unchanged; otherwise `platform.prepare()` proceeds as before (local normalization, `stageDir/params.json`), followed by `planFromPrepared()`: `command = [python, "runner.py", "--params", "params.json", "--outdir", "."]`, `uploads = [runner.py, sim_runtime.py, params.json]`, `outputs = expectedOutputs + ["done.json","progress.json","stdout.log"]`, and `resources.gpu` taken from `--gpu` or the platform default (openmm defaults to `null`, requiring the user to opt in explicitly). `computeJobId` is written, the state **stays at `dry_run`**, `lastError = null`, and `exp status` shows "compute job <id> awaiting approval: spark-research compute approve <id> --run".
- Once a human approves and dispatches, `exp run <id> --resume` calls `broker.poll(jobId)` instead of `platform.poll(runId)`; once `delivery=complete`, `materializeHarvest()` writes the harvest directory back into the form `RunStore` understands, at `<runs>/<runId>/` (`done.json` + outputs + `run.json`, `run_store.ts:18-34`), after which `platform.collect(runId)` **works unmodified**, and `ingestOutputs()` works unmodified.
- As a result, the `SimulationPlatform` interface, `SubprocessSimulationPlatform`, `openmm/index.ts`, and `pyref` get **zero changes**; `simulation/registry.ts` gets zero changes (this also clears the way for W5-3 β's three-platform bundle).

**Acceptance** (unchanged from proposal §3.3): a real OpenMM task is planned → approved (one-time digest consumption) → dispatched → the local process is SIGKILLed → `exp run --resume` after restart harvests it → the observation enters the graph. The CI version runs the same path with the local adapter (`tests/unit/compute_e2e.test.ts` + `compute_driver.ts`); the Modal version uses record-and-replay plus a manual smoke test.

#### 1.1.10 Credentials (AD-2)

- The Modal token is stored under `connectors.modal = { token_id, token_secret }` in `credentials.json` — `CredentialStore` is already a KV store keyed by id (`daemon/credentials.ts:76-80`), so no separate store is created for compute.
- What the adapter receives is a `CredentialProvider` (`connectors/base.ts:31-34`) — the same interface as connectors — and `get("modal")` is only resolved inside the process where the broker lives (CLI/server); the kernel-side permit set is unchanged (`python_kernel` only has the `credentials` metadata method).
- `secretRefs` are resolved at dispatch time via `provider.get(ref)` → `modal.secrets.fromObject(...)` → discarded immediately after use; `job.json`/`plan.json` only ever contain symbolic names. Test: treat the content of `credentials.json` as a needle and grep the entire job directory and all record content — zero hits.

### 1.2 C4 · Embedding abstraction and semanticizing novelty

#### 1.2.1 Location and layering

```
backend/src/llm/embeddings/
  types.ts           EmbeddingAdapter / EmbedRequest / EmbedResponse (isomorphic to AD-13: ok=false ⇒ vectors=null)
  openai_compat.ts   POST {baseUrl}/v1/embeddings — covers openai / qwen (DashScope compatibility mode) / ollama / vLLM / self-hosted
  router.ts          EmbeddingRouter: reads config `embeddingModel` (of the form "openai/text-embedding-3-small" / "local/nomic-embed-text"),
                     resolves provider → apiKey (reusing PROVIDER_API_KEY_ENV, providers/registry.ts) → baseUrl (reusing router.ts's ADAPTERS baseUrl and LOCAL_BASE_URL_ENV)
  calibration.ts     SEMANTIC_THRESHOLDS: { [modelId]: { high: number, calibratedOn: string, sampleSize: number, source: "tests/fixtures/novelty/calibration.json" } }
```

**Relationship to `ProviderAdapter`: same layer (both are provider adapters), different contract.** `EmbeddingAdapter` does not `extend ProviderAdapter` — `ProviderRequest` (`llm/providers/types.ts:17-25`) has `messages/options/tools`, none of which embedding uses; forcing the fit would just produce a fake request whose `messages` is permanently empty. **What is reused is the infrastructure**: the AD-13 discipline of `failure()`/`llmFailure`, `redactSecrets`, `providerApiKeyEnv`, `configuredLlmTimeoutMs`, injecting `fetchImpl`, and `HttpClient` (**embedding goes through `http/client.ts`'s `HttpClient` rather than raw fetch** — this makes `http/fixture.ts`'s record-and-replay usable with zero changes, see §1.2.4).

Ollama: the planning directory §(b) states "the native endpoint is `/api/embeddings`; whether it is compatible with `/v1/embeddings` has not been verified." This document's choice: **implement only the OpenAI-compatible shape** (`/v1/embeddings`), with Ollama accessed through its OpenAI-compatible layer; the first thing lane β does when starting work is verify this endpoint against local Ollama, and if it doesn't work, add `ollama_native.ts` (`/api/embed`) — both are within β's ownership and don't affect anyone else.

#### 1.2.2 How novelty consumes it

Current state: `ideation/affinity.ts:73-98`'s `coverage()`/`claimAffinity()` is lexical coverage; `ideation/novelty.ts:49` has `HIGH_AFFINITY = 0.75`; `constrainRating()` (`novelty.ts:391`) constrains the rating using `candidate.affinity`; `NoveltyDeps` (`novelty.ts:617-631`) has a `highAffinity?` injection slot.

Changes (all within β's ownership):

1. `NoveltyCandidate` (`novelty.ts:159`) gains `semanticAffinity: number | null` and `affinityBasis: "semantic" | "lexical"`.
2. `NoveltyDeps` gains `embedder?: Pick<EmbeddingRouter, "embed" | "modelId">`. Once retrieval is complete, a single batched `embed([...claimTexts, ...candidateTexts])` call is made; if `ok=false`, everything falls back to `semanticAffinity=null`, `affinityBasis="lexical"`, and the report's "methodology note" states "embedding unavailable (<error.kind>); falling back to lexical for this run" — **no silent degradation** (the same discipline as `feedback_silent_fallback_logging`).
3. `constrainRating()`'s threshold is `basis === "semantic" ? SEMANTIC_THRESHOLDS[modelId].high : HIGH_AFFINITY`; **an uncalibrated model forces lexical** (`affinityBasis="lexical"`, even when embedding succeeds — the vector is computed but not used as a constraint, appearing only as a reference column in the report).
4. The report (`renderNoveltyReport`, `novelty.ts:519`) shows two columns per candidate: lexical / semantic; the "methodology note" spells out this run's basis, model, threshold, and calibration date. AD-8's "keep both the model's original judgment and the corrected one" is unchanged, with an added layer of "keep both kinds of similarity."

#### 1.2.3 Recalibration: where do the samples come from

This is C4's real difficulty, and the planning directory doesn't answer it. This document's answer:

| Source | Count | How to construct |
|---|---|---|
| **Published (existing)** | ≥10 claims | Pick real papers from **existing fixture cassettes** (`tests/fixtures/literature/*.json`, real OpenAlex/EuropePMC/arXiv responses recorded starting at P2; `tests/fixtures/proteins/` also works). Write one **paraphrased** claim per paper (don't copy the title — reword it, reorder it, Chinese is allowed); the positive sample is that paper, and the negative samples are 3 neighboring works in the same field from the same cassette |
| **Fabricated combinations (novel)** | ≥10 claims | Splice together unrelated methods/subjects from two cassettes into one claim (following the approach in devlog P4's calibration table (b)); nearest neighbors are drawn from the full pool of cassette candidates |
| **The 2 original from P4** | 2 | Kept as-is, as a historical control |

Written to disk at `tests/fixtures/novelty/calibration.json`: `{ claim, lang, expected: "existing"|"novel", positives: [paperKey], negatives: [paperKey], cassette }`.

**Where the vectors come from, and how CI runs it**: the embedding adapter goes through `HttpClient` → `FixtureHttp` records the `/v1/embeddings` responses to `tests/fixtures/embeddings/<modelId>.json` (`http/fixture.ts`'s key is method + normalized URL + body hash; text in the POST body is distinguished via `bodyHash`, and **request headers are never written to disk** — credentials structurally cannot end up in a fixture). CI replays them, with zero network access.

**Calibration test** (`tests/unit/novelty_calibration.test.ts`): for each calibrated model, compute the positive/negative cosine-similarity distribution over 20+ claims, and assert that `SEMANTIC_THRESHOLDS[model].high` falls between "the highest negative sample" and "the lowest positive sample" with **a margin of ≥ 0.05 on each side**; `sampleSize` must equal the number of entries in calibration.json (registry checked against the source of truth, the narrative_parity discipline). Negative control: shift the threshold by ±0.1 → must fail; delete 5 samples → `sampleSize` mismatch → must fail.

**Which model to record with**: decided by lane β based on the keys the user actually holds — first choice `openai/text-embedding-3-small` (if the user has `OPENAI_API_KEY`), fallback local Ollama `nomic-embed-text` (zero keys needed). **Thresholds are only registered for models that have a recorded fixture**; any model not in the table always falls back to lexical (K-4).

#### 1.2.4 Configuration and capabilities

- `CONFIG_SETTINGS` gains `embeddingModel` (in the table at `config/index.ts:99`; `envVar: "SPARK_RESEARCH_EMBEDDING_MODEL"`, defaulting to `null` = lexical).
- `CapabilityManifest` gains `embedding: { configured: boolean; model: string | null; calibrated: boolean; threshold: number | null }` — an external agent knows, before novelty even runs, whether this machine is lexical or semantic (AD-12). This section changes `capabilities/index.ts` and is wired up at close-out.

### 1.3 C5-② · SMILES → 2D structure diagram

#### 1.3.1 Shape

```
backend/src/chem/
  depict.py     stdin JSON {smiles, width?, height?} → stdout JSON {ok, svg, canonicalSmiles, formula, molWeight, rdkitVersion} | {ok:false, error}
  depict.ts     depictSmiles(input, deps): spawns a subprocess (resolvePython(), simulation/platform.ts:26-31) → validates the SVG (starts with "<svg", no <script>) → ArtifactStore.save() → an artifact record
  cli.ts        spark-research chem depict "<SMILES>" [--name mol] [--json]
server/routes/chem.ts   POST /api/chem/depict {smiles, name?}
```

- **Why a subprocess rather than `PythonKernel`** (objection X-5): a single depict call is a 100ms-scale, stateless invocation that doesn't need a persistent kernel; going through the daemon would drag in `ControlRepl`/permits as well (`simulation/platform.ts:23-26` already made the same call for the simulation layer). `rdkit>=2023.9` is already in the `pyproject.toml` dependencies — **zero new dependencies**.
- **Artifact channel**: `ArtifactStore.save()` (`artifacts/store.ts:172-232`) already maps `.svg` to `image/svg+xml` (`:65-82`). `depict.ts` first writes the SVG to `<project>/artifacts/tmp/<name>.svg`, then calls `save()`, with `lineageMessages` recording `{kind:"write", file, content:"rdkit depict <canonicalSmiles>"}`; then `records.createFromArtifact(saved, { evidence:"computed", metadata:{ kind:"chem_depiction", smiles, canonicalSmiles, formula, molWeight, rdkitVersion } })` (the same usage as `experiment/loop.ts:316-333`).
- **Frontend**: `center.tsx:355-400`'s `ArtifactsView` currently has only two branches, `.md` and `<pre>`. Add a third: `contentType === "image/svg+xml"` → `<img src={"data:image/svg+xml;utf8," + encodeURIComponent(body)} />`. Use `<img>` rather than innerHTML: even if a `<script>` got mixed into the SVG, it would not execute — the backend has already validated it, so this is the second line of defense. **No frontend dependency is introduced** (AD-7).
- **Entry points**: the CLI `chem` is a new `case` in `index.ts`; MCP's `chem_depict` (`request: POST /api/chem/depict`, with `present` stating "artifact id + viewable on the workbench's 'Artifacts' page").
- **No SKILL.md is created**: this is a capability primitive, not a skill; it does not count against the skill quota in proposal §2.2. It will get one later when chem-type skills are integrated.

#### 1.3.2 Validation

- Unit tests: a valid SMILES → a valid SVG + the correct record shape; an invalid SMILES → `ok:false` and **no record/artifact is written at all** (negative control: make the script emit an empty SVG for invalid input → the assertion must fail); rdkit missing → an actionable error message (following the `PlatformAvailability.reason` convention).
- `ui_cli_parity.test.ts` gains a fourth group: the record fingerprint from CLI depict and HTTP depict must match.
- A new Playwright case is added: "⑭ depict → a .svg appears in the artifacts list → `img.naturalWidth > 0`."

### 1.4 C2 / C3 · Integration pipeline (a repeatable checklist)

#### 1.4.0 Prerequisite: the V26 rate limiter (before any NCBI-family connector)

```
backend/src/http/ratelimit.ts
  HOST_RATE_POLICIES: Record<host, { rps: number; burst: number; source: string; verifiedDate: string }>
  class RateLimitedHttp implements HttpClient   // decorator: takes a token bucket keyed by new URL(url).host; all connectors on the same host share one pool
  rateLimitedHttp(inner: HttpClient = defaultHttp): HttpClient
```

- The key is the **host**, not the connector (the conclusion of proposal §0.2 supplement). First-batch policies: `eutils.ncbi.nlm.nih.gov` at 3 rps (anonymous, per NCBI's official documentation NBK25497 — the lane must attach the URL and verification date when entering it), `rest.kegg.jp` at 3 rps, `api.crossref.org` / `api.openalex.org` per their polite-pool documentation. **A number with no cited source may not go into the table** (the same discipline as PRICING).
- Wiring point: the `ConnectorRegistry` constructor (`connectors/registry.ts:90-92`) uses `this.options.http ?? rateLimitedHttp()`; an injected `http` (fixture/stub) **is not wrapped**, so test determinism is unaffected.
- Test: `tests/concurrency/host_ratelimit.test.ts` — `pubmed` + `ncbi` + a staged eutils connector each fire 40 concurrent requests at a `StubHttp` timer, asserting that within any 1s window, requests landing on `eutils.ncbi.nlm.nih.gov` are ≤ `rps + burst`; negative control: remove the decorator → must fail; change the key to the connector name → the three each get 3 rps for a combined 9 → must fail.
- **Gate check**: `narrative_parity` gains a rule that "when the number of connectors in `BUILTIN_CONNECTORS` whose `metadata.domain` is `eutils.ncbi.nlm.nih.gov` is ≥ 2, `HOST_RATE_POLICIES` must have an entry for that host" — turning "rate-limit before integrating" from a discipline into a red/green check.

#### 1.4.1 Routing criteria (applied at the first step of integration, not the last)

| Criterion | Goes through the P15 declarative manifest (`connectors/manifest.ts`, `ext verify` automatically covers the concurrency invariant) | Goes through a TS connector (a `HttpConnector` subclass) |
|---|---|---|
| Response | JSON | XML / text / a 200+empty-body branch (BindingDB) |
| Request | Single call | Multi-hop (esearch → esummary) |
| Parameters | Enumerable/typeable | Requires runtime rewriting (`query→term`, a fixed `db=`) |
| This batch's candidates | biorxiv (single-hop JSON, `server` enum) · string-db (JSON) · reactome (JSON) | clinvar (two-step eutils) · opentargets (GraphQL POST, multi-entity requires splitting into tools) |

The planning directory's staged connectors are all in TS form (`workstreams/connectors/staged/clinvar.ts` etc.). **Routing isn't about convenience — it's about letting sources that can go through the manifest automatically get `ext verify`'s 100-concurrency invariant**; sources that can't go this route are integrated as TS, with the concurrency invariant written by hand into `tests/concurrency/connector_race.test.ts`.

#### 1.4.2 Connector integration checklist (one per source, written into the lane devlog)

```
□ 0  Write down the pulling source clearly: an F-1 gap / a user's research topic / a shortfall in an already-integrated capability (pick one of the three; if you can't articulate it, don't integrate)
□ 1  Fill in the routing criteria table (§1.4.1); decide manifest or TS
□ 2  If the host is a rate-limited one such as NCBI/KEGG: confirm HOST_RATE_POLICIES already has that host (otherwise do §1.4.0 first)
□ 3  Copy from staged/<id>.ts into backend/src/connectors/<id>.ts; strip the STAGED/UNTESTED header section;
     keep only user-relevant limitations in metadata.caveat (rate limits/field version differences), remove any "untested" wording
□ 4  staged/<id>.test.ts → tests/unit/connector_<id>.test.ts (string-db → connector_string_db)
□ 5  FIXTURE_MODE=record bun test tests/unit/connector_<id>.test.ts → tests/fixtures/<domain>/<id>.json;
     check the fixture for no api_key/mailto etc. (http/fixture.ts's VOLATILE_QUERY_KEYS already strips these, but grep by hand once anyway)
□ 6  Turn the recording block from skipIf(!RECORDING) into a regular replay test case (no leftover skips allowed: proposal §6.1's "0 skip")
□ 7  Register in two places: BUILTIN_CONNECTORS (by domain) + CONNECTOR_CLASSES (connectors/registry.ts:36-88);
     for a new domain (pathways/omics), add the key in BUILTIN_CONNECTORS and domainOf() picks it up automatically
□ 8  Three gates:
     ① a tightened AD-5 — this connector must be consumed by at least one reachable entry point (lit search's sources / a skill / an MCP tool),
        and must appear in the connectors list of capabilities --json (automatic); being called only from tests = not integrated
     ② concurrency invariant — manifest sources pass automatically via ext verify; TS sources get a new group added to connector_race.test.ts
     ③ storage-layer writer — this batch of connectors carries no storage, mark N/A (if some source needs to write papers into LibraryStore,
        register it in narrative_parity's STORE_WRITE_BINDINGS)
□ 9  the narrative_parity "connector count" assertion updates automatically; if docs/DESIGN.md / README has a hardcoded connector count, change it in the same PR
□ 10 Consumer sweep (discipline rule 13): does the new tool name go into the mcp/tools.ts description? does regenerating llms.txt produce an empty diff?
□ 11 Full run of the six test suites + negative control (revert one response field in the fixture → the normalization test must fail)
□ 12 Write in the devlog: the pulling source, the date of the first real network test, and any 429/403 encounters and how they were handled
```

#### 1.4.3 Platform-skill integration checklist (scanpy / pydeseq2 / cobrapy)

The planning directory has already designed all three as new `dry-experiment` `SimulationPlatform`s (`workstreams/skills/OVERVIEW.md:10,15`; the "production entry point" section of `staged/scanpy/VALIDATION_PLAN.md`). **The wiring point `simulation/registry.ts:7-9` is confirmed to exist and is uncontested by any lane in W5-3** (the CB-6 bridge doesn't touch it, §1.1.9).

```
□ 0  Pulling source (as above); the pull for the three-platform bundle = explicitly stated in proposal §2.3 + AD-4's third payoff
□ 1  Add dependencies to pyproject.toml (scanpy/anndata/leidenalg/igraph…); measure real uv pip install time and wheel availability,
     write it into the devlog (VALIDATION_PLAN already requires this)
□ 2  backend/src/simulation/<id>/{index.ts, runner.py}: extends SubprocessSimulationPlatform;
     the runner uses sim_runtime.RunContext (simulation/sim_runtime.py), with atomic writes of done.json
□ 3  registry.ts: add the id to SIMULATION_PLATFORM_IDS + add a case to the switch
□ 4  Contract test: tests/unit/<id>_contract.test.ts using describeSimulationContract() (tests/helpers/simulation_contract.ts:17-37);
     if the environment is unavailable, the whole suite skips and prints the reason — but the CI machine must have it installed (the 0-skip baseline), and the lane report must state whether it actually ran on that machine
□ 5  e2e: an offline small dataset goes into tests/fixtures/<id>/ (VALIDATION_PLAN explicitly forbids downloading during tests);
     the assertion is a **scientific criterion** (scanpy: known marker genes fall in a cluster's top table; pydeseq2: known direction of differential expression;
     cobrapy: known model growth rate), not "it ran without erroring"
□ 6  Python-side tests/sim/<id>_runner.test.py
□ 7  Copy SKILL.md from staged into backend/src/skills/<id>/; the three paths in frontmatter's validation must genuinely exist (frontmatter.ts checks this);
     platforms: [<id>] must be an already-registered id
□ 8  Three gates: ① entry point = reuses the exp CLI + exp_design/exp_run MCP — add a line to narrative_parity's SKILL_ENTRYPOINTS,
     `"<id>": { cli: ["exp"], mcp: ["exp_design","exp_run"] }` (tests/unit/narrative_parity.test.ts:185);
     ② ext verify doesn't apply (an in-repo platform) → the contract test is the gate; ③ storage layer N/A
□ 9  docs/EXTENDING.md's "N skills" number (narrative_parity.test.ts:476 checks this) + the skills/README.md table + capabilities, automatically
□ 10 Six test suites + negative control (change the gene name in a marker assertion to a wrong one → must fail; delete the registry's case → the whole contract-test suite goes missing → "skill reachability" must fail)
```

#### 1.4.4 Command-style skills: explicitly not integrated in v0.5

The planning directory's OVERVIEW mentions "the remaining 8 new `chem/seq/data/flow/review/critique/scholar` command groups." Each one requires touching `index.ts` + `mcp/tools.ts` + `capabilities`, and the R-d gate check requires that as soon as a SKILL.md lands in the repo it must have an entry point — **they can only be wired up in batches during a close-out window**. Proposal §2.2 caps the total at 8 skills; the three-platform bundle takes 3, leaving 5 slots reserved for real gaps exposed by the F-1 external acceptance review; this document **does not pre-schedule** any command-style skill.

#### 1.4.5 Two rules to write into `EXTENDING.md` (documentation changed at close-out, not code)

1. **Any wet-experiment-type skill must funnel into the existing `wet-protocol` approval gate; parallel approval channels are forbidden** (item 5 of the planning directory's BATCH_ROLLUP "integration candidates"; a corollary of AD-6 at the skill layer). By the same logic: **any billable action must funnel into `compute`'s approval gate** — a skill must not call the Modal SDK on its own.
2. Per-tool content-type overrides (SureChEMBL's form-urlencoded) go into BACKLOG, pending a real pull.

### 1.5 Peripheral module designs (brief)

| Item | Design | Files |
|---|---|---|
| **Making the V25 safety-gate fields actually consumed** (W5-1 δ) | The compiler's main pipeline parses concentration (`CONCENTRATION_SIGNAL`, `lab/protocol.ts:275`) into `ReagentSpec.concentration` (a field already present at `protocol.ts:3-8`) and `biosafetyLevel` into `ProtocolStep.params`; the two rules (`lab/safety.ts:121-160`) turn from "permanently a no-op" into real consumption; the corresponding `unconsumedWarnings` branch (`protocol.ts:296-307`) **changes to only report on parse failure**, with successful parsing counting as consumption. Negative control: remove the parser → `safety.test`'s "over-limit concentration must fail" must fail + `lab_compile.test`'s "already-consumed no longer warns" must fail | `lab/protocol.ts` `lab/safety.ts` + two tests |
| **V31/V32** (W5-2 δ) | ① In addition to `extensions/mcp_client.ts`'s `.mcp_calls.jsonl` (`:159-178`), every external tool call also writes an `observation` record (`kind:"external_tool_call"`, `evidence:"sourced"`), **and `external_tool_call` is added to `NON_EVIDENCE_RECORD_TYPES`** (`agents/contract.ts:152`) — it's an audit trail, not progress (K-3); ② `createExternalToolRunner()` is wired into `AgentToolBus.options.runner`. **The wiring points `agents/orchestrator.ts` and `toolbus.ts` are uncontested in W5-2** (β only adds the `unit` value, which is not in the same function as δ's runner replacement) — but the two are in the same file; see the disposition in §3.2 | `extensions/mcp_client.ts` `agents/contract.ts` `agents/orchestrator.ts` (owned by δ in W5-2) |
| **F-3 removing aliases** | The three aliases in `connectors/base.ts:180-186` are removed; a CHANGELOG breaking-changes section | Gate F, main session |
| **V21 timeout prefix** | `SPARK_HTTP/LLM/KERNEL/TASK_TIMEOUT_MS` → `SPARK_RESEARCH_*`; the old names are kept for one version with a deprecation warning; discipline rule 11's consistency assertion is updated accordingly | Gate F or close-out |

---

## 2. Key interface signatures

> What follows are signatures that can be dropped directly into code, not pseudocode. Comments only explain "why."

### 2.1 `backend/src/compute/lifecycle.ts`

```ts
export const EXECUTION_STATES = [
  "planned", "awaiting_approval", "approved", "rejected",
  "queued", "starting", "running",
  "succeeded", "failed", "timed_out", "cancelled", "interrupted",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const DELIVERY_STATES = ["none", "pending", "complete", "rejected", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const RESOURCE_STATES = ["none", "starting", "active", "closed", "unknown"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const LIFECYCLE_EVENTS = [
  "review", "approve", "reject", "dispatch", "start", "run",
  "succeed", "fail", "timeout", "cancel", "interrupt", "recover",
  "deliver", "deliver_ok", "deliver_reject", "deliver_fail", "retry_delivery",
  "resource_start", "resource_active", "close", "lose",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface LifecycleState {
  execution: ExecutionState;
  delivery: DeliveryState;
  resource: ResourceState;
  /** The remote side still holds the sole recoverable copy of the artifact; when true, close must throw (L-4). */
  recoverable: boolean;
}

export interface TransitionContext {
  /** The derived value of plan.approvalRequired (L-3); dispatch going directly out of planned is only legal when this is false (L-2). */
  approvalRequired: boolean;
  /** Must be present and its digest must match at dispatch time (L-2); ignored for all other events. */
  approval?: { planDigest: string } | null;
  planDigest: string;
  /** The outcome the adapter decides on after recover. */
  recoverOutcome?: "running" | "succeeded" | "failed";
}

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionState, Partial<Record<LifecycleEvent, ExecutionState>>>>;
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, Partial<Record<LifecycleEvent, DeliveryState>>>>;
export const RESOURCE_TRANSITIONS: Readonly<Record<ResourceState, Partial<Record<LifecycleEvent, ResourceState>>>>;

export function initialLifecycle(): LifecycleState; // { planned, none, none, false }
/** A pure function: any illegal transition throws ComputeStateError; there is no silent correction (discipline rule P5). */
export function transition(state: LifecycleState, event: LifecycleEvent, ctx: TransitionContext): LifecycleState;
export function isExecutionTerminal(s: ExecutionState): boolean;
/** /api/compute/machine is derived from these two functions; hand-writing it is not allowed (AD-12 ③). */
export function approvalGate(): { from: "awaiting_approval"; to: "approved"; requires: ["actor"] };
export function dispatchGate(): { from: "approved"; to: "queued"; consumesApproval: true; verifies: ["planDigest", "uploads"] };

export class ComputeStateError extends Error {
  constructor(readonly from: LifecycleState, readonly event: LifecycleEvent, reason: string);
}
```

### 2.2 `backend/src/compute/plan.ts`

```ts
export interface UploadEntry { path: string; size: number; sha256: string }

export interface CostEstimate {
  unit: "computeSeconds";
  quantity: number;                 // timeoutMinutes * 60 — an upper bound, not a prediction
  unitPriceUsd: number | null;      // null if it can't be looked up, never 0
  upperBoundUsd: number | null;
  source: string | null;            // the pricing page URL
  verifiedDate: string | null;      // ISO date
}

export interface ComputePlan {
  schemaVersion: 1;
  digest: string;                    // sha256(canonicalJson(plan with digest and workspaceRoot removed))
  target: TargetRef;
  purpose: string;
  command: string[];                 // argv; shell strings are rejected
  cwd: "/workspace";
  env: Record<string, string>;       // validatePlan rejects secret-looking keys
  image: { base: string; pip: string[]; pipLock: { digest: string; requirements: string } | null } | null;
  secretRefs: string[];              // symbolic names; values never enter plan/job
  resources: { gpu: string | null; cpus: number; memoryGb: number; timeoutMinutes: number };
  network: "none" | "unrestricted";
  uploads: UploadEntry[];
  uploadBytes: number;
  outputs: string[];                 // glob
  approvalRequired: boolean;         // derived (L-3)
  estimate: CostEstimate;
  warning: string;                   // plain text: "this run uses your <target> account and may incur charges; upper bound $X"
  workspaceRoot: string;             // absolute path; excluded from the digest
}

export type PlanInput = Omit<ComputePlan, "digest" | "approvalRequired" | "estimate" | "warning" | "uploadBytes" | "schemaVersion" | "cwd">;

export function planDigest(plan: Omit<ComputePlan, "digest">): string;
export function buildPlan(input: PlanInput, caps: AdapterCapabilities, pricing: PricingLookup): ComputePlan;
export function validatePlan(plan: ComputePlan, caps: AdapterCapabilities): void; // throw PlanValidationError
export type PricingLookup = (target: TargetRef, gpu: string | null) => Omit<CostEstimate, "unit" | "quantity" | "upperBoundUsd">;
```

### 2.3 `backend/src/compute/target.ts`

```ts
export type TargetRef =
  | { kind: "local" }
  | { kind: "modal"; environment?: string }
  | { kind: "ssh"; hostId: string };        // v0.5 is a placeholder only, available:false

export const TARGET_KINDS = ["local", "modal", "ssh"] as const;

export interface AdapterCapabilities {
  billable: boolean;
  persistentVolume: boolean;
  recovery: boolean;
  secretRefs: boolean;
  network: readonly ("none" | "unrestricted")[];
  gpus: readonly string[];            // optional GPU model names; [] for local
  uploadLimits: { count: number; bytes: number };
}

export interface RunHooks {
  onLog?: (line: string) => void;
  onState?: (patch: Partial<LifecycleState>) => void;
  signal?: AbortSignal;
}

/** The remote handle held by the adapter; written as a whole into job.json.adapterHandle, and handed back unchanged to recover() after a restart. */
export interface AdapterHandle {
  kind: TargetRef["kind"];
  /** local: { pid, startedAt }; modal: { sandboxId, volumeName, appName, tags } */
  data: Record<string, string | number | null>;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  handle: AdapterHandle;
}

export interface Harvest {
  files: Array<{ path: string; bytes: number; sha256: string }>;   // already written to <job>/harvest/
  logPath: string;
  exitCode: number | null;
  wallSeconds: number | null;
  /** Non-null when the exit code reported remotely doesn't match the marker on the volume (reconcile); the caller marks delivery=failed. */
  reconcileError: string | null;
}

export interface DispatchSpec {
  jobId: string;
  plan: ComputePlan;
  jobDir: string;                                 // <project>/experiments/compute/jobs/<jobId>
  /** Resolved by the broker only at dispatch time; the adapter discards it immediately after use and must not write it to any file. */
  resolveSecret: (ref: string) => Record<string, string>;
}

export interface ComputeAdapter {
  readonly kind: TargetRef["kind"];
  readonly description: string;
  capabilities(): AdapterCapabilities;
  /** A credential connectivity probe (used by the capabilities --probe tier); produces no remote resources. */
  check(): Promise<{ ok: boolean; reason: string | null; detail: Record<string, string | number | boolean | null> }>;
  /** Dispatches and waits until execution reaches a terminal state; logs stream back via hooks. After returning, delivery is still pending — harvesting is a separate step. */
  run(spec: DispatchSpec, hooks: RunHooks): Promise<RunResult>;
  /** After the orchestrating process restarts: still running → reattach and wait for a terminal state; already finished → return directly; lost → throw RecoverFailure (classification below). */
  recover(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle, hooks: RunHooks): Promise<RunResult>;
  /** Harvests outputs from the persistent volume/working directory; **does not depend on the sandbox still being alive**. */
  collect(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<Harvest>;
  cancel(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<void>;
  /** Deletes the remote volume/working directory; the caller (broker) has already guaranteed recoverable=false per L-4 before calling this. */
  release(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<void>;
}

export type RecoverFailureKind = "retryable" | "unauthorized" | "quota" | "ownership_mismatch" | "invalid_request" | "not_found";
export class RecoverFailure extends Error { constructor(readonly kind: RecoverFailureKind, message: string); }

export interface SshHost {
  id: string; host: string; port: number; user: string;
  hostKeyFingerprint: `SHA256:${string}`; hostKey: string;
  identityPath: string; proxyJump: string[]; concurrency: number; scheduler: "none" | "slurm" | "pbs";
}
export function validateSshHost(input: unknown): SshHost;   // follows the validation rules of upstream jobs.ts's Host schema
```

### 2.4 `backend/src/compute/approval.ts` (within CB-1, X-1)

```ts
export interface ComputeApprovalMeta {
  decisionRecordId: string;
  actor: string;
  actorSource: string;          // "explicit" | "http:explicit" | …, per the AD-6 P7 convention
  at: string;
  planDigest: string;
  note: string | null;
}

export interface ApproveInput { actor: string; actorSource?: string; note?: string }
export interface RejectInput  { actor: string; actorSource?: string; reason: string }

export class ComputeApproval {
  constructor(deps: { records: Pick<RecordStore, "create" | "link">; jobs: ComputeJobStore; now?: () => string });
  /** awaiting_approval → approved; writes a decision record; writes job.json.approval. An empty actor → ApprovalRequiredError. */
  approve(jobId: string, input: ApproveInput): { job: ComputeJobView; decisionId: string };
  reject(jobId: string, input: RejectInput): { job: ComputeJobView; decisionId: string };
  /**
   * Pre-execution re-verification + one-time consumption: if the digest matches, approval→consumedApproval within the same CAS write;
   * if not, mark failed and throw ApprovalRequiredError (following wet_loop.ts:522-538).
   * Called by broker.dispatch(); not exposed externally as an entry point.
   */
  consume(jobId: string, currentDigest: string, expectedRev: number): ComputeJobView;
}
export class ApprovalRequiredError extends Error {}
```

### 2.5 `backend/src/compute/job_store.ts` and `broker.ts`

```ts
export interface ComputeJobRecord {
  jobId: string;
  projectSlug: string;
  experimentId: string | null;          // only present on the bridge path
  target: TargetRef;
  lifecycle: LifecycleState;
  rev: number;                          // CAS; follows the semantics of project/records.ts:340-370
  approval: ComputeApprovalMeta | null;
  consumedApproval: ComputeApprovalMeta | null;
  supersededApproval: ComputeApprovalMeta | null;
  rejection: (ComputeApprovalMeta & { reason: string }) | null;
  adapterHandle: AdapterHandle | null;
  createdAt: string; dispatchedAt: string | null; finishedAt: string | null;
  exitCode: number | null; message: string | null;
  actualCostUsd: number | null;         // filled in after harvest; null if the unit price can't be looked up
}
export type ComputeJobView = ComputeJobRecord & { plan: ComputePlan; jobDir: string };

export class ComputeJobStore {
  constructor(root: string);                       // <project>/experiments/compute/jobs
  create(plan: ComputePlan, init: Pick<ComputeJobRecord, "projectSlug" | "experimentId" | "target">): ComputeJobView;
  read(jobId: string): ComputeJobView | null;
  /** An atomic write (temp file + rename) + CAS; throws ComputeJobConflictError if rev doesn't match. */
  patch(jobId: string, patch: Partial<ComputeJobRecord>, opts?: { expectedRev?: number }): ComputeJobView;
  list(filter?: { experimentId?: string; execution?: ExecutionState[] }): ComputeJobView[];
  dirOf(jobId: string): string;
}

export interface ComputeBrokerDeps {
  jobs: ComputeJobStore;
  adapters: Partial<Record<TargetRef["kind"], ComputeAdapter>>;
  approval: ComputeApproval;
  credentials: CredentialProvider;                 // connectors/base.ts:31-34
  pricing: PricingLookup;
  budget?: Pick<BudgetLedger, "record">;           // injected = spend is recorded to the ledger; not injected = only written to job.json
  admissionLimit?: number;                         // defaults to 2; exceeding it fails explicitly rather than queuing
}

export class ComputeBroker {
  constructor(deps: ComputeBrokerDeps);
  targets(): Array<{ kind: TargetRef["kind"]; available: boolean; reason: string | null; capabilities: AdapterCapabilities | null }>;
  /** Normalization + digest + the triple upload filter; zero side effects (creates no remote resources, writes no credentials). */
  plan(input: PlanInput, ctx: { projectSlug: string; experimentId?: string }): Promise<ComputeJobView>;
  /** approved → queued; five steps: state / approval presence / digest re-verification / uploads preflight / CAS consumption; then adapter.run(). */
  dispatch(jobId: string, hooks?: RunHooks): Promise<ComputeJobView>;
  poll(jobId: string): ComputeJobView;             // reads disk only
  /** Reattaches after a restart: dispatches based on adapterHandle via adapter.recover(); terminal-class RecoverFailure marks it failed directly. */
  recover(jobId: string, hooks?: RunHooks): Promise<ComputeJobView>;
  collect(jobId: string): Promise<{ job: ComputeJobView; harvest: Harvest }>;
  cancel(jobId: string): Promise<ComputeJobView>;
  release(jobId: string): Promise<ComputeJobView>; // L-4 is guarded inside lifecycle.transition
}
```

### 2.6 `backend/src/compute/sim_bridge.ts`（CB-6）

```ts
export function planFromPrepared(
  prepared: PreparedRun,                       // simulation/models.ts:27-44
  target: TargetRef,
  opts: { python: string; runtimePath: string; gpu?: string | null; timeoutMinutes?: number },
): PlanInput;
/** Writes <job>/harvest/ back as <runs>/<runId>/{done.json, outputs..., run.json}, in the form RunStore can read; returns the runId. */
export function materializeHarvest(runStore: RunStore, prepared: PreparedRun, job: ComputeJobView, harvest: Harvest): string;
```

### 2.7 ToolBus pricing (an extension of `agents/toolbus.ts:72-93`)

```ts
export type ToolCostUnit = "call" | "computeSeconds";
export interface ToolCallCost { unit: ToolCostUnit; costUsd: number | null }
// costOf() still returns { unit:"call", costUsd:null } for compute_* tools: an agent going through MCP never dispatches, so pricing doesn't belong here.
// Real spend: ComputeBroker.collect() → deps.budget.record({ inputTokens:0, outputTokens:0, costUsd: actual|null, usageUnavailable:false })
```

### 2.8 `backend/src/llm/embeddings/types.ts` and `router.ts`

```ts
export interface EmbedRequest {
  model: string;
  input: string[];
  apiKey: string | null;            // null for a local endpoint
  baseUrl: string;
  timeoutMs: number;
  http: HttpClient;                 // http/client.ts — makes FixtureHttp injectable
  signal?: AbortSignal;
}

export type EmbedResponse =
  | { ok: true;  provider: string; model: string; vectors: number[][]; dims: number; usage: { tokens: number; costUsd: number | null; usageUnavailable?: boolean }; error?: undefined }
  | { ok: false; provider: string; model: string; vectors: null;       dims: null;   usage: { tokens: 0; costUsd: null; usageUnavailable: true };  error: LlmError };

export interface EmbeddingAdapter {
  readonly id: string;
  /** Any failure returns ok:false rather than throwing (the same convention as ProviderAdapter.call). */
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  batchLimit(): number;
}

export class EmbeddingRouter {
  constructor(opts?: { env?: Record<string, string | undefined>; http?: HttpClient; fetchImpl?: typeof fetch });
  /** The result of resolving the config's embeddingModel; null = not configured (novelty falls back to lexical). */
  modelId(): string | null;
  configured(): boolean;
  embed(texts: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<EmbedResponse>;
}

export function cosine(a: number[], b: number[]): number;   // a pure function; unit tests pin down the numeric values
```

`calibration.ts`：

```ts
export interface SemanticThreshold { high: number; calibratedOn: string; sampleSize: number; source: string }
export const SEMANTIC_THRESHOLDS: Readonly<Record<string, SemanticThreshold>>;   // only registers models that have a recorded fixture
export function semanticHighAffinity(modelId: string | null): number | null;      // unregistered = null → novelty forces lexical
```

### 2.9 `backend/src/chem/depict.ts`

```ts
export interface DepictInput { smiles: string; name?: string; width?: number; height?: number }
export interface DepictResult {
  ok: true; svg: string; canonicalSmiles: string; formula: string; molWeight: number; rdkitVersion: string;
  artifactId: string; recordId: string; path: string;
}
export interface DepictFailure { ok: false; error: { kind: "invalid_smiles" | "rdkit_unavailable" | "timeout" | "bad_output"; message: string } }
export interface DepictDeps { artifacts: ArtifactStore; records: RecordStore; python?: string; timeoutMs?: number; projectSlug: string; sessionId?: string | null }
export async function depictSmiles(input: DepictInput, deps: DepictDeps): Promise<DepictResult | DepictFailure>;
export function assertSafeSvg(svg: string): void;   // starts with <svg, no <script, no on*= attributes, no <foreignObject
```

### 2.10 `backend/src/http/ratelimit.ts`

```ts
export interface HostRatePolicy { rps: number; burst: number; source: string; verifiedDate: string; note?: string }
export const HOST_RATE_POLICIES: Readonly<Record<string, HostRatePolicy>>;
export class RateLimitedHttp implements HttpClient {
  constructor(inner: HttpClient, policies?: Readonly<Record<string, HostRatePolicy>>, now?: () => number);
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;   // a host with no policy passes straight through
  /** For tests: the current bucket state of a given host. */
  bucketOf(host: string): { tokens: number; lastRefill: number } | null;
}
export function rateLimitedHttp(inner?: HttpClient): HttpClient;
```

### 2.11 capabilities increment (the `CapabilityManifest` at `capabilities/index.ts:154-181`)

```ts
export interface ComputeTargetCapability {
  kind: "local" | "modal" | "ssh";
  description: string;
  availability: Availability;           // ssh is always "placeholder"
  reason: string | null;
  credentialConfigured: boolean | null; // modal: whether credentials.json has a modal entry; local: null
  billable: boolean; persistentVolume: boolean; recovery: boolean;
  uploadLimits: { count: number; bytes: number };
  probeCache?: "hit" | "miss";
}
export interface EmbeddingCapability { configured: boolean; model: string | null; calibrated: boolean; threshold: number | null }
// CapabilityManifest gains: compute: { targets: ComputeTargetCapability[]; withheld: string[] }; embedding: EmbeddingCapability
```

---

## 3. Parallel waves and lane assignment

### 3.0 Footprint-verification method (redone)

The planning directory's `TODO_v0.5.md` §"Parallel development verification" was written while v0.4 was in flight, and it checked "the intersection with P11's four lanes." Those constraints have all been lifted. This document instead lists a contention matrix by **wave × file**: how many lanes want to touch each file within a given wave.

| File | Lane(s) wanting it in W5-1 | W5-2 | W5-3 | Disposition |
|---|---|---|---|---|
| `backend/src/index.ts` | γ (`case "chem"`) | β (`case "compute"`) | — | **Only one per wave** → assigned to that lane |
| `backend/src/mcp/tools.ts` | γ (`chem_depict`) | β (`compute_*` + 3 withheld entries) | — | Same as above |
| `backend/src/capabilities/index.ts` | β (embedding section) · γ (none) | β (compute targets section) | — | Assigned to β in W5-1; assigned to β in W5-2 |
| `backend/src/server/app.ts` | γ (one `/api/chem` line) | β (one `/api/compute` line) | — | One lane per wave → assigned to that lane |
| `backend/src/config/index.ts` | β (`embeddingModel`) | β (`computeTarget`, `modalEnvironment`) · α (none) | — | Assigned to β |
| `backend/src/agents/toolbus.ts` | — | β (`ToolCostUnit`) · δ (the runner replacement is in orchestrator, not toolbus) | — | Assigned to β in W5-2 |
| `backend/src/agents/orchestrator.ts` | — | δ (V32 runner) · β (injecting sessionBudget into the broker? **Not done** — in v0.5 the agent never dispatches, so the orchestrator doesn't need the broker) | — | Assigned to δ in W5-2 |
| `backend/src/agents/contract.ts` | — | δ (adds one item to `NON_EVIDENCE_RECORD_TYPES`) | — | Assigned to δ |
| `backend/src/connectors/registry.ts` | — | γ (rate-limiter wiring + first-batch registration) | γ (second batch) | Assigned to γ |
| `backend/src/literature/normalize.ts` | — | γ (if biorxiv is wired into unified search) | γ | Assigned to γ |
| `backend/src/simulation/registry.ts` | — | — | β (the three-platform bundle) | Assigned to β; α's bridge does not touch it (§1.1.9) |
| `backend/src/simulation/platform.ts` | α (exports `canonicalJson`, 1 line) | — | — | Assigned to α |
| `backend/src/experiment/{loop,models,cli}.ts` | — | — | α (the bridge) | Assigned to α |
| `backend/src/lab/cli.ts` | — | β (moves the TTY gate to `approval/gate.ts`) | — | Assigned to β; δ (V25) in W5-1 touches `lab/protocol.ts`/`safety.ts`, a different wave |
| `backend/src/project/models.ts` (`RECORD_TYPES`) | — | δ (if `external_tool_call` were made a new record type) — **not done**: uses `observation` + `metadata.kind` instead, no 10th type is added | — | Nobody touches it |
| `tests/unit/narrative_parity.test.ts` | α (registers the compute module's "awaiting wiring" entry) · γ (none: chem has an entry point) · β (none) | β (removes α's registration) · γ (no SKILL_ENTRYPOINTS entries) · δ (none) | β (three SKILL_ENTRYPOINTS lines + the EXTENDING number) | **Only registry-entry edits are allowed**; in W5-1 only α edits it → assigned to α; in W5-2 only β edits it → assigned to β; in W5-3 only β edits it |
| `docs/EXTENDING.md` "N skills" | — | — | β | Assigned to β |
| `frontend/workspace/src/components/center.tsx` | γ (the svg branch) | — | — | Assigned to γ |
| `pyproject.toml` | — | — | β | Assigned to β |
| `package.json` (the `modal` dependency) | — | α | — | Assigned to α |
| `llms.txt` | `bun run gen:llms` at each wave's close-out | | | Close-out |
| `CHANGELOG / BACKLOG / README / DEVELOPMENT_PLAN*` | No lane may touch these | | | Close-out |

**Conclusion**: across v0.5's three waves, **no single file is contested by two lanes within the same wave** (every row/column in the matrix is ≤1). So the "pull the whole thing out" list in proposal §5.1 can, in practice, be assigned wave-by-wave in v0.5 (X-2). **The only thing that genuinely needs to be done centrally at close-out is regenerating `llms.txt` and the four off-limits documents.** The cost: the main session must re-run this matrix before each wave starts — the ownership tables in the lane task briefs are just slices of the matrix.

### 3.1 W5-1

| Lane | Task | Suggested model | Files owned exclusively |
|---|---|---|---|
| **α** C1 contract + approval semantics + local + upload surface (CB-1/2/3) | `compute/{lifecycle,plan,target,approval,job_store,uploads,broker}.ts` from the table in §1.1.1 + `adapters/local.ts` + the contract-test helper | Opus | `backend/src/compute/**` (except `cli.ts`/`sim_bridge.ts`/`adapters/modal.ts`) · `backend/src/simulation/platform.ts` (**only** allowed to export `canonicalJson`) · `package.json` (**only** allowed to add the `modal` devDependency, pinned to 0.9.0; no import this wave) · `tests/unit/compute_*.test.ts` · `tests/helpers/compute_contract.ts` · `tests/unit/narrative_parity.test.ts` (**only** allowed to add an "awaiting wiring" entry to `ALLOWED_ORPHANS`) · `docs/devlog/W5-1-a.md` |
| **β** C4 embedding + novelty recalibration | All of §1.2 | Opus | `backend/src/llm/embeddings/**` · `backend/src/ideation/{novelty,affinity}.ts` · `backend/src/config/index.ts` (**only** allowed to add `embeddingModel`) · `backend/src/capabilities/index.ts` (**only** allowed to add the `embedding` section) · `tests/unit/{novelty,novelty_e2e,novelty_calibration,embeddings}.test.ts` · `tests/fixtures/{embeddings,novelty}/**` · `docs/devlog/W5-1-b.md` |
| **γ** C5-② SMILES→SVG | All of §1.3 | Sonnet | `backend/src/chem/**` · `backend/src/server/routes/chem.ts` · `backend/src/server/app.ts` (**only** allowed to add one `app.route("/api/chem", …)` line plus the import) · `backend/src/index.ts` (**only** allowed to add `case "chem"`) · `backend/src/mcp/tools.ts` (**only** allowed to append `chem_depict`) · `frontend/workspace/src/components/center.tsx` (**only** allowed to add the svg branch to ArtifactsView) · `frontend/workspace/src/lib/types.ts` (if a contentType field is needed) · `tests/unit/{chem_depict,chem_cli,chem_http,chem_mcp}.test.ts` · `tests/unit/ui_cli_parity.test.ts` (**only** allowed to add one group) · `tests/e2e/workbench.spec.ts` (**only** allowed to append ⑭) · `docs/devlog/W5-1-c.md` |
| **δ** Making the V25 safety-gate fields actually consumed | Row 1 of §1.5 | Sonnet | `backend/src/lab/protocol.ts` · `backend/src/lab/safety.ts` · `backend/src/skills/wet-protocol/SKILL.md` (the coverage section) · `README.md`'s "the safety gate's current real coverage" paragraph (**the only** exception allowing a lane to touch README, because that paragraph is V25's narrative and would drift if left to close-out) · `tests/unit/{lab_safety,lab_compile}.test.ts` · `tests/lab/protocol_agent.test.py` (if the Python-side parsing is touched) · `docs/devlog/W5-1-d.md` |

**α's "awaiting wiring" registration**: `compute/broker.ts` and `compute/adapters/local.ts` have no production caller in W5-1 (the CLI is in W5-2 β) → per v0.4 §5.3 supplement, register in `ALLOWED_ORPHANS`: "awaiting wiring: this entry must be deleted once W5-2 β's `compute/cli.ts` is wired up." `lifecycle/plan/target/approval/job_store/uploads` are imported by `broker.ts` and are therefore not orphans.

### 3.2 W5-2

| Lane | Task | Model | Files owned exclusively |
|---|---|---|---|
| **α** CB-4 Modal adapter | §1.1.6's modal; the `ModalGateway` recording layer; `check()`; record-and-replay fixtures; **requires the user to supply a token** — without a token, this lane can only deliver "gateway interface + recording layer + passing the contract tests with a fake gateway," with real recording left to a manual smoke test after close-out (must be stated honestly in the report) | Opus | `backend/src/compute/adapters/modal.ts` · `backend/src/compute/adapters/modal_gateway.ts` · `tests/unit/compute_modal.test.ts` · `tests/fixtures/compute/modal/**` · `docs/devlog/W5-2-a.md` |
| **β** CB-5 wiring | `compute/cli.ts` · `approval/gate.ts` (moved out of `lab/cli.ts:150-251`, with lab switched to use it) · `server/routes/compute.ts` + one line in `app.ts` · `index.ts`'s `case "compute"` · four MCP-exposed tools in `mcp/tools.ts` + **three `MCP_WITHHELD` entries** · `toolbus.ts`'s `ToolCostUnit` · `config/index.ts`'s `computeTarget`/`modalEnvironment` · `capabilities/index.ts`'s `compute` section · removing α's `ALLOWED_ORPHANS` registration · three AD-14 adversarial tests (a subagent calling `compute_approve/run/release` must be rejected) · a TTY-gate test (piping must be rejected) | Opus | The files above + `backend/src/lab/cli.ts` (**only** allowed to swap the gate for an import) · `tests/unit/{compute_cli,compute_http,compute_mcp,approval_gate,toolbus}.test.ts` (toolbus only gains test cases) · `tests/unit/sub_agent.test.ts` (only gains adversarial cases) · `tests/unit/narrative_parity.test.ts` (only removes the registration + adds the "target count" assertion) · `docs/devlog/W5-2-b.md` |
| **γ** The V26 rate limiter + C2 first batch (≤4, per the F-1 outcome; defaulting to clinvar · biorxiv · reactome · string-db) | §1.4.0 + the §1.4.2 checklist ×4 | Sonnet | `backend/src/http/ratelimit.ts` · `backend/src/connectors/{registry,clinvar,biorxiv,reactome,string-db}.ts` (or merged into domain files per REGISTRY_PATCH — **the choice must be locked in the task brief**; this document decides on separate files) · `backend/src/literature/{normalize,search}.ts` (when biorxiv is wired into unified search) · `tests/concurrency/{host_ratelimit,connector_race}.test.ts` · `tests/unit/connector_*.test.ts` · `tests/fixtures/{genomics,literature,pathways}/**` · `docs/devlog/W5-2-c.md` |
| **δ** V31/V32 | Row 2 of §1.5 | Sonnet | `backend/src/extensions/mcp_client.ts` · `backend/src/agents/{orchestrator,contract}.ts` · `tests/unit/{mcp_client,orchestrator,contract}.test.ts` · `docs/devlog/W5-2-d.md` |

**β and δ both touch `agents/` in the same wave**: β only touches `toolbus.ts`, δ only touches `orchestrator.ts` + `contract.ts` — different files, no contention in the matrix. Each task brief locks in "must not stray into the other lane's files."

### 3.3 W5-3

| Lane | Task | Model | Files owned exclusively |
|---|---|---|---|
| **α** The CB-6 bridge + real e2e | `compute/sim_bridge.ts` · a branch in `experiment/{loop,models,cli}.ts` · `compute_driver.ts` · `compute_e2e.test.ts` (local, SIGKILL) · a real Modal smoke test (if a token is available) · the observation-metadata increment | Opus | The above + `backend/src/server/routes/experiments.ts` (passing through the `target` field) · `backend/src/mcp/tools.ts` (**only** allowed to add a `target` parameter and its description to `exp_design`) · `tests/unit/{experiment,experiment_cli,server_experiments}.test.ts` · `docs/devlog/W5-3-a.md` |
| **β** C3 three-platform bundle | The §1.4.3 checklist ×3 | Opus | `backend/src/simulation/{registry.ts,scanpy/**,pydeseq2/**,cobrapy/**}` · `backend/src/skills/{scanpy,pydeseq2,cobrapy}/**` · `backend/src/skills/README.md` · `docs/EXTENDING.md` (**only** allowed to change the "N skills" number) · `pyproject.toml` · `tests/unit/{scanpy,pydeseq2,cobrapy}_{contract,e2e}.test.ts` · `tests/sim/*_runner.test.py` · `tests/fixtures/{scanpy,pydeseq2,cobrapy}/**` · `tests/unit/narrative_parity.test.ts` (**only** allowed to add three `SKILL_ENTRYPOINTS` lines) · `docs/devlog/W5-3-b.md` |
| **γ** C2 second batch (≤4, **only opened if F-1 or the W5-2-end external acceptance review calls for it**; otherwise this lane stays empty) | §1.4.2 | Sonnet | Same pattern as W5-2 γ |
| **δ** Floating slot + BACKLOG cleanup (X-4) | Absorbs overflow from the first two waves; the **implementation** of "absorb or explicitly drop" decisions for V3/V8/V9/V13/V14/V24, item by item (the decision itself is made in main-session review) | Sonnet | Assigned ad hoc based on overflow items |

### 3.4 Hub-file list verification

Proposal §5.1 lists 9 files. Verification results:

| Proposal's list | Actual contention in v0.5 | Disposition |
|---|---|---|
| `index.ts` `mcp/tools.ts` `server/app.ts` `capabilities/**` | Only one lane per wave (the §3.0 matrix) | **Assigned wave-by-wave** (X-2) |
| `agents/orchestrator.ts` `agents/toolbus.ts` | One lane each in W5-2, different files | Delegated |
| `connectors/registry.ts` `literature/normalize.ts` | Only γ | Delegated to γ |
| `narrative_parity.test.ts` | One lane per wave editing the registry | Delegated, **rule unchanged: only registry-entry additions/removals allowed** |
| **Added** `config/index.ts` | W5-1 β, W5-2 β | Delegated to β |
| **Added** `docs/EXTENDING.md`, `skills/README.md`, `pyproject.toml` | W5-3 β | Delegated |
| **Added** `llms.txt` | Every wave | **Close-out**: `bun run gen:llms` |
| **Added** `CHANGELOG.md` `BACKLOG.md` `README.md` (except the V25 section) `DEVELOPMENT_PLAN*` | — | **Close-out** |

### 3.5 Dependency edges and critical path

```
Gate F ─┬─► W5-1 α ──► W5-2 β ──┬─► W5-3 α (bridge + e2e) ──► close-out ──► v0.5.0
        │            W5-2 α ────┘ (needed for the real Modal smoke test; not needed on the CI path)
        ├─► W5-1 β (independent)
        ├─► W5-1 γ (independent)
        ├─► W5-1 δ (independent)
        ├─► W5-2 γ (V26 → first-batch connectors; does not depend on W5-1)
        ├─► W5-2 δ (independent)
        └─► W5-3 β (depends only on the simulation/registry gap being open; uncontested in W5-3)

Critical path: F → W5-1 α → W5-2 β → W5-3 α → close-out. The three close-out tails (one per wave) are each serial.
```

**The close-out checklist for each wave** (main session, not optional): merge the integration branch → `bun run gen:llms` → independently re-run the negative controls from each lane's report → the full six test suites → check `ALLOWED_ORPHANS` symmetry → devlog/CHANGELOG.

### 3.6 Zero-context external acceptance review insertion points (unchanged from proposal §6.3)

Gate F (baseline) · **end of W5-2** (submit a compute task and read back the conclusion, including approval; performed by a person/session not involved in development — using the local target is sufficient to verify the approval chain, no need to wait for Modal) · pre-release (a clean machine).

---

## 4. Verification design for each lane

| Lane | Negative control ① (reverting the fix must fail) | Negative control ② | Stage gates |
|---|---|---|---|
| **W5-1 α** | Change `dispatch`'s `approved` in-edge to also accept `awaiting_approval` → the L-2 case in `compute_lifecycle.test` must fail | Make `consume()` not clear `approval` → `compute_approval.test`'s "must not be able to re-dispatch on a stale approval after a restart" must fail; `uploads.test`: tamper with one byte of a file already preflighted → `UploadChangedError` must throw; comment out the sha256 comparison → must fail | typecheck · unit · concurrency (a new `compute_dispatch_once.test.ts`: N=30 concurrent dispatches of the same approved job → exactly 1 succeeds, following `tests/concurrency/approve_once.test.ts`) · timeout · e2e · py · lab |
| **W5-1 β** | Shift the threshold by ±0.1 → the margin assertion in `novelty_calibration.test` must fail | Make `vectors` become `[]` instead of `null` when `EmbedResponse.ok=false` → a type-level compile error + a runtime case ("degradation must be written into the methodology note") must fail; treat an uncalibrated model as semantic anyway → the "uncalibrated forces lexical" case must fail | Six test suites; `novelty_e2e` must have 0 skips under fixture replay |
| **W5-1 γ** | Make `depict.py` emit an empty `<svg/>` for invalid SMILES → "invalid input writes no record" must fail | Revert the frontend svg branch to `<pre>` → Playwright ⑭'s `naturalWidth>0` must fail; make `assertSafeSvg` allow `<script>` through → the unit test must fail | Six test suites + the new `ui_cli_parity` group |
| **W5-1 δ** | Rip out the concentration parser → `lab_safety.test`'s "50% H2SO4 over the limit must fail" must fail | Successful parsing still reports an unconsumed warning → `lab_compile.test`'s "consumed no longer warns" must fail | Six test suites (`test:lab` must run) |
| **W5-2 α** | Make `recover()` reattach without verifying the ownership tag → the "must reject someone else's sandbox" case must fail (`RecordedModalGateway` replays a sandbox with a mismatched tag) | Make `harvest()` skip reconcile → "must flag a mismatch between the on-volume exit code and the sandbox's report" must fail | Six test suites; the contract-test helper runs record-and-replay against modal |
| **W5-2 β** | Remove `compute_run` from `MCP_WITHHELD` → the AD-14 adversarial case in `sub_agent.test` must fail + `narrative_parity`'s "withheld and exposed don't overlap" stays green but the `consumesApproval` assertion for "/api/compute/machine is derived from the transition table" must fail | Change `approval/gate.ts`'s isTTY check to look only at stdin → `approval_gate.test`'s "must reject when stdout is redirected" must fail; `echo yes \| compute approve` must be rejected | Six test suites; independently re-running `bun backend/src/index.ts compute approve x </dev/null` must be rejected (done manually by the main session, discipline rule 6) |
| **W5-2 γ** | Remove the `RateLimitedHttp` decorator → `host_ratelimit.test` must fail | Change the bucket key to the connector name → the three combined give 9 rps → must fail; change one field name in a fixture → the normalization case must fail | Six test suites; the real first network test for each connector is logged (the terminal output of `FIXTURE_MODE=record` goes into the devlog) |
| **W5-2 δ** | Don't add `external_tool_call` to `NON_EVIDENCE_RECORD_TYPES` → `contract.test`'s "external tool audit trail doesn't count as progress" must fail (following the case shape at `contract.ts:137-152`) | After the runner replacement, no record is written → `mcp_client.test`'s "all four branches write an observation" must fail | Six test suites |
| **W5-3 α** | After SIGKILL, make `exp run --resume` call `dispatch()` directly instead of going through `broker.recover()` → "re-dispatch must require a new approval" must fail | `materializeHarvest` omits writing `done.json` → `platform.collect()` throws "marked completed but the result is missing" → the e2e must fail | Six test suites + a real Modal smoke test (if a token is available); the SIGKILL e2e must pass on local |
| **W5-3 β** | Change a marker gene name to a wrong one → the e2e must fail | Remove the registry's `case "scanpy"` → the entire contract-test suite disappears via skip → **the 0-skip baseline must fail** + "skill reachability" must fail | Six test suites; `test:py` includes the new runner tests; the devlog records how long `uv install` took on this machine |

Common to all lanes: **the report must state which suites could not be run successfully in this lane** (v0.4 §5.2 ⑨), and the main session independently re-runs at least one negative control per discipline rule 6.

---

## 5. Risks and known pitfalls

### 5.1 The four pitfalls hit in v0.4, and how this design avoids them

| Pitfall | What actually happened in v0.4 | How v0.5 avoids it |
|---|---|---|
| **Built but nobody wired it up** (6 times) | The ledger, findings_store, contract, the anthropic adapter… | ① K-5: entry-point files are delegated wave by wave, with each lane wiring up its own work (γ's chem and β's compute commands both close the loop within their own lane); ② the only cross-wave "awaiting wiring" case is W5-1 α → W5-2 β, registered in `ALLOWED_ORPHANS`, and the very first item in W5-2 β's task brief is to delete that registration; ③ `STORE_WRITE_BINDINGS` gains `compute/job_store.ts:create ← compute/broker.ts`, and `CONTRACT_RECORD_PRODUCERS` gains `kind:"compute_output" ← compute/broker.ts` (a gate check keyed on capability rather than on file) |
| **A hub file locked to a single lane, forcing everyone else to leave stub wiring** | P11 R-b's router | The matrix proves that in v0.5 every file has ≤1 lane per wave (§3.0); **the main session re-runs the matrix before each wave starts**, and only pulls a file out if it hits ≥2 |
| **The binary is a different runtime** | W1-d was all-green while the artifact was entirely broken (V27) | Gate F-4 makes a ruling; if "fix" is chosen, `compute/adapters/local.ts`, `chem/depict.py`, and the new runner **must not** use `import.meta.dir` to locate assets outside the script, and a V28 smoke test runs before release (build → `--version`/`capabilities --json`/`doctor`/`chem depict`); if "permanently drop the single-binary distribution" is chosen, INSTALL.md §3 is deleted, and every `import.meta.dir` usage in this document is kept as-is |
| **Bookkeeping records pollute the progress signal** | The `agent_run` close-out in W3 defeated noProgress | K-3: compute state never enters the graph; V31's `external_tool_call` is explicitly added to `NON_EVIDENCE_RECORD_TYPES`; **a new rule is written into the comments of `agents/contract.ts`**: "any lane adding a new record `kind`/type must answer whether it counts as progress" |

### 5.2 New risks

| Risk | Impact | Mitigation |
|---|---|---|
| The Modal token doesn't arrive in time → W5-2 α can only deliver a fake gateway | Real e2e is delayed | The CI path doesn't depend on it (the local adapter walks the full approval chain); α's report honestly states "not actually recorded"; the release criteria list "a real Modal smoke test" as a separate item that cannot be satisfied with a replay |
| Quirks in `modal` SDK 0.9.0, e.g. `close()` not actually closing the gRPC channel | A long-running server accumulates connections | Client pooling is copied as-is; upgrades go through fixtures first |
| Embedding fixtures are tied to a specific model, so if the user switches models the threshold becomes invalid | novelty falls back to "pulled out of thin air" again | K-4: an uncalibrated model forces lexical + capabilities explicitly reports `calibrated:false` |
| scanpy's dependency chain (numba/scikit-learn/leidenalg) fails to compile on the CI machine | The whole contract-test suite skips → the 0-skip baseline fails | W5-3 β's first step measures the wheel in real conditions; on failure, switch to `pydeseq2`/`cobrapy` first, with scanpy pushed to W5-3 δ or v0.6 |
| Moving `approval/gate.ts` touches `lab/cli.ts` | Wet-experiment approval regresses | Only the import is swapped; `lab_cli.test` and e2e ⑧ must pass; β's negative controls include the lab path |
| A user completes `compute approve --run` in one step → approval and dispatch happen at the same instant | This differs from wet's two-step "approve first, then simulate" | Allowed, but `--run` still goes through the same `dispatch()` (consumption + re-verification); the decision record and the dispatch timestamp are recorded separately; both are withheld on the MCP side |
| The C2 second batch is tempting because "it looks useful in staged" | Scope creep | W5-3 γ **stays empty by default**, and only opens if F-1 or the W5-2-end acceptance review gives a written pull request |

---

## 6. Kickoff order and the first wave's task-brief drafts

**Order**: Gate F (F-1 baseline acceptance → F-2 AMiner → F-3 remove aliases → F-4 rules on V27) → the main session `cd`s back to the main repo → creates `feat/w5-1-integration` → spawns the four lanes.

The following four task briefs follow the v0.4 lane-brief format. Shared paragraphs are written once:

> **Shared section (included in every task brief)**
> - Workspace: `git worktree add ~/Desktop/AI4S/spark-research-w5-1-<lane> -b feat/w5-1-<lane> feat/w5-1-integration` → `bun install --frozen-lockfile` → `uv sync` (or link to the main repo's `.venv`; skipping this step causes 17 OpenMM test cases to silently skip) → `export SPARK_E2E_PORT=<4400+lane index>` → **`git push -u` immediately** (discipline rule 9)
> - Isolation: **do not touch other lanes' worktrees or the main repo**; your own lane's workspace is where you belong, regardless of your initial cwd. If the environment contradicts this task brief, stop and ask — that is the correct move.
> - Baseline: `main feb3c8a`; `bun test tests/unit` = 1396 pass / 0 fail / 0 skip
> - Only touch files in the ownership table; report before crossing that boundary. Do not touch CHANGELOG / BACKLOG / README (except δ's V25 section) / DEVELOPMENT_PLAN*; the devlog is written only to `docs/devlog/W5-1-<lane>.md`
> - Before opening a PR, run the full suite: `bun run typecheck` + `bun test tests/unit/` + `tests/concurrency/` + `tests/timeout/` + `bun run test:e2e` + `bun run test:py` + `bun run test:lab`
> - Negative controls are mandatory: revert your own fix, confirm the new test genuinely fails, and paste the terminal output into the devlog
> - The report must state which suites could not be run successfully in this lane (do not count a skip as a pass)
> - Target branch `feat/w5-1-integration`; do not push to main, do not open a PR, do not merge
> - When a newly built module has no production caller yet, register it in `ALLOWED_ORPHANS` and state clearly "awaiting wiring by whom" — only registry additions are allowed, never changes to the assertion logic
> - Credentials must never enter code/fixtures/the devlog; grep every newly added file before committing

### 6.1 W5-1-a · C1 contract-first + approval semantics + the local adapter + the upload surface

**You are the starting point of v0.5's critical path.** Read: `docs/DEVELOPMENT_PLAN_v0.5_MODULES.md` §1.1 (in full) and §2.1-2.5; `~/Desktop/AI4S/spark-research-v0.5-plan/workstreams/compute/COMPUTE_DESIGN.md`; `backend/src/lab/wet_loop.ts:371-560` (the already-verified approach to approval and consumption); `backend/src/simulation/{platform,run_store}.ts` (the disk source of truth and the poll order); `tests/helpers/simulation_contract.ts`, `tests/concurrency/approve_once.test.ts`, `tests/unit/wet_crash_recovery.test.ts`.

**File ownership**: `backend/src/compute/{lifecycle,plan,target,approval,job_store,uploads,broker}.ts` · `backend/src/compute/adapters/local.ts` · `backend/src/simulation/platform.ts` (only allowed to `export` `canonicalJson`) · `package.json` (only allowed to add the `"modal": "0.9.0"` devDependency; no import this wave) · `tests/unit/compute_{lifecycle,plan,approval,job_store,uploads,broker,local}.test.ts` · `tests/concurrency/compute_dispatch_once.test.ts` · `tests/helpers/compute_contract.ts` · `tests/unit/narrative_parity.test.ts` (only allowed to add an `ALLOWED_ORPHANS` registration) · `docs/devlog/W5-1-a.md`

**Tasks**:
1. `lifecycle.ts`: the §2.1 signatures; the three transition tables; a pure `transition()` function; invariants L-1…L-7; an **exhaustive test** (the Cartesian product of the three axes × the event table, versus the explicit legal-state table).
2. `plan.ts`: §2.2; the digest excludes `workspaceRoot`; `approvalRequired` is derived; `estimate` is null when the price can't be looked up; `validatePlan` rejects a shell-string command and secret-looking env keys.
3. `target.ts`: §2.3; `validateSshHost()` follows the upstream Host schema's validation rules (validation only, no implementation).
4. `uploads.ts`: deny-list / gitignore / dual limits / sha256 / symlink rejection / `preflight()`; all pure functions + read-only fs.
5. `job_store.ts`: the directory layout from §1.1.5; atomic writes + `rev` CAS.
6. `approval.ts`: §2.4; the decision-record shape is isomorphic to `wet_loop.ts:387-418` (`evidence:"inferred"`, `origin.kind:"manual"`, `metadata.kind:"approval"`, `planDigest`); `consume()` performs `approval → consumedApproval` within the same CAS operation.
7. `broker.ts`: §2.5; `dispatch()`'s five steps; exceeding the admission limit fails explicitly; `recover()` dispatches based on `adapterHandle`.
8. `adapters/local.ts`: a subprocess that writes to files rather than piping; `recover()`'s order is "check the exit-code file before the pid"; `capabilities().billable=false`.
9. `tests/helpers/compute_contract.ts`: a parameterized contract suite (following `SimulationContractCase`); this wave only runs against local.
10. Register `broker.ts` and `adapters/local.ts` in `ALLOWED_ORPHANS`: "awaiting wiring: this entry must be deleted once W5-2 β's `compute/cli.ts` is wired up."

**Stage gates**: the full six test suites; all new tests green; the `tests/unit` count ≥ 1396 with 0 skips.
**Negative controls** (at least): loosening the L-2 in-edge → must fail; `consume()` not clearing approval → "must not re-dispatch on a stale approval after a restart" must fail; removing the sha256 comparison from `preflight` → must fail; removing CAS from `compute_dispatch_once` → must fail.
**Report requirements**: list every deviation from the §2 signatures, with a reason for each; the impact of exporting `canonicalJson` on `specHashOf` (should be zero, with evidence that `simulation_contract` passes); the final upload deny-list.

### 6.2 W5-1-b · C4 embedding abstraction + novelty recalibration

Read: this document's §1.2 and §2.8; `workstreams/provider/V05_PROVIDER_DESIGN.md` §(b); `backend/src/llm/{types,router}.ts`, `llm/providers/{types,registry,openai_compat}.ts`; `backend/src/ideation/{affinity,novelty}.ts`; `backend/src/http/{client,fixture}.ts`; the calibration table in `docs/devlog/P4-ideation.md`.

**File ownership**: `backend/src/llm/embeddings/**` · `backend/src/ideation/{novelty,affinity}.ts` · `backend/src/config/index.ts` (only allowed to add `embeddingModel`) · `backend/src/capabilities/index.ts` (only allowed to add the `embedding` section and its interface) · `tests/unit/{embeddings,novelty,novelty_e2e,novelty_calibration}.test.ts` · `tests/fixtures/embeddings/**` · `tests/fixtures/novelty/calibration.json` · `docs/devlog/W5-1-b.md`

**Tasks**:
1. The very first thing to do: check whether local Ollama (if present) supports `/v1/embeddings`; write the result into the devlog (AD-12).
2. `embeddings/types.ts` + `openai_compat.ts` + `router.ts` + `calibration.ts` (§2.8); **must go through `HttpClient`**.
3. Dual-trace novelty: `NoveltyCandidate` gains `semanticAffinity`/`affinityBasis`; `NoveltyDeps.embedder`; `constrainRating` picks its threshold based on basis; **an uncalibrated model forces lexical**; the report's methodology note states the basis/model/threshold/calibration date; an embedding failure must be written into the report, never silently swallowed.
4. Calibration set: per §1.2.3, construct ≥20 entries from existing cassettes (≥10 existing / ≥10 novel / the 2 original from P4), written to `calibration.json`; record the vector fixture with `FIXTURE_MODE=record` using whichever model you actually have a key for; `SEMANTIC_THRESHOLDS` only registers that model.
5. `novelty_calibration.test.ts`: margins of ≥0.05 on each side; `sampleSize` must match the count in calibration.json.
6. `CONFIG_SETTINGS.embeddingModel`; the capabilities `embedding` section.

**Stage gates**: the six test suites; `novelty_e2e` at 0 skips under replay.
**Negative controls**: shifting the threshold by ±0.1 → must fail; changing `vectors` to `[]` when `ok=false` → compile error; treating an uncalibrated model as semantic → must fail; deleting 5 samples → `sampleSize` must fail.
**Report requirements**: the final thresholds, the min/max of the positive/negative distributions, the margins; which model was used and the fixture size; the source cassette for every claim in the calibration set; **a table showing where embedding and lexical disagree across the 20 entries** (this is the direct evidence for C4's "improves credibility" claim).

### 6.3 W5-1-c · SMILES → SVG

Read: this document's §1.3 and §2.9; `backend/src/artifacts/store.ts:65-82,172-232`; `backend/src/experiment/loop.ts:290-335` (the `createFromArtifact` usage pattern); `backend/src/proteins/{cli,analysis}.ts` + `server/routes/proteins.ts` + `mcp/tools.ts`'s `protein_analyze` (the precedent for R-d's "three entry points" requirement); `frontend/workspace/src/components/center.tsx:355-400`; `tests/unit/ui_cli_parity.test.ts`; `tests/e2e/workbench.spec.ts`.

**File ownership**: `backend/src/chem/{depict.py,depict.ts,cli.ts}` · `backend/src/server/routes/chem.ts` · `backend/src/server/app.ts` (only allowed to add the import + one `app.route` line) · `backend/src/index.ts` (only allowed to add `case "chem"`) · `backend/src/mcp/tools.ts` (only allowed to append `chem_depict`) · `frontend/workspace/src/components/center.tsx` (only allowed to add the svg branch to ArtifactsView) · `frontend/workspace/src/lib/{types,api}.ts` (only allowed to add contentType pass-through) · `tests/unit/{chem_depict,chem_cli,chem_http,chem_mcp}.test.ts` · `tests/unit/ui_cli_parity.test.ts` (only allowed to add one group) · `tests/e2e/workbench.spec.ts` (only allowed to append ⑭) · `docs/devlog/W5-1-c.md`

**Tasks**:
1. `depict.py`: stdin JSON → stdout JSON; when rdkit is missing, output `{ok:false, error:{kind:"rdkit_unavailable", message:"install: uv pip install rdkit"}}` (following the actionable-reason convention).
2. `depict.ts`: a subprocess (`resolvePython()`) + a timeout + `assertSafeSvg` + `ArtifactStore.save()` + `createFromArtifact({ evidence:"computed", metadata.kind:"chem_depiction" })`; invalid input **writes nothing at all**.
3. Three entry points: the CLI `chem depict`, HTTP `POST /api/chem/depict`, and MCP's `chem_depict` (the description written per the four-part "judgment two" format at the top of `mcp/tools.ts`).
4. The frontend svg branch (`<img data:>`, not innerHTML).
5. A new `ui_cli_parity` group; Playwright ⑭.
6. **No SKILL.md is created.**

**Stage gates**: the six test suites (including `bun run test:e2e`).
**Negative controls**: the script emitting an empty svg for an invalid SMILES → "no record written" must fail; reverting the frontend to `<pre>` → ⑭ must fail; `assertSafeSvg` letting `<script>` through → must fail.
**Report requirements**: the rdkit version and its latency; SVG dimensions; evidence that the record fingerprints match across all three entry points; a screenshot/JSON snippet showing `chem_depict` appearing in capabilities.

### 6.4 W5-1-d · Making the V25 safety-gate fields actually consumed

Read: this document's §1.5 row 1; `backend/src/lab/safety.ts:20-50,121-160`; `backend/src/lab/protocol.ts:3-8,255-310`; the D-8 section of `docs/devlog/P10-d.md`; README's "the safety gate's current real coverage"; `backend/src/skills/wet-protocol/SKILL.md`.

**File ownership**: `backend/src/lab/protocol.ts` · `backend/src/lab/safety.ts` · `backend/src/skills/wet-protocol/SKILL.md` (only allowed to change the coverage section) · `README.md` (**only** allowed to change the "the safety gate's current real coverage" paragraph) · `tests/unit/{lab_safety,lab_compile}.test.ts` · `tests/lab/protocol_agent.test.py` (if the Python side is touched) · `docs/devlog/W5-1-d.md`

**Tasks**:
1. Have the compiler parse concentration into `ReagentSpec.concentration` (normalize units to mol/L or %, and document the convention clearly), and parse BSL into `ProtocolStep.params.biosafetyLevel`.
2. Turn `concentration_limit` / `biosafety` from "permanently a no-op" into real consumption; add source citations to the `MAX_CONCENTRATION` table.
3. Change the two branches of `scanUnconsumedSignals` to **report only on parse failure**; successful parsing counts as consumption and no longer warns.
4. Update README's coverage section and SKILL.md; **do not** claim coverage beyond the actual parsing capability (AD-12).
5. Adversarial cases: an over-limit concentration must fail; BSL-3 must fail; vague phrasing ("an appropriate amount," "high concentration") → still warns as unconsumed.

**Stage gates**: the six test suites (`test:lab` must run).
**Negative controls**: removing the parser → "over-limit must fail" must fail; successful parsing still warning → "consumed no longer warns" must fail.
**Report requirements**: a list of the parseable expression forms (regexes) and an explicit list of what isn't covered; the README paragraph before/after.

---

## 7. Objections (stated explicitly, with rationale)

### X-1 · CB-5's approval **semantics** should be done in CB-1; CB-5 should only handle wiring

Proposal §3.1 places CB-5 in W5-2, and §3.2 calls it the center of gravity. This document agrees with that assessment of importance, but believes the slice boundary is drawn in the wrong place: `planned → awaiting_approval → approved → queued` is the backbone of the lifecycle, and "one-time digest consumption" and "pre-execution re-verification" are **preconditions** of the `dispatch` transition, not bolt-ons. If CB-1 doesn't include them, the exhaustive transition test will inevitably leave `dispatch` with a "no approval check under test" loophole — and that loophole is a production backdoor. Once moved forward, W5-2 β is left with only wiring (CLI/HTTP/withheld/TTY/ToolBus/capabilities), which is actually easier to close out within a single wave. **Cost**: W5-1 α becomes heavier (8 files); Opus is recommended.

### X-2 · The hub-file list should not be locked down for the whole version

The matrix in §3.0 proves that across v0.5's three waves, no file is contested by two lanes in the same wave. Locking it down for the whole version would replay v0.4's "built but nobody wired it up." Files are assigned wave by wave (K-5), with the main session re-running the matrix before each wave starts.

### X-3 · The v0.1 `ComputeService` in the daemon must be resolved one way or the other

> **Upgraded after main-session verification (2026-09-10): this is not "once v0.5 lands, there will be two 'computes' causing confusion" —
> it is a live, silent false-success path that already exists in v0.4.0.**
>
> The actual call chain: `agents/orchestrator.ts:53`'s `TASK_KINDS` includes `"compute"` →
> `orchestrator.ts:490-494`'s `case "compute"` calls `this.daemon.compute.submit()` →
> `daemon/daemon.ts:72-91`'s `DefaultCompute` fabricates a fake job, `{ id, status: "queued" }`,
> using an **in-memory Map** → and **returns `ok: true`**.
>
> In other words: **when an LLM plans a compute task, it gets back a fake job that will never produce
> a result, while the entire chain reports success.** This is exactly what the external review said
> at the time — "delegate_task/compute goes through an in-memory mock that never produces a result —
> an LLM planning a compute task will silently produce a fake job."
> P8 deleted `backend/src/compute/` (the providers/manager/job_manager trio),
> **but this one survived on the daemon side**, and v0.3.0's D-4 ("LLM failures are no longer
> silently treated as success") never covered it either
> (it isn't an LLM failure — it's a false success at the execution layer).
>
> **This disposition is elevated to Gate F's fifth item (F-5)**, ahead of any v0.5 feature work:
> either delete `ComputeService` / `DefaultCompute` / the `compute_submit` entry in `permissions.ts:8` /
> the `"compute"` entry in `TASK_KINDS` and the orchestrator's case branch, or make it explicitly
> report "not implemented." **A silent false success is the worst possible choice**,
> and it has already been alive in the repository for four versions.

### X-4 · W5-3 δ's "runtime contract + Python SDK" definition didn't come along with it (wording already corrected by the main session)

> **Main-session verification: the original claim that "there is no definition anywhere in the full
> proposal text or the planning directory" was overstated.**
> The planning directory's `TODO_v0.5.md:101` and `:132` **do have a definition**:
> "the external API is upgraded to a versioned contract + a zero-dependency Python client
> (benchmarked against upstream's `tooling/sdk/python`). Scheduled for the latter part of v0.5,
> depending on P14's SSE streaming stabilizing."
>
> **But the substance of this objection still holds**: when the main session copied this into
> proposal §5's wave table, **the definition didn't come along with it** — the proposal's body text
> is left with only a one-line heading, so anyone dispatching work off the proposal has no idea what
> it's supposed to do. This is the same shape as the "narrative and implementation diverging" problem
> that recurred throughout v0.4, just occurring between documents this time.
>
> **Disposition**: W5-3 δ is kept, but **the definition must first be moved from the planning
> directory into the proposal's body text**, or it is demoted to a floating slot. Before the
> definition is in the proposal, it does not get dispatched.

### X-5 · C5-②'s "kernel side" should be read as "the Python side"

Routing depict through `PythonKernel`/the daemon would drag the permit set, `ControlRepl`, and the kernel lifecycle into a 100ms stateless call; `simulation/platform.ts:23-26` already made the same trade-off for the simulation layer. This document uses a subprocess + `resolvePython()` (the same `.venv`), with zero new dependencies.

### X-6 (a reminder, not an objection) · Proposal §5 is right to schedule CB-4 and CB-5 in the same wave, but it must state that the two are **mutually independent**

The proposal's dependency graph draws CB-5 after CB-4 (`F → CB-1/2/3 → CB-4 → CB-5`). In practice, CB-5's wiring only faces CB-1's interface, and CI walks the full approval chain using the local adapter; CB-4 lacking a token should not block CB-5. This document's critical path is already drawn this way (§0.2).

---

## 8. Close-out memo for the main session

- W5-1 close-out: `gen:llms`; check α's two `ALLOWED_ORPHANS` registrations; independently re-run α's L-2 negative control and γ's Playwright ⑭; write §1.4.5's two rules into `EXTENDING.md`; decide X-3.
- W5-2 close-out: remove α's registration (β has done this — verify it's symmetric); confirm the two new `narrative_parity` assertions ("target count" and "NCBI host rate limiting") are in place; **the W5-2-end external acceptance review** (the local-target approval chain); verify the three `MCP_WITHHELD` entries made it into `MCP_INSTRUCTIONS` (automatic via `mcp/server.ts:204-214`).
- W5-3 close-out: the skill count in `EXTENDING.md`; `skills/README.md`; the real Modal smoke-test result listed separately (a replay doesn't count); go through all 38 BACKLOG items one by one deciding "absorb/drop"; the CHANGELOG breaking-changes section (F-3, V21).
- Pre-release: the full chain on a clean machine; if F-4 decides "fix," the V28 binary smoke test must include `chem depict` and `compute targets`.

---

## 3 (supplement): Rescheduling W5-1 based on Gate F's output (main session, 2026-09-10)

> This section was appended by the main session after Gate F closed out. The original §3.1 table
> was written **before** Gate F, when F-1's external acceptance review had not yet run.
> Proposal §1 states explicitly that "**F-1's output directly influences the choices in §2**";
> the output is now in, and this section acts on it.

### Supplement.1 F-4 ruling: fix it, don't permanently downgrade

The proposal gives F-4 two paths — "fix it" or "commit permanently to not shipping a single binary" — and stipulates that **no version may leave this hanging again**.

Choosing "fix it" isn't a matter of preference — it's that **the downgrade path doesn't actually work**: the code relies on `bun:sqlite` for the persistence layer, which node cannot run, so **the npm package would also require Bun to be pre-installed**. Dropping the single binary wouldn't simplify installation; it would just make all three installation paths require Bun to be pre-installed — making onboarding worse, not better. Downgrading gives up capability without buying any simplification in return.

F-c has already fully verified the mechanism and produced a minimal viable set (`docs/devlog/F-c.md`): `.sql`/`.txt` go through a static `import ... with { type: "text" }`; `.py` files, because they must be spawned by path from **an external subprocess**, require "static import as text → unpack to a temp file at runtime → spawn the real path" — **`type: "file"` alone doesn't work** (it yields a virtual `/$bunfs/` path that an external python process can't open). `project/records.ts` is the one spot where F-c has already applied the patch on a real machine, compiled it, and run it successfully — concrete proof that the fix approach is viable.

### Supplement.2 Three new lanes (ε / ζ / η), all pulled by F-1

| Lane | Contents | Why it's worth its own lane |
|---|---|---|
| **ε** V27/V33 embedding assets | F-4's execution surface: 3 instances of `schema.sql` · 4 instances of `.py` · 3 instances of prompt `.txt` · 3 dangerous default paths (including V33's `/workspaces`) | The one thing Gate F left unfinished. It determines whether the "single binary" installation path is real or fake |
| **ζ** Literature-domain usability | V34 default sources · V35 long-task CLI visibility · V36 failure messages · V38 BibTeX author names · V39 `lit review --help` | Both of the top two blockers from the external acceptance review live here. **Merged into one lane by file ownership**: all five items land under `literature/`, and splitting them apart would inevitably fight over `literature/cli.ts` |
| **η** Closing out capability-reporting accuracy | V37: `auth` and `config list`/`doctor` report different statuses for the same key + `idea new`'s failure message | The root cause has already been pinned down to a specific line, more specifically than the report stated (see below) |

**V37's root cause** (verified by the main session): `index.ts:103` has a **hand-written copy of `KEY_NAMES` that only lists kimi + openrouter**, while `doctor` / `capabilities` / `onboarding` all derive theirs from `providerApiKeyEnv()`. More directly, `auth()`, when displaying configuration, **only reads the config file and never looks at environment variables** (`index.ts:126`), so it reports "not set" when the key is actually present in the environment. **This is the second occurrence of the exact same bug as the hand-written `PROVIDER_API_KEY_ENV` copy that was closed out in P11** — the source of truth was unified, but this consumer was missed.

### Supplement.3 Rescheduling ownership of `backend/src/index.ts`

The original table gave γ "only allowed to add `case "chem"`" in `index.ts`. Now η needs to rewrite that file's `KEY_NAMES` / `getApiKey()` / `auth()` in three places — **two lanes writing to the same file will inevitably conflict**.

The disposition follows the precedent already established in this document's §3.1 for `app.ts` ("the one line in `app.ts` is wired up at close-out"):

- **`backend/src/index.ts` as a whole belongs to η**
- **γ's `case "chem"` line and its import are wired up at close-out** — γ states in its report exactly which line needs to be written

### Supplement.4 W5-1 footprint verification, incremental (listing only the intersection between the three new lanes and the original four)

| File | Contention | Disposition |
|---|---|---|
| `backend/src/index.ts` | γ (original) · η (new) | **Belongs to η**; γ's line is delegated to close-out (Supplement.3) |
| `backend/src/literature/library.ts` | ε (`schema.sql`) | ζ only takes `{models,cli,export}.ts`, not `library.ts` → no conflict |
| `backend/src/lab/wet_backend.ts` | ε (`.py` spawn) | δ only takes `{protocol,safety}.ts` → no conflict |
| `backend/src/simulation/{openmm,pyref}/index.ts` | ε (`runner.py`) | α only takes the `canonicalJson` export from `platform.ts`; W5-3 β takes the registry + three new platforms → no conflict |
| `backend/src/agents/orchestrator.ts` | ε (V33's `/workspaces`, `:223`) | Only W5-2 δ touches it, **different waves, never simultaneous** → no conflict |
| `backend/src/ideation/cli.ts` | η (the failure message) | β takes `{novelty,affinity}.ts` → no conflict |
| `tests/unit/narrative_parity.test.ts` | α (registers "awaiting wiring") | ζ's new gate-check assertion is put in a **separate new file**, `tests/unit/literature_source_parity.test.ts`, and does not touch the hub file |

### Supplement.5 A gate check ζ needs to add along the way (a structural lesson from V34)

V34 was not an ordinary bug: `lit search --sources arxiv` worked, `capabilities --json` reported arxiv as available, yet `lit add <arxiv-id>` couldn't find it. **The capability was built, but the default value wasn't updated to match it**, and **the AD-12 gate check couldn't catch this** — it checks "is arxiv in the registry," not "does the default value include it."

So beyond fixing that one line, ζ must add an assertion: **any already-implemented source must appear in `DEFAULT_SEARCH_SOURCES`, or be listed with a reason in an explicit exclusion table** (CNKI/Wanfang are placeholder implementations and are a legitimate exclusion). Negative control: remove arxiv from the default set → this assertion must fail.

### Supplement.6 The remaining two external-acceptance-review checkpoints are unchanged

Proposal §6.3 requires three reviews. Gate F has already run the first (baseline). The second is **at the end of W5-2** (including the approval chain; the local target is sufficient, no need to wait for Modal), and the third is **pre-release** (a clean machine). Both must be performed by a session that was not involved in development.

---

## 3 (supplement.7): W5-2 α ships a "degraded delivery without a token"; enabling Modal must be pure configuration (user decision, 2026-09-10)

### The decision

The user's direction: **go with option A first (degraded delivery); the rest goes into the user's config file.**

So W5-2 α's delivery boundary is: **the gateway interface + the recording layer + passing the contract tests with a fake gateway**, with no real Modal recording. The real smoke test is deferred to a manual pass once the user obtains a token. **This blocks no other lane** — α's already-delivered local adapter carries the entire contract-test suite, and the second external acceptance review (end of W5-2) can walk the full approval chain using the local target.

### Three hard constraints that follow from this decision (all must be verifiable, not left to good faith)

**Constraint one: enabling Modal must require zero code changes and zero recompilation.**
The only two actions the user later needs to take are: writing the token into `connectors.modal` in `~/.spark-research/credentials.json` (already specified in §1.1.7, reusing `CredentialStore`, mode 0600), and writing `computeTarget` / `modalEnvironment` into `config.json` (owned by W5-2 β).

> ⚠️ **Correction after W5-2 α's delivery (main session, 2026-09-10)**: this constraint was **only half fulfilled**, and it was lane α itself that flagged it. The decision path really is pure configuration (pinned down by a negative control, with no compile-time constant participating in "whether Modal can be used"), **but a real `ModalGateway` (a Modal SDK client) doesn't exist at all yet** — what this wave delivered is the interface + the recording layer + a fake gateway. So **"just fill in the token and it runs" does not currently hold**.
>
> Rather than making the interface look usable, α made `status()` report this situation in a way that's unattractive but accurate: "the real gateway is not yet implemented — so filling in only the token still won't make it run" (`adapters/modal.ts:156`). **This is the right call**: for an adapter that has never connected to a real service, any wording that makes it "look usable" would mislead release materials.
>
> The accurate statement of constraint one should be: **"once the real gateway is implemented in the future, enabling it must require no compile-time changes"** — this part has already been achieved this wave and is gate-checked. "Fill in the token and it just works" only becomes true once the real gateway lands; see `docs/devlog/W5-2-a.md` §4 for the checklist.

**No build-time constant may participate in the "can Modal be used" decision inside the adapter** — the decision must come only from reading configuration at runtime. Negative control: change the decision to read a compile-time constant → the test must fail.

**Constraint two: when no token is configured, the reported status must be "not configured" — neither "unavailable" nor "available."**
Both `doctor` and `capabilities --json` must honestly report `credentialConfigured: false` (the field already exists in §2.11), and must provide **configuration guidance** (a quality requirement from V36).

- Reporting "unavailable" is wrong: the capability is present, it's just missing credentials — a different situation from `openmm` not being installed;
- Reporting "available" is even more wrong — that's exactly the shape AD-12 explicitly forbids, and this very wave just fixed V34 and the binary's "0 skills" for the same reason.

**Constraint three: the fake gateway must never become a permanent stand-in.**
Using a fake gateway to pass contract tests in the recording layer is **meant to get the contract established first** — it is not an implementation of Modal. So `modal.ts` must carry an explicit entry, in `ALLOWED_ORPHANS` or an equivalent location, reading "**awaiting real recording**: once a token is obtained, a real gateway recording must be made and this entry deleted" — the same discipline as W5-1 α's "awaiting wiring." **Without this registration, the fake gateway will live on into the release.**

### The messaging for external materials

The v0.5.0 release **must not** claim to "support Modal remote compute." The accurate statement is: **the compute abstraction layer and the approval chain have landed, with a local implementation; the Modal adapter's contract is established, but its real pathway is unverified.** (This follows the same discipline as v0.4.0's honest disclosure of three unclosed items at release time.)

---

## 3 (supplement.8): W5-3 lane assignment and footprint verification (main session, 2026-09-10)

> §3.3's original table was written before W5-2. It is rescheduled here based on **two events
> that have since occurred**: ① the output of the zero-context external acceptance review at the
> end of W5-2; ② V45 (external MCP runtime wiring) being identified as its own lane.

### Supplement.8.1 The second batch of connectors (formerly γ) is **cancelled** — this is the proposal's own rule taking effect

§3.3's condition for W5-3 γ was "**only opens if F-1 or the W5-2-end external acceptance review calls for it; otherwise this lane stays empty**."

The W5-2-end review **did not ask for more literature sources**. What it asked for was: getting compute output into the evidence graph (S2), being able to view raw records (S11), and not leaving the report's evidence index empty (S10). **So the second batch of connectors does not open** — not because it was forgotten, but because the criteria say it shouldn't. The whole reason this rule exists is to prevent a repeat of v0.4's scope creep (proposal §2).

The freed-up slot goes to two **more valuable** items instead: V45 and "evidence-graph visibility."

### Supplement.8.2 Four lanes

| Lane | Contents | Model |
|---|---|---|
| **α** | The CB-6 bridge + **S2 (getting compute output into the evidence graph)** + the real SIGKILL e2e | Opus |
| **β** | C3 three-platform bundle (scanpy / pydeseq2 / cobrapy) | Opus |
| **γ** | **V45**: external MCP runtime wiring (subprocess lifecycle) | Opus |
| **δ** | **Evidence-graph visibility**: S10 / S11 / S12 | Sonnet |

**Why α also does S2**: the design in §1.1 already assigned "one `observation` record (`kind:"compute_output"`, `evidence:"computed"`) + one artifact record per harvested file" to W5-3 α. The acceptance review only ran into it because W5-3 hadn't run yet. **S2 is not new scope — it was already α's scope.**

**Why γ is a lane rather than close-out work**: the W5-2 close-out investigation found that `connectExternalMcp()`'s entire production path has zero callers — not because "a parameter was forgotten," but because **there is no such flow to pass it through**. What needs to be built is the complete lifecycle: discover an installed `mcp_client` extension → connect its **subprocess** when the agent starts running → register it into `ExternalToolRegistry` → bind the project's `recordSink` → tear it down at the end → **a broken extension must not be allowed to bring down the whole run**. Hand-building a subprocess lifecycle during close-out is exactly the kind of cross-layer change that engineering discipline rule 13 warns against.

**Why δ deliberately extends `report` rather than creating a new `records` namespace**: the `report` CLI already has `export`/`stats` and is already wired into `index.ts`, and `RecordStore` already has `list`/`get`/`edgesOf`/`listEdges` (read-only, which is sufficient). Extending it **eliminates three hub-file contention points in one move** (`index.ts` · `narrative_parity.test.ts` · a new command's "awaiting wiring" registration), and evidence-graph inspection already belongs semantically under `report` anyway.

### Supplement.8.3 Footprint verification (verified by actual grep, not from memory)

| File | α | β | γ | δ | Disposition |
|---|---|---|---|---|---|
| `backend/src/compute/sim_bridge.ts` (new) | ✅ | | | | Exclusive |
| `backend/src/compute/{cli,broker}.ts` | ✅ (S2 writes the record) | | | | Exclusive |
| `backend/src/experiment/{loop,models,cli}.ts` | ✅ | | | | Exclusive |
| `backend/src/server/routes/experiments.ts` | ✅ | | | | Exclusive |
| `backend/src/mcp/tools.ts` | ✅ (adds `target` to `exp_design`) | | | | Exclusive |
| `backend/src/simulation/registry.ts` + the three new platforms | | ✅ | | | Exclusive (α's bridge only reads it, §1.1.9) |
| `backend/src/skills/**` · `docs/EXTENDING.md` · `pyproject.toml` | | ✅ | | | Exclusive |
| `tests/unit/narrative_parity.test.ts` | | ✅ (three SKILL_ENTRYPOINTS lines) | | | **Exclusive to β**; γ doesn't need it (`mcp_client.ts` already has a production caller, so it isn't an orphan — verified); δ doesn't need it (extends `report`, no new entry point) |
| `backend/src/extensions/{loader,mcp_client}.ts` | | | ✅ | | Exclusive |
| `backend/src/daemon/daemon.ts` · `server/context.ts` · `index.ts` | | | ✅ | | **Exclusive to γ** — δ no longer needs `index.ts` now that it extends `report` instead |
| `backend/src/agents/orchestrator.ts` | | | ✅ | | Exclusive (α doesn't touch it) |
| `backend/src/report/{cli,export}.ts` | | | | ✅ | Exclusive |
| `backend/src/project/records.ts` | Read-only | | | Read-only | **Nobody writes to it** — α uses the existing `create()`, δ uses the existing query API |
| `backend/src/artifacts/store.ts` | Read-only (calls `save()`) | | | | Nobody writes to it |

**Conclusion: zero contention.** Compared with W5-1/W5-2, this round's footprint is unusually clean, mainly thanks to δ's decision to extend `report`.

### Supplement.8.4 Three lessons this round's task briefs must carry

1. **Baseline numbers must be measured for real before being written into a task brief** (a W5-1 lesson: when a new worktree is missing `.venv`/`node_modules`, the Python suite **doesn't error — it silently turns into a skip**, and a lane will measure against a fake baseline). Pre-install dependencies once the worktree is built, and spot-check them.
2. **A lane doing cross-layer changes must be explicitly required in its task brief to run e2e** (a W5-1 lesson: δ's footprint had no `tests/e2e/` in it, and V25's associated regression wasn't caught until close-out). Both α and γ are cross-layer this round.
3. **A single lane's gate checks cannot see "the same thing hand-copied twice" across parallel lanes** (a V46 lesson: Modal credential field names didn't match up). This round, both α and δ will touch "what compute output looks like in the evidence graph" — **the task briefs must pin down the record's `kind` / `evidence` literals exactly, and require both lanes to import them from the same place**.
