# Spark Research v0.2 Product Design

> Status: updated alongside implementation · final draft checked at Gate P8 close-out (2026-09-09)
> Upstream inputs: OpenScience architecture analysis, AMiner integration research (2026-09-07), Claude Science product shape, existing v0.1 code assets
> Companion document: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) (development and verification plan)

---

## I. Positioning

**Spark Research is an open-source research workbench for the research community**: researchers drive an auditable research agent with natural language to complete the full loop of "literature research → co-exploration of ideas → experimental verification → data recording → novelty verification → conclusion review → writing," with the whole process local-first and evidence traceable.

One-sentence pitch: **Your research project is a first-class citizen; every step of thinking and every experiment leaves behind an auditable evidence chain.**

### 1.1 Target Users

| User | Core pain point | Spark Research's answer |
|------|---------|---------------------|
| Graduate students / postdocs | Literature research is time-consuming; citation management in reviews is chaotic | Project literature library + review pipeline + citation authenticity verification |
| PIs / lab heads | Hard to verify the credibility of students' conclusions | Research Record evidence chain + Reviewer veto mechanism |
| Corporate R&D (pharma/materials) | Dry-lab and wet-lab data are siloed | Dry/wet closed loop + full-process data recording |
| Independent researchers | Lack a discussion partner; hard to verify the novelty of ideas | Co-explore + Novelty check |

### 1.2 Non-goals (explicitly out of scope for v0.x)

- No cloud multi-tenant SaaS (local-first, single user / single research group)
- No general-purpose IDE / coding assistant (dedicated to research tasks)
- No in-house models (model-agnostic routing, BYOK)
- No literature full-text hosting service (only stores PDFs that the user has legally obtained, to a local library)

---

## II. Reference Frame: What We Absorb, What We Don't

### 2.1 From Claude Science (product shape)

**Absorbed**: the productized expression of the research loop (four categories of work — literature / data / experiment / write-up — plus a review pass); the interaction mental model of "give it a goal and it completes the whole loop."
**Not absorbed**: a hosted closed-source environment. We are local-first; data never leaves the user's machine.

### 2.2 From OpenScience (kernel architecture, already analyzed at the source-code level)

**Absorbed**:
1. **A single research agent + hidden task-type subagents** (explore/execute/review delegated by work type, not split by discipline) — already implemented in v0.1, retained
2. **Two-layer prompt** (provider-neutral system contract + agent workflow prompt) — already implemented in v0.1, retained
3. **Unified Connector contract** (id/domain/search/fetch, organized by discipline domain) — v0.1 has a prototype, strengthened in v0.2
4. **Local-first skill loading** (instruction bundles loaded on demand, not pre-filled into context) — the v0.1 directory is empty, landed in v0.2
5. **Provenance envelope** (every artifact carries lineage) — already implemented in v0.1 as a SQLite version

**Not absorbed**:
- The route of scaling up to 313 skills — we take the route of "fewer but deeper, every skill has e2e verification"
- Tying to a single Modal cloud-compute vendor — keep the provider abstraction, land implementation order as needed

### 2.3 From the AMiner integration research (credential-architecture lesson, drawn from actual testing)

OpenScience's three-layer sandbox isolation (env allowlist / file sandbox / restricted network) causes custom paid data sources to be unusable inside the agent, forcing a fork to modify the source code. **Spark Research turns this lesson into a native design principle**:

> **Credential-layering principle**: all credentialed external access (AMiner, CNKI, paid APIs) happens only inside connectors within the daemon process; the kernel/sandbox subprocess can never obtain the credential body itself — it can only request the daemon to access on its behalf via an `mcp_call` authorized by the permit set. Credentials are stored in `~/.spark-research/credentials.json` (0600) or the system Keychain; they never enter env, prompts, or logs.

This makes paid/authorized data sources first-class connectors, rather than exceptions requiring a security hole to be opened.

### 2.4 Inventory of Existing v0.1 Assets (foundation reused directly)

