import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type McpConfig = { type?: "stdio" | "http" | "sse"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; inheritEnv?: boolean; disabled?: boolean; trustedReadOnly?: boolean; timeoutSeconds?: number };
export type McpEntry = { name: string; config?: McpConfig; source: "user" | "project"; path?: string; error?: string };
export type McpConfiguration = { entries: McpEntry[]; projectHash: string; root: string; home: string; warnings: string[] };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function validateMcpMap(value: unknown): Record<string, McpConfig> {
  if (!object(value)) throw new Error("mcpServers must be an object.");
  const out: Record<string, McpConfig> = Object.create(null);
  for (const [name, v] of Object.entries(value)) {
    if (!name || name.length > 128 || !object(v)) throw new Error("Each MCP server needs a name and an object configuration.");
    const bad = (why: string) => new Error(`MCP server ${JSON.stringify(name)}: ${why}. Values are hidden.`);
    for (const key of Object.keys(v)) if (!["type", "command", "args", "env", "url", "headers", "disabled", "trustedReadOnly", "timeoutSeconds", "inheritEnv"].includes(key)) throw bad("unknown configuration field");
    for (const key of ["disabled", "trustedReadOnly", "inheritEnv"]) if (v[key] !== undefined && typeof v[key] !== "boolean") throw bad(`${key} must be boolean`);
    if (v.disabled === true) { out[name] = { disabled: true }; continue; }
    const type = v.type ?? (v.command ? "stdio" : "http");
    if (!["stdio", "http", "sse"].includes(String(type))) throw bad("type must be stdio, http or sse");
    if (type === "stdio") {
      if (typeof v.command !== "string" || !v.command.trim() || v.url !== undefined || v.headers !== undefined) throw bad("stdio needs command and cannot have url/headers");
    } else {
      if (typeof v.url !== "string" || v.command !== undefined || v.args !== undefined || v.env !== undefined || v.inheritEnv !== undefined) throw bad("HTTP/SSE needs url and cannot have command/args/env");
      try { const u = new URL(v.url); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error(); } catch { throw bad("url must be HTTP(S), without embedded credentials"); }
    }
    if (v.args !== undefined && (!Array.isArray(v.args) || !v.args.every(a => typeof a === "string"))) throw bad("args must be strings");
    for (const key of ["env", "headers"]) if (v[key] !== undefined && (!object(v[key]) || !Object.values(v[key]).every(x => typeof x === "string"))) throw bad(`${key} must map names to strings`);
    if (v.timeoutSeconds !== undefined && (!Number.isInteger(v.timeoutSeconds) || Number(v.timeoutSeconds) < 1 || Number(v.timeoutSeconds) > 600)) throw bad("timeoutSeconds must be 1–600");
    out[name] = { ...v, type } as McpConfig;
  }
  return out;
}
const stable = (v: any): string => JSON.stringify(v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : v);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function loadMcpConfig(root: string, home = homedir()): McpConfiguration {
  root = realpathSync(root);
  const entries = new Map<string, McpEntry>();
  const warnings: string[] = [];
  const project: unknown[] = [];
  for (const [path, source] of [[join(home, ".maquette", "settings.json"), "user"], [join(root, ".mcp.json"), "project"], [join(root, ".maquette", "settings.json"), "project"]] as const) {
    if (!existsSync(path)) continue;
    let json;
    try { json = JSON.parse(readFileSync(path, "utf8")); } catch { warnings.push(`Invalid JSON in ${path}; MCP configuration skipped (values hidden).`); continue; }
    if (json.mcpServers === undefined) continue;
    if (source === "project") project.push(json.mcpServers);
    if (!object(json.mcpServers)) { warnings.push(`mcpServers in ${path} must be an object.`); continue; }
    for (const [name, value] of Object.entries(json.mcpServers)) {
      try { entries.set(name, { name, source, path, config: validateMcpMap({ [name]: value })[name] }); }
      catch (e) { entries.set(name, { name, source, path, error: (e as Error).message }); }
    }
  }
  // Project-relative executables are part of the trust decision, including a
  // symlink's resolved contents. PATH commands still trust the configured path.
  const executables = [...entries.values()].filter(e => e.source === "project" && e.config?.command?.startsWith(".")).map(e => {
    const path = resolve(root, e.config!.command!);
    try { return [e.name, createHash("sha256").update(readFileSync(path)).digest("hex")]; }
    catch { return [e.name, "unavailable executable"]; }
  });
  return { entries: [...entries.values()], projectHash: hash(stable([project, executables])), root, home, warnings };
}
const trustFile = (c: McpConfiguration) => join(c.home, ".maquette", "mcp-trust", `${hash(c.root)}.json`);
export function isTrusted(c: McpConfiguration): boolean {
  try { const t = JSON.parse(readFileSync(trustFile(c), "utf8")); return t.root === c.root && t.hash === c.projectHash; } catch { return false; }
}
// Call only after explicit approval of the shown root and effective project configuration.
export function trustProject(c: McpConfiguration) {
  mkdirSync(join(c.home, ".maquette", "mcp-trust"), { recursive: true, mode: 0o700 });
  writeFileSync(trustFile(c), JSON.stringify({ root: c.root, hash: c.projectHash }), { mode: 0o600 });
}
export function expandCredentials(config: McpConfig, env = process.env): McpConfig {
  const expand = (map?: Record<string, string>) => map && Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined) throw new Error(`Missing environment variable ${name}; set it before reconnecting. Credential values are hidden.`);
    return env[name]!;
  })]));
  return { ...config, env: expand(config.env), headers: expand(config.headers) };
}
export function redactedMcp(value: Record<string, McpConfig>) {
  return Object.fromEntries(Object.entries(value).map(([name, c]) => [name, { ...c, ...(c.command ? { command: "[configured]" } : {}), ...(c.args ? { args: c.args.map(() => "[redacted]") } : {}), ...(c.url ? { url: "[configured URL]" } : {}), ...(c.env ? { env: Object.fromEntries(Object.keys(c.env).map(k => [k, "[redacted]"])) } : {}), ...(c.headers ? { headers: Object.fromEntries(Object.keys(c.headers).map(k => [k, "[redacted]"])) } : {}) }]));
}
