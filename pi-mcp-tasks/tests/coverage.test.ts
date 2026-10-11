import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements.ts";

describe("checklist coverage", () => {
  it("maps every client requirement to a test", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
    for (const requirement of REQUIREMENTS) {
      assert.equal(requirement.status, "implemented", requirement.id);
      assert.equal(requirement.test, requirement.id, requirement.id);
      assert.equal(source.includes(requirement.id), true, requirement.id);
    }
  });
});
