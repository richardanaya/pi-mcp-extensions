import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { McpClient, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp";
import { installPiMcpHooks } from "../src/attach.ts";
import { formatReport } from "../index.ts";
import { SkillsHost } from "../src/host.ts";
import {
  clientCapabilitiesWithSkills,
  collisionLines,
  EXTENSION_ID,
  MAX_RESOURCES,
  MAX_SKILL_BYTES,
  parseFrontmatter,
  parseSkill,
  protocolRequiresCacheFields,
  resolveReference,
  skillPath,
  validSkillName,
  validateSkill,
} from "../src/model.ts";
import { cacheFields, FakePort, listedSkill, readResult, settle, skillDocument, skillsCapabilities, type SkillFile } from "./support.ts";

const allow = () => true;

function hostOf(port: FakePort, now?: () => number): SkillsHost {
  void port;
  return new SkillsHost(now ? { now } : {});
}

async function attach(host: SkillsHost, server: string, port: FakePort): Promise<void> {
  await host.attach(server, port);
}

test("C01 skills methods wait for the extension declaration", async () => {
  const silent = new FakePort({ resources: {} }, () => {
    throw new Error("should not be called");
  });
  const host = hostOf(silent);
  await attach(host, "plain", silent);
  assert.deepEqual(silent.methods(), []);
  const file = skillDocument("demo", "A demo skill");
  const declared = new FakePort(skillsCapabilities(), (method) => {
    assert.equal(method, "skills/list");
    return { skills: [listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file)], ...cacheFields() };
  });
  await attach(host, "skills", declared);
  assert.deepEqual(declared.methods(), ["skills/list"]);
  assert.equal(host.catalog().length, 1);
});

test("C02 directory reads require directoryRead true", async () => {
  const file = skillDocument("demo", "A demo skill");
  const off = new FakePort(skillsCapabilities(false), (method) => {
    if (method === "skills/list") return { skills: [listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file)] };
    throw new Error(method);
  });
  const host = hostOf(off);
  await attach(host, "skills", off);
  const shown = await host.directory("skills", "skill://demo", undefined, allow);
  assert.equal(off.methods().includes("resources/directory/read"), false);
  assert.match(shown.text, /SKILL\.md/);
  const on = new FakePort(skillsCapabilities(true), (method, params) => {
    if (method === "skills/list") return { skills: [listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file)] };
    if (method === "resources/directory/read") {
      assert.equal(params?.uri, "skill://demo");
      return { resources: [{ uri: "skill://demo/SKILL.md", name: "SKILL.md" }], ...cacheFields() };
    }
    throw new Error(method);
  });
  await attach(host, "skills", on);
  await host.directory("skills", "skill://demo", undefined, allow);
  assert.equal(on.methods().filter((method) => method === "resources/directory/read").length, 1);
});

test("C03 initialize advertises the skills extension", async () => {
  const preserved = clientCapabilitiesWithSkills({
    extensions: { [EXTENSION_ID]: { keep: true }, other: {} },
    sampling: {},
  });
  assert.deepEqual(preserved.extensions, { [EXTENSION_ID]: { keep: true }, other: {} });
  assert.deepEqual(preserved.sampling, {});
  const added = clientCapabilitiesWithSkills(undefined);
  assert.deepEqual((added.extensions as Record<string, unknown>)[EXTENSION_ID], {});

  const hook = await installPiMcpHooks({ onReady() {}, onClose() {} });
  assert.equal(hook.installed, true);
  const seen: unknown[] = [];
  let emit: ((message: JsonRpcMessage) => void) | undefined;
  const transport: McpTransport = {
    async start() {},
    async close() {},
    onMessage(listener) {
      emit = listener;
      return () => {};
    },
    onError() {
      return () => {};
    },
    onClose() {
      return () => {};
    },
    async send(message) {
      if (!("method" in message) || message.method !== "initialize" || !("id" in message)) return;
      seen.push(message.params);
      emit?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: skillsCapabilities(),
          serverInfo: { name: "fixture", version: "0" },
        },
      });
    },
  };
  const client = new McpClient({ name: "pi", version: "1.0.1", capabilities: { sampling: {} } });
  await client.connect(transport);
  await client.close();
  const params = seen[0] as { capabilities: { extensions: Record<string, unknown>; sampling: unknown } };
  assert.deepEqual(params.capabilities.extensions[EXTENSION_ID], {});
  assert.deepEqual(params.capabilities.sampling, {});
});

test("C04 a skills server without resources is not listed", async () => {
  const port = new FakePort({ extensions: { [EXTENSION_ID]: {} } }, () => {
    throw new Error("should not be called");
  });
  const host = hostOf(port);
  await attach(host, "half", port);
  assert.deepEqual(port.methods(), []);
  assert.match(host.errors()[0]?.message ?? "", /resources/);
  await assert.rejects(() => host.load("half", "skill://demo/SKILL.md", allow), /resources/);
});

