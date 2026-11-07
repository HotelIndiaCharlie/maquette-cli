import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Tool } from "../args.ts";
import { runtimeProtocol, startServer, type ServerHandle, type ServerOptions, type RuntimeIdentity } from "../server.ts";

export async function discover(root: string, port: number, version: string): Promise<RuntimeIdentity | undefined> {
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(1500) }); }
  catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return;
    throw new Error(`Port ${port} cannot be verified as a Maquette runtime. It may be occupied or unresponsive.`);
  }
  let id: RuntimeIdentity;
  try { id = await response.json(); } catch { throw new Error(`Port ${port} is occupied by a non-Maquette process.`); }
  if (!response.ok || id.protocol !== runtimeProtocol || id.version !== version || typeof id.runtimeId !== "string") throw new Error(`Port ${port} is not a compatible Maquette ${version} runtime.`);
  if (id.root !== realpathSync(root)) throw new Error(`Port ${port} belongs to another project: ${id.root}. Choose a different --port.`);
  return id;
}

export async function attachRuntime(identity: RuntimeIdentity, port: number): Promise<ServerHandle> {
  const caller = `terminal:${randomUUID()}`;
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-maquette-root": identity.root, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(610_000) });
    if (!r.ok) throw new Error(`Shared runtime request failed (${r.status}); no call was retried.`);
    return await r.json();
  };
  let data = await request("/tools");
  let last: string | undefined;
  const handle: ServerHandle = {
    root: identity.root, port, identity, get revision() { return data.revision; }, get tools() { return data.tools; }, get byName() { return new Map<string, Tool>(data.tools.map((t: Tool) => [t.name, t])); },
    get instructions() { return data.instructions; }, images: "maquette-renders", lastImage: () => last,
    async enqueue(tool, args, source, options) { const r = await request("/call", { tool, arguments: args, source, caller: options?.caller ?? caller, identity: options?.identity }); last = r.images?.at(-1) ?? last; return r; },
    async refresh() { const current = await request("/tools"); if (current.runtimeId !== identity.runtimeId) throw new Error("Runtime restarted; reconnect and inspect current state before continuing."); data = current; },
    async mcpStatus() { return (await request("/mcp")).servers; }, async reconnect(name) { await request("/mcp/reconnect", { name }); await handle.refresh(); },
    on() { return () => {}; }, async stop() {},
  };
  return handle;
}

// Both frontends start through this path; startServer's exclusive root/port lock owns launch.
export async function ensureRuntime(options: Omit<ServerOptions, "cli" | "engine">, launch: () => Promise<{ cli?: string; engine?: string }>): Promise<{ server: ServerHandle; owned: boolean }> {
  const root = realpathSync(options.root ?? process.cwd());
  const existing = await discover(root, options.port, options.version);
  if (existing) return { server: await attachRuntime(existing, options.port), owned: false };
  try { return { server: await startServer({ ...options, root, ...await launch() }), owned: true }; }
  catch (e) {
    if (!/Already owned|Ownership is being checked|Port .* is in use/.test((e as Error).message)) throw e;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const id = await discover(root, options.port, options.version);
      if (id) return { server: await attachRuntime(id, options.port), owned: false };
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("Another runtime is starting but did not become ready. Check its terminal before retrying.");
  }
}
