# Spark Research v0.2 Development and Verification Plan

> Status: Finalized alongside [DESIGN.md](DESIGN.md) · 2026-09-09
> Principle: one branch and one PR per phase, squash merge; tests only ever increase, never decrease; leave a devlog for each phase; verify before moving to the next phase.

---

## 0. Engineering Discipline (applies across all phases)

1. **Branch flow**: no direct pushes to `main`. Each phase opens a `feat/p<N>-<slug>` branch → PR → squash merge → delete the branch.
2. **Test threshold**: before opening a PR, `bun run typecheck` + `bun test tests/unit/` must pass fully; new modules must ship with unit tests; e2e tests run via fixture replay in CI (real network requests only run during local verification, then get recorded and replayed).
3. **devlog**: when each phase completes, write `docs/devlog/P<N>-<slug>.md`: what was done, key decisions, test results (including failures and fixes), and deviations from the design.
4. **Credential discipline**: no credentials ever go into the repo/prompts/logs; run a secret grep on new files before committing.
5. **Model division of labor**: use Fable 5 (main session) for design and acceptance review; implementation tasks may be delegated to Opus 5 subagents, and subagent output must go through main-session review + test verification before it can be merged.
6. **Documentation sync**: when implementation deviates from the design, update DESIGN.md within the same PR — no drift left behind.
7. **Worktree isolation** (added after the P6 incident): while a subagent is developing, the main session **must not** perform any git operations (checkout/branch/commit) in the main worktree; when the main session needs to make parallel changes, use a separate worktree, or wait for the subagent to close out. See devlog P6 for the incident record.
8. **worktrees must always be created under `~/Desktop/AI4S/<repo>-<topic>`** (corrected after the P7 incident): other paths under `~/Desktop/` can become inaccessible mid-session due to sandbox policy, causing uncommitted work to be lost entirely.
9. **Save incremental progress promptly** (added after P7, at the user's request; reinforced after P9): **immediately after creating a new branch, run `git push -u` to establish remote tracking before writing any code**; after that, commit and push after completing each logical chunk. P9 once hit a quota interruption while at zero commits and nearly lost everything. Pushing a feature branch does not violate "no direct pushes to main" — merging still goes through PR + main-session review. This way work isn't lost when a quota interruption or environment failure occurs.
10. **Immediately verify after release that the tag is actually in main's history** (added after the v0.2.1 incident): after cutting a tag, run
    `git merge-base --is-ancestor <tag> origin/main`; if it doesn't hold, the tag has been bypassed.
    **Incident**: `v0.2.1` was tagged at `c5c7b11`, but P10's branch was pulled from the earlier `19a3586` and merged first,
    so main ended up on a different path — the three fixes the tag and Release claimed simply did not exist on main,
    the version number regressed, the regression test file disappeared, and v0.3 would have continued development on top of code missing the fixes.
    **The most dangerous part is that it produces no error**: no conflict, no warning, it just silently vanishes. This was only caught by chance,
    when `/api/health` was glimpsed reporting 0.2.0 during a screenshot — pure luck.
11. **Cross-phase semantic consistency must be asserted explicitly** (added after v0.2.1 × P10): no file conflict ≠ no semantic conflict.
    **Example**: v0.2.1's tool description recommended "set the MCP wait to 900000," while P10's newly added task-lifecycle fallback
    default was only 600000 — each change was correct on its own, but together they gave the wrong recommendation, **and tests were all green on both sides**.
    Functional tests can't catch this kind of contradiction. Any relationship where "two knobs must be turned together" (timeout ceilings, capability flags and their consumers,
    tool descriptions and actual behavior) must be pinned down with a dedicated consistency-assertion test.

12. **Always verify the remote ref after pushing** (added after the v0.3.0 empty-PR incident): `git push -q …; echo ok` uses an
    unconditional echo that **masks push failures**. Before opening a PR, confirm with `git ls-remote --heads origin <branch>` that
    the remote ref matches local HEAD; after merging, `git diff --stat <local-branch> origin/main` should be empty.
    **Incident**: PR #22's branch was never actually pushed — the remote stayed at an old commit, so the PR's
    diff against main was empty, and GitHub went ahead and squash-"merged" it anyway — 32 files / 2027 lines, an entire phase's worth of work, never made it into main, with no error.

