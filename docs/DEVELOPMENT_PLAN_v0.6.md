# Spark Research v0.6 Development & Testing Plan (Final v1)

> Finalized: 2026-09-11 PDT · Baseline: main @ v0.5.0
> **Execution preconditions satisfied (verified 2026-09-11)**: tag v0.5.0 = main HEAD (20a7232, PR #38) ·
> `--version` reports 0.5.0 · working tree clean · no leftover local branches.
> Incidental finding: on GitHub, starting from v0.3.0 only tags were pushed, no Release objects were created (the Releases list stops at v0.2.1);
> whether to backfill these is for the user to decide, and it does not block v0.6.
> Location discipline: this directory is independent of the repo and GitHub and does not affect the existing working tree; the first action once execution begins is to copy this document
> into the repo as `docs/DEVELOPMENT_PLAN_v0.6.md` and put it through a PR.
> Execution mode: `/loop` at an adaptive pace, running automatically for 10 continuous hours (the user types the command when ready, see §9).

---

## 0. One-Liner and Locked-In Decisions

**v0.5 built out the full pipeline and honestly flagged every breakpoint; v0.6 lets a real user come in through the browser and walk all the way through
"literature → writing," and uses accounting data from multiple real runs to polish literature research and writing quality until it is trustworthy.**

| Decision item | Content | Decided |
|---|---|---|
| B2 topics | T1 protein structure prediction (EN) · T2 single-cell clustering (EN) · T3 brain-computer interface signal decoding (ZH) · T4 perovskite stability (ZH) | Confirmed by user 2026-09-11 |
| Per-round budget | **$2** (actual LLM spend, enforced by `maxCostUsd`) | Same as above |
| Total budget for the whole run | **$6 hard cap** (actual LLM spend within the 10 hours; once the cap is hit, stop the spending path and continue with non-spending development) | Same as above |
| LLM model | OpenRouter `z-ai/glm-5.3-flash` (effective price including 5.5% platform fee: input ~$0.0791/M · output ~$0.2638/M) | Same as above |
| Primary retrieval source | AMiner (main path for Chinese-language topics; key expires 2026-10-07, **not renewed in this release**, all Chinese-language rounds must be scheduled before expiry) | Same as above |
| PR policy | **Automatic squash-merge authorized**: merge once all tests are green and self-review passes; direct pushes to main remain disallowed; the remote ref must be verified after every push | Same as above |
| Versioning discipline | All changes iterate on the **v0.6.x line**: W6-1 close-out → `v0.6.0-alpha.1`; B2-round fixes → alpha.2/3…; A5 review pass → `v0.6.0`. Every tag must have a CHANGELOG section + devlog entry | Same as above |
| Progress reporting | **No Telegram push notifications**. ① within the session, report a progress update at every wake-up point; ② auditable on GitHub: PRs are named with the `G-x:` / `W6-1 α:` / `B2-R1:` prefixes, so the user can re-verify the merged-PR list and CHANGELOG at any time | Same as above |
| A3 (3D view) | Conditionally triggered: only built if a B2 round actually produces structural data (3Dmol.js pinned to a version, artifacts not committed to git); otherwise explicitly not done | Same as above |

Budget-scale reference: a single topic's full pipeline (10 deep-read papers + review + 2 ideas + novelty check) is estimated at ~$0.3.
R1's two topics ≈ $0.6, a full re-run of all 4 topics ≈ $1.2, both within $2. The point of the $2 gate is to **prevent runaway loops**
(the shape of the P12 `agent_run` incident), not to save money.

---

## 1. Baseline Gate (Step 0 — work does not start without it)

The first automated action only verifies, it does not change anything:

1. After `git fetch`, confirm main contains tag `v0.5.0`, and that the release/v0.5.0 close-out commit is already on main
2. Start the server from source; `/api/health` reports 0.5.0 (a direct lesson from the v0.2.1 incident: this is how a tag/main divergence gets caught)
3. Working tree is clean (no leftover uncommitted changes)
4. `OPENROUTER_API_KEY` present · `~/.spark-research/credentials.json` present · `bun test` all green

**If any of these is not satisfied → stop execution, report status in the session, and wait for the user to decide. Do not close out or release on your own initiative.**

Once passed: copy this document into `docs/DEVELOPMENT_PLAN_v0.6.md`, and put it through the first PR together with the 4 topic taskbooks (§5).

---

## 2. Gate G (Foundation — waves only open after this is completed serially)

### G-1 · Model configurability + GLM pricing registration

Development:
1. Add `z-ai/glm-5.3-flash` to `PROVIDER_MODELS.openrouter`; in `providers/registry`,
   register `priceFor` with the **effective price including the 5.5% platform fee**, with a comment documenting the basis (otherwise the ledger will always under-report)
2. `config set default-model` persists to disk + `LLMRouter.call()` reads it when no model is explicitly passed.
   **Lesson from the V40 repeat offender** (`defaultProvider` was write-only, never read): there must be a real reader, plus an added gate check —
   **any config item that can be written must have a reader** (reconcile every item in the config schema)
3. Add a `--model` override to `lit read` / `lit review` / `idea` / `chat` (V16's "half visible to the user"; per-subagent model assignment is out of scope)

Tests:
- Unit test: after `set`, calling without passing model routes through openrouter with the correct wire model
- Negative control: remove the reader → the "config item must have a reader" gate turns red
- Pricing assertion: `priceFor("z-ai/glm-5.3-flash")` is non-null (guards against silently losing pricing on a future table edit)

### G-2 · Release surface

Development: bundle the frontend dist artifacts into the binary (the last piece of the V27 family, V43①); add
`files`/`engines`/`prepublishOnly` to `package.json` (V29); `new skill|connector` continues to be explicitly rejected inside the binary, documented in INSTALL.md (V43②).

Tests (V28 lands together with this): CI smoke test — build the binary → `--version` / `capabilities --json` / `doctor`
→ **start `server`, curl the homepage, get 200 and real HTML** → version numbers consistent in all three places. Manually verify the npx path once from a clean directory.

### G-3 · Round-level budget gate ($2 enforced)

Development:
1. **Ledger persisted to disk**: `usage.jsonl` (under `~/.spark-research/projects/<slug>/`), appending on every LLM call:
   `{ts, command, skill, model, calls, tokens, knownCostUsd, unknownCostCalls}` —
   a single "round" spans multiple CLI commands, so the ledger must accumulate across processes
2. Batch commands (`lit read --all` / `lit review` / the agent loop) read the accumulated ledger at startup and pass
   `maxCostUsd` into `BudgetLedger`; on overrun, **stop gracefully with resume support, without losing already-completed deep-read cards**.
   The overrun decision follows the ledger's iron rule: use the `knownCostUsd` lower bound to judge overrun, flag unknown cost with a warning rather than hiding it, and never treat it as 0
3. `usage` CLI: `spark-research usage [--json] [--since <ts>]`, attributed per skill.
   **CLI wiring note**: the `usage` namespace's dispatcher is broken out into its own `backend/src/cli/usage.ts`,
   with `index.ts` only adding a single case — this leaves a mount point for W6-1 α, avoiding two lanes contending for the `index.ts` hotspot

Tests:
- Cross-process persistence: run two commands in sequence, the second reads the accumulated total
- Negative control: inject a model with no unit price → `unknownCostCalls` +1, `costUsd` reports null, not 0
- Live gate test: set the cap to $0.001, run `lit read --all` → stops gracefully + resume prompt + completed cards retained

### G-4 · AMiner preflight check

Run the `getPaper` detail endpoint once with a real key (V9, search has already been verified working), and record the result code in the devlog.
No renewal (per user instruction); establish the scheduling constraint: **all rounds of Chinese-language topics must be squeezed in before 10-07** (naturally satisfied within this run's 10 hours).

---

## 3. W6-1 · Three parallel lanes

File ownership (the iron rule from v0.4 §5.1; the `index.ts` hotspot has already been broken apart in G-3):

| lane | Content | Exclusive files/directories | Must not touch |
|---|---|---|---|
| α | connector call ledger | `connectors/base.ts` · `backend/src/usage/` (new) · appended within `cli/usage.ts` | `index.ts` · frontend |
| β | four workbench panels | `frontend/workspace/src/**` | all of backend |
| γ | CLI onboarding cleanup | `index.ts` · `literature/` copy · `report/export.ts` | `connectors/` · frontend |

### lane α · connector call ledger (B1)

G-3 handles money, α handles API call **counts and health** (AMiner is free, but 429/401/latency are B2's core observed metrics every round):
- A single instrumentation point in `connectors/base.ts`, covering every connector (not modifying each one individually — the lesson of V46's "two hand-written copies"):
  `{ts, connector, host, status, latencyMs, rateLimitWaitMs}` logged to `api_calls.jsonl`
- `usage api` subcommand: aggregated by source/by host, with 429/401 broken out separately (this is how the V26 rate limiter's real-world effectiveness becomes observable)
- Logged URLs have **query parameters stripped** (credential discipline)

Tests: success/429/timeout — all three branches get logged; negative control: bypassing the base layer to send directly → gate turns red;
**ledger file contents are checked against the credential-regex gate**.

### lane β · four workbench panels (A2)

Each panel gets a three-piece set: implementation + a `ui_cli_parity.test.ts` assertion + one Playwright scenario.

| Panel | CLI it aligns with | Playwright scenario |
|---|---|---|
| ① Long-task progress | `lit tasks` | start a read task → UI shows progress → still there after refresh |
| ② record / evidence graph | `report records` / `report show` | click a record → see incoming and outgoing edges |
| ③ Compute (read-only) | `compute list/status` | job is visible; **assert that the dispatch button does not exist** (V47 ruling) |
| ④ Usage | `usage` / `usage api` | numbers change after running a command |

Discipline: ④ only consumes the `--json` output of G-3/α, it does not compute its own numbers (two places computing the same number = the shape of V37).

### lane γ · CLI onboarding cleanup (A4)

- V54: the bioRxiv "not real search" caveat goes into `lit sources` / `lit search` + `&amp;` decoding
- V56, three items: unknown-command echo of the mistyped word · reports carrying unconsumedWarnings · observation table formatting
- V50: for `rev`, adopt the direction of "separating the user-visible rev from the internal write count"; the behavior change goes into the CHANGELOG
- V53: verify with real fault injection that the `packagingLimitation` mechanism actually lights up

Each item comes with a regression test.

### W6-1 close-out

All three lanes merged in → full test suite green → binary smoke test → **narrow acceptance review of the changed paths** (institutionalizing the V58 lesson)
→ tag `v0.6.0-alpha.1` + CHANGELOG + devlog.

---

## 4. B2 · Multi-round empirical feedback loop (the core of this release)

### Per-round protocol (fixed script, comparable round over round)

```
0. Preflight: usage snapshot reset to zero · doctor · AMiner liveness probe
1. Retrieval: lit search per the taskbook's search query (for Chinese-language topics, --sources aminer is primary)
2. Ingestion: lit add the top 10 papers → paper-download pulls the PDFs
3. Deep read: lit read --all (the $2 gate is in effect, model z-ai/glm-5.3-flash)
4. Review: lit review (citation authenticity verification enabled)
5. Ideation: idea new ×2 → novelty check
6. Report: report export
7. Observation: usage / usage api snapshot · report stats · fill in the metrics table (§6)
8. Logging: findings list → BACKLOG (every item has a disposition: fix / defer / explicitly won't do)
9. Fix: this round's fixes + regression + narrow acceptance review of changed paths → only then is the next round allowed to open; tag alpha.N after fixes are merged
```

### Round schedule

| Round | Topics | Executor | Purpose |
|---|---|---|---|
| R1 (within this 10h run) | T1 + T3 | **Zero-context subagent** (unfamiliar with the main session's development — the posture v0.5's three review passes proved best at surfacing problems) | Expected to surface the most findings, with the longest fix window |
| R2 (subsequent session) | T2 + T4 | Zero-context subagent | Runs with R1's fixes applied; whether T1 produced structural data decides A3 |
| R3 (subsequent session) | T1–T4, full set | Driven by the main session | Regression + final data; in principle no new fixes are mixed in — if they are, add R4 |

### Topic taskbooks (each written up in its own document within the first PR of the execution phase; recall baselines are independently pre-listed and frozen before the run starts)

| # | Topic | Search query key points | Coverage |
|---|---|---|---|
| T1 | Recent 3-year progress in protein structure prediction/design (AlphaFold family) | EN: protein structure prediction / design, 2023-2026 | protein-analysis; producing structural output → triggers A3 |
| T2 | Comparison of single-cell transcriptome clustering methods | EN: single-cell RNA-seq clustering benchmark | scanpy platform, dry-experiment closed loop |
| T3 | Brain-computer interface signal decoding | ZH: brain-computer interface / neural signal decoding (AMiner Chinese-language search query) | V8 Chinese-language recall, AMiner main path |
| T4 | Perovskite solar cell stability | ZH: perovskite / stability / encapsulation | AMiner + mixed Chinese/English deduplication |

Fixed taskbook format: research question in one sentence · search query · **5–8 pre-listed core papers (the baseline for the recall-rate acceptance criterion,
independently compiled using free sources and frozen before the run starts, isolated from round execution)** · budget $2 · success criteria.

---

## 5. Metrics table (must be filled in every round, trend-comparable)

| Metric | Measurement method | Target |
|---|---|---|
| Per-round cost | `usage` knownCostUsd + unknownCostCalls | ≤$2 and unknown=0 (>0 = there's a hole in the pricing table, fix within the same round) |
| Retrieval recall | Proportion of hits against the taskbook's pre-listed core papers | EN ≥80%; for Chinese, first get a baseline number (V8), then decide on a fix |
| API health | `usage api` 429/401 rate, rate-limit wait time | 429 trending to zero (verifying V26's real-world effectiveness) |
| Citation verification | lit review hard/soft counts + manual spot-check of 5 entries | precision holds at 100% (P8-G5 baseline) |
| Judge JSON failure rate | `citation_judge_unavailable` count (V12) | Re-establish baseline on GLM; if >2%, wire up `response_format` (whether GLM supports it is tested empirically in R1, not assumed in advance) |
| Deep-read card quality | Sample 5 cards per round, classify errors (missed reading/hallucination/misattribution) | Error types converge; the V13 standard is decided using real samples |
| Novelty criteria | Each round's new claims go into the calibration set | ≥20 claims after three rounds (a debt left over from v0.5 planning) |
| Report usability | A human reads through the report export once | No S10/S12-type "reader thinks it's broken" breakpoints |

---

## 6. Subsequent waves (beyond this 10h run, listed here for the complete roadmap)

- **W6-2**: R2 + the A3 decision and implementation (if triggered)
- **W6-3**: R3 full re-run + metrics roll-up; attached side debt: V41 (MCP description-capability claim gate) ·
  V48 (local handle persisted to disk, so SIGKILL→resume actually works) · V24/V21/V14/V3 decided item by item — absorbed or explicitly won't-do
- **Close-out A5**: zero-context external review pass, two points differ from the previous three (per the V57 disposition) —
  ① the entry point is primarily the browser workbench (starting from `npx spark-research server`);
  ② the spending path is pre-authorized for $2 and executed per script without asking for approval on each item. `v0.6.0` ships only after blockers are fixed and a narrow acceptance review is completed.

### v0.6.0 DONE definition (all four conditions satisfied)

- [ ] On a clean machine, `npx` starting the server yields a usable workbench with all four panels
- [ ] Three rounds of the feedback loop completed, the metrics table is comparable across the three rounds, with trends improving or every regression explained
- [ ] The $2 gate has been tested with a real trigger, cost ledger unknown=0
- [ ] A zero-context reviewer walked the full pipeline through the browser + spending path (V57 zeroed out)

### Explicitly out of scope (v0.6)

Physical Opentrons · multi-user identity · a real SSH/Modal gateway · broad skill/connector rollout
(only integrating what B2 names, ≤2–3 per round) · compute dispatch from the web UI · AMiner renewal (per user instruction) ·
per-subagent model configuration · genome browser.

---

## 7. 10-hour automated run operating procedure

### Time-boxing (estimated, adjusted on a rolling basis; if something doesn't finish, cut from the tail in order rather than thinning everything evenly)

| Time window | Content | Output acceptance criterion |
|---|---|---|
| 0–0.5h | Baseline gate (§1) + PR bringing the plan/taskbooks into the repo | main contains v0.5.0 and health check reconciles |
| 0.5–2.5h | Gate G-1/G-3/G-4/G-2 | All gate tests green + $0.001 live trigger test |
| 2.5–6h | W6-1 three lanes (each in its own worktree: `~/Desktop/spark-research-<lane>`) | Each lane's gate checks + negative controls green |
| 6–6.5h | W6-1 close-out → `v0.6.0-alpha.1` | Full suite green + smoke test + narrow acceptance review |
| 6.5–9.5h | B2 R1 (T1+T3, zero-context subagent, $2 gate); remaining time fixes top-priority findings | Two round reports + usage snapshot + BACKLOG entries logged |
| 9.5–10h | Wrap-up: materialize wip into a branch and push it (no stash left overnight) · handoff notes · in-session summary | Clean, resumable state |

### Guardrails (hard constraints for the whole run)

1. No direct pushes to main; squash-merge after all tests are green and self-review passes (authorized by the user on 2026-09-11); **delete the local branch immediately after merging**
2. Verify the remote ref after every push (`push -q; echo ok` is forbidden)
3. Actual LLM spend is **hard-capped at $6**; once the cap is hit, stop the spending path and continue with non-spending development, noting this in the session
4. Credentials must never enter logs/commits/prompts; the α lane's credential gate serves as the backstop; new files are grepped for secrets before commit
5. Do not touch the wet-experiment/compute approval path (naturally held in place by the AD-9 TTY requirement during automated runs)
6. Version records: every alpha tag has a CHANGELOG section; every wave gets a devlog entry; all findings go into BACKLOG with a disposition
7. Progress reporting: report a segment within the session at every wake-up point (what was done / next steps / cumulative spend);
   on the GitHub side, PR prefixes `G-x:` / `W6-1 α:` / `B2-R1:` let the user re-verify independently
8. If something already reviewed gets changed after its review pass → a narrow acceptance review must be re-run (V58)

### Subagent and model allocation (who does which step, using which model)

> The two model layers are independent of each other — don't conflate them: the **product-side LLM** (the one spark-research itself calls) uses
> `z-ai/glm-5.3-flash` throughout, governed by the $2/$6 budget; the **agent-side model** (the one Claude uses to do the work) is allocated per the table below,
> and consumes Claude quota.

| Step | Executor | Agent model | Rationale |
|---|---|---|---|
| Baseline gate · Gate G | **Done directly by the main session**, no subagent | Fable (current) | Serial foundational work that touches hotspot files (router/index.ts); delegating to a subagent would require rebuilding context anyway |
| W6-1 lane α/β/γ | 3 parallel subagents, each in its own worktree | **sonnet** | The same kind of lane development in v0.5 also used sonnet subagents — the right scale for this |
| W6-1 merge review | **Main session** (sole merge authority, discipline #14) | Fable | **Don't trust a lane's self-reported numbers**: before merging, the main session independently re-runs the tests and negative controls, and does not take a lane's "all green" claim at face value |
| W6-1 close-out (smoke test/narrow acceptance review/tag) | Main session | Fable | Cross-lane judgment + release actions |
| B2 R1 execution (T1+T3) | **Zero-context subagent** (forbidden from reading source code, given only MCP/CLI + llms.txt) | **sonnet** | The reviewer must be unfamiliar with the system; the product side still goes through glm — the agent model does not affect the $2 budget |
| R1 metrics roll-up / findings analysis / BACKLOG logging | Main session | Fable | Judgment-intensive — this is where the real value of these 10 hours lies |
| Mechanical batch work (fixture recording, log scanning, compiling taskbook recall baselines) | A single subagent | **haiku** | Pure execution, saves quota |

Additional discipline: subagent output only counts once **verified by the main session** (re-running tests / spot-checking files / checking the remote ref);
subagents are never granted merge rights — PR merges happen only in the main session.

### Recovery protocol for insufficient Claude quota

Quota exhaustion typically manifests as subagent spawn failures or calls reporting quota errors. The fixed response is:

1. **Materialize before waiting**: turn the current state into something durable (unmerged changes → push into a wip branch, progress written into
   `~/Desktop/AI4S/spark-research-v0.6-plan/RUN_LOG.md`), ensuring any interruption point is resumable
2. **Step down and retry** (in order): 3 parallel lanes → a single serial lane; sonnet subagent → the main session does it itself
   → mechanical parts switch to haiku. **Product-side glm calls are unaffected by Claude quota** — if a B2 round is already running, let it finish
3. **Periodic retry**: when quota is fully blocked, don't idle-spin burning tokens — use a wake-up mechanism to probe every **20–30 minutes**
   (spawn a minimal haiku task as a probe); once recovered, resume from the RUN_LOG breakpoint; log one line per attempt in the session
4. **Time accounting**: time blocked on quota still counts against the 10-hour wall clock. If still blocked when time runs out, at the first wake-up point after recovery,
   do only wrap-up (materializing wip + handoff notes) and stop — do not start new work

### Launch command (the user types this in the session after confirming the v0.5 release)

```
/loop Follow ~/Desktop/AI4S/spark-research-v0.6-plan/PLAN_v0.6.md to automatically advance v0.6: first pass the baseline gate (main=v0.5.0, health reconciled, working tree clean; stop and report if not satisfied), then Gate G → W6-1 three lanes → close-out and tag v0.6.0-alpha.1 → B2 Round 1 (T1+T3, zero-context subagent, $2 gate per round). Guardrails per plan §7: squash-merge after PR is all-green and self-reviewed, LLM total spend hard-capped at $6, credentials never enter logs, report progress within the session at every wake-up point. Subagent and model allocation per the §7 table (lane development uses sonnet, mechanical work uses haiku, review and merging in the main session); on insufficient Claude quota, follow the §7 recovery protocol: first materialize state to RUN_LOG.md, step down and retry, wake up every 20–30 minutes to probe, resume immediately once recovered. Run continuously for 10 hours; once time is up or the goal is complete, materialize the wip branch, write handoff notes, and stop.
```
