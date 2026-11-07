import { chmodSync, closeSync, fchmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile, lstat, readdir } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { sessionTitle } from "./presentation.js";
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import { acquireLock } from "../runtime/lock.js";
import { pairedView } from "./context.js";
const idPattern = /^[a-zA-Z0-9_-]{1,120}$/;
const kinds = new Set(["header", "provider", "message", "call_start", "call_result", "shell_start", "shell_result", "interrupted", "usage", "compact", "cursor", "notice", "recovered"]);
function validMessage(m) {
    if (!m || !["assistant", "user"].includes(m.role) || !Array.isArray(m.parts))
        return false;
    if (m.native && (m.role !== "assistant" || typeof m.native.provider !== "string" || !("content" in m.native)))
        return false;
    const content = (p) => p && (p.type === "text" ? typeof p.text === "string" : p.type === "image" && typeof p.data === "string" && typeof p.mediaType === "string");
    return m.parts.every((p) => content(p) || (p?.type === "tool_call" && m.role === "assistant" && typeof p.id === "string" && typeof p.name === "string" && p.input && typeof p.input === "object" && !Array.isArray(p.input)) || (p?.type === "tool_result" && m.role === "user" && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.content) && p.content.every(content)));
}
function directory(root) {
    const canonical = realpathSync(root);
    for (const part of [".maquette", ".maquette/sessions"]) {
        const p = join(canonical, part);
        if (!existsSync(p))
            mkdirSync(p, { mode: 0o700 });
        const r = relative(canonical, realpathSync(p));
        if (r === ".." || r.startsWith(`..${sep}`))
            throw new Error(`Session directory escapes project: ${part}`);
    }
    chmodSync(join(canonical, ".maquette", "sessions"), 0o700);
    return join(canonical, ".maquette", "sessions");
}
function read(path, root) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
        throw new Error(`Session must be a regular file: ${path}`);
    const bytes = readFileSync(path);
    const last = bytes.lastIndexOf(10);
    const truncated = bytes.length > 0 && last !== bytes.length - 1;
    const valid = bytes.subarray(0, last + 1).toString("utf8");
    const records = (valid ? valid.slice(0, -1).split("\n") : []).map((line, i) => {
        return parseRecord(line, i, path);
    });
    if (records[0]?.type !== "header" || records[0].data.root !== realpathSync(root))
        throw new Error(`Session root/header mismatch: ${path}`);
    return { records, valid, truncated };
}
function parseRecord(line, i, path) {
    let r;
    try {
        r = JSON.parse(line);
    }
    catch {
        throw new Error(`Corrupt session ${path}, line ${i + 1}. Original preserved; inspect or restore a backup.`);
    }
    if (r.v !== 1)
        throw new Error(`Unsupported session version at ${path}:${i + 1}; use a compatible Maquette version.`);
    if (r.seq !== i + 1 || !kinds.has(r.type) || typeof r.at !== "string" || !r.data || typeof r.data !== "object")
        throw new Error(`Invalid session record at ${path}:${i + 1}.`);
    if (r.type === "message" && !validMessage(r.data))
        throw new Error(`Invalid message at ${path}:${i + 1}.`);
    if (r.type === "compact" && (!Array.isArray(r.data.messages) || !r.data.messages.every(validMessage)))
        throw new Error(`Invalid compact view at ${path}:${i + 1}.`);
    if (r.type === "notice" && r.data.ui && !validPresentation(r.data.ui))
        throw new Error(`Invalid presentation record at ${path}:${i + 1}. Original preserved.`);
    return r;
}
function validPresentation(event) {
    if (!event || typeof event.id !== "string")
        return false;
    if (event.kind === "end")
        return true;
    if (event.kind === "input")
        return typeof event.text === "string";
    if (event.kind === "answer" || event.kind === "tool") {
        if (!Number.isInteger(event.ref) || event.ref < 1)
            return false;
        return event.kind === "answer" || (typeof event.callId === "string" && typeof event.name === "string" && event.input && typeof event.input === "object" && !Array.isArray(event.input) && ["model", "prompt", "http", "mcp"].includes(event.source));
    }
    if (event.kind !== "item" || !event.item)
        return false;
    const item = event.item;
    if (item.kind === "shell")
        return typeof item.command === "string" && typeof item.output === "string" && (item.code === null || Number.isInteger(item.code));
    if (typeof item.text !== "string")
        return false;
    if (item.kind === "notice")
        return ["info", "warn", "error"].includes(item.level);
    return item.kind === "output" && typeof item.ok === "boolean" && (item.images === undefined || (Array.isArray(item.images) && item.images.every((p) => typeof p === "string")));
}
async function readAsync(path, root, progress) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`Session must be a regular file: ${path}`);
    const bytes = await readFile(path);
    const last = bytes.lastIndexOf(10);
    const valid = bytes.subarray(0, last + 1).toString("utf8");
    const lines = valid ? valid.slice(0, -1).split("\n") : [];
    const records = [];
    for (let i = 0; i < lines.length; i++) {
        records.push(parseRecord(lines[i], i, path));
        if (i % 64 === 0) {
            progress?.(i + 1, lines.length);
            await yieldLoop();
        }
    }
    if (records[0]?.type !== "header" || records[0].data.root !== realpathSync(root))
        throw new Error(`Session root/header mismatch: ${path}`);
    progress?.(lines.length, lines.length);
    return { records, valid, truncated: bytes.length > 0 && last !== bytes.length - 1 };
}
function locked(path) {
    try {
        const p = JSON.parse(readFileSync(`${path}.lock`, "utf8"));
        if (!Number.isInteger(p.pid) || p.pid < 1)
            return true;
        try {
            process.kill(p.pid, 0);
            return true;
        }
        catch (e) {
            return e.code !== "ESRCH";
        }
    }
    catch {
        return existsSync(`${path}.lock`);
    }
}
function metadata(id, path, records) {
    const first = records.find(r => r.type === "message" && r.data.role === "user")?.data.parts.find((p) => p.type === "text")?.text ?? "(empty)";
    const p = records.findLast(r => r.type === "provider")?.data ?? records[0].data;
    const title = sessionTitle(records);
    return { id, title, empty: title === "Empty conversation", locked: locked(path), date: records.at(-1).at, first: String(first).replace(/\s+/g, " ").slice(0, 90), provider: p.provider, model: p.model };
}
export async function listSessionsAsync(root) {
    const dir = directory(root);
    const out = [];
    for (const file of (await readdir(dir)).filter(f => f.endsWith(".jsonl"))) {
        const id = file.slice(0, -6), path = join(dir, file);
        try {
            const { records } = await readAsync(path, root);
            out.push(metadata(id, path, records));
        }
        catch (e) {
            out.push({ id, date: "", first: "", provider: "", model: "", error: e.message });
        }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
export class SessionJournal {
    id;
    path;
    records = [];
    warnings = [];
    #fd;
    #release;
    #closed = false;
    static async open(root, options, progress) {
        if (!options.resume)
            return new SessionJournal(root, options);
        const id = typeof options.resume === "string" ? options.resume : (await listSessionsAsync(root)).find(s => !s.error && !s.empty)?.id;
        if (!id || !idPattern.test(id))
            throw new Error("No resumable session here. Start a new conversation first.");
        const path = join(directory(root), `${id}.jsonl`);
        const release = acquireLock(`${path}.lock`);
        try {
            const prepared = await readAsync(path, root, progress);
            return new SessionJournal(root, { ...options, resume: id, prepared, release });
        }
        catch (e) {
            release();
            throw e;
        }
    }
    constructor(root, options) {
        const dir = directory(root);
        this.id = typeof options.resume === "string" ? options.resume : options.resume ? listSessions(root).find(s => !s.error)?.id ?? "" : randomUUID();
        if (!idPattern.test(this.id))
            throw new Error(options.resume ? "No resumable session here. Start maquette without --resume first, or choose an ID from /sessions." : "Invalid session ID.");
        this.path = join(dir, `${this.id}.jsonl`);
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
                    this.warnings.push(`Incomplete final line: original preserved at ${previous}; continuing recovered copy ${this.id}.`);
                }
            }
            this.#fd = openSync(this.path, options.resume ? "a" : "wx", 0o600);
            fchmodSync(this.#fd, 0o600);
            if (!options.resume)
                this.append("header", { root: realpathSync(root), id: this.id, appVersion: options.version ?? "0.1.0", provider: options.provider, model: options.model });
            if (this.warnings.length)
                this.append("recovered", { warnings: this.warnings });
            this.append("provider", { provider: options.provider, model: options.model });
        }
        catch (e) {
            this.#release();
            throw e;
        }
    }
    append(type, data) {
        if (this.#closed)
            throw new Error("Session journal is closed.");
        const r = { v: 1, seq: this.records.length + 1, at: new Date().toISOString(), type, data };
        const bytes = Buffer.from(`${JSON.stringify(r)}\n`);
        try {
            let offset = 0;
            while (offset < bytes.length)
                offset += writeSync(this.#fd, bytes, offset);
            fsyncSync(this.#fd);
            this.records.push(r);
        }
        catch {
            this.close();
            throw new Error(`Session journal write failed at ${this.path}; writer closed. Restart with --resume to recover before continuing.`);
        }
    }
    restore() {
        let messages = [];
        const pending = new Map();
        let activeCalls = [];
        let outcomes = new Map();
        let lastMessage = 0;
        const complete = () => {
            if (!activeCalls.length || !outcomes.size)
                return;
            messages.push({ role: "user", parts: activeCalls.filter(c => outcomes.has(c.id)).map(c => outcomes.get(c.id)) });
            activeCalls = [];
            outcomes.clear();
        };
        for (const r of this.records) {
            if (r.type === "message") {
                lastMessage = r.seq;
                // The committed group supersedes the per-call recovery view.
                if (r.data.role === "user" && r.data.parts.some((p) => p.type === "tool_result")) {
                    activeCalls = [];
                    outcomes.clear();
                }
                else
                    complete();
                messages.push(r.data);
                if (r.data.role === "assistant")
                    activeCalls = r.data.parts.filter((p) => p.type === "tool_call");
            }
            if (r.type === "compact") {
                messages = r.data.messages;
                activeCalls = [];
                outcomes.clear();
            }
            if (r.type === "call_start" || r.type === "shell_start")
                pending.set(r.data.id, r);
            if (r.type === "call_result" || r.type === "shell_result") {
                pending.delete(r.data.id);
                if (activeCalls.some(c => c.id === r.data.id)) {
                    const normalized = r.data.normalized ?? (r.data.reply ? { type: "tool_result", id: r.data.id, name: r.data.reply.tool, isError: !r.data.reply.ok,
                        content: [{ type: "text", text: `${r.data.reply.text}\n${(r.data.reply.images ?? []).map((p) => `image: ${p}`).join("\n")}` }] } : undefined);
                    if (normalized)
                        outcomes.set(r.data.id, normalized);
                }
            }
        }
        complete();
        // Direct effects after the last committed message are evidence, not instructions to replay.
        for (const r of this.records.filter(r => r.seq > lastMessage)) {
            if (r.type === "call_result" && r.data.reply?.source === "prompt")
                messages.push({ role: "user", parts: [{ type: "text", text: `Recovered direct call result (already executed; do not replay): ${r.data.reply.tool}: ${r.data.reply.text}` }] });
            if (r.type === "shell_result")
                messages.push({ role: "user", parts: [{ type: "text", text: `Recovered shell result (do not replay), exit ${r.data.code}: ${r.data.output}` }] });
        }
        const paired = pairedView(messages);
        return { messages: paired.messages, uncertain: paired.uncertain || pending.size > 0 };
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        closeSync(this.#fd);
        this.#release();
    }
}
export function listSessions(root) {
    const dir = directory(root);
    return readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(file => {
        const id = file.slice(0, -6);
        try {
            const { records } = read(join(dir, file), root);
            return metadata(id, join(dir, file), records);
        }
        catch (e) {
            return { id, date: "", first: "", provider: "", model: "", error: e.message };
        }
    }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