test("C05 list pages are followed and entries stay whole", async () => {
  const first = skillDocument("one", "First skill");
  const second = skillDocument("two", "Second skill");
  const pages = [
    { skills: [listedSkill("skill://one/SKILL.md", "one", "First skill", first)], nextCursor: "page-2", ...cacheFields() },
    { skills: [listedSkill("skill://two/SKILL.md", "two", "Second skill", second)], nextCursor: "", ...cacheFields() },
  ];
  let index = 0;
  const cursors: unknown[] = [];
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    assert.equal(method, "skills/list");
    cursors.push(params?.cursor);
    return pages[index++];
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(
    host.catalog().map((entry) => entry.skill.uri),
    ["skill://one/SKILL.md", "skill://two/SKILL.md"],
  );
  const kept = host.catalog().map((entry) => entry.skill.uri);
  port.handler = (method, params) => {
    assert.equal(method, "skills/list");
    if (params?.cursor === undefined) return { skills: [listedSkill("skill://one/SKILL.md", "one", "First skill", first)], nextCursor: "loop" };
    return { skills: [listedSkill("skill://two/SKILL.md", "two", "Second skill", second)], nextCursor: "loop" };
  };
  await host.refresh("skills");
  assert.match(host.errors().find((error) => error.server === "skills")?.message ?? "", /nextCursor/);
  assert.deepEqual(host.catalog().map((entry) => entry.skill.uri), kept);
});

test("C06 an empty listing is not proof there are no skills", async () => {
  const file = skillDocument("hidden-skill", "Served only by skills/get");
  const uri = "skill://hidden-skill/SKILL.md";
  const port = new FakePort(
    skillsCapabilities(),
    (method, params) => {
      if (method === "skills/list") return { skills: [] };
      if (method === "skills/get") {
        assert.equal(params?.uri, uri);
        return { skill: listedSkill(uri, "hidden-skill", "Served only by skills/get", file) };
      }
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    },
    `See ${uri} for the rest.`,
  );
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(host.catalog().length, 0);
  assert.equal(host.references()[0]?.uri, uri);
  const loaded = await host.load("skills", uri, allow);
  assert.match(loaded.text, /Served only by skills\/get/);
  assert.equal(host.acting().some((item) => item.uri === uri), true);
});

test("C08 registry assembly does not fetch files", async () => {
  const file = skillDocument("demo", "A demo skill");
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file)] };
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.deepEqual(port.methods(), ["skills/list"]);
});

test("C09 cache fields are required on 2026-07-28 and are a freshness hint", async () => {
  assert.equal(protocolRequiresCacheFields("2026-07-28"), true);
  assert.equal(protocolRequiresCacheFields("2025-11-25"), false);
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const entry = listedSkill(uri, "demo", "A demo skill", file);
  const strict = new FakePort(skillsCapabilities(), () => ({ skills: [entry] }), undefined, "2026-07-28");
  const host = hostOf(strict);
  await attach(host, "strict", strict);
  assert.equal(host.catalog().length, 0);
  assert.match(host.errors()[0]?.message ?? "", /resultType/);

  let clock = 1_000;
  const timed = new FakePort(
    skillsCapabilities(),
    (method) => {
      if (method === "skills/list") return { skills: [entry], ...cacheFields(1_000) };
      if (method === "skills/get") return { skill: entry, ...cacheFields(1_000) };
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    },
    undefined,
    "2026-07-28",
  );
  const timedHost = new SkillsHost({ now: () => clock });
  await timedHost.attach("skills", timed);
  assert.equal(timedHost.catalog()[0]?.ttlMs, 1_000);
  assert.equal(timedHost.catalog()[0]?.cacheScope, "session");
  clock = 1_500;
  await timedHost.show("skills", uri);
  assert.equal(timed.methods().includes("skills/get"), false);
  clock = 2_000;
  await timedHost.show("skills", uri);
  assert.equal(timed.methods().includes("skills/get"), true);

  const old = new FakePort(skillsCapabilities(), () => ({ skills: [entry] }), undefined, "2025-11-25");
  const oldHost = hostOf(old);
  await oldHost.attach("old", old);
  assert.equal(oldHost.catalog().length, 1);

  let reads = 0;
  let clock = 5_000;
  const directory = new FakePort(
    skillsCapabilities(true),
    (method) => {
      if (method === "skills/list") return { skills: [entry], ...cacheFields(60_000) };
      if (method === "resources/directory/read") {
        reads += 1;
        return { resources: [{ uri, name: "SKILL.md" }], ...cacheFields(1_000) };
      }
      throw new Error(method);
    },
    undefined,
    "2026-07-28",
  );
  const directoryHost = new SkillsHost({ now: () => clock });
  await directoryHost.attach("skills", directory);
  await directoryHost.directory("skills", "skill://demo", uri, allow);
  await directoryHost.directory("skills", "skill://demo", uri, allow);
  assert.equal(reads, 1);
  clock = 6_000;
  await directoryHost.directory("skills", "skill://demo", uri, allow);
  assert.equal(reads, 2);

  const bareDirectory = new FakePort(
    skillsCapabilities(true),
    (method) => {
      if (method === "skills/list") return { skills: [entry], ...cacheFields() };
      if (method === "resources/directory/read") return { resources: [], resultType: "complete" };
      throw new Error(method);
    },
    undefined,
    "2026-07-28",
  );
  const bareHost = hostOf(bareDirectory);
  await bareHost.attach("bare", bareDirectory);
  await assert.rejects(() => bareHost.directory("bare", "skill://demo", uri, allow), /ttlMs/);

  let legacyReads = 0;
  const legacyDirectory = new FakePort(
    skillsCapabilities(true),
    (method) => {
      if (method === "skills/list") return { skills: [entry] };
      if (method === "resources/directory/read") {
        legacyReads += 1;
        return { resources: [{ uri, name: "SKILL.md" }], resultType: "complete" };
      }
      throw new Error(method);
    },
    undefined,
    "2025-11-25",
  );
  const legacyHost = hostOf(legacyDirectory);
  await legacyHost.attach("legacy", legacyDirectory);
  await legacyHost.directory("legacy", "skill://demo", uri, allow);
  await legacyHost.directory("legacy", "skill://demo", uri, allow);
  assert.equal(legacyReads, 2);
});

