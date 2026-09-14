# Spark Research v0.5.0 Development Plan

> Drafted: 2026-09-10 (PDT) · Starting point: `main` v0.4.0 (`ebcf118`)
> Input: `~/Desktop/AI4S/spark-research-v0.5-plan/` (a separate planning directory, **not committed to the repo**) —
> containing a source-level comparison against OpenScience v2.0.86, the remote compute design, 29 staged connectors, 154 staged skills, and provider intel.
> This document is the **source of truth for v0.5 construction**; the planning directory is the **materials library** — see §0.2 for the division of labor between the two.

---

## 0. Starting Point and Positioning

### 0.1 In One Sentence

**v0.4 made the word "agent" real. v0.5 does two things: send compute off the local machine, and keep walking the "fewer, deeper" path even with 183 candidates staring us in the face.**

The second half of that sentence is the real difficulty of this release.

### 0.2 What the Planning Directory Has Produced, and What It Is Not

| Output | Count | Status |
|---|---|---|
| staged connectors | **29** | Structural tests 201 pass / tsc clean; **fixtures not recorded, real network not verified** |
| staged skills | **154** | Directory complete, frontmatter all pass the real parser; **functionality unverified, no production entry point** |
| Remote compute design | COMPUTE_DESIGN.md | Includes line-by-line upstream source citations + 7 implementation slices |
| Provider intel | PROVIDER_QUIRKS / V05_PROVIDER_DESIGN | Already fed back into v0.4's P11 |

**This is an ammunition depot, not a scheduling commitment.** The planning directory itself states it plainly: "154 staged items are an ammunition depot, not a scheduling commitment." This plan enforces that statement as a hard constraint — see §2.

### 0.2 Addendum · Resource Inventory (measured 2026-09-10)

**The planning directory is 70M in size, of which 66M is the read-only reference clone of upstream/openscience** (Apache 2.0, main @ 2026-09-10). The actual self-produced materials amount to roughly 4M:

#### 29 Staged Connectors

```
arrayexpress bindingdb biogrid biorxiv chebi clinvar dbsnp depmap expression-atlas
geo gnomad gtex gtopdb hpa intact interpro kegg mygene myvariant ncbi-gene
opentargets pdbe reactome sifts single-cell-atlas string-db surechembl ucsc wikipathways
```

| Dimension | Finding |
|---|---|
| Requires credentials | **Only 1 — biogrid**; the other 28 are keyless |
| Verification status | Structural tests 201 pass / 0 fail + `tsc` clean; **fixtures not recorded, real network not verified** |
| **Host-pooling risk (V26)** | **4 on ncbi.nlm.nih.gov** (clinvar/dbsnp/geo/ncbi-gene) · 4 on the ebi.ac.uk family. Adding the repo's existing pubmed, **a single NCBI eutils host already has 5 consumers** |
| Known red flags | WikiPathways returns 403 in testing; KEGG is free for academic use / paid for commercial use / 3 req/s; COSMIC requires registration |

> **This inventory raises the urgency of V26**: the connector layer currently **has no rate limiter at all**, only a polite User-Agent header.
> Once this batch is integrated, a single NCBI host will have 5 consumers each hitting it independently — the rate limiter must **pool by host key**,
> not have each connector throttle itself. This must be scheduled into C2's first batch, **before any NCBI-family connector is integrated**.

#### 154 Staged Skills

| Domain | Count | Form |
|---|---|---|
| experiment | **105** | 29 platform-type (go through `SimulationPlatform`) · 97 with scripts |
| literature | 28 | |
| report | 15 | |
| ideation | 6 | |

**Dependency distribution**: about 125/158 rows have `—` in the connector field — **most skills do not depend on a connector**,
they run on kernel scripts. This is good news for the integration cadence: the skill line and the connector line are **more loosely coupled than expected**,
and each can proceed on its own pull without waiting on the other.

**Full ledger**: the complete inventory of 313 = SKIP (initial screen) 143 + staged 154 + SKIP (detailed screen) 9 + merged 1.
Every SKIP has a written justification.

