# Spark Research v0.8 Development and Testing Plan (Finalized v1)

> Finalized: 2026-09-11 PDT · Baseline: main @ v0.7.0 (`f23c19b`, PR #80; dual-platform Release binaries already attached)
> **Execution mode: the user drives continuous auto-advance at an adaptive pace via `/loop`** (same as v0.6), reporting a segment of progress at each wake point; the main session holds sole merge authority.
> User decided on 2026-09-11: **v0.8 = the next major version; all currently discovered, actionable backlog items go in; physical devices and sales are out of scope.**
> Upstream documents: `docs/DEVELOPMENT_PLAN_v0.7.md` (§7·Addendum execution orchestration carried forward) · `docs/DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md` · `docs/reviews/v0.6.0_external_review.md` · `docs/BACKLOG.md`

---

## 0. One-line summary and locked-in decisions

**v0.7 left the data behind; v0.8 patches the hard money-and-permissions flaws, clears out the 27 to-dos unearthed by three review passes and an external review, and builds the runtime contract + Python SDK that has been deferred twice since v0.5 — what ships is a version with no known security/budget holes that external agents can integrate with directly.**

| Decision item | Content | Decided by |
|---|---|---|
| Version positioning | Major version; scope = all actionable real BACKLOG items (27) + SDK/contract (a roadmap item carried forward) + V2 embedding semanticization | User, 2026-09-11 |
| Explicitly out of scope | **Physical Opentrons and any real-device path** (V6 / V52 domain judgment / the hardware half remaining in V59) · **sales channel, billing, license text** (the interface shape was already left in place in v0.7) · 3D viewer · multi-user identity (V10) · real Modal gateway (V4, unless the token arrives) · skill/connector rollout (V76 only names ≤2–3 per R5) · R kernel (V5) · CNKI/Wanfang (D3) · materials platform (D1) | Same as above |
| V95 (HTTP approval bypass) | **Do the software half**: HTTP `lab approve/simulate` goes through the same signature + confirmation-token gate as the CLI, no longer a bypass; **no device integration** | Decided in this plan |
| V2 (embedding) | Use the **embedding endpoint of an already-configured provider** (OpenAI-compatible `/embeddings`; any of OpenRouter/OpenAI/DeepSeek works as long as a key is present); with no key, keep the lexical-matching method as the fallback path, with dual-logging (AD-8); no Ollama dependency introduced | Decided in this plan (a narrowed version of the v0.5 design draft) |
| Empirical feedback loop | **R5**: full rerun of all four topics (OpenAlex with the polite pool) to produce T1–T4 recall numbers; **A7** the sixth zero-context acceptance review (browser + spending money + export + SDK, all in one pass) | Proposed in this plan |
| Per-round budget | $2/topic; product-side model stays glm-5.3-flash; in R5 at least one topic runs the judge on a second provider (prerequisite for closing V12) | Carried forward |
| PR / versioning discipline | Authorized auto squash-merge (all six suites green + self-review); no direct pushes to main; verify the remote ref after pushing; **smoke tests do not enter the pipeline** (`> log; test $? -eq 0`); one alpha tag per wave, every tag must have a CHANGELOG section; **run `gh release create` before cutting the formal tag** (the v0.7.0 incident) | Carried forward + two new rules |
| Numbering discipline | Before registering a new BACKLOG entry, run `git grep -h "^| V" $(git branch -r) docs/BACKLOG.md` to get the highest number across all remote branches (the v0.7 number-collision incident) | New |

---

## I. Baseline gate (Step 0, does not start work)

| # | Check | Acceptance criterion |
|---|---|---|
| 0-1 | All six suites green on v0.7.0, with counts recorded | unit ≥ 2271 · e2e 20 · concurrency+timeout 31 · py 73 · lab 26; written into the first PR description as the "only increase, never decrease" baseline |
| 0-2 | Binary smoke test exit 0; both Release v0.7.0 assets present | — |
| 0-3 | For every new worktree: chain `.venv` + `bun install` + actually run `test:py` and check the skip count | 0 skips |
| 0-4 | `tests/preload.ts` isolation is effective: `test_isolation` green; after one unit-test run, `~/.spark-research/raw` doesn't exist or has zero new entries | V83 does not recur |
| 0-5 | `contactEmail` already configured (`config list`); AMiner key valid through at least the planned date of the R5 Chinese round (expires 10-07) | Otherwise schedule the Chinese round first |
| 0-6 | BACKLOG reconciled: R1/R3/S12/V57 marked ✅ (already resolved in fact); V83 marked archived done; add a v0.8 row to the disposition master table | Already done in this plan's PR |

---

## II. Gate G (foundation, main session, serial; each item its own PR, once merged → `v0.8.0-alpha.1`)

Clear the hard security and money flaws first — they touch the shared layer every lane will touch, and only once they're all done in series do the waves start.

| # | Item | Deliverable | Gate check / negative control |
|---|---|---|---|
| G-1 | **V100** compute uploads' `workspaceRoot` accepts arbitrary absolute paths | Only accept relative paths under `dataDir()`/the project directory; absolute paths and `..` are always rejected with a readable error; the quota check is moved to before the disk read | Unit test: `/etc` / `../../` are rejected; negative control: remove the validation → red |
| G-2 | **V101** extensions `--trust` fingerprint only covers the single entry file | Fingerprint = a hash of the extension directory manifest (relative file path + content sha256, sorted then hashed); an old single-file fingerprint is treated as stale and requires re-trust | Unit test: modifying a helper file → fingerprint changes; negative control: revert to single-file fingerprinting → red |
| G-3 | **V93** budget-gate TOCTOU | `BudgetLedger` introduces **in-flight reservation**: reserve at the model's price ceiling before the call (`reserve`), settle at the actual cost after it returns (`settle`); under `Promise.all`, the sum of N in-flight calls does not exceed the gate | `tests/concurrency/budget_inflight.test.ts`: 10 concurrent calls, gate at $0.1, $0.03 each → at most 3 admitted; negative control: remove the reservation → red |
| G-4 | **V94** an unpriced model silently disables the budget gate | Missing price-table entry → the call is **not admitted** (not admitted-as-unknown); `--allow-unpriced` explicitly admits it and marks usage as `unpriced`; the Anthropic price table is filled in (check the official prices, record the source and date) | Unit test: unpriced model rejected by default + explicit admission, two cases; negative control → red |
| G-5 | **V96** non-atomic write to state.json | `writeState` changed to temp + rename (same directory, same fs); shares the same critical section as C-1's lock | Unit test: simulated kill (a half-written tmp file doesn't affect the main file); negative control: revert to a bare writeFileSync → detected |
| G-6 | **V21** remove the old timeout env-var name (a v0.7 commitment) | Reading the old name now errors and points to the new name; docs/INSTALL kept in sync | Unit test |

