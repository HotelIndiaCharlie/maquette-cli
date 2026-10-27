// Any server that speaks the OpenAI chat completions API: Ollama, LM Studio, llama.cpp,
// vLLM, OpenRouter and most hosted models. This is how Maquette runs a local model. It
// streams POST {baseUrl}/chat/completions over server-sent events and lists models with
// GET {baseUrl}/models.
import type { Settings } from "../settings.ts";
import { type AssistantMessage, type ChatEvent, type ChatRequest, type ImagePart, type Message, type ModelInfo, type Provider, ProviderError, type StopReason, type ToolCallPart } from "./types.ts";

type Options = Settings["providers"]["openai-compatible"];
type Chat = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };

const stops: Record<string, StopReason> = { stop: "end", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

const imageNote = (p: ImagePart) => `[image${p.path ? ` ${p.path}` : ""} left out: this model is set up without vision (providers.openai-compatible.vision)]`;
const dataUrl = (p: ImagePart) => ({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });

// The conversation as chat completion messages. A tool result becomes a "tool" message right
// after the assistant's call; images can't go in those, so they follow in a user message.
export function toOpenAI(system: string, messages: Message[], vision: boolean): Chat[] {
  const out: Chat[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const calls = m.parts.filter((p) => p.type === "tool_call");
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
      continue;
    }
    const images: ImagePart[] = [];
    for (const r of m.parts) {
      if (r.type !== "tool_result") continue;
      const text = r.content.map((c) => (c.type === "text" ? c.text : vision ? `[image ${images.push(c)}${c.path ? `: ${c.path}` : ""}, shown below]` : imageNote(c))).join("\n");
      out.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${text}` : text });
    }
    const rest = m.parts.filter((p) => p.type !== "tool_result");
    if (vision) images.push(...rest.filter((p) => p.type === "image"));
    const texts = rest.flatMap((p) => (p.type === "text" ? [p.text] : vision ? [] : [imageNote(p)]));
    if (!images.length && !texts.length) continue;
    if (!images.length) out.push({ role: "user", content: texts.join("\n\n") });
    else out.push({ role: "user", content: [...texts.map((text) => ({ type: "text", text })), ...images.map(dataUrl)] });
  }
  return out;
}

// The data of each server-sent event in a response body.
export async function* events(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(buffer[5] === " " ? 6 : 5).replace(/\r$/, ""));
  if (data.length) yield data.join("\n");
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";
  readonly model: string;
  options: Options;

  constructor(model: string | undefined, options: Options) {
    this.model = model ?? "";
    this.options = options;
  }

  get base() {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const key = process.env[this.options.apiKeyEnv];
    const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) };
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, headers });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      const code = (e as { cause?: { code?: string } }).cause?.code;
      throw new ProviderError(
        code === "ECONNREFUSED"
          ? `Nothing is answering at ${this.base}. Start the model server (Ollama, LM Studio, llama.cpp, …), or point Maquette at it: maquette config set providers.openai-compatible.baseUrl <url>`
          : `Can't reach ${this.base}: ${(e as Error).message}`,
      );
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error?.message ?? json.error ?? json.message ?? text;
    } catch {}
    message = String(message).trim().slice(0, 500) || res.statusText;
    if (res.status === 401 || res.status === 403) throw new ProviderError(`${this.base} didn't accept the key (${res.status}): ${message}. Set ${this.options.apiKeyEnv} (providers.openai-compatible.apiKeyEnv).`);
    if (res.status === 404 && path === "/chat/completions") throw new ProviderError(`${this.base} has no model "${this.model}" (404): ${message}. \`maquette models\` lists them.`);
    if (/tool/i.test(message) && /support/i.test(message)) throw new ProviderError(`${this.model} can't call tools, which Maquette needs (${res.status}: ${message}). Pick a model that supports tool calling.`);
    throw new ProviderError(`${this.base}${path} failed (${res.status}): ${message}`);
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (!this.model) throw new ProviderError("No model is set for the openai-compatible provider. `maquette models` lists what the server offers; then: maquette config set model <id>");
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
    let finish = "";
    let model = this.model;
    let usage: { input: number; output: number } | undefined;
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const data of events(res.body!)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.base} reported an error mid-reply: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const at = calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" };
        if (tc.id) at.id = tc.id;
        if (tc.function?.name) at.name += tc.function.name;
        const args = tc.function?.arguments;
        if (args !== undefined && args !== null) at.args += typeof args === "string" ? args : JSON.stringify(args);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const message: AssistantMessage = { role: "assistant", parts: text ? [{ type: "text", text }] : [] };
    for (const [i, c] of calls.entries()) {
      if (!c) continue;
      const call: ToolCallPart = { type: "tool_call", id: c.id || `call_${i}`, name: c.name, input: {} };
      try {
        const input = JSON.parse(c.args || "{}");
        if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("not a JSON object");
        call.input = input;
      } catch (e) {
        call.error = `The arguments weren't a JSON object (${(e as Error).message}): ${c.args.slice(0, 200)}`;
      }
      message.parts.push(call);
      yield { type: "tool_call", call };
    }
    const stop = calls.length && (finish === "stop" || !finish) ? "tool_use" : (stops[finish] ?? (finish ? "other" : "end"));
    yield { type: "done", message, stop, model, ...(usage ? { usage } : {}) };
  }

  async models(): Promise<ModelInfo[]> {
    const json = (await (await this.request("/models")).json()) as { data?: { id: string }[]; models?: { name: string }[] };
    return (json.data ?? json.models?.map((m) => ({ id: m.name })) ?? []).map((m) => ({ id: m.id }));
  }
}
