// Claude, through the official Anthropic SDK. Each turn streams from the beta Messages API so
// it can carry adaptive thinking with an effort level, prompt caching, server-side
// compaction for long conversations, and a server-side fallback model when Claude declines
// on policy grounds. Claude's replies are kept whole (`native`) and sent back unchanged.
import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../settings.ts";
import { type AssistantMessage, type ChatEvent, type ChatRequest, type Message, type ModelInfo, type Provider, ProviderError, safeId, type StopReason, type ToolCallPart } from "./types.ts";

type Beta = Anthropic.Beta.Messages.BetaMessageParam;
type BetaBlock = Anthropic.Beta.Messages.BetaContentBlockParam;
type Options = Settings["providers"]["anthropic"];

export const defaultModel = "claude-opus-5-5";

// Models from before adaptive thinking (Claude 3, and the Claude 4 models before 4.6) take no
// adaptive thinking, effort or compaction. Every other model, newer ones included, gets them.
const legacy = /^(anthropic\.)?claude-(\d|instant)|^(anthropic\.)?claude-(opus|sonnet|haiku)-4(-[015])?([-@]\d{8})?$/;
export const isLegacy = (model: string) => legacy.test(model);

const stops: Record<string, StopReason> = { end_turn: "end", stop_sequence: "end", tool_use: "tool_use", max_tokens: "max_tokens", model_context_window_exceeded: "max_tokens", refusal: "refusal" };

