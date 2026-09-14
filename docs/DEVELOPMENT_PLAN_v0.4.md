# Spark Research v0.4.0 Development Plan

> Drafted: 2026-09-10 (PDT) · Starting point: `main` v0.3.1 (`3599b75`)
> Upstream document: `DEVELOPMENT_PLAN_v0.3.md` (the architecture design of main lines A/B/C is still valid; this document carries it forward and revises it)
> **This document is the sole source of truth for v0.4 construction**; where it conflicts with the P11–P16 sections of the v0.3 document, this document governs

---

## 0. In one sentence

**v0.3 paid off the concurrency and timeout debt; v0.4 makes the phrase "Agent platform" real:
subagents actually use tools, task completion is judged by the evidence graph, installing an extension
is like installing an npm package — and all of this must be independently walkable end-to-end
by an external agent that knows nothing about this repo.**

---

## I. Starting point: what v0.3 taught us, and which plans must change as a result

### 1.1 v0.3's three incidents, all of which must become v0.4 construction constraints

| Incident | Symptom | v0.4 response |
|---|---|---|
| **v0.2.1 was silently bypassed by P10** | The P10 branch was cut before v0.2.1; after merging, the fix the tag claimed did not actually exist on main. No conflict, no warning — it was only discovered by accidentally glancing at `/api/health` | Discipline §5.3 adds "sole merge authority" and "integration must first align with origin/main and re-verify old tags" |
| **PR #22 merged an empty diff** | The `echo` in `git push -q …; echo pushed` masked the push failure; the remote branch stayed at the old commit while GitHub "merged" as usual | New discipline: "must verify the remote ref after push"; each phase gate adds a `git diff <branch> origin/main` check that should be empty |
| **v0.3.0 shipped with a UI regression** | The backend removed `wet_run`, but the frontend's execute button still judged availability by the old state name → after approval, the button was permanently greyed out. **The e2e test case already existed — it just wasn't run** | **`bun run test:e2e` enters every phase gate**; cross-layer changes force a "consumer cleanup checklist" |

> All three incidents share the same shape: **no error, no conflict — just silent nothing happening.**
> v0.4's verification design revolves around this: wherever "failure looks like success" is possible, there must be an explicit assertion.

### 1.2 P10 parallel field test: what held up, what needs backfilling

**What held up** (keep doing): one lane per worktree, the file-ownership mutual-exclusion table, no touching high-conflict files,
lane → integration → one PR. Zero violations of the four-lane discipline.

**What needs backfilling**:

| Issue | Field result | v0.4 fix |
|---|---|---|
| lane worktree had no `.venv` | 17 OpenMM contract test cases were **silently skipped**, lane reported green but hadn't run | After a lane is set up, `uv sync` is mandatory (or link the main repo's `.venv`); the lane report must state **which suites failed to run** |
| Cross-lane semantic conflict | D-d split a state → `routes/lab.ts` hardcoded the old state name, each of the four lanes green individually, red when combined | Already covered by Discipline 11; v0.4 adds the **consumer cleanup checklist** (see §5.4) |
| The real bottleneck is review bandwidth | 4 lanes = 4 PRs waiting for review; the serial tail took up a considerable share of the time | The lane cap stays at 4; **the serial tail's workload must be explicitly counted in scheduling**, no longer treated as "just wrapping up" |
| The breach was cross-session | Another session directly merged a lane branch into main | §5.3 sole merge authority |

**An unexpected win**: three lanes performed **negative controls** (reverting their own fix and confirming the test really does go red)
without being required to. This has proven extremely effective, and v0.4 **elevates it to a mandatory requirement**.

### 1.3 New findings left over from v0.3 that must go into v0.4

| # | Finding | Source |
|---|---|---|
| V22 | **`capabilities` externally broadcasts a skill that cannot actually be invoked** — `protein-analysis` carries a full description, `triggers`, a connector list, and a `validation` list in `capabilities --json`, while **all three entry points — CLI / HTTP / MCP — are absent**. An external agent reading the triggers would be confident it can invoke it. **This is not a completeness gap, it is the self-description surface lying** (a direct violation of AD-12) | First run of the D-12 gate check + the reachability matrix measured while drafting v0.4 |
| V23 | The wet-experiment `unconsumedWarnings` is only force-displayed in the CLI; **HTTP / Web approval surfaces are not wired up** | lane D-d delivery notes |
| V25 | `concentration_limit` / `biosafety` are **still no-ops** on the natural-language main pipeline | lane D-d, scope of D-8's authorization |
| V24 | `RecordIntegrityError` has no "fix after manual confirmation" recovery path | lane D-d |
| V20/V21 | `CONFIG_DIR` does not recognize `SPARK_RESEARCH_DATA_DIR`; timeout-related environment variable prefixes are inconsistent | lane D-c / serial close-out |
| — | **8 test cases in `tests/integration/` are `skipIf(!RECORDING)`**, connector behavior against the real upstream has never been verified in this round | v0.3.1 verification retrospective |
| — | **The `records.db` migration was never run against a real v0.2.x legacy database**, only unit-test coverage of the migration logic exists | v0.3.1 verification retrospective |

---

## II. Scope

### 2.1 What to do (six items)

