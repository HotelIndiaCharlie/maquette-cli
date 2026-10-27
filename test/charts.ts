// Draws the five example charts through the engine, as an agent would, checks each drawing,
// saves the document, reopens it and redraws two charts with their updated data. Needs the
// DesignCraft CLI (maquette install-designcraft, or DESIGNCRAFT_CLI). Leaves the document
// and the renders in a temporary folder.
//
//   npm test
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolResult } from "../src/designcraft.ts";
import { findDesignCraft } from "../src/install.ts";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = findDesignCraft();
if (!cli) throw new Error("The DesignCraft CLI isn't installed; run `maquette install-designcraft` first.");
const root = mkdtempSync(join(tmpdir(), "maquette-test-"));
cpSync(join(pkg, "examples"), join(root, "example"), { recursive: true });

const client = new Client({ name: "maquette-test", version: "0.1.0" });
const engine = join(pkg, "src", "engine.ts");
await client.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, engine, "--designcraft", cli, "--root", root], cwd: root, stderr: "inherit" }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { text, image: r.content.find((c) => c.type === "image")?.data };
};

// A drawing passes when its own check finds nothing wrong.
const failures: string[] = [];
const clean = (name: string, text: string) => {
  const ok = /All \d+ marks sit where the data puts them/.test(text) && ["No overset text.", "Nothing outside the frame.", "No overlapping labels."].every((s) => text.includes(s));
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${text}\n`);
  if (!ok) failures.push(name);
};

const names = ["01-revenue", "02-deliveries-by-region", "03-member-vs-market-price", "04-farm-size-vs-yield", "05-quarterly-operating-result"];
await call("open_document", { path: "example/annual-report.designcraft" });
await call("save_document", { path: "test.designcraft" });
for (const name of names) {
  const spec = JSON.parse(readFileSync(join(root, "example", "specs", `${name}.json`), "utf8"));
  const { text, image } = await call("chart_create", { frame: `firstlight:slot:${name.slice(0, 2)}`, spec });
  if (image) writeFileSync(join(root, `${name}.png`), Buffer.from(image, "base64"));
  clean(`chart_create ${name}`, text);
}
await call("save_document");

// Reopened, the charts come back from test.designcraft.maquette.json and can be redrawn.
await call("open_document", { path: "test.designcraft" });
const charts: { chart: string; spec: { data: { url: string } } }[] = JSON.parse((await call("chart_list")).text);
if (charts.length !== names.length) failures.push(`chart_list after reopening has ${charts.length} charts, not ${names.length}`);
for (const name of names.slice(0, 2)) {
  const chart = charts.find((c) => c.spec.data.url.includes(name))?.chart;
  if (!chart) continue;
  const { text } = await call("chart_update", { chart, data: { url: `example/data/${name}-updated.csv` }, render: false });
  clean(`chart_update ${name}`, text);
}
await call("save_document");
await client.close();

console.log(failures.length ? `Failed: ${failures.join("; ")}` : `All passed. The document and renders are in ${root}`);
process.exitCode = failures.length ? 1 : 0;
