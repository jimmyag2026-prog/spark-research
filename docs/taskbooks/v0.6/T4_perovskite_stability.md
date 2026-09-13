# T4 · Perovskite Solar Cell Stability (Chinese)

> B2 round taskbook · Language: Chinese · Budget: $2 (actual LLM spend, `maxCostUsd` enforced)
> Coverage: AMiner Chinese + Chinese/English mixed literature **deduplication** (dual Chinese/English publication of the same work is a distinctive observation point for this task)
> ⚠️ Scheduling constraint: same as T3 — execute before the AMiner key expires

## Research Question (one sentence)

What has been the progress over the past three years on perovskite solar cell stability bottlenecks (humidity/thermal/light-induced degradation) and on encapsulation and compositional-engineering countermeasures?

## Search Queries

- AMiner Chinese: `钙钛矿太阳能电池 稳定性`, `钙钛矿 封装 降解`
- English mixed search: `perovskite solar cell stability encapsulation`
- Primary source: `--sources aminer` + default set of 6 sources, ingested together (deliberately creating a Chinese/English deduplication scenario)

## Pre-registered Core Literature (Recall Acceptance-Criterion Baseline)

> ⚠️ Status: **Frozen (2026-09-11)** — same discipline as T1. The baseline includes a number of Chinese and English entries, annotated to indicate which are bilingual versions of the same work.

| # | Title | Year | Source ID | Rationale for inclusion |
|---|---|---|---|---|
| 1 | Research Progress in the Stability of Inorganic Perovskite Solar Cells (CN, Chinese original) | 2020 | AMiner 5f64918dd36f8db06e179c39 | Review of progress on inorganic perovskite stability, an authoritative Chinese-language publication; covers humidity, thermal, and light-induced degradation |
| 2 | A Brief Survey on the Stability Study of Organometal Halide Perovskite Solar Cells (CN, Chinese original) | 2018 | AMiner 604b417d6f90b7f6cae2ad72 | A focused study on the stability of organic-inorganic hybrid perovskites, a foundational Chinese-language publication |
| 3 | Research Progress on the Stability of Perovskite Solar Cells (CN, Chinese original) | 2020 | AMiner 604b60b06f90b7f6cadb06de | A multi-angle review of perovskite stability, a compilation of localized Chinese research |
| 4 | Halide Perovskite Photovoltaics: Background, Status, and Future Prospects | 2019 | https://doi.org/10.1021/acs.chemrev.8b00539 | An internationally authoritative review, 3091 citations; a core reference on stability mechanisms and encapsulation engineering |
| 5 | Consensus statement for stability assessment and reporting for perovskite photovoltaics based on ISOS procedures | 2020 | https://doi.org/10.1038/s41560-019-0529-5 | Standards and protocols for stability testing and evaluation, 1788 citations; industry standardization work from the past three years |
| 6 | Pseudo-halide anion engineering for α-FAPbI3 perovskite solar cells | 2021 | https://doi.org/10.1038/s41586-021-03406-5 | Compositional engineering for stability improvement, 3095 citations; a representative example of recent encapsulation and structural innovation |
| 7 | Efficient, stable and scalable perovskite solar cells using poly(3-hexylthiophene) | 2019 | https://doi.org/10.1038/s41586-019-1036-3 | Hole-transport-layer stability, 2319 citations; a practical case study in encapsulation and device integration |
| 8 | Imperfections and their passivation in halide perovskite solar cells | 2019 | https://doi.org/10.1039/c8cs00853a | Defect passivation and stability, 1952 citations; a deep theoretical foundation for degradation mechanisms and countermeasures |

**Expected Chinese/English deduplication observation**: rows #1-3 are Chinese originals (AMiner); rows #4-8 are English (OpenAlex). No clear bilingual version pairs of the same work were found in the search (Chinese-language publications may be concentrated in domestic conferences/journals, and AMiner's coverage is relatively limited).

## Execution Script

Follow the nine-step protocol in §4. **Additional observation**: after ingestion, check dedupe behavior — whether the same work under mixed Chinese/English search is
correctly merged or incorrectly merged (W5-1 fixed a `firstAuthorSurname` misalignment issue; this is a real-world re-verification of that fix).

## Acceptance Criteria

T1's 5 general acceptance criteria + a 6th: the Chinese/English deduplication behavior has a written observation record (counts for correct merges, incorrect merges, and missed merges).
