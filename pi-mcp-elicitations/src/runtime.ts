/**
 * Turns elicitation requests into accept, decline, or cancel.
 *
 * UI mode shows a dialog. Tool mode stores the request until `mcp_elicitations_respond`.
 * With neither, the answer is cancel on this turn. Nothing here waits for a person who
 * has no way to answer.
 */

import type { ApprovalMode } from "./approval-mode.ts";
import { fulfillElicitation, type ElicitResult, type ElicitationUi } from "./elicit.ts";
import {
  buildMrtrRetryParams,
  isUrlElicitationRequired,
  MAX_MRTR_ROUNDS,
  MRTR_METHODS,
  readInputRequired,
  type InputRequest,
  type InputRequired,
  type RequestState,
} from "./mrtr.ts";
import type { protocolOffer } from "./approval-mode.ts";
import { isRecord, validateFormContent } from "./schema.ts";
import { presentUrl } from "./url.ts";

type Sender = (method: string, params?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
type Offer = ReturnType<typeof protocolOffer>;

export interface ElicitationRuntimeOptions {
  mode?: () => ApprovalMode;
  ui?: () => ElicitationUi | undefined;
  openUrl?: (url: string) => Promise<void> | void;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  deliver?: (text: string) => void;
  setStatus?: (text: string | undefined) => void;
  protocol?: () => Offer;
}

interface PendingLegacy {
  kind: "legacy";
  id: string;
  server: string;
  params: Record<string, unknown>;
  resolve: (result: ElicitResult) => void;
}

interface PendingMrtr {
  kind: "mrtr";
  id: string;
  server: string;
  method: string;
  params: Record<string, unknown>;
  requests: Record<string, InputRequest>;
  requestState: RequestState;
  round: number;
  send: Sender;
  options?: unknown;
}

interface PendingUrl {
  kind: "url-retry";
  id: string;
  server: string;
  method: string;
  params: Record<string, unknown>;
  elicitationIds: string[];
  send: Sender;
  options?: unknown;
}

interface PendingConsent {
  kind: "url-consent";
  id: string;
  server: string;
  method: string;
  params: Record<string, unknown>;
  elicitations: Record<string, unknown>[];
  send: Sender;
  options?: unknown;
}

type Pending = PendingLegacy | PendingMrtr | PendingUrl | PendingConsent;

export class ElicitationRuntime {
  private readonly options: ElicitationRuntimeOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly urls = new Map<string, "open" | "done">();
  private next = 0;

  constructor(options: ElicitationRuntimeOptions = {}) {
    this.options = options;
  }

  offer(): Offer {
    return this.options.protocol?.();
  }

  /** Server-initiated `elicitation/create` from a 2025-11-25 server. */
  legacy(server: string, params: unknown, signal?: AbortSignal): Promise<ElicitResult> {
    return this.answer(server, params, signal);
  }

  /**
   * A client request returned `input_required`, or the caller is replaying one.
   * `send` performs the retry. It must be a new JSON-RPC request.
   */
  handleInputRequired(server: string, method: string, params: Record<string, unknown> | undefined, result: unknown, send: Sender, options?: unknown): Promise<unknown> {
    if (!MRTR_METHODS.has(method)) return Promise.resolve(result);
    const required = readInputRequired(result);
    if (required === undefined) return Promise.resolve(result);
    return this.follow(server, method, params ?? {}, required, send, 1, options);
  }

  /** Wrap one client request. MRTR retries and the legacy URL error stay inside this call when a UI can answer. */
  async around(server: string, method: string, params: Record<string, unknown> | undefined, options: unknown, send: Sender): Promise<unknown> {
    try {
      const result = await send(method, params, options);
      return this.handleInputRequired(server, method, params, result, send, options);
    } catch (error) {
      if (!MRTR_METHODS.has(method) || !isUrlElicitationRequired(error)) throw error;
      return this.urlRequired(server, method, params ?? {}, error.data.elicitations, send, options);
    }
  }

  listText(): string {
    if (this.pending.size === 0) return "No elicitations are waiting.";
    return [...this.pending.values()].map((item) => this.describe(item)).join("\n");
  }

  /**
   * Answer a pending elicitation. `inputResponses` is one elicitation result for a legacy
   * request, or a map keyed like `inputRequests` for a multi round-trip round.
   * `open` is required before a URL is launched or a URL accept is sent.
   */
  async respond(id: string, inputResponses: string, open = false): Promise<string> {
    const pending = this.pending.get(id);
    if (!pending) return `Error: No elicitation ${id} is waiting.`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputResponses) as unknown;
    } catch {
      return "Error: inputResponses must be JSON.";
    }
    if (pending.kind === "legacy") return this.respondLegacy(pending, parsed, open);
    if (pending.kind === "url-consent") return this.respondConsent(pending, parsed, open);
    if (pending.kind === "url-retry") return "That request is waiting for the URL step to finish. Call mcp_elicitations_retry.";
    return this.respondMrtr(pending, parsed, open);
  }

  /** Run a request that was parked after URL consent. Also used when the completion notification never arrives. */
  async retry(id?: string): Promise<string> {
    const items = [...this.pending.values()].filter((item): item is PendingUrl => item.kind === "url-retry" && (id === undefined || item.id === id));
    if (items.length === 0) return id ? `No URL retry ${id} is waiting.` : "No URL retry is waiting.";
    const lines: string[] = [];
    for (const item of items) lines.push(await this.replay(item));
    return lines.join("\n");
  }

  /** `notifications/elicitation/complete`. Unknown and already-completed ids are ignored. */
  completeNotification(server: string, params: unknown): void {
    if (!isRecord(params) || typeof params.elicitationId !== "string" || params.elicitationId.length === 0) return;
    const key = urlKey(server, params.elicitationId);
    if (this.urls.get(key) !== "open") return;
    this.urls.set(key, "done");
    this.options.notify?.(`URL elicitation ${params.elicitationId} on ${server} completed.`, "info");
    for (const item of [...this.pending.values()]) {
      if (item.kind === "url-retry" && item.elicitationIds.includes(params.elicitationId)) void this.replay(item);
    }
  }

  close(): void {
    for (const item of [...this.pending.values()]) {
      if (item.kind === "legacy") item.resolve({ action: "cancel" });
    }
    this.pending.clear();
    this.refreshStatus();
  }

  private async answer(server: string, params: unknown, signal?: AbortSignal): Promise<ElicitResult> {
    if (signal?.aborted) return { action: "cancel" };
    const mode = this.mode();
    const ui = mode === "tool" ? undefined : this.ui();
    if (ui) {
      const result = await fulfillElicitation(ui, params, { server, openUrl: (url) => this.options.openUrl?.(url) });
      this.noteUrl(server, params, result);
      return result;
    }
    if (mode === "tool") return this.waitForTool(server, isRecord(params) ? params : {}, signal);
    return { action: "cancel" };
  }

  private waitForTool(server: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ElicitResult> {
    const id = this.allocate();
    return new Promise((resolve) => {
      const finish = (result: ElicitResult) => {
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.refreshStatus();
        resolve(result);
      };
      const onAbort = () => finish({ action: "cancel" });
      const pending: PendingLegacy = { kind: "legacy", id, server, params, resolve: finish };
      this.pending.set(id, pending);
      this.refreshStatus();
      this.options.notify?.(this.describe(pending), "info");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async follow(
    server: string,
    method: string,
    params: Record<string, unknown>,
    required: InputRequired | { error: string },
    send: Sender,
    round: number,
    options: unknown,
    cancelling = false,
  ): Promise<unknown> {
    if ("error" in required) return this.explain(method, required.error);
    if (round > MAX_MRTR_ROUNDS) return this.explain(method, "Stopped after too many input_required rounds.");
    if (!required.requests) {
      if (round > 1) return this.explain(method, "The server is still waiting and did not ask a question. Call mcp_elicitations_retry if you opened a URL.");
      return this.step(server, method, buildMrtrRetryParams(params, undefined, required.requestState), send, round + 1, options);
    }
    const foreign = Object.values(required.requests).find((request) => request.method !== "elicitation/create");
    if (foreign) return this.explain(method, `Cannot fulfill ${foreign.method}. The request was not retried.`);
    const mode = this.mode();
    const ui = mode === "tool" ? undefined : this.ui();
    if (!ui && mode !== "tool") {
      const responses: Record<string, ElicitResult> = {};
      for (const key of Object.keys(required.requests)) responses[key] = { action: "cancel" };
      return this.step(server, method, buildMrtrRetryParams(params, responses, required.requestState), send, round + 1, options, true);
    }
    if (!ui) return this.stashMrtr(server, method, params, required, send, round, options);
    const responses: Record<string, ElicitResult> = {};
    let stop = false;
    for (const [key, request] of Object.entries(required.requests)) {
      if (stop) {
        responses[key] = { action: "cancel" };
        continue;
      }
      const result = await fulfillElicitation(ui, request.params ?? {}, { server, openUrl: (url) => this.options.openUrl?.(url) });
      this.noteUrl(server, request.params, result);
      responses[key] = result;
      if (result.action === "cancel") stop = true;
    }
    return this.step(server, method, buildMrtrRetryParams(params, responses, required.requestState), send, round + 1, options, cancelling);
  }

  private async step(server: string, method: string, params: Record<string, unknown>, send: Sender, round: number, options: unknown, cancelling = false): Promise<unknown> {
    try {
      const result = await send(method, params, options);
      const required = readInputRequired(result);
      if (required === undefined) return result;
      if (cancelling) return this.explain(method, "The server still needs input, and there is no dialog to collect it. The elicitation was cancelled.");
      return this.follow(server, method, params, required, send, round, options);
    } catch (error) {
      if (!isUrlElicitationRequired(error)) throw error;
      return this.urlRequired(server, method, params, error.data.elicitations, send, options);
    }
  }

  private stashMrtr(server: string, method: string, params: Record<string, unknown>, required: InputRequired, send: Sender, round: number, options: unknown): unknown {
    const id = this.allocate();
    const pending: PendingMrtr = {
      kind: "mrtr",
      id,
      server,
      method,
      params,
      requests: required.requests ?? {},
      requestState: required.requestState,
      round,
      send,
      options,
    };
    this.pending.set(id, pending);
    this.refreshStatus();
    const text = this.describe(pending);
    this.options.notify?.(text, "info");
    return this.explain(method, text, false);
  }

  private async urlRequired(server: string, method: string, params: Record<string, unknown>, elicitations: unknown[], send: Sender, options: unknown): Promise<unknown> {
    const items = elicitations.filter(isRecord);
    const mode = this.mode();
    const ui = mode === "tool" ? undefined : this.ui();
    if (!ui && mode !== "tool") return this.explain(method, `URL elicitation from ${server} was cancelled. The request was not retried.`, true);
    if (!ui) {
      const id = this.allocate();
      const pending: PendingConsent = { kind: "url-consent", id, server, method, params, elicitations: items, send, options };
      this.pending.set(id, pending);
      this.refreshStatus();
      return this.explain(method, this.describe(pending), false);
    }
    const ids: string[] = [];
    for (const item of items) {
      const result = await fulfillElicitation(ui, item, { server, openUrl: (url) => this.options.openUrl?.(url) });
      if (result.action !== "accept") return this.explain(method, `URL elicitation was ${result.action}. The request was not retried.`, true);
      const elicitationId = typeof item.elicitationId === "string" ? item.elicitationId : undefined;
      if (elicitationId) {
        this.urls.set(urlKey(server, elicitationId), "open");
        ids.push(elicitationId);
      }
    }
    const id = this.allocate();
    const pending: PendingUrl = { kind: "url-retry", id, server, method, params, elicitationIds: ids, send, options };
    this.pending.set(id, pending);
    this.refreshStatus();
    return this.explain(method, `${this.describe(pending)} Call mcp_elicitations_retry if the server does not continue.`, false);
  }

  private async respondLegacy(pending: PendingLegacy, parsed: unknown, open: boolean): Promise<string> {
    const checked = this.checkResult(pending.params, parsed, open);
    if (typeof checked === "string") return checked;
    const opened = await this.openAccepted(pending.server, pending.params, checked, open);
    if (opened) return opened;
    this.noteUrl(pending.server, pending.params, checked);
    pending.resolve(checked);
    return `Sent ${checked.action} for ${pending.id}.`;
  }

  private async respondMrtr(pending: PendingMrtr, parsed: unknown, open: boolean): Promise<string> {
    if (!isRecord(parsed)) return "Error: inputResponses must be an object keyed by the inputRequests keys.";
    const responses: Record<string, ElicitResult> = {};
    for (const [key, request] of Object.entries(pending.requests)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) return `Error: Missing inputResponses.${key}.`;
      const checked = this.checkResult(request.params ?? {}, parsed[key], open);
      if (typeof checked === "string") return `${key}: ${checked}`;
      responses[key] = checked;
    }
    for (const key of Object.keys(parsed)) {
      if (!pending.requests[key]) return `Error: ${key} is not an input request.`;
    }
    for (const [key, request] of Object.entries(pending.requests)) {
      const opened = await this.openAccepted(pending.server, request.params ?? {}, responses[key]!, open);
      if (opened) return `${key}: ${opened}`;
      this.noteUrl(pending.server, request.params, responses[key]!);
    }
    this.pending.delete(pending.id);
    const next = buildMrtrRetryParams(pending.params, responses, pending.requestState);
    try {
      const result = await this.step(pending.server, pending.method, next, pending.send, pending.round + 1, pending.options);
      this.refreshStatus();
      if (isRecord(result) && Array.isArray(result.content)) return textOf(result);
      return textOf(result);
    } catch (error) {
      this.refreshStatus();
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async respondConsent(pending: PendingConsent, parsed: unknown, open: boolean): Promise<string> {
    const results = consentResults(pending.elicitations, parsed);
    if (typeof results === "string") return results;
    const ids: string[] = [];
    for (let index = 0; index < pending.elicitations.length; index += 1) {
      const item = pending.elicitations[index]!;
      const result = results[index]!;
      if (result.action !== "accept") {
        this.pending.delete(pending.id);
        this.refreshStatus();
        return `URL elicitation was ${result.action}. The request was not retried.`;
      }
      const opened = await this.openAccepted(pending.server, item, result, open);
      if (opened) return opened;
      const elicitationId = typeof item.elicitationId === "string" ? item.elicitationId : undefined;
      if (elicitationId) {
        this.urls.set(urlKey(pending.server, elicitationId), "open");
        ids.push(elicitationId);
      }
    }
    this.pending.delete(pending.id);
    const parked: PendingUrl = {
      kind: "url-retry",
      id: pending.id,
      server: pending.server,
      method: pending.method,
      params: pending.params,
      elicitationIds: ids,
      send: pending.send,
      options: pending.options,
    };
    this.pending.set(parked.id, parked);
    this.refreshStatus();
    return `${this.describe(parked)} Call mcp_elicitations_retry if the server does not continue.`;
  }

  private checkResult(params: Record<string, unknown>, value: unknown, open: boolean): ElicitResult | string {
    const result = asResult(value);
    if (!result) return "Error: Each response needs action accept, decline, or cancel.";
    const mode = typeof params.mode === "string" ? params.mode : "form";
    if (result.action !== "accept") return { action: result.action };
    if (mode === "url") {
      if (!open) {
        const presentation = presentUrl(typeof params.url === "string" ? params.url : "");
        const shown = presentation ? presentation.url : "the server URL";
        return `Error: Pass open true to consent to open ${shown}. Do not pass it unless the user agreed.`;
      }
      return { action: "accept" };
    }
    if (mode !== "form") return `Error: Mode ${mode} is not supported.`;
    const content = "content" in result ? result.content : {};
    const validated = validateFormContent(params.requestedSchema, content);
    if (!validated.ok) return `Error: ${validated.errors.join("\n")}`;
    return { action: "accept", content: validated.content };
  }

  private async openAccepted(server: string, params: Record<string, unknown>, result: ElicitResult, open: boolean): Promise<string | undefined> {
    if (result.action !== "accept" || !open) return undefined;
    const mode = typeof params.mode === "string" ? params.mode : "form";
    if (mode !== "url" || typeof params.url !== "string") return undefined;
    const presentation = presentUrl(params.url);
    if (!presentation) return `Error: Elicitation from ${server} did not include a URL that can be opened.`;
    if (!this.options.openUrl) return "Error: This client has no browser opener.";
    try {
      await this.options.openUrl(presentation.url);
    } catch {
      return `Error: Could not open ${presentation.host}.`;
    }
    return undefined;
  }

  private async replay(pending: PendingUrl): Promise<string> {
    this.pending.delete(pending.id);
    this.refreshStatus();
    try {
      const result = await this.step(pending.server, pending.method, pending.params, pending.send, 1, pending.options);
      const text = textOf(result);
      this.options.deliver?.(text);
      return text;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.options.deliver?.(text);
      return text;
    }
  }

  private noteUrl(server: string, params: unknown, result: ElicitResult): void {
    if (result.action !== "accept" || !isRecord(params) || params.mode !== "url") return;
    if (typeof params.elicitationId !== "string" || params.elicitationId.length === 0) return;
    const key = urlKey(server, params.elicitationId);
    if (this.urls.get(key) === "done") return;
    this.urls.set(key, "open");
  }

  private explain(method: string, text: string, isError = true): unknown {
    if (method === "tools/call") return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    throw new Error(text);
  }

  private describe(pending: Pending): string {
    if (pending.kind === "legacy") {
      return `${pending.id}\t${pending.server}\tlegacy\t${summarize(pending.params)}`;
    }
    if (pending.kind === "mrtr") {
      const questions = Object.entries(pending.requests).map(([key, request]) => `${key}: ${summarize(request.params ?? {})}`).join("; ");
      return `${pending.id}\t${pending.server}\tmrtr\t${pending.method}\t${questions}\tCall mcp_elicitations_respond.`;
    }
    if (pending.kind === "url-consent") {
      const urls = pending.elicitations.map((item) => (typeof item.url === "string" ? item.url : "")).filter((url) => url.length > 0).join(" ");
      return `${pending.id}\t${pending.server}\turl\t${urls}\tCall mcp_elicitations_respond with open true only if the user agreed to open each URL.`;
    }
    return `${pending.id}\t${pending.server}\turl-retry\t${pending.method}\telicitation ${pending.elicitationIds.join(", ") || "(no id)"}`;
  }

  private allocate(): string {
    this.next += 1;
    return `e${this.next}`;
  }

  private mode(): ApprovalMode {
    return this.options.mode?.() ?? "ui";
  }

  private ui(): ElicitationUi | undefined {
    return this.options.ui?.();
  }

  private refreshStatus(): void {
    this.options.setStatus?.(this.pending.size === 0 ? undefined : `elicitations ${this.pending.size}`);
  }
}

function urlKey(server: string, elicitationId: string): string {
  return `${server}\0${elicitationId}`;
}

function summarize(params: Record<string, unknown>): string {
  const mode = typeof params.mode === "string" ? params.mode : "form";
  const message = typeof params.message === "string" ? params.message : "";
  const url = typeof params.url === "string" ? params.url : "";
  return [mode, message, url].filter((part) => part.length > 0).join(" ");
}

function asResult(value: unknown): ElicitResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.action === "decline" || value.action === "cancel") return { action: value.action };
  if (value.action !== "accept") return undefined;
  if (value.content === undefined) return { action: "accept" };
  if (!isRecord(value.content)) return undefined;
  return { action: "accept", content: value.content };
}

function consentResults(elicitations: Record<string, unknown>[], parsed: unknown): ElicitResult[] | string {
    if (elicitations.length === 1 && isRecord(parsed) && typeof parsed.action === "string") {
    const result = asResult(parsed);
    return result ? [result] : "Error: inputResponses must use accept, decline, or cancel.";
  }
  if (!isRecord(parsed)) return "Error: inputResponses must be an object keyed by elicitationId.";
  const results: ElicitResult[] = [];
  for (const item of elicitations) {
    const id = typeof item.elicitationId === "string" ? item.elicitationId : "";
    const result = asResult(parsed[id]);
    if (!result) return `Error: Missing a response for ${id || "the URL elicitation"}.`;
    results.push(result);
  }
  return results;
}

export function textOf(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter((item) => item.length > 0)
      .join("\n");
    if (text.length > 0) return text;
  }
  return JSON.stringify(result);
}
