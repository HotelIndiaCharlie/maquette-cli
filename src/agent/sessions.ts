import { chmodSync, closeSync, fchmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Message, ToolCallPart, ToolResultPart } from "../providers/types.ts";
import { acquireLock } from "../runtime/lock.ts";
import { pairedView } from "./context.ts";

export type SessionRecord = { v: 1; seq: number; at: string; type: string; data: any };
export type SessionInfo = { id: string; date: string; first: string; provider: string; model: string; error?: string };
const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
const kinds = new Set(["header", "provider", "message", "call_start", "call_result", "shell_start", "shell_result", "interrupted", "usage", "compact", "cursor", "notice", "recovered"]);

function validMessage(m: any): boolean {
  if (!m || !["assistant", "user"].includes(m.role) || !Array.isArray(m.parts)) return false;
  if (m.native && (m.role !== "assistant" || typeof m.native.provider !== "string" || !("content" in m.native))) return false;
  const content = (p: any) => p && (p.type === "text" ? typeof p.text === "string" : p.type === "image" && typeof p.data === "string" && typeof p.mediaType === "string");
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
    let r: SessionRecord;
    try { r = JSON.parse(line); } catch { throw new Error(`Corrupt session ${path}, line ${i + 1}. Original preserved; inspect or restore a backup.`); }
    if (r.v !== 1) throw new Error(`Unsupported session version at ${path}:${i + 1}; use a compatible Maquette version.`);
    if (r.seq !== i + 1 || !kinds.has(r.type) || typeof r.at !== "string" || !r.data || typeof r.data !== "object") throw new Error(`Invalid session record at ${path}:${i + 1}.`);
    if (r.type === "message" && !validMessage(r.data)) throw new Error(`Invalid message at ${path}:${i + 1}.`);
    if (r.type === "compact" && (!Array.isArray(r.data.messages) || !r.data.messages.every(validMessage))) throw new Error(`Invalid compact view at ${path}:${i + 1}.`);
    return r;
  });
  if (records[0]?.type !== "header" || records[0].data.root !== realpathSync(root)) throw new Error(`Session root/header mismatch: ${path}`);
  return { records, valid, truncated };
}

export class SessionJournal {
  id: string;
  path: string;
  records: SessionRecord[] = [];
  warnings: string[] = [];
  #fd: number;
  #release: () => void;
  #closed = false;
  constructor(root: string, options: { resume?: string | true; provider: string; model: string; version?: string }) {
    const dir = directory(root);
    this.id = typeof options.resume === "string" ? options.resume : options.resume ? listSessions(root).find(s => !s.error)?.id ?? "" : randomUUID();
    if (!idPattern.test(this.id)) throw new Error(options.resume ? "No resumable session here. Start maquette without --resume first, or choose an ID from /sessions." : "Invalid session ID.");
    this.path = join(dir, `${this.id}.jsonl`);
    const releaseOriginal = acquireLock(`${this.path}.lock`);
    this.#release = releaseOriginal;
    try {
      if (options.resume) {
        const r = read(this.path, root);
        this.records = r.records;
        if (r.truncated) {
          const previous = this.path;
          this.id = `${this.id.slice(0, 75)}_recovered_${randomUUID().slice(0, 8)}`;
          this.path = join(dir, `${this.id}.jsonl`);
          const releaseNew = acquireLock(`${this.path}.lock`);
          this.#release = () => { releaseNew(); releaseOriginal(); };
          writeFileSync(this.path, r.valid, { flag: "wx", mode: 0o600 });
          this.warnings.push(`Incomplete final line: original preserved at ${previous}; continuing recovered copy ${this.id}.`);
        }
      }
      this.#fd = openSync(this.path, options.resume ? "a" : "wx", 0o600);
      fchmodSync(this.#fd, 0o600);
      if (!options.resume) this.append("header", { root: realpathSync(root), id: this.id, appVersion: options.version ?? "0.1.0", provider: options.provider, model: options.model });
      if (this.warnings.length) this.append("recovered", { warnings: this.warnings });
      this.append("provider", { provider: options.provider, model: options.model });
    } catch (e) { this.#release(); throw e; }
  }
  append(type: string, data: unknown) {
    if (this.#closed) throw new Error("Session journal is closed.");
    const r: SessionRecord = { v: 1, seq: this.records.length + 1, at: new Date().toISOString(), type, data };
    const bytes = Buffer.from(`${JSON.stringify(r)}\n`);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset);
      fsyncSync(this.#fd);
      this.records.push(r);
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
      if (r.type === "compact") { messages = r.data.messages; activeCalls = []; outcomes.clear(); }
      if (r.type === "call_start" || r.type === "shell_start") pending.set(r.data.id, r);
      if (r.type === "call_result" || r.type === "shell_result") {
        pending.delete(r.data.id);
        if (activeCalls.some(c => c.id === r.data.id)) {
          const normalized = r.data.normalized ?? (r.data.reply ? { type: "tool_result", id: r.data.id, name: r.data.reply.tool, isError: !r.data.reply.ok,
            content: [{ type: "text", text: `${r.data.reply.text}\n${(r.data.reply.images ?? []).map((p: string) => `image: ${p}`).join("\n")}` }] } : undefined);
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
    return { messages: paired.messages, uncertain: paired.uncertain || pending.size > 0 };
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
      const first = records.find(r => r.type === "message" && r.data.role === "user")?.data.parts.find((p: any) => p.type === "text")?.text ?? "(empty)";
      const p = records.findLast(r => r.type === "provider")?.data ?? records[0].data;
      return { id, date: records.at(-1)!.at, first: String(first).replace(/\s+/g, " ").slice(0, 90), provider: p.provider, model: p.model };
    } catch (e) { return { id, date: "", first: "", provider: "", model: "", error: (e as Error).message }; }
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
