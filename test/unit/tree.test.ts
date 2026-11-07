import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { folderMap } from "../../src/tools/workspace/tree.ts";
import workspace from "../../src/tools/workspace/index.ts";
import survey from "../../src/tools/survey/index.ts";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { fakeServer, settings } from "./fake-server.ts";
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "maquette-tree-")));
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

test("folder map deterministic summaries, exclusions, collapse and direct large-directory first page", async () => {
  const dir = root(); mkdirSync(join(dir, "Links"));
  for (let i = 0; i < 35; i++) writeFileSync(join(dir, "Links", `${String(i).padStart(2, "0")}.PNG`), "abc");
  for (const name of [".hidden", "node_modules", ".git", ".maquette", "maquette-renders"]) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "ignore.txt"), "ignored"); }
  writeFileSync(join(dir, "brief.md"), "brief"); writeFileSync(join(dir, "control\nname.txt"), "x");
  const map = await folderMap(dir); assert.deepEqual(await folderMap(dir), map);
  assert.equal(map.summary.files, 37); assert.equal(map.summary.bytes, 111); assert.equal(map.summary.types[".png"], 35);
  assert.ok(map.lines.some(l => /collapsed: 35/.test(l))); assert.ok(map.lines.some(l => /control\\u000aname/.test(l)));
  assert.doesNotMatch(JSON.stringify(map), /ignore.txt|node_modules|maquette-renders/);
  const direct = await folderMap(dir, "Links"); assert.equal(direct.summary.files, 35); assert.ok(direct.lines.some(l => /15 entries omitted/.test(l)));
  assert.equal((await folderMap(dir, ".", 0)).lines.length, 1); assert.equal((await folderMap(dir, ".", 0)).summary.partial, true);
  await assert.rejects(() => folderMap(dir, ".", 7), /0 to 6/);
});
test("symlinks/traversal are confined and unreadable entries remain explicit", async () => {
  const dir = root(), outside = root(); writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(dir, "outside")); symlinkSync(dir, join(dir, "cycle")); mkdirSync(join(dir, "locked")); chmodSync(join(dir, "locked"), 0);
  try {
    const map = await folderMap(dir); assert.equal(map.summary.links, 2); assert.doesNotMatch(JSON.stringify(map), /secret.txt/); assert.match(JSON.stringify(map), /symlink; not followed/);
    if (process.getuid?.() !== 0) assert.equal(map.partial, true);
    await assert.rejects(() => folderMap(dir, "outside"), /symlink/); await assert.rejects(() => folderMap(dir, "../"), /outside/);
  } finally { chmodSync(join(dir, "locked"), 0o700); }
});
test("large traversal and output stay bounded; counts are explicitly partial", async () => {
  const dir = root();
  for (let i = 0; i < 2105; i++) writeFileSync(join(dir, `file-${String(i).padStart(4, "0")}.txt`), "x");
  const started = Date.now(); const map = await folderMap(dir, ".", 6);
  assert.ok(map.visited <= 2000); assert.ok(map.lines.length <= 250); assert.ok(Buffer.byteLength(JSON.stringify(map)) <= 24576); assert.equal(map.partial, true); assert.equal(map.summary.partial, true); assert.ok(Date.now() - started < 2500); assert.match(map.hint!, /Partial/);
});
test("tree and survey without a document use the same map", async () => {
  const dir = root(); writeFileSync(join(dir, "brief.md"), "Purpose: members");
  const context = { root: dir, readRoots: [dir], warnings: () => [], dc: { async json() { throw new Error("no document"); } } as any };
  const tree = await workspace(context).call("tree", {}); const s = await survey(context).call("document_survey", {});
  const last = s.content.filter(c => c.type === "text").at(-1)!.text!;
  assert.deepEqual(JSON.parse(last).folder, JSON.parse(text(tree))); assert.match(text(s), /No document is open/);
});
test("scripted init reads selected brief, cites it and preserves existing memory until agreed", async () => {
  const server = fakeServer(); writeFileSync(join(server.root, "brief.md"), "Audience: members. Use blue."); writeFileSync(join(server.root, "MAQUETTE.md"), "# Keep the designer's words\n");
  const ws = workspace({ root: server.root, readRoots: [server.root], warnings: () => [], dc: {} as any });
  const original = server.enqueue.bind(server); const names = new Set(ws.tools.map(t => t.name)); server.tools = [...server.tools, ...ws.tools]; server.byName = new Map(server.tools.map(t => [t.name, t]));
  server.enqueue = async (name, args, source) => names.has(name) ? { id: 1, tool: name, source, ms: 0, ok: true, text: text(await ws.call(name, args)), images: [] } : original(name, args, source);
  const provider = new FakeProvider([{ text: "I select brief.md for purpose and brand evidence.", calls: [{ name: "read_file", input: { path: "brief.md" } }] }, { text: "Proposed authority: brief.md; Audience: members. Existing memory preserved. May I add the agreed guidance?" }]);
  const s = new AgentSession({ server, settings: settings(), provider, projectFile: join(server.root, "settings.json") }); await s.submit("/init");
  const instruction = JSON.stringify(provider.requests[0].messages); assert.match(instruction, /at most five supporting text files and three/); assert.match(instruction, /If guides conflict/); assert.match(instruction, /already installed pdftotext/);
  assert.match(JSON.stringify(provider.requests[1].messages), /Audience: members/); assert.equal((await ws.call("read_file", { path: "MAQUETTE.md" })).content[0].text, "# Keep the designer's words");
});
