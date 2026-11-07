// Exercise Ink's interactive writer. ink-testing-library uses debug mode, which
// deliberately appends the full frame and cannot detect scrollback duplication.
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "ink";
import { AgentSession } from "../../src/agent/session.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { App } from "../../src/ui/app.ts";
import { h } from "../../src/ui/h.ts";
import { fakeServer, settings } from "./fake-server.ts";

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
class TerminalOutput extends Writable {
  isTTY = true;
  columns = 110;
  rows = 24;
  chunks: string[] = [];
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.chunks.push(chunk.toString()); done(); }
  text() { return this.chunks.join(""); }
}
test("resizing a completed long answer never reprints it into terminal scrollback", async () => {
  const stdout = new TerminalOutput();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const server = fakeServer();
  const marker = "SavedAnswerMarker";
  const answer = `${marker}\n\n${Array.from({ length: 80 }, (_, i) => `Survey line ${i}: styles, fonts and chart slots in the report.`).join("\n")}`;
  const session = new AgentSession({ server, settings: settings(), provider: new FakeProvider([{ text: answer }]), projectFile: join(server.root, "settings.json") });
  const ui = render(h(App, { session, server, info: { version: "test", engineName: "Stub", toolCount: 5, port: 8787, images: "renders" }, onExit() {} }), { stdout, stdin, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  try {
    await tick(); await session.submit("survey this document"); await tick();
    const occurrences = () => stdout.text().split(marker).length - 1;
    assert.equal(occurrences(), 1, "completed answer printed once");
    const before = stdout.text().length;
    for (const [columns, rows] of [[44, 12], [110, 40], [44, 8], [110, 24], [110, 24]]) {
      stdout.columns = columns; stdout.rows = rows; stdout.emit("resize"); await tick();
    }
    assert.equal(occurrences(), 1, "resize must not append another copy of saved output");
    const redraws = stdout.text().slice(before);
    assert.doesNotMatch(redraws, /\x1b\[(?:2|3)J/, "resize must not clear saved output or scrollback");
    assert.equal(session.busy, false);
    stdin.write("/cost"); await tick(); stdin.write("\r"); await tick();
    assert.match(stdout.text().slice(before), /\/cost/, "input still works after resizes");
    assert.equal(occurrences(), 1);
  } finally { ui.unmount(); ui.cleanup(); session.close(); stdin.destroy(); stdout.destroy(); }
});
