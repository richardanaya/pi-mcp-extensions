/**
 * Shared elicitation helper.
 *
 * pi-mcp-tasks can call `fulfillElicitation` for a task `input_required` elicitation
 * instead of its local form collector. The result is always accept, decline, or cancel.
 * A missing UI returns cancel on the same turn. Dismissing a dialog is cancel.
 * An explicit Decline choice is decline. URL mode calls `openUrl` only after Open.
 */

import { checkField, formDefaults, parseFormSchema, parseTypedNumber, validateFormContent, type FormField } from "./schema.ts";
import { presentUrl, urlDialogText } from "./url.ts";

export interface ElicitationUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ElicitContext {
  server: string;
  /** Called only after the user chooses Open. Receives the server's URL string, unchanged. */
  openUrl?: (url: string) => Promise<void> | void;
}

export type ElicitResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "accept" }
  | { action: "decline" }
  | { action: "cancel" };

const DECLINE = "Decline request";
const CANCEL = "Cancel request";

/**
 * Answer one `elicitation/create`. Never hangs.
 * `ui` undefined means the request cannot be shown: the action is cancel.
 */
export async function fulfillElicitation(ui: ElicitationUi | undefined, params: unknown, context: ElicitContext): Promise<ElicitResult> {
  if (!ui) return { action: "cancel" };
  if (!isParams(params)) return { action: "cancel" };
  const record = params;
  const mode = typeof record.mode === "string" ? record.mode : "form";
  const message = typeof record.message === "string" ? record.message : "The server is asking for information.";
  if (mode === "url") return fulfillUrl(ui, record, message, context);
  if (mode !== "form") {
    ui.notify(`Elicitation mode ${mode} from ${context.server} is not supported.`, "warning");
    return { action: "cancel" };
  }
  return fulfillForm(ui, record.requestedSchema, message, context);
}

async function fulfillUrl(ui: ElicitationUi, params: Record<string, unknown>, message: string, context: ElicitContext): Promise<ElicitResult> {
  const raw = typeof params.url === "string" ? params.url : "";
  const presentation = presentUrl(raw);
  if (!presentation) {
    ui.notify(`Elicitation from ${context.server} did not include a URL that can be opened.`, "warning");
    return { action: "cancel" };
  }
  const choice = await ui.select(urlDialogText(context.server, message, presentation), ["Open", "Decline", "Cancel"]);
  if (choice === "Decline") return { action: "decline" };
  if (choice !== "Open") return { action: "cancel" };
  try {
    await context.openUrl?.(presentation.url);
  } catch {
    ui.notify(`Could not open ${presentation.host}.`, "error");
    return { action: "cancel" };
  }
  return { action: "accept" };
}

async function fulfillForm(ui: ElicitationUi, schema: unknown, message: string, context: ElicitContext): Promise<ElicitResult> {
  const parsed = parseFormSchema(schema);
  if (!parsed.ok) {
    ui.notify(`Cannot show the form from ${context.server}: ${parsed.error}`, "warning");
    return { action: "cancel" };
  }
  const opened = await ui.select(`Elicitation from ${context.server}\n${message}`, ["Answer", "Decline", "Cancel"]);
  if (opened === "Decline") return { action: "decline" };
  if (opened !== "Answer") return { action: "cancel" };

  let content = formDefaults(schema);
  for (;;) {
    for (const field of parsed.form.fields) {
      const asked = await askField(ui, field, content[field.name], context.server);
      if (asked.action === "decline") return { action: "decline" };
      if (asked.action === "cancel") return { action: "cancel" };
      if (asked.omit) delete content[field.name];
      else content = { ...content, [field.name]: asked.value };
    }
    const validated = validateFormContent(schema, content);
    if (!validated.ok) ui.notify(validated.errors.join("\n"), "error");
    const summary = Object.entries(validated.ok ? validated.content : content).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const review = await ui.select(
      `Review for ${context.server}\n${summary || "(no fields)"}\n\nAccept sends this. Edit changes it. Decline refuses. Cancel dismisses.`,
      validated.ok ? ["Accept", "Edit", "Decline", "Cancel"] : ["Edit", "Decline", "Cancel"],
    );
    if (review === "Decline") return { action: "decline" };
    if (review === "Edit") continue;
    if (review === "Accept" && validated.ok) return { action: "accept", content: validated.content };
    return { action: "cancel" };
  }
}

type Asked = { action: "value"; value: unknown; omit: boolean } | { action: "decline" } | { action: "cancel" };

