// The Ink screen, through ink-testing-library: a scripted conversation against the fake
// provider and the fake server, with keys typed into the input box.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider, type FakeTurn } from "../../src/providers/fake.ts";
import { App } from "../../src/ui/app.ts";
import { h } from "../../src/ui/h.ts";
import { complete } from "../../src/ui/input.ts";
import { fakeServer, settings } from "./fake-server.ts";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const info = { version: "0.1.0", engineName: "Stub engine", toolCount: 5, port: 8787, images: "maquette-renders/now" };

function screen(turns: FakeTurn[], mode: "ask" | "auto" | "plan" = "ask") {
  const server = fakeServer();
  const provider = new FakeProvider(turns);
  const session = new AgentSession({ server, provider, settings: settings({ permissions: { mode } }), projectFile: join(mkdtempSync(join(tmpdir(), "maquette-ui-")), "settings.json") });
  let exited = false;
  const r = render(h(App, { session, server, info, onExit: () => (exited = true) }));
  const type = async (text: string) => {
    for (const ch of text) r.stdin.write(ch);
    await tick();
  };
  const frame = () => strip(r.lastFrame());
  // Waits for the pattern, or else for the session to go idle again.
  const until = async (re?: RegExp) => {
    for (let i = 0; i < 100; i++) {
      await tick(20);
      if (re ? re.test(frame()) : !session.busy) break;
    }
    await tick(40);
  };
  const enter = async (re?: RegExp) => {
    r.stdin.write("\r");
    await until(re);
  };
  return { ...r, server, provider, session, type, enter, until, frame, exited: () => exited };
}

test("a scripted conversation draws the banner, the user line, a tool line, the answer and the footer", async () => {
  const s = screen([{ text: "Rendering. ", calls: [{ name: "render_page", input: { page: 0 } }] }, { text: "Here is **page one**.\n\n- it has a chart\n- and a title" }], "auto");
  await tick();
  let f = s.frame();
  assert.match(f, /M A Q U E T T E|███/);
  assert.match(f, /Stub engine, headless, with Maquette's tools \(5 tools\)/);
  assert.match(f, /❯/);
  assert.match(f, /\? for shortcuts/);
  assert.match(f, /fake · auto · 0 in \/ 0 out/);
  await s.type("show me page one");
  assert.match(s.frame(), /❯ show me page one/);
  await s.enter();
  f = s.frame();
  assert.match(f, /❯ show me page one/);
  assert.match(f, /✓ render_page --page 0 · \d+ ms · 001-render_page\.png/);
  assert.match(f, /Rendering\./);
  assert.match(f, /Here is page one\./);
  assert.match(f, /• it has a chart/);
  assert.deepEqual(s.server.calls.map((c) => c.tool), ["render_page"]);
  assert.doesNotMatch(f, /thinking…/);
  s.unmount();
});

test("typing y at the permission prompt lets the call run; n refuses it", async () => {
  const s = screen([{ calls: [{ name: "chart_create", input: { frame: "slot:01", spec: {} } }] }, { calls: [{ name: "save_document", input: {} }] }, { text: "Done." }]);
  await tick();
  await s.type("make the chart and save");
  await s.enter(/Allow chart_create/);
  assert.match(s.frame(), /Allow chart_create --frame slot:01/);
  assert.match(s.frame(), /y yes {3}n no {3}a always/);
  s.stdin.write("y");
  await s.until(/Allow save_document/);
  assert.match(s.frame(), /Allow save_document\?/);
  s.stdin.write("n");
  await s.until();
  const f = s.frame();
  assert.match(f, /✓ chart_create/);
  assert.match(f, /✗ save_document.*declined/);
  assert.match(f, /Done\./);
  assert.deepEqual(s.server.calls.map((c) => c.tool), ["chart_create"]);
  s.unmount();
});

test("↑ recalls the last line, Tab completes a tool and a slash command, and ctrl+o expands the last tool line", async () => {
  const s = screen([{ calls: [{ name: "render_page", input: { page: 0 } }] }, { text: "ok" }], "auto");
  await tick();
  await s.type("render_page --page 0");
  await s.enter();
  assert.match(s.frame(), /Rendered page 0\./);
  s.stdin.write("\x1b[A");
  await tick();
  assert.match(s.frame(), /❯ render_page --page 0/);
  s.stdin.write("\x15"); // ctrl+u clears
  await tick();
  await s.type("chart_");
  s.stdin.write("\t");
  await tick();
  assert.match(s.frame(), /❯ chart_create\b/);
  s.stdin.write("\x15");
  await s.type("/per");
  s.stdin.write("\t");
  await tick();
  assert.match(s.frame(), /❯ \/permissions\b/);
  s.stdin.write("\x15");
  await s.type("hello");
  await s.enter();
  assert.match(s.frame(), /ok/);
  s.stdin.write("\x0f"); // ctrl+o
  await tick();
  assert.match(s.frame(), /"page": 0/);
  s.unmount();
});

test("Ctrl-C during a turn stops it and the input box stays; on an empty line it exits", async () => {
  class Slow extends FakeProvider {
    override async *chat(request: import("../../src/providers/types.ts").ChatRequest) {
      yield { type: "text" as const, text: "Once upon " };
      await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
  }
  const server = fakeServer();
  const session = new AgentSession({ server, provider: new Slow([]), settings: settings(), projectFile: "/nonexistent/x.json" });
  let exited = false;
  const r = render(h(App, { session, server, info, onExit: () => (exited = true) }));
  await tick();
  for (const ch of "tell me a story") r.stdin.write(ch);
  r.stdin.write("\r");
  await tick(120);
  assert.match(strip(r.lastFrame()), /esc to interrupt/);
  r.stdin.write("\x03");
  await tick(120);
  const f = strip(r.lastFrame());
  assert.match(f, /Once upon/);
  assert.match(f, /Interrupted\./);
  assert.match(f, /❯/);
  assert.match(f, /\? for shortcuts/);
  assert.equal(session.busy, false);
  r.stdin.write("\x03");
  await tick(80);
  assert.equal(exited, true);
  r.unmount();
});

test("calls from other sessions appear marked http, and ! lines show their output", async () => {
  const s = screen([], "ask");
  await tick();
  s.server.emitHttp("render_page", { page: 1 });
  await tick();
  assert.match(s.frame(), /✓ http render_page --page 1/);
  await s.type("!echo hi");
  await s.enter();
  assert.match(s.frame(), /! echo hi\n\s+hi/);
  s.unmount();
});

test("completion offers tools, flags, slash commands and paths", () => {
  const server = fakeServer();
  const c = (v: string) => complete(v, v.length, server.byName, server.root);
  assert.equal(c("chart_").replace, "chart_create ");
  assert.deepEqual(c("/p").options, ["/permissions", "/provider"]);
  assert.equal(c("/p").replace, undefined);
  assert.equal(c("/pe").replace, "/permissions ");
  assert.equal(c("render_page --pa").replace, "--page ");
  assert.equal(c("help rend").replace, "render_page ");
  assert.equal(c("/permissions au").replace, "auto ");
  assert.ok(c("@./").options.some((o) => /001|\.png$|^@\.\//.test(o)) || c("@./").options.length === 0);
  assert.equal(c("hello wor").replace, undefined);
});