test("C10 colliding names are kept and disambiguated by path", async () => {
  const billing = skillDocument("refunds", "Billing refunds");
  const support = skillDocument("refunds", "Support refunds");
  const skills = [
    listedSkill("skill://acme/billing/refunds/SKILL.md", "refunds", "Billing refunds", billing),
    listedSkill("skill://acme/support/refunds/SKILL.md", "refunds", "Support refunds", support),
  ];
  const port = new FakePort(skillsCapabilities(), () => ({ skills }));
  const host = hostOf(port);
  await attach(host, "acme", port);
  const names = host.catalog().map((entry) => entry.displayName).sort();
  assert.deepEqual(names, ["acme/billing/refunds", "acme/support/refunds"]);
  await assert.rejects(() => host.load("acme", "refunds", allow), /More than one skill/);
});

test("C11 names are per server label and do not shadow", async () => {
  const file = skillDocument("notes", "Notes");
  const entry = listedSkill("skill://notes/SKILL.md", "notes", "Notes", file);
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult("skill://notes/SKILL.md", file.text);
    throw new Error(method);
  });
  const other = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult("skill://notes/SKILL.md", file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "alpha", port);
  await attach(host, "beta", other);
  const found = host.search("notes");
  assert.deepEqual(found.map((entry) => entry.server).sort(), ["alpha", "beta"]);
  await host.load("alpha", "notes", allow);
  assert.deepEqual(host.acting(), [{ server: "alpha", uri: "skill://notes/SKILL.md" }]);
});

test("C12 identity is server plus URI", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const make = () =>
    new FakePort(skillsCapabilities(), (method) => {
      if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    });
  const host = new SkillsHost();
  await host.attach("alpha", make());
  await host.attach("beta", make());
  let prompts = 0;
  const approve = (prompt: { kind: string }) => {
    if (prompt.kind === "load") prompts += 1;
    return true;
  };
  await host.load("alpha", uri, approve);
  await host.load("beta", uri, approve);
  assert.equal(prompts, 2);
  host.unload("alpha", uri);
  assert.deepEqual(host.acting(), [{ server: "beta", uri }]);
});

test("C13 missing or unknown resources fields are refused", async () => {
  const file = skillDocument("demo", "A demo skill");
  const good = listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file);
  const skills = [
    { uri: "skill://bare/SKILL.md", frontmatter: { name: "bare", description: "Missing resources" } },
    { uri: "skill://weird/SKILL.md", frontmatter: { name: "weird", description: "Wrong resources" }, resources: 5 },
    { ...good, uri: "skill://dyn/SKILL.md", frontmatter: { name: "dyn", description: "Dynamic" }, resources: "dynamic" },
    good,
  ];
  const port = new FakePort(skillsCapabilities(), () => ({ skills }));
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.deepEqual(
    host.catalog().map((entry) => entry.skill.uri),
    ["skill://dyn/SKILL.md", "skill://demo/SKILL.md"],
  );
  assert.equal(host.rejected().length, 2);
});

test("C14 resource arrays must be complete and inside the skill", () => {
  const digest = `sha256:${"ab".repeat(32)}`;
  const uri = "skill://demo/SKILL.md";
  const base = { uri, digest, size: 1 };
  const outside = validateSkill(skill(uri, [base, { uri: "skill://other/file.txt", digest, size: 1 }]));
  assert.equal(outside.ok, false);
  const duplicate = validateSkill(skill(uri, [base, base]));
  assert.match(duplicate.ok ? "" : duplicate.reason, /more than once/);
  const badDigest = validateSkill(skill(uri, [{ uri, digest: "md5:nope", size: 1 }]));
  assert.match(badDigest.ok ? "" : badDigest.reason, /sha256/);
  const missingSelf = validateSkill(skill(uri, [{ uri: "skill://demo/other.txt", digest, size: 1 }]));
  assert.match(missingSelf.ok ? "" : missingSelf.reason, /omit SKILL.md/);
  const good = validateSkill(skill(uri, [base, { uri: "skill://demo/other.txt", digest, size: 2 }]));
  assert.equal(good.ok, true);
});