| Asset | Location | Role in v0.2 |
|------|------|----------|
| Daemon + permit set | `backend/src/daemon/` | Control core, extend credential service |
| Stateful Python kernel | `backend/src/kernels/` | Dry-experiment execution engine |
| Artifact + lineage (SQLite) | `backend/src/artifacts/` | Extended into Research Record storage |
| Reviewer veto (trace-don't-recompute) | `backend/src/reviewer/` | Vehicle for conclusion review + citation verification |
| 11 connectors + registry | `backend/src/connectors/` | Extend the credential layer + literature-domain enhancements |
| Orchestrator (+ swarm) | `backend/src/agents/` | Orchestrator retained; **swarm was deleted in v0.4 (W4-a)** — a v0.1 legacy with zero production callers, `dependsOn` never implemented, `decompose` being three regexes; the review judged it a false claim (BACKLOG V7). Concurrency and delegation are now provided by the ToolBus + real subagents |
| Lab protocol compiler + safety gate | `backend/src/lab/` | Wet-experiment domain, mock → simulator |
| 84 unit tests | `tests/unit/` | Test baseline, only grows, never shrinks (706 at Gate P8 close-out) |
| v0.1's `compute/` task abstraction | `backend/src/compute/` | **Deleted at P8** (an in-memory blocking contract, superseded by `SimulationPlatform`) |

---

## III. Differentiation Thesis (three bets relative to OpenScience / Claude Science)

1. **Project-centric, not session-centric.** OpenScience and Claude Science use the workspace/session as their unit; the real unit of research is the **project** — a project spans months and hundreds of sessions. Spark Research's persistence layer is rooted at Project: the literature library, idea library, experiment records, and conclusion cards all hang under the project and accumulate across sessions.
2. **Full-process Research Record.** It records not just code artifacts, but also **ideas, decisions, observations, and conclusions** — all going into the same evidence graph. Side effect: a natural electronic lab notebook (ELN) + an auditable research trail, directly supporting novelty verification and paper writing.
3. **Dry/wet closed loop.** The protocol compiler + safety gate + device abstraction already have a prototype; together with the simulation-platform connector, they form a closed loop of "AI design → dry-experiment simulation → wet-experiment execution → data feedback → iteration." Neither reference system has this.

---

## IV. Design of the Five Functional Domains

### Domain A: Literature Research and Writing

**A1 Literature retrieval (multi-source aggregation)**
- Connector-layer extension: existing arXiv/PubMed plus newly added OpenAlex, CrossRef, EuropePMC, Semantic Scholar (referencing OpenScience's literature-domain list. P2 real-world testing: anonymous S2 requests persistently hit 429s; for practical use it's recommended to configure a free API key — routed through the credential service, connector id `semanticscholar`; without a key, the unified search automatically degrades to the remaining sources)
- **AMiner connector** (with credentials, via the §2.3 credential layering): 29 APIs already verified usable during research
- CNKI/Wanfang upgraded from placeholders to real implementations (dependent on obtainable API channels; without a channel, remains a placeholder and is explicitly labeled as such)
- Unified retrieval interface: cross-source query → deduplication (DOI/fuzzy title match) → merge and rank

**A2 Personal research-project literature library (Project Library)**
- Each Project has one `library.db` (SQLite): paper metadata, authors, venue, tags, reading status, notes
- PDF download pipeline (reusing verified paper-download experience: direct OA download from arXiv/EuropePMC, bioRxiv 403 self-recovery); PDFs land in the `papers/` directory, with paths + checksums stored in the library
- Citation relationships: intra-library paper cross-citation edges (data from OpenAlex/Semantic Scholar citation APIs)
- Export: BibTeX / CSL-JSON

**A3 Review and writing pipeline**
1. Background research: given a research question → multi-source search → candidate paper list (human review or auto-ingest)
2. Per-paper close-reading cards: each paper generates a structured card (problem/method/conclusion/limitations/relation to this project); the card is a record and carries source anchors
3. Review draft: organized based on close-reading cards, **every citation must link back to a real paper in the library**
4. Citation verification: Reviewer checks whether every citation in the draft exists in the library and whether the content matches (extending existing rules — a natural extension of the existing "detect fabricated citations" test)

P3 landing spec (record-type mapping, no new record types added):
- A close-reading card = a `reading` record (an independent type since P3, separated from experiment `observation`), `evidence=sourced`, `metadata.kind="reading_card"`, with a `cites` edge pointing to that paper's `paper` record; the only inferred field on the card, `relationToProject`, is marked under `metadata.inferredFields` and **does not participate** in the reference baseline for citation verification
- The review draft = an artifact + `artifact` record, `evidence=inferred`, with `derives_from` edges connecting each close-reading card and `cites` edges connecting each cited paper
- Citation markers take the form `[@bibtexKey]`, with the key exactly matching `lit export --format bibtex` (readers can cross-check directly against the .bib)

**A4 Co-explore (co-exploring ideas)**
- Conversation mode: a Socratic discussion around the research question, with the agent proactively searching literature to ground its own views
- Output: **Idea cards** (hypothesis statement + supporting literature + opposing literature + points to verify) into the idea library
- Feedback on drafts: gives literature-grounded critical feedback on the user's existing ideas/drafts (citing real literature, labeling evidence type)

P4 landing spec:
- An Idea card = an `idea` record, `evidence=inferred`, `metadata.kind="idea_card"`; no new record type added
- Evidence-edge direction is read by **semantics** ("A supports B"): `paper --supports--> idea` / `paper --contradicts--> idea`.
  This is deliberately the reverse direction of P3's `cites` (new artifact → cited paper) — to look up an idea's supporting literature, look at its incoming edges
- Two hard gates (at the schema validation layer; a violation triggers one retry, and if it still violates, the card is rejected):
  ① every piece of evidence must either give a bibtex key in the library, or explicitly mark `inferred:true`; a key outside the library is treated as a fabricated citation (same standard as A3-4)
  ② `contradicting` must have at least 1 entry — a "co-exploration" that can produce no counter-evidence is mere agreement; if the library has no counter-evidence, say so explicitly and mark it inferred
- The conversation mode hangs off the orchestrator (`chat({mode:"coexplore"})`), parallel to default chat, and does not go through the plan/execute/review loop

### Domain B: Experimental Verification

**B1 Dry experiments (in silico)**
- Execution engine: the existing stateful Python kernel (RDKit/pandas/numpy already configured)
- **Simulation adapter interface**: a unified `SimulationPlatform` contract (prepare/submit/poll/collect), modeled on the connector pattern
- Capability bit `deterministic`: whether the same spec is bit-for-bit reproducible (pyref=true; OpenMM CPU=false, due to multithreaded floating-point reduction, verified at P5). The observation record carries this bit, and the E1 checker and P8 report use it to choose "recompute reconciliation" or "range reconciliation"
- First reference implementations (2, to prove the interface's generality):
  - Local-process type: OpenMM (molecular dynamics, pip-installable, fully local)
  - Command-line type: GROMACS (if installable locally), or fall back a tier to a Python built-in simulation script as the second implementation
- Further additions on demand: materials computation (VASP/LAMMPS), EDA, etc. — interface first, implementations driven by real user projects

P5 landing spec:
- The two implementations are respectively `openmm` (water-box energy minimization + short NVT equilibration; tested with OpenMM 8.6, which has a PyPI wheel, second-scale on pure CPU) and `pyref` (a damped harmonic oscillator via RK4, **zero external dependencies + has an analytical solution to check against**).
  The second implementation chose pyref over GROMACS: the contract test needs an implementation that runs in any environment,
  otherwise the whole test suite gets skipped in CI whenever openmm happens to be missing, which is equivalent to having no contract test at all
- Both adapters are **subprocess-based** rather than executing inside the kernel: MD tasks routinely take minutes and up,
  and occupying the stateful kernel would block the session to a halt; more critically, the requirement that "the task keeps running even after the orchestrating process is killed" demands that the task be an independent process
- The source of truth for state lives on disk: `experiments/<platform>/runs/<runId>/{run.json,params.json,done.json,stdout.log}`,
  with `prepared/<specHash>/params.json` storing the normalized input. `poll` **checks done.json before checking the pid**——
  a task only exits after writing its results, so if the result exists it is authoritative; PID reuse at worst makes an already-dead task appear "still running" for a little longer,
  and never reports a failure as a success
- The v0.1 `compute/providers.ts` (`ComputeProvider`) is not reused: its `wait()` has blocking semantics with all state
  in memory, which does not carry across processes and is not the same thing as the lifecycle contract AD-4 requires. This module was deleted at P8 (BACKLOG G6) along with
  its v0.1 tests — leaving two "submit a task" abstractions around would only cause the next person to pick the wrong one

**B2 Wet lab experiments**
- Existing: protocol compiler (natural language → device instructions) + safety gate (reagent compatibility / concentration caps / biosafety) + mock devices
- v0.2 target: **replace the mock with the official Opentrons simulator (`opentrons_simulate`)**, running one real protocol compile → simulated execution → result feedback pass end-to-end
- Physical device integration is left for v0.3+ (requires real hardware)

P6 landing spec:
- The compilation target is the **Opentrons Flex** / Python Protocol API v2 (`apiLevel 2.21`), not the OT-2.
  Two reasons: ① opentrons 9.x has removed OT-2 support, and `simulate()` raises a `RuntimeError` directly for OT-2 protocols;
  ② the OT-2 has no absorbance plate-reader module, so "read OD at 600 nm" only has a real module on the Flex, sparing it from degrading into a comment
- Two execution backends: `opentrons_simulate` (**default**, the official simulator) and `mock_devices` (the unit-test backend,
  zero dependencies). The mock validates the pipeline, not protocol legality — a script that opentrons refuses to parse would still "run successfully" on the mock,
  so the default must be the real simulator
- **Never pretend to have hardware that Opentrons doesn't have**: centrifugation, non-quad-wavelength readings, incubation below 37 °C, off-deck liquid dispensing are all compiled to
  `[spark-note]` comments and marked `execution: "manual"`; in the run log this is a note, not an execution record
- Run-log anchoring: before every step the compiler injects `protocol.comment("[spark-step] <id> <action>")`;
  structured parsing binds every command back to a specific step in the compilation artifact via this anchor, without depending on opentrons's own wording
- `protocolHash` = sha256(the generated script source code), the source deliberately excludes a compile timestamp — the approve gate approves this
  hash; if it included a timestamp, every compile would produce a different hash and the approval would forever be stale
- The safety gate was split from three sequential `if`s into **four mutually independent pure-function rules** (`chemical_compatibility` /
  `concentration_limit` / `biosafety` / **newly added `volume_capacity`**). `volume_capacity` consumes the compiled artifact:
  "cumulative well overflow" is invisible at the natural-language layer — it's only knowable after summing the deck layout
  - **v0.3.0 (P10 D-8) spec convergence**: "four rules" refers to the fact that the rules themselves exist and each has its own adversarial tests,
    not that all four are actually active on the natural-language main pipeline. In practice: `volume_capacity` is trustworthy throughout;
    `chemical_compatibility`'s word list has been expanded to cover both Chinese and English plus molecular formulas but is still limited;
    the fields `concentration_limit` / `biosafety` require are never produced by the compiler, so they **idle permanently on the main pipeline**.
    The adversarial tests were originally written by manually injecting via `withReagents()` to validate the rule itself — that validated the rule, not the wiring.
    The compensating mechanism is `unconsumedWarnings` (see `lab/protocol.ts`): when a sentence contains a quantity/reagent/condition
    that no rule consumes, an explicit warning is produced and is forced to display before approval.
    **"A rule can be tested in isolation" does not imply "the rule is active on the pipeline" — this is the single most important lesson from this round of external review.**

**B3 Dry/wet closed-loop engine**
- State machine: `design → dry_run → (approve gate) → approved → (execution gate) → executing → collect → analyze → iterate | conclude`
  - **v0.3.0 (P10 D-10)**: the original `wet_run` state simultaneously represented "approved and awaiting execution" and "currently executing";
    it was split into `approved` / `executing`. The second gate (`approved → executing`) is claimed atomically by `execute()` using
    an optimistic-concurrency CAS, **consuming the approval in that same moment** — a re-run always requires re-approval,
    with no exception after a crash and restart. Both gates have a machine-readable representation at `/api/lab/machine` (`approvalGate` / `executionGate`)
- Each iteration is one Experiment record, with all inputs/outputs/parameters going into the evidence graph
- Resumable after interruption: state is persisted to Project storage, recoverable after a process restart
- Human-in-the-loop: an approve gate is mandatory before wet-experiment execution (passing the safety gate ≠ automatic execution)

P5 landing spec (dry-experiment half; `wet_run` and the approve gate left for P6):
- 7 states: `design / dry_run / collect / analyze / concluded / iterated / failed`.
  `iterate` and `conclude` are implemented as **terminal states** rather than action names — the semantics of iterate is "this experiment ends here,
  a new one starts," and the new experiment is a new experiment record connected back to the old one via a `supersedes` edge
- Only 7 legal transitions (`design→dry_run`, `dry_run→collect|failed`, `collect→analyze`,
  `analyze→concluded|iterated`, `failed→dry_run`); anything off the table is rejected outright, with **no "helpful auto-correction"**
- State write-back always goes through the narrow `RecordStore.update()` interface (a spec set at P4: lifecycle fields are mutable,
  `type/evidence/origin/artifactId/createdAt` are not); every transition leaves a timestamp in
  `metadata.history` and `metadata.timestamps`
- Three cases of resumption after interruption, distinguished by `resume()`: **task still running** (no done.json and the pid is alive) → stays dry_run;
  **task already completed** (done.json exists) → goes straight to collect; **task lost** (no done.json and the pid is gone) →
  marked `failed` with `recoverable=true`, retryable with a fresh run.
  "Killed alongside the process" and "the computation itself crashed" must be distinguishable — the former just needs a re-run, the latter needs a parameter change
- Evidence graph: `artifact record --derives_from--> experiment` (one per output), `observation --derives_from--> experiment` and each artifact record,
  `conclusion --derives_from--> observation/experiment`.
  The experiment's evidence is `inferred` (the design is inferred), while the observation is `computed` (the result is computed)
- At P5, conclusion cards land with only a minimal structure and `review` is always `pending` (the full review threshold is described in Domain E2/P8)

P6 landing spec (wet-experiment half + approve gate):
- Wet experiments use **a separate state machine**, with 11 states: `design / compile / safety_check / awaiting_approval /
  wet_run / collect / analyze / concluded / iterated / rejected / failed`, with 18 legal transitions.
  This is **deliberately kept as a separate table** from the P5 dry-experiment state machine: the two chains have different state sets, and P5's transition table is locked down by a suite of exhaustive tests;
  adding states into it would quietly change that suite's semantics. What the two share is record storage, edge semantics, and
  the narrow `RecordStore.update()` interface — those are what should be reused
- **AD-6 lands in the transition table**: `wet_run`'s only incoming edge is `awaiting_approval → wet_run`,
  and only `approve()` ever takes this edge. Once the safety gate passes, `safetyCheck()` makes two transitions in sequence
  (`compile → safety_check` and `safety_check → awaiting_approval`),
  so "the gate passed" and "stopped, waiting for a human" are kept distinguishable on the evidence graph
- Approve / reject each produces a `decision` record (`evidence=inferred`, `derives_from` edge connecting to the experiment),
  with metadata recording **who / when / which protocolHash was approved**; the body lists the step table approved in that version and the safety-gate conclusion at that time
- **A recompile always clears any existing approve/reject and safety-gate conclusions**: once the protocol changes, an old approval cannot carry over across versions.
  There is a second line of defense — `execute()` re-compares the approved hash against the current compiled artifact's hash before execution,
  which guards against paths outside the state machine (someone directly editing a record, or concurrent compilation)
- The dry/wet closed loop connects two paths: a dry experiment at `analyze` → the dry chain transitions to `iterated`, and the wet chain picks up via `supersedes`;
  a dry experiment already `concluded` → connects only via `derives_from` (the conclusion holds, taken forward to be verified by the wet experiment)
- The wet experiment's execution output has an observation `evidence` of **`observed`** (the run log records what the device did),
  in contrast to the dry experiment's `computed`. Simulator execution likewise counts as observed, but the body text and metadata explicitly state
  "hardware is simulated" — the data's provenance must be distinguishable by whoever reads the graph
- Wet-experiment simulation is a second-scale synchronous task (measured at 30–60 ms per protocol), so `execute()` awaits the subprocess's completion
  rather than doing the detach + poll approach from P5. Disk is still the source of truth (`protocol.py` / `runlog.json` / `done.json`
  are atomically written from the python side), so switching processes can still pick it back up

### Domain C: Full-Process Data Recording (Research Record)

**C1 Data model** (extending the existing artifact/lineage architecture, into the same graph)

```
Record types:
  idea         idea card (from Co-explore or manual)
  decision     decision point (why option A was chosen over B)
  experiment   experiment (dry/wet, including parameters, state-machine state)
  observation  observation (raw finding produced by an experiment)
  reading      close-reading card (a structured reading note on a paper)
  conclusion   conclusion card (claim + evidence + limitations + review status)
  paper        literature (a citation anchor for a paper in the library)
  artifact     artifact (existing: code/figures/data files, with lineage)

Edge types:
  supports / contradicts / derives_from / cites / supersedes
```

- Every record carries: type, content, timestamp, source (session/cell/connector call), and an evidence-type label (observed/sourced/computed/inferred — this classification is already defined in the existing core.txt)
- Storage: `records.db` (one per Project), cross-linked with the `artifacts` table via id

**C2 Timeline and export**
- Project timeline view (frontend): a record stream filterable by time/type
- Export: Markdown research report (organized by the evidence graph: question → idea → experiment → conclusion, each with an evidence link); PDF may be added later

P7 landing spec:
- Timeline endpoint `GET /api/records`, filter dimensions `type` (multi-select) / `evidence` / `session` / `since` / `until`,
  paginated via `limit` + `offset`. The filter predicate is factored into a single source of truth inside `RecordStore`, shared by `list()` and `count()` —
  otherwise "this page" and "the total count" would be two separate specs, and the total would contradict itself while paging
- The evidence subgraph `GET /api/records/:id/graph?depth` (1–5), rendered on the frontend with a **deterministic ring layout**:
  a force-directed layout looks different every time it opens and screenshots won't match, unsuitable for an audit-grade graph
- Record detail includes the artifact content (AD-3's id cross-linking retrieved in one shot at the API layer)

P8 landing spec (report export, `backend/src/report/export.ts`):
- Sections: I. Question (project description + idea cards' openQuestions + literature-base statistics) / II. Ideas (each idea card's
  hypothesis, novelty status, supporting and opposing literature, following supports/contradicts edges) / III. Experiments (dry/wet experiment status,
  platform or backend, hypothesis, summary, observations) / IV. Conclusions (**only cards with review approved**) / V. To be verified
  (pending and vetoed, each listing the hard finding blocking it) / Appendix A Evidence index / Appendix B References
- **The body text is entirely rendered by code, never passing through the model.** Letting the model write the report would be handing it a chance to alter the data;
  the same discipline is already applied to experiment records and novelty reports
- Every statement carries a record id, so readers can use `conclusion show <id>` or `GET /api/records/<id>` to cross-check the original record;
  every id in Appendix A must be resolvable in records.db (guarded by a test — no ghost entries allowed)
- Capability bits feed into wording: `deterministic=false` → "range/trend reconciliation"; `simulated=true` → the conclusion title carries
  `[simulated data]` with an appended note that "the simulator does not verify biology." Mixed evidence takes the most conservative label
- Exit points: `spark-research report export|stats`, `GET /api/report[?format=markdown]`, the workbench's export button

### Domain D: Novelty Verification and Organization

**D1 Novelty check pipeline**
1. Claim extraction: extract testable statements of novelty from idea cards or conclusion cards (P4: 1–5 statements, each paired with 2–3 English search queries)
2. Dense retrieval: multi-source search targeting each claim (including semantic near-neighbor search, via Semantic Scholar/OpenAlex related-paper APIs)
3. Comparison report: for each claim, list the closest existing work + similarities + differences + a novelty rating (novel / incremental / existing, with evidence attached)
4. **Rating-validation layer (added at P4, deterministic code)**: the model's rating must be constrained by computable features of the search results, otherwise "novelty" reduces to letting the model grade its own idea. Rules are in the table below
5. Reviewer re-verification: every "existing work" citation in the report must genuinely exist (via the same citation-verification pipeline as A3-4; knownKeys = library keys ∪ this search's candidates)

Rating-validation rules (each is a pure function, unit-testable):

| Rule | Trigger | Consequence |
|------|------|------|
| `no_candidates` | The search returned zero candidates | Conclusion unusable (**failing to find something ≠ novel**) |
| `rating_without_nearest` | Candidates exist but the nearest neighbor is not listed | Conclusion unusable |
| `unknown_work` | Cites a key outside the candidate list | Conclusion unusable |
| `existing_without_high_affinity` | Rated existing but no highly similar candidate is cited | Downgraded to incremental |
| `novel_despite_high_affinity` | A highly similar candidate exists but was rated novel | Upgraded to existing |

"Similarity" is a deterministic computation (content-word coverage between the claim/search query and the candidate's title + abstract), not a model-assigned score; the report lists both the model's rating and the corrected rating.

**D2 Coupling with the idea library**: every Idea card has a novelty status field (unchecked / checked-novel / checked-incremental / checked-overlap); the check result is attached to the evidence graph as a record.

P4 landing spec:
- The report = an artifact + `artifact` record (`metadata.kind="novelty_report"`, `evidence=inferred`), `derives_from` edge connecting to the idea, `cites` edges connecting to matched candidate papers within the library
- Status takes the most conservative value: if any claim is `existing` → checked-overlap; else if any is `incremental` → checked-incremental; if all are `novel` → checked-novel
- If any claim's conclusion is unusable → the status **remains unchecked**, but the report pointer is still written back to the idea ("checked but couldn't determine" must be distinguishable from "never checked")

### Domain E: Conclusion Analysis and Review

**E1 Reviewer strengthening** (layered on top of the existing veto mechanism)
- Existing: lineage version-conflict detection (stale_input/version_mix), trace-don't-recompute, veto completion
- New checkers (each an independent rule, unit-testable):
  - Citation authenticity (serving domains A/D) — landed at P3 as `citation-integrity`: a key outside the library (whether a fabricated key or a real work outside the library) = hard veto; a conflict with a close-reading card = soft (LLM-assisted, marked inferred); a strong assertion with no citation = soft
  - Data-conclusion consistency: whether the observation cited by a conclusion card actually exists in the execution record
  - Statistical plausibility hints (soft finding): heuristic hints on sample size, multiple comparisons, and p-hacking patterns
- Position-weighted retention: a claim in a figure/report is held to a stricter standard than one in chat.
  **Exception**: `citation-integrity` findings' severity is defined by the rule itself and is not subject to position weighting — otherwise every soft hint in a review draft (text/markdown) would get upgraded to a veto, directly conflicting with "soft only hints, never vetoes" (P3 decision D3)

**E2 Conclusion card**
- Structure: claim + evidence list (record links) + limitations + confidence + review status (pending / approved / vetoed)
- Only conclusion cards with review approved can enter the "conclusions" section of the exported report (vetoed/pending cards go to the "to be verified" section)

P8 landing spec (`backend/src/conclusion/` + `backend/src/reviewer/conclusion_rules.ts`):

Three new checkers (in the same form as `citation-integrity`: zero IO, unit-testable, **exempt from position weighting** —
a conclusion card's body is markdown, and position weighting would upgrade every soft to a veto, wrecking "heuristics only hint, never veto"):

| rule | severity | acceptance criterion |
|------|--------|------|
| `data-consistency` | hard / soft | evidence must be an observation that genuinely exists within this project: broken link / cross-project / wrong type / zero evidence = hard; missing runId and experimentId anchors (manually registered), or no derives_from edge connecting it on the evidence graph = soft |
| `capability-labeling` | hard | citing an observation with `simulated=true` without labeling it in the claim/limitations = hard; evidence coming from a `deterministic=false` platform yet claiming bit-for-bit/complete consistency = hard |
| `stats-plausibility` | **soft only** | heuristics: sample size < 6 / multiple comparisons uncorrected / p ∈ [0.04, 0.05] / a strong causal claim + a weak evidentiary basis. Every finding carries `heuristic: true`; both false positives and false negatives are expected |

- **The ruling logic is non-negotiable**: any hard → `vetoed`; zero hard → `approved`. There is no path
  for "manually override a hard" — the three hard rules are all verifiable factual judgments, not matters of taste; in the reverse direction, a `--veto` is provided
  (a human blocking a conclusion that would otherwise auto-pass, with a mandatory reason)
- Every review produces one `decision` record (`kind=conclusion_review`, `derives_from` → the conclusion card),
  recording who, when, what was ruled, and on which findings it was based. When the CLI falls back to `$USER`, `actorSource` records `env:USER`;
  HTTP with no actor returns a 400 directly and records `http:explicit` (a P7 addition to AD-6)
- **The report reflects the review status already recorded on the card, not "would it pass if run right now."** Not reviewed means not reviewed —
  the report does not press the approve button on the reviewer's behalf
- The `review` field is backward-compatible with the bare-string form from P5/P6; anything unparseable falls back to `pending` —
  a review field that can't be understood must never be treated as approved

---

## V. System Architecture

### 5.1 Layer diagram

```
┌────────────────────────────────────────────────────────────┐
│  Interface layer                                            │
│  CLI (full functionality) · Web workbench (project nav+session+timeline+experiment panel) │
│  MCP server (P9: 24 tools, for external agent integration; approval-type actions deliberately not exposed) │
│  ↕ HTTP API (P7: domain endpoints + long-task handles + SSE, both UI and MCP are projections) │
├────────────────────────────────────────────────────────────┤
│  Agent layer (TypeScript)                                    │
│  research agent (the only one visible to the user)          │
│   └ task-type subagents: explore / execute / review (existing) │
│     + literature / lab (newly configured, same delegation mechanism) │
│  Two-layer prompt: core.txt (provider-neutral) + workflow prompt │
├────────────────────────────────────────────────────────────┤
│  Daemon control layer (TypeScript, the only credential-holding process) │
│  permit set · credential service (new) · Project management (new) ·  │
│  Record/Artifact storage · execution records · Reviewer      │
├────────────┬──────────────┬──────────────┬─────────────────┤
│ Kernel layer│ Connector layer│ Simulation  │ Lab layer        │
│ Python      │ Lit.×8 Protein×3│ adapter interface│ protocol compiler│
│ (stateful)  │ Gene×3 Chem×2  │ +OpenMM etc. │ +safety gate     │
│ control_repl│ +AMiner(credentialed)│         │ +Opentrons simulator │
├────────────┴──────────────┴──────────────┴─────────────────┤
│  Storage layer (local-first)                                 │
│  ~/.spark-research/projects/<slug>/                          │
│    project.json · library.db · records.db ·                 │
│    papers/ · artifacts/(incl. artifacts.db) ·                │
│    experiments/<platform>/{prepared,runs}/  (P5 simulation state source of truth) │
│  ~/.spark-research/state.json (current project + session→project) │
│  ~/.spark-research/credentials.json (0600, daemon-only)      │
│  ~/.spark-research/config.json (P9: config source of truth, env > file > default)│
└────────────────────────────────────────────────────────────┘
```

### 5.2 Key Architecture Decisions (ADR summary)

| # | Decision | Rationale |
|---|------|------|
| AD-1 | Project is the root of the persistence layer; sessions hang under a project | The unit of research is the project; differentiation thesis §3.1 |
| AD-2 | Credentials only ever live in the daemon; the kernel accesses them via `mcp_call` on its behalf | Lesson from the AMiner research; credentials must never enter the sandbox/env/prompt. P1 landing spec: the daemon's `credentials` method only returns "whether configured + field names," never the value body; a kernel without that permit can't even obtain the metadata |
| AD-3 | Record and Artifact are the same graph in different tables, cross-linked by id | Reuses the already-verified lineage mechanism, avoiding a two-graph inconsistency. P1 landing: `records.artifact_id` → `artifacts.id`, and `artifacts.project_slug` points to a real project |
| AD-4 | Simulation adapter is independent of connector | connector is data reading (idempotent), simulation is a long-running task lifecycle (prepare/submit/poll/collect) — different contracts |
| AD-5 | Fewer, deeper skills: a skill is only considered complete when it has matching e2e verification | A differentiated response to OpenScience's "uneven quality across 313 skills" |
| AD-6 | A mandatory human approve gate before wet-experiment execution | The safety gate is necessary but not sufficient; physical-world actions are not auto-approved. **P7 addition (HTTP layer stricter than CLI)**: when the CLI lacks `--actor`, falling back to `$USER` is honest (it really is the person who typed the command on this machine); HTTP is **not** allowed an env fallback — the service process's OS user has nothing to do with the person clicking "approve," so a missing `actor` returns a 400 directly, with `actorSource` recording `http:explicit` for audit disambiguation. Note that this is currently the "whoever claims to be who" model appropriate to a single-user local scenario; this must be replaced with real identity once multi-user support is built |
| AD-7 | Frontend stays vanilla JS through P7; migrates to SolidJS starting at P7, matching the OpenScience workspace experience (user-scheduled on 2026-09-09), API-first | CLI/API is the source-of-truth for capability, the UI is a projection. **Already landed at P7**: SolidJS + Vite (dependencies are only solid-js/vite/vite-plugin-solid; Markdown, charts, and the evidence graph are all hand-rolled), the build artifact is served statically by the server, artifacts are not checked into git, and when missing the UI path falls back to a 503 + build instructions while the API keeps working normally. UI/CLI behavioral parity is checked in `tests/unit/ui_cli_parity.test.ts` |
| AD-8 | Anywhere "the model produces a conclusion, and the conclusion drives downstream action" must have a layer of deterministic code constraining it via computable features (P4's rating-validation layer is the first instance) | LLM judgment can serve as input, but cannot be both player and referee. The constraint layer must be zero-IO, pure functions, unit-testable, and must retain both "the model's original ruling" and "the corrected ruling" in the artifact |
| AD-9 | **The MCP exposure surface is cut by "who bears the consequences," not by "what's technically feasible"** (added at P9) | `lab approve/reject/simulate` and `conclusion review` are not made into MCP tools: if an external agent could approve on its own, it could compile the protocol, approve it, and execute it all by itself, and AD-6's approve gate would degrade into a comment; conclusion review is the same — it is the last gate on credibility. Landing requires three things: ① the withheld list is **explicit data** (`MCP_WITHHELD`), surfaced in the capabilities output and the server instructions, so an external agent sees the boundary at a glance; ② adjacent read-only capabilities remain open as usual (`lab_status` / `conclusion_get`'s pre-assessment) — the refusal is precise, not a blanket cut; ③ **a structural defense** — a test that enumerates request constructions against every exposed tool and asserts that none of them can reach an approval-type endpoint, guarding against "sneak past it under a different name." <br>**Main-session ruling (v0.2.0)**: the MCP tool list is a **declaration of capability, not an access-control mechanism**. The real access control lives elsewhere (the daemon's permit set, file permissions, the physical device requiring a human to press it). An agent with Bash access genuinely can route around it and call the CLI directly — we acknowledge this rather than pretending it's blocked. What this boundary actually does is three other things: the **default path** (an agent's first instinct is "what tools do I have," and auto-approval isn't in that default reachable set), **making intent explicit** (routing around it requires actively constructing a command — a self-evident "I know I'm bypassing the design" trace that's visible to the user at the permission layer), and **attribution of responsibility** (a call made via MCP is a capability we authorized; a bypass via Bash is a consequence of the Bash permission the user granted). So this is one layer of defense in depth, not the only layer — claiming it stops a deliberate bypasser is security theater, but "since it can be bypassed anyway, it isn't worth doing" is equally wrong: defaults determine 99% of behavior. If truly blocking the bypass is the goal, the correct fix isn't to harden the MCP layer, but to require at the CLI layer that approvals come only from an interactive terminal (see BACKLOG V19) |
| AD-12 | **Every capability claimed publicly must be machine-verifiable** (added in v0.3.0, gated by `tests/unit/narrative_parity.test.ts`) | The single biggest finding from the external review was "narrative running ahead of implementation": the README advertised a 100-concurrency swarm while `swarm.ts` had zero callers in production code, and the architecture diagram claimed 18 connectors when there were actually 17. This kind of drift **produces no error** — it compiles, all tests are green, and only a human reading closely notices the mismatch, so relying on self-discipline is unsustainable. The gate does three things: ① **orphan-module detection** (a production-code module with zero referrers must be registered with a stated reason, and the allowlist may only shrink, never quietly grow); ② document-stated counts are checked against the runtime source of truth; ③ **self-describing endpoints must be derivable from the source of truth** — the two gates of `/api/lab/machine` are computed from the transition table for comparison, rather than hand-written (P10 actually hit this: after D-10 split the states, the endpoint still claimed `to: "wet_run"`, so AD-6's machine-readable representation was lying externally with every test green). <br>**Numbering note**: AD-10 / AD-11 are reserved for v0.4's P13 (completion determined by querying the graph, not the model) and P15 (only counts as "installed" once it has passed through the contract), see `docs/DEVELOPMENT_PLAN_v0.3.md` §VIII |
| AD-15 | **The raw layer is append-only and never modified; the evidence graph is a derived layer** (added in the v0.7 proposal, landed in W7-D0/D1, design in `DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md`) | After three rounds of external acceptance review and B2's three rounds of empirical runs, it was discovered that connector raw responses were discarded before `JSON.parse`, that only a hash of the LLM's original text was kept, and that `RecordStore.update()`'s overwrite left no trace of the old value — once normalization logic changes, old results can no longer be recomputed, and the research-process data is untraceable. Underneath the mutable projection (which the state machine requires) there must be an immutable log; L0 raw + records_journal satisfies audit and recovery needs without doing full event replay (the 9 state-machine call sites are not rewritten) |
| AD-16 | **Data with `provenanceClass = upstream` never enters any shared collection** (added in the v0.7 proposal, gated at G6) | Upstream mirrors (especially credentialed-protocol AMiner/CNKI/Wanfang and public APIs under non-commercial terms) are not a sellable asset; only derived / user_authored / model_generated data whose license permits it may be exported for-sharing. Upstream nodes appear in exports as stubs that preserve edges but not content. AD-13/14's numbering is explained in `DEVELOPMENT_PLAN_v0.4.md` |

### 5.3 Skill catalog (v0.2 first batch, 10 in total)

| Skill | Domain | Verification method |
|------|-----|---------|
| literature-search | A | real multi-source retrieval e2e (fixtures replayed in CI) |
| paper-download | A | real arXiv+EuropePMC downloads (existing verified experience) |
| library-curation | A | unit tests on ingest/dedup/BibTeX export |
| literature-review | A | 10 papers → review → citation verification, all passing |
| idea-coexplore | A | conversation produces an Idea card + literature-grounding check |
| novelty-check | D | idea in a known field → comparison report → citation-authenticity verification |
| protein-analysis | B | UniProt/PDB/AlphaFold pipeline (P5: real recorded fixtures replayed as e2e, 12 cases) |
| dry-experiment | B | OpenMM minimal MD task end-to-end (P5: contract tests ×2 implementations + real SIGKILL recovery e2e) |
| wet-protocol | B | protocol compile → Opentrons simulator execution (P6: 2 protocol classes real-simulator e2e + safety-gate 4-rule adversarial matrix + approve-gate unit tests) |
| research-report | C/E | evidence graph → Markdown report, conclusion-card review threshold in effect (P8: three-checker unit tests + report-section attribution + full-chain rehearsal script) |

### 5.4 Model routing

- Stays model-agnostic (existing LLMRouter: kimi/openai/anthropic/deepseek/qwen/openrouter)
- Subagents can be configured with an independent model (heavy tasks use a stronger model, retrieval/summarization uses a faster model). Checked at P9: this layer is currently **configured in code**; exposing it as a user-facing config option is logged in BACKLOG V16
- The default model stays routed through OpenRouter, with the user supplying BYOK

## 5.5 Extension Surface and Self-Description (P9)

- The contract, minimal runnable example, testing method, and file location for the **six extension points** (Skill / Connector / SimulationPlatform / WetLabBackend / safety-gate rules / Prompt and model routing) are in [EXTENDING.md](EXTENDING.md)
- **Scaffolding**: `spark-research new skill|connector|platform` generates test stubs that are runnable on the spot (CI actually runs them once)
- **Capability self-description**: `spark-research capabilities [--json] [--probe]`, **generated entirely from the real registry** with a bidirectional consistency test (every item in the listing can be instantiated; every item in the registry appears in the listing). Availability is split into a static tier (zero IO) and a probe tier (spawns a subprocess), kept separate
- **Config-surface close-out**: `~/.spark-research/config.json` + one settings table (`backend/src/config/index.ts`) serve as the single source of truth, with precedence env > config.json > default; credentials and settings share the same file but are labeled `secret`, and values are never printed and never enter env
- **SKILL.md frontmatter standardization**: three newly required fields — `triggers` / `connectors` / `validation` — with schema validation running in CI; `validation` turns AD-5 from a slogan into an actual gate (the validator checks the disk to confirm the test files exist)
- **llms.txt / llms-full.txt**: idempotently generated by `bun run gen:llms`, with CI enforcing sync with the docs
- **Naming fix**: the connector base class `MCPConnector` → `HttpConnector` (unrelated to the MCP protocol; a v0.1 historical holdover). The old name is kept as a deprecated alias; its removal is logged in BACKLOG V15

---

## VI. Risks and Mitigations

| Risk | Mitigation |
|------|------|
| CNKI/Wanfang have no public API | Keep as placeholders + document it explicitly; AMiner covers the main path for Chinese-literature search needs |
| Simulation platforms vary widely; the adapter is over-abstracted | Validate the contract with 2 reference implementations first, without presupposing a 3rd |
| Evidence-graph complexity slows down daily use | Record writes all go through the daemon asynchronously; the agent side only perceives "recorded successfully" |
| Reviewer false vetoes slow down research | hard/soft grading already exists; soft only hints, never vetoes; a veto must come with an actionable fix pointer |
| Single-person maintenance + a fast-iterating upstream reference system | Each phase's devlog records an architecture diff against OpenScience, aligned once per quarter |

---

## VII. Success Criteria (v0.2 release acceptance criteria)

1. One real research thread can be walked through end to end: raise a question → literature research into the library → Co-explore produces an idea → novelty check → dry experiment (OpenMM) → conclusion card passes review → export a research report with an evidence chain
2. Wet-experiment path: a natural-language protocol → compile → safety gate → successful Opentrons simulator execution
3. Test baseline: unit tests only grow from 84, never shrink; every skill has e2e verification; CI fully green
4. Documentation: README rewrite + per-phase devlog + this design document updated alongside implementation

P8 verification conclusion (evidence itemized in [devlog/P8-wrapup.md](devlog/P8-wrapup.md)):

| Criterion | Conclusion | Evidence |
|------|------|------|
| 1 Complete research thread | ✅ | `scripts/demo-research-thread.ts` (replayable, zero network, CI entry point `tests/unit/demo_thread.test.ts`) + browser-version Playwright ①–⑫. **One deviation**: the dry experiment uses pyref rather than OpenMM — CI cannot depend on whether openmm happens to be installed, and OpenMM goes through the same contract test suite |
| 2 Wet-experiment path | ✅ | `tests/unit/wet_e2e.test.ts` runs two protocol classes under the **real** `opentrons.simulate`; safety-gate 4-rule adversarial matrix; Playwright ⑦⑧⑨ run the browser version |
| 3 Test baseline | ✅ | unit 706 (baseline 84 → 655 → 706; the 12 tests deleted with the v0.1 compute module at P8 fall under G6-authorized cleanup) · pytest 48 · Playwright 12 · typecheck clean |
| 4 Documentation | ✅ | README rewrite, CHANGELOG v0.2.0, 9 devlog posts, this document updated alongside implementation |

P9 additional verification (extension surface and LLM-friendliness, evidence itemized in [devlog/P9-extensibility.md](devlog/P9-extensibility.md)):

| Item | Conclusion | Evidence |
|----|------|------|
| The six extension points are documented with runnable examples | ✅ | [EXTENDING.md](EXTENDING.md) six sections; skill/connector/platform examples = scaffolding output, generated then actually run in CI; safety-gate rule example `examples/extending/flammable_over_heat_rule.ts` with 11 cases (including negative controls) |
| Capability listing generated from the registry | ✅ | `tests/unit/capabilities.test.ts` bidirectionally consistent (19 cases) |
| MCP can be driven end-to-end by a real client | ✅ | `tests/unit/mcp_e2e.test.ts` uses the SDK Client + InMemoryTransport to walk through capabilities → search-to-ingest → idea → novelty → timeline → report |
| Approval-type actions are unreachable at the MCP layer | ✅ | `tests/unit/mcp_server.test.ts` adversarial suite, including the structural defense enumerating request constructions across every tool |
| llms.txt is idempotent | ✅ | `tests/unit/llms_txt.test.ts` (including the gate for "docs changed but forgot to regenerate → red") |
| Test baseline | ✅ | unit 716 → 824 (+108) · pytest 48 · Playwright 12 · typecheck clean |
