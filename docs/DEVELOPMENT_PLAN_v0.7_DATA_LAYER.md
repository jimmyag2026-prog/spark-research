# v0.7 Main-Direction Design Draft · Data Layer Evolution (raw layer append-only · lakehouse · controllable feedback loop)

> Status: **v0.7 companion design (finalized v1)**, entering the repo in the same PR as `DEVELOPMENT_PLAN_v0.7.md`. Decided by the user on 2026-09-11: the data layer is v0.7's main direction A.
> The master table of waves, lane footprints, gate checks, and review passes is in `DEVELOPMENT_PLAN_v0.7.md`; this document covers only the data layer itself.
> Baseline: `main` @ v0.6.0 (`dd11bf3`). All file paths and line numbers have been re-verified against this baseline (2026-09-11).
> Inputs: the user's local research "Data Collection System Redesign" (hot window + archive, QC as a first-class citizen) ·
> "Data Trading Marketplaces: AWS/Snowflake/Databricks Comparison" (no copying, open protocol, billed per query) ·
> "China AI Data Export and Distillation Regulation" (source traceability, upstream data boundaries).

---

## 0. One-sentence summary and locked-in decisions

**Demote the "evidence graph" from a source of truth to a derived layer, and add beneath it a layer that only appends and never modifies; nail down the export format and provenance classification from day one; do not build the feedback-loop channel.**

Already locked in (user, 2026-09-11):
- The data layer is v0.7's main direction; the 3D structure viewer will not be built
- Local-first: no cloud dependency introduced, S3 is only an optional archive target
- Interfaces left open for the community: the storage layer must have a contract like the ones for `SimulationPlatform` / `WetLabBackend` / `ComputeAdapter`
- Feedback loop / resale: v0.7 only does **fields and determination logic**, not the channel
- **The raw layer is on by default, local only** (Question 1)
- **LLM originals are retained permanently by default**, no downgrade to hash after N days (Question 2); `data archive` only compresses, never deletes
- **JSONL + direct DuckDB querying is the entirety of v0.7**, Parquet is deferred (Question 3) — the `--format parquet` option in §6.1 is removed from v0.7 scope, leaving only JSONL; example DuckDB queries go into the docs
- **Sharing/export unit = project; increments = time-window deltas, with the manifest chain-referencing the previous one** (Question 4, analysis in §7.5); slicing by record type is not supported
- **The resale piece is not being developed**; the interface is reserved along internationally common lines: manifest naming aligned with Delta Sharing's three-level share/schema/table hierarchy, license expressed via SPDX expressions (custom ones go through `LicenseRef-`), dataset description drawn from DCAT core fields (Question 5, see §7.6)
- **`raw/kernel` stores only a reference + content hash, no mirroring** (Question 6, undecided by the user, ruled on by the main session — rationale in the §4.1 note)

## I. Goals and non-goals

| Goal | What v0.7 achieves |
|---|---|
| Automatically record all data | Every connector call, every LLM call, every kernel cell, every device reading produces a raw record, **with no module needing to remember to write it** |
| Append-only raw data | The raw layer only ever `append`s; every rewrite of the evidence graph leaves a journal row; deletion is a tombstone |
| Lakehouse integration | Stable export directory conventions + manifest; directly queryable via local DuckDB; Parquet optional |
| Local-first | All new files still live under `~/.spark-research/projects/<slug>/` |
| Community-adjustable | Two interfaces, `RawSink` / `RecordJournal`, with default implementations jsonl + SQLite |
| Controllable feedback loop | Every piece of data carries `provenanceClass` + `license`; a `shareable()` determination function + gate check; upstream mirrors never leave |

**Non-goals (explicitly out of scope for v0.7)**: Delta/Iceberg dependency · cloud storage enabled by default · the transport channel and billing for the feedback loop · replacing SQLite (it remains the hot layer) · multi-user permissions (V10).

## II. Diagnosis of the current state (by code, not by impression)