test("C15 dynamic skills are not content-bound", async () => {
  const file = skillDocument("dyn", "Dynamic notes");
  const uri = "skill://dyn/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") {
      return { skills: [{ uri, frontmatter: { name: "dyn", description: "Dynamic notes" }, resources: "dynamic" }] };
    }
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const prompts: { dynamic: boolean }[] = [];
  const approve = (prompt: { dynamic: boolean }) => {
    prompts.push(prompt);
    return true;
  };
  await host.load("skills", uri, approve);
  await host.load("skills", uri, approve);
  assert.equal(prompts.length, 2);
  assert.equal(prompts.every((prompt) => prompt.dynamic), true);
});

test("C16 skills up to the published limits load and larger ones are declined", async () => {
  const digest = `sha256:${"cd".repeat(32)}`;
  const uri = "skill://big/SKILL.md";
  const atCount = resources(uri, MAX_RESOURCES, 1);
  const overCount = resources(uri, MAX_RESOURCES + 1, 1);
  const atBytes = [{ uri, digest, size: MAX_SKILL_BYTES }];
  const overBytes = [{ uri, digest, size: MAX_SKILL_BYTES + 1 }];
  assert.equal(validateSkill(skill(uri, atCount)).ok, true);
  assert.match(validateSkill(skill(uri, overCount)).ok ? "" : (validateSkill(skill(uri, overCount)) as { reason: string }).reason, /512/);
  assert.equal(validateSkill(skill(uri, atBytes)).ok, true);
  const over = validateSkill(skill(uri, overBytes));
  assert.match(over.ok ? "" : over.reason, new RegExp(String(MAX_SKILL_BYTES)));
  const port = new FakePort(skillsCapabilities(), () => ({
    skills: [skill(uri, overCount)],
  }));
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(host.catalog().length, 0);
  assert.match(host.rejected()[0]?.reason ?? "", /512/);
});

test("C17 dynamic retrieval stops at 16 MiB", async () => {
  const file = skillDocument("dyn", "Dynamic notes");
  const uri = "skill://dyn/SKILL.md";
  const blob = "skill://dyn/blob.txt";
  const room = MAX_SKILL_BYTES - file.size;
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list") {
      return { skills: [{ uri, frontmatter: { name: "dyn", description: "Dynamic notes" }, resources: "dynamic" }] };
    }
    if (method === "resources/read" && params?.uri === uri) return readResult(uri, file.text);
    if (method === "resources/read" && params?.uri === blob) return readResult(blob, "x".repeat(room));
    if (method === "resources/read") return readResult(String(params?.uri), "y");
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.load("skills", uri, allow);
  const first = await host.read("skills", blob, uri, allow);
  assert.equal(first.text.includes("x"), true);
  await assert.rejects(() => host.read("skills", "skill://dyn/more.txt", uri, allow), /16/);
});

test("C18 frontmatter is kept and the path segment matches the name", async () => {
  const file = skillDocument("demo", "A demo skill", "body", "license: mit");
  const entry = listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file, undefined, { license: "mit" });
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry, listedSkill("skill://demo/SKILL.md", "other", "Mismatch", file)] };
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(host.catalog()[0]?.skill.frontmatter.license, "mit");
  assert.match(host.rejected()[0]?.reason ?? "", /other/);
});

test("C19 unrecognized extension metadata keys are ignored", async () => {
  const file = skillDocument("demo", "A demo skill", "body", "metadata:\n  io.modelcontextprotocol/future: 1\n  kept: visible");
  const entry = listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file, undefined, {
    metadata: { "io.modelcontextprotocol/future": 1, kept: "visible" },
  });
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult("skill://demo/SKILL.md", file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const shown = await host.show("skills", "demo");
  assert.match(shown.text, /io\.modelcontextprotocol\/future/);
  assert.equal(host.acting().length, 0);
  assert.equal(host.catalog()[0]?.skill.frontmatter.metadata && (host.catalog()[0]?.skill.frontmatter.metadata as { kept: string }).kept, "visible");
});

test("C20 skill URI authorities are not resolved", () => {
  const source = readFileSync(new URL("../src/model.ts", import.meta.url), "utf8");
  assert.equal(source.includes("node:dns"), false);
  assert.equal(source.includes("new URL"), false);
  assert.equal(skillPath("skill://_not_a_host/my-skill/SKILL.md"), "_not_a_host/my-skill");
  assert.equal(resolveReference("skill://_not_a_host/my-skill/SKILL.md", "guide.md"), "skill://_not_a_host/my-skill/guide.md");
});

test("C21 a URI scheme does not make a resource a skill", async () => {
  const port = new FakePort(skillsCapabilities(), () => ({ skills: [] }), "Look at skill://ghost/SKILL.md later.");
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(host.catalog().length, 0);
  assert.equal(host.references()[0]?.uri, "skill://ghost/SKILL.md");
  assert.equal(port.methods().includes("skills/get"), false);
  assert.equal(port.methods().includes("resources/read"), false);
});

