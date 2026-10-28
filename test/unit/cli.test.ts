// The config, models and ask commands, run as a person would, against one local server that
// plays both a running Maquette (GET /tools, POST /call) and an OpenAI-compatible model server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll, closedPort, json, mock, sse } from "./mock.ts";

after(closeAll);
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

function run(args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = mkdtempSync(join(tmpdir(), "maquette-cli-"));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  return runIn(cwd, home, args, env, input);
}

function runIn(cwd: string, home: string, args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MAQUETTE_|OPENAI_|ANTHROPIC_|DESIGNCRAFT_)/.test(k)));
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...clean, HOME: home, NO_COLOR: "1", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(input ?? "");
  return new Promise((done) => child.on("close", (code) => done({ code: code ?? -1, stdout, stderr })));
}

const word = (content: string) => ({ model: "qwen3:14b", choices: [{ index: 0, delta: { content }, finish_reason: null }] });

test("config sets, reads and removes keys, in the user's file or the project's", async () => {
  const base = mkdtempSync(join(tmpdir(), "maquette-cli-"));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const m = (...args: string[]) => runIn(cwd, home, args, {});
  assert.match((await m("config", "set", "model", "claude-sonnet-5-5")).stdout, /Set model to "claude-sonnet-5-5" in ~\/.maquette\/settings.json\./);
  assert.match((await m("config", "set", "providers.anthropic.effort", "medium", "--project")).stdout, /in .maquette\/settings.json\./);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".maquette", "settings.json"), "utf8")), { providers: { anthropic: { effort: "medium" } } });
  assert.equal((await m("config", "get", "model")).stdout, "claude-sonnet-5-5\n");
  const list = (await m("config")).stdout;
  assert.match(list, /model +claude-sonnet-5-5 +user ~\/.maquette\/settings.json/);
  assert.match(list, /providers.anthropic.effort +medium +project .maquette\/settings.json/);
  assert.match(list, /port +8787 +default/);
  const bad = await m("config", "set", "port", "eighty");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /port must be a number, not "eighty"/);
  assert.match((await m("config", "unset", "model")).stdout, /Removed model/);
  assert.match((await m("config")).stdout, /model +claude-opus-5-5 +anthropic's default/);
  writeFileSync(join(cwd, ".maquette", "settings.json"), '{"provider": "openai"}');
  const broken = await m("tools");
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /provider must be one of anthropic, openai-compatible, not "openai"/);
  assert.match((await m("config")).stderr, /not "openai" \(.*settings.json\)\. It's ignored until it's fixed\./);
  assert.match((await m("config", "set", "provider", "openai-compatible", "--project")).stdout, /Set provider to "openai-compatible"/);
  assert.equal((await m("tools", "--port", String(await closedPort()))).stderr.includes("provider must be"), false);
});

test("ask streams the model's answer, with Maquette's tools in its instructions", async () => {
  const server = await mock((s, res) => {
    if (s.url === "/tools") return json(res, 200, { root: "/work/report", instructions: "Use chart_create for charts.", tools: [{ name: "chart_create", description: "Draws a whole chart into a frame. More detail.", inputSchema: {} }] });
    if (s.url === "/v1/chat/completions") return sse(res, [word("Run:\n"), word("maquette call chart_create firstlight:slot:01 @spec.json"), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 812, completion_tokens: 19 } }, "[DONE]"]);
    json(res, 404, {});
  });
  const port = server.url.split(":").at(-1)!;
  const r = await run(["ask", "how", "do", "I", "add", "a", "chart?"], { MAQUETTE_PROVIDER: "openai-compatible", MAQUETTE_MODEL: "qwen3:14b", OPENAI_BASE_URL: `${server.url}/v1`, MAQUETTE_PORT: port });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Run:\nmaquette call chart_create firstlight:slot:01 @spec.json\n");
  assert.match(r.stderr, /qwen3:14b · 812 tokens in · 19 out/);
  const chat = server.seen.find((s) => s.url === "/v1/chat/completions")!;
  assert.equal(chat.body.model, "qwen3:14b");
  assert.equal(chat.body.tools, undefined);
  assert.match(chat.body.messages[0].content, /Maquette is running in \/work\/report/);
  assert.match(chat.body.messages[0].content, /chart_create +Draws a whole chart into a frame\./);
  assert.deepEqual(chat.body.messages[1], { role: "user", content: "how do I add a chart?" });
});