---

## III. W8-1 · Six parallel lanes (sonnet subagents, each its own worktree; once merged → `alpha.2`)

| lane | Items | Delivery highlights | Footprint (owner) | Off-limits |
|---|---|---|---|---|
| **α Retrieval close-out** | V67 · V86 · V87 · V73 | With the polite pool, write the real T1–T4 recall@10 (frozen baseline) into the devlog; the `--rank` default tier set from the data; `lit review` output shows "parsed N / judged M / gap disposition (deduped x · self-citation y · parse failures z)"; write the one-off conclusion of the AMiner 401 ledger observation | `literature/search.ts` · `literature/cli.ts` (the review-output section) · `reviewer/citation_judge.ts` · `connectors/aminer.ts` | `index.ts` · `reviewer/rules.ts` |
| **β Data-layer completion** | V85 · V78 · V63 · V97 · V99 · V98 | Simulation prepare/submit/collect lands in raw as `kind=simulation` (add a category to the raw contract, keep export/import/validation in sync); `subAgentLlm()` goes through `usageTrackingLlm` (sessionId passed through); `ratelimit.ts` returns the wait time in milliseconds, api_calls actually recorded; usage `model` field validated (reject writing an object); LLM ledger write failures don't swallow the output (same treatment as api_ledger) + unify the billing accounting for auth/rate_limit; `basis/basisReason` on close-reading cards is read back into `cardFromRecord`, so the review prompt and the judge can access material-level information | `raw/*` · `simulation/*` · `agents/orchestrator.ts` (subAgentLlm) · `http/ratelimit.ts` · `usage/*` · `literature/reading.ts` (cardFromRecord) · `data/*` (simulation-category export) | `index.ts` · `literature/cli.ts` · `project/*` |
| **γ Experience** | V88 · V89 · V90 · V79 | Close-reading task progress is reported back per paper (check runCliTask batching); co-explore produces two cards at once: either dedupe or the UI states "primary/backup hypothesis"; the project dropdown shows the slug; three low-severity A5 items (a review-citation span jumping to the evidence graph · a conclusion-review upfront prompt · a UI entry point for budget parameters) | Frontend components · `server/routes/*` (pass-through only) · `cli/progress.ts` · `ideation/coexplore.ts` (dedup logic) | `index.ts` · `literature/*` · `project/*` |
| **δ Citation verification** | V92 · V13 · V14 · V51 | `CITATION_TOKEN` character set includes Chinese characters and both verification gates take effect on Chinese keys (negative control: a forged citation with a Chinese key must be caught); V13 uses real samples from R1–R4 to decide the criterion and either revise the prompt or explicitly close it; position-weighting exemptions changed to a whitelist scheme; helpers like `probeCodeFor` are moved up to the top level of `simulation/`, consolidating three inline probing sites into one | `reviewer/rules.ts` · `reviewer/citation_judge.ts` · `reviewer/agent.ts` · `agents/prompt/*` · `simulation/probe.ts` (new) · `doctor/*` (probing reuse) | `index.ts` · `literature/cli.ts` · `raw/*` |
| **ε Wet-experiment software half** | V95 · V55 · V59 residual | HTTP `lab approve/simulate` goes through the same gate as the CLI: an explicit `actor` + a one-time confirmation token (server-issued, single-use, short-lived), rejected without a token — **no device integration**; English protocol parsing (bilingualize the step parser, since the vocabulary is already bilingual); four of V59's five software items: the limit-table coverage disclosure is printed on the `lab compile` screen, `biosafety` recognizes `P3 实验室` (P3 laboratory), the `chemical_compatibility` message explains it doesn't look at well positions, and the `over-limit` message gives the limit/unit/next step | `lab/protocol.ts` · `lab/safety.ts` (messages and vocabulary, not the rule semantics) · `lab/cli.ts` · `server/routes/lab.ts` · `lab/approval_token.ts` (new) · frontend approval dialog (token) | `lab/wet_loop.ts` state-machine semantics · `index.ts` |
| **ζ V2 embedding semanticization** | V2 | `llm/embeddings.ts`: an OpenAI-compatible `/embeddings` adapter (using an already-configured provider key; pick one of OpenRouter/OpenAI/DeepSeek); `novelty`'s `claimAffinity()` becomes "embedding cosine similarity → lexical-matching fallback" with dual-logging (the result metadata records `affinityBasis: embedding\|lexical`); thresholds re-labeled using the 68-sample fixture (same method as `novelty_threshold.test.ts`); with no key, behavior is byte-for-byte identical to v0.7 | `llm/embeddings.ts` (new) · `llm/providers/*` (embedding capability flag) · `ideation/novelty.ts` (affinity, one spot) · `tests/fixtures/novelty/*` | `index.ts` · `usage/*` (embedding spend is wrapped through the existing usageTrackingLlm, no separate ledger) |