13. **Any cross-layer change must run e2e + a consumer sweep** (added after the v0.3.0 UI regression): whenever a backend change touches
    the **public vocabulary or response shape** (state names, enums, endpoint fields, error codes), it must ① run
    `bun run test:e2e`; ② sweep consumers: `frontend/workspace/src`, the tool descriptions in `mcp/tools.ts`,
    `llms.txt`, `skills/*/SKILL.md`, the capabilities output, and docs.
    **Incident**: after v0.3.0 removed `wet_run`, the workspace's execute button still judged availability by the old state name →
    after approval the button stayed permanently greyed out, breaking the wet-experiment loop on the Web UI. **The e2e test case already existed, it simply wasn't run**;
    typecheck couldn't catch it, because that was a string comparison, not an enum.

14. **Single merge authority** (added after a cross-session incident): at any given moment only one session holds the authority to merge into `main`;
    all other sessions' output stays parked on branches. Before opening a PR for an integration branch, you must `git fetch` and confirm
    that `origin/main` is its own ancestor, and re-verify that **all existing tags are still in `origin/main`'s history**.
    **Incident**: another session merged P10's lane branches directly into main, and those lanes had been pulled from before v0.2.1 —
    so v0.2.1's three fixes were silently bypassed.

---

## 1. Phase Overview

```
P0 Design merged into repo (this PR)
P1 Project foundation ──────────► root of all persistence
P2 Literature domain · retrieval and library ────► first half of Domain A (A1/A2)
P3 Literature domain · review and citation verification ──► second half of Domain A (A3) + Domain E citation checker
P4 Co-explore and Novelty ──► Domain A4 + Domain D
P5 Dry-experiment loop ─────────────► Domain B1/B3 + Domain C experiment records
P6 Wet-experiment simulator ───────────► Domain B2
P7 Frontend workbench ─────────────► timeline + project navigation + experiment panel upgrade
P8 Feature close-out ───────────────► report export + README + P8-gate settlement + acceptance criteria review
P9 Extensibility surface and LLM-friendliness ────► EXTENDING + scaffolding + capabilities + MCP + release v0.2.0
```

Dependencies: P1 is a prerequisite for all phases; P2→P3→P4 run serially (progressing within the same domain); P5 and P6 can run in parallel with the literature domain after P1; P7 requires the P1-P5 APIs to be stable; P8 is the close-out.

---

## 2. Phase Details

### P1 Project Foundation

**Scope**
- `backend/src/project/`: Project manager (create/open/list/archive), directory layout `~/.spark-research/projects/<slug>/`
- `records.db` schema: record table (7 types) + edge table (5 edge types) + cross-linking with artifacts (AD-3)
- Credential service: `CredentialStore` inside the daemon (`credentials.json` read/write at 0600, looked up by connector id; AD-2)
- CLI: `spark-research project new|list|open`; sessions belong to a project
- Migration of the existing artifact store: the `project` field changes from a free-form string to a real project reference

**Verification**
- Unit tests: project lifecycle, record CRUD, edge consistency, credential file permissions (0600 assertion), permit set blocking the kernel from reading credentials directly
- e2e: create a project via CLI → session produces artifact + record → restart the process → data is intact and queryable

**Exit criteria**: all tests green; devlog P1 committed.

### P2 Literature Domain · Retrieval and Library

**Scope**
- Connector expansion: OpenAlex, CrossRef, EuropePMC, Semantic Scholar (no key required); AMiner (via the credential service, wiring up the two core endpoints — search/paper-detail — out of its 29 APIs first)
- Cross-source unified retrieval: concurrent queries → DOI/title deduplication → normalized Paper model
- Project Library: `library.db` (papers/authors/tags/notes/reading status) + PDF download pipeline (direct download from arXiv/EuropePMC OA, with a 403 fallback strategy) + checksum
- Citation relationship scraping (OpenAlex citations API)
- BibTeX / CSL-JSON export
- Skills: literature-search, paper-download, library-curation