### 2.1 Existing recording surfaces

| Layer | Location | Content | Mutability |
|---|---|---|---|
| Evidence graph | `projects/<slug>/records.db` (`project/records.ts`) | 9 record types · 4 evidence tags · 5 edges · `rev` CAS | **Mutable**: `update()` can overwrite `content`/`metadata`, old values are not retained |
| Artifacts and cell execution | `artifacts/artifacts.db` (`artifacts/store.ts`) | versions · dependencies · `execution_records` (source/stdout/stderr/resources) | approximately append-only |
| Agent frame ledger | record type `agent_run` (`agents/ledger.ts`) | model/provider/**systemHash/promptHash**/usage/integrityHash | append-only; **only hashes, no original text** |
| LLM spend ledger | `projects/<slug>/usage.jsonl` (`usage/ledger.ts:23`) | ts/command/provider/model/tokens/costUsd | append-only |
| Connector call ledger | `<dataDir>/api_calls.jsonl` (`usage/api_ledger.ts:23`) | ts/connector/host/status/latencyMs | append-only; **no request parameters, no response body** |
| External MCP calls | `<ext>/.mcp_calls.jsonl` (`extensions/mcp_client.ts:186`) | call records | append-only |
| Literature library | `library.db` (`literature/library.ts`) | normalized papers | `update()` limited to tags/readingStatus/notes/pdf*; `remove()` is a hard delete (V30: zero production callers) |

### 2.2 "Append-only raw data" fails to hold in three places

1. **Connector raw responses are discarded** — in `connectors/base.ts:188`, `const raw = await response.text()` is immediately followed by `JSON.parse`, and the raw text never lands on disk. Once the normalization logic changes (e.g. author-name parsing, V38), the old result can no longer be recomputed.
2. **LLM originals are not persisted** — both `LLMRouter.call()` (`llm/router.ts:163`) and `usageTrackingLlm()` (`usage/ledger.ts:155`) only record usage; `agent_run` records only `promptHash`. For real topics run under R1/R2, all that remains today are derived results (close-reading cards, conclusion cards) — **the prompts and the model's raw output are no longer traceable**.
3. **The evidence graph is overwritable** — `RecordStore.update()` (`records.ts:345`) directly does `UPDATE records SET content=…`. There are 9 production call sites:

| Caller | What it changes | Nature |
|---|---|---|
| `experiment/loop.ts:705/755/802` | experiment state + rendered body | state machine |
| `lab/wet_loop.ts:826/872` | wet-lab state + approval (CAS) | state machine (D-9 integrity verification depends on this) |
| `ideation/store.ts:114` · `conclusion/store.ts:100` | card state | state machine |
| `compute/broker.ts:289` | backfilling compute observations | backfill |
| `literature/reading.ts:466` | `retracted` marker | already tombstone-shaped |