The shared discipline from v0.7's `_COMMON.md` carries forward (one lane per worktree · mutually exclusive footprints · all six suites + negative controls actually run · concurrency-timeout test cases rerun individually · no merging into main).

**W8-1 close-out** (main session): merge review does not trust self-reported numbers; CHANGELOG/BACKLOG reconciled; V102's external-review miscellany is **split item by item** into independent numbers or explicitly marked as not-doing; `alpha.2`.

---

## IV. W8-2 · runtime contract + Python SDK (main session + 1 lane; once merged → `alpha.3`)

The external integration surface that has been deferred twice since v0.5. **Principle: the SDK is a thin projection of HTTP/MCP (AD-7), adding no new capability; the contract is a versionable subset of `capabilities --json`.**

| Item | Deliverable | Gate |
|---|---|---|
| runtime contract | `spark-research contract --json`: version number, CLI commands and flags (structurally extracted from the `index.ts` switch and each HELP structure, not hand-written), HTTP routes and request/response schemas (generated from the Hono routes and `server/types.ts`), MCP tools, data-export manifest schema, config items; `contract.json` is attached as a Release asset | **Gate**: the contract is diffed against the source of truth — the CLI case set, MCP_TOOLS, CONFIG_SETTINGS, and manifest types must match item-for-item (AD-12, item 10); negative control: remove one case → red |
| Python SDK (`sdk/python/spark_research/`) | Thin client: `Client(base_url)`, methods map one-to-one to HTTP routes (generated from the contract, not hand-written); long-running task handles are polled; `data export/verify/import` wrapped; type hints; `pytest` contract tests run against a fixture server | `tests/sdk/`: at least one round-trip per HTTP route; contract change → generated SDK artifact changes (an idempotency gate, same shape as llms.txt) |
| Documentation | `docs/SDK.md` + add "use the SDK instead of hand-rolling curl" to `readme_for_agent.md`; `llms.txt` kept in sync | G8 narrative-consistency |

