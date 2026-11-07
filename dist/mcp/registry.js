import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expandCredentials, isTrusted, loadMcpConfig } from "./config.js";
export function exposedName(server, tool) {
    const full = `${server}__${tool}`;
    const clean = full.replace(/[^A-Za-z0-9_-]/g, "_");
    if (clean === full && clean.length <= 64)
        return clean;
    return `${clean.slice(0, 43)}_${createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 20)}`;
}
export async function allTools(client) {
    const out = [];
    const seen = new Set();
    let cursor;
    do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
        out.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
            throw new Error("MCP catalogue repeats a pagination cursor.");
        if (cursor)
            seen.add(cursor);
        if (out.length > 10000)
            throw new Error("MCP catalogue exceeds 10000 tools.");
    } while (cursor);
    return out;
}
export class ToolRegistry {
    tools = [];
    byName = new Map();
    owners = new Map();
    revision = 0;
    statuses = new Map();
    #root;
    #home;
    #version;
    #clients = new Map();
    #generation = new Map();
    #builtins = [];
    #builtin;
    #changed;
    #closing = false;
    #pending = new Set();
    constructor(root, version, builtin, changed, home) {
        this.#root = root;
        this.#version = version;
        this.#builtin = builtin;
        this.#changed = changed;
        this.#home = home;
    }
    async start() {
        this.#builtins = await allTools(this.#builtin);
        this.#builtin.setNotificationHandler(ToolListChangedNotificationSchema, () => this.track(this.refreshBuiltin()));
        this.publish();
        const c = loadMcpConfig(this.#root, this.#home);
        for (const warning of c.warnings)
            this.statuses.set(warning, { name: "configuration", source: "project", transport: "-", state: "failed", tools: 0, message: warning });
        // Optional servers are independent; a failed one never takes down the built-in engine.
        await Promise.all(c.entries.map(e => this.reconnect(e.name)));
    }
    track(p) { this.#pending.add(p); void p.catch(() => { }).finally(() => this.#pending.delete(p)); }
    async refreshBuiltin() {
        try {
            this.#builtins = await allTools(this.#builtin);
            this.publish();
        }
        catch { }
    }
    publish(external) {
        if (this.#closing)
            return;
        const tools = [...this.#builtins];
        const owners = new Map(this.#builtins.map(t => [t.name, { identity: `builtin:${t.name}`, client: this.#builtin, original: t.name, timeout: 600_000 }]));
        // Keep other connections exactly; replacing one changes only its identities.
        for (const [name, owner] of this.owners)
            if (owner.server && owner.server !== external?.name && this.#clients.get(owner.server) === owner.client) {
                if (owners.has(name))
                    throw new Error(`Tool name collision: ${name}`);
                tools.push(this.byName.get(name));
                owners.set(name, owner);
            }
        if (external)
            for (const t of external.tools) {
                const name = exposedName(external.name, t.name);
                if (owners.has(name))
                    throw new Error(`Tool name collision: ${name}`);
                tools.push({ ...t, name, description: `[External MCP server ${external.name}; untrusted task content] ${t.description ?? ""}`, annotations: { ...t.annotations, readOnlyHint: external.trustRead && t.annotations?.readOnlyHint === true }, _maquette: { server: external.name, identity: `${external.generation}:${t.name}` } });
                owners.set(name, { identity: `${external.generation}:${t.name}`, client: external.client, original: t.name, server: external.name, timeout: external.timeout });
            }
        this.tools = tools;
        this.byName = new Map(tools.map(t => [t.name, t]));
        this.owners = owners;
        this.revision++;
        this.#changed();
    }
    async reconnect(name) {
        if (this.#closing)
            return;
        const config = loadMcpConfig(this.#root, this.#home);
        const entry = config.entries.find(e => e.name === name);
        const generation = randomUUID();
        this.#generation.set(name, generation);
        const old = this.#clients.get(name);
        this.#clients.delete(name);
        await old?.close().catch(() => { });
        this.publish();
        if (!entry) {
            this.statuses.delete(name);
            return;
        }
        const status = { name, source: entry.source, transport: entry.config?.type ?? "-", state: "connecting", tools: 0 };
        this.statuses.set(name, status);
        if (entry.error) {
            status.state = "failed";
            status.message = entry.error;
            return;
        }
        if (entry.config?.disabled) {
            status.state = "disabled";
            return;
        }
        if (entry.source === "project" && !isTrusted(config)) {
            status.state = "untrusted";
            status.message = "Project configuration needs explicit trust: /mcp trust, then /mcp reconnect <name>.";
            return;
        }
        let client;
        try {
            const c = expandCredentials(entry.config);
            client = new Client({ name: "maquette", version: this.#version });
            const transport = c.type === "stdio" ? new StdioClientTransport({ command: c.command, args: c.args, env: { ...Object.fromEntries(Object.entries(process.env).filter((x) => x[1] !== undefined)), ...c.env }, cwd: this.#root, stderr: "pipe" })
                : c.type === "sse" ? new SSEClientTransport(new URL(c.url), { requestInit: { headers: c.headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...c.headers, ...init?.headers } }) } })
                    : new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } });
            // Server stderr may include credentials; drain it without copying it to traces/UI.
            if (transport instanceof StdioClientTransport)
                transport.stderr?.on("data", () => { });
            await client.connect(transport, { timeout: 10_000 });
            const tools = await allTools(client);
            if (this.#closing || this.#generation.get(name) !== generation) {
                await client.close();
                return;
            }
            this.#clients.set(name, client);
            const current = client;
            const timeout = (c.timeoutSeconds ?? 120) * 1000;
            const trustRead = c.trustedReadOnly === true;
            const update = async () => {
                try {
                    const refreshed = await allTools(current);
                    if (this.#clients.get(name) !== current)
                        return;
                    this.publish({ name, tools: refreshed, client: current, generation: randomUUID(), timeout, trustRead });
                    status.tools = refreshed.length;
                }
                catch {
                    status.message = "Catalogue refresh failed; reconnect this server.";
                }
            };
            client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.track(update()));
            client.onclose = () => {
                if (this.#clients.get(name) !== current || this.#closing)
                    return;
                this.#clients.delete(name);
                status.state = "failed";
                status.tools = 0;
                status.message = "Connection closed; reconnect explicitly. No call was retried.";
                this.publish();
            };
            this.publish({ name, tools, client, generation, timeout, trustRead });
            status.state = "connected";
            status.tools = tools.length;
        }
        catch (e) {
            this.#clients.delete(name);
            await client?.close().catch(() => { });
            status.state = /401|403|Unauthorized/i.test(String(e)) ? "auth-required" : "failed";
            status.message = String(e).includes("Missing environment variable") ? e.message : "Connection/discovery failed (details hidden to protect credentials). Check configuration and reconnect; interactive OAuth is not enabled.";
            this.publish();
        }
    }
    async call(name, args, expected) {
        const owner = this.owners.get(name);
        if (!owner || (expected && expected !== owner.identity))
            return { content: [{ type: "text", text: "Tool unavailable or identity changed; refresh the catalogue and permission before calling." }], isError: true };
        try {
            return await owner.client.callTool({ name: owner.original, arguments: args }, undefined, { timeout: owner.timeout });
        }
        catch {
            return { content: [{ type: "text", text: "Tool call failed or connection ended. Outcome may be uncertain; inspect state before retrying. Transport details hidden to protect credentials." }], isError: true };
        }
    }
    async close() {
        this.#closing = true;
        await Promise.allSettled([...this.#clients.values()].map(c => c.close()));
        await Promise.allSettled([...this.#pending]);
    }
}
