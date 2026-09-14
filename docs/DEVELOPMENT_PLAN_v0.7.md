# Spark Research v0.7 Development and Testing Plan (Final Draft v1)

> Finalized: 2026-09-11 PDT · Baseline: main @ v0.6.0 (`dd11bf3`, PR #60)
> **Execution prerequisites confirmed satisfied (verified 2026-09-11)**: tag v0.6.0 = main HEAD · `package.json` 0.6.0 ·
> working tree clean · v0.6.0 tag is on the `origin/main` ancestor chain · GitHub Release has CI-attached binaries for both platforms.
> Companion design doc: `DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md` (full text of main line A; this document only references it, not restates it).
> The source of truth during planning lives locally at `~/Desktop/AI4S/spark-research-v0.7-plan/`; this document is its cleaned-up, checked-in version.
> Execution mode and timeboxing are set by the user at kickoff (v0.6 used `/loop` for a 10-hour autonomous run; this version may reuse that or split into segments).

---

## 0. One-line summary and decisions already locked in

**v0.6 lets the user come in through the browser and walk the full "literature → writing" path while knowing how much it cost; v0.7 makes sure every piece of data produced along that path is preserved as-is, exportable, and judgeable as fit-to-leave-the-building, while also fixing the two things all four case studies bled on across three rounds of empirical testing: retrieval ranking, and concurrency/long-task reliability.**

| Decision item | Content | Decided |
|---|---|---|
| Main direction | **A. Data layer evolution** (raw layer append-only · journal · export/lakehouse · provenance tiering) · **B. Retrieval package** · **C. Reliability package** · D. Modal (waiting on token, does not occupy the schedule) | 2026-09-11, user |
| Explicitly out of scope | 3D structure viewer (C5-①) · SDK / runtime contract (deferred to v0.8) · skill/connector rollout at scale (V76 convention: ≤2–3 per round, pulled by case-study need) · sales channel and billing · multi-user identity (V10) · physical Opentrons (V6, gated on V52 not yet decided) | same |
| Six data-layer rulings | raw on by default and local · LLM raw text kept permanently · v0.7 is JSONL + DuckDB direct-query only, no Parquet · sharing unit = project, time window is incremental-only, manifest is chained · sale channel not built but interfaces aligned with Delta Sharing / DCAT / SPDX · `raw/kernel` stores only references + hash | same (see companion design §0 for detail) |
| Empirical feedback loop | **R4**: full rerun of all four case studies (T1–T4, baseline already frozen), metrics table listed alongside R1–R3 for comparison; add a two-step `data export --for-sharing` → import into an empty project via `data import` → `report export` diff | proposed by this plan |
| Per-round budget | $2 (carried over from v0.6, enforced via `--budget-usd`); R4's four case studies estimated at ≈ $0.3 (v0.6 measured $0.03–0.09 per case study) | carried over |
| LLM model | Continue with `z-ai/glm-5.3-flash`; in R4, rerun the judge on at least one case study with a second provider (V12's ruling needs a cross-provider sample) | proposed by this plan |
| AMiner key | **Expires 2026-10-07**; the R4 round for the Chinese-language case studies (T3/T4) must be scheduled before expiry; renewal is the user's call | user's standing instruction |
| PR policy | Carried over from v0.6: authorized auto squash-merge (all six suites green + self-review); no direct pushes to main; verify the remote ref after pushing; **single merge authority** (discipline #14) | carried over |
| Versioning discipline | All changes on the **v0.7.x line**: W7-D0 close-out → `v0.7.0-alpha.1`, one alpha per subsequent wave; after R4 + the fifth zero-context acceptance review passes → `v0.7.0`. Every tag must have a CHANGELOG section | carried over |

---

## I. Baseline gate (step 0, no work starts before this)

| # | Check | Acceptance criterion |
|---|---|---|
| 0-1 | All six suites green on v0.6.0, with counts recorded | unit ≥ 2145 · e2e 19 · concurrency+timeout · pytest · test:lab; the numbers go into the W7-D0 first PR description as the "only increase, never decrease" baseline |
| 0-2 | Binary smoke test (CI) green on tag v0.6.0 | Release assets exist for both platforms |
| 0-3 | `.venv` usable in every worktree | v0.5 lesson: a new worktree missing `.venv` made the python suite **silently turn into skips** — symlink it, then actually run `test:py` once and check the skip count |
| 0-4 | BACKLOG reconciled | Done in this PR: V1/V7/V11/V15/V17/V18/V19 marked ✅ with empirical evidence; V16 ruling revised; V12 measurement numbers from GLM added |
| 0-5 | AMiner key remaining validity ≥ planned date of R4's Chinese-language round | Otherwise schedule the Chinese round first, or have the user renew |

---

## II. Main line A · Data layer evolution (three waves, see companion design for detail)

| Wave | Deliverable | Gate (companion design §8) | Related BACKLOG |
|---|---|---|---|
| **W7-D0** | L0 raw layer: `backend/src/raw/` (`RawSink` contract + `JsonlRawSink` + `MemoryRawSink`) · 4 instrumentation points (`connectors/base.ts:188` · `usage/ledger.ts:184` · `artifacts/store.ts` where execution_records are written · `lab/wet_loop.ts:662`) · redaction · hash chain · blob threshold · L3 three columns (`quality` / `provenance_class` / `license`) + `backend/src/provenance/policy.ts` mapping table + backfill migration (schemaVersion 1→2) · **V78 cleanup**: all 6 bare `new LLMRouter()` call sites (`orchestrator.ts` / `server/context.ts` etc.) switched to go through `usageTrackingLlm`, otherwise both raw/llm and usage.jsonl miss the chat and MCP surfaces | G1 coverage · G2 redaction · G3 chain · G6 AD-16 · G7 config has a reader | V78 · V63 (raw rows carry real rateLimitWaitMs) · V76 (new connectors must declare license) |
| **W7-D1** | L1: `records_journal` (same transaction as records) · `RecordStore.history()` · `records repair <id> --to-seq` · `LibraryStore.remove()` changed to a tombstone, wired to `retractOrphanRecords()` · HTTP `GET /api/records/:id/history` · CLI `report records --history` | G4 journal reconciliation · D-9 integrity-verification regression (full run of `tests/unit/lab_*`) | V24 · V30 |
| **W7-D2** | L2: `spark-research data export/import` (JSONL + manifest: three-tier Delta Sharing naming · DCAT fields · SPDX license · `prevManifestHash` chain · `--for-sharing` category filtering + upstream stub redaction) · three example queries in the DuckDB direct-query docs · binary smoke test extended with the export path · README/llms.txt narrative | G5 export round-trip · G8 narrative consistency | V57 disposition (acceptance taskbook gets the two extra steps) |

**Order cannot be swapped**: D0's three columns are a precondition for D2's filtering; D1's journal is one of D2's export objects.

---

## III. Main line B · Retrieval package

The common bleeding point across all four case studies over three rounds of empirical testing. Baseline (frozen in `docs/taskbooks/v0.6/`): T1 milestone recall 2/8, T2 3/8, T4 1/5@10 (still 2/5 at limit 150), T3 Chinese 3/3 but 0 hits on closed compound words.

| lane | Deliverable | Acceptance criterion | Footprint |
|---|---|---|---|
| **B-1 Ranking (V67)** | Currently `literature/search.ts:158` sorts merged results only by "hit-source count → first-seen order." Change to **hybrid ranking**: `hitCount` × normalized citation count (`library.citedByCount` already exists, sourced from OpenAlex `cited_by_count` / Crossref `is-referenced-by-count`; **add normalize mapping for AMiner's `n_citation` and S2's `citationCount`**) × year decay; `lit search --rank blended\|hits\|citations\|recent`, default blended; status.note states the ranking basis (AD-12: how a result was produced must be visible) | For all four frozen case-study baselines, recall@10 **each ≥ baseline +2, or each shortfall has a documented mechanism explanation**; no regression (T3 stays at 3/3) | `literature/search.ts` · `literature/normalize.ts` · `connectors/aminer.ts` · `connectors/literature.ts` (S2 fields) · `literature/cli.ts` (flag copy) |
| **B-2 Chinese segmentation** | V65's fallback splitting only recognizes spaces. Add a segmenter: **Python `jieba` as an optional dependency** (same shape as `pdf_text.py`/pypdf: `.venv` probe → spawn → falls back to space-splitting if missing, with honest disclosure in the note); triggered only when "zero hits and no spaces" | Add 2 closed compound-word queries each for T3/T4 into the frozen benchmark, reachable after segmentation; behavior identical to v0.6 when jieba is absent (gate: the missing-stub path) | new `literature/segment.py` + `literature/segment.ts` · single call site added in `search.ts` · one line added to the `doctor` probe surface |
| **B-3 desc contamination (V69)** | `projectContext` injection changed to an explicit "background information, not a task instruction" framing block; the prompt templates for the reading card's "relevance to this project" and the report's "research questions" get the same change | Golden test: desc appears inside the framing block in the prompt text, and only once; R4 spot-checks 5 cards to confirm desc's original text does not appear verbatim in the body | `agents/prompts.ts` · `literature/reading.ts` · the prompt-construction site in `report/export.ts` |
| **B-4 Minor items** | V72: Chinese entries with no author → BibTeX key falls back to pinyin or `anon<year>`; V71: `review findings` shows the citation soft finding | One unit test each | `literature/bibtex.ts` · the query surface of `reviewer/findings_store.ts` |

---

## IV. Main line C · Reliability package

| lane | Deliverable | Acceptance criterion | Footprint |
|---|---|---|---|
| **C-1 V64 root-cause fix** | Resolution order: `--project` > env `SPARK_RESEARCH_PROJECT` > `state.json.sessions[sessionId]` (field already exists, `manager.ts:197`) > global `currentProject`; writes to the global pointer get a file lock (`state.json.lock`, O_EXCL + expiry reclaim); `project use` only changes the session binding, not the global one, unless `--global` is passed | Two processes alternating `project use` + record writes, 100 iterations each, zero cross-project contamination (`tests/concurrency/project_pointer.test.ts`); R4's four case studies rerun concurrently with zero contamination | `project/manager.ts` · the single `openProjectResolved` call site in `cli/` (already closed out in alpha.6, this is the only spot to touch) |
| **C-2 V70 + V3** | Task snapshots and simulation run records store `pid` + process start time (`ps -o lstart=` / Linux `/proc/<pid>/stat` starttime); `lit tasks` / `exp status` cross-verify on read-back — if the pid is absent or the start time doesn't match, mark as `orphaned` (do not change to failed — that might be a false read; keep tasks.ts's existing convention) | `lit tasks` no longer shows running after kill -9; false-positive test: a pid-reuse scenario is marked orphaned, not running | `server/tasks.ts` · `simulation/run_store.ts` · `literature/cli.ts` (tasks output) |
| **C-3 V60** | Parser keeps the original text fragment of out-of-vocabulary reagents in the compiled artifact (`label`); Opentrons step name reads `unrecognized reagent#step-1 (original: nitric acid)`; the approval surface (CLI + UI) shows the original text and flags it as "out of vocabulary, not covered by safety rules" | Unit tests: original text is visible for each of three out-of-vocabulary reagents, reservoir well positions do not collapse (V60's existing assertion preserved); e2e ⑨ approval dialog contains the original text | `lab/protocol.ts` · `lab/opentrons_protocol.ts` · approval rendering in `lab/cli.ts` · frontend approval component (discipline #13: cross-layer changes must run e2e) |
| **C-4 V80** | Add `PRAGMA busy_timeout = 5000` to `records.db` / `library.db` / `artifacts.db` (`findings_store.ts:159` already has it, the other three DBs don't) | Concurrent `idea new` + `idea check` no longer hits `database is locked` (R3-T4 repro script added to the concurrency suite) | one line each in `project/records.ts` · `literature/library.ts` · `artifacts/store.ts` |

---

## V. Side line D (Modal) and debt settlement E

**D · Modal real gateway**: Conditionally triggered — work begins the day the user provides a token, implementing the real pipeline per v0.5's `COMPUTE_DESIGN.md` and the W5-2 α contract; the acceptance path §1.1.9 "SIGKILL → resume → reap" must hold on Modal. **Does not occupy the schedule, not part of the DONE definition.**

**E · Debt** (each item either gets done, or gets a ruling and is archived — no item is allowed to stay dangling, per BACKLOG discipline):

| Item | Disposition |
|---|---|
| V41 MCP description capability claims gate | **Do**: add an 8th check to `narrative_parity` — capability words in `MCP_TOOLS[].description` (docking/3D/full-text/…) are reconciled against the `capabilities` source of truth; negative control follows the same one used in W5-1 γ |
| V48 local handle persistence | **Do**: `adapters/local.ts` writes back `adapterHandle` as soon as spawn succeeds (`broker.ts:696` already has the CAS write point), so SIGKILL → resume works for real on local |
| V62 e2e tsconfig, 45 type errors | **Do**: fix until it passes and fold into the `typecheck` script, or write an exemption justification — pick one, decided at W7-D0 close-out |
| V21 timeout env prefix | **Start deprecation cycle**: the new name `SPARK_RESEARCH_*_TIMEOUT_MS` takes effect; reading the old name emits a warning; removed in v0.8 |
| V14 allowlist scheme | **Ruling**: do together with the reviewer state-machine rework (P13 convention); not touched in v0.7, reasoning recorded in BACKLOG |
| V12 structured output | **Candidate for closure**: the judge's JSON failure rate was 0% on glm-5.3-flash across R1–R3 (see the "numbers" section of CHANGELOG v0.6.0); R4 reruns one case study on a second provider — if still 0%, close; otherwise `CallOptions.responseFormat` moves into v0.8 |
| V13 judge prompt convention | **Ruling**: R1–R3 verified 400+ citations with 0 fabrications, 0 hard failures — the "attribution out of thin air" underreport has not recurred, closed; reopen if it recurs |
| V16 subagent model configuration | **Ruling: closed**: the user-visible half was already done in v0.6 G-1; "joint evaluation with V7" has no object left since V7 was deleted |
| V42 network declaration not enforced | **Registered as not doing**: isolating local process network requires sandbox/netns, out of scope for v0.7; documentation explicitly states "declaration is not enforced" |
| V49 deterministic convention | **Not ruled on** (deferred by the user), but goes into the `quality` column (W7-D0) |
| V52 concentration units | **Waiting on user domain judgment**, gates V6 |

---

## VI. lane footprint master table (parallelism discipline: one owner per file)

| File/directory | Owner | How other lanes may touch it |
|---|---|---|
| `backend/src/index.ts` | **Close-out** (main session) | Each lane contributes one `case` line, merged at close-out (v0.5 η lesson) |
| `backend/src/raw/` · `backend/src/provenance/` · `backend/src/data/` | A (D0/D1/D2 respectively) | New directories, no conflicts |
| `connectors/base.ts` · `usage/ledger.ts` · `artifacts/store.ts` · `lab/wet_loop.ts` (instrumentation lines) | A-D0 | B/C do not touch; the one-line PRAGMA for C-4 in `artifacts/store.ts` is handed to A-D0 to do in passing |
| `project/records.ts` · `project/manager.ts` · `project/models.ts` | A-D0 (adds columns/paths) → A-D1 (journal) → **C-1 touches `manager.ts` only after D1 is merged** | Serial, not parallel |
| `literature/search.ts` · `normalize.ts` · `connectors/aminer.ts` · `connectors/literature.ts` | B-1 | B-2 only adds `segment.*` and one call site in search.ts; **B-2 starts only after B-1 is merged** |
| `agents/prompts.ts` · `literature/reading.ts` · `report/export.ts` | B-3 | A-D1's one update at `reading.ts:466` is untouched, no conflict |
| `server/tasks.ts` · `simulation/run_store.ts` | C-2 | — |
| `lab/protocol.ts` · `lab/opentrons_protocol.ts` · `lab/cli.ts` · frontend approval component | C-3 | A-D0's `wet_loop.ts` instrumentation is a different file |
| `tests/unit/narrative_parity.test.ts` | E (V41) | A-D2's G8 item is merged in by E |
| `docs/` · `README.md` · `llms.txt` | Close-out | lanes submit devlogs; narrative changes are unified at close-out and pass G8 |

**Wave orchestration** (sequencing/parallelism relationships):

```
W7-D0 (A-L0 + three columns + V78 cleanup + C-4 + V62 ruling)  ──→ alpha.1
   ├─ B-1 ranking      ─┐
   ├─ B-3 desc         ─┼─ parallel ──→ alpha.2
   ├─ C-2 tasks        ─┤
   ├─ C-3 V60          ─┤
   └─ E: V41 V48 V21   ─┘
W7-D1 (A-L1 journal + V24/V30)  ──→ alpha.3
   ├─ B-2 segmentation (after B-1)  ─┐
   ├─ B-4 minor items                ─┼─ parallel ──→ alpha.4
   └─ C-1 V64 root-cause (after D1) ─┘
W7-D2 (A-L2 export/import + narrative)  ──→ alpha.5
R4 full rerun + fifth zero-context acceptance review (including export two-step) → fix blockers → v0.7.0
```

---

## VII. Gates and acceptance

- **All six suites + binary smoke test** must run on every PR; numbers only increase, never decrease (baseline §I 0-1)
- **Companion design §8 G1–G8** all landed, each with a negative control actually run and recorded (devlog pastes the command and red/green result)
- **Cross-layer changes must run e2e + consumer-side sweep** (discipline #13): C-3 and W7-D2 must trigger this
- **R4**: rerun all four case studies per the v0.6 per-round protocol; metrics table gets new columns "export round-trip diff" and "raw row count / usage row count"
- **Fifth zero-context acceptance review**: entry via browser; spend-path pre-authorized for $2; taskbook adds `data export --for-sharing` → verify manifest counts and exclusion reasons → `data import` into a new project → `report export` diff must be empty
- **Nothing reviewed gets modified after acceptance** (V58): if it's modified, do a narrow-scope re-review

## VII·Addendum. Execution orchestration: who does what, using which model (confirmed by user 2026-09-11, added before work starts)

> Two layers of models are unrelated to each other: the **product-side LLM** (the one spark-research itself calls) runs entirely on `z-ai/glm-5.3-flash`,
> governed by the $2/round budget; the **agent-side model** (the one Claude uses to do the work) is allocated per the table below, consuming Claude quota.

| Step | Executor | agent model | Rationale |
|---|---|---|---|
| Baseline gate · **W7-D0 / W7-D1 / W7-D2** | **Main session does it directly**, no subagents | Fable | All three waves are data-layer groundwork, touching the hotspot files `records.ts` / `manager.ts` / `base.ts` / `index.ts`; splitting these to subagents means rebuilding context and easy collisions |
| alpha.2's five lanes (B-1 · B-3 · C-2 · C-3 · E) | 5 parallel subagents, each in its own worktree | **sonnet** | Lanes of similar scale in v0.5/v0.6 were all completed by sonnet |
| alpha.4's three lanes (B-2 · B-4 · C-1) | 3 parallel subagents, each in its own worktree | sonnet | B-2 must start only after B-1 is merged; C-1 must start only after W7-D1 is merged (see §VI sequencing/parallelism relationships) |
| Review of each batch merge | **Main session** (single merge authority, discipline #14) | Fable | **Lane self-reported numbers are not trusted**: independently rerun all six suites + every negative control before merging; verify the remote ref |
| Close-out of each wave (smoke test / narrow acceptance review / tag / CHANGELOG) | Main session | Fable | Cross-lane judgment + release actions |
| R4 rerun of the four case studies · fifth zero-context acceptance review | **Zero-context subagent** (forbidden from reading source code, given only CLI/MCP + `llms.txt` + `readme_for_agent.md`) | sonnet | The reviewer must be unfamiliar with the system; the product side still goes through glm as usual, the agent model does not affect the $2 budget |
| Metrics rollup / findings analysis / BACKLOG registration | Main session | Fable | Judgment-intensive |
| Mechanical bulk work (fixture recording, log scanning, recall-benchmark checking) | A single subagent | **haiku** | Pure execution, saves quota |

Hard disciplines (carried over, each with an incident history behind it):
- One lane, one worktree: `~/Desktop/AI4S/spark-research-<lane>`, never in /tmp; lanes start from a neutral cwd (§5.3·addendum 2)
- New worktrees must symlink `.venv` and `bun install` first, then **actually run `test:py` once and check the skip count** (v0.5: missing `.venv` silently skipped 17 test cases, and the lane reported green)
- Subagent taskbooks must state their footprint (including `tests/e2e/` — v0.5 δ's e2e regression happened precisely because the footprint omitted it) and must state their negative controls
- Subagents are not granted merge rights; output only counts once verified by the main session
- Network/quota interruptions: the lane commits a wip commit first, marked "not verified in any way," and continues from the wip commit after recovery (this is how the five simultaneously-stalled lanes from v0.5's network outage were handled)

### Timeboxing (user's decision: two segments, with a check-in on alpha.2 in between)

| Segment | Content | Estimate |
|---|---|---|
| Segment 1 | Baseline gate → W7-D0 → alpha.1 → five lanes in parallel → merge → alpha.2 | ~6h |
| (user reviews alpha.2) | | |
| Segment 2 | W7-D1 → alpha.3 → three lanes in parallel → alpha.4 → W7-D2 → alpha.5 → R4 + fifth acceptance review → v0.7.0 | ~6–8h |

> **Execution-period numbering correction (2026-09-11)**: the main session's W7-D2 finished before the three lanes did, so in practice alpha.3 = W7-D1, **alpha.4 = W7-D2**, and **alpha.5 = close-out of the three lanes (B-2/B-4/C-1)**. The CHANGELOG reflects what actually happened.

If work can't be finished in time, cut from the tail in order (cut B-4 first, then V21/V62 within E), **do not thin everything evenly**; anything cut goes back into BACKLOG with the reason documented.

## VIII. Metrics table (required for R4, listed alongside R1–R3)

| Metric | R1 | R2 | R3 | R4 target |
|---|---|---|---|---|
| Milestone recall@10 (T1/T2/T4) | 2/8 · — · — | — · 3/8 · 1/5 | (see R3 summary) | each case study ≥ baseline +2, or has an explanation |
| Chinese recall (T3; includes 2 closed compound-word queries) | 0/3 | 3/3 | 3/3 | 5/5 |
| Concurrency contamination | bidirectional | 0 | 0 | 0 (two processes, 100 iterations) |
| Judge JSON failure rate | 0% (glm) | 0% | 0% | 0% (second provider) |
| Citation verification hard failures | 0 | 0 | 0 | 0 |
| Cost per case study | $0.03–0.09 | | | ≤ $0.15 |
| **raw/llm row count == usage.jsonl row count** | — | — | — | equal (including chat/MCP surfaces) |
| **Export round-trip report diff** | — | — | — | empty |
| Zombie "running" state after kill -9 | present | present | present | 0 |

## IX. v0.7.0 DONE definition (all five conditions must be met)

- [x] One case study run to completion, `raw/` has rows for connector/llm (device only on the wet-experiment path, kernel only on the chat code-task path — V85 registers that simulation is not in raw), chain verification passes (after the V91 fix), no credentials found via grep (G2)
- [x] **Ordinary export** → `data import` → `report export` diffs empty against the original report (A6 step 12); under `--for-sharing`, the manifest's upstream count is > 0 and marked as stub, and the artifact has no upstream abstract found via grep (A6 / `w7a6_r4_fixes`) — the for-sharing round trip is lossy by design, the convention was corrected in alpha.4
- [ ] **Not met**: recall ≥ +2 was only actually measured for T1 (3/8 → 5/8); T2/T4 were not measured due to OpenAlex anonymous 429s (R4 came back 0/8 across the board, mechanism explanation = upstream rate limiting, not a ranking regression). T3's closed compound words are now retrievable ✅ (R4). V67/V86 stay open, to be retested once a contactEmail politeness pool is in place
- [x] Two processes, 100 concurrent iterations, zero cross-project contamination (C-1 tests + R4's four case studies measured live); no zombie "running" state after kill -9 (`orphaned` instead) (C-2 tests + R4 measured live)
- [x] Fifth zero-context acceptance review completed successfully (A6: browser + $0.21 spent + the export two-step), Blocker/High findings cleared to zero; its Low finding turned up V91, already fixed (alpha.7)

> **Release decision (2026-09-11)**: 4 of 5 conditions are met; condition 3 is honestly marked as not met (blocked by upstream rate limiting on live measurement, not a product regression). Following the convention used since v0.5 — put the details into the backlog, don't let one external dependency block a release — recommend shipping v0.7.0, with V67/V86 as the first items in v0.8.

## X. Risks

| Risk | Mitigation |
|---|---|
| A-D0's `create()` rejecting on missing `provenance_class` → 10 write-side modules need cleanup | warn for one alpha first, reject afterward; G1 coverage gate as a backstop |
| B-1's hybrid ranking pushes T3's already-passing Chinese recall back down | T3 goes into the regression benchmark; ranking weights can degrade to hits-only per source (when AMiner has no citedByCount) |
| B-2's jieba unavailable in the binary | optional dependency + fallback + doctor probe, AD-12 convention consistent with pypdf |
| C-1's change to global-pointer semantics affects all CLI usage | only touch the single `openProjectResolved` site; concurrency tests + R4 rerun |
| AMiner key's 10-07 expiry collides with R4 | §I 0-5 upfront check; schedule the Chinese round first |
| Three main lines running in parallel causing index.ts conflicts | close-out has sole ownership; lanes only contribute case lines |
| Disk: raw layer on by default | companion design §4.3 estimates <50 MB/case study; `data archive` compresses without deleting |

## XI. BACKLOG reconciliation (this version)

| Disposition | Items |
|---|---|
| **Doing in v0.7** | V24 V30 V41 V48 V60 V62 V63 V64 V67 V69 V70 V71 V72 V78 V80 · V3 · V21 (deprecation cycle started) |
| **Ruling: closed in v0.7** | V12 (after re-verification with a second provider in R4) · V13 · V16 |
| **Registered as not doing in v0.7** | V14 · V42 |
| **Waiting on user/external** | V4 Modal (token) · V49 · V52 · V10 · V5 · V6 · D1 D2 D3 |
| **Marked complete retroactively in this PR** | V1 V7 V11 V15 V17 V18 V19 (evidence in respective rows) |
