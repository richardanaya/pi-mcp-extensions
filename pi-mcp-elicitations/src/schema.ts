/**
 * Form-mode elicitation schemas are flat objects of primitive fields.
 * This is the subset in the 2026-07-28 elicitation spec: strings (with format,
 * length, and pattern), numbers and integers (with minimum and maximum),
 * booleans, single-select enum and oneOf titles, and multi-select enums.
 */

export interface Choice {
  value: string | number | boolean;
  label: string;
}

export interface FormField {
  name: string;
  kind: "string" | "number" | "integer" | "boolean" | "enum" | "multi";
  title: string;
  description?: string;
  required: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minimum?: number;
  maximum?: number;
  choices?: Choice[];
  minItems?: number;
  maxItems?: number;
}

export interface ParsedForm {
  fields: FormField[];
}

export type SchemaResult = { ok: true; form: ParsedForm } | { ok: false; error: string };

const ROOT_KEYS = new Set(["type", "properties", "required", "title", "description", "$schema", "$id", "additionalProperties"]);
const STRING_KEYS = new Set(["type", "title", "description", "default", "minLength", "maxLength", "pattern", "format", "enum", "oneOf"]);
const NUMBER_KEYS = new Set(["type", "title", "description", "default", "minimum", "maximum"]);
const BOOLEAN_KEYS = new Set(["type", "title", "description", "default"]);
const ARRAY_KEYS = new Set(["type", "title", "description", "default", "minItems", "maxItems", "items"]);

const FORMATS = new Set(["email", "uri", "date", "date-time"]);
const MAX_PATTERN = 256;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFormSchema(schema: unknown): SchemaResult {
  if (!isRecord(schema)) return { ok: false, error: "requestedSchema must be an object" };
  for (const key of Object.keys(schema)) {
    if (!ROOT_KEYS.has(key)) return { ok: false, error: `unsupported schema keyword ${key}` };
  }
  if (schema.type !== undefined && schema.type !== "object") return { ok: false, error: "requestedSchema type must be object" };
  if (schema.properties === undefined) return { ok: true, form: { fields: [] } };
  if (!isRecord(schema.properties)) return { ok: false, error: "properties must be an object" };
  const required = new Set<string>();
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string")) {
      return { ok: false, error: "required must be an array of strings" };
    }
    for (const name of schema.required) required.add(name);
  }
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const parsed = parseField(name, property, required.has(name));
    if ("error" in parsed) return parsed;
    fields.push(parsed);
  }
  return { ok: true, form: { fields } };
}

function parseField(name: string, schema: unknown, required: boolean): FormField | { ok: false; error: string } {
  if (!isRecord(schema)) return { ok: false, error: `${name} schema must be an object` };
  const title = typeof schema.title === "string" && schema.title.length > 0 ? schema.title : name;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  if (schema.type === "array" || (schema.type === undefined && schema.items !== undefined)) {
    return parseMulti(name, schema, required, title, description);
  }
  if (schema.oneOf !== undefined || (schema.enum !== undefined && schema.type !== "number" && schema.type !== "integer" && schema.type !== "boolean")) {
    return parseSingle(name, schema, required, title, description);
  }
  const type = schema.type;
  if (type === "string" || type === undefined) return parseString(name, schema, required, title, description);
  if (type === "number" || type === "integer") return parseNumber(name, schema, required, title, description, type);
  if (type === "boolean") return parseBoolean(name, schema, required, title, description);
  return { ok: false, error: `${name} has unsupported type ${String(type)}` };
}

