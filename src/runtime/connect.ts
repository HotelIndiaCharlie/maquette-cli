import { realpathSync } from "node:fs";
import { runtimeOwner } from "./ownership.ts";
import { OwnershipError } from "./lock.ts";
import type { Tool } from "../args.ts";
import { runtimeProtocol, startServer, PortInUseError, type ServerHandle, type ServerOptions, type RuntimeIdentity } from "../server.ts";

export async function discover(root: string, port: number, version: string): Promise<RuntimeIdentity | undefined> {
  const owner = runtimeOwner(root);
  if (owner && owner.port !== port) throw new Error(`Maquette is already running for this folder on port ${owner.port} (pid ${owner.pid}); use --port ${owner.port}.`);
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

export async function attachRuntime(identity: RuntimeIdentity, port: number, channel: "terminal" | "mcp" = "terminal"): Promise<ServerHandle> {
  const tokens = new Map<string, Promise<string>>();
  const request = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-maquette-root": identity.root, ...(token ? { "x-maquette-session": token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      // At most ten minutes queued, then ten minutes executing. A queue
      // deadline prevents an abandoned waiting request from executing later.
      signal: AbortSignal.timeout(path === "/call" ? 1_210_000 : path === "/mcp/reconnect" ? 15_000 : 5000),
    });
    if (!r.ok) throw new Error(`Shared runtime request failed (${r.status}); no call was retried.`);
    return await r.json();
  };
  const sessionToken = async (caller = "attached") => {
    let token = tokens.get(caller);
    if (!token) {
      token = request("/session", { channel }).then(r => r.token as string); tokens.set(caller, token);
      const pending = token;
      void token.catch(() => { if (tokens.get(caller) === pending) tokens.delete(caller); });
    }
    return token;
  };
  let data = await request("/tools");
  let byName = new Map<string, Tool>(data.tools.map((t: Tool) => [t.name, t]));
  let last: string | undefined;
  const handle: ServerHandle = {
    root: identity.root, port, identity, get changeSequence() { return data.changeSequence; },
    async changes(cursor, caller) { return await request(`/changes${cursor ? `?runtime=${encodeURIComponent(cursor.runtime)}&after=${cursor.after}` : ""}`, undefined, await sessionToken(caller)); },
    get revision() { return data.revision; }, get tools() { return data.tools; }, get byName() { return byName; },
    get instructions() { return data.instructions; }, images: "maquette-renders", lastImage: () => last,
    async enqueue(tool, args, source, options) {
      const r = await request("/call", { tool, arguments: args, deadline: Date.now() + 600_000, identity: options?.identity, cursor: options?.cursor }, await sessionToken(options?.caller));
      last = r.images?.at(-1) ?? last; return r;
    },
    async refresh() {
      const current = await request("/tools");
      if (current.protocol !== runtimeProtocol || current.root !== identity.root || current.version !== identity.version) throw new Error("Runtime identity changed to an incompatible process/project; reconnect explicitly.");
      if (identity.runtimeId !== current.runtimeId) tokens.clear();
      identity.runtimeId = current.runtimeId; data = current;
      byName = new Map<string, Tool>(data.tools.map((t: Tool) => [t.name, t]));
    },
    async mcpLogs(name) { return (await request(`/mcp/logs?name=${encodeURIComponent(name)}`)).text; },
    async mcpStatus() { return (await request("/mcp")).servers; },
    async reconnect(name) { await request("/mcp/reconnect", { name }); await handle.refresh(); },
    on() { return () => {}; }, async stop() {},
  };
  return handle;
}

// Both frontends start through this path; startServer's exclusive canonical-root lock owns launch.
export async function ensureRuntime(options: Omit<ServerOptions, "cli" | "engine"> & { channel?: "terminal" | "mcp" }, launch: () => Promise<{ cli?: string; engine?: string }>): Promise<{ server: ServerHandle; owned: boolean }> {
  const root = realpathSync(options.root ?? process.cwd());
  const existing = await discover(root, options.port, options.version);
  if (existing) return { server: await attachRuntime(existing, options.port, options.channel), owned: false };
  try { return { server: await startServer({ ...options, root, ...await launch() }), owned: true }; }
  catch (e) {
    if (!(e instanceof OwnershipError) && !(e instanceof PortInUseError)) throw e;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const id = await discover(root, options.port, options.version);
      if (id) return { server: await attachRuntime(id, options.port, options.channel), owned: false };
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("Another runtime is starting but did not become ready. Check its terminal before retrying.");
  }
}