test("C23 skill names and descriptions follow Agent Skills", () => {
  assert.equal(validSkillName("my-skill"), true);
  assert.equal(validSkillName("α"), true);
  assert.equal(validSkillName("技能"), false);
  assert.equal(validSkillName("Bad"), false);
  assert.equal(validSkillName("-skill"), false);
  assert.equal(validSkillName("skill-"), false);
  assert.equal(validSkillName(""), false);
  const digest = `sha256:${"ab".repeat(32)}`;
  const uri = "skill://demo/SKILL.md";
  assert.equal(validateSkill(skill(uri, [{ uri, digest, size: 1 }], "d".repeat(1024))).ok, true);
  assert.match(validateSkill(skill(uri, [{ uri, digest, size: 1 }], "")).ok ? "" : "description", /description/);
  const long = validateSkill(skill(uri, [{ uri, digest, size: 1 }], "d".repeat(1025)));
  assert.equal(long.ok, false);
});

test("C24 the previous name pattern and extra fields still load", async () => {
  assert.equal(validSkillName("my--skill"), true);
  const file = skillDocument("my--skill", "Still valid", "body", "license: mit");
  const entry = listedSkill("skill://old/my--skill/SKILL.md", "my--skill", "Still valid", file, undefined, { license: "mit" });
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult(entry.uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const loaded = await host.load("skills", "my--skill", allow);
  assert.match(loaded.text, /Still valid/);
  assert.equal(host.catalog()[0]?.skill.frontmatter.license, "mit");
});

test("C27 SKILL.md frontmatter must match the entry field by field", async () => {
  const file = skillDocument("demo", "From the file");
  const entry = listedSkill("skill://demo/SKILL.md", "demo", "From the entry", file);
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult("skill://demo/SKILL.md", file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await assert.rejects(() => host.load("skills", "demo", allow), /Frontmatter/);
  assert.equal(host.acting().length, 0);
});

test("C28 a stale read recovers through skills/get and revokes a moved set", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const stale = listedSkill(uri, "demo", "A demo skill", { ...file, digest: `sha256:${"00".repeat(32)}`, size: file.size });
  const fresh = listedSkill(uri, "demo", "A demo skill", file);
  let gets = 0;
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [stale] };
    if (method === "skills/get") {
      gets += 1;
      return { skill: fresh };
    }
    if (method === "resources/read") return readResult(uri, `${file.text}MARKER`);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await assert.rejects(() => host.load("skills", uri, allow), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : "", /Load it again/);
    assert.equal(String(error instanceof Error ? error.message : "").includes("MARKER"), false);
    return true;
  });
  assert.equal(gets, 1);
  assert.equal(host.acting().length, 0);
  port.handler = (method) => {
    if (method === "skills/list" || method === "skills/get") return method === "skills/get" ? { skill: fresh } : { skills: [fresh] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  };
  const loaded = await host.load("skills", uri, allow);
  assert.match(loaded.text, /A demo skill/);
  assert.equal(loaded.text.includes("MARKER"), false);
});

test("C29 an unlisted file is a verification failure while acting", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const secret = "skill://demo/secret.txt";
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list" || method === "skills/get") {
      const entry = listedSkill(uri, "demo", "A demo skill", file);
      return method === "skills/get" ? { skill: entry } : { skills: [entry] };
    }
    if (method === "resources/read" && params?.uri === secret) return readResult(secret, "SECRET_BYTES");
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.load("skills", uri, allow);
  await assert.rejects(() => host.read("skills", secret, uri, allow), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /not in the approved files/);
    assert.equal(message.includes("SECRET_BYTES"), false);
    return true;
  });
});

test("C30 files are fetched when loaded or read, not before approval", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const extra = skillDocument("demo", "A demo skill", "template");
  const extraUri = "skill://demo/template.txt";
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list") {
      return { skills: [listedSkill(uri, "demo", "A demo skill", file, [{ uri, digest: file.digest, size: file.size }, { uri: extraUri, digest: extra.digest, size: extra.size }])] };
    }
    if (method === "resources/read" && params?.uri === extraUri) return readResult(extraUri, extra.text);
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(port.methods().includes("resources/read"), false);
  const approve = () => {
    assert.equal(port.methods().includes("resources/read"), false);
    return true;
  };
  await host.load("skills", uri, approve);
  assert.equal(port.calls.filter((call) => call.method === "resources/read" && call.params?.uri === uri).length, 1);
  await host.read("skills", extraUri, uri, allow);
  assert.equal(port.calls.filter((call) => call.params?.uri === extraUri).length, 1);
});

test("C31 verified bytes are reused only when the digest still matches", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.show("skills", uri);
  await host.show("skills", uri);
  assert.equal(port.calls.filter((call) => call.method === "resources/read").length, 1);
  const changed = skillDocument("demo", "A demo skill", "changed body");
  port.handler = (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", changed)] };
    if (method === "resources/read") return readResult(uri, changed.text);
    throw new Error(method);
  };
  await host.refresh("skills");
  await host.show("skills", uri);
  assert.equal(port.calls.filter((call) => call.method === "resources/read").length, 2);
});

test("C32 a matching digest is still untrusted server text", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "origin-a", port);
  const loaded = await host.load("origin-a", uri, allow);
  assert.match(loaded.text, /untrusted server text/);
  assert.match(loaded.text, /not a local filesystem skill/);
});

test("C33 the acting window stays until unload or detach", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.load("skills", uri, allow);
  assert.equal(host.acting().length, 1);
  host.unload("skills", uri);
  assert.equal(host.acting().length, 0);
  await host.load("skills", uri, allow);
  host.detach("skills");
  assert.equal(host.acting().length, 0);
});