async function askField(ui: ElicitationUi, field: FormField, current: unknown, server: string): Promise<Asked> {
  const labels = actionLabels((field.choices ?? []).map((choice) => choice.label));
  if (field.kind === "boolean") {
    const choice = await ui.select(fieldTitle(field, server, current), ["Yes", "No", labels.decline, labels.cancel]);
    if (choice === labels.decline) return { action: "decline" };
    if (choice === "Yes") return { action: "value", value: true, omit: false };
    if (choice === "No") return { action: "value", value: false, omit: false };
    return { action: "cancel" };
  }
  if (field.kind === "enum") {
    const choice = await ui.select(fieldTitle(field, server, current), [...(field.choices ?? []).map((item) => item.label), labels.decline, labels.cancel]);
    if (choice === undefined || choice === labels.cancel) return { action: "cancel" };
    if (choice === labels.decline) return { action: "decline" };
    const match = field.choices?.find((item) => item.label === choice);
    if (!match) return { action: "cancel" };
    return { action: "value", value: match.value, omit: false };
  }
  if (field.kind === "multi") return askMulti(ui, field, Array.isArray(current) ? current : [], labels, server);
  return askText(ui, field, current, server);
}

async function askText(ui: ElicitationUi, field: FormField, current: unknown, server: string): Promise<Asked> {
  for (;;) {
    const prefill = current === undefined ? "" : String(current);
    const typed = ui.editor
      ? await ui.editor(fieldTitle(field, server, current), prefill)
      : await ui.input(fieldTitle(field, server, current), prefill ? `Current: ${prefill}` : field.description);
    if (typed === undefined) return { action: "cancel" };
    if (typed.length === 0 && current !== undefined) {
      const kept = checkField(field, current);
      if (kept.ok) return { action: "value", value: kept.value, omit: kept.omit };
    }
    const value = coerceText(field, typed);
    if (value === undefined) {
      ui.notify(`${field.name} is not a valid ${field.kind}.`, "error");
      const again = await ui.select(field.title, ["Try again", DECLINE, CANCEL]);
      if (again === DECLINE) return { action: "decline" };
      if (again === "Try again") continue;
      return { action: "cancel" };
    }
    const checked = checkField(field, value);
    if (!checked.ok) {
      ui.notify(checked.error, "error");
      const again = await ui.select(field.title, ["Try again", DECLINE, CANCEL]);
      if (again === DECLINE) return { action: "decline" };
      if (again === "Try again") continue;
      return { action: "cancel" };
    }
    return { action: "value", value: checked.value, omit: checked.omit };
  }
}

async function askMulti(ui: ElicitationUi, field: FormField, current: unknown[], labels: { decline: string; cancel: string }, server: string): Promise<Asked> {
  const selected = [...current];
  for (;;) {
    const options = [
      ...(field.choices ?? []).map((choice) => `${selected.some((item) => item === choice.value) ? "[x]" : "[ ]"} ${choice.label}`),
      "Done",
      labels.decline,
      labels.cancel,
    ];
    const choice = await ui.select(fieldTitle(field, server, selected), options);
    if (choice === undefined || choice === labels.cancel) return { action: "cancel" };
    if (choice === labels.decline) return { action: "decline" };
    if (choice === "Done") {
      const checked = checkField(field, selected);
      if (!checked.ok) {
        ui.notify(checked.error, "error");
        continue;
      }
      return { action: "value", value: checked.value, omit: false };
    }
    const label = choice.replace(/^\[[ x]\] /, "");
    const match = field.choices?.find((item) => item.label === label);
    if (!match) return { action: "cancel" };
    const index = selected.findIndex((item) => item === match.value);
    if (index === -1) selected.push(match.value);
    else selected.splice(index, 1);
  }
}

function coerceText(field: FormField, raw: string): unknown {
  if (field.kind === "string") return raw;
  return parseTypedNumber(raw, field.kind === "integer");
}

function fieldTitle(field: FormField, server: string, current: unknown): string {
  const lines = [`${server} / ${field.title}`];
  if (field.description) lines.push(field.description);
  if (field.format) lines.push(`Format: ${field.format}`);
  if (field.minimum !== undefined || field.maximum !== undefined) lines.push(`Range: ${field.minimum ?? ""}..${field.maximum ?? ""}`);
  if (field.minLength !== undefined || field.maxLength !== undefined) lines.push(`Length: ${field.minLength ?? 0}..${field.maxLength ?? ""}`);
  if (current !== undefined) lines.push(`Current: ${JSON.stringify(current)}`);
  return lines.join("\n");
}

function actionLabels(labels: string[]): { decline: string; cancel: string } {
  let decline = DECLINE;
  let cancel = CANCEL;
  const used = new Set(labels);
  while (used.has(decline)) decline += " (not a value)";
  used.add(decline);
  while (used.has(cancel)) cancel += " (not a value)";
  return { decline, cancel };
}

function isParams(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { validateFormContent, presentUrl };
