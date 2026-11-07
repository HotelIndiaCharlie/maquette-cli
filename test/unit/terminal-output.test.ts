// Exercise Ink's interactive writer. ink-testing-library uses debug mode, which
// deliberately appends the full frame and cannot detect scrollback duplication.
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink";
import xterm from "@xterm/headless";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { App } from "../../src/ui/app.ts";
import { h } from "../../src/ui/h.ts";
import { repairResize } from "../../src/ui/resize.ts";
import { fakeServer, settings } from "./fake-server.ts";

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
class TerminalOutput extends Writable {
  isTTY = true;
  columns = 110;
  rows = 24;
  chunks: string[] = [];
  screen = new xterm.Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true, convertEol: true, scrollback: 5000 });
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.chunks.push(chunk.toString()); this.screen.write(chunk.toString(), done); }
  text() { return this.chunks.join(""); }
  lines() { const buffer = this.screen.buffer.active; return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)); }
  resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.screen.resize(columns, rows); this.emit("resize"); }
}
test("resizing a completed long answer never reprints it into terminal scrollback", async () => {
  const stdout = new TerminalOutput();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const server = fakeServer();
  const marker = "SavedAnswerMarker";
  const answer = `${marker}\n\n${Array.from({ length: 80 }, (_, i) => `Survey line ${i}: styles, fonts and chart slots in the report.`).join("\n")}`;
  const session = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: answer }]), projectFile: join(server.root, "settings.json") });
  const ui = render(h(App, { session, server, info: { version: "test", engineName: "Stub", toolCount: 5, port: 8787, images: "renders" }, onExit() {} }), { stdout, stdin, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const removeResizeRepair = await repairResize(stdout as unknown as NodeJS.WriteStream);
  try {
    await tick(); await session.submit("survey this document"); await tick();
    const occurrences = () => stdout.text().split(marker).length - 1;
    assert.equal(occurrences(), 1, "completed answer printed once");
    const before = stdout.text().length;
    for (const [columns, rows] of [[44, 12], [110, 40], [44, 8], [110, 24], [110, 24]]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, rows); await ui.waitUntilRenderFlush();
    }
    assert.equal(occurrences(), 1, "resize must not append another copy of saved output");
    const redraws = stdout.text().slice(before);
    assert.doesNotMatch(redraws, /\x1b\[(?:2|3)J/, "resize must not clear saved output or scrollback");
    assert.equal(session.busy, false);
    stdin.write("/cost"); await tick(); stdin.write("\r"); await tick();
    assert.match(stdout.text().slice(before), /\/cost/, "input still works after resizes");
    assert.equal(occurrences(), 1);
  } finally { removeResizeRepair(); ui.unmount(); ui.cleanup(); session.close(); stdin.destroy(); stdout.destroy(); stdout.screen.dispose(); }
});
test("narrowing the terminal does not leave old prompt bars in the screen or scrollback", async () => {
  const stdout = new TerminalOutput();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const server = fakeServer();
  const answer = Array.from({ length: 80 }, (_, i) => `Report line ${i}: layout and chart slots.`).join("\n");
  const session = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: answer }]), projectFile: join(server.root, "settings.json") });
  const ui = render(h(App, { session, server, info: { version: "test", engineName: "Stub", toolCount: 5, port: 8787, images: "renders" }, onExit() {} }), { stdout, stdin, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const removeResizeRepair = await repairResize(stdout as unknown as NodeJS.WriteStream);
  try {
    await tick(); await session.submit("survey the report"); await tick();
    const prompts = () => stdout.lines().filter(line => /^❯\s*$/.test(line));
    assert.equal(prompts().length, 1);
    for (const columns of [109, 108, 106, 100, 80, 44, 110, 90]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, 24); await ui.waitUntilRenderFlush();
      assert.equal(prompts().length, 1, `exactly one prompt after resize to ${columns} columns`);
      assert.equal(stdout.lines().filter(line => /^─+$/.test(line)).length, 2, "only the current prompt's two borders remain");
      assert.equal(stdout.lines().filter(line => line.includes("Report line 79")).length, 1, "the last saved line remains intact");
    }
    stdin.write("DraftToken 漢字 漢字 working on a report with extra words"); await tick();
    for (const columns of [44, 70, 110]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, 24); await ui.waitUntilRenderFlush();
      assert.equal(stdout.lines().filter(line => line.includes("DraftToken")).length, 1, `draft visible once at ${columns} columns`);
      assert.equal(stdout.lines().filter(line => line.includes("Report line 79")).length, 1, "saved output remains intact while editing");
    }
    stdin.write("\x15"); await tick();
    assert.equal(stdout.lines().filter(line => line.includes("DraftToken")).length, 0, "cleared draft leaves no ghost in scrollback");
    assert.equal(prompts().length, 1);
  } finally { removeResizeRepair(); ui.unmount(); ui.cleanup(); session.close(); stdin.destroy(); stdout.destroy(); stdout.screen.dispose(); }
});