#### Remaining Resources

| Resource | Content |
|---|---|
| `workstreams/compute/COMPUTE_DESIGN.md` | Remote compute design, including line-by-line upstream source citations + 7 implementation slices + a risk table |
| `workstreams/provider/` (4 documents) | PROVIDER_INTEL · **PROVIDER_QUIRKS (already fed back into P11 in v0.4)** · V05_PROVIDER_DESIGN |
| `upstream/openscience/` | Read-only reference clone, **not committed to the repo** |
| Integration-candidate proposals (5) | See BATCH_ROLLUP: the deterministic rule that equation discovery requires held-out validation · C0/C1 compute tiering · base.ts per-tool content-type · `registerCustom()` as a near-term bridge · **all wet-experiment skills must be funneled into the existing wet-protocol approval gate, no parallel approval channels allowed** |

> That last proposal (no parallel approval channels) **should be written directly into the skill specification in `EXTENDING.md`**,
> rather than being remembered only when some skill is being integrated — it is a corollary of AD-6 at the skill layer.

### 0.3 After v0.4's Completion, the Dependency Graph Is Fully Cleared

The planning directory's dependency table was written while v0.4 was in flight, and it listed 8 places "waiting on P11/P12/P15/P16 to land." **All of these constraints are now lifted**:

| Original constraint | Current status |
|---|---|
| C1 CB-5 approval wiring waits on P12 ToolBus | ✅ ToolBus has shipped, and P12 **reserved a pricing-dimension interface specifically for "billable consequential actions"** (not hardcoded to tokens) |
| C1 budget reporting waits on P13 frame-level accounting | ✅ the `agent_run` record has landed in the graph |
| C2 integration waits on P15 manifest + ext verify | ✅ delivered, **but the boundary is narrower than expected** (see §2.2) |
| C3 integration waits on R-d's tightened AD-5 acceptance criterion | ✅ the skill-reachability gate check is already in CI |
| C4 embedding waits on P11 provider abstraction | ✅ the `llm/types.ts` trio is in place |
| Side item V15 alias removal waits on the deprecation cycle | ✅ v0.4.0 has been released, the cycle has run its course (the aliases are still in `base.ts:180-186`) |

**So v0.5's constraint is no longer dependencies — it's capacity and review bandwidth.**

---

## 1. Gate F: Four Things That Must Be Cleared Before v0.5 Starts

> Same semantics as Gate D in v0.3 and the gate in v0.4: **no new features until these are cleared**.
> But this time, three of the four items are things "v0.4 owes" and things "with a deadline," not technical debt.

| # | Item | Why it must come first |
|---|---|---|
| **F-1** | **Make up the three zero-context external acceptance reviews** | The v0.4 plan required one at the end of each of W2/W3/W4, and **not a single one was run**. This is the highest signal-to-noise check in this project — the three real friction points from v0.2.1 were discovered exactly this way. **The second one must be executed by a person/session that did not participate in development.** Before v0.5 introduces remote compute (real money spent) and large-scale expansion, we need to know how much friction the current external experience has |
| ~~F-2~~ | ~~AMiner key renewal~~ **→ downgraded to a non-gate item (user decision, 2026-09-10)** | User's position: **use the current key for now, users will bring their own key in the future**. After verification, this decision is confirmed safe — missing key → `skipped` (with configuration guidance, `literature/search.ts:142`); **an invalid key → upstream 401 → thrown → `failed` (visible)**, it will not silently swallow into an empty result. Credentials were never meant to be committed to the repo (AD-2) — BYOK is already the design. **The only remaining task is documentation wording**: make sure README / INSTALL clearly state that AMiner requires the user to bring their own key — settle this into the backlog, does not block starting work |
| **F-3** | **V15: remove deprecated aliases** | v0.4 §2.2 explicitly states "run the deprecation cycle through to v0.5." The three aliases `MCPConnector` / `MCPConnectorConfig` / `MCPTool` (`base.ts:180-186`). **Breaking change, goes into the CHANGELOG** |
| **F-5** | **Remove (or explicitly report as unimplemented) the fake `ComputeService` in the daemon** | **A live, silent fake-success path in v0.4.0**: the `case "compute"` in `orchestrator.ts:490-494` calls `DefaultCompute` in `daemon/daemon.ts:72-91` — an in-memory Map fabricates a fake `{status:"queued"}` job, **returning `ok:true`**. The review's original comment at the time was "an LLM plan that emits a compute task will silently produce a fake job" — P8 deleted `backend/src/compute/`, but this path on the daemon side survived. **v0.5 needs to land real compute, so this must be cleared first** — otherwise the repo would have two computes, one real and one lying |
| **F-4** | **V27 ruling: fix it or permanently downgrade it** | The single binary only has shallow commands available. In v0.4, per the user's decision, it was not fixed. In v0.5, either fix it (23 asset-loading sites), or **write "no single-binary release" into a permanent commitment** and remove that path from INSTALL.md. **No more carrying it over to another release** |

