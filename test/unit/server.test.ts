// `maquette` itself, without a terminal, on the stub engine: it serves HTTP, prints the plain
// log lines, and never loads Ink.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closedPort } from "./mock.ts";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const engine = fileURLToPath(new URL("../stub-engine.ts", import.meta.url));
const hook = fileURLToPath(new URL("./no-ink-hook.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill("SIGKILL")));

async function start(extra: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), "maquette-serve-"));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const port = await closedPort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MAQUETTE_|OPENAI_|ANTHROPIC_|DESIGNCRAFT_)/.test(k)));
  const child = spawn(process.execPath, [...extra, cli], { cwd, env: { ...clean, HOME: home, NO_COLOR: "1", MAQUETTE_ENGINE: engine, MAQUETTE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((done) => child.on("close", done));
  for (let i = 0; i < 200 && !/Listening on/.test(stdout) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  return { child, port, cwd, out: () => stdout, err: () => stderr, exited };
}

test("without a terminal, maquette serves calls, prints plain log lines and doesn't load Ink", async () => {
  const m = await start(["--import", hook]);
  assert.match(m.out(), /8 tools\)/, m.err());
  assert.match(m.out(), /From another terminal/);
  const tools = await (await fetch(`http://127.0.0.1:${m.port}/tools`)).json();
  // macOS reports the temp folder through its /private symlink.
  assert.equal(realpathSync(tools.root), realpathSync(m.cwd));
  assert.ok(tools.tools.some((t: { name: string }) => t.name === "render_page"));
  const r = await (await fetch(`http://127.0.0.1:${m.port}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "render_page", arguments: { page: 1 } }) })).json();
  assert.equal(r.ok, true);
  assert.equal(r.source, "http");
  assert.match(r.images[0], /001-render_page\.png$/);
  const bad = await fetch(`http://127.0.0.1:${m.port}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "nope" }) });
  assert.equal(bad.status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(m.out(), /#1 {2}http {2}render_page {2}\{"page":1\} {2}ok {2}\d+ ms {2}maquette-renders\/\S+\/001-render_page\.png/);
  assert.doesNotMatch(m.out(), /\x1b\[/, "no escape codes with NO_COLOR and no screen");
  m.child.kill("SIGTERM");
  assert.equal(await m.exited, 0);
  assert.match(m.out(), /Stopping DesignCraft/);
  assert.doesNotMatch(m.err(), /Ink was loaded/);
});

test("a second maquette on the same port says so and exits", async () => {
  const first = await start();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MAQUETTE_|OPENAI_|ANTHROPIC_|DESIGNCRAFT_)/.test(k)));
  const second = spawn(process.execPath, [cli], { cwd: first.cwd, env: { ...clean, HOME: tmpdir(), NO_COLOR: "1", MAQUETTE_ENGINE: engine, MAQUETTE_PORT: String(first.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  second.stderr.on("data", (d) => (err += d));
  const code = await new Promise((done) => second.on("close", done));
  assert.equal(code, 1);
  assert.match(err, /already running on port/);
  first.child.kill("SIGTERM");
  await first.exited;
});
