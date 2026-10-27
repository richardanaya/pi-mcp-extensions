import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { approvalMode, protocolOffer } from "../src/approval-mode.ts";
import { fulfillElicitation } from "../src/elicit.ts";
import { buildMrtrRetryParams, readInputRequired } from "../src/mrtr.ts";
import { EXTERNAL_OPEN_COMMAND, openExternal, type SpawnExternal } from "../src/open.ts";
import { withElicitationCapability, withElicitationMeta } from "../src/protocol.ts";
import { formDefaults, validateFormContent } from "../src/schema.ts";
import { presentUrl } from "../src/url.ts";
import { ScriptedUi } from "./support.ts";

const contact = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 3, maxLength: 20, default: "octocat" },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 18, maximum: 120 },
    site: { type: "string", format: "uri" },
    day: { type: "string", format: "date" },
    when: { type: "string", format: "date-time" },
    code: { type: "string", pattern: "^[A-Z]+$" },
    color: { type: "string", enum: ["Red", "Green", "Blue"], default: "Red" },
    paint: {
      type: "string",
      oneOf: [
        { const: "#FF0000", title: "Red" },
        { const: "#00FF00", title: "Green" },
      ],
      default: "#FF0000",
    },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: { type: "string", enum: ["Red", "Green", "Blue"] },
      default: ["Red"],
    },
    shades: {
      type: "array",
      items: {
        anyOf: [
          { const: "#FF0000", title: "Red" },
          { const: "#00FF00", title: "Green" },
        ],
      },
    },
    score: { type: "number", minimum: 0, maximum: 1 },
    ok: { type: "boolean", default: false },
  },
  required: ["name", "email"],
};

describe("form schema", () => {
  it("C-MUST-16 validates required fields, formats, bounds, enums, and oneOf", () => {
    const good = validateFormContent(contact, {
      name: "Monalisa",
      email: "octocat@github.com",
      age: 30,
      site: "https://github.com/octocat",
      day: "2020-02-29",
      when: "2020-01-02T03:04:05Z",
      code: "ABC",
      color: "Green",
      paint: "#00FF00",
      tags: ["Red", "Blue"],
      shades: ["#FF0000"],
      score: 0.5,
      ok: true,
    });
    assert.equal(good.ok, true);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ email: "octocat@github.com" }, "name is required"],
      [{ name: "Mo", email: "octocat@github.com" }, "name must be at least 3 characters"],
      [{ name: "M".repeat(21), email: "octocat@github.com" }, "name must be at most 20 characters"],
      [{ name: "Monalisa", email: "not-an-email" }, "email must be an email address"],
      [{ name: "Monalisa", email: "a@b.co", age: 1.5 }, "age must be a whole number"],
      [{ name: "Monalisa", email: "a@b.co", age: 17 }, "age must be >= 18"],
      [{ name: "Monalisa", email: "a@b.co", age: 121 }, "age must be <= 120"],
      [{ name: "Monalisa", email: "a@b.co", site: "not a uri" }, "site must be a URI"],
      [{ name: "Monalisa", email: "a@b.co", day: "2020-02-31" }, "day must be a date (YYYY-MM-DD)"],
      [{ name: "Monalisa", email: "a@b.co", when: "2020-01-02 03:04:05" }, "when must be a date-time"],
      [{ name: "Monalisa", email: "a@b.co", code: "ab" }, "code must match the requested pattern"],
      [{ name: "Monalisa", email: "a@b.co", color: "Yellow" }, "color must be one of the allowed values"],
      [{ name: "Monalisa", email: "a@b.co", paint: "Red" }, "paint must be one of the allowed values"],
      [{ name: "Monalisa", email: "a@b.co", tags: [] }, "tags must have at least 1 items"],
      [{ name: "Monalisa", email: "a@b.co", tags: ["Red", "Green", "Blue"] }, "tags must have at most 2 items"],
      [{ name: "Monalisa", email: "a@b.co", score: 1.5 }, "score must be <= 1"],
      [{ name: "Monalisa", email: "a@b.co", extra: true }, "extra is not part of this form"],
    ];
    for (const [content, error] of cases) {
      const result = validateFormContent(contact, content);
      assert.equal(result.ok, false, error);
      if (!result.ok) assert.ok(result.errors.includes(error), `${error} in ${result.errors.join("; ")}`);
    }
  });

  it("C-SHOULD-01 reads defaults that match the schema", () => {
    assert.equal(formDefaults(contact).name, "octocat");
    assert.equal(formDefaults(contact).color, "Red");
    assert.equal(formDefaults(contact).paint, "#FF0000");
    assert.deepEqual(formDefaults(contact).tags, ["Red"]);
    assert.equal(formDefaults(contact).ok, false);
  });

  it("rejects a schema outside the flat elicitation subset", () => {
    const nested = validateFormContent({ type: "object", properties: { person: { type: "object" } } }, {});
    assert.equal(nested.ok, false);
    const exclusive = validateFormContent({ type: "object", properties: { age: { type: "integer", exclusiveMinimum: 0 } } }, { age: 1 });
    assert.equal(exclusive.ok, false);
  });
});