1. **Reachability close-out** — every externally claimed capability must have a reachable production entry point (AD-5 tightened)
2. **LLM Runtime v2** — tool calling / usage accounting / streaming / JSON mode / true model neutrality
3. **ToolBus + real subagents** — subagents actually use tools, have a budget, are audited, and never self-approve
4. **Research loop** — contract completion criterion (query the graph, not the model), replan, frame-level accounting, findings state machine
5. **Onboarding experience** — npx / single binary / zero-argument UI startup / wizard / offline demo / local models / SSE streaming
6. **Extension surface** — declarative connectors / TS extensions / external MCP client / `ext verify` contract-based acceptance

Plus a **side track**: literature domain reinforcement (arXiv/PubMed go through declarative manifests, doubling as acceptance verification for the extension mechanism).

### 2.2 Explicitly not doing

| Not doing | Reason |
|---|---|
| Integrating physical Opentrons (V6) | **A hard prerequisite is unmet**: V25's `concentration_limit` / `biosafety` are still no-ops. v0.4 will backfill V23 (force-display the warning in the UI), but even after that it's still not enough |
| Real multi-user identity (V10) | Get the agent layer solid first; `actor` is still "whoever claims to be who they say they are" |
| Removing deprecated aliases (V15) | v0.2.0/v0.3.x have already been publicly released with them; removing them is a breaking change, and should go through a deprecation cycle to v0.5 |
| Chasing connector / skill count | AD-5 is unchanged. What v0.4 solves is **letting the user add one themselves in 30 minutes**, not us adding 46 |
| Plugin marketplace / remote extension repository | Get the loading and acceptance mechanism working first; v0.4 only does local directory loading |

---

## III. Phase overview

```
P11 ─┬─ Interface-first: llm/types.ts ──┬─ R-a OpenAI-compatible base
     │                          ├─ R-b Anthropic native
     │                          └─ R-c Budget and capability bits
     └─ R-d Reachability gate (independent, no dependency on the interface)
                    │
                    ▼
P12 ─┬─ T-a ToolBus (authorization/budget/audit)
     └─ T-b Real subagent tool loop + remove swarm          ──┐
                    │                                │
                    ▼                                │  P14 Onboarding
P13 ─┬─ C-a contract + replan + frame-level accounting             │  (only depends on P11 streaming,
     └─ C-b findings state machine (fully independent)              │    runs fully in parallel with P12/P13)
                    │                                │
                    ▼                                │
P15 ─┬─ X-a Extension loading + ext verify  ◀─ depends on P12 ToolBus
     └─ X-b Declarative connector + MCP client
                    │
                    ▼
P16  Literature domain reinforcement (arXiv/PubMed via manifest = real acceptance test of the extension mechanism) + release v0.4.0
```

**Critical path**: P11 → P12 → P13 → P15 → P16. **P14 is not on the critical path.**

---

## IV. Phase designs

### 4.1 P11 · LLM Runtime v2 + Reachability Gate

#### R-a/b/c: LLM Runtime v2

Current-state review (v0.3.1): `llm/router.ts` is 254 lines; D-b added timeouts and `fetchImpl` injection,
but it **still has no tool calling, no usage, no streaming, no `response_format`**,
and `SUPPORTED_PROVIDERS` declares 6 providers while only implementing two: kimi and openrouter.

The architecture and type design **carries forward v0.3 document §4.1** (`llm/types.ts` + the `providers/` trio);
this document records only two new constraints added after P10:

1. **`ok=false ⇒ content=""` (AD-13) lands in this phase**. P10's D-4 only did a tactical version
   (the orchestrator checked `res.ok` in four places); the type-layer fix is completed here for good, **and those four `if`s are deleted** —
   otherwise there would be "two lines of defense, fix one and not the other" drift.
2. **Provider capability bits must go into `capabilities --json`**: `{ toolCalling, jsonMode, streaming, usageReported }`.
   An external agent needs to know **before** picking a model whether it can run a tool loop, rather than finding out halfway through.
   This is also a prerequisite for P12 — when ToolBus encounters a model that doesn't support tool calling, it must be able to **explicitly degrade**
   (degrade to a "JSON plan + step-by-step execution" mode with honest disclosure), rather than failing silently.

**Risk and countermeasure**: tool-calling compatibility varies widely among domestic providers.
The countermeasure is that **capability bits are detectable at runtime**, and the degradation path has an independent e2e test — it cannot only work "when the model cooperates."

> **Upstream intel available (added 2026-09-10)**: a source-level investigation of OpenScience v2.0.86's provider layer was done,
> and the per-provider quirks table lives in the local planning directory `spark-research-v0.5-plan/workstreams/provider/PROVIDER_QUIRKS.md`
> (deliberately not checked into the repo; disposition to be decided at the v0.5 review). Three items directly useful for R-a/R-b:
> ① DeepSeek is the only provider that requires **structurally rewriting the tool schema**, and `tool_choice` must be stripped in thinking mode;
> ② OpenRouter will **silently discard the reasoning trace** unless explicitly requested;
> ③ Qwen has almost no dedicated upstream adaptation and its compatibility is unverified — exactly the kind of case our "capability bits detectable at runtime" is meant to catch.
> Check this table before implementing R-a/R-b — don't step in the same hole twice.

#### R-d: Reachability Gate (new, independent lane)

**The problem** (while drafting v0.4, the reachability matrix was measured for all 10 skills; the conclusion is worse than initially assumed):
`protein-analysis` is the **only one of the 10 with all three entry points — CLI / HTTP / MCP — completely absent**, and the only one whose SKILL.md has no CLI example.
Yet `capabilities --json` **broadcasts it as an available capability as usual** — with a description, `triggers` ("what does this protein look like",
"is there an available structure"), a connector list, and a `validation` file list. An external agent reading the triggers would be confident it can invoke it.

