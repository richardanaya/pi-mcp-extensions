/** Client requirements for elicitation (2026-07-28, 2025-11-25, SEP-1036, SEP-2322). */

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
    text: "Declare elicitation form and url on initialize, and keep every other capability.",
    status: "implemented",
    test: "C-MUST-01",
  },
  {
    id: "C-MUST-02",
    level: "MUST",
    text: "Name the server that is asking.",
    status: "implemented",
    test: "C-MUST-02",
  },
  {
    id: "C-MUST-03",
    level: "MUST",
    text: "Send accept, decline, or cancel. Dismissing a dialog is cancel. Decline is the explicit refusal.",
    status: "implemented",
    test: "C-MUST-03",
  },
  {
    id: "C-MUST-04",
    level: "MUST",
    text: "Let the user review and modify a form before accept, and send the content with accept.",
    status: "implemented",
    test: "C-MUST-04",
  },
  {
    id: "C-MUST-05",
    level: "MUST",
    text: "Show the full URL and the host, get consent before opening, and never open or prefetch otherwise.",
    status: "implemented",
    test: "C-MUST-05",
  },
  {
    id: "C-MUST-06",
    level: "MUST",
    text: "Treat a request with no mode as form mode.",
    status: "implemented",
    test: "C-MUST-06",
  },
  {
    id: "C-MUST-07",
    level: "MUST",
    text: "Omit content on URL accept, decline, and cancel.",
    status: "implemented",
    test: "C-MUST-07",
  },
  {
    id: "C-MUST-08",
    level: "MUST",
    text: "Open a consented URL in an external browser so the client cannot read the page or what the user types.",
    status: "implemented",
    test: "C-MUST-08",
  },
  {
    id: "C-MUST-09",
    level: "MUST",
    text: "Build inputResponses for an input_required elicitation before retrying the original request.",
    status: "implemented",
    test: "C-MUST-09",
  },
  {
    id: "C-MUST-10",
    level: "MUST",
    text: "Echo requestState exactly when the result included it, and omit it when the result did not.",
    status: "implemented",
    test: "C-MUST-10",
  },
  {
    id: "C-MUST-11",
    level: "MUST",
    text: "Retry with a new JSON-RPC id, and do not attach one request's inputResponses or requestState to another request.",
    status: "implemented",
    test: "C-MUST-11",
  },
  {
    id: "C-MUST-12",
    level: "MUST",
    text: "Treat a result that omits resultType as complete.",
    status: "implemented",
    test: "C-MUST-12",
  },
  {
    id: "C-MUST-13",
    level: "MUST",
    text: "Answer a server-initiated elicitation/create from a 2025-11-25 server.",
    status: "implemented",
    test: "C-MUST-13",
  },
  {
    id: "C-MUST-14",
    level: "MUST",
    text: "Ignore notifications/elicitation/complete for an unknown or already-completed elicitation id.",
    status: "implemented",
    test: "C-MUST-14",
  },
  {
    id: "C-MUST-15",
    level: "MUST",
    text: "When there is no UI and tool mode is not configured, cancel immediately instead of waiting.",
    status: "implemented",
    test: "C-MUST-15",
  },
  {
    id: "C-MUST-16",
    level: "MUST",
    text: "Validate form content before accept: required fields, types, enum, oneOf, format, length, pattern, and minimum, maximum, and item bounds.",
    status: "implemented",
    test: "C-MUST-16",
  },
  {
    id: "C-MUST-17",
    level: "MUST",
    text: "Do not retry an input_required result whose inputRequests include a method other than elicitation/create.",
    status: "implemented",
    test: "C-MUST-17",
  },
  {
    id: "C-SHOULD-01",
    level: "SHOULD",
    text: "Pre-populate form fields from defaults and let the user change them.",
    status: "implemented",
    test: "C-SHOULD-01",
  },
  {
    id: "C-SHOULD-02",
    level: "SHOULD",
    text: "Highlight the URL host and warn on Punycode and non-https URLs.",
    status: "implemented",
    test: "C-SHOULD-02",
  },
  {
    id: "C-SHOULD-03",
    level: "SHOULD",
    text: "Do not treat a URL in a form field as something to open.",
    status: "implemented",
    test: "C-SHOULD-03",
  },
  {
    id: "C-SHOULD-04",
    level: "SHOULD",
    text: "Offer a manual retry when a URL completion notification never arrives.",
    status: "implemented",
    test: "C-SHOULD-04",
  },
  {
    id: "C-SHOULD-05",
    level: "SHOULD",
    text: "Show oneOf and multi-select titles, and submit the const values.",
    status: "implemented",
    test: "C-SHOULD-05",
  },
  {
    id: "C-SHOULD-06",
    level: "SHOULD",
    text: "In tool mode, answer through mcp_elicitations_respond instead of opening a dialog.",
    status: "implemented",
    test: "C-SHOULD-06",
  },
  {
    id: "C-MAY-01",
    level: "MAY",
    text: "Retry a request that failed with URLElicitationRequiredError (-32042) after notifications/elicitation/complete.",
    status: "implemented",
    test: "C-MAY-01",
  },
  {
    id: "C-MAY-02",
    level: "MAY",
    text: "Offer protocol 2026-07-28 only behind --mcp-elicitations-protocol. Leave pi's negotiation unchanged otherwise.",
    status: "implemented",
    test: "C-MAY-02",
  },
  {
    id: "C-MAY-03",
    level: "MAY",
    text: "List elicitations that are waiting for a tool response.",
    status: "implemented",
    test: "C-MAY-03",
  },
];
