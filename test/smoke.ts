// `npm run smoke`: the whole prompt end to end, in one process. The real server runs the stub
// engine, the fake provider plays the model, and the Ink screen is driven through
// ink-testing-library as a person would type. No key, no network, no DesignCraft.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { AgentSession } from "../src/agent/session.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { startServer } from "../src/server.ts";
import { App } from "../src/ui/app.ts";
import { h } from "../src/ui/h.ts";
import { settings } from "./unit/fake-server.ts";
import { closedPort } from "./unit/mock.ts";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(join(tmpdir(), "maquette-smoke-"));
mkdirSync(join(root, "example"));
const port = await closedPort();
const server = await startServer({ port, version: "smoke", root, engine: fileURLToPath(new URL("./stub-engine.ts", import.meta.url)) });

const spec = { data: { url: "example/data/01-revenue.csv" }, mark: "bar" };
const provider = new FakeProvider([
  { text: "I'll open the report, draw the chart and render the page.\n", calls: [{ name: "open_document", input: { path: "example/annual-report.designcraft" } }] },
  { calls: [{ name: "chart_create", input: { frame: "firstlight:slot:01", spec } }] },
  { calls: [{ name: "render_page", input: { page: 0 } }] },
  { text: "Done. The revenue chart sits in the first slot, and page one is rendered at `maquette-renders/…/003-render_page.png`." },
]);
const session = new AgentSession({ server, provider, settings: settings(), projectFile: join(root, ".maquette", "settings.json") });
const screen = render(h(App, { session, server, info: { version: "smoke", engineName: "Stub engine", toolCount: server.tools.length, port, images: "maquette-renders/smoke" }, onExit: () => {} }));
const type = async (s: string) => {
  for (const ch of s) screen.stdin.write(ch);
  await tick();
};
const until = async (re: RegExp, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (re.test(strip(screen.lastFrame()))) return;
    await tick(50);
  }
  throw new Error(`Never saw ${what}. Last frame:\n${strip(screen.lastFrame())}`);
};

const failures: string[] = [];
const expect = (re: RegExp, what: string) => {
  if (!re.test(strip(screen.lastFrame()))) failures.push(`${what}: not in the screen`);
};

try {
  await until(/\? for shortcuts/, "the footer");
  await type("open the example report and put the revenue chart in the first slot, then show me page one");
  screen.stdin.write("\r");
  await until(/Allow open_document/, "the permission prompt for open_document");
  screen.stdin.write("y");
  await until(/Allow chart_create/, "the permission prompt for chart_create");
  screen.stdin.write("a");
  await until(/Done\. The revenue chart/, "the final answer");
  await tick(100);
  // The screen as it was drawn, colours and all.
  console.log(screen.lastFrame());
  expect(/✓ open_document --path example\/annual-report\.designcraft/, "the open_document line");
  expect(/✓ chart_create --frame firstlight:slot:01 --spec \{[^]*?· \d+ ms ·\s+\S*002-chart_create\.png/, "the chart_create line with its render");
  expect(/✓ render_page --page 0 · \d+ ms · \S*003-render_page\.png/, "the render_page line");
  expect(/fake · ask · 0 in \/ 0 out/, "the footer's model and mode");
  // A call from another terminal lands in the transcript marked http while the box stays put.
  const r = await (await fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "render_page", arguments: { page: 1 } }) })).json();
  if (!r.ok) failures.push("the http call failed");
  await until(/✓ http render_page --page 1/, "the http call's line");
  await type("!ls");
  screen.stdin.write("\r");
  await until(/! ls\n\s+example/, "the shell listing");
  await type("/cost");
  screen.stdin.write("\r");
  await until(/4 turns with the model/, "/cost");
  await type("exit");
  screen.stdin.write("\r");
  await tick(100);
} catch (e) {
  failures.push((e as Error).message);
}
screen.unmount();
await server.stop();
console.log(failures.length ? `\nSmoke test failed:\n  ${failures.join("\n  ")}` : `\nSmoke test passed: ${server.tools.length} tools, ${provider.requests.length} model turns, 4 calls through the queue.`);
process.exit(failures.length ? 1 : 0);
