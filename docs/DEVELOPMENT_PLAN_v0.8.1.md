# Spark Research v0.8.1 Remediation Plan (Draft v1)

> Baseline: `main` @ `644cccd`, tag `v0.8.0` (2026-09-12).
> Trigger: full source-level external review, `spark-research_v0.8_review.md` (2026-09-13), cross-checked against OpenScience v2.0.77.
> Scope: a **patch-level hardening release**. No new functional domains, no physical lab hardware, no billing/sales — consistent with the v0.8 charter.
> Every finding below has been independently re-verified against `main` (`file:line` evidence) before being registered; none are taken from the review at face value.
>
> **Documentation language note**: this is the first planning document in this project written entirely in English, per a project-wide decision (2026-09-13) to stop adding Chinese to planning/backlog artifacts going forward. Historical Chinese planning documents (`DEVELOPMENT_PLAN.md`, `DEVELOPMENT_PLAN_v0.3.md`–`v0.8.md`, `DESIGN.md`, `BACKLOG.md`, `taskbooks/`) are being translated to English as a separate, parallel workstream — see `docs/reviews/i18n_translation_log.md` (created alongside this plan) for status. Source-code comments, `CHANGELOG.md`, and `docs/devlog/*` are out of scope for translation unless the user asks otherwise.

---

## 0. One-line verdict and locked decisions

**v0.8.0 closed out the v0.6 external review's P0/P1 backlog and is honest about what's left. The review's own diagnosis holds up under re-verification: the data/evidence layer is ahead of the runtime layer.** Ten of its Top-10 items are real, reproducible, and none require new product surface — they are bugs and gaps in code that already exists. This plan sequences them into one patch release plus one explicit open decision.

