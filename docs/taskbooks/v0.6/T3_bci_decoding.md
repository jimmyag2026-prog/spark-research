# T3 · Brain-Computer Interface Signal Decoding (Chinese)

> B2 round taskbook · Language: Chinese · Budget: $2 (actual LLM spend, `maxCostUsd` enforced)
> Coverage: **AMiner Chinese primary path** · V8 Chinese recall baseline measurement · mixed Chinese/English literature processing
> ⚠️ Scheduling constraint: the AMiner key expires on 2026-10-07; this task round must be executed before then

## Research Question (one sentence)

What is the progress over the past three years, and what are the clinical translation bottlenecks, for neural signal decoding methods (motor intent / speech decoding) in invasive and non-invasive brain-computer interfaces?

## Search Queries

- AMiner Chinese: `脑机接口 信号解码`, `运动意图解码 神经信号`, `脑机接口 语音解码`
- Control group (English source, for comparison against Chinese recall): `brain-computer interface neural decoding`
- Primary source: `--sources aminer`; control search uses the default set of 6 sources

## Pre-registered Core Literature (Recall Acceptance-Criterion Baseline)

> ⚠️ Status: **Frozen (2026-09-11)** — 8 papers (3 Chinese via AMiner + 5 English via OpenAlex),
> covering recent progress in invasive/non-invasive brain-computer interfaces, motor/speech decoding, and neural signal processing.

| # | Title | Year | Source | Rationale for inclusion |
|---|---|---|---|---|
| 1 | Adaptive Temporal Alignment-Based Motion Intention Recognition for Robotic Arm Control | 2025 | 68fa8ac6163c01c850043178 | AMiner Chinese; latest as of 2025; dynamic alignment method for motion intention recognition |
| 2 | Motor Intention Recognition of Upper Extremity Active Rehabilitation Training Based on Transfer Learning | 2023 | 6422c69d90e50fcafd329299 | AMiner Chinese; motor intention decoding for upper-extremity active rehabilitation training; transfer-learning practice |
| 3 | Research Progress on the Coding and Decoding of Scalp Electroencephalogram Signals | 2023 | 64626435d68f896efa560f8e | AMiner Chinese; a review; summary of foundational progress in EEG signal encoding/decoding |
| 4 | A high-performance speech neuroprosthesis | 2023 | 10.1038/s41586-023-06377-x | Nature; 576 citations; implementation of a speech-decoding neuroprosthesis; a milestone in clinical application of invasive BCIs |
| 5 | A high-performance neuroprosthesis for speech decoding and avatar control | 2023 | 10.1038/s41586-023-06443-4 | Nature; 525 citations; extends speech decoding to avatar control; a comprehensive multimodal application |
| 6 | Semantic reconstruction of continuous language from non-invasive brain recording | 2023 | 10.1038/s41593-023-01304-9 | Nature Neuroscience; 394 citations; non-invasive fMRI-based semantic reconstruction of language; significant for comparative validation |
| 7 | A Generalist Intracortical Motor Decoder | 2025 | 67a5d8d8ae8580e7ff6dfac6 | AMiner English; latest as of 2025; a generalist intracortical-electrode motor decoder |
| 8 | TRACE: Transformer for Regularized and Accurate Cortical ECoG Motor Decoding | 2026 | 6aa1e9d40a96f8c83ce84878 | AMiner English; 2026 frontier work; application of Transformer architecture to cortical ECoG motor decoding |

## Execution Script

Follow the nine-step protocol in §4. **Additional observation**: in step 1, separately record the hit count and recall rate
for the AMiner Chinese search and the English control search (V8 baseline figures); separately log AMiner's call count and result codes via `usage api` (continuation of G-4).

## Acceptance Criteria

T1's 5 general acceptance criteria + a 6th: the V8 Chinese recall baseline figures are produced (even if poor — the goal is to obtain the numbers,
not to fix the issue in this round) + a complete AMiner call ledger (429/401 responses recorded truthfully).
