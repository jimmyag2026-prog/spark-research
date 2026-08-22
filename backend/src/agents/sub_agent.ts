import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMRouter } from "../llm/router";

export type SubAgentType = "explore" | "execute" | "review" | "lab";

export interface SubAgentConfig {
  name: string;
  type: SubAgentType;
  model: string;
  prompt: string;
  permission: string[];
}

const DEFAULT_MODELS: Record<SubAgentType, string> = {
  explore: LLMRouter.DEFAULT_MODEL,
  execute: LLMRouter.DEFAULT_MODEL,
  review: LLMRouter.DEFAULT_MODEL,
  lab: LLMRouter.DEFAULT_MODEL,
};

const DEFAULT_PERMISSIONS: Record<SubAgentType, string[]> = {
  explore: ["read_frames", "read_artifacts", "read_lineage", "scoped_query"],
  execute: ["python", "write_artifact", "read_artifacts", "compute_submit"],
  review: ["read_frames", "read_artifacts", "read_lineage", "scoped_query"],
  lab: ["lab_control", "read_frames", "read_artifacts"],
};

const INLINE_PROMPTS: Record<SubAgentType, string> = {
  explore:
    "You are an Explore sub-agent. Gather breadth over literature and data before committing to an approach. Return evidence-labeled findings and candidate sources.",
  execute:
    "You are an Execute sub-agent. Run the assigned analysis exactly as specified. Do not fabricate results; report observable execution records and write artifacts to the session workspace.",
  review:
    "You are the independent reviewer. Read-only verification pass over the session's artifacts. TRACE DON'T RECOMPUTE; weight findings by location.",
  lab: "You are a Lab sub-agent. Operate lab devices through connectors under the safety gate. Record every device action as an observable execution record.",
};

const REVIEW_PROMPT_FILE = "reviewer.txt";

export class SubAgent {
  readonly name: string;
  readonly type: SubAgentType;
  readonly model: string;
  readonly prompt: string;
  readonly permission: string[];

  constructor(config: SubAgentConfig) {
    this.name = config.name;
    this.type = config.type;
    this.model = config.model;
    this.prompt = config.prompt;
    this.permission = [...config.permission];
  }
}

function loadPromptFile(dir: string, filename: string): string | null {
  try {
    return readFileSync(join(dir, filename), "utf8");
  } catch {
    return null;
  }
}

export class SubAgentFactory {
  private promptDir: string;

  constructor(promptDir = join(import.meta.dir, "prompt")) {
    this.promptDir = promptDir;
  }

  create(
    type: SubAgentType,
    overrides: Partial<Omit<SubAgentConfig, "type">> = {},
  ): SubAgent {
    const inline = INLINE_PROMPTS[type];
    const prompt =
      overrides.prompt ??
      (type === "review" ? (loadPromptFile(this.promptDir, REVIEW_PROMPT_FILE) ?? inline) : inline);
    return new SubAgent({
      name: overrides.name ?? type,
      type,
      model: overrides.model ?? DEFAULT_MODELS[type],
      prompt,
      permission: overrides.permission ?? DEFAULT_PERMISSIONS[type],
    });
  }
}