**Conclusion**: we cannot simply "disable `update()`" — state-machine semantics (including D-9 integrity verification and CAS's atomic claim of execution rights) are all built on top of it. The correct move is to **add a journal underneath it**: a mutable projection plus an immutable log.

### 2.3 Existing quality/provenance markers are scattered everywhere

`deterministic` (V49) · `basis: abstract|fulltext` (V66) · `simulated` (G4) · bioRxiv `caveat` (V54) · `usageUnavailable` — all live in their own `metadata`, with no unified column, so they cannot be machine-filtered at export or feedback-loop time.

### 2.4 Single-binary constraint (affects format selection)

`bun build --compile` does not carry native extensions; the repo's `package.json` has no duckdb/parquet/arrow dependency. **Parquet output cannot rely on an npm native package**, leaving only: (1) JSONL as the stable contract; (2) Parquet via an external `duckdb` CLI subprocess (the same "probe → spawn" shape as the `.venv` python case), with an honest "unavailable" report if it's missing (AD-12).

## III. Target architecture: four layers

```
L3  Feedback-loop control   provenanceClass · license · shareable() · shared-manifest approval (same shape as AD-6)
L2  Export/lakehouse        data export → <slug>/export/<ts>/{manifest.json, records/, raw/, artifacts/}
                            JSONL as the stable contract; Parquet optional (external duckdb); direct DuckDB querying
L1  Evidence graph          records.db (mutable projection, feeding state machines/reports/completion determination)
                            + records_journal (append-only: one row per create/update/tombstone)
L0  Raw layer               <slug>/raw/{connector,llm,kernel,device}/<date>.jsonl (+ blobs/)
                            append-only; in-row prevHash chain; credentials never enter it
```

**Invariants** (to be written into the AD list):
- **AD-15**: L0 is append-only; L1 can be rebuilt from L0 + journal (v0.7 achieves "export → re-import yields row-for-row equality", not full replay)
- **AD-16**: data with `provenanceClass = upstream` never enters any share/export-for-sharing set

### 3.1 Directory layout (new parts in bold)

```
projects/<slug>/
├── project.json              schemaVersion 1 → 2
├── records.db                + table records_journal · + column quality · + column provenance_class · + column license
├── library.db
├── artifacts/artifacts.db
├── papers/  experiments/
├── usage.jsonl
├── **raw/**
│   ├── connector/<name>/<YYYY-MM-DD>.jsonl
│   ├── llm/<YYYY-MM-DD>.jsonl
│   ├── kernel/<YYYY-MM-DD>.jsonl        (a mirror of execution_records, for unified export convenience; optional)
│   ├── device/<YYYY-MM-DD>.jsonl
│   └── blobs/<sha256[:2]>/<sha256>      (response bodies/PDF text above the threshold; the row keeps only a reference)
└── **export/**<ISO-ts>/                 data export output (deletable, rebuildable)
```

`ProjectPaths` (`project/manager.ts:89`) gains `rawDir` and `exportDir`.

## IV. L0 raw layer

### 4.1 Row schema (shared shell across all kinds)

```ts
interface RawEntry {
  v: 1;                       // row format version
  id: string;                 // ulid
  ts: string;                 // ISO8601
  kind: "connector" | "llm" | "kernel" | "device";
  project: string;
  sessionId: string | null;
  command: string | null;     // the CLI command / MCP tool / HTTP route that triggered it
  provenanceClass: "upstream" | "derived" | "user_authored" | "model_generated";
  license: string | null;     // SPDX or source ToS identifier (see the mapping table in §7.2)
  prevHash: string | null;    // hash of the previous row in the same file (chain)
  hash: string;               // sha256(canonical(all fields except hash))
  payload: ConnectorPayload | LlmPayload | KernelPayload | DevicePayload;
}
```

| kind | payload |
|---|---|
| connector | `{ connector, tool, host, params(redacted), status, latencyMs, responseRef: {inline: string} \| {blob: sha256, bytes}, contentType }` |
| llm | `{ provider, model, wireModel, messages(original), options(excluding key), response(original content + finish_reason + usage), ok, failureKind }` |
| kernel | `{ executionRecordId, contentHash }` (points into artifacts.db without duplicating stdout; `contentHash` = sha256 of that execution_record row after canonicalization, letting the raw chain cover kernel output too. **Ruling: no mirroring**: stdout can be large and is already append-shaped in artifacts.db, and it forms its own table at L2 export time; mirroring would only buy "one directory to see everything" at the cost of doubled size and two copies that could diverge — the V46 shape) |
| device | `{ experimentId, backend, stepId, reading }` |

**Hard redaction rule (an extension of AD-2)**: request headers are never recorded; fields in `params` named `key/token/apiKey/authorization` are replaced with `"<redacted>"`; LLM `options` strip out env/key. Gate check: `tests/unit/raw_redaction.test.ts` calls a stub carrying a key and asserts the key cannot be grepped out of the raw files.

### 4.2 Instrumentation points (one each, full coverage — the lesson of V46's "two hand-written copies")

| Data | Instrumentation point | Note |
|---|---|---|
| connector | `connectors/base.ts:188`, after the raw response is in hand and before `JSON.parse` | Same `finally` block as the existing `recordApiCall` (:210); failed responses are recorded too |
| LLM | `usage/ledger.ts`, at the point where `usageTrackingLlm().call()`'s real call returns | Already the mandatory choke point for every spending path (v0.6's G-3 budget gate lives here); **direct `new LLMRouter().call()` callers need to be swept clean** (same shape as V40: the gate check requires the router to make `rawSink` mandatory or an explicit `null` with a stated reason) |
| kernel | `artifacts/store.ts`, where `execution_records` is written | Only a reference row is written |
| device | `lab/wet_loop.ts:662`, at the `read_result` collection point | One row per reading |

