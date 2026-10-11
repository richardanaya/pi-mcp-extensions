import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("every requirement id is named by a test and the README", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const tests = readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(root, "tests", name), "utf8"))
    .join("\n");
  for (const requirement of REQUIREMENTS) {
    assert.equal(readme.includes(requirement.id), true, `${requirement.id} missing from README`);
    assert.equal(tests.includes(requirement.id), true, `${requirement.id} missing from tests`);
    assert.equal(requirement.status, "implemented");
  }
});
