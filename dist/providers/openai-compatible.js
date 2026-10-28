import { ProviderError } from "./types.js";
const stops = { stop: "end", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };
const imageNote = (p) => `[image${p.path ? ` ${p.path}` : ""} left out: this model is set up without vision (providers.openai-compatible.vision)]`;
const dataUrl = (p) => ({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
// The conversation as chat completion messages. A tool result becomes a "tool" message right
// after the assistant's call; images can't go in those, so they follow in a user message.
export function toOpenAI(system, messages, vision) {
    const out = system ? [{ role: "system", content: system }] : [];
    for (const m of messages) {
        if (m.role === "assistant") {
            const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
            const calls = m.parts.filter((p) => p.type === "tool_call");
            out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
            continue;
        }
        const images = [];
        for (const r of m.parts) {
            if (r.type !== "tool_result")
                continue;
            const text = r.content.map((c) => (c.type === "text" ? c.text : vision ? `[image ${images.push(c)}${c.path ? `: ${c.path}` : ""}, shown below]` : imageNote(c))).join("\n");
            out.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${text}` : text });
        }
        const rest = m.parts.filter((p) => p.type !== "tool_result");
        if (vision)
            images.push(...rest.filter((p) => p.type === "image"));
        const texts = rest.flatMap((p) => (p.type === "text" ? [p.text] : vision ? [] : [imageNote(p)]));
        if (!images.length && !texts.length)
            continue;
        if (!images.length)
            out.push({ role: "user", content: texts.join("\n\n") });
        else
            out.push({ role: "user", content: [...texts.map((text) => ({ type: "text", text })), ...images.map(dataUrl)] });
    }
    return out;
}
// The data of each server-sent event in a response body.
export async function* events(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    let data = [];
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line === "") {
                if (data.length)
                    yield data.join("\n");
                data = [];
            }
            else if (line.startsWith("data:"))
                data.push(line.slice(line[5] === " " ? 6 : 5));
        }
    }
    if (buffer.startsWith("data:"))
        data.push(buffer.slice(buffer[5] === " " ? 6 : 5).replace(/\r$/, ""));
    if (data.length)
        yield data.join("\n");
}
// Some servers send a reasoning model's thinking inside the text, between <think> and </think>,
// rather than in a field of its own. This takes it out as the text streams in, holding back the
// end of a piece that could be the start of a tag split across two pieces.
export class ThinkSplitter {
    #inside = false;
    #held = "";
    push(piece) {
        let rest = this.#held + piece;
        this.#held = "";
        let text = "";
        let thinking = "";
        for (;;) {
            const tag = this.#inside ? "</think>" : "<think>";
            const at = rest.indexOf(tag);
            const end = at >= 0 ? at : rest.length - partialTag(rest, tag);
            if (this.#inside)
                thinking += rest.slice(0, end);
            else
                text += rest.slice(0, end);
            if (at < 0) {
                this.#held = rest.slice(end);
                return { text, thinking };
            }
            this.#inside = !this.#inside;
            rest = rest.slice(at + tag.length);
        }
    }
    // What's still held back once the reply is over.
    flush() {
        const held = this.#held;
        this.#held = "";
        return this.#inside ? { text: "", thinking: held } : { text: held, thinking: "" };
    }
}
// How many characters at the end of `s` could begin `tag`.
function partialTag(s, tag) {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--)
        if (tag.startsWith(s.slice(-n)))
            return n;
    return 0;
}
export class OpenAICompatibleProvider {
    name = "openai-compatible";
    model;
    options;
    constructor(model, options) {
        this.model = model ?? "";
        this.options = options;
    }
    // From the settings: when false, images are left out with a note.
    get vision() {
        return this.options.vision;
    }
    get base() {
        return this.options.baseUrl.replace(/\/+$/, "");
    }
    async request(path, init = {}) {
        const key = process.env[this.options.apiKeyEnv];
        const headers = { ...(init.body ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) };
        let res;
        try {
            res = await fetch(`${this.base}${path}`, { ...init, headers });
        }
        catch (e) {
            if (e.name === "AbortError")
                throw e;
            const code = e.cause?.code;
            throw new ProviderError(code === "ECONNREFUSED"
                ? `Nothing is answering at ${this.base}. Start the model server (Ollama, LM Studio, llama.cpp, …), or point Maquette at it: maquette config set providers.openai-compatible.baseUrl <url>`
                : `Can't reach ${this.base}: ${e.message}`);
        }
        if (res.ok)
            return res;
        const text = await res.text().catch(() => "");
        let message = text;
        try {
            const json = JSON.parse(text);
            message = json.error?.message ?? json.error ?? json.message ?? text;
        }
        catch { }
        message = String(message).trim().slice(0, 500) || res.statusText;
        if (res.status === 401 || res.status === 403)
            throw new ProviderError(`${this.base} didn't accept the key (${res.status}): ${message}. Set ${this.options.apiKeyEnv} (providers.openai-compatible.apiKeyEnv).`);
        if (res.status === 404 && path === "/chat/completions")
            throw new ProviderError(`${this.base} has no model "${this.model}" (404): ${message}. \`maquette models\` lists them.`);
        if (/tool/i.test(message) && /support/i.test(message))
            throw new ProviderError(`${this.model} can't call tools, which Maquette needs (${res.status}: ${message}). Pick a model that supports tool calling.`);
        throw new ProviderError(`${this.base}${path} failed (${res.status}): ${message}`);
    }
    async *chat(request) {
        if (!this.model)
            throw new ProviderError("No model is set for the openai-compatible provider. `maquette models` lists what the server offers; then: maquette config set model <id>");
        const tools = request.tools ?? [];
        const body = {
            model: this.model,
            messages: toOpenAI(request.system, request.messages, this.options.vision),
            stream: true,
            stream_options: { include_usage: true },
            ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })) } : {}),
            ...(this.options.maxTokens ? { max_tokens: this.options.maxTokens } : {}),
        };
        const res = await this.request("/chat/completions", { method: "POST", body: JSON.stringify(body), signal: request.signal });
        let text = "";
        let thinking = "";
        let finish = "";
        let model = this.model;
        let usage;
        const split = new ThinkSplitter();
        // The visible text, without the blank lines a model leaves after its thinking.
        const visible = function* (piece) {
            const out = text ? piece : piece.trimStart();
            if (!out)
                return;
            text += out;
            yield { type: "text", text: out };
        };
        const calls = [];
        for await (const data of events(res.body)) {
            if (data === "[DONE]")
                break;
            let chunk;
            try {
                chunk = JSON.parse(data);
            }
            catch {
                continue;
            }
            if (chunk.error)
                throw new ProviderError(`${this.base} reported an error mid-reply: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
            if (chunk.model)
                model = chunk.model;
            if (chunk.usage) {
                const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens;
                usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0, ...(reasoning ? { reasoning } : {}) };
            }
            const choice = chunk.choices?.[0];
            if (!choice)
                continue;
            const delta = choice.delta ?? {};
            // Reasoning in a field of its own: reasoning_content from llama.cpp, LM Studio, vLLM and
            // DeepSeek; reasoning from Ollama, OpenRouter and newer vLLM.
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === "string")
                thinking += reasoning;
            if (typeof delta.content === "string" && delta.content) {
                const piece = split.push(delta.content);
                thinking += piece.thinking;
                yield* visible(piece.text);
            }
            for (const tc of delta.tool_calls ?? []) {
                const at = calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" };
                if (tc.id)
                    at.id = tc.id;
                if (tc.function?.name)
                    at.name += tc.function.name;
                const args = tc.function?.arguments;
                // A string is a piece of the JSON, to append; an object (as Ollama sends) is the whole
                // set of arguments, so it replaces what came before rather than being glued on.
                if (typeof args === "string")
                    at.args += args;
                else if (args !== undefined && args !== null)
                    at.args = JSON.stringify(args);
            }
            if (choice.finish_reason)
                finish = choice.finish_reason;
        }
        const last = split.flush();
        thinking += last.thinking;
        yield* visible(last.text);
        const message = { role: "assistant", parts: text ? [{ type: "text", text }] : [] };
        for (const [i, c] of calls.entries()) {
            if (!c)
                continue;
            const call = { type: "tool_call", id: c.id || `call_${i}`, name: c.name, input: {} };
            try {
                const input = JSON.parse(c.args || "{}");
                if (typeof input !== "object" || input === null || Array.isArray(input))
                    throw new Error("not a JSON object");
                call.input = input;
            }
            catch (e) {
                call.error = `The arguments weren't a JSON object (${e.message}): ${c.args.slice(0, 200)}`;
            }
            message.parts.push(call);
            yield { type: "tool_call", call };
        }
        const stop = calls.length && (finish === "stop" || !finish) ? "tool_use" : (stops[finish] ?? (finish ? "other" : "end"));
        yield { type: "done", message, stop, model, ...(usage ? { usage } : {}), ...(thinking.trim() ? { thinking: thinking.trim() } : {}) };
    }
    async models() {
        const json = (await (await this.request("/models")).json());
        const ids = json.data?.map((m) => m?.id) ?? json.models?.map((m) => m?.name) ?? [];
        // Some local servers list entries without an id; those can't be chosen, so they're left out.
        return ids.filter((id) => typeof id === "string" && id.length > 0).map((id) => ({ id }));
    }
}