So this isn't "missing an entry point" — it's **the self-description surface lying to the outside world** — a direct violation of AD-12, and the existing gate check
only looks for orphan modules, not skill reachability. AD-5's "every skill must have a matching e2e verification to count as done" is also **satisfied on paper only** here: there's an e2e test, but nobody can actually use it.
(Aside: the second item in its `validation` list is one of the 8 `skipIf(!RECORDING)` test cases that has never run this round.)

**AD-5 tightened to** (write into DESIGN):

> The criterion for a skill being "complete" is **e2e verification + at least one reachable production entry point** (one of CLI / HTTP / MCP),
> and that entry point must appear in `capabilities --json`. A capability that only tests can reach is equivalent to not existing.

**Deliverables**:
1. Add an assertion to `narrative_parity.test.ts`: the capability corresponding to every SKILL.md under `skills/`
   must be reachable in at least one of the CLI command table / HTTP route table / `MCP_TOOLS`, and must appear in the capabilities output
2. Add production entry points for `protein-analysis` (one CLI + one MCP tool each), or pull it from the skill directory — **pick one, don't leave it hanging**
3. **V23**: wire `unconsumedWarnings` into the HTTP approval response and the Web approval dialog, **with an added e2e assertion**
   (the approval UI must display content saying "you wrote this but the safety gate never saw it")
4. **V20**: change `index.ts`'s `CONFIG_DIR` to go through `dataDir()`, using the same resolution as `config/index.ts`

> R-d has zero file overlap with R-a/b/c and can run fully in parallel; it is also the only lane in P11 that does **not depend on interface-first**.

### 4.2 P12 · ToolBus + real subagents

Architecture carries forward v0.3 document §4.2 (`AgentToolBus` wraps around P9's `McpToolRunner`, adding authorization/budget/audit).
Revisions after P10:

1. **MCP tools have grown to 29** (v0.2.1 added a few more), and ToolBus's `specs()` must be **sourced from the same place** as
   `MCP_TOOLS`, not maintained as a separate copy.
2. **`MCP_WITHHELD` is directly reused** (the five withheld tools already defined by AD-9), not reimplemented as a separate dangerous-action table.
   AD-14 "subagents never self-approve" = ToolBus also rejects `MCP_WITHHELD` + adversarial tests.
3. **V19 (approval requires an interactive terminal) is done in the same batch as AD-14**: AD-14 blocks the default path,
   while V19 is the technical line of defense (CLI approval requires a TTY or a confirmation token unobtainable in a non-interactive environment). Neither can be skipped.
4. **Remove swarm**: `swarm.ts` / `swarm_types.ts` and their tests.
   Note that the D-12 gate's `ALLOWED_ORPHANS` has a registration entry for it — **after deleting the code, the registration must be deleted too** —
   the gate's "stale entry" assertion will force this (that's exactly what that assertion is for).
