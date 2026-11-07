// Callback-free presentation metadata. Never used as provider history or executed on replay.
import type { SessionRecord } from "./sessions.ts";
import type { Source } from "../server.ts";
export type Activity = { id: string; kind: string; label: string; interruptible: boolean; stopping?: boolean; progress?: { current: number; total: number }; queued: number };
export type DisplayTool = { kind: "tool"; id: string; name: string; input: Record<string, unknown>; source: Source; done: boolean; ok?: boolean; text?: string; images?: string[]; ms?: number; expanded?: boolean; calls?: DisplayTool[] };
export type DisplayItem = { kind: "user"; text: string } | { kind: "answer"; text: string } | DisplayTool | { kind: "shell"; command: string; output: string; code: number | null } | { kind: "output"; text: string; ok: boolean; images?: string[] } | { kind: "notice"; text: string; level: "info" | "warn" | "error" };
export type SessionView = { id?: string; title: string; warnings: string[]; items: DisplayItem[]; restored: number; legacy: boolean };
// Presentation only: never skip a call or alter its recorded/provider result. Non-tool
// items (including each new user input) are boundaries, as are errors and images.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function collapseTools<T extends { kind: string }>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    const a = previous as unknown as DisplayTool | undefined, b = item as unknown as DisplayTool;
    if (a?.kind === "tool" && b.kind === "tool" && a.done && b.done && a.ok && b.ok && !a.images?.length && !b.images?.length && a.name === b.name && a.source === b.source && a.text === b.text && stable(a.input) === stable(b.input)) {
      result[result.length - 1] = { ...a, ms: a.ms === undefined && b.ms === undefined ? undefined : (a.ms ?? 0) + (b.ms ?? 0), calls: [...(a.calls ?? [a]), ...(b.calls ?? [b])] } as unknown as T;
    } else result.push(item);
  }
  return result;
}
export function titleFromInput(text: string, kind: string): string | undefined {
  if (kind === "command" || kind === "exit") return undefined;
  if (kind === "slash" && !/^\/(init|report-review|designcraft|chart)(\s|$)/.test(text)) return undefined;
  let title = text.trim().split(/\r?\n/, 1)[0].replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ");
  if (/^\/init(?:\s|$)/.test(title)) title = title.replace(/^\/init/, "Initialize project");
  if (!title) return undefined;
  const chars = [...title]; if (chars.length > 60) title = chars.slice(0, 59).join("").replace(/\s+\S*$/, "") + "…";
  return title;
}
export function legacyInput(text: string): string {
  if (text.startsWith("The person typed /init.")) return "/init";
  const skill = /^The person invoked \/([a-z0-9-]+)\./.exec(text); if (skill) return `/${skill[1]}`;
  const direct = /^The person ran `([^`]+)` (?:at the prompt|in the shell)/.exec(text); if (direct) return direct[1];
  if (/^(Shared runtime notice:|MAQUETTE.md changed|MAQUETTE.md was removed|Continuation summary|Result of `maquette call )/.test(text)) return "";
  return text;
}
function legacyUser(parts: any[]): string {
  const input = parts.filter(p => p.type === "text").map(p => legacyInput(p.text)).filter(Boolean).join("\n");
  return rawDirect(parts)?.shell ? `!${input}` : input;
}
export function sessionTitle(records: SessionRecord[]): string {
  const named = records.find(r => r.type === "notice" && typeof r.data.sessionTitle === "string");
  if (named) return named.data.sessionTitle;
  for (const r of records) {
    if (r.type === "message" && r.data.role === "user" && !r.data.parts.some((p: any) => p.type === "tool_result")) {
      const text = legacyUser(r.data.parts);
      const skill = r.data.parts.some((p: any) => p.type === "text" && /^The person invoked \//.test(p.text));
      const title = titleFromInput(text, skill ? "skill" : text.startsWith("/") ? "slash" : "message"); if (title) return title;
    }
  }
  return "Empty conversation";
}
export function restorePresentation(records: SessionRecord[], count = 10): Pick<SessionView, "items" | "restored" | "legacy"> {
  const ui = records.filter(r => r.type === "notice" && r.data.ui);
  if (ui.some(r => r.data.ui.kind === "input")) {
    const completed = new Set(ui.filter(r => r.data.ui.kind === "end").map(r => r.data.ui.id));
    const inputs = ui.filter(r => r.data.ui.kind === "input" && completed.has(r.data.ui.id)).slice(-count);
    const ids = new Set(inputs.map(r => r.data.ui.id)); const items: DisplayItem[] = [];
    const bySeq = new Map(records.map(r => [r.seq, r]));
    for (const r of ui) {
      const event = r.data.ui; if (!ids.has(event.id)) continue;
      if (event.kind === "input") items.push({ kind: "user", text: event.text });
      else if (event.kind === "item") items.push(event.item);
      else if (event.kind === "answer") {
        const m = bySeq.get(event.ref)?.data; const text = m?.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
        if (text) items.push({ kind: "answer", text });
      } else if (event.kind === "tool") {
        const result = bySeq.get(event.ref)?.data; const reply = result?.reply; const normalized = result?.normalized;
        items.push({ kind: "tool", id: event.callId, name: event.name, input: event.input, source: event.source, done: true, ok: reply?.ok ?? !normalized?.isError, text: reply?.text ?? normalized?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"), images: reply?.images ?? [], ms: reply?.ms ?? 0 });
      }
    }
    const previous = inputs.length < count ? restoreLegacy(records.filter(r => r.seq < ui.find(r => r.data.ui.kind === "input")!.seq)).slice(-(count - inputs.length)) : [];
    return { items: [...previous.flat(), ...items], restored: previous.length + inputs.length, legacy: previous.length > 0 };
  }
  const groups = restoreLegacy(records).slice(-count);
  return { items: groups.flat(), restored: groups.length, legacy: true };
}
// Older journals have no exact UI log. Recover normalized visible facts, keeping direct
// results with the prompt summary committed after them, rather than the preceding turn.
function restoreLegacy(records: SessionRecord[]): DisplayItem[][] {
  const starts = new Map<string, any>();
  let pending: DisplayItem[] = [];
  const groups: DisplayItem[][] = []; let group: DisplayItem[] | undefined;
  for (const r of records) {
    if (r.type === "message") {
      const m = r.data;
      if (m.role === "user" && !m.parts.some((p: any) => p.type === "tool_result")) {
        const input = legacyUser(m.parts);
        if (input) {
          const direct = rawDirect(m.parts);
          group = [{ kind: "user", text: input }];
          if (direct) { group.push(...pending); pending = []; }
          groups.push(group);
        }
      } else if (m.role === "assistant") {
        const text = m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""); if (text) group?.push({ kind: "answer", text });
      }
    } else if (r.type === "call_start" || r.type === "shell_start") starts.set(r.data.id, r.data);
    else if (r.type === "call_result") {
      const reply = r.data.reply, normalized = r.data.normalized, start = starts.get(r.data.id);
      if (reply || normalized) {
        const item: DisplayTool = { kind: "tool", id: r.data.id, name: reply?.tool ?? normalized.name, input: start?.args ?? {}, source: reply?.source ?? "model", done: true, ok: reply?.ok ?? !normalized?.isError, text: reply?.text ?? normalized.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"), images: reply?.images ?? [], ms: reply?.ms };
        if (reply?.source === "prompt") pending.push(item); else group?.push(item);
      }
    } else if (r.type === "shell_result") {
      pending.push({ kind: "shell", command: starts.get(r.data.id)?.command ?? "(saved command)", output: r.data.output, code: r.data.code });
    }
  }
  return groups;
}
function rawDirect(parts: any[]): { shell: boolean } | undefined {
  const text = parts.filter(p => p.type === "text").map(p => p.text).join("\n");
  const match = /^The person ran `[^`]+` (at the prompt|in the shell)/.exec(text);
  return match ? { shell: match[1] === "in the shell" } : undefined;
}