function parseString(name: string, schema: Record<string, unknown>, required: boolean, title: string, description: string | undefined): FormField | { ok: false; error: string } {
  const extra = unknownKey(schema, STRING_KEYS);
  if (extra) return { ok: false, error: `${name} has unsupported keyword ${extra}` };
  const field: FormField = { name, kind: "string", title, required, ...(description ? { description } : {}) };
  if (schema.minLength !== undefined) {
    if (!isCount(schema.minLength)) return { ok: false, error: `${name} minLength must be a non-negative integer` };
    field.minLength = schema.minLength;
  }
  if (schema.maxLength !== undefined) {
    if (!isCount(schema.maxLength)) return { ok: false, error: `${name} maxLength must be a non-negative integer` };
    field.maxLength = schema.maxLength;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length === 0 || schema.pattern.length > MAX_PATTERN) {
      return { ok: false, error: `${name} pattern must be a string of at most ${MAX_PATTERN} characters` };
    }
    try {
      new RegExp(schema.pattern);
    } catch {
      return { ok: false, error: `${name} pattern is not a valid regular expression` };
    }
    field.pattern = schema.pattern;
  }
  if (schema.format !== undefined) {
    if (typeof schema.format !== "string" || !FORMATS.has(schema.format)) return { ok: false, error: `${name} format is not supported` };
    field.format = schema.format as FormField["format"];
  }
  if (schema.default !== undefined) {
    if (typeof schema.default !== "string") return { ok: false, error: `${name} default must be a string` };
    field.default = schema.default;
  }
  return field;
}

function parseNumber(name: string, schema: Record<string, unknown>, required: boolean, title: string, description: string | undefined, type: "number" | "integer"): FormField | { ok: false; error: string } {
  const extra = unknownKey(schema, NUMBER_KEYS);
  if (extra) return { ok: false, error: `${name} has unsupported keyword ${extra}` };
  const field: FormField = { name, kind: type, title, required, ...(description ? { description } : {}) };
  if (schema.minimum !== undefined) {
    if (typeof schema.minimum !== "number" || !Number.isFinite(schema.minimum)) return { ok: false, error: `${name} minimum must be a number` };
    field.minimum = schema.minimum;
  }
  if (schema.maximum !== undefined) {
    if (typeof schema.maximum !== "number" || !Number.isFinite(schema.maximum)) return { ok: false, error: `${name} maximum must be a number` };
    field.maximum = schema.maximum;
  }
  if (schema.default !== undefined) {
    if (typeof schema.default !== "number" || !Number.isFinite(schema.default)) return { ok: false, error: `${name} default must be a number` };
    if (type === "integer" && !Number.isInteger(schema.default)) return { ok: false, error: `${name} default must be an integer` };
    field.default = schema.default;
  }
  return field;
}

function parseBoolean(name: string, schema: Record<string, unknown>, required: boolean, title: string, description: string | undefined): FormField | { ok: false; error: string } {
  const extra = unknownKey(schema, BOOLEAN_KEYS);
  if (extra) return { ok: false, error: `${name} has unsupported keyword ${extra}` };
  const field: FormField = { name, kind: "boolean", title, required, ...(description ? { description } : {}) };
  if (schema.default !== undefined) {
    if (typeof schema.default !== "boolean") return { ok: false, error: `${name} default must be a boolean` };
    field.default = schema.default;
  }
  return field;
}

function parseSingle(name: string, schema: Record<string, unknown>, required: boolean, title: string, description: string | undefined): FormField | { ok: false; error: string } {
  const extra = unknownKey(schema, new Set(["type", "title", "description", "default", "enum", "oneOf"]));
  if (extra) return { ok: false, error: `${name} has unsupported keyword ${extra}` };
  if (schema.type !== undefined && schema.type !== "string") return { ok: false, error: `${name} enum must be a string` };
  const choices = schema.oneOf !== undefined ? parseOneOf(name, schema.oneOf) : parseEnum(name, schema.enum);
  if ("error" in choices) return choices;
  const field: FormField = { name, kind: "enum", title, required, choices: choices.choices, ...(description ? { description } : {}) };
  if (schema.default !== undefined) {
    if (!choices.choices.some((choice) => choice.value === schema.default)) return { ok: false, error: `${name} default is not one of the choices` };
    field.default = schema.default;
  }
  return field;
}