### 4.3 Volume control (drawn from §8.3 of data_collection_redesign)

- Response bodies over 64 KB are written to `blobs/`, with the row keeping only `{blob, bytes}`; deduplicated by hash (a paper looked up 5 times is stored only once)
- LLM originals are fully stored by default (research-process data is the part with the most feedback-loop value); `config set rawLlm off` can disable this, and with it off `agent_run` still keeps the hash
- Rolling archival: `data archive --before <date>` gzips daily raw files into `raw/archive/`, **without deleting them**; S3 upload is left to the user (a `--to <dir>` option is provided, no cloud SDK is bundled)
- Estimate: R1's two topics, at $0.055 of spend, correspond to roughly 600K tokens ≈ 2.4 MB of original text; connector responses at R1's call volume run about 20 MB per topic. **A medium-sized topic is under 50 MB**, so no compression for now

### 4.4 Interface (community replacement point)

```ts
export interface RawSink {
  readonly id: string;
  append(entry: Omit<RawEntry, "prevHash" | "hash">): Promise<RawEntry>;
  verify(kind: RawEntry["kind"], date: string): Promise<{ ok: boolean; brokenAt?: string }>;
  iterate(filter: { kind?: RawEntry["kind"]; since?: string; until?: string }): AsyncIterable<RawEntry>;
}
```
Default implementation `JsonlRawSink`; tests use `MemoryRawSink`. Registered the same way as `SimulationRegistry`: `config set rawSink <id>`, with external implementations going through the `ext` mechanism (AD-11: passing the contract test is what counts as properly installed — the contract test = append followed by iterate being byte-for-byte identical, plus chain verification).

## V. L1 evidence graph: journal + unified columns

### 5.1 `records_journal` (append-only)

```sql
CREATE TABLE records_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,            -- create | update | tombstone | link
  rev_before INTEGER, rev_after INTEGER,
  actor TEXT, actor_source TEXT,
  patch TEXT NOT NULL,         -- JSON: for update, the diff of {title?,content?,metadata?}; for create, the full record
  prev_hash TEXT, hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```
- `RecordStore.create/update/link` each get one added line that writes a journal row, **in the same transaction**; the 9 call sites are not changed at all
- `RecordStore.history(id)` is a new read-only interface; HTTP `GET /api/records/:id/history`; CLI `report records --history <id>`
- **V24 closed out along the way**: on integrity-verification failure, `records repair <id> --to-seq <n>` rebuilds the projection from the journal (requires `--actor`, and writes a journal row with `op=repair`)
- **V30 closed out along the way**: `LibraryStore.remove()` is changed to a tombstone (`removedAt`), and `retractOrphanRecords()` is wired up to become a production caller

### 5.2 Unified columns

| Column | Values | Written by whom | Scattered metadata it replaces |
|---|---|---|---|
| `quality` | a JSON array, e.g. `["deterministic:false","basis:abstract","simulated","caveat:biorxiv-not-search"]` | each writer (the original metadata is kept as-is; this column is an addition) | V49/V66/G4/V54 |
| `provenance_class` | one of four values | declared by the writer per the mapping table in §7.2; `RecordStore.create()` rejects by default if absent (no default value — the V40 lesson) | none |
| `license` | string/null | same as above | none |