**Verification**
- Unit tests: deduplication logic (matching DOI / fuzzy title), normalization, BibTeX output format
- Local real-world e2e: one search across 5 sources + real download of 2 OA PDFs into the library; request/response recorded as a fixture
- CI e2e: replay the same pipeline via fixture

**Exit criteria**: real search + download e2e passes and is recorded; the AMiner connector is verified in an environment with a key, and degrades gracefully in an environment without one (explicitly reporting "not configured" rather than erroring).

### P3 Literature Domain · Review and Citation Verification

**Scope**
- Close-reading card pipeline: papers in the library → structured cards (anchored to a record: paper)
- Review draft generation: organized from close-reading cards, citations may only point to papers in the library
- New Reviewer checker: `citation-integrity` (matches draft citations against papers in the library; a mismatch = a hard finding → veto)
- Skill: literature-review

**Verification**
- Unit tests: citation-integrity rules (genuine citation passes / fabricated citation vetoed / out-of-library citation vetoed)
- e2e: 10 real papers → review → deliberately inject one fabricated citation → the Reviewer must catch it (adversarial test)

**Exit criteria**: the adversarial test passes consistently (100% detection rate for fabricated citations, injecting 3 fabrication modes: nonexistent DOI, real title with a false conclusion, a genuine paper outside the library).

### P4 Co-explore and Novelty