---

## V. B3 · Empirical feedback loop and acceptance review (→ `alpha.4` → `v0.8.0`)

- **R5** (zero-context subagent): all four topics following the v0.6 per-round protocol + the v0.7 data-layer two-step + **run the SDK through the full chain end to end** (use the Python client instead of the CLI to run T2); at least one topic's judge uses a second provider (prerequisite for closing V12). Metrics table listed alongside R1–R4.
- **R5 fix window** (main session): fix P0/P1s, narrow acceptance review; `alpha.5` (if needed).
- **A7** (zero-context, a different agent): browser entry point + spending $2 + a two-step export + **SDK installed and usable out of the box** + the HTTP approval-token gate (must reject without a token) + the concurrency budget gate (10 concurrent paid calls must not exceed the gate).
- Close-out: CHANGELOG release section (highlights / honest disclosure / numbers / installation) · full BACKLOG table reconciled · **run `gh release create` before cutting the tag** · smoke test exit 0.

---

## VI. Lane footprint master table (one owner per file)

| File/directory | Owner |
|---|---|
| `backend/src/index.ts` · `docs/` · `README*` · `llms*.txt` · `CHANGELOG.md` · `BACKLOG.md` | Close-out (main session) |
| `compute/uploads*` · `extensions/fingerprint.ts`/`verify.ts` · `llm/budget.ts` · `usage/ledger.ts` (G-3/G-4 portion) · `project/manager.ts` (G-5) · `config/index.ts` (G-6) | Gate G (main session, serial, ahead of the lanes) |
| `literature/search.ts` · `literature/cli.ts` (the review-output section) · `reviewer/citation_judge.ts` · `connectors/aminer.ts` | α |
| `raw/*` · `simulation/*` (except probe) · `agents/orchestrator.ts` (subAgentLlm) · `http/ratelimit.ts` · `usage/*` (after Gate G merges) · `literature/reading.ts` (cardFromRecord) · `data/*` | β |
| Frontend components · `server/routes/*` (pass-through) · `cli/progress.ts` · `ideation/coexplore.ts` | γ |
| `reviewer/rules.ts` · `reviewer/agent.ts` · `agents/prompt/*` · `simulation/probe.ts` (new) · `doctor/*` | δ |
| `lab/protocol.ts` · `lab/safety.ts` · `lab/cli.ts` · `server/routes/lab.ts` · `lab/approval_token.ts` (new) · frontend approval dialog | ε |
| `llm/embeddings.ts` (new) · `llm/providers/*` · `ideation/novelty.ts` · `tests/fixtures/novelty/*` | ζ |
| `sdk/python/*` · `backend/src/contract/*` (new) · `tests/sdk/*` | W8-2 |

Conflict points and how they're handled: `usage/ledger.ts` is modified and merged by G-3/G-4 first, and β then branches off alpha.1; `literature/reading.ts` is touched only by β; the frontend approval dialog is touched only by ε (γ does not touch approval-related components); `server/routes/lab.ts` belongs to ε, all other routes belong to γ and are pass-through only.

---

## VII. Execution orchestration (carried forward from v0.7 §7·Addendum, only differences listed)

| Step | Executor | Model |
|---|---|---|
| Baseline gate · Gate G's six items · each wave's close-out · W8-2 contract generator | Main session | Fable |
| W8-1's six lanes · W8-2 SDK lane | Parallel sonnet subagents, each its own worktree | sonnet |
| R5 · A7 | Zero-context subagents (one each, different agents) | sonnet |
| Mechanical work (fixture recording, recall-baseline verification) | A single subagent | haiku |