// The conversation in the Messages API's form. Claude's own earlier replies go back exactly
// as they came; a reply from another provider is rebuilt from its parts.
export function toAnthropic(messages: Message[]): Beta[] {
  return messages.map((m): Beta => {
    if (m.role === "assistant") {
      if (m.native?.provider === "anthropic") return { role: "assistant", content: m.native.content as BetaBlock[] };
      const content: BetaBlock[] = m.parts.flatMap((p): BetaBlock[] =>
        p.type === "text" ? (p.text ? [{ type: "text", text: p.text }] : []) : [{ type: "tool_use", id: safeId(p.id), name: p.name, input: p.input }],
      );
      return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
    }
    // Tool results must come first in a user turn.
    const results = m.parts.filter((p) => p.type === "tool_result");
    const rest = m.parts.filter((p) => p.type !== "tool_result");
    const media = (p: { type: "text"; text: string } | { type: "image"; mediaType: string; data: string }) =>
      p.type === "text" ? ({ type: "text", text: p.text || " " } as const) : ({ type: "image", source: { type: "base64", media_type: p.mediaType as "image/png", data: p.data } } as const);
    const content: BetaBlock[] = [
      ...results.map((r): BetaBlock => ({ type: "tool_result", tool_use_id: safeId(r.id), content: r.content.map(media), ...(r.isError ? { is_error: true } : {}) })),
      ...rest.filter((p) => p.type !== "text" || p.text).map((p) => media(p)),
    ];
    return { role: "user", content };
  });
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  readonly vision = true;
  options: Options;
  #client?: Anthropic;

  constructor(model: string | undefined, options: Options) {
    this.model = model || defaultModel;
    this.options = options;
  }

  // Credentials: the variable named by apiKeyEnv when it isn't the SDK's own ANTHROPIC_API_KEY;
  // otherwise the SDK finds them (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile).
  get client(): Anthropic {
    if (this.#client) return this.#client;
    const key = this.options.apiKeyEnv !== "ANTHROPIC_API_KEY" ? process.env[this.options.apiKeyEnv] : undefined;
    try {
      this.#client = new Anthropic({ ...(key ? { apiKey: key } : {}), ...(this.options.baseUrl ? { baseURL: this.options.baseUrl } : {}) });
    } catch (e) {
      throw this.explain(e);
    }
    return this.#client;
  }

  params(request: ChatRequest) {
    const { effort, maxTokens, refusalFallback, compaction } = this.options;
    const modern = !isLegacy(this.model);
    const betas: string[] = [];
    if (refusalFallback) betas.push("server-side-fallback-2026-07-01");
    if (modern && compaction) betas.push("compact-2026-01-12");
    return {
      model: this.model,
      max_tokens: maxTokens,
      system: request.system,
      messages: toAnthropic(request.messages),
      ...(request.tools?.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: { type: "object" as const, ...t.inputSchema } })) } : {}),
      // Caches everything up to the last block, so each turn reads the one before from cache.
      cache_control: { type: "ephemeral" as const },
      // Summarised, so the thinking comes back readable: on some models the default leaves it out.
      ...(modern ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      ...(modern && effort !== "default" ? { output_config: { effort } } : {}),
      ...(refusalFallback ? { fallbacks: "default" as const } : {}),
      ...(modern && compaction ? { context_management: { edits: [{ type: "compact_20260112" as const }] } } : {}),
      ...(betas.length ? { betas } : {}),
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    let final: Anthropic.Beta.Messages.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(this.params(request), { signal: request.signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
        else if (event.type === "content_block_start") {
          const block = event.content_block as { type: string; from?: { model?: string }; to?: { model?: string } };
          if (block.type === "fallback") yield { type: "notice", text: `${block.from?.model ?? "The model"} declined; ${block.to?.model ?? "a fallback model"} continued.` };
          else if (block.type === "compaction") yield { type: "notice", text: "Earlier conversation was summarised to make room." };
        }
      }
      final = await stream.finalMessage();
    } catch (e) {
      throw this.explain(e);
    }
    const message: AssistantMessage = { role: "assistant", parts: [], native: { provider: "anthropic", content: final.content } };
    const thinking: string[] = [];
    for (const block of final.content) {
      if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
      else if (block.type === "text") message.parts.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        const call: ToolCallPart = { type: "tool_call", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
        message.parts.push(call);
        yield { type: "tool_call", call };
      }
    }
    const details = final.stop_details as { category?: string | null; explanation?: string | null } | null | undefined;
    const u = final.usage;
    yield {
      type: "done",
      message,
      stop: stops[final.stop_reason ?? ""] ?? "other",
      model: final.model,
      usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      ...(thinking.length ? { thinking: thinking.join("\n\n") } : {}),
      ...(final.stop_reason === "refusal" ? { detail: details?.explanation || (details?.category ? `category: ${details.category}` : undefined) } : {}),
    };
  }

  async models(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      for await (const m of this.client.models.list()) out.push({ id: m.id, name: m.display_name });
    } catch (e) {
      throw this.explain(e);
    }
    return out;
  }

  explain(e: unknown): Error {
    if (e instanceof Anthropic.APIUserAbortError) return e;
    // The API's own message, without the status and raw JSON the SDK wraps it in.
    const said = e instanceof Anthropic.APIError ? ((e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message) : "";
    const where = this.options.baseUrl ? ` at ${this.options.baseUrl}` : "";
    const keyHelp = `Set ${this.options.apiKeyEnv}${this.options.apiKeyEnv === "ANTHROPIC_API_KEY" ? "" : " (providers.anthropic.apiKeyEnv)"}, or run \`ant auth login\`.`;
    if (e instanceof Anthropic.AuthenticationError) return new ProviderError(`Anthropic didn't accept the credentials (401). ${keyHelp}`);
    if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError(`These credentials may not use ${this.model} (403): ${said}`);
    if (e instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic has no model "${this.model}" (404). \`maquette models\` lists them.`);
    if (e instanceof Anthropic.RateLimitError) return new ProviderError("Anthropic is rate-limiting these requests (429). Try again shortly.");
    if (e instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic refused the request (400): ${said}`);
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`Can't reach the Claude API${where}: ${e.message}`);
    if (e instanceof Anthropic.APIError) return new ProviderError(`The Claude API failed (${e.status ?? "no status"}): ${said}`);
    if (e instanceof Error && /resolve authentication method/.test(e.message)) return new ProviderError(`No Anthropic credentials found. ${keyHelp}`);
    return e instanceof Error ? e : new Error(String(e));
  }
}
