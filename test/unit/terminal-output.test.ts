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
function assertPromptPlacement(stdout: TerminalOutput, lastAnswer: string) {
  const lines = stdout.lines();
  let answerRow = lines.findLastIndex(line => line.includes(lastAnswer));
  assert.ok(answerRow >= 0, "last answer remains in the buffer");
  // A saved answer may itself wrap at narrow widths. Measure from its final
  // physical row, rather than the row containing its identifying prefix.
  while (stdout.screen.buffer.active.getLine(answerRow + 1)?.isWrapped) answerRow++;
  const borderRow = lines.findIndex(line => /^─+$/.test(line));
  assert.equal(borderRow - answerRow, 1, "prompt border immediately follows the answer");
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
    await tick(); await ui.waitUntilRenderFlush(); await session.submit("survey this document"); await ui.waitUntilRenderFlush();
    const occurrences = () => stdout.text().split(marker).length - 1;
    assert.equal(occurrences(), 1, "completed answer printed once");
    const before = stdout.text().length;
    for (const [columns, rows] of [[44, 12], [110, 40], [44, 8], [110, 24], [110, 24]]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, rows); await ui.waitUntilRenderFlush();
      assertPromptPlacement(stdout, "Survey line 79");
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
    await tick(); await ui.waitUntilRenderFlush(); await session.submit("survey the report"); await ui.waitUntilRenderFlush();
    const prompts = () => stdout.lines().filter(line => /^❯\s*$/.test(line));
    assert.equal(prompts().length, 1);
    assertPromptPlacement(stdout, "Report line 79");
    await ui.waitUntilRenderFlush(); stdout.resize(99, 70); await ui.waitUntilRenderFlush();
    assertPromptPlacement(stdout, "Report line 79");
    for (const columns of [109, 108, 106, 100, 80, 44, 110, 90]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, 24); await ui.waitUntilRenderFlush();
      assert.equal(prompts().length, 1, `exactly one prompt after resize to ${columns} columns`);
      assert.equal(stdout.lines().filter(line => /^─+$/.test(line)).length, 2, "only the current prompt's two borders remain");
      assert.equal(stdout.lines().filter(line => line.includes("Report line 79")).length, 1, "the last saved line remains intact");
      assertPromptPlacement(stdout, "Report line 79");
    }
    stdin.write("DraftToken 漢字 漢字 working on a report with extra words\nsecond draft line 漢字"); await tick();
    for (const [columns, rows] of [[44, 24], [70, 24], [110, 24], [99, 70], [20, 70], [110, 24], [44, 12], [99, 70], [99, 70]]) {
      await ui.waitUntilRenderFlush(); stdout.resize(columns, rows); await ui.waitUntilRenderFlush();
      assert.equal(stdout.lines().filter(line => line.includes("DraftToken")).length, 1, `draft visible once at ${columns} columns`);
      assert.equal(stdout.lines().filter(line => line.includes("Report line 79")).length, 1, "saved output remains intact while editing");
      assertPromptPlacement(stdout, "Report line 79");
    }
    stdin.write("\x15"); await tick();
    assert.equal(stdout.lines().filter(line => line.includes("DraftToken")).length, 0, "cleared draft leaves no ghost in scrollback");
    assert.equal(prompts().length, 1);
    assertPromptPlacement(stdout, "Report line 79");
  } finally { removeResizeRepair(); ui.unmount(); ui.cleanup(); session.close(); stdin.destroy(); stdout.destroy(); stdout.screen.dispose(); }
});
test("a short conversation starts and stays next to its prompt in a tall terminal", async () => {
  const stdout = new TerminalOutput();
  stdout.resize(99, 70);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const server = fakeServer();
  const session = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: "FirstShortAnswer" }, { text: "SecondShortAnswer" }]), projectFile: join(server.root, "settings.json") });
  const ui = render(h(App, { session, server, info: { version: "test", engineName: "Stub", toolCount: 5, port: 8787, images: "renders" }, onExit() {} }), { stdout, stdin, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const removeResizeRepair = await repairResize(stdout as unknown as NodeJS.WriteStream);
  try {
    await tick(); await ui.waitUntilRenderFlush();
    await session.submit("first question"); await ui.waitUntilRenderFlush();
    assertPromptPlacement(stdout, "FirstShortAnswer");
    for (const [columns, rows] of [[44, 12], [99, 70], [110, 24], [99, 70], [99, 12], [99, 70]]) {
      stdout.resize(columns, rows); await ui.waitUntilRenderFlush();
      assertPromptPlacement(stdout, "FirstShortAnswer");
      assert.equal(stdout.lines().filter(line => /^─+$/.test(line)).length, 2);
    }
    await session.submit("second question"); await ui.waitUntilRenderFlush();
    assertPromptPlacement(stdout, "SecondShortAnswer");
    for (const answer of ["FirstShortAnswer", "SecondShortAnswer"]) {
      assert.equal(stdout.text().split(answer).length - 1, 1, "saved answers are written once");
      assert.equal(stdout.lines().filter(line => line.includes(answer)).length, 1, "saved answers survive all resizes and subsequent output");
    }
    assert.equal(stdout.lines().filter(line => /^❯\s*$/.test(line)).length, 1);
  } finally { removeResizeRepair(); ui.unmount(); ui.cleanup(); session.close(); stdin.destroy(); stdout.destroy(); stdout.screen.dispose(); }
});

test("an unavailable Ink renderer disables only the optional repair", async () => {
  const { optionalResizeRepair } = await import("../../src/ui/resize.ts");
  const stdout = new TerminalOutput(); const warnings: string[] = [];
  try {
    const remove = await optionalResizeRepair(stdout as unknown as NodeJS.WriteStream, message => warnings.push(message));
    assert.match(warnings[0], /Resize repair disabled/); assert.doesNotThrow(remove);
    stdout.write("The terminal still works"); await tick(); assert.match(stdout.text(), /terminal still works/);
  } finally { stdout.destroy(); stdout.screen.dispose(); }
});
