import { chmodSync, closeSync, fchmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile, lstat, readdir } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { sessionTitle } from "./presentation.ts";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Message, ToolCallPart, ToolResultPart } from "../providers/types.ts";
import { acquireLock } from "../runtime/lock.ts";
import { confine } from "../tools/workspace/paths.ts";
import { pairedView } from "./context.ts";

export type SessionRecord = { v: 1; seq: number; at: string; type: string; data: any };
export type SessionInfo = { id: string; date: string; first: string; provider: string; model: string; title?: string; empty?: boolean; locked?: boolean; lockedPid?: number; recoveredAs?: string; error?: string };
const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
const kinds = new Set(["header", "provider", "message", "message_append", "call_start", "call_result", "shell_start", "shell_result", "interrupted", "usage", "compact", "cursor", "notice", "recovered"]);

function validMessage(m: any): boolean {
  if (!m || !["assistant", "user"].includes(m.role) || !Array.isArray(m.parts)) return false;
  if (m.native && (m.role !== "assistant" || typeof m.native.provider !== "string" || !("content" in m.native))) return false;
  const content = (p: any) => p && (p.type === "text" ? typeof p.text === "string" : p.type === "image" && (typeof p.data === "string" || (typeof p.path === "string" && /^[a-f0-9]{64}$/.test(p.sha256))) && typeof p.mediaType === "string");
  return m.parts.every((p: any) => content(p) || (p?.type === "tool_call" && m.role === "assistant" && typeof p.id === "string" && typeof p.name === "string" && p.input && typeof p.input === "object" && !Array.isArray(p.input)) || (p?.type === "tool_result" && m.role === "user" && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.content) && p.content.every(content)));
}

