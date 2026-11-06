// The workspace tool module: files, shell and images in the folder Maquette runs in, and
// nothing outside it. Real files in a temp folder; no engine, no key.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classify } from "../../src/agent/permissions.ts";
import type { DesignCraft, ToolResult } from "../../src/designcraft.ts";
import workspace, { globRegex } from "../../src/tools/workspace/index.ts";
import { png } from "./fake-server.ts";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "maquette-workspace-")));
const textOf = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";

// A project folder with data files, and a folder beside it the tools must not reach.
function project() {
  const top = temp();
  const root = join(top, "project");
  const away = join(top, "away");
  mkdirSync(join(root, "example", "data"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(away);
  writeFileSync(join(root, "example", "data", "01-revenue.csv"), "year,revenue\n2024,10\n2025,12\n");
  writeFileSync(join(root, "example", "data", "02-margin.csv"), "year,margin\n2024,0.2\n");
  writeFileSync(join(root, "example", "spec.json"), '{"mark": "bar"}\n');
  writeFileSync(join(root, "node_modules", "x", "a.csv"), "skip me\n");
  writeFileSync(join(away, "secret.txt"), "the secret\n");
  symlinkSync(join(away, "secret.txt"), join(root, "link.txt"));
  symlinkSync(away, join(root, "away-dir"));
  symlinkSync(join(away, "missing.txt"), join(root, "dangling.txt"));
  const m = workspace({ dc: {} as DesignCraft, root, readRoots: [root], warnings: () => [] });
  return { root, away, m, call: (name: string, args: Record<string, unknown>) => m.call(name, args) };
}

test("every file tool refuses a path outside the folder: absolute, ../, ~, and through a symlink", async () => {
  const { away, call } = project();
  const outside = ["/etc/hosts", "../away/secret.txt", join(away, "secret.txt"), "~/x.txt", "link.txt", "away-dir/secret.txt", "dangling.txt", "away-dir/new.txt"];
  for (const path of outside) {
    for (const [tool, args] of [
      ["read_file", { path }],
      ["write_file", { path, text: "x" }],
      ["edit_file", { path, search: "secret", replace: "x" }],
      ["grep", { pattern: "secret", path }],
      ["open_file", { path }],
    ] as const) {
      const r = await call(tool, args);
      assert.equal(r.isError, true, `${tool} ${path}`);
      assert.match(textOf(r), /outside .*only work inside the folder/, `${tool} ${path}`);
    }
  }
  for (const pattern of ["../away/*", "/etc/*", "away-dir/*"]) {
    const r = await call("glob", { pattern });
    assert.ok(r.isError || !/secret/.test(textOf(r)), `glob ${pattern}`);
  }
  assert.equal(readFileSync(join(away, "secret.txt"), "utf8"), "the secret\n");
  // A directory search never follows a symlink out either.
  assert.doesNotMatch(textOf(await call("grep", { pattern: "secret" })), /the secret/);
});

test("read_file, write_file and glob work inside the folder, and write_file makes the folders it needs", async () => {
  const { root, call } = project();
  assert.equal(textOf(await call("read_file", { path: "example/data/01-revenue.csv" })), "year,revenue\n2024,10\n2025,12");
  assert.equal(textOf(await call("read_file", { path: "example/data/01-revenue.csv", offset: 2, limit: 1 })), "2024,10\n… 1 more lines; read on with offset 3.");
  const w = await call("write_file", { path: "out/notes/a.md", text: "# A\n" });
  assert.equal(w.isError, undefined);
  assert.equal(readFileSync(join(root, "out", "notes", "a.md"), "utf8"), "# A\n");
  assert.equal(textOf(await call("glob", { pattern: "example/data/*.csv" })), "example/data/01-revenue.csv\nexample/data/02-margin.csv");
  assert.equal(textOf(await call("glob", { pattern: "**/*.csv" })), "example/data/01-revenue.csv\nexample/data/02-margin.csv");
  assert.equal(textOf(await call("glob", { pattern: "example/**/*.{json,md}" })), "example/spec.json");
  assert.match(textOf(await call("read_file", { path: "nope.txt" })), /no such file/);
});

test("grep gives path:line: text, filtered by a glob", async () => {
  const { call } = project();
  assert.equal(textOf(await call("grep", { pattern: "^2024" })), "example/data/01-revenue.csv:2: 2024,10\nexample/data/02-margin.csv:2: 2024,0.2");
  assert.equal(textOf(await call("grep", { pattern: "MARK", ignore_case: true, glob: "*.json" })), 'example/spec.json:1: {"mark": "bar"}');
  assert.equal(textOf(await call("grep", { pattern: "2025", path: "example/data/01-revenue.csv" })), "example/data/01-revenue.csv:3: 2025,12");
  assert.equal((await call("grep", { pattern: "(" })).isError, true);
});

test("edit_file replaces a search string that matches once, and refuses none or several", async () => {
  const { root, call } = project();
  const file = join(root, "example", "data", "01-revenue.csv");
  const none = await call("edit_file", { path: "example/data/01-revenue.csv", search: "2030", replace: "x" });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /isn't in/);
  const many = await call("edit_file", { path: "example/data/01-revenue.csv", search: "20", replace: "x" });
  assert.equal(many.isError, true);
  assert.match(textOf(many), /matches 2 times/);
  assert.equal(readFileSync(file, "utf8"), "year,revenue\n2024,10\n2025,12\n");
  const one = await call("edit_file", { path: "example/data/01-revenue.csv", search: "2025,12", replace: "2025,13" });
  assert.equal(textOf(one), "Edited example/data/01-revenue.csv at line 3.");
  assert.equal(readFileSync(file, "utf8"), "year,revenue\n2024,10\n2025,13\n");
});

test("bash runs in the folder, gives the exit code, stops at its timeout and caps its output", async () => {
  const { call } = project();
  const ls = await call("bash", { command: "ls example/data" });
  assert.equal(textOf(ls), "01-revenue.csv\n02-margin.csv\n(exit code 0)");
  const bad = await call("bash", { command: "echo oops >&2; exit 3" });
  assert.equal(bad.isError, true);
  assert.equal(textOf(bad), "oops\n(exit code 3)");
  const t0 = Date.now();
  const slow = await call("bash", { command: "echo started; sleep 30", timeout: 1 });
  assert.ok(Date.now() - t0 < 5000, "stopped well before the sleep ended");
  assert.equal(slow.isError, true);
  assert.equal(textOf(slow), "started\nStopped after 1 s.");
  const long = textOf(await call("bash", { command: "yes x | head -c 100000" }));
  assert.ok(long.length < 31_000);
  assert.match(long, /… \d+ more characters left out\n\(exit code 0\)$/);
});

test("view_image sends the real type of a JPEG named .png, and refuses what isn't an image", async () => {
  const { root, call } = project();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  writeFileSync(join(root, "photo.png"), jpeg);
  const r = await call("view_image", { path: "photo.png" });
  const image = r.content.find((c) => c.type === "image")!;
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, jpeg.toString("base64"));
  writeFileSync(join(root, "real.png"), Buffer.from(png, "base64"));
  assert.equal((await call("view_image", { path: "real.png" })).content[0].mimeType, "image/png");
  const csv = await call("view_image", { path: "example/data/01-revenue.csv" });
  assert.equal(csv.isError, true);
  assert.match(textOf(csv), /isn't a PNG, JPEG, GIF or WebP/);
  assert.match(textOf(await call("read_file", { path: "real.png" })), /isn't a text file\. It's an image: view_image/);
});

test("reads, glob, grep and view_image run without asking; writes, edits, bash and open_file are changes", () => {
  const { m } = project();
  const kinds = Object.fromEntries(m.tools.map((t) => [t.name, classify(t)]));
  assert.deepEqual(kinds, { bash: "change", read_file: "read", write_file: "change", edit_file: "change", glob: "read", grep: "read", view_image: "read", open_file: "change" });
});

test("globRegex: ** crosses folders, * and ? don't, {a,b} is either", () => {
  assert.ok(globRegex("**/*.csv").test("a.csv"));
  assert.ok(globRegex("**/*.csv").test("a/b/c.csv"));
  assert.ok(!globRegex("*.csv").test("a/b.csv"));
  assert.ok(globRegex("data/0?-*.{csv,json}").test("data/01-x.json"));
  assert.ok(!globRegex("data/0?-*.{csv,json}").test("data/01-x.txt"));
  assert.ok(globRegex("a.b").test("a.b") && !globRegex("a.b").test("axb"));
});
