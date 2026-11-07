// Request views are separate from the immutable committed journal.
export function providerView(messages, provider, model) {
    return messages.map(m => m.role === "assistant" && m.native && (m.native.provider !== provider || m.native.model !== model)
        ? { role: "assistant", parts: m.parts } : m);
}
export function pairedView(messages) {
    const out = [];
    let pending = [];
    let uncertain = false;
    const complete = () => {
        if (!pending.length)
            return;
        uncertain = true;
        out.push({ role: "user", parts: pending.map(c => ({ type: "tool_result", id: c.id, name: c.name, isError: true,
                content: [{ type: "text", text: "Outcome unknown: no durable result. This call must not be replayed. Inspect current state before continuing." }] })) });
        pending = [];
    };
    for (const m of messages) {
        const results = m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [];
        if (pending.length && results.length && m.role === "user") {
            const ids = new Set(results.map(r => r.id));
            const missing = pending.filter(c => !ids.has(c.id));
            uncertain ||= missing.length > 0;
            out.push({ ...m, parts: [...m.parts, ...missing.map(c => ({ type: "tool_result", id: c.id, name: c.name, isError: true,
                        content: [{ type: "text", text: "Outcome unknown: no durable result. Do not replay; inspect current state." }] }))] });
            pending = [];
            continue;
        }
        complete();
        out.push(m);
        if (m.role === "assistant")
            pending = m.parts.filter((p) => p.type === "tool_call");
    }
    complete();
    return { messages: out, uncertain };
}
// A cut can precede a user turn, but never split a native assistant and its results.
export function compactBoundary(messages, keep = 6) {
    const desired = Math.max(0, messages.length - keep);
    for (let i = desired; i > 0; i--) {
        if (messages[i].role === "user" && !messages[i].parts.some(p => p.type === "tool_result"))
            return i;
    }
    return 0;
}