function directory(root: string): string {
  const canonical = realpathSync(root);
  for (const part of [".maquette", ".maquette/sessions"]) {
    const p = join(canonical, part);
    if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
    const r = relative(canonical, realpathSync(p));
    if (r === ".." || r.startsWith(`..${sep}`)) throw new Error(`Session directory escapes project: ${part}`);
  }
  chmodSync(join(canonical, ".maquette", "sessions"), 0o700);
  return join(canonical, ".maquette", "sessions");
}
function read(path: string, root: string): { records: SessionRecord[]; valid: string; truncated: boolean } {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Session must be a regular file: ${path}`);
  const bytes = readFileSync(path);
  const last = bytes.lastIndexOf(10);
  const truncated = bytes.length > 0 && last !== bytes.length - 1;
  const valid = bytes.subarray(0, last + 1).toString("utf8");
  const records = (valid ? valid.slice(0, -1).split("\n") : []).map((line, i) => {
    return parseRecord(line, i, path);
  });
  if (records[0]?.type !== "header" || records[0].data.root !== realpathSync(root)) throw new Error(`Session root/header mismatch: ${path}`);
  return { records, valid, truncated };
}

function parseRecord(line: string, i: number, path: string): SessionRecord {
    let r: SessionRecord;
    try { r = JSON.parse(line); } catch { throw new Error(`Corrupt session ${path}, line ${i + 1}. Original preserved; inspect or restore a backup.`); }
    if (r.v !== 1) throw new Error(`Unsupported session version at ${path}:${i + 1}; use a compatible Maquette version.`);
    if (r.seq !== i + 1 || !kinds.has(r.type) || typeof r.at !== "string" || !r.data || typeof r.data !== "object") throw new Error(`Invalid session record at ${path}:${i + 1}.`);
    if (r.type === "message" && !validMessage(r.data)) throw new Error(`Invalid message at ${path}:${i + 1}.`);
    if (r.type === "message_append" && (!Array.isArray(r.data.parts) || !validMessage({ role: "user", parts: r.data.parts }))) throw new Error(`Invalid message append at ${path}:${i + 1}.`);
    if (r.type === "compact" && (!Array.isArray(r.data.messages) || !r.data.messages.every(validMessage))) throw new Error(`Invalid compact view at ${path}:${i + 1}.`);
    if (r.type === "notice" && r.data.ui && !validPresentation(r.data.ui)) throw new Error(`Invalid presentation record at ${path}:${i + 1}. Original preserved.`);
    return r;
}
function validPresentation(event: any): boolean {
  if (!event || typeof event.id !== "string") return false;
  if (event.kind === "end") return true;
  if (event.kind === "input") return typeof event.text === "string";
  if (event.kind === "answer" || event.kind === "tool") {
    if (!Number.isInteger(event.ref) || event.ref < 1) return false;
    return event.kind === "answer" || (typeof event.callId === "string" && typeof event.name === "string" && event.input && typeof event.input === "object" && !Array.isArray(event.input) && ["model", "prompt", "http", "mcp"].includes(event.source));
  }
  if (event.kind !== "item" || !event.item) return false;
  const item = event.item;
  if (item.kind === "shell") return typeof item.command === "string" && typeof item.output === "string" && (item.code === null || Number.isInteger(item.code));
  if (typeof item.text !== "string") return false;
  if (item.kind === "notice") return ["info", "warn", "error"].includes(item.level);
  return item.kind === "output" && typeof item.ok === "boolean" && (item.images === undefined || (Array.isArray(item.images) && item.images.every((p: unknown) => typeof p === "string")));
}
type ReadSession = ReturnType<typeof read>;
async function readAsync(path: string, root: string, progress?: (current: number, total: number) => void): Promise<ReadSession> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Session must be a regular file: ${path}`);
  const bytes = await readFile(path); const last = bytes.lastIndexOf(10);
  const valid = bytes.subarray(0, last + 1).toString("utf8"); const lines = valid ? valid.slice(0, -1).split("\n") : [];
  const records: SessionRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    records.push(parseRecord(lines[i], i, path));
    if (i % 64 === 0) { progress?.(i + 1, lines.length); await yieldLoop(); }
  }
  if (records[0]?.type !== "header" || records[0].data.root !== realpathSync(root)) throw new Error(`Session root/header mismatch: ${path}`);
  progress?.(lines.length, lines.length);
  return { records, valid, truncated: bytes.length > 0 && last !== bytes.length - 1 };
}
function locked(path: string): boolean {
  try { const p = JSON.parse(readFileSync(`${path}.lock`, "utf8")); if (!Number.isInteger(p.pid) || p.pid < 1) return true; try { process.kill(p.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } }
  catch { return existsSync(`${path}.lock`); }
}
function recoveredAs(path: string): string | undefined {
  try { const id = readFileSync(`${path}.recovered`, "utf8").trim(); return idPattern.test(id) ? id : undefined; } catch {}
}
function recoveryTarget(root: string, initial: string): string {
  let id = initial; const seen = new Set<string>();
  for (;;) {
    if (seen.has(id) || seen.size >= 100) throw new Error("Invalid cycle in recovered session references; inspect .recovered markers.");
    seen.add(id);
    const next = recoveredAs(join(directory(root), `${id}.jsonl`));
    if (!next) return id;
    id = next;
  }
}
function resumable(s: SessionInfo) { return !s.error && !s.empty && !s.locked && !s.recoveredAs; }
function latest(entries: SessionInfo[]): string | undefined {
  const id = entries.find(resumable)?.id;
  if (!id && entries.some(s => s.locked && !s.empty && !s.error)) throw new Error(`The latest conversation is open in another terminal${entries.find(s => s.locked)?.lockedPid ? ` (pid ${entries.find(s => s.locked)!.lockedPid})` : ""}; use /resume to pick another or start a new conversation.`);
  return id;
}
function lockPid(path: string): number | undefined {
  try { const pid = JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid; return Number.isInteger(pid) && pid > 0 ? pid : undefined; } catch {}
}
function metadata(id: string, path: string, records: SessionRecord[]): SessionInfo {
  const first = records.find(r => r.type === "message" && r.data.role === "user")?.data.parts.find((p: any) => p.type === "text")?.text ?? "(empty)";
  const p = records.findLast(r => r.type === "provider")?.data ?? records[0].data;
  const title = sessionTitle(records);
  return { id, title, empty: title === "Empty conversation", locked: locked(path), lockedPid: lockPid(path), recoveredAs: recoveredAs(path), date: records.findLast(r => r.type === "message")?.at ?? records[0].at, first: String(first).replace(/\s+/g, " ").slice(0, 90), provider: p.provider, model: p.model };
}
export async function listSessionsAsync(root: string): Promise<SessionInfo[]> {
  const dir = directory(root); const out: SessionInfo[] = [];
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".jsonl"))) {
    const id = file.slice(0, -6), path = join(dir, file);
    try { const { records } = await readAsync(path, root); out.push(metadata(id, path, records)); }
    catch (e) { out.push({ id, date: "", first: "", provider: "", model: "", error: (e as Error).message }); }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export class SessionJournal {
  id: string;
  path: string;
  records: SessionRecord[] = [];
  warnings: string[] = [];
  #fd: number;
  #release: () => void;
  #closed = false;
  calls = new Map<string, { start?: SessionRecord; result?: SessionRecord }>();
  private index(record: SessionRecord) {
    if (record.type !== "call_start" && record.type !== "call_result") return;
    const current = this.calls.get(record.data.id) ?? {};
    if (record.type === "call_start") current.start = record; else current.result = record;
    this.calls.set(record.data.id, current);
  }
  private persist(value: any): any {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => this.persist(v));
    if (value.type === "image" && typeof value.data === "string" && value.mediaType) {
      const bytes = Buffer.from(value.data, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
      const dir = confine(this.root, join(directory(this.root), "assets")); mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Content-addressed snapshots don't change if a render path is overwritten.
      const path = join(dir, sha256);
      if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: "wx", flush: true });
      return { type: "image", path: relative(this.root, path), mediaType: value.mediaType, sha256, ...(value.path ? { originalPath: value.path } : {}) };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.persist(v)]));
  }
  private hydrate(value: any): any {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => this.hydrate(v));
    if (value.type === "image" && value.sha256 && !value.data) {
      try {
        const path = realpathSync(join(this.root, value.path));
        const base = confine(this.root, join(directory(this.root), "assets"));
        if (!path.startsWith(base + sep)) throw new Error("Image path outside assets");
        const bytes = readFileSync(path);
        if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new Error("Image hash changed");
        return { type: "image", mediaType: value.mediaType, data: bytes.toString("base64"), ...(value.originalPath ? { path: value.originalPath } : {}) };
      } catch { return { type: "text", text: `image no longer available: ${value.originalPath ?? value.path}` }; }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.hydrate(v)]));
  }
  root: string;
  static async open(root: string, options: { resume?: string | true; provider: string; model: string }, progress?: (current: number, total: number) => void): Promise<SessionJournal> {
    if (!options.resume) return new SessionJournal(root, options);
    const selected = typeof options.resume === "string" ? options.resume : latest(await listSessionsAsync(root));
    if (!selected || !idPattern.test(selected)) throw new Error("No resumable session here. Start a new conversation first.");
    const id = recoveryTarget(root, selected);
    const path = join(directory(root), `${id}.jsonl`);
    const release = acquireLock(`${path}.lock`);
    try { const prepared = await readAsync(path, root, progress); return new SessionJournal(root, { ...options, resume: id, prepared, release }); }
    catch (e) { release(); throw e; }
  }
  constructor(root: string, options: { resume?: string | true; provider: string; model: string; version?: string; prepared?: ReadSession; release?: () => void }) {
    this.root = realpathSync(root);
    const dir = directory(root);
    this.id = typeof options.resume === "string" ? options.resume : options.resume ? latest(listSessions(root)) ?? "" : randomUUID();
    if (!idPattern.test(this.id)) throw new Error(options.resume ? "No resumable session here. Start maquette without --resume first, or choose an ID from /sessions." : "Invalid session ID.");
    this.path = join(dir, `${this.id}.jsonl`);
    // The synchronous constructor remains a compatibility path for embedders;
    // it shares selection/recovery rules with open(), used by the interactive UI.
    if (options.resume) { this.id = recoveryTarget(root, this.id); this.path = join(dir, `${this.id}.jsonl`); }
    const releaseOriginal = options.release ?? acquireLock(`${this.path}.lock`);
    this.#release = releaseOriginal;
    try {
      if (options.resume) {
        const r = options.prepared ?? read(this.path, root);
        this.records = r.records;
        if (r.truncated) {
          const previous = this.path;
          this.id = `${this.id.slice(0, 75)}_recovered_${randomUUID().slice(0, 8)}`;
          this.path = join(dir, `${this.id}.jsonl`);
          const releaseNew = acquireLock(`${this.path}.lock`);
          this.#release = () => { releaseNew(); releaseOriginal(); };
          writeFileSync(this.path, r.valid, { flag: "wx", mode: 0o600 });
          writeFileSync(`${previous}.recovered`, this.id, { mode: 0o600 });
          this.warnings.push(`Incomplete final line: original preserved at ${previous}; continuing recovered copy ${this.id}.`);
        }
      }
      this.#fd = openSync(this.path, options.resume ? "a" : "wx", 0o600);
      fchmodSync(this.#fd, 0o600);
      if (!options.resume) this.append("header", { root: realpathSync(root), id: this.id, appVersion: options.version ?? "0.1.0", provider: options.provider, model: options.model });
      if (this.warnings.length) this.append("recovered", { warnings: this.warnings });
      const previous = this.records.findLast(r => r.type === "provider")?.data ?? this.records[0]?.data;
      if (previous?.provider !== options.provider || previous?.model !== options.model) this.append("provider", { provider: options.provider, model: options.model });
      for (const record of this.records) this.index(record);
    } catch (e) { this.#release(); throw e; }
  }
  append(type: string, data: any) {
    if (this.#closed) throw new Error("Session journal is closed.");
    if (type === "provider") {
      const previous = this.records.findLast(r => r.type === "provider")?.data ?? this.records[0]?.data;
      if (previous?.provider === data.provider && previous?.model === data.model) return;
    }
    if (type === "call_result" && data.reply) {
      const { result, ...reply } = data.reply;
      // File images are already durable. Avoid raw MCP base64 and a second
      // normalized copy; recovery uses this bounded first-ingestion text.
      const normalized = data.normalized;
      data = { id: data.id, ...(normalized ? { imageRefs: normalized.content.filter((p: any) => p.type === "image") } : {}), reply: { ...reply, ...(normalized ? { text: normalized.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") } : {}) } };
    }
    data = this.persist(data);
    const r: SessionRecord = { v: 1, seq: this.records.length + 1, at: new Date().toISOString(), type, data };
    const bytes = Buffer.from(`${JSON.stringify(r)}\n`);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset);
      fsyncSync(this.#fd);
      this.records.push(r); this.index(r);
    } catch {
      this.close();
      throw new Error(`Session journal write failed at ${this.path}; writer closed. Restart with --resume to recover before continuing.`);
    }
  }
  restore(): { messages: Message[]; uncertain: boolean } {
    let messages: Message[] = [];
    const pending = new Map<string, { seq: number; type: string; data: any }>();
    let activeCalls: ToolCallPart[] = [];
    let outcomes = new Map<string, ToolResultPart>();
    let lastMessage = 0;
    const complete = () => {
      if (!activeCalls.length || !outcomes.size) return;
      messages.push({ role: "user", parts: activeCalls.filter(c => outcomes.has(c.id)).map(c => outcomes.get(c.id)!) });
      activeCalls = []; outcomes.clear();
    };
    for (const r of this.records) {
      if (r.type === "message") {
        lastMessage = r.seq;
        // The committed group supersedes the per-call recovery view.
        if (r.data.role === "user" && r.data.parts.some((p: any) => p.type === "tool_result")) { activeCalls = []; outcomes.clear(); }
        else complete();
        messages.push(r.data);
        if (r.data.role === "assistant") activeCalls = r.data.parts.filter((p: any) => p.type === "tool_call");
      }
      if (r.type === "message_append") {
        const last = messages.at(-1);
        if (last?.role === "user") messages[messages.length - 1] = { ...last, parts: [...last.parts, ...r.data.parts] };
      }
      if (r.type === "compact") { messages = r.data.messages; activeCalls = []; outcomes.clear(); }
      if (r.type === "call_start" || r.type === "shell_start") pending.set(r.data.id, r);
      if (r.type === "call_result" || r.type === "shell_result") {
        pending.delete(r.data.id);
        if (activeCalls.some(c => c.id === r.data.id)) {
          const normalized = r.data.normalized ?? (r.data.reply ? { type: "tool_result", id: r.data.id, name: r.data.reply.tool, isError: !r.data.reply.ok,
            content: [{ type: "text", text: `${r.data.reply.text}\n${(r.data.reply.images ?? []).map((p: string) => `image: ${p}`).join("\n")}` }, ...(r.data.imageRefs ?? [])] } : undefined);
          if (normalized) outcomes.set(r.data.id, normalized);
        }
      }
    }
    complete();
    // Direct effects after the last committed message are evidence, not instructions to replay.
    for (const r of this.records.filter(r => r.seq > lastMessage)) {
      if (r.type === "call_result" && r.data.reply?.source === "prompt") messages.push({ role: "user", parts: [{ type: "text", text: `Recovered direct call result (already executed; do not replay): ${r.data.reply.tool}: ${r.data.reply.text}` }] });
      if (r.type === "shell_result") messages.push({ role: "user", parts: [{ type: "text", text: `Recovered shell result (do not replay), exit ${r.data.code}: ${r.data.output}` }] });
    }
    const paired = pairedView(messages);
    return { messages: this.hydrate(paired.messages), uncertain: paired.uncertain || pending.size > 0 };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
    this.#release();
  }
}

export function listSessions(root: string): SessionInfo[] {
  const dir = directory(root);
  return readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(file => {
    const id = file.slice(0, -6);
    try {
      const { records } = read(join(dir, file), root);
      return metadata(id, join(dir, file), records);
    } catch (e) { return { id, date: "", first: "", provider: "", model: "", error: (e as Error).message }; }
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