5. **V16**: expose the subagent's independent model as a user config item (`SubAgentSpec.model` finally has a real consumer).
6. **Reserve the interface, don't write the implementation (added 2026-09-10)**: v0.5 has already been greenlit to do remote compute
   (BACKLOG V4's launch condition triggered), and it will be ToolBus's next class of consumer — **billable-consequence actions**
   (submitting a Modal GPU job = spending real money). P12 only needs to lock two things down with tests, and doesn't need to write any code for v0.5:
   ① `MCP_WITHHELD`'s rejection has no exception for subagents (the AD-14 adversarial test naturally covers this; later, `compute approve` just needs to be added to the withheld list);
   ② the budget-accounting interface must not hardcode the unit of measure as tokens — leave an extensible pricing dimension, otherwise v0.5 will have to tear it apart and redo it when integrating compute cost.

### 4.3 P13 · Research loop

Architecture carries forward v0.3 document §4.3 (contract stages / replan / `agent_run` record / findings state machine).
Revisions after P10:

1. **`agent_run` is the 9th record type**, and the records table has had `rev` (CAS) and
   `integrityHash` since D-9. New record types must go through the same write path, **and must not bypass integrity checking**.
2. **AD-10's biggest design risk**: if `check(q)` is written too strictly, the agent will judge "not done" forever and spin.
   The countermeasure is **three parallel halt conditions**, all required:
   - `contract.allDone()` — normal completion
   - `noProgress(2 rounds)` — two consecutive rounds with no new node in the evidence graph → halt and report the unfinished stage
   - `budget` exhausted → `stopReason: "budget"`, **explicitly distinct from `done`**
3. **The findings state machine (C-b) has zero file overlap with contract/replan (C-a)**, and runs fully in parallel.

### 4.4 P14 · Onboarding experience

Carries forward v0.3 document §4.4. Two new items after P10:

- **V11, persisting long-task handles to disk, is upgraded to mandatory**: v0.2.1's zero-context external acceptance review already ran into this
  (the task handle lived in the server process's memory, and became invalid the moment the connection dropped). This is the #1 friction point for the external-agent experience.
- **V17 MCP long-task progress reporting** + **V18 `capabilities --probe` caching** are done together (both belong to "visibly working").
- **Local model integration has existing intel available (added 2026-09-10)**: the implementation checklist for OpenScience's `local.ts`
  has been organized in the local planning directory `spark-research-v0.5-plan/workstreams/provider/V05_PROVIDER_DESIGN.md` §c (not checked in).
  Three upstream field pitfalls: local endpoints **must not set a timeout** (cold-loading a large model can take minutes); Ollama's context window must go through
  the `/api/create` alias mechanism rather than a request parameter; Ollama/LM Studio each have their own port presets and differing response shapes. Read it first when doing local models in P14.

### 4.5 P15 · Extension surface

Carries forward v0.3 document §4.5 (three loading strengths + `ext verify` contract-based acceptance + AD-11). Revisions after P10:

**The declarative connector's manifest must map onto the new contract established after D-a**:
"same-named method equals handler" was abolished in v0.3.0; it is now explicit constructor-time `this.handle(toolName, fn)` registration.
Each tool declaration in the manifest compiles into one handler registration, **naturally inheriting D-1's concurrency-safety property** —
this is a direct dividend from v0.3's debt payoff for v0.4, and the manifest design should explicitly exploit it.

`ext verify`'s connector contract tests **directly reuse the invariants of `tests/concurrency/connector_race.test.ts`**:
third-party connectors must also pass the 100-concurrency parameter-mapping-consistency check.

**Three field-tested constraints on manifest expressiveness (added 2026-09-10)**: during v0.5 planning, a staged implementation
investigation was done on 30 candidate data sources (local planning directory `spark-research-v0.5-plan/workstreams/connectors/`, not checked in);
these three should be used as acceptance cases when designing the manifest schema, rather than discovered too late to be expressible:

1. **Parameters must support enum validation** — bioRxiv's `server` parameter only accepts `biorxiv|medrxiv`; a manifest that can't declare an enum can't block dirty input;
2. **Declarative mapping cannot cover response-body branching** — BindingDB returns HTTP 200 with an empty body on no match (not a 404);
   sources like this should stay at the TS loading strength, and the manifest doesn't need to strive for full coverage (that's exactly why the three loading strengths coexist);
3. **The shape of "one fetch, multiple entity types" needs to be split** — OpenTargets has a single endpoint spanning target/disease/drug, three entity types;
   going into the manifest, it should be split into multiple tool declarations rather than made into one do-everything parameter.

### 4.6 P16 · Literature domain + release

Carries forward v0.3 document §4.6 (E-1…E-6). Two new **verification tasks** added (both from the v0.3.1 verification retrospective):

- **Run `tests/integration/` once against the real network** (`RECORDING=1`), re-record the fixtures, and check
  whether the upstream API has drifted — this suite of tests **has never run since it was written**
- **Run a real v0.2.x legacy `records.db` through the migration drill**, confirming D-9's `rev` column migration holds up on a real legacy database

**Rate-limiting budget note (added 2026-09-10, registered as BACKLOG V26, not implemented in P16)**: the connector layer currently only has
a politeness header (`politeness.ts`), **no rate limiter of any kind**. P16's pubmed manifest and the ClinVar / GEO connectors planned for v0.5
both hit the **same host budget** on NCBI eutils — if a rate limiter is ever built, it must be keyed and pooled by host,
not managed per-connector independently, otherwise the four connectors would collectively get hit with 429s.

---

## V. Parallelization plan

### 5.1 Lane division and file ownership

> **The iron rule is unchanged: a file belongs to exactly one lane at any given time.** Report first if crossing a boundary; never self-expand scope.

**P11 (4 lanes)**

| lane | model | exclusive files |
|---|---|---|
| **Interface-first** (must merge in alone first) | Opus 5 | `llm/types.ts` + `llm/router.ts` façade |
| `R-a` OpenAI-compatible base (incl. ollama / vLLM / local endpoints) | Opus 5 | `llm/providers/openai_compat.ts` |
| `R-b` Anthropic native | Sonnet 5 | `llm/providers/anthropic.ts` |
| `R-c` Budget and capability bits | Sonnet 5 | `llm/budget.ts` `llm/providers/registry.ts` the provider section of `capabilities/` |
| `R-d` **Reachability gate** (does not depend on interface-first) | Sonnet 5 | `tests/unit/narrative_parity.test.ts` · `proteins/**` · `skills/protein-analysis/**` · the unconsumedWarnings egress point in `lab/` · `server/routes/lab.ts` · the frontend approval dialog · the CONFIG_DIR section of `index.ts` |

**P12 (2 lanes, Opus 5)**: `agents/toolbus.ts` ‖ `agents/subagent.ts` + `agents/prompt/*.txt` + remove swarm (including removing the gate registration)
**P13 (2 lanes, Opus 5)**: `agents/contract.ts` + replan + `agents/ledger.ts` ‖ `reviewer/findings_store.ts` + CLI (**fully independent**)
**P14 (2 lanes, Sonnet 5)**: distribution packaging (npx/single binary/brew) ‖ wizard + demo + SSE streaming + long-task handle persistence
**P15 (2 lanes, Opus 5)**: extension loading + `ext verify` ‖ declarative connector + MCP client
**P16 (3 lanes, Sonnet 5)**: manifest sources (arXiv/PubMed) ‖ judge cost reduction ‖ metadata fixes + real-network recording + legacy-database migration drill

### 5.2 Lane startup checklist (write into every task brief)

```
① git worktree add ~/Desktop/AI4S/spark-research-<lane> -b feat/<phase>-<lane> feat/<phase>-integration
② bun install --frozen-lockfile
③ uv sync (or link the main repo's .venv) — skip this step and 17 OpenMM cases will silently skip
④ export SPARK_E2E_PORT=<4400 + lane number>
⑤ Only touch files owned by this lane per the ownership table; report first if crossing a boundary
⑥ Do not touch CHANGELOG / BACKLOG / README / DEVELOPMENT_PLAN*; devlog goes only in docs/devlog/<phase>-<lane>.md
⑦ Before opening a PR, run the **full suite**: typecheck + bun test tests/unit/ + tests/concurrency/ + tests/timeout/
   + **bun run test:e2e** + test:py + test:lab
⑧ **Negative controls are mandatory**: revert your own fix, confirm the new test really goes red, write the result into the devlog
⑨ The report must state **which suites failed to run** in this lane (do not count a skip as a pass)
⑩ The target branch is feat/<phase>-integration, not main; do not push to main, do not open a PR against it, do not merge into it
```

### 5.3 Discipline (3 new items on top of the repo's existing 11)

> Recommended to also add to the engineering-discipline section of `docs/DEVELOPMENT_PLAN.md`.

**12. The remote ref must be verified after a push** (new, from this incident)
`git push -q …; echo ok` uses an unconditional echo that masks a push failure. Before opening a PR, run
`git ls-remote --heads origin <branch>` to confirm the remote ref really is the local HEAD;
after merging, run `git diff --stat <local branch> origin/main`, which should be empty.
**Failure that looks like success** — that's exactly how PR #22 merged an empty diff.

**13. Cross-layer changes must run e2e + a consumer cleanup pass** (new, after the v0.3.0 regression)
Any backend change that touches the **externally-facing vocabulary or response shape** (state names, enums, endpoint fields, error codes)
must: ① run `bun run test:e2e`; ② go through the consumer cleanup checklist —
`frontend/workspace/src`, the tool descriptions in `mcp/tools.ts`, `llms.txt`, `skills/*/SKILL.md`,
the `capabilities` output, `docs/`. **Typecheck cannot catch string comparisons.**

**14. Sole merge authority** (new, after the cross-session incident)
At any given moment, only one session holds the authority to merge into `main`. Any other session's output stays parked on its branch.
Before opening a PR, the integration branch must `git fetch` and confirm `origin/main` is its own ancestor,
and re-verify that every existing tag is still in `origin/main`'s history.

### 5.3·Addendum · What to do when a new module is created but you don't have wiring authority (P11 field addendum)

**A real conflict hit in P11**: lane R-b delivered `llm/providers/anthropic.ts`, but the `router.ts`'s
`ADAPTERS` registration was **deliberately withheld** by the main session (both R-b and R-c might touch router,
and withholding it was meant to avoid the P10-style "four lanes each green individually, red combined"). The result was that R-b's new module had
**no production caller at all on its own branch** — running straight into the D-12 orphan-module gate check (that assertion was originally
built to catch `swarm.ts`).

**The gate was right, and withholding the wiring was right too — the conflict is that the two weren't coordinated.** This isn't an isolated case: any
combination of "lane creates a new module + wiring authority sits elsewhere" will hit this, and there are many such combinations in the remaining phases of v0.4
(P12's ToolBus, P13's ledger, and P15's extension loader are all new modules).

**Handling (follow from here on)**:

1. The lane creating the module **itself** adds a registration entry to `ALLOWED_ORPHANS`, with the reason written as
   "**awaiting wiring**: <who> will wire it in <which phase>; this entry must be deleted once wired"
2. When the main session does the wiring, it **deletes that registration entry**
3. The gate's symmetric "stale entries must be deleted" check will force this:
   - Wired in → the entry becomes stale → fails to delete it → red
   - Forgot to wire in → the module is still an orphan → also red

   **Both directions are pinned down — it can't be forgotten.**

> Incidentally, this gives the gate check a use beyond "preventing narrative drift": **it doubles as a wiring checklist**.
> This is an upside AD-12 didn't anticipate — pushing "claims must reconcile with implementation" to its limit,
> such that even a half-finished state like "the module is built but not wired in" gets tracked automatically.

**Template sentence for lane task briefs**:
> If the module you created has no production caller for now (wiring authority isn't yours),
> register an entry in `ALLOWED_ORPHANS` and write clearly "awaiting wiring by whom" — **only add registrations, never change the assertion logic**.

---

### 5.3·Addendum 2 · Must return to a neutral directory before spawning (hit once each by W1/W2)

**Symptom**: when a subagent spawns, it inherits the main session's cwd at that moment. Across both wave W1 and wave W2 I was sitting in a lane's worktree when I dispatched tasks, so all four subagents' pwd was that one lane's directory — **three of them mismatched with their own brief**.

**The consequence is worse than it sounds**: the isolation rule in the task brief ("don't touch other worktrees"), combined with the mismatched cwd, produces a **seemingly reasonable but wrong inference** — the subagent reads the sandbox binding as an assignment signal, and concludes either "the lane I've been assigned is the one at pwd, the brief must be wrong" or "another session is currently working in the directory my brief points to, and going there would cause a collision."
Both W1-c and W2-c stopped for exactly this reason, and **their reasoning was entirely correct given the information they could observe**.

**Putting `cd <absolute path>` on the first line of the brief is not enough to fix this** (that's exactly what W2 did, and it still triggered) — because the contradiction isn't "not knowing where to go," it's "which one to believe when the environment and the instructions contradict each other."

**Approach**:
1. **`cd` back to the main repo before spawning** (`~/Desktop/AI4S/spark-research`), so every subagent inherits a neutral directory;
2. Write the isolation rule precisely in the brief: "**Do not touch other lanes' worktrees or the main repo**; your own lane's workspace is where you belong, regardless of the initial cwd";
3. If a subagent still stops to ask — **that's the correct behavior, don't find it annoying**. This project has hit three "no conflict, no warning, just a silent failure" pitfalls (v0.2.1 bypassed / a PR merging an empty diff / the UI regression), so a subagent proactively flagging a similar risk is a net win.

---

### 5.4 Consumer cleanup checklist (the executable form of Discipline 13)

After changing the backend's externally-facing vocabulary / response shape, confirm each item:

| Consumer | How to check |
|---|---|
| Web workspace | `grep -rn "<old term>" frontend/workspace/src` (**note this is a string comparison — tsc doesn't care**) |
| MCP tool descriptions | `grep -n "<old term>" backend/src/mcp/tools.ts` — these strings are what external agents see |
| Self-describing endpoints | `capabilities --json`, `/api/lab/machine`, etc. **must be derivable from the source of truth**, never hand-written |
| llms.txt | `git diff` after `bun run gen:llms` should be empty (otherwise it means regeneration was forgotten) |
| SKILL.md | `grep -rn "<old term>" backend/src/skills/` |
| Documentation | README / DESIGN / EXTENDING |

**Whatever can be automated goes into `narrative_parity.test.ts`** — the checklist is a manual fallback for humans; the gate check is the real line of defense.

---

## V·Addendum · Wave scheduling for P12–P16 (rearranged after P11)

> **Why rearrange**: §III's dependency graph is at the **phase level** (P12→P13→P15→P16 serial),
> but the real dependencies are at the **task level**, which is much looser. Scheduling by phase leaves a large number of mutually independent tasks waiting for no reason.
> This section repackages the P12–P16 tasks; the phase numbering is kept as a **delivery grouping label** (CHANGELOG /
> milestones are still described by P12–P16), but **execution proceeds by wave**.

### 5·Addendum.1 Task-level dependency graph (redrawn)

```
R-c(budget.ts) ──► T-a ToolBus ──┬─► T-b subagent tool loop ──┐
                                 │                          ├─► C-b replan loop
                                 └─► X-c external MCP client    │
                                                            │
C-a contract stages (depends only on the evidence graph, **not on ToolBus**) ─────┘

X-b declarative connector manifest (depends only on v0.3.0's connector contract) ──► E-1 arXiv/PubMed
X-a extension loading + ext verify (depends only on the existing contract test suite)

The following have **zero cross-dependencies** and can start anytime:
  C-c agent_run frame-level accounting · C-d findings state machine · B-a packaging & distribution ·
  B-b wizard+demo · B-c SSE streaming (depends on P11 streaming, already ready) · B-d long-task handle persistence ·
  E-2…E-6 literature-domain fixes · real-network recording · legacy-database migration drill · remove swarm · V17/V18/V19
```

**There is really only one critical path**: `R-c → T-a → T-b → C-b`. Everything else can be routed around it and parallelized.

### 5·Addendum.2 Four waves (4 lanes per wave, still capped by review bandwidth)

| Wave | lane | Task | Dependency | Model |
|---|---|---|---|---|
| **W1** | `W1-a` | **T-a ToolBus** (the three layers of authorization / budget / audit, wrapped around P9's `McpToolRunner`) | R-c's `BudgetLedger` | Opus |
| | `W1-b` | **C-d findings state machine** (open→addressed→resolved→reflagged + CLI) | none | Sonnet |
| | `W1-c` | **X-b declarative connector manifest** (restricted mapping DSL + SSRF allowlist) | none | Opus |
| | `W1-d` | **B-a packaging & distribution** (`bun build --compile` single binary / npm meta package / brew) | none | Sonnet |
| **W2** | `W2-a` | **T-b subagent tool loop** (`SubAgentSpec` + budget + stopReason flow-back) | W1-a | Opus |
| | `W2-b` | **C-a contract stages** (AD-10: completion is judged by querying the graph, not the model) | none | Opus |
| | `W2-c` | **X-a extension loading + `ext verify`** (three loading strengths + contract-based acceptance) | none (paired with W1-c) | Opus |
| | `W2-d` | **B-b/B-c wizard + demo + SSE streaming** | P11 streaming ✓ | Sonnet |
| **W3** | `W3-a` | **C-b replan loop** (observation flow-back + three halt conditions) | W2-a + W2-b | Opus |
| | `W3-b` | **C-c agent_run frame-level accounting** (the 9th record type, goes through rev + integrityHash) | R-c | Opus |
| | `W3-c` | **X-c external MCP client** (external tools enter ToolBus and capabilities, calls land in the execution record) | W1-a | Opus |
| | `W3-d` | **E-1 arXiv/PubMed via manifest** (**doubles as a real acceptance test of the extension mechanism**) | W1-c | Sonnet |
| **W4** | `W4-a` | **Remove swarm** + pull the README marketing copy + V16 subagent model configuration + V19 approval requiring a TTY | W2-a | Sonnet |
| | `W4-b` | **E-2…E-6 literature-domain fixes** + real-network recording + **real v0.2.x legacy-database migration drill** | none | Sonnet |
| | `W4-c` | **B-d long-task handle persistence (V11)** + V17 MCP progress flow-back + V18 probe caching | none | Sonnet |
| | `W4-d` | Floating slot: absorb overflow items from the first three waves | — | — |

**The serial tail between waves** (main session, cannot be skipped, took up a considerable share of the time in the P10/P11 field tests):
merge integration → close out cross-lane semantic conflicts → wiring (including deleting "awaiting wiring" entries in `ALLOWED_ORPHANS`)
→ the full six-suite run → devlog/CHANGELOG.

### 5·Addendum.3 Insertion points for the three zero-context external acceptance reviews

| Time point | Task | What to look at |
|---|---|---|
| **End of W2** | Ingest literature into the database → create an idea → novelty check → launch a dry experiment and read back the conclusion | After the subagent does the work, has friction for the external agent genuinely decreased |
| **End of W3** | Per `EXTENDING.md`, add a brand-new data source via manifest and pass `ext verify`, **without touching the repo's source code at any point** | Is the extension mechanism truly self-service |
| **End of W4** | On a clean machine, `npx spark-research` walks through a complete research thread | Release criterion |

**The second review must be run by a person/session that did not participate in the development** — validating your own extension mechanism yourself is meaningless.

### 5·Addendum.4 Benefits and costs of wave scheduling vs. phase-serial scheduling

**Benefit**: the critical path compresses from "four phases, P12→P13→P15→P16" to "three waves, W1→W2→W3";
all of P14 and half of P15 move up to W1/W2, and zero-dependency fixes like E-2…E-6 are no longer pushed to the very end.

**Cost (must be faced head-on)**: a single wave touches files across multiple phases at once, so **the cross-lane conflict surface is larger than within a phase**.
The countermeasure is to maintain the file ownership table by **wave** rather than by phase, and to keep the two items already validated in P11:
① files contested by multiple parties (e.g. `router.ts`, `mcp/tools.ts`, `server/app.ts`) are **pulled out of every lane's scope entirely, and wired in centrally at close-out**;
② for a newly created module with no wiring authority, the lane registers it itself in `ALLOWED_ORPHANS` and states clearly "awaiting wiring by whom" (§5.3·Addendum).

**Known contention hotspots** (registered in advance, wired in centrally at close-out):

| File | Who wants to touch it | Handling |
|---|---|---|
| `backend/src/llm/router.ts` | none (already closed out in P11) | — |
| `backend/src/mcp/tools.ts` | W1-a (ToolBus reads MCP_TOOLS) · W3-c (external tool registration) · W4-c (V17 progress) | Read-only consumers don't touch it; whoever needs to write is wired in centrally at close-out |
| `backend/src/server/app.ts` | W2-c (extension routes) · W2-d (SSE endpoint) | Wired in centrally at close-out |
| `backend/src/capabilities/index.ts` | W1-c/W2-c (extensions) · W3-c (external tools) | Wired in centrally at close-out |
| `tests/unit/narrative_parity.test.ts` | Multiple lanes need to add/remove registrations | **Only entries in `ALLOWED_ORPHANS` / `SKILL_ENTRYPOINTS` may be changed, the assertion logic may not be touched** |
| `docs/BACKLOG.md` `CHANGELOG.md` `README.md` | — | **Lanes are forbidden to touch these**; written centrally at close-out |

---

## VI. Verification plan

### 6.1 Phase gate (every phase must pass, no exceptions)

1. `bun run typecheck` clean
2. `bun test tests/unit/` zero regressions (the baseline advances with each phase; v0.4's starting point is **905**)
3. `tests/concurrency/` + `tests/timeout/` all green
4. **`bun run test:e2e` all green** ← the lesson from v0.3.0, cannot be skipped
5. `bun run test:py` + `bun run test:lab` all green
6. **Negative control**: every key test added in this phase must be verified to "go red when the implementation is reverted"
7. `git diff --stat <integration> origin/main` is empty after merging

### 6.2 Phase-specific verification

| Phase | Dedicated adversarial tests |
|---|---|
| P11 | Provider matrix contract (one recorded-and-replayed case each for tool calling / JSON mode / streaming / usage); **a model that doesn't support tool calling must go through an explicit degradation path with an independent e2e test**; the type-layer assertion for `ok=false ⇒ content=""` |
| P11 R-d | Reachable-entry-point assertion for every skill; an e2e test that `unconsumedWarnings` must be visible in the Web approval dialog |
| P12 | Over-privileged tool calls are structurally rejected; when the budget is exhausted, `stopReason:"budget"` rather than `done`; the tool result is genuinely fed back (assert that the second-round prompt contains the first round's result); **a subagent calling `lab_approve` must always be rejected** (AD-14 red line); once swarm is removed, the gate registration disappears in sync |
| P13 | **Fabricated completion**: FakeLLM claims completion but there's no evidence in the graph → `allDone()` is false; **no-progress halt**: two rounds with no new record → halt on round 2 and report the unfinished stage; **honest accounting**: when usage is unavailable, `costUsd: null` + `usageUnavailable`, must not fill in 0 |
| P14 | On a clean machine (no bun / no Python / no key), `npx spark-research` → `demo` shows the evidence graph within 30 seconds |
| P15 | Malicious-extension matrix: manifest declares A but calls B; obtains credentials without a grant; declarative connector injects `file://` / an internal-network address (SSRF); an extension throwing an exception leaves the main process alive with capabilities marked `failed`; **third-party connectors must pass the 100-concurrency parameter-mapping-consistency check** |
| P16 | Real-network recording once, checked against upstream drift; real v0.2.x legacy `records.db` migration drill |

### 6.3 Zero-context external acceptance review (v0.4's primary acceptance method)

This is exactly how v0.2.1 came to light: **an agent that knows nothing about this repo, forbidden from reading the source,
ran the full pipeline using only MCP + llms.txt, scoring 8/10 and exposing three genuine friction points.** This is the highest-signal feedback source in this project.

v0.4 **runs it three times**, not just once at the end:

| Time point | Task | What to look at |
|---|---|---|
| End of P12 | Ingest literature into the database → create an idea → novelty check → **launch a dry experiment and read back the conclusion** | After the subagent does the work, has friction for the external agent genuinely decreased |
| End of P15 | Per `EXTENDING.md`, add a brand-new data source via a declarative manifest and pass `ext verify`, **without touching the repo's source code at any point** | Is the extension mechanism truly self-service |
| End of P16 | On a clean machine, `npx spark-research` → a complete research thread is walked through | Release criterion |

**The second run must be executed by a person/session who did not participate in development** — validating your own extension mechanism yourself is meaningless.

---

## VII. Schedule and model allocation

The unit is a "session" (one full cycle of scope confirmation → delegation → running tests → code review → design-checklist acceptance → PR).
v0.3 field data: P10's four lanes + serial tail ≈ roughly one workday's worth, **of which the serial tail took up a considerable share**.

| Phase | Magnitude | lanes | Primary model | Dependency |
|---|---|---|---|---|
| P11 | 2–3 sessions | 4 (incl. interface-first) | Opus (interface/R-a) + Sonnet (R-b/c/d) | v0.3.1 |
| P12 | 2 sessions | 2 | Opus 5 | P11 |
| P13 | 2 sessions | 2 | Opus 5 | P12 |
| P14 | 2 sessions | 2 | Sonnet 5 | P11 (streaming) |
| P15 | 2 sessions | 2 | Opus 5 | P12 (ToolBus) |
| P16 | 2 sessions | 3 | Sonnet 5 | P15 |

**Allocation rationale unchanged** (v0.3 document §6.2): use Opus for abstract design / original design / security boundaries,
use Sonnet for phases with clearly specified mechanical work and many parallel lanes.
P11's interface-first work and the OpenAI-compatible base are the foundation for the entire version — getting them wrong means three main lines have to be redone together, so it must be Opus.

**Trimming order if needed**: P15's MCP client → P14's brew/curl → P13's findings state machine.
**Cannot be trimmed**: all of P11, P12, AD-10's deterministic completion criterion, P11 R-d's reachability gate.

---

## VIII. Milestones

| Milestone | What can be said publicly once complete |
|---|---|
| End of P11 | "The model is genuinely provider-neutral, and its capabilities can be queried at runtime" + "every claimed capability is actually reachable" |
| End of P12 | "The subagent is a genuine tool-using agent" — all overstated marketing claims retracted |
| End of P13 | **"Completion is judged by the evidence graph, not self-reported by the model"** — the single most publication-worthy line |
| End of P14 | "One `npx` command, zero keys, the full picture in 30 seconds" |
| End of P15 | "Add your own data source, and it runs the contract tests the moment it's installed" |
| P16 / v0.4.0 | Five major functional domains + a real agent runtime + self-service extension — the only one of the three with a closed dry-wet loop |

---

## IX. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Poor tool-calling compatibility in domestic providers | P12 falls short | Capability bits detectable at runtime; the degradation path (JSON plan mode) has an **independent e2e test**, and cannot only work when the model cooperates |
| AD-10's `check()` written too strictly → the agent forever judges "not done" and spins, burning money | P13 becomes unusable | Three parallel halt conditions (allDone / noProgress / budget), and `stopReason` must flow back |
| The declarative connector's mapping DSL keeps growing until it resembles a programming language | P15's complexity spirals out of control | Hard constraint: a restricted JSONPath subset + fixed normalized fields; **if it can't be expressed, write a TS extension** — that's a feature, not a defect |
| External extensions = code execution under the same UID | The security surface expands | Default to pushing declarative (no code execution); TS extensions require `--trust` + fingerprint confirmation; **the documentation must say plainly that this is not a sandbox** (not repeating S-3's overclaiming, "sandbox escaped in one line") |
| The serial tail is underestimated | The schedule becomes unrealistic | v0.3 field data shows the serial tail took up a considerable share; already explicitly counted in §VII |
| Yet another cross-session incident | Work is silently lost | Disciplines 12/13/14; re-verify with `git diff` after every merge |

---

## X. To the maintainers

v0.3 proved two things: **parallel development is workable in this repo** (zero violations of the four-lane discipline,
only one semantic conflict when combined), and **"failure that looks like success" is currently this project's biggest enemy**
— all three incidents share this shape, and not one of them was "the code was written wrong."

So v0.4's verification design is not "write more tests," it's **installing an explicit assertion at every point where silent failure is possible**:
whether the push actually pushed, whether the e2e actually ran, whether a skill can actually be invoked,
whether there's evidence in the graph when the model says it's done, whether an installed extension actually passes its contract.

Functionally, v0.4 does exactly one thing: **make the word "agent" in the README's first sentence true.**