**F-1's output directly affects the choices in §2**: friction points exposed by external acceptance review take priority over any staged material.

---

## 2. The Core Problem: 183 Candidates on the Table — How Not to Repeat the Sprawl

### 2.1 Let's Get the Numbers Straight First

Current repo: **17 connectors, 11 skills**.
Planning directory: **29 staged connectors, 154 staged skills**.

If all of them were integrated, connectors would become 46 (exactly matching OpenScience), and skills would become 165.
**This is precisely the shape AD-5 was originally set up to avoid** — the review's verdict on OpenScience was "313 skills of uneven quality."

The planning directory's discipline is "2–3 per iteration." But 154 ÷ 2.5 ≈ **62 iterations**.
That is not a schedule — it is "later" dressed up to look like a plan.

### 2.2 So v0.5's Selection Principle: Demand-Pulled, Not Queue Consumption

**Three hard rules**:

1. **Only integrate what has real pull.** Pull = ① a gap exposed by F-1's external acceptance review, ② something the user's current research topic genuinely needs,
   ③ a **clear shortfall** in an already-integrated capability (e.g., kegg lacking conv/link breaks some chain).
   **"It's in staged and looks useful" is not pull.**
2. **v0.5's integration ceiling: connectors ≤ 8, skills ≤ 8.** Hard-coding the number is not about being conservative — it's about forcing a choice —
   without a ceiling, "add one more" is always the path of least resistance.
3. **Every integrated item must pass the three gates built in v0.4**: the tightened AD-5 (e2e + a reachable production entry point + registered in capabilities),
   `ext verify`'s 100-concurrency parameter-mapping invariant, and the **storage-layer write-access gate check** (if it involves storage).
   **If it doesn't pass, it doesn't get integrated — not "merge first, fix later."**

### 2.3 Priority Candidates (subject to adjustment pending F-1 results)

The planning directory recommends "integrate the plug-and-play staged connectors first." Combined with the boundaries measured in v0.4:

| Category | Candidates | Rationale |
|---|---|---|
| connectors (select ≤8) | clinvar · biorxiv · opentargets · reactome · string-db (the latter three also patch capability gaps) | Biomedicine is the user's actual direction; these five can support database-type skills |
| skills (select ≤8) | **the platform trio scanpy / pydeseq2 / cobrapy** takes priority | The planning directory verified their wiring point `simulation/registry.ts` exists and belongs to no lane; they go through the `SimulationPlatform` contract — **AD-4's two-implementation investment pays off for a third time** |

> ⚠️ **The boundary measured in W3-d must be carried into C2**: the manifest's declarative path only covers sources with
> "**JSON response + single request**." XML normalization cannot be expressed structurally; multi-hop requests have no primitive.
> The planning directory's note that "when integrating, prioritize evaluating the P15 declarative manifest path" must be triaged against this criterion first —
> **don't burn time on sources for which it's impossible.**

---

## 3. Main Line C1: Remote Compute (Critical Path)

The design is complete (`workstreams/compute/COMPUTE_DESIGN.md`, including line-by-line upstream source citations). This plan records only the **scheduling and wiring**.

