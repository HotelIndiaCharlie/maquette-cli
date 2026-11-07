import type { Source } from "../server.ts";
export type ChangeCursor = { runtime: string; after: number };
export type Change = { seq: number; at: string; caller: string; tool: string; source: Source; scope: "designcraft" | "workspace" | "external"; server?: string };
export type ChangeFeed = { runtime: string; sequence: number; gap: boolean; changes: Change[] };
export class ChangeRing {
  runtime: string;
  sequence = 0;
  #events: Change[] = [];
  constructor(runtime: string) { this.runtime = runtime; }
  append(event: Omit<Change, "seq" | "at">) {
    this.#events.push({ ...event, seq: ++this.sequence, at: new Date().toISOString() });
    if (this.#events.length > 1000) this.#events.shift();
  }
  since(cursor?: ChangeCursor): ChangeFeed {
    const gap = !!cursor && (cursor.runtime !== this.runtime || cursor.after > this.sequence || cursor.after < (this.#events[0]?.seq ?? 1) - 1);
    return { runtime: this.runtime, sequence: this.sequence, gap, changes: cursor && !gap ? this.#events.filter(e => e.seq > cursor.after) : [] };
  }
}