| Decision | Content | Owner |
|---|---|---|
| Release shape | v0.8.1 = patch only: timeouts, token-gate parity, resource-leak fixes, CI coverage, sandbox-narrative correction. No new record types, no new connectors/skills. | This plan |
| Physical hardware | Still out of scope (per v0.8 charter). Wet-lab items here are corrections to safety-gate *narrative accuracy*, not new hardware integration. | Unchanged from v0.8 |
| Orchestrator dead code (#1 below) | **Not decided in this plan** — genuine product call between "wire into production" (scope-expanding, effectively a feature) and "delete + downgrade narrative" (safer, smaller). Presented as an open decision in §3. | **User** |
| Numbering discipline | Before registering, checked `docs/BACKLOG.md` + all remote branches for the highest existing `V` number: **V133**. New entries start at **V134**. | Continuing v0.7/v0.8 discipline |

---

## 1. Baseline gate

| # | Check | Criterion |
|---|---|---|
| 0-1 | Working tree clean on `main` @ `v0.8.0` before branching | Verified 2026-09-13: `git status --short` empty |
| 0-2 | Six-suite baseline recorded in the first PR description ("only grows") | Pull current `unit`/`e2e`/`concurrency+timeout`/`py`/`lab` counts before first commit |
| 0-3 | Each new worktree: `bun install` + venv relink + `test:py` run with zero skips | 0 skip |

---

## 2. Gate H — safety & robustness hardening (serial, one PR per item, tag `v0.8.1-alpha.1` on completion)

These are small, independent, high-value fixes. Serial on the main worktree — no lane split needed; the batch is too small to justify parallel worktrees and several items touch the same files (`llm/router.ts`, `llm/providers/*`).

| # | Backlog ID | Item | Evidence (re-verified) | Fix | Negative control |
|---|---|---|---|---|---|
| H-1 | **V134** | LLM timeout does not cover streamed/body reads | `llm/providers/anthropic.ts:278-303` and `openai_compat.ts:207-228`: the `AbortController` timer is cleared in a `finally` block immediately after `fetch()` resolves; `consumeStream()` (`anthropic.ts:372`) and `response.json()` run afterward with no timer at all. A 200-OK response that then hangs mid-stream or mid-body wedges the agent indefinitely — the single most dangerous item in the review. | Keep the abort controller alive (or start a second timer) across `consumeStream()`/`response.json()`, not just across the initial `fetch()`. Apply to both providers. | Unit test: mock a `Response` whose body stream never closes; assert the call rejects with a timeout error within `timeoutMs`, not indefinitely. |
| H-2 | **V135** | HTTP `compute approve/reject` has no one-time approval token, asymmetric with `lab` | `server/routes/compute.ts:235-283`: `approve`/`reject` call only `requireActor(body)` — any local process can `curl` a fabricated human approval. Contrast with `server/routes/lab.ts` (V95, already fixed): `approve`/`simulate` require `requireApprovalTokenValue()` + `consumeApprovalTokenOrThrow()`, a one-time token minted by `spark-research lab token <id>` at a TTY gate. | Extend the same one-time-token gate (`lab/approval_token.ts` generalized, or a sibling `compute/approval_token.ts`) to `compute approve`/`reject`. Dispatch already requires CLI TTY (AD-14 depth), so spend is not directly exposed, but the approval *record* itself should not be forgeable. | Unit test: `POST /jobs/:id/approve` without a token → 403; with a valid single-use token → 200, second use of same token → 403. |
| H-3 | **V136** | HTTP `lab /reject` has no one-time token (unlike `/approve`) | `server/routes/lab.ts` (reject handler, ~L246-266): calls `requireActor(body)` + `requireString(body, "reason")` only — no `requireApprovalTokenValue`/`consumeApprovalTokenOrThrow`, while the sibling `/approve` handler at the same file requires both. | Add the same token requirement to `/reject` that `/approve` already has. | Unit test: reject without token → 403. |
| H-4 | **V137** | `retryable` error flag is declared but never consumed — no retry path exists anywhere | `llm/types.ts:44,105,154` define and set `retryable`; `grep -rn retryable backend/src/llm/router.ts` finds only the *setter*, no reader, and no loop/backoff logic exists in `router.ts`. Every transient failure (timeout, 5xx, rate limit) propagates straight to the caller. | Add one bounded retry with exponential backoff + jitter in `router.ts`, gated strictly on `retryable === true`; must not retry non-idempotent side effects (nothing in the LLM call path is non-idempotent, so this is safe). Cap total added latency. | Unit test: mock adapter returns `retryable:true` failure once then succeeds → caller sees success; mock returns `retryable:false` → no retry attempted, single call only. |
| H-5 | **V138** | `orchestrator.ts` `projectCache` grows unbounded in a long-running server | `orchestrator.ts:278` (`private projectCache = new Map<string, Project>()`), `:626-629` (`.get`/`.set` only — no `.delete` anywhere in the file). A long-lived HTTP/MCP server accumulates one entry per distinct `sessionId` forever. | Add eviction: either an LRU cap, or delete-on-session-end if session lifecycle is already tracked elsewhere (check `daemon/daemon.ts` for existing session teardown hooks before adding a new one). | Unit test: drive N distinct sessions through `projectForSession()`, assert cache size does not exceed the cap. |
| H-6 | **V139** | `raw/sink.ts` busy-waits with `Bun.sleepSync(5)` and re-reads the file tail synchronously on every append | `raw/sink.ts:170` (`Bun.sleepSync(5)` inside a lock-wait loop), `readLastHash`/`readTail` (synchronous read on every append/verify). | **Investigated, not fixed — downgraded after finding a real architecture conflict, not implemented as originally scoped in this row.** `RawSink.append()` is *deliberately* synchronous per the file's own header comment (two of the four call sites are in `finally`/wrapper return paths; sync semantics make "was it recorded" independent of promise-settlement ordering) — making it non-blocking requires converting the whole interface to async, touching all 4 call sites, `MemoryRawSink`, and a lot of tests. That's a dedicated migration, not a Gate H item, and this plan does not attempt it. Separately, the "cache the tail offset" mitigation originally proposed here turned out to be wrong: the per-append disk re-read of the last hash is not an oversight — it is **the V91 fix** for multi-process hash-chain corruption (server + CLI appending to the same file), and removing it would reintroduce that bug. `Bun.sleepSync` is also already the correct blocking-sleep primitive (not a CPU-spinning loop), so there is no narrower fix that keeps the sync contract and avoids blocking during genuine lock contention. Practical severity is lower than the finding reads: JS's single-threadedness means two `append()` calls can never race *within* one process, so the lock/sleepSync path only fires under genuine cross-process contention — rare and brief in this product's actual usage pattern. Full writeup in `docs/BACKLOG.md` V139. | N/A — no code change made for this item. |
| H-7 | **V140** | `PythonKernel` JSON.parse of kernel stdout line is unguarded | `kernels/manager.ts:195`: `const parsed = JSON.parse(line);` with no try/catch. Any native extension that writes to stdout out of protocol (not just malformed extensions — any print-debugging left in third-party code) throws an unhandled exception and desyncs the line protocol for the rest of the kernel's life. | Wrap in try/catch; on parse failure, treat as a protocol violation: log the offending line (truncated), and either resync (skip to next well-formed line) or kill+restart the kernel (reuse the existing `killAndReset()` path). | Unit test: feed a non-JSON line into the kernel's stdout mock → assert kernel recovers (via reset or resync) rather than crashing the caller. |
| H-8 | **V141** | CI runs only `unit` + binary smoke; `concurrency`, `timeout`, `integration`, `e2e`, `sdk` suites never run in CI, and `package.json` has no `test:concurrency`/`test:timeout` scripts | `.github/workflows/ci.yml`: only `bun test tests/unit` and `bash scripts/smoke-binary.sh`. `package.json:28-36`: scripts exist for `test`, `test:integration`, `test:lab`, `test:py`, `test:e2e`, `test:sdk` — but no `test:concurrency` or `test:timeout`, and none of `integration`/`e2e`/`sdk`/concurrency/timeout are wired into the workflow. | **Done, but narrower than originally scoped — investigation changed the plan.** Added `test:concurrency`/`test:timeout` npm scripts and wired `concurrency`, `timeout`, `lab` (pytest, zero heavy deps), and `e2e` (Playwright, fixture-server-backed, no real credentials, ~21s locally) into CI. **Did not** wire in `test:sdk` (2 pre-existing, order-dependent failures found during this work — new item **V148**, would make every PR's CI red for a pre-existing bug unrelated to this plan), `test:integration` (`describe.skipIf(!RECORDING)` — always 0 executed assertions without real network credentials; wiring it in would be pure "green theater," not a real gate), or the full `test:py` (needs the heavyweight opentrons/scanpy/pydeseq2/cobra install, a dedicated CI-infra investment out of scope for a Gate H item — `tests/lab`, which needs none of that, is wired in instead). | CI green on the PR that adds it (verified locally: all four newly-wired suites pass — concurrency 33/33, timeout 4/4, lab 26/26, e2e 25/25). |

**Exit criterion for Gate H**: seven of eight items merged to `main` (H-6/V139 investigated and deliberately not implemented — see its row above and `docs/BACKLOG.md` V139), six-suite baseline count only grows, tag `v0.8.1-alpha.1`, `gh release create` run before the tag per the standing v0.7.0-incident rule.

---

## 3. Open decision required from the user — orchestrator dead code (V142)

**Do not resolve this in-plan; the review is explicit that it's a product call, not an engineering one.**

- **Finding**: `agents/orchestrator.ts:1097` (`runResearchLoop`) and `:1217` (calls into `agents/replan.ts:188` `runReplanLoop`) are only invoked from `tests/unit/orchestrator.test.ts`, `tests/unit/replan.test.ts`, and `tests/unit/narrative_parity.test.ts`. Re-verified with a repo-wide grep excluding `.test.ts` files: **zero production callers**. The production path (`index.ts` → `chat`/`processRequest`) never calls `runResearchLoop`. This means the "contract-completion-driven research loop + replan" behavior described in `DESIGN.md`/`CHANGELOG.md` does not run in any shipped code path.
- **Why it slipped through AD-12** (machine-checkable capability claims): the existing gate (`narrative_parity.test.ts`) checks capability claims at *file* granularity — "does this module exist and get referenced somewhere" — not at *symbol* granularity — "does this exported function have a production caller." A file can be fully wired into imports (`orchestrator.ts:65` imports `runReplanLoop`) while the specific exported entry point it wraps is never reached from `chat`.
- **Two options, not mutually exclusive with sequencing**:
  1. **Wire it into the production `chat`/`processRequest` path.** This is the "close the gap" option — it makes the DESIGN.md/CHANGELOG claim true. It is realistically **not a v0.8.1 patch item**: it means deciding when a chat turn should hand off to the contract-completion loop vs. the current single-shot `chat → processRequest`, and that decision touches the core agent loop that the review itself flags as the thinnest, most-in-need-of-care layer in the codebase. Recommend scoping as its own v0.9 lane with a dedicated taskbook, not squeezed into a hardening patch.
  2. **Delete `runResearchLoop`/`runReplanLoop` from the production module and downgrade the narrative.** Smaller, safer, immediately shippable in v0.8.1. Requires: removing the dead code, moving the design intent (if still wanted for later) from "implemented" to "considered, not built" language in `DESIGN.md`/`DEVELOPMENT_PLAN` history, and deleting the now-pointless unit tests that only exercise dead code (or keeping them if the code moves to an explicitly-labeled experimental module not claimed as production).
- **This plan's recommendation** (non-binding): option 2 for v0.8.1, because it's the only one compatible with a patch-scope release; revisit option 1 as a deliberately-scoped v0.9 item if the contract-completion behavior is still wanted. But this is the user's call, not an engineering default.

Register whichever direction is chosen as **V142** in `BACKLOG.md` with the decision date and rationale, per project convention (every backlog row needs a disposition, not just a description).

**Companion gate fix (V143)**, independent of the decision above: upgrade the AD-12 gate itself so this class of gap cannot recur silently. Today's file-level check should gain a symbol-level check: for a designated set of "must have a production caller" exports (starting with anything `DESIGN.md`/`CHANGELOG.md` describes as an implemented, shipped behavior), assert a static-analysis or runtime-coverage signal that the production entrypoint (`index.ts` → `chat`/HTTP routes → ...) actually reaches it. This does not need to be a general dead-code detector — scope it to the specific claim surface (files whose exports are referenced in `CHANGELOG.md`'s "done" language), matching the project's existing "capability claims must be checkable" pattern rather than building a generic tool.

---

## 4. Deferred to the hardware-integration gate (not v0.8.1, tracked here so they aren't lost)

Both items are pre-conditions for connecting a real Opentrons device — out of scope while v0.8's "no physical hardware" charter holds, but worth registering now since the review found them independently of any hardware work in flight.

| Backlog ID | Item | Evidence | Note |
|---|---|---|---|
| **V144** | `ControlRepl` is not a sandbox; `AD-2` ("kernel never gets credentials") is an API-discipline convention, not an isolation boundary | `kernels/control_repl.ts:3,28-69`: `new Function(...)` executes at the same UID as the host process. `makeRequire()` restricts only the `require()` shim to `ALLOWED_MODULES = [json, os, sys, pathlib, datetime, uuid]` (`control_repl.ts:3`) — it does **not** restrict `process`, `globalThis`, `Bun`, or `Function.constructor`, all of which are reachable from inside the sandbox closure and give same-UID code execution one line away from the module allowlist. | Two paths: (a) narrative correction now — state plainly in `DESIGN.md`/`SECURITY.md`-equivalent docs that AD-2 is a discipline, not a security boundary, so nothing downstream relies on a false isolation guarantee; (b) real isolation (container, separate UID, or a proper JS sandbox like `isolated-vm`) before any real Opentrons connection. (a) is cheap and should happen regardless; (b) is real work and belongs to the hardware-integration gate, not v0.8.1. |
| **V145** | `Host` header is not validated; only `Origin` is, despite comments claiming both, and `Origin` allows any `localhost` port unconditionally | `server/app.ts:84-135` (Origin-only allowlist logic, deliberate per the inline rationale about browsers always sending `Origin` on cross-site writes) vs `:167-185`. The code's own design rationale for skipping `Host` is not written down next to the check — worth confirming the comment/doc claim ("Origin/Host dual check") is actually stale narrative rather than a missed check, and either implement the `Host` check or correct the doc to describe what's actually enforced. Low urgency: service binds to `127.0.0.1` only today. | Narrative-vs-implementation alignment, same genus as V142/V143 — cheap to fix in v0.8.1 as a doc correction; add the real `Host` check only if/when the server binds beyond loopback. |
| **V146** (already partially tracked as V25/V59) | Wet-lab safety-gate coverage gap: `concentration_limit`/`biosafety` rules only match same-sentence phrasing, not cross-sentence references (the most common real phrasing) | Referenced in review §2.2 and §10.2 item 8; cross-check against existing `V25`/`V59` rows in `BACKLOG.md` before re-registering — if those already cover this exact gap, annotate them rather than duplicating. | Hard prerequisite before any real Opentrons connection, independent of v0.8.1. |

---

## 5. Ongoing / no action in v0.8.1

- **V147** Retrieval recall (8/24 across T1–T4, R5 real-network run) — already tracked under V67/V86; no new registration, this plan just confirms the review's number matches the existing R5 record and doesn't indicate regression.
- Remote compute (Modal contract-only, no real gateway) — unchanged, blocked on user-provided Modal token per existing backlog rows (V4).
- Extension scaffolding covering 3 of 6 documented extension points — already an acknowledged gap (`scaffold/cli.ts:36` and the docs' own admission); no new finding, not re-registered.

---

## 6. Sequencing summary

```
main @ v0.8.0
   │
   ├─ Gate H (serial, one PR each) ────────────────────────► tag v0.8.1-alpha.1
   │        H-1 LLM stream timeout                    [done]
   │        H-2 compute approve/reject token parity    [done]
   │        H-3 lab /reject token                      [done]
   │        H-4 retryable backoff                       [done]
   │        H-5 projectCache eviction                   [done]
   │        H-6 raw/sink async lock                     [investigated, not fixed — architecture conflict, see row above]
   │        H-7 PythonKernel JSON.parse guard
   │        H-8 CI suite coverage + npm scripts         [done, narrower scope — see row above; new V148]
   │
   ├─ User decision on V142 (orchestrator dead code) ─────► V142 disposition registered
   │        + V143 AD-12 symbol-level gate (independent of the decision, do regardless)
   │
   ├─ Narrative corrections (cheap, do in v0.8.1) ────────► V144(a), V145
   │
   └─ release: v0.8.1 (patch — bug fixes + hardening only, per SemVer/trunk-based scheme)
```

V144(b) (real ControlRepl isolation) and V146 (safety-gate cross-sentence coverage) move to the hardware-integration gate, not this release.

---

*This plan supersedes no prior `DEVELOPMENT_PLAN_v0.8*.md` content — it is additive, covering only what the 2026-09-13 external review found on top of the already-shipped v0.8.0. All file:line citations in this document were re-verified against `main`@`644cccd` on 2026-09-13, independent of the source review's own citations.*