function parseMulti(name: string, schema: Record<string, unknown>, required: boolean, title: string, description: string | undefined): FormField | { ok: false; error: string } {
  const extra = unknownKey(schema, ARRAY_KEYS);
  if (extra) return { ok: false, error: `${name} has unsupported keyword ${extra}` };
  if (!isRecord(schema.items)) return { ok: false, error: `${name} items must be an enum or anyOf` };
  const choices = schema.items.anyOf !== undefined ? parseOneOf(name, schema.items.anyOf) : parseEnum(name, schema.items.enum);
  if ("error" in choices) return choices;
  const itemKeys = new Set(Object.keys(schema.items));
  const allowed = schema.items.anyOf !== undefined ? new Set(["anyOf"]) : new Set(["type", "enum"]);
  for (const key of itemKeys) {
    if (!allowed.has(key)) return { ok: false, error: `${name} items keyword ${key} is not supported` };
  }
  if (schema.items.anyOf === undefined && schema.items.type !== undefined && schema.items.type !== "string") {
    return { ok: false, error: `${name} items type must be string` };
  }
  const field: FormField = { name, kind: "multi", title, required, choices: choices.choices, ...(description ? { description } : {}) };
  if (schema.minItems !== undefined) {
    if (!isCount(schema.minItems)) return { ok: false, error: `${name} minItems must be a non-negative integer` };
    field.minItems = schema.minItems;
  }
  if (schema.maxItems !== undefined) {
    if (!isCount(schema.maxItems)) return { ok: false, error: `${name} maxItems must be a non-negative integer` };
    field.maxItems = schema.maxItems;
  }
  if (schema.default !== undefined) {
    if (!Array.isArray(schema.default) || schema.default.some((item) => !choices.choices.some((choice) => choice.value === item))) {
      return { ok: false, error: `${name} default must list allowed choices` };
    }
    field.default = [...schema.default];
  }
  return field;
}

function parseEnum(name: string, value: unknown): { choices: Choice[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    return { ok: false, error: `${name} enum must be a non-empty array of strings` };
  }
  return { choices: value.map((item) => ({ value: item, label: item })) };
}

function parseOneOf(name: string, value: unknown): { choices: Choice[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: `${name} oneOf must list choices` };
  const choices: Choice[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !("const" in entry)) return { ok: false, error: `${name} choice must have const` };
    const consts = entry.const;
    if (typeof consts !== "string" && typeof consts !== "number" && typeof consts !== "boolean") {
      return { ok: false, error: `${name} const must be a string, number, or boolean` };
    }
    const label = typeof entry.title === "string" && entry.title.length > 0 ? entry.title : String(consts);
    choices.push({ value: consts, label });
  }
  return { choices };
}

