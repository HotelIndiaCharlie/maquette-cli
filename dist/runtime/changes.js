export class ChangeRing {
    runtime;
    sequence = 0;
    #events = [];
    constructor(runtime) { this.runtime = runtime; }
    append(event) {
        this.#events.push({ ...event, seq: ++this.sequence, at: new Date().toISOString() });
        if (this.#events.length > 1000)
            this.#events.shift();
    }
    since(cursor) {
        const gap = !!cursor && (cursor.runtime !== this.runtime || cursor.after > this.sequence || cursor.after < (this.#events[0]?.seq ?? 1) - 1);
        return { runtime: this.runtime, sequence: this.sequence, gap, changes: cursor && !gap ? this.#events.filter(e => e.seq > cursor.after) : [] };
    }
}