`PROJECT_SCHEMA_VERSION` goes 1 → 2 (`project/manager.ts:11`); `initSchema()` follows the same "ALTER to add columns to old databases" path as D-9; the backfill rule for `provenance_class` on old records: `origin.kind=connector → upstream`, `agent_run/reading/conclusion(model) → model_generated`, `manual/import → user_authored`, everything else `derived`; the backfill result is recorded as one journal row with `op=backfill`.

## VI. L2 export and lakehouse

### 6.1 `spark-research data export`

```
data export [--since <ts>] [--until <ts>] [--for-sharing] [--out <dir>]      # JSONL only
```
Output:
```
export/<ts>/
├── manifest.json     { schemaVersion, project, range, counts{records,raw,artifacts}, licenses{...:count},
│                       provenanceClasses{...:count}, rootHash, generator:{version, commit}, forSharing: bool }
├── records/type=<type>/date=<YYYY-MM-DD>/part-0.jsonl
├── records_journal/date=.../part-0.jsonl
├── raw/kind=<kind>/date=.../part-0.jsonl   (+ blobs/ copied by reference)
└── artifacts/...(execution_records + version table)
```
- Hive-style partitioning, directly queryable in DuckDB with a single `read_json_auto('export/*/records/**/*.jsonl')`; the docs provide 3 example queries
- ~~`--format parquet`~~ **not built in v0.7** (per the user, 2026-09-11: JSONL + DuckDB is enough). The directory conventions and partition columns are already designed to be Parquet-friendly, so adding `--format parquet` in the future is just one `COPY … (FORMAT PARQUET)` after probing for the external `duckdb` CLI, with no change to the data model
- `--for-sharing`: applies the `shareable()` function from §7.3, **always excluding `upstream`**, with the manifest flagged `forSharing:true` and listing the count of exclusions
- `data import <export-dir>`: only does "rebuild into an empty project", used for review-pass reconciliation (§9)

### 6.2 Interface (community replacement point)

```ts
export interface RecordJournal {
  append(entry: JournalEntry): void;           // same transaction as records
  history(recordId: string): JournalEntry[];
  iterate(since?: number): Iterable<JournalEntry>;
}
export interface ExportTarget {
  readonly id: string;                          // "local-dir" | "s3" | ...
  write(rel: string, bytes: Uint8Array): Promise<void>;
  finalize(manifest: Manifest): Promise<string>; // returns a locatable URI
}
```
v0.7 ships only `local-dir`. S3/Iceberg are left to the community or a later version; the contract test is generated by the `new export-target` scaffold (reusing the P15 mechanism).

## VII. L3 feedback-loop control (fields and determination logic, no channel)

### 7.1 Classification definitions

| provenanceClass | Meaning | Example |
|---|---|---|
| `upstream` | Content mirrored in from an external data source | connector responses, downloaded PDFs, AMiner/CNKI results |
| `derived` | Obtained from `upstream` via deterministic processing | normalized paper metadata, simulation output, safety-gate conclusions, statistics |
| `user_authored` | Written by the user themselves | project desc, original idea text, original protocol, approval notes |
| `model_generated` | LLM output | close-reading cards, conclusion drafts, determinator output, agent_run |

### 7.2 Source → class/license mapping table (source of truth lives in `backend/src/provenance/policy.ts`; a gate check verifies it stays consistent with the connector registry — the V34 lesson)

| Source | class | license field |
|---|---|---|
| aminer / cnki / wanfang (credentialed sources) | upstream | `proprietary:<connector>` — **never exported for-sharing, and the raw response body is by default stored only as a hash, not inline** (ToS risk) |
| Public APIs (openalex/crossref/europepmc/pubmed/arxiv/…) | upstream | each source's own declaration (CC0 / CC-BY / non-commercial); `unknown` if `metadata.license` is absent |
| Simulation / wet-lab output | derived | `user-owned` |
| LLM output | model_generated | `user-owned` (provider ToS separately noted as `providerTerms:<provider>`) |
| User input | user_authored | `user-owned` |

