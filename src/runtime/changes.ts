import type { Source } from "../server.ts";
export type ChangeCursor = { runtime: string; after: number };
export type Change = { seq: number; at: string; caller: string; own?: boolean; tool: string; source: Source; scope: "designcraft" | "workspace" | "external"; server?: string };
export type ChangeFeed = { runtime: string; sequence: number; gap: boolean; changes: Change[] };
export class ChangeRing {
  runtime: string;
  sequence = 0;
  #events: (Change & { author: string })[] = [];
  #labels = new Map<string, string>();
  #counts = new Map<string, number>();
  #nextLabel = 0;
  constructor(runtime: string) { this.runtime = runtime; }
  append(event: Omit<Change, "seq" | "at">) {
    let label = this.#labels.get(event.caller);
    if (!label) { label = `${event.source === "mcp" ? "mcp" : event.source === "http" && !event.caller.startsWith("terminal:") ? "http" : "terminal"}#${++this.#nextLabel}`; this.#labels.set(event.caller, label); }
    this.#counts.set(event.caller, (this.#counts.get(event.caller) ?? 0) + 1);
    this.#events.push({ ...event, author: event.caller, caller: label, seq: ++this.sequence, at: new Date().toISOString() });
    if (this.#events.length > 1000) {
      const oldest = this.#events.shift()!.author, count = this.#counts.get(oldest)! - 1;
      if (count) this.#counts.set(oldest, count); else { this.#counts.delete(oldest); this.#labels.delete(oldest); }
    }
  }
  since(cursor?: ChangeCursor, caller?: string): ChangeFeed {
    const gap = !!cursor && (cursor.runtime !== this.runtime || cursor.after > this.sequence || cursor.after < (this.#events[0]?.seq ?? 1) - 1);
    return { runtime: this.runtime, sequence: this.sequence, gap, changes: cursor && !gap ? this.#events.filter(e => e.seq > cursor.after).map(({ author, ...e }) => ({ ...e, own: author === caller })) : [] };
  }
}