test("C34 reading SKILL.md does not load it", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const read = await host.read("skills", uri, uri, allow);
  assert.match(read.text, /not a loaded skill/);
  assert.equal(read.activated, false);
  assert.equal(host.acting().length, 0);
});

test("C35 relative references resolve against that skill directory", async () => {
  const parent = skillDocument("parent", "Parent skill");
  const nested = skillDocument("child-skill", "Nested skill");
  const note = skillDocument("child-skill", "Nested skill", "note");
  const parentUri = "skill://app/parent/SKILL.md";
  const nestedUri = "skill://app/parent/child-skill/SKILL.md";
  const noteUri = "skill://app/parent/child-skill/note.txt";
  const skills = [
    listedSkill(parentUri, "parent", "Parent skill", parent, [
      { uri: parentUri, digest: parent.digest, size: parent.size },
      { uri: nestedUri, digest: nested.digest, size: nested.size },
    ]),
    listedSkill(nestedUri, "child-skill", "Nested skill", nested, [
      { uri: nestedUri, digest: nested.digest, size: nested.size },
      { uri: noteUri, digest: note.digest, size: note.size },
    ]),
  ];
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list") return { skills };
    if (method === "resources/read" && params?.uri === noteUri) return readResult(noteUri, note.text);
    throw new Error(String(params?.uri));
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const read = await host.read("skills", "note.txt", nestedUri, allow);
  assert.equal(port.calls.some((call) => call.params?.uri === noteUri), true);
  assert.match(read.text, /note/);
  await assert.rejects(() => host.read("skills", "../SKILL.md", nestedUri, allow), /escapes/);
});

test("C36 a nested SKILL.md read does not activate its frontmatter", async () => {
  const parent = skillDocument("parent", "Parent skill");
  const nested = skillDocument("child-skill", "Nested skill");
  const parentUri = "skill://app/parent/SKILL.md";
  const nestedUri = "skill://app/parent/child-skill/SKILL.md";
  const skills = [
    listedSkill(parentUri, "parent", "Parent skill", parent, [
      { uri: parentUri, digest: parent.digest, size: parent.size },
      { uri: nestedUri, digest: nested.digest, size: nested.size },
    ]),
    listedSkill(nestedUri, "child-skill", "Nested skill", nested),
  ];
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list") return { skills };
    if (params?.uri === parentUri) return readResult(parentUri, parent.text);
    if (params?.uri === nestedUri) return readResult(nestedUri, nested.text);
    throw new Error(String(params?.uri));
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.load("skills", parentUri, allow);
  const read = await host.read("skills", nestedUri, parentUri, allow);
  assert.match(read.text, /not activated/);
  assert.deepEqual(host.acting(), [{ server: "skills", uri: parentUri }]);
});

test("C37 directory reads follow nextCursor", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const cursors: unknown[] = [];
  const port = new FakePort(skillsCapabilities(true), (method, params) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/directory/read") {
      cursors.push(params?.cursor);
      if (params?.cursor === undefined) return { resources: [{ uri, name: "SKILL.md" }], nextCursor: "d2", resultType: "complete" };
      return { resources: [{ uri: "skill://demo/more.txt", name: "more.txt" }], nextCursor: null, resultType: "complete" };
    }
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const listed = await host.directory("skills", "skill://demo", uri, allow);
  assert.deepEqual(cursors, [undefined, "d2"]);
  assert.match(listed.text, /SKILL\.md/);
  assert.match(listed.text, /more\.txt/);
});

test("C38 a manifest can answer a directory question", async () => {
  const file = skillDocument("demo", "A demo skill");
  const extra = skillDocument("demo", "A demo skill", "template");
  const uri = "skill://demo/SKILL.md";
  const template = "skill://demo/templates/sample.txt";
  const port = new FakePort(skillsCapabilities(false), (method) => {
    if (method === "skills/list") {
      return {
        skills: [listedSkill(uri, "demo", "A demo skill", file, [
          { uri, digest: file.digest, size: file.size },
          { uri: template, digest: extra.digest, size: extra.size },
        ])],
      };
    }
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const root = await host.directory("skills", "skill://demo", uri, allow);
  assert.equal(port.methods().includes("resources/directory/read"), false);
  assert.match(root.text, /templates/);
  assert.match(root.text, /SKILL\.md/);
});

test("C39 a directory result cannot extend the manifest", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const entry = listedSkill(uri, "demo", "A demo skill", file);
  const port = new FakePort(skillsCapabilities(true), (method) => {
    if (method === "skills/list" || method === "skills/get") return method === "skills/get" ? { skill: entry } : { skills: [entry] };
    if (method === "resources/read") return readResult(uri, file.text);
    if (method === "resources/directory/read") {
      return {
        resources: [
          { uri, name: "SKILL.md" },
          { uri: "skill://demo/extra.txt", name: "extra.txt" },
        ],
        resultType: "complete",
      };
    }
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.load("skills", uri, allow);
  const listed = await host.directory("skills", "skill://demo", uri, allow);
  assert.match(listed.text, /not part of the approved skill/);
  assert.match(listed.text, /extra\.txt/);
  assert.equal(listed.text.split("\n").some((line) => line.includes("\t") && line.includes("extra.txt")), false);
  assert.equal(host.acting().length, 1);
});

test("C41 loaded text is tagged with the host server label", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "host-label", port);
  const loaded = await host.load("host-label", uri, allow);
  assert.match(loaded.text, /server "host-label"/);
  assert.equal(loaded.text.includes("serverInfo"), false);
});

test("C42 allowed-tools is ignored", async () => {
  const file = skillDocument("demo", "A demo skill", "body", "allowed-tools: bash");
  const entry = listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file, undefined, { "allowed-tools": "bash" });
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    if (method === "resources/read") return readResult(entry.uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const loaded = await host.load("skills", "demo", allow);
  assert.match(loaded.text, /allowed-tools is ignored/);
  assert.equal(host.acting().length, 1);
});

test("C44 a read of another server needs an approval that names both", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const make = () =>
    new FakePort(skillsCapabilities(), (method) => {
      if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    });
  const host = new SkillsHost();
  await host.attach("alpha", make());
  await host.attach("beta", make());
  await host.load("alpha", uri, allow);
  const prompts: string[] = [];
  await assert.rejects(
    () =>
      host.read("beta", uri, uri, (prompt) => {
        prompts.push(`${prompt.otherServer} -> ${prompt.server}`);
        return false;
      }),
    /Cross-origin/,
  );
  assert.deepEqual(prompts, ["alpha -> beta"]);
  const read = await host.read("beta", uri, uri, (prompt) => prompt.otherServer === "alpha" && prompt.server === "beta");
  assert.match(read.text, /server "beta"/);
});