### 7.3 `shareable(entry) → { ok: boolean; reason }`

There are only three rules, hard-coded and testable: (1) `upstream` → false; (2) `license` of `unknown` or containing `proprietary:` → false; (3) everything else → true. **No "partial sharing" or "sharing after redaction"** — that belongs to the channel phase.

### 7.4 Shape of the sharing-action approval flow (v0.7 only defines the shape, does not wire up a channel)

Reuses the wet-lab approval pattern: `data share-manifest <export-dir>` generates a pending-approval list → `data approve <manifest-hash> --actor` writes a `decision` record (with metadata carrying `manifestHash`, the exclusion count, and `actorSource`). AD-6: who approved it and which version. AD-14: a subagent cannot approve.

### 7.5 Ruling on the sharing unit (Question 4)

The three candidates were each examined against **what the buyer gets** and **whether edges break**:

| Unit | What the buyer gets | Graph closure | Consent/approval granularity | Conclusion |
|---|---|---|---|---|
| By record type | A pile of same-type nodes (e.g. all close-reading cards) | **Broken**: the other end of `derives_from`/`supports` edges is outside the set, so the trajectory's value drops to zero | Cannot explain "what was consented to" | Not supported |
| By time window | Nodes within a time span | Broken (edges crossing the window) | Explainable, but a topic gets chopped into pieces | Only used as an **increment**, never as the first delivery |
| **By project** | A topic's complete trajectory from idea to conclusion | **Closed**: a project is the graph's natural boundary (AD-1, project-centric) | One approval = one topic; `desc` is the title of the consent document | **The unit for the first export** |

Ruling: **the manifest is unit-of-a-project; subsequent exports of the same project use `--since` to produce a delta, with the manifest carrying `prevManifestHash` to form a chain**; `data import` replays them in chain order. Under `--for-sharing`, type filtering is applied first, then the graph closure is computed: excluded nodes (upstream) are kept in the export as **stubs** (only id/type/hash/provenanceClass, no content), so edges are not broken — the buyer can see "this references an upstream paper" without getting the mirrored content.

### 7.6 Reserved interface for resale (Question 5: not being developed, only aligned to internationally common shapes)

| Aspect | Aligned with | How it shows up in v0.7 |
|---|---|---|
| Delivery protocol | **Delta Sharing** (open REST: share → schema → table, recipient profile + bearer, `/shares/{share}/schemas/{schema}/tables/{table}/query`; championed by Databricks, readable by pandas/Spark) | The manifest's top-level naming follows it: `share = <project-slug>`, `schema = records \| records_journal \| raw \| artifacts`, `table = <type or kind>`. A future read-only endpoint maps directly onto these three levels without changing the export format |
| Dataset description | **DCAT** (W3C) core fields: title / description / issued / modified / license / publisher / distribution | The manifest gains fields of the same name (`dcat:` prefix), with `title`/`description` drawn from project.json |
| License identifier | **SPDX** license expressions; custom licenses use `LicenseRef-<id>` | The `license` column is itself an SPDX expression: public sources use their own declaration (`CC0-1.0` / `CC-BY-4.0` / `LicenseRef-noncommercial`); credentialed sources use `LicenseRef-proprietary-<connector>`; user/model output uses `LicenseRef-spark-user-owned` (a placeholder, with the real license to be determined at resale time) |
| Billing basis | The market mainstream is "per query/event" rather than per GB | Read-only endpoints will in the future reuse the shape of `api_calls.jsonl` to record usage in reverse; not built in v0.7 |
| Versions/revisions | AWS Data Exchange's data set → revision → asset | The manifest chain (§7.5) is itself the revision sequence |

