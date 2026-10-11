export type ApprovalMode = "ui" | "tool";

/** `tool` skips confirm and input dialogs. `mcp_tasks_respond` is the approval. */
export function approvalMode(flag: boolean | string | undefined, env = process.env.PI_MCP_TASKS_APPROVALS): ApprovalMode {
  const raw = (typeof env === "string" && env.length > 0 ? env : typeof flag === "string" ? flag : "ui").trim().toLowerCase();
  return raw === "tool" ? "tool" : "ui";
}
