// The prompts in prompts/*.md: each loads, every placeholder is filled, and versions follow the
// templates rather than the folder or MAQUETTE.md.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { systemPrompt } from "../../src/agent/prompt.ts";
import { fill, promptsDir, template } from "../../src/agent/prompts.ts";

const tools = [{ name: "render_page", description: "Renders a page.", inputSchema: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] } }];
const input = { root: "/r", instructions: "Engine says hi.", tools, mode: "ask" as const, textProtocol: false };

test("every prompt file loads, with its includes in place", () => {
  const names = readdirSync(promptsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  assert.ok(names.includes("core") && names.includes("project-rule"));
  for (const name of names) {
    const t = template(name);
    assert.match(t.version, /^[0-9a-f]{8}$/);
    assert.ok(!t.text.includes("{{>"), `${name} has an include left`);
  }
  assert.ok(template("project").text.includes(template("project-rule").text), "project.md takes the rule from project-rule.md");
});

test("the system prompt fills every placeholder, in every mode", () => {
  for (const mode of ["ask", "auto", "plan"] as const)
    for (const textProtocol of [false, true])
      for (const project of [undefined, "# Memo\n{{not a placeholder}}"]) {
        const blocks = systemPrompt({ ...input, mode, textProtocol, project });
        assert.deepEqual(blocks.map((b) => b.name), ["core", "environment", "project"]);
        for (const b of blocks.slice(0, 2)) assert.ok(!/\{\{/.test(b.text), `${b.name} has a placeholder left`);
        if (project) assert.ok(blocks[2].text.includes("{{not a placeholder}}"), "MAQUETTE.md's text goes in as it is");
      }
  assert.throws(() => fill("environment", {}), /prompts\/environment\.md uses \{\{root\}\}, which wasn't given/);
});

test("each block says which prompts it came from; versions don't change with the folder or MAQUETTE.md", () => {
  const plain = systemPrompt({ ...input, project: undefined });
  const elsewhere = systemPrompt({ ...input, root: "/elsewhere", instructions: "Other.", project: undefined });
  const planned = systemPrompt({ ...input, mode: "plan", project: "# Memo" });
  assert.deepEqual(plain.map((b) => b.source?.names), [["core"], ["environment", "engine"], ["no-project"]]);
  assert.deepEqual(planned.map((b) => b.source?.names), [["core"], ["environment", "plan-mode", "engine"], ["project"]]);
  assert.equal(plain[0].source?.version, template("core").version);
  assert.deepEqual(elsewhere.map((b) => b.source?.version), plain.map((b) => b.source?.version));
  assert.notEqual(planned[1].source?.version, plain[1].source?.version, "plan mode adds a prompt, so the environment's version differs");
  assert.deepEqual(plain[1].source?.variables, { root: "/r", tools: "", instructions: "Engine says hi." });
});