**All that v0.7 delivers is the manifest shape and the license enumeration**; there is no endpoint, no recipient, and no billing.


### 7.7 Regulatory cross-reference (facts only, no legal conclusions)

- Explaining the legality of training data requires source traceability → the three columns `origin` + `provenanceClass` + `license` are exactly that explanatory material
- Upstream mirrors (especially credentialed Chinese-language sources) cannot serve as a resale item → AD-16
- Personal information is essentially not involved; whether research data falls under "important data" is not something judged at the product layer — the manifest merely supplies counts and classifications for a human to judge

## VIII. Gate checks and review pass (AD-12 style, each one able to go red)

| # | Gate check | Negative control |
|---|---|---|
| G1 | **raw coverage**: run the full CLI e2e suite against http/llm stubs, assert that the row count of `raw/connector` == the row count of `api_calls.jsonl`, and the row count of `raw/llm` == the row count of `usage.jsonl` | Remove the base.ts instrumentation → red |
| G2 | **Redaction**: grep the raw directory after a stub call carrying a fake key | Remove the redaction → red |
| G3 | **Chain verification**: tamper with any raw row → `verify()` reports `brokenAt` | — |
| G4 | **Journal reconciliation**: after a random create/update sequence, replaying the journal yields records that match the projection field-for-field | Any update that skips the journal → red |
| G5 | **Export round trip**: `export` → `import` into an empty project → records/edges/journal match row-for-row, manifest rootHash is identical | — |
| G6 | **AD-16**: no `provenanceClass:"upstream"` can be grepped anywhere in `--for-sharing` output; aminer response bodies never appear inline | Change `shareable()` to allow upstream through → red |
| G7 | **Config keys have a reader** (an extension of the V40 gate check): the two new config keys `rawSink`/`rawLlm` must have a consumer in config_reader_parity | — |
| G8 | **Narrative consistency**: every claim in README/llms.txt about "raw data", "exportable", "shareable" maps to one of G1–G6 | — |
| Review pass | The zero-context external review-pass task sheet gains two steps: after completing a topic, run `data export --for-sharing` and manually check the manifest's counts and exclusion reasons; after `data import` into a new project, `report export` diffs empty against the original report | — |

## IX. Intersection with the existing BACKLOG