### 3.1 Seven Slices and Their Dependencies

| Slice | Content | Dependency |
|---|---|---|
| CB-1 | Contract-first: three-axis lifecycle state machine + Plan schema + Target/Adapter interfaces + exhaustive transition tests | none |
| CB-2 | local adapter: restate "local subprocess + disk as source of truth" as the first `ComputeAdapter` | CB-1 |
| CB-3 | upload surface: deny-list / quota / sha256 / preflight re-verification, unit tests at the pure-function layer | CB-1 |
| CB-4 | Modal adapter: the four paths run/recover/collect/release + ownership tags | CB-1, **requires the user to provide a Modal token** |
| **CB-5** | **Approval wiring**: plan digest → decision record → single-use consumption → digest re-verification before execution | ToolBus ✅ |
| CB-6 | SimulationPlatform integration (optional path) | CB-4 |

### 3.2 CB-5 Is the Center of Gravity of This Main Line, Not CB-4

**Remote compute is the first "billable consequential action" spark has encountered** — submitting a Modal GPU task = spending real money.
This is structurally isomorphic to the physical consequences of a wet experiment, so it must reuse the same already-validated mechanism:

- **`compute approve` goes into `MCP_WITHHELD`** — naturally covered by AD-14's adversarial tests (a subagent can never self-approve)
- **Single-use digest consumption** — following the approval-consumption semantics that v0.3.0 D-10 built for wet experiments,
  **a rerun must be re-approved**, no exception even after a crash and restart
- **Approval requires an interactive terminal** — V19 already landed in v0.4 (`isTTY` is a kernel-layer property, piping cannot get around it),
  compute approval reuses this directly
- **Budget goes through ToolBus's pricing dimension** — P12 **specifically reserved an interface for this** (`ToolCallCost { unit }`,
  not hardcoded to tokens), v0.5 only needs to add a `unit` value and real numbers

> **The pass/fail criterion for this main line is not "Modal can run" — it's whether "the fact that money was spent was approved by a human, which version was approved,
> how many times it was approved, and how much was spent" is all auditable.** The former is integration work; the latter is what this project stands on.

### 3.3 Acceptance

A real OpenMM MD task runs to completion on a Modal GPU:
plan → approval (single-use digest consumption) → dispatch → **local process SIGKILL** → recover and harvest after restart →
observation record goes into the evidence graph. Contract tests are carried by the local adapter (**runs with zero credentials in CI**).

---

## 4. Remaining Main Lines

### C4 · Embedding Abstraction + Semantic Novelty

**This is the only item in v0.5 that directly improves the credibility of an existing capability.**

Current risk (known since post-v0.3): novelty similarity is **lexical matching**, threshold 0.75,
**the calibration sample is only 2 claims**, nearest-neighbor margin 0.08.

