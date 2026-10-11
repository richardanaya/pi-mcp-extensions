/** Client-side SEP-2663 requirements and the test that covers each one. */

export type RequirementLevel = "MUST" | "SHOULD" | "MAY";

export interface Requirement {
  id: string;
  level: RequirementLevel;
  text: string;
  status: "implemented";
  test: string;
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    id: "C-MUST-01",
    level: "MUST",
    text: "Handle either CallToolResult or CreateTaskResult for a supported request (tools/call).",
    status: "implemented",
    test: "C-MUST-01",
  },
  {
    id: "C-MUST-02",
    level: "MUST",
    text: "Treat CreateTaskResult on an unsupported request type as an invalid response.",
    status: "implemented",
    test: "C-MUST-02",
  },
  {
    id: "C-MUST-03",
    level: "MUST",
    text: "Inspect inputRequests when a task is input_required.",
    status: "implemented",
    test: "C-MUST-03",
  },
  {
    id: "C-MUST-04",
    level: "MUST",
    text: "Apply the same trust model to inputRequests as to a direct elicitation or sampling request.",
    status: "implemented",
    test: "C-MUST-04",
  },
  {
    id: "C-MUST-05",
    level: "MUST",
    text: "Cancel tasks with tasks/cancel, never notifications/cancelled.",
    status: "implemented",
    test: "C-MUST-05",
  },
  {
    id: "C-MUST-06",
    level: "MUST",
    text: "Set Mcp-Name to the task id on tasks/get, tasks/update, and tasks/cancel over Streamable HTTP.",
    status: "implemented",
    test: "C-MUST-06",
  },
  {
    id: "C-MUST-07",
    level: "MUST",
    text: "Do not call the removed tasks/result method.",
    status: "implemented",
    test: "C-MUST-07",
  },
  {
    id: "C-MUST-08",
    level: "MUST",
    text: "Do not send the legacy task parameter on tools/call.",
    status: "implemented",
    test: "C-MUST-08",
  },
  {
    id: "C-MUST-09",
    level: "MUST",
    text: "Do not advertise legacy tasks.requests, tasks.list, or tasks.cancel capabilities.",
    status: "implemented",
    test: "C-MUST-09",
  },
  {
    id: "C-MUST-10",
    level: "MUST",
    text: "Declare io.modelcontextprotocol/tasks on tools/call and on task protocol requests.",
    status: "implemented",
    test: "C-MUST-10",
  },
  {
    id: "C-MUST-11",
    level: "MUST",
    text: "Keep a tool result with isError true on the completed status, not failed.",
    status: "implemented",
    test: "C-MUST-11",
  },
  {
    id: "C-MUST-12",
    level: "MUST",
    text: "Surface a failed task's JSON-RPC error to the user and the model.",
    status: "implemented",
    test: "C-MUST-12",
  },
  {
    id: "C-SHOULD-01",
    level: "SHOULD",
    text: "Keep the set of task-augmented methods open so later revisions can add request types.",
    status: "implemented",
    test: "C-SHOULD-01",
  },
  {
    id: "C-SHOULD-02",
    level: "SHOULD",
    text: "Honor pollIntervalMs, including a value that changes between polls.",
    status: "implemented",
    test: "C-SHOULD-02",
  },
  {
    id: "C-SHOULD-03",
    level: "SHOULD",
    text: "Keep polling until the task is terminal or the client cancels it.",
    status: "implemented",
    test: "C-SHOULD-03",
  },
  {
    id: "C-SHOULD-04",
    level: "SHOULD",
    text: "Persist task ids so polling can resume after a restart.",
    status: "implemented",
    test: "C-SHOULD-04",
  },
  {
    id: "C-SHOULD-05",
    level: "SHOULD",
    text: "Fulfill input_required by sending inputResponses on tasks/update.",
    status: "implemented",
    test: "C-SHOULD-05",
  },
  {
    id: "C-SHOULD-06",
    level: "SHOULD",
    text: "After tasks/update, keep observing the task until it is terminal.",
    status: "implemented",
    test: "C-SHOULD-06",
  },
  {
    id: "C-SHOULD-07",
    level: "SHOULD",
    text: "Deduplicate inputRequests keys across polls.",
    status: "implemented",
    test: "C-SHOULD-07",
  },
  {
    id: "C-SHOULD-08",
    level: "SHOULD",
    text: "Do not send inputResponses for a key that was already answered.",
    status: "implemented",
    test: "C-SHOULD-08",
  },
  {
    id: "C-SHOULD-09",
    level: "SHOULD",
    text: "Show statusMessage to the user and include it in what the model sees.",
    status: "implemented",
    test: "C-SHOULD-09",
  },
  {
    id: "C-MAY-01",
    level: "MAY",
    text: "Expose the task lifecycle with list, inspect, cancel, and respond tools, and a status widget.",
    status: "implemented",
    test: "C-MAY-01",
  },
  {
    id: "C-MAY-02",
    level: "MAY",
    text: "Treat createdAt plus ttlMs as a backstop when the task never reaches a terminal status.",
    status: "implemented",
    test: "C-MAY-02",
  },
  {
    id: "C-MAY-03",
    level: "MAY",
    text: "Subscribe to notifications/tasks and keep polling.",
    status: "implemented",
    test: "C-MAY-03",
  },
  {
    id: "C-MAY-04",
    level: "MAY",
    text: "Drop answered input-request state after tasks/cancel.",
    status: "implemented",
    test: "C-MAY-04",
  },
  {
    id: "C-MAY-05",
    level: "MAY",
    text: "Accept a later terminal notification after a cooperative cancel.",
    status: "implemented",
    test: "C-MAY-05",
  },
];