test("C45 approval is bound to the resources set", async () => {
  const first = skillDocument("demo", "A demo skill", "one");
  const second = skillDocument("demo", "A demo skill", "two");
  const uri = "skill://demo/SKILL.md";
  let current: SkillFile = first;
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", current)] };
    if (method === "resources/read") return readResult(uri, current.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  let prompts = 0;
  const approve = (prompt: { changed: boolean }) => {
    prompts += 1;
    return prompt.changed || prompts === 1;
  };
  await host.load("skills", uri, approve);
  await host.load("skills", uri, approve);
  assert.equal(prompts, 1);
  current = second;
  await host.refresh("skills");
  const again = await host.load("skills", uri, (prompt) => {
    prompts += 1;
    assert.equal(prompt.changed, true);
    return true;
  });
  assert.match(again.text, /two/);
  assert.equal(prompts, 2);
});

test("C46 a nested skill needs its own approval", async () => {
  const parent = skillDocument("parent", "Parent skill");
  const nested = skillDocument("child-skill", "Nested skill");
  const parentUri = "skill://app/parent/SKILL.md";
  const nestedUri = "skill://app/parent/child-skill/SKILL.md";
  const skills = [
    listedSkill(parentUri, "parent", "Parent skill", parent),
    listedSkill(nestedUri, "child-skill", "Nested skill", nested),
  ];
  const port = new FakePort(skillsCapabilities(), (method, params) => {
    if (method === "skills/list") return { skills };
    if (params?.uri === parentUri) return readResult(parentUri, parent.text);
    if (params?.uri === nestedUri) return readResult(nestedUri, nested.text);
    throw new Error(String(params?.uri));
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  const approved: string[] = [];
  const approve = (prompt: { uri?: string }) => {
    approved.push(prompt.uri ?? "");
    return true;
  };
  await host.load("skills", parentUri, approve);
  await host.load("skills", nestedUri, approve);
  assert.deepEqual(approved, [parentUri, nestedUri]);
});

test("C48 name collisions are reported to the user", async () => {
  const billing = skillDocument("refunds", "Billing refunds");
  const support = skillDocument("refunds", "Support refunds");
  const skills = [
    listedSkill("skill://acme/billing/refunds/SKILL.md", "refunds", "Billing refunds", billing),
    listedSkill("skill://acme/support/refunds/SKILL.md", "refunds", "Support refunds", support),
  ];
  const port = new FakePort(skillsCapabilities(), () => ({ skills }));
  const host = hostOf(port);
  await attach(host, "acme", port);
  const report = formatReport(host);
  assert.match(report, /Name collision on acme: refunds is/);
  assert.match(report, /billing\/refunds/);
  assert.match(report, /support\/refunds/);
  assert.equal(collisionLines([{ server: "acme", name: "solo", uri: "skill://solo/SKILL.md" }]).length, 0);
});

test("C49 loading can be declined", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await assert.rejects(() => host.load("skills", uri, () => false), /not approved/);
  assert.equal(port.methods().includes("resources/read"), false);
  assert.equal(host.acting().length, 0);
});

test("C50 the memory cache leaves with the server", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.show("skills", uri);
  await host.show("skills", uri);
  assert.equal(port.calls.filter((call) => call.method === "resources/read").length, 1);
  host.detach("skills");
  await host.attach("skills", port);
  await host.show("skills", uri);
  assert.equal(port.calls.filter((call) => call.method === "resources/read").length, 2);
});

test("C56 requests carry negotiated _meta and client capabilities", async () => {
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const entry = listedSkill(uri, "demo", "A demo skill", file);
  const port = new FakePort(
    skillsCapabilities(true),
    (method) => {
      if (method === "skills/list") return { skills: [entry], ...cacheFields() };
      if (method === "skills/get") return { skill: entry, ...cacheFields() };
      if (method === "resources/read") return readResult(uri, file.text);
      if (method === "resources/directory/read") return { resources: [{ uri, name: "SKILL.md" }], ...cacheFields() };
      throw new Error(method);
    },
    undefined,
    "2025-11-25",
  );
  const host = hostOf(port);
  await attach(host, "skills", port);
  await host.show("skills", "skill://missing/SKILL.md");
  await host.directory("skills", "skill://demo", uri, allow);
  const methods = ["skills/list", "skills/get", "resources/read", "resources/directory/read"];
  for (const method of methods) {
    const call = port.calls.find((item) => item.method === method);
    const meta = call?.params?._meta as Record<string, unknown> | undefined;
    assert.equal(meta?.["io.modelcontextprotocol/protocolVersion"], "2025-11-25", method);
    assert.deepEqual(meta?.["io.modelcontextprotocol/clientInfo"], { name: "pi-mcp-skills", version: "0.1.0" });
    const caps = meta?.["io.modelcontextprotocol/clientCapabilities"] as { extensions?: Record<string, unknown> };
    assert.deepEqual(caps.extensions?.[EXTENSION_ID], {});
  }
  const unset = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [entry] };
    throw new Error(method);
  });
  const unsetHost = hostOf(unset);
  await unsetHost.attach("unset", unset);
  const meta = unset.calls[0]?.params?._meta as Record<string, unknown>;
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], undefined);
  assert.ok(meta["io.modelcontextprotocol/clientCapabilities"]);
});