describe("dialogs", () => {
  it("C-MUST-02 C-MUST-03 C-MUST-04 C-MUST-06 reviews a form and treats a missing mode as form", async () => {
    const ui = new ScriptedUi(["Answer", "wrong", "Edit", "octocat", "Accept"]);
    const result = await fulfillElicitation(ui, {
      message: "Please provide your GitHub username",
      requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 3 } }, required: ["name"] },
    }, { server: "billing" });
    assert.deepEqual(result, { action: "accept", content: { name: "octocat" } });
    assert.match(ui.selects[0]?.title ?? "", /billing/);
    assert.match(ui.selects[0]?.title ?? "", /GitHub username/);
    assert.ok(ui.selects.at(-1)?.options.includes("Accept"));
    assert.ok(ui.selects.at(-1)?.options.includes("Decline"));
    assert.ok(ui.selects.at(-1)?.options.includes("Cancel"));
    assert.equal(ui.editors.length, 2);
  });

  it("C-MUST-03 sends decline and cancel without content, including when the dialog is dismissed", async () => {
    const decline = await fulfillElicitation(new ScriptedUi(["Decline"]), {
      mode: "form",
      message: "Name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }, { server: "billing" });
    assert.deepEqual(decline, { action: "decline" });
    const dismissed = await fulfillElicitation(new ScriptedUi([undefined]), {
      mode: "form",
      message: "Name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    }, { server: "billing" });
    assert.deepEqual(dismissed, { action: "cancel" });
    const reviewCancel = await fulfillElicitation(new ScriptedUi(["Answer", "octocat", undefined]), {
      mode: "form",
      message: "Name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }, { server: "billing" });
    assert.deepEqual(reviewCancel, { action: "cancel" });
    assert.equal("content" in reviewCancel, false);
  });

  it("C-MUST-07 C-MUST-05 URL accept has no content and is not opened before consent", async () => {
    const opened: string[] = [];
    const ui = new ScriptedUi(["Open"]);
    const result = await fulfillElicitation(ui, {
      mode: "url",
      url: "https://mcp.example.com/ui/set_api_key",
      message: "Please provide your API key to continue.",
    }, {
      server: "billing",
      openUrl: (url) => {
        opened.push(url);
      },
    });
    assert.deepEqual(result, { action: "accept" });
    assert.equal("content" in result, false);
    assert.deepEqual(opened, ["https://mcp.example.com/ui/set_api_key"]);
    assert.match(ui.selects[0]?.title ?? "", /Host: mcp\.example\.com/);
    assert.match(ui.selects[0]?.title ?? "", /https:\/\/mcp\.example\.com\/ui\/set_api_key/);
    const declined = new ScriptedUi(["Decline"]);
    const declinedOpens: string[] = [];
    const decline = await fulfillElicitation(declined, {
      mode: "url",
      url: "https://mcp.example.com/ui/set_api_key",
      message: "Please provide your API key to continue.",
    }, { server: "billing", openUrl: (url) => { declinedOpens.push(url); } });
    assert.deepEqual(decline, { action: "decline" });
    assert.deepEqual(declinedOpens, []);
    const dismissedOpens: string[] = [];
    const dismiss = await fulfillElicitation(new ScriptedUi([undefined]), {
      mode: "url",
      url: "https://mcp.example.com/ui/set_api_key",
      message: "Go",
    }, { server: "billing", openUrl: (url) => { dismissedOpens.push(url); } });
    assert.deepEqual(dismiss, { action: "cancel" });
    assert.deepEqual(dismissedOpens, []);
  });

  it("C-SHOULD-02 warns on Punycode and non-https and highlights the host", () => {
    const puny = presentUrl("https://www.xn--80ak6aa92e.com/login");
    assert.ok(puny);
    assert.equal(puny?.host, "www.xn--80ak6aa92e.com");
    assert.match(puny?.warnings.join(" ") ?? "", /Punycode/);
    const http = presentUrl("http://mcp.example.com/path");
    assert.match(http?.warnings.join(" ") ?? "", /not https/);
    assert.equal(presentUrl("http://localhost:8080/dev")?.warnings.length, 0);
    assert.equal(presentUrl("javascript:alert(1)"), undefined);
  });

  it("C-SHOULD-01 prefills the editor with the default", async () => {
    const ui = new ScriptedUi(["Answer", "octocat", "Accept"]);
    const result = await fulfillElicitation(ui, {
      mode: "form",
      message: "Username",
      requestedSchema: { type: "object", properties: { name: { type: "string", default: "octocat" } }, required: ["name"] },
    }, { server: "billing" });
    assert.equal(ui.editors[0]?.prefill, "octocat");
    assert.deepEqual(result, { action: "accept", content: { name: "octocat" } });
  });

  it("C-SHOULD-05 submits oneOf const values and shows titles", async () => {
    const ui = new ScriptedUi(["Answer", "Red", "Accept"]);
    const result = await fulfillElicitation(ui, {
      mode: "form",
      message: "Color",
      requestedSchema: {
        type: "object",
        properties: {
          paint: {
            type: "string",
            oneOf: [
              { const: "#FF0000", title: "Red" },
              { const: "#00FF00", title: "Green" },
            ],
          },
        },
        required: ["paint"],
      },
    }, { server: "billing" });
    assert.deepEqual(result, { action: "accept", content: { paint: "#FF0000" } });
    assert.ok(ui.selects.some((select) => select.options.includes("Red") && select.options.includes("Green")));
  });

  it("C-SHOULD-03 does not open a URL that appears in a form field", async () => {
    const opened: string[] = [];
    const ui = new ScriptedUi(["Answer", "https://evil.example/phish", "Accept"]);
    await fulfillElicitation(ui, {
      mode: "form",
      message: "See https://evil.example/phish",
      requestedSchema: { type: "object", properties: { note: { type: "string", format: "uri" } }, required: ["note"] },
    }, { server: "billing", openUrl: (url) => { opened.push(url); } });
    assert.deepEqual(opened, []);
    assert.equal(ui.selects.some((select) => select.options.includes("Open")), false);
  });

  it("C-MUST-15 returns cancel immediately when no UI is available", async () => {
    const started = Date.now();
    const result = await fulfillElicitation(undefined, {
      mode: "form",
      message: "Name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }, { server: "billing" });
    assert.deepEqual(result, { action: "cancel" });
    assert.ok(Date.now() - started < 50);
  });

  it("refuses an invalid email until the value matches the format", async () => {
    const ui = new ScriptedUi(["Answer", "nope", "Try again", "octocat@github.com", "Accept"]);
    const result = await fulfillElicitation(ui, {
      mode: "form",
      message: "Email",
      requestedSchema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] },
    }, { server: "billing" });
    assert.deepEqual(result, { action: "accept", content: { email: "octocat@github.com" } });
    assert.match(ui.notes.join("\n"), /email/);
  });
});

describe("multi round-trip params", () => {
  it("C-MUST-10 echoes requestState exactly and omits it when it was absent", () => {
    const state = "  AEAD-protected blob  ";
    const retried = buildMrtrRetryParams({ name: "deploy", arguments: { env: "prod" } }, {
      confirm: { action: "accept", content: { confirm: true } },
    }, { present: true, value: state });
    assert.equal(retried.requestState, state);
    assert.equal(Object.is(retried.requestState, state), true);
    assert.deepEqual((retried.arguments as { env: string }).env, "prod");
    const without = buildMrtrRetryParams({ name: "deploy", requestState: "previous", inputResponses: { old: true } }, {
      confirm: { action: "decline" },
    }, { present: false });
    assert.equal(Object.hasOwn(without, "requestState"), false);
    assert.deepEqual(without.inputResponses, { confirm: { action: "decline" } });
  });

  it("C-MUST-12 treats a missing resultType as complete", () => {
    assert.equal(readInputRequired({ content: [{ type: "text", text: "ok" }] }), undefined);
    assert.equal(readInputRequired({ resultType: "complete", content: [] }), undefined);
    const required = readInputRequired({ resultType: "input_required", requestState: "blob" });
    assert.ok(required && !("error" in required));
  });
});

describe("flags", () => {
  it("lets the environment override the approval and protocol flags", () => {
    assert.equal(approvalMode("ui", "tool"), "tool");
    assert.equal(approvalMode("tool", ""), "tool");
    assert.equal(approvalMode(undefined, undefined), "ui");
    assert.equal(protocolOffer("", "2026-07-28"), "2026-07-28");
    assert.equal(protocolOffer("2026-07-28", ""), "2026-07-28");
    assert.equal(protocolOffer("1999-01-01", ""), undefined);
  });
});

describe("capability merge", () => {
  it("C-MUST-01 adds form and url without dropping other capabilities", () => {
    const capabilities = withElicitationCapability({
      sampling: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    assert.deepEqual(capabilities.elicitation, { form: {}, url: {} });
    assert.deepEqual(capabilities.sampling, {});
    assert.deepEqual((capabilities.extensions as { "io.modelcontextprotocol/tasks": unknown })["io.modelcontextprotocol/tasks"], {});
    const params = withElicitationMeta({ name: "deploy", _meta: { progressToken: 1, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }, "2026-07-28");
    const meta = params._meta as {
      progressToken: number;
      "io.modelcontextprotocol/protocolVersion": string;
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: unknown; url: unknown } };
    };
    assert.equal(meta.progressToken, 1);
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2025-11-25");
    assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"].elicitation, { form: {}, url: {} });
  });
});

describe("browser", () => {
  it("C-MUST-08 launches xdg-open and does not keep a pipe that could read the page", async () => {
    const calls: Array<{ command: string; args: string[]; options: { stdio: string; detached: boolean } }> = [];
    const spawnImpl: SpawnExternal = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & { unref: () => void; once: EventEmitter["once"] };
      let unref = false;
      child.unref = () => {
        unref = true;
      };
      queueMicrotask(() => {
        assert.equal(unref, false);
        child.emit("spawn");
        assert.equal(unref, true);
      });
      return child as never;
    };
    await openExternal("https://mcp.example.com/ui/set_api_key", spawnImpl);
    assert.equal(calls[0]?.command, EXTERNAL_OPEN_COMMAND);
    assert.deepEqual(calls[0]?.args, ["https://mcp.example.com/ui/set_api_key"]);
    assert.equal(calls[0]?.options.stdio, "ignore");
    assert.equal(calls[0]?.options.detached, true);
  });
});
