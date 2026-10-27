export type ApprovalMode = "ui" | "tool";

/** `tool` skips dialogs. `mcp_elicitations_respond` is the answer. The environment variable wins. */
export function approvalMode(flag: boolean | string | undefined, env = process.env.PI_MCP_ELICITATIONS_APPROVALS): ApprovalMode {
  const raw = (typeof env === "string" && env.length > 0 ? env : typeof flag === "string" ? flag : "ui").trim().toLowerCase();
  return raw === "tool" ? "tool" : "ui";
}

/**
 * pi 1.4.0 offers `2025-11-25`. `2026-07-28` is opt-in and only useful with a server that
 * still completes `initialize`. Anything else leaves negotiation unchanged.
 */
export function protocolOffer(flag: boolean | string | undefined, env = process.env.PI_MCP_ELICITATIONS_PROTOCOL): "2026-07-28" | undefined {
  const raw = (typeof env === "string" && env.length > 0 ? env : typeof flag === "string" ? flag : "").trim();
  return raw === "2026-07-28" ? "2026-07-28" : undefined;
}