Approach:
1. Add an embedding provider abstraction to `llm/` (reuse the form of P11's provider adapter layer)
2. Swap novelty's similarity metric for embeddings
3. **Re-calibrate the threshold**: expand the calibration set to **≥20 claims**, including bidirectional controls of known novel / existing
4. AD-8 unchanged: **both the model's original judgment and the corrected rating remain in the artifact**

### C5 · Inline Scientific Views (do the zero-dependency one first)

- **② SMILES → 2D structure diagram**: goes through kernel-side RDKit to produce an SVG → the artifact channel, **zero new frontend dependencies**. Do this one first.
- ① PDB/mmCIF 3D viewer: requires introducing 3Dmol.js/NGL (the frontend currently only has solid-js/vite).
  **Evaluate only after ② is done** — AD-7's frontend discipline is "artifacts do not go into git, dependencies must be kept minimal."

Acceptance: UI-vs-CLI behavior parity goes into `ui_cli_parity.test.ts`; add one Playwright test each.

### Side Line · BACKLOG Sweep (38 items still open)

Loose items named by the planning directory: V3 · V8 · V9 · V13 · V14 · V21 · V24.
Plus the ones added in v0.4: V25 · V27 · V29 · V30 · V31 · V32.

**Discipline: at the v0.5 review, decide item by item to either "absorb" or "explicitly won't do" — none may be left hanging.**
Three of them carry special weight:

- **V25** (make the safety-gate concentration/biosafety fields real) — **a hard prerequisite for physical Opentrons**.
  v0.5 must at least make the compiler-produced fields real, otherwise V6 can never get started
- **V31/V32** (external MCP calls recorded into the evidence graph) — the differentiation claim relative to OpenScience that "external tool calls naturally go into provenance"
  **is currently only half realized**. Either wire it up or withdraw the claim — pick one
- **V21** (unify the timeout environment-variable prefix) — breaking, runs through the deprecation cycle in the same batch as F-3

---

## 5. Wave Scheduling

> Continuing the form validated as effective in v0.4: **task-level dependencies + wave-level parallelism + serial close-out**.
> The four-lane cap is unchanged — the bottleneck is review bandwidth, not compute.

```
Gate F (serial, cannot be parallelized)
  F-1 three external acceptance reviews · F-2 AMiner key · F-3 remove aliases · F-4 V27 ruling
        │
        ▼
W5-1 ─┬─ α  C1 CB-1/CB-2/CB-3 (contract + local adapter + upload surface)  ← start of critical path
      ├─ β  C4 embedding abstraction + novelty re-calibration
      ├─ γ  C5-② SMILES→SVG (kernel side, zero frontend dependencies)
      └─ δ  Side line: V25 safety-gate field realization (hard prerequisite for physical device)
        │
        ▼
W5-2 ─┬─ α  C1 CB-4 Modal adapter (requires token)
      ├─ β  C1 CB-5 approval wiring (single-use digest consumption + MCP_WITHHELD + TTY)
      ├─ γ  C2 first batch of connector integrations (≤4, chosen per F-1 results)
      └─ δ  Side line: V31/V32 external MCP calls recorded into the evidence graph
        │
        ▼
W5-3 ─┬─ α  C1 CB-6 + real Modal e2e (SIGKILL → recover)
      ├─ β  C3 first batch of skill integrations (platform trio first)
      ├─ γ  C2 second batch of connectors (≤4)
      └─ δ  runtime contract + Python SDK
        │
        ▼
Close-out + release v0.5.0
```

**Critical path**: F → CB-1/2/3 → CB-4 → CB-5 → real e2e. Everything else runs in parallel around it.

### 5.1 Hub Files (continuing v0.4's rule starting this release)

Extracted from all lanes, **wired centrally at close-out**:
`backend/src/index.ts` · `mcp/tools.ts` · `capabilities/**` · `agents/orchestrator.ts` ·
`agents/toolbus.ts` · `server/app.ts` · `connectors/registry.ts` · `literature/normalize.ts` ·
`tests/unit/narrative_parity.test.ts` (only adding/removing registered entries is allowed; assertion logic may not be touched).

Measured in v0.4: the cost of not doing this was three `index.ts` conflicts and **six "built but nobody wired them up."**

### 5.2 Five Parallelism Disciplines (proven effective in v0.4, carried over unchanged)

1. **`cd` back to the neutral directory (the main repo) before spawning** — a subagent inherits the cwd, and a mismatch combines with isolation rules to produce
   a plausible-looking but wrong inference. Writing `cd` as the first line of the brief **is not sufficient** (tried in v0.4, still triggered)
2. **Hub files are close-out exclusive** (§5.1)
3. **Negative controls are mandatory** — every critical test must verify that "reverting the implementation turns it red," and the terminal output goes into the devlog
4. **"Waiting to be wired" registration** — a newly created module that has no permission to wire itself in registers itself under `ALLOWED_ORPHANS`,
   and is removed via a symmetric check once it's wired in at close-out.
   In v0.4, 7 modules went through this full lifecycle, and **it caught the main session itself twice**
5. **Multiple lanes must go through an integration branch** — each lane being all-green on its own while the merge turns red is the normal case

**Adding one more, learned from v0.4:**

6. **Don't trust a lane's self-reported numbers.** The main session must independently re-run the key negative controls and wire-format probes.
   Real bugs caught by the main session's independent re-verification in v0.4 include: the binary was a different runtime, a circular import crashed the CLI,
   and **an accounting record nullified the burn-prevention shutdown condition** (all tests remained green — only one number changed from 1 to 2).

---

## 6. Verification Plan

### 6.1 Stage Gates (every lane, every wave, no exceptions)

Continuing v0.4's six suites: `typecheck` · `tests/unit/` (baseline **1396**, 0 fail / **0 skip**) ·
`tests/concurrency/` + `tests/timeout/` · **`bun run test:e2e`** · `test:py` · `test:lab`.

### 6.2 Two New Ones Added in v0.5

| Addition | Why |
|---|---|
| **Compute contract tests are carried by the local adapter** | Runs with zero credentials in CI (following the precedent pyref set for OpenMM). **Modal e2e uses record-and-replay** |
| **Every newly integrated item passes three gates** (tightened AD-5 / `ext verify` concurrency invariant / storage-layer write access) | Hard rule 3 from §2.2. **If it doesn't pass, it doesn't get integrated** |

### 6.3 Zero-Context External Acceptance Review: Run It Three Times in v0.5, and This Time for Real

| Point in time | Task |
|---|---|
| **Gate F** (before work starts) | Current-state baseline — get a read on how much friction exists in the external experience delivered by v0.4 |
| End of W5-2 | Submit a remote compute task and read back the conclusion (**including the approval process**) |
| Before release | Full pipeline on a clean machine |

**The second one must be executed by a person/session that did not participate in development.** v0.4 ran zero of its three; v0.5 will not repeat that.

---

## 7. Explicitly Not Doing

| Not doing | Rationale |
|---|---|
| SSH adapter implementation | Only leave the Host schema and a slot; upstream is 1800 lines, wait for real demand |
| Physical Opentrons | **Realizing the V25 safety-gate fields is a hard prerequisite**; a separate project once that's realized |
| Multi-user real identity | v0.5 compute still runs under a single user's own account, so this doesn't trigger |
| Full port of all 313 skills / full alignment of all connectors | §2.2's ceiling: connectors ≤8, skills ≤8 |
| Genome browser · desktop Electron shell | Not needed by the user's current direction |
| Matching OpenScience's daily-release cadence | **Bus factor of 1 — racing on speed is a guaranteed loss** (the strategic conclusion from the v0.3 review is unchanged) |

---

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **The ammunition-depot temptation**: 154 staged items sitting there, "add one more" is always the easiest choice | Repeat the sprawl, AD-5 breaks down | §2.2's hard-coded ceiling + demand-pull criterion; **integration count is not a KPI** |
| Modal real billing runs out of control | Spends real money | CB-5 comes before CB-4's real e2e; budget goes through ToolBus; **approval requires a TTY** |
| staged material has not been verified against a real network | Batch rework at integration time | Record fixtures for each item before merging; the planning directory already marks them `UNTESTED` |
| manifest boundary narrower than expected (measured in W3-d) | Wrong routing decision for C2 integration | Triage first by "JSON + single request"; sources for which it's impossible go straight to a TS extension |
| Insufficient re-calibration samples for embedding | novelty remains untrustworthy | A calibration set of ≥20 claims is a hard requirement, including bidirectional controls |
| External acceptance review skipped again | Yet another release with no real acceptance review | **Written into Gate F**, not an optional tail item |

---

## 9. To the Maintainers

v0.4 proved one thing: **parallel development is workable in this repo**, and that defense against "failure that looks like success"
(five gate checks + mandatory negative controls + waiting-to-be-wired registration) really does catch things — including catching the main session itself.

v0.5's technical difficulty is remote compute, but **the real test is §2**: with 183 ready-made candidates on the table,
can we still hold the line on "fewer, deeper"?

Every bit of this project's differentiation from OpenScience — the evidence graph, the deterministic verification layer, contract-based acceptance,
and completion determinations that consult the graph rather than the model — rests on the premise that "everything has been verified."
**Integrating one unverified skill doesn't cost you that skill — it costs you that premise.**
