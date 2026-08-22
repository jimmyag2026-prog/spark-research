export const PERMIT_SETS = {
  control_repl: [
    "mcp_call",
    "create_agent",
    "delegate_task",
    "query_frames",
    "manage_skills",
    "compute_submit",
  ],
  python_kernel: [
    "artifact_lookup",
    "lineage_query",
    "model_call",
    "credentials",
    "analytic_libraries",
  ],
  r_kernel: [
    "artifact_lookup",
    "lineage_query",
    "model_call",
    "credentials",
    "analytic_libraries",
  ],
} as const;

const KERNEL_TYPE_TO_PERMIT: Record<string, keyof typeof PERMIT_SETS> = {
  python: "python_kernel",
  r: "r_kernel",
  control_repl: "control_repl",
};

export class PermissionDeniedError extends Error {
  readonly kernelId?: string;
  readonly kernelType: string;
  readonly method: string;

  constructor(kernelId: string | undefined, kernelType: string, method: string) {
    super(
      `PermissionDenied: kernel '${kernelId ?? "?"}' (${kernelType}) is not permitted to call '${method}'`,
    );
    this.name = "PermissionDeniedError";
    this.kernelId = kernelId;
    this.kernelType = kernelType;
    this.method = method;
  }
}

export class PermissionManager {
  getPermitSet(kernelType: string): readonly string[] {
    const key = (KERNEL_TYPE_TO_PERMIT[kernelType] ?? kernelType) as keyof typeof PERMIT_SETS;
    const set = PERMIT_SETS[key];
    if (!set) throw new Error(`Unknown kernel type: '${kernelType}'`);
    return set;
  }

  hasPermission(kernelType: string, method: string): boolean {
    return this.getPermitSet(kernelType).includes(method);
  }
}
