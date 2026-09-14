# T2 · Comparison of Single-Cell Transcriptomic Clustering Methods (EN)

> B2 round taskbook · Language: English · Budget: $2 (actual LLM spend, `maxCostUsd` enforced)
> Coverage: full literature pipeline + scanpy platform dry-lab closed loop (`sc-cluster`)

## Research Question (one sentence)

What do benchmark comparisons conclude about single-cell RNA-seq clustering methods (Leiden/Louvain family vs. deep-learning-based methods), and how do resolution choice and batch effects affect clustering stability?

## Search Queries

- `single-cell RNA-seq clustering benchmark`
- `scRNA-seq Leiden Louvain comparison`
- `clustering stability batch effect single cell`
- Sources: default set of 6 sources

## Pre-registered Core Literature (Recall Acceptance-Criterion Baseline)

> ⚠️ Status: **Frozen (2026-09-11)** — same discipline as T1: independently compiled, frozen before the run starts, the executor does not participate.

| # | Title | Year | Source ID | Rationale for inclusion |
|---|---|---|---|---|
| 1 | SCANPY: large-scale single-cell gene expression data analysis | 2018 | https://doi.org/10.1186/s13059-017-1382-0 | Mainstream single-cell analysis platform, 9816 citations; includes built-in Leiden clustering as a baseline |
| 2 | From Louvain to Leiden: guaranteeing well-connected communities | 2019 | https://doi.org/10.1038/s41598-019-41695-z | Original Leiden algorithm paper, 5552 citations; directly addresses the task-critical Leiden vs. Louvain benchmark |
| 3 | Fast unfolding of communities in large networks | 2008 | https://doi.org/10.1088/1742-5468/2008/10/p10008 | Foundational Louvain algorithm method, 21717 citations; a landmark work in the community detection field |
| 4 | Current best practices in single‐cell RNA‐seq analysis: a tutorial | 2019 | https://doi.org/10.15252/msb.20188746 | Best-practices review for single-cell analysis, 2471 citations; covers clustering stability and parameter selection |
| 5 | Batch effects in single-cell RNA-sequencing data are corrected by matching mutual nearest neighbors | 2018 | https://doi.org/10.1038/nbt.4091 | Batch-effect correction method, 2792 citations; directly supports the sub-question of "how batch effects affect stability" |
| 6 | Normalization and variance stabilization of single-cell RNA-seq data using regularized negative binomial regression | 2019 | https://doi.org/10.1186/s13059-019-1874-1 | Normalization and variance stabilization, 5096 citations; the effect of preprocessing on clustering stability |
| 7 | A benchmark of batch-effect correction methods for single-cell RNA sequencing data | 2020 | https://doi.org/10.1186/s13059-019-1850-9 | Benchmark comparison of batch-correction methods, 1247 citations; systematically evaluates differences in clustering performance across batch-correction methods |
| 8 | Clustering trees: a visualization for evaluating clusterings at multiple resolutions | 2018 | https://doi.org/10.1093/gigascience/giy083 | Multi-resolution visualization and evaluation, 1211 citations; directly supports the acceptance criterion for "resolution selection" |

## Execution Script

Follow the nine-step protocol in §4. **Additional dry-lab step**: after the deep read, run `sc-cluster` once
on the scanpy platform (bring your own dataset: synthesizing a small counts CSV is sufficient — clarified by R2 real-world testing: the platform does not ship a built-in sample dataset; the taskbook's earlier statement was incorrect), producing an observation to feed into the evidence chart, with the report's conclusion citing that observation.

## Acceptance Criteria

T1's 5 general acceptance criteria + a 6th: the scanpy dry-lab observation successfully feeds into the evidence chart and is cited by the conclusion
(real-world usage validation of the S2 fix path).
