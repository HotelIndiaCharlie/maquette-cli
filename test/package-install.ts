// Builds no release and publishes nothing: pack/install into a disposable directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findDesignCraft } from "../src/install.ts";
import { closedPort } from "./unit/mock.ts";
const pkg = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "maquette-package-"));
const pack = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", base], { cwd: pkg, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
const install = join(base, "install"), project = join(base, "project"), testHome = join(base, "home");
for (const dir of [install, project, testHome]) mkdirSync(dir);
writeFileSync(join(install, "package.json"), JSON.stringify({ private: true }));
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(base, pack.filename)], { cwd: install, stdio: ["ignore", "pipe", "pipe"] });
const binary = join(install, "node_modules/.bin/maquette");
const env = { ...process.env, HOME: testHome }; delete env.MAQUETTE_ENGINE;
const listing = execFileSync(binary, ["skills"], { cwd: project, env, encoding: "utf8" });
for (const name of ["init", "chart", "report-review", "designcraft"]) assert.match(listing, new RegExp(`${name} —`));
const shown = execFileSync(binary, ["skills", "chart"], { cwd: project, env, encoding: "utf8" }); assert.match(shown, /current tool keeps a move/);
const dc = findDesignCraft(); if (!dc) throw new Error("Packed MCP acceptance requires the pinned DesignCraft CLI.");
cpSync(join(install, "node_modules/maquette-cli/examples"), join(project, "example"), { recursive: true });
const client = new Client({ name: "packed-install-acceptance", version: "1" });
let stderr = "";
const transport = new StdioClientTransport({ command: binary, args: ["mcp", "--port", String(await closedPort())], cwd: project, env: { ...env, DESIGNCRAFT_CLI: dc } as any, stderr: "pipe" });
transport.stderr?.on("data", b => stderr += b);
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools; assert.ok(tools.some(t => t.name === "skill")); assert.ok(tools.some(t => t.name === "tree"));
  const resource = await client.callTool({ name: "skill", arguments: { name: "chart", path: "references/working-with-charts.md" } }); assert.ok(!resource.isError, JSON.stringify(resource)); assert.match(JSON.stringify(resource.content), /Current chart contract/);
  const open = await client.callTool({ name: "open_document", arguments: { path: "example/annual-report.designcraft" } }); assert.ok(!open.isError, JSON.stringify(open));
  const inspected = await client.callTool({ name: "inspect_document", arguments: {} }); assert.match(JSON.stringify(inspected.content), /Larkmoor/);
  console.log(`PASS: packed install without dev dependencies; installed binary, four bundled skills, supporting resource, tree and real DesignCraft MCP facade. Artifacts: ${base}`);
} finally { await client.close(); }
