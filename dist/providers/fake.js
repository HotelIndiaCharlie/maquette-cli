export class FakeProvider {
    name = "fake";
    model = "fake";
    vision = true;
    requests = [];
    turns;
    count = 0;
    constructor(turns) {
        this.turns = [...turns];
    }
    async *chat(request) {
        this.requests.push(structuredClone({ ...request, signal: undefined }));
        const turn = this.turns.shift() ?? { text: "" };
        const message = { role: "assistant", parts: [] };
        if (turn.text) {
            for (const piece of turn.text.match(/\S+\s*|\s+/g) ?? [])
                yield { type: "text", text: piece };
            message.parts.push({ type: "text", text: turn.text });
        }
        for (const c of turn.calls ?? []) {
            const call = { type: "tool_call", id: `fake_${++this.count}`, name: c.name, input: c.input ?? {} };
            message.parts.push(call);
            yield { type: "tool_call", call };
        }
        const stop = turn.stop ?? (turn.calls?.length ? "tool_use" : "end");
        yield { type: "done", message, stop, model: this.model, usage: { input: 0, output: 0 }, ...(turn.thinking ? { thinking: turn.thinking } : {}) };
    }
    async models() {
        return [{ id: "fake" }];
    }
}