function unknownKey(schema: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(schema).find((key) => !allowed.has(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface ValidationOk {
  ok: true;
  content: Record<string, unknown>;
}

export interface ValidationFail {
  ok: false;
  errors: string[];
}

/** Check a submitted object against the schema. Unknown keys are errors. Invalid schemas are errors. */
export function validateFormContent(schema: unknown, content: unknown): ValidationOk | ValidationFail {
  const parsed = parseFormSchema(schema);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  if (!isRecord(content)) return { ok: false, errors: ["content must be an object"] };
  const errors: string[] = [];
  const known = new Set(parsed.form.fields.map((field) => field.name));
  for (const key of Object.keys(content)) {
    if (!known.has(key)) errors.push(`${key} is not part of this form`);
  }
  const next: Record<string, unknown> = {};
  for (const field of parsed.form.fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.name) || content[field.name] === undefined) {
      if (field.required) errors.push(`${field.name} is required`);
      continue;
    }
    const checked = checkField(field, content[field.name]);
    if (checked.ok) {
      if (checked.omit) continue;
      next[field.name] = checked.value;
    } else {
      errors.push(checked.error);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, content: next };
}

export function formDefaults(schema: unknown): Record<string, unknown> {
  const parsed = parseFormSchema(schema);
  if (!parsed.ok) return {};
  const content: Record<string, unknown> = {};
  for (const field of parsed.form.fields) {
    if (field.default === undefined) continue;
    const checked = checkField(field, field.default);
    if (checked.ok && !checked.omit) content[field.name] = checked.value;
  }
  return content;
}

export function checkField(field: FormField, value: unknown): { ok: true; value: unknown; omit: boolean } | { ok: false; error: string } {
  if (field.kind === "string") return checkString(field, value);
  if (field.kind === "number" || field.kind === "integer") return checkNumber(field, value);
  if (field.kind === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `${field.name} must be a boolean` };
    return { ok: true, value, omit: false };
  }
  if (field.kind === "enum") {
    if (!field.choices?.some((choice) => choice.value === value)) return { ok: false, error: `${field.name} must be one of the allowed values` };
    return { ok: true, value, omit: false };
  }
  if (!Array.isArray(value)) return { ok: false, error: `${field.name} must be a list` };
  for (const item of value) {
    if (!field.choices?.some((choice) => choice.value === item)) return { ok: false, error: `${field.name} must be one of the allowed values` };
  }
  if (field.minItems !== undefined && value.length < field.minItems) return { ok: false, error: `${field.name} must have at least ${field.minItems} items` };
  if (field.maxItems !== undefined && value.length > field.maxItems) return { ok: false, error: `${field.name} must have at most ${field.maxItems} items` };
  return { ok: true, value: [...value], omit: false };
}

function checkString(field: FormField, value: unknown): { ok: true; value: unknown; omit: boolean } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: `${field.name} must be a string` };
  if (value.length === 0) {
    if (field.required) return { ok: false, error: `${field.name} is required` };
    return { ok: true, value: "", omit: true };
  }
  const length = [...value].length;
  if (field.minLength !== undefined && length < field.minLength) return { ok: false, error: `${field.name} must be at least ${field.minLength} characters` };
  if (field.maxLength !== undefined && length > field.maxLength) return { ok: false, error: `${field.name} must be at most ${field.maxLength} characters` };
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) return { ok: false, error: `${field.name} must match the requested pattern` };
  if (field.format !== undefined && !matchesFormat(field.format, value)) return { ok: false, error: formatError(field) };
  return { ok: true, value, omit: false };
}

function checkNumber(field: FormField, value: unknown): { ok: true; value: unknown; omit: boolean } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `${field.name} must be a number` };
  if (field.kind === "integer" && !Number.isInteger(value)) return { ok: false, error: `${field.name} must be a whole number` };
  if (field.minimum !== undefined && value < field.minimum) return { ok: false, error: `${field.name} must be >= ${field.minimum}` };
  if (field.maximum !== undefined && value > field.maximum) return { ok: false, error: `${field.name} must be <= ${field.maximum}` };
  return { ok: true, value, omit: false };
}

function formatError(field: FormField): string {
  if (field.format === "email") return `${field.name} must be an email address`;
  if (field.format === "uri") return `${field.name} must be a URI`;
  if (field.format === "date") return `${field.name} must be a date (YYYY-MM-DD)`;
  return `${field.name} must be a date-time`;
}

export function matchesFormat(format: NonNullable<FormField["format"]>, value: string): boolean {
  if (format === "email") return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value);
  if (format === "uri") {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  }
  if (format === "date") return isCalendarDate(value);
  return isDateTime(value);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !isCalendarDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  return hour <= 23 && minute <= 59 && second <= 60;
}

/** Parse a number a person typed. Rejects blank and non-JSON numbers. */
export function parseTypedNumber(raw: string, integer: boolean): number | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (integer && !Number.isInteger(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