Three new hard rules: smoke tests do not enter the pipeline (`> log; test $? -eq 0`) · get the highest V number across all remote branches before registering a new entry · run `gh release create` before cutting the formal tag. Everything else (worktree / actually running `.venv` to check skips / footprints / negative controls / not trusting self-reported numbers / committing wip) is unchanged.

### Time-boxing (`/loop` adaptive; if it can't all be finished, cut from the tail in order — do not thin everything evenly)

| Segment | Content | Estimate |
|---|---|---|
| One | Baseline gate → Gate G (6 independent PRs) → alpha.1 → six lanes in parallel → merge → alpha.2 | ~7h |
| Two | W8-2 contract + SDK → alpha.3 → R5 → fix window → A7 → v0.8.0 | ~6h |

Cut order: ζ (embedding) → γ's V79 → δ's V14/V51 → W8-2's SDK documentation layer. **Gate G and α/β/ε are never cut** — security, money, data consistency, and the approval bypass are the baseline for this release.

### Guardrails (hard constraints throughout)

- Every PR: all six suites green + binary smoke test exit 0; numbers only increase, never decrease
- Every gate check has at least one negative control actually run and logged in the devlog
- Spending path: R5/A7 each topic at `--budget-usd 2`, total ≤ $12 throughout; the unknown/unpriced count must be 0 (after G-4, unpriced only appears under explicit admission)
- Credentials never enter the repo/logs/reports; grep for secrets before every commit
- Quota/network interruption: a lane commits wip first (labeled "not verified in any way") and pushes to the remote; once restored, SendMessage revives the same agent; at each main-session wake point, run `git status` across all worktrees first
- Any "change made to something after it was accepted" → a narrow re-acceptance rerun (V58)

### Launch command (typed by the user in the session)

```
/loop Execute v0.8 per docs/DEVELOPMENT_PLAN_v0.8.md: start from the baseline gate, do Gate G's six items serially and cut alpha.1,
then run the six lanes in parallel, W8-2, R5, A7, through to the v0.8.0 tag. Report a segment of progress at each wake point; on a quota interruption commit wip and wait;
land all intermediate results on disk (tag/devlog/PR), no need to check with me, if it can't all be finished cut from the tail per the plan's cut order.
```

---

## VIII. v0.8.0 DONE definition (all six conditions must be satisfied)

- [ ] All six Gate G items merged, each with a negative control; 10 concurrent paid calls do not exceed the budget gate; an unpriced model is rejected by default
- [ ] Frozen-baseline recall (polite pool) for all four topics, each ≥ baseline +2 or with a mechanistic explanation; numbers go into the CHANGELOG
- [ ] HTTP `lab approve/simulate` must reject without a token (verified in A7); English protocols can compile
- [ ] `spark-research contract --json` diff-against-source-of-truth gate is green; the Python SDK runs T2 end to end (R5)
- [ ] Real BACKLOG to-dos down from 27 to ≤ 5, each remaining item has a disposition (awaiting external input / explicitly not doing / v0.9)
- [ ] A7 passes end to end (browser + spending money + export + SDK + approval-token gate), Blocker/High count at zero

## IX. Explicitly out of scope (v0.8)

Physical Opentrons and real devices · sales channel/billing/license text · 3D viewer · multi-user identity · real Modal gateway (revisit once the token arrives) · skill/connector rollout · R kernel · CNKI/Wanfang · materials platform.

## X. BACKLOG reconciliation (this release)

| Disposition | Items |
|---|---|
| **Gate G** | V100 V101 V93 V94 V96 V21 |
| **W8-1 α** | V67 V86 V87 V73 |
| **W8-1 β** | V85 V78 V63 V97 V99 V98 |
| **W8-1 γ** | V88 V89 V90 V79 |
| **W8-1 δ** | V92 V13 V14 V51 |
| **W8-1 ε** | V95 (software half) V55 V59 (four software items) |
| **W8-1 ζ** | V2 |
| **Close-out ruling** | V12 (after R5's second provider) · V102 (split up) · V42 (registered as not-doing, kept as is) |
| **Awaiting external input (unscheduled)** | V4 V5 V6 V10 V52 · D1 D2 D3 · V76 (named per R5) |