| Item | Handling |
|---|---|
| V24 integrity errors have no recovery path | Closed out by §5.1's `records repair` |
| V30 deleted papers are unreachable | Closed out by §5.1's tombstone |
| V49 `deterministic` basis | Not settling the basis, but it now enters the `quality` column and is visible on export |
| V54 / V66 | Enter the `quality` column |
| V63 `rateLimitWaitMs` | The raw connector row carries the real value along the way (changing `ratelimit.ts`'s return shape) |
| V57 spending-path review pass | The review-pass task sheet gains the two export steps (§VIII) |
| V76 staged connector | The onboarding template for new connectors must declare a license (the table in §7.2 is a prerequisite for onboarding) |
| DESIGN.md §5.2 / AD table | Add AD-15, AD-16; §5.2 gains a "four layers" diagram |

## X. Waves and lanes (position within v0.7 to be determined at integration time)

| Wave | Content | Footprint (ownership) | Risk |
|---|---|---|---|
| **W7-D0** (can be bundled into v0.7's first wave) | L0 instrumentation ×4 + `RawSink` default implementation + redaction + chain + G1/G2/G3; L3's three columns and the §7.2 mapping table + backfill migration + G6/G7 | `connectors/base.ts` · `usage/ledger.ts` · `artifacts/store.ts` (one line) · `lab/wet_loop.ts` (one line) · **new directories `backend/src/raw/`, `backend/src/provenance/`** · `project/{manager,records,models}.ts` (columns/paths added) | Low — it's all additive; the only semantic change is `create()` rejecting when `provenanceClass` is missing (sweeping 10 writer modules, backstopped by gate check G1) |
| **W7-D1** | `records_journal` + `history` + `repair` + tombstone + G4; V24/V30 closed out | `project/records.ts` · `literature/library.ts` · `report/cli.ts` · `server/routes/records.ts` | Medium — touches inside `update()` but not its callers; the D-9 integrity-verification regression must always be run (`tests/unit/lab_*`) |
| **W7-D2** | `data export/import` + manifest + DuckDB docs + Parquet probing + G5/G8 + the two review-pass task-sheet steps | new `backend/src/data/` · `index.ts` (one case) · README/llms.txt/INSTALL | Medium — the binary smoke test needs the export path added (the V27 family) |
| Future versions | S3 `ExportTarget`, archive compression, the feedback-loop channel and billing, a Delta-Sharing-style read-only endpoint | — | — |

All three waves require: the six-suite battery + binary smoke test + consumer sweep (Discipline 13) + single merge authority (Discipline 14).

## XI. Risks

| Risk | Mitigation |
|---|---|
| Disk growth (LLM originals + response bodies) | The threshold in §4.3 routes large ones into blobs plus dedup; `data archive`; estimated under 50 MB per topic, no compression for now, to be pinned down with real data after R3 |
| Synchronous jsonl writes slowing the hot path | Single-row append uses `appendFileSync`; R1 measured 200–900 ms per connector call, with the disk write under 1 ms and thus negligible; the same applies to LLM calls |
| User privacy (desc/notes entering raw) | raw shares the same directory and permissions (0700) as records, adding no exposure surface; `--for-sharing` does not automatically clear sensitive `user_authored` items — v0.7 allows everything through for now, leaving the field in place, with sensitive-item rules to be defined at the resale stage |
| `create()` rejecting a missing `provenanceClass` will turn old external-extension writers red | Update the extension contract test plus a version's worth of deprecation warning rather than outright rejection (consistent with the V21 deprecation-cycle convention) |
| (Former) Parquet unavailable inside the binary | v0.7 doesn't build Parquet, so the risk disappears; JSONL is always available |
| Raw response bodies from credentialed sources storing content the ToS disallows | Per §7.2: credentialed sources store only a hash inline by default, not the content; `config set rawUpstreamInline on` is needed to store it, and it never enters for-sharing regardless |

## XII. Open questions — all settled as of 2026-09-11 (answers in §0)

| # | Question | Conclusion | Decided by |
|---|---|---|---|
| 1 | raw on/off by default | On by default, local only | User |
| 2 | LLM original retention period | Permanent | User |
| 3 | Parquet | Not built; JSONL + DuckDB | User |
| 4 | Sharing unit | By project, time windows only as increments, chained manifest; slicing by type not supported | Main-session analysis (§7.5), authorized by the user |
| 5 | Resale license text | Resale not developed; interface aligned to Delta Sharing / DCAT / SPDX | User (direction) + main session (alignment targets) |
| 6 | raw/kernel mirror or reference | Reference + contentHash | Undecided by the user, ruled on by the main session (note in §4.1) |

**Still open (to be revisited when entering the repo for cleanup)**: the real license text for `LicenseRef-spark-user-owned` — does not affect v0.7's implementation.

---

## Appendix · What we are not doing, and why (so it doesn't get relitigated)

- **Not doing full event-sourcing replay**: state machines (wet-lab D-9, CAS) are built on the mutable projection; replay would require rewriting all 9 call sites, and the payoff doesn't match the cost; the journal already satisfies audit and recovery needs
- **Not replacing SQLite**: the hot layer's query patterns (graph traversal, CAS) are well served by SQLite; lakehouse concerns belong to the export layer
- **Not bundling an S3 SDK**: local-first; once exported to a directory, the user runs their own `aws s3 sync`
- **Not doing redacted sharing**: that is a product decision for the channel phase; v0.7 only guarantees "can be determined, can be excluded, can be audited"