test("ask reads the message from stdin, shows the model an image, and fails on a refusal", async () => {
  const server = await mock((_, res) => sse(res, [word("No."), { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }, "[DONE]"]));
  const base = mkdtempSync(join(tmpdir(), "maquette-cli-"));
  mkdirSync(join(base, "home"));
  writeFileSync(join(base, "page.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  // A JPEG saved as .png, as image generators often do.
  writeFileSync(join(base, "cover.png"), Buffer.from("ffd8ffe000104a464946", "hex"));
  writeFileSync(join(base, "notes.png"), "not an image");
  const env = { MAQUETTE_PROVIDER: "openai-compatible", MAQUETTE_MODEL: "llava", OPENAI_BASE_URL: server.url, MAQUETTE_PORT: String(await closedPort()) };
  const r = await runIn(base, join(base, "home"), ["ask", "--image", "page.png", "-"], env, "What's on this page?\n");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /The model declined to answer\./);
  const [chat] = server.seen;
  assert.match(chat.body.messages[0].content, /Maquette isn't running now/);
  assert.deepEqual(chat.body.messages[1].content, [{ type: "text", text: "What's on this page?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }]);
  const missing = await runIn(base, join(base, "home"), ["ask", "--image", "nope.gif", "hi"], env);
  assert.match(missing.stderr, /--image nope.gif: there's no such file\./);
  const fake = await runIn(base, join(base, "home"), ["ask", "--image", "notes.png", "hi"], env);
  assert.match(fake.stderr, /--image notes.png: that isn't a PNG, JPEG, GIF or WebP image/);
  await runIn(base, join(base, "home"), ["ask", "--image", "cover.png", "hi"], env);
  assert.equal(server.seen.at(-1)!.body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,/9j/4AAQSkZJRg==");
});

test("models lists what the server offers and marks the one in use", async () => {
  const server = await mock((_, res) => json(res, 200, { data: [{ id: "llama3.1:8b" }, { id: "qwen3:14b" }] }));
  const r = await run(["models", "--provider", "openai-compatible", "--model", "qwen3:14b"], { OPENAI_BASE_URL: server.url });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 models from openai-compatible at http:\/\/127.0.0.1:\d+:/);
  assert.match(r.stdout, /^  llama3.1:8b$/m);
  assert.match(r.stdout, /^› qwen3:14b$/m);
});

test("call still passes --model and --provider through to the tool", async () => {
  const server = await mock((s, res) =>
    s.url === "/tools" ? json(res, 200, { root: "/r", instructions: "", tools: [{ name: "set_meta", inputSchema: { properties: { model: { type: "string" }, provider: { type: "string" } } } }] }) : json(res, 200, { id: 1, tool: "set_meta", ok: true, text: "done", images: [] }),
  );
  const r = await run(["call", "set_meta", "--model", "A4", "--provider", "press"], { MAQUETTE_PORT: server.url.split(":").at(-1)! });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(server.seen.at(-1)!.body, { tool: "set_meta", arguments: { model: "A4", provider: "press" } });
});

test("config edit creates the file, writes the defaults beside it, opens the editor and checks the result", async () => {
  const base = mkdtempSync(join(tmpdir(), "maquette-cli-"));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  // An "editor" that keeps a copy of what it was given, then writes new settings.
  const editor = join(base, "editor.sh");
  writeFileSync(editor, '#!/bin/sh\ncp "$1" "$1.before"\nprintf "%s" "$NEW_SETTINGS" > "$1"\n');
  chmodSync(editor, 0o755);
  const edit = (settings: string, ...args: string[]) => runIn(cwd, home, ["config", "edit", ...args], { EDITOR: editor, NEW_SETTINGS: settings });

  const first = await edit('{"model": "claude-sonnet-5-5"}');
  const user = join(home, ".maquette", "settings.json");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Created ~\/.maquette\/settings.json, empty, and opening it\./);
  assert.equal(readFileSync(`${user}.before`, "utf8"), "{}\n");
  assert.match(first.stdout, /✓ ~\/.maquette\/settings.json is valid\./);
  const reference = JSON.parse(readFileSync(join(home, ".maquette", "settings.defaults.json"), "utf8"));
  assert.equal(reference.model, "claude-opus-5-5");
  assert.equal(reference.providers.anthropic.effort, "high");
  assert.equal(reference.designcraft, undefined);
  assert.match((await runIn(cwd, home, ["config", "get", "model"], {})).stdout, /claude-sonnet-5-5/);

  const project = await edit('{"port": "eighty", "colour": "blue"}', "--project");
  assert.match(project.stdout, /Created .maquette\/settings.json/);
  assert.match(project.stdout, /port must be a whole number|port must be a number/);
  assert.match(project.stdout, /"colour"; it's ignored/);
  assert.ok(existsSync(join(cwd, ".maquette", "settings.json")));

  const again = await edit('{"model": "claude-haiku-5-5"}');
  assert.match(again.stdout, /^Opening ~\/.maquette\/settings.json\./);
  assert.equal(readFileSync(`${user}.before`, "utf8"), '{"model": "claude-sonnet-5-5"}');
});

// Starts the server alone with the stub engine and gives back what it printed by the time the
// list under the title is done, then stops it.
async function startLines(env: Record<string, string>): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "maquette-trace-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MAQUETTE_|OPENAI_|ANTHROPIC_|DESIGNCRAFT_)/.test(k)));
  const engine = fileURLToPath(new URL("../stub-engine.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "--port", String(await closedPort())], { cwd, env: { ...clean, HOME: cwd, NO_COLOR: "1", MAQUETTE_ENGINE: engine, ...env } });
  child.stdin.end();
  let out = "";
  await new Promise<void>((done) => {
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("From another terminal")) done();
    });
    child.on("close", () => done());
  });
  child.kill();
  return out;
}

test("MAQUETTE_TRACE=0, false or off leaves tracing off; a URL turns it on and says where", async () => {
  for (const value of ["0", "false", "off"]) assert.ok(!(await startLines({ MAQUETTE_TRACE: value })).includes("Tracing"), `MAQUETTE_TRACE=${value}`);
  const port = await closedPort();
  assert.match(await startLines({ MAQUETTE_TRACE: `http://127.0.0.1:${port}` }), new RegExp(`✓ Tracing to http://127\\.0\\.0\\.1:${port}, project maquette`));
});
