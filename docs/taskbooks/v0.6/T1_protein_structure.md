# T1 · Protein Structure Prediction and Design: Progress over the Past Three Years (EN)

> B2 round taskbook · Language: English · Budget: $2 (actual LLM spend, `maxCostUsd` enforced)
> Coverage: full literature pipeline + protein-analysis skill; if structural data is produced → triggers A3 (3D view) review

## Research Question (one sentence)

What are the methodological advances and open problems in protein structure prediction and de novo design (AlphaFold family and successors) from 2023–2026?

## Search Queries

- `protein structure prediction deep learning` (2023-2026)
- `de novo protein design diffusion model`
- `AlphaFold3 co-folding ligand`
- Sources: default set of 6 sources (openalex/crossref/europepmc/semanticscholar/arxiv/pubmed)

## Pre-registered Core Literature (Recall Acceptance-Criterion Baseline)

> ⚠️ Status: **Frozen (2026-09-11)** — 8 papers, independently compiled as an OpenAlex/arXiv baseline, covering
> milestones in the field such as AlphaFold/ESMFold/RFdiffusion/ProteinMPNN.

| # | Title | Year | Source | Rationale for inclusion |
|---|---|---|---|---|
| 1 | Accurate structure prediction of biomolecular interactions with AlphaFold 3 | 2024 | 10.1038/s41586-024-07487-w | Published in Nature; 15609 citations; extends AF2 to ligand-protein co-folding, an authoritative milestone in the field |
| 2 | Evolutionary-scale prediction of atomic-level protein structure with a language model | 2023 | 10.1126/science.ade2574 | Published in Science; 5485 citations; ESMFold open-source framework, a widely recognized benchmark in the protein language model direction |
| 3 | De novo design of protein structure and function with RFdiffusion | 2023 | 10.1038/s41586-023-06415-8 | Nature; 2219 citations; a landmark work in diffusion-model-based protein design, widely reproduced and applied |
| 4 | Fast and accurate protein structure search with Foldseek | 2023 | 10.1038/s41587-023-01773-0 | Nature Biotechnology; 2573 citations; 3D structure search infrastructure, an essential tool for bioinformatics databases |
| 5 | De novo design of luciferases using deep learning | 2023 | 10.1038/s41586-023-05696-3 | Nature; 464 citations; validates combined ProteinMPNN/RFdiffusion design, empirical evidence of design feasibility |
| 6 | Illuminating protein space with a programmable generative model | 2023 | 10.1038/s41586-023-06728-8 | Nature; 452 citations; evaluates the capability of generative protein models, exploring the structure of protein space |
| 7 | ProGen2: Exploring the boundaries of protein language models | 2023 | 10.1016/j.cels.2023.10.002 | Cell Systems; 463 citations; analysis of the generalization ability of pretrained language models in sequence generation |
| 8 | Improving de novo protein binder design with deep learning | 2023 | 10.1038/s41467-023-38328-5 | Nature Commun.; 398 citations; validates binding-affinity design, a representative usability evaluation study |

## Execution Script

Execute per the nine-step round protocol in `DEVELOPMENT_PLAN_v0.6.md` §4, using model `z-ai/glm-5.3-flash`.

## Acceptance Criteria

1. ≥10 papers ingested, all deep-read cards generated, review passes citation verification (hard finding = 0)
2. 2 idea cards + novelty check completed (both the model's original judgment and the corrected judgment are logged)
3. report export produces a readable report; the review gate reaches approved, or there is a clear veto rationale
4. Cost ≤$2 and unknownCostCalls = 0
5. Metrics table (§5) fully filled in