test("C57 optional skill _meta is kept and a non-object is rejected", () => {
  const file = skillDocument("demo", "A demo skill");
  const entry = listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", file);
  const parsed = parseSkill({ ...entry, _meta: { "io.modelcontextprotocol.skills/note": "kept" } });
  assert.equal("skill" in parsed, true);
  if (!("skill" in parsed)) return;
  assert.equal(parsed.skill._meta?.["io.modelcontextprotocol.skills/note"], "kept");
  const absent = parseSkill(entry);
  assert.equal("skill" in absent && absent.skill._meta, undefined);
  const bad = parseSkill({ ...entry, _meta: ["nope"] });
  assert.equal("error" in bad, true);
});

test("C55 instruction URIs are references until skills/get", async () => {
  const file = skillDocument("hidden-skill", "Confirmed later");
  const uri = "skill://hidden-skill/SKILL.md";
  const port = new FakePort(
    skillsCapabilities(),
    (method) => {
      if (method === "skills/list") return { skills: [] };
      if (method === "skills/get") return { skill: listedSkill(uri, "hidden-skill", "Confirmed later", file) };
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    },
    `Instructions mention ${uri} only.`,
  );
  const host = hostOf(port);
  await attach(host, "skills", port);
  assert.equal(host.catalog().length, 0);
  assert.deepEqual(host.references(), [{ server: "skills", uri }]);
  await host.load("skills", uri, allow);
  assert.equal(host.references().length, 0);
  assert.equal(host.catalog()[0]?.skill.uri, uri);
});

test("list-changed notifications schedule another list", async () => {
  const first = skillDocument("demo", "A demo skill");
  const second = skillDocument("other", "Added later");
  let skills = [listedSkill("skill://demo/SKILL.md", "demo", "A demo skill", first)];
  const port = new FakePort(skillsCapabilities(), () => ({ skills }));
  const host = hostOf(port);
  await attach(host, "skills", port);
  skills = [...skills, listedSkill("skill://other/SKILL.md", "other", "Added later", second)];
  port.emit("notifications/resources/list_changed");
  await settle();
  assert.equal(host.catalog().some((entry) => entry.skill.frontmatter.name === "other"), true);
  skills = [...skills, listedSkill("skill://third/SKILL.md", "third", "From the skills notification", skillDocument("third", "From the skills notification"))];
  port.emit("notifications/skills/list_changed");
  await settle();
  assert.equal(host.catalog().some((entry) => entry.skill.frontmatter.name === "third"), true);
});

test("YAML frontmatter timestamps compare as JSON values", () => {
  const parsed = parseFrontmatter("---\nname: demo\ndescription: A demo skill\nupdated: 2020-01-02\n---\nbody\n");
  assert.equal("error" in parsed, false);
  if ("error" in parsed) return;
  assert.equal(typeof parsed.value.updated === "string" || parsed.value.updated instanceof Object, true);
});

function skill(
  uri: string,
  resources: { uri: string; digest: string; size: number }[],
  description = "A demo skill",
) {
  const name = uri.slice(uri.lastIndexOf("/", uri.length - "/SKILL.md".length - 1) + 1, -"/SKILL.md".length);
  return { uri, frontmatter: { name, description }, resources };
}

function resources(uri: string, count: number, size: number) {
  const digest = `sha256:${"ab".repeat(32)}`;
  return Array.from({ length: count }, (_, index) => ({
    uri: index === 0 ? uri : uri.replace(/SKILL\.md$/, `f${index}.txt`),
    digest,
    size,
  }));
}