**Scope**
- Co-explore session mode: critical-discussion workflow prompt + literature grounding (claims must carry a source or be tagged inferred)
- Idea cards: produced, stored (record: idea), with supporting/opposing literature edges
- Novelty pipeline: claim extraction → dense retrieval (reusing P2's unified retrieval) → comparison report (novel/incremental/existing rating) → citation verification (reusing the P3 checker)
- Skills: idea-coexplore, novelty-check

**Verification**
- Unit tests: claim extraction structure, report schema, rating logic
- e2e bidirectional comparison: (a) take the **core idea of an already-published work** and run novelty check → it must be rated existing and find the original paper; (b) take a **deliberately fabricated combination idea** → it should be rated novel/incremental and given its nearest neighbors

**Exit criteria**: the bidirectional comparison e2e passes; idea cards are correctly linked to literature in the evidence graph.

### P5 Dry-Experiment Loop

**Scope**
- `SimulationPlatform` interface (prepare/submit/poll/collect; AD-4)
- 2 reference implementations: OpenMM (in-process) + a second implementation (GROMACS or a pure-Python simulation script, decided based on the local environment, with the rationale recorded in the devlog)
- Closed-loop state machine: `design → dry_run → collect → analyze → iterate|conclude`, with state persistence (record: experiment) and resume-from-checkpoint
- Kernel integration: simulation output automatically becomes an artifact + observation record
- Skills: dry-experiment, protein-analysis (add a skill and e2e coverage on top of the existing protein connector pipeline)

**Verification**
- Unit tests: full coverage of state-machine transitions, checkpoint recovery, adapter contract mock tests
- e2e: a minimal OpenMM MD task (e.g. water-box equilibration) end to end: design → run → data collection → observation into the graph → kill the process midway → resume and continue

**Exit criteria**: the e2e test including checkpoint recovery passes; both adapter implementations pass fully green on the same shared contract test suite.

### P6 Wet-Experiment Simulator

**Scope**
- Opentrons integration: `opentrons_simulate` replaces `mock_devices.py` as the default wet-experiment backend (the mock is kept for unit tests)
- Protocol compilation target: existing protocol compiler output → an Opentrons Python protocol API v2 script
- approve gate implementation: mandatory CLI/API confirmation before wet-experiment execution (AD-6)
- Wiring the dry/wet closed-loop state machine together: `dry_run → approve → wet_run → collect`
- Skill: wet-protocol

**Verification**
- Unit tests: validity of compiled output (valid if it parses successfully under opentrons_simulate), the safety gate's block list (one example each for over-concentration / incompatible reagents / missing approve)
- e2e: a natural-language protocol ("take a 50µL sample and add it to a 96-well plate, incubate at 37°C…") → compile → safety gate → approve → simulator execution → execution log recorded

**Exit criteria**: at least 2 different types of protocols execute successfully under real `opentrons_simulate`; the safety gate blocks every adversarial sample.

### P7 Frontend Workbench

**Scope** (revised by the user on 2026-09-09: the UI's level of detail should reference the OpenScience workbench, not a smoke-test version)
- **Step one, the API layer** (still the priority): fill out HTTP APIs for all P1-P6 capabilities (project/lit/idea/exp/lab endpoints + SSE session streams), upgrading server/app.ts from its v0.1 form; no capability is allowed to exist only in the UI without an API
- **Step two, upgrade the UI to a SolidJS workbench** (triggered by AD-7's "migrate at P7"): match the experience level and interaction patterns of OpenScience's `frontend/workspace` (a local clone can be studied for its component organization/theming/session-stream rendering — Apache 2.0 allows reference, but the code itself is written from scratch):
  - Left: project switcher + navigation tree for the literature library/idea library/experiments
  - Middle: session stream (including coexplore mode) + rich rendering of close-reading cards/reviews/novelty reports
  - Right: record timeline (filterable by type/time) + artifact/evidence graph browsing
  - Bottom: experiment panel — dry/wet state machine visualization + approve/reject buttons (linked to the decision record)
  - complete light/dark themes, keyboard accessibility, and loading/error states
- Scientific rendering is limited to lightweight forms (tables/curves/run logs); molecular/structural 3D rendering is scheduled for v0.3

**Verification**
- API layer: unit tests for every new endpoint (following the existing server.test.ts pattern)
- e2e: a full browser workflow (create project → retrieve into library → close-reading/review → idea/novelty → dry-experiment approve → wet-experiment simulation → complete timeline rendering), using Playwright or an equivalent
- UI vs. CLI behavior comparison: the same operation produces identical records/artifacts on both sides

**Exit criteria**: the full-workflow browser e2e passes; the UI is entirely a projection of the API; the experience shows no obvious gap compared with the OpenScience workspace (the three subjective items — session stream/navigation/timeline — are reviewed and signed off by the user).

### P8 Close-Out and Release v0.2

**Scope**
- Research report export: evidence graph → Markdown (sectioned into questions/ideas/experiments/conclusions, with the conclusion-card review threshold in effect)
- Skill: research-report
- README rewrite (aligned with the new positioning and the five domains), final check of DESIGN.md, CHANGELOG
- Release acceptance-criteria review: check off each of the 4 items in DESIGN.md §7 one by one, recorded in devlog P8

**Verification**: §7's success criteria serve as the acceptance checklist — in particular, the full walkthrough of a complete research thread (literature → idea → novelty → dry experiment → conclusion → report) is saved as a replayable script for the final e2e.

**Exit criteria**: all 4 acceptance criteria pass. (Revised 2026-09-09: tagging and the Release are moved to the end of P9 — the release must come with a complete extensibility story.)

### P9 Extensibility Surface Review and LLM-Friendliness (added by the user on 2026-09-09, the final phase before release)

> User's original framing: review the places — skill / tool / connector — that let researchers configure and modify things themselves, and wrap and adapt them in an LLM-friendly way.

**Scope**

I. Extensibility surface review (self-service configuration for researchers)
- `docs/EXTENDING.md`: one section per extension point (six total), each section = contract description + minimal runnable example + testing method + file placement location:
  1. **Skill** (`backend/src/skills/<name>/SKILL.md`, standardized frontmatter: name/description/triggers/required connector)
  2. **Connector** (the Connector contract + credentials via CredentialStore, AD-2; two examples, one keyless and one requiring a key)
  3. **SimulationPlatform** (dry-experiment platforms; the P5 contract test suite is reused directly as acceptance for new platforms)
  4. **WetLabBackend** (the wet-experiment execution side; includes V6 implementation notes: non-Opentrons device families need device-language compilation pushed down into the backend)
  5. **Safety gate rules** (pure-function rules; adding one rule = one function + one unit test)
  6. **Prompt and model routing** (the two-layer `agents/prompt/*.txt` structure + an independent model configuration per subagent)
- Scaffolding: `spark-research new skill|connector|platform <name>` generates a template with test stubs
- Consolidating the user configuration surface: `~/.spark-research/config.json` registers everything in one place (default model, the mailto for the politeness header, backend selection), with documentation spelling out clearly what can be changed and what changing it affects

II. LLM-friendly wrapping and adaptation
- **Capability self-description**: `spark-research capabilities --json` outputs a machine-readable manifest (all connectors/platforms/backends/skills/safety rules + each one's input schema and availability status) — an agent can introspect the entire workbench in a single call
- **llms.txt + llms-full.txt** (matching the approach used by OpenScience docs): plain-text, complete documentation that an external LLM can consume directly
- **SKILL.md standardization**: a unified frontmatter schema, validated in CI; agents load it on demand (the skills directory = the LLM's operating manual, not pre-filled into context)
- **MCP server mode**: `spark-research mcp` exposes the core capabilities (lit search/library/idea/novelty/exp/lab/records) as MCP tools — any external LLM agent (Claude Code, other MCP clients) can plug Spark Research in directly as a research toolbox. Dangerous actions of the approve kind retain human-confirmation semantics at the MCP layer
- Tool-description polishing: every MCP tool / API endpoint's description is written to the standard of "an LLM can use it correctly the first time it sees it" (parameter examples + common mistakes + when not to use it)

**Verification**
- The minimal example attached to each of EXTENDING.md's six sections actually runs (CI runs one example skill/connector/rule each successfully)
- `capabilities --json` schema validation + a consistency test against the actual registry (every item in the manifest genuinely exists)
- MCP server: a real MCP client connects and runs the lit search → idea → novelty pipeline end to end; an adversarial test confirming that approve actions require confirmation at the MCP layer
- The llms.txt generation script is idempotent (regenerating after a documentation change produces a clean diff)

**Exit criteria**: external acceptance — using a brand-new Claude Code session (with no context on this repo), relying solely on the MCP connection + llms.txt, complete a "retrieve literature into the library → create an idea → novelty check" operation; all three categories of EXTENDING.md examples pass CI; tag `v0.2.0` + GitHub Release (moved in from P8).

**P9 completion status (2026-09-09)**: the entire scope has been delivered, see [devlog/P9-extensibility.md](devlog/P9-extensibility.md).
The machine-side exit criteria are already covered by `tests/unit/mcp_e2e.test.ts` (a real MCP client runs
capabilities → retrieve into library → idea → novelty → timeline → report end to end, with zero network access and zero real models);
**the human-side external acceptance review (a brand-new Claude Code session connecting via MCP) is left for the main session to carry out**, together with the tag and Release.

| Layer | Tool | Network | When it runs |
|----|------|------|---------|
| Unit | bun test | none | every commit |
| Contract (adapter/connector) | bun test + mock | none | every commit |
| e2e replay | bun test + fixture | none (replay) | CI |
| e2e real | bun test (tagged) | yes | local verification + when recording fixtures |
| Adversarial | dedicated tests (fabricated citations/safety gate samples) | none | CI |
| Python (kernel/lab) | pytest | none | every commit |

**Simulated-testing principles** (the concrete realization of the user's request to "do simulated testing and verification yourself, step by step and logically"):
1. For each phase, write the tests listed in the "Verification" section first, then implement (tests define the acceptance bar)
2. Real external dependencies (network APIs, simulators) are run successfully once locally → recorded → CI always replays them, eliminating flakiness
3. Adversarial tests take priority over the happy path: fabricated citations, safety-gate violations, and checkpoint kills are all first-class test cases

## 4. Execution Approach

- At the start of each phase: the main session (Fable 5) confirms scope → delegates implementation to an Opus 5 subagent → the main session runs tests + reviews code + checks acceptance against the design → PR → squash merge → devlog
- Between phases, sync progress and the next phase's scope with the user once ("requirements to be discussed later" get inserted here: new requirements go into the backlog, and after evaluation are scheduled into a phase or into v0.3)
- The local directory `~/Desktop/AI4S/spark-research` stays synced in real time with GitHub `jimmyag2026-prog/spark-research` (pushed as soon as each PR is merged)
