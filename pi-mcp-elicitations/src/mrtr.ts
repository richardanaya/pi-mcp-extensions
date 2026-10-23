/**
 * SEP-2322 multi round-trip requests, as published in protocol 2026-07-28.
 * A missing `resultType` is a completed result from an older server.
 */

import { isRecord } from "./schema.ts";

export const MRTR_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

/** Enough rounds for the SDK example (confirm, then URL) with a little room. Stops a loop. */
export const MAX_MRTR_ROUNDS = 5;

export const URL_ELICITATION_REQUIRED = -32042;

export interface InputRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface RequestState {
  present: boolean;
  value?: string;
}

export interface InputRequired {
  requests?: Record<string, InputRequest>;
  requestState: RequestState;
}

export function readInputRequired(result: unknown): InputRequired | { error: string } | undefined {
  if (!isRecord(result) || result.resultType !== "input_required") return undefined;
  const state = readState(result);
  if ("error" in state) return state;
  if (!Object.prototype.hasOwnProperty.call(result, "inputRequests")) return { requestState: state };
  if (!isRecord(result.inputRequests)) return { error: "inputRequests must be an object" };
  const requests: Record<string, InputRequest> = {};
  for (const [key, entry] of Object.entries(result.inputRequests)) {
    if (!isRecord(entry) || typeof entry.method !== "string") return { error: `inputRequests.${key} is not a request` };
    requests[key] = { method: entry.method, ...(isRecord(entry.params) ? { params: entry.params } : {}) };
  }
  return { requests, requestState: state };
}

function readState(result: Record<string, unknown>): RequestState | { error: string } {
  if (!Object.prototype.hasOwnProperty.call(result, "requestState")) return { present: false };
  if (typeof result.requestState !== "string") return { error: "requestState must be a string" };
  return { present: true, value: result.requestState };
}

/**
 * Params for the retry. `requestState` is copied through unchanged when the result had one,
 * and left off when it did not. Previous inputResponses on the original params are replaced.
 */
export function buildMrtrRetryParams(
  original: Record<string, unknown> | undefined,
  inputResponses: Record<string, unknown> | undefined,
  requestState: RequestState,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(original ?? {}) };
  delete next.inputResponses;
  delete next.requestState;
  if (inputResponses && Object.keys(inputResponses).length > 0) next.inputResponses = inputResponses;
  if (requestState.present) next.requestState = requestState.value;
  return next;
}

export function isUrlElicitationRequired(error: unknown): error is { code: number; message: string; data: { elicitations: unknown[] } } {
  if (!isRecord(error) || error.code !== URL_ELICITATION_REQUIRED) return false;
  return isRecord(error.data) && Array.isArray(error.data.elicitations);
}
