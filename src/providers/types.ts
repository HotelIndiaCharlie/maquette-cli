// What Maquette needs from a model provider: one streamed turn of a conversation at a time,
// with tools the model may call and images it may look at, plus the list of models on offer.
// Messages are kept in this neutral form so a conversation can move between providers;
// a provider's own reply is also kept as it came (`native`) and sent back to that provider
// unchanged, so nothing it relies on, such as thinking or compaction blocks, is lost.

export type TextPart = { type: "text"; text: string };
// Base64 image data. `path` is where it came from, for a note when a model can't see images.
export type ImagePart = { type: "image"; mediaType: string; data: string; path?: string };
// `error` is set when the model's arguments weren't valid JSON; `input` is then empty.
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; error?: string };
export type ToolResultPart = { type: "tool_result"; id: string; name: string; content: (TextPart | ImagePart)[]; isError?: boolean };

export type Native = { provider: string; content: unknown };
export type UserMessage = { role: "user"; parts: (TextPart | ImagePart | ToolResultPart)[] };
export type AssistantMessage = { role: "assistant"; parts: (TextPart | ToolCallPart)[]; native?: Native };
export type Message = UserMessage | AssistantMessage;

export type ToolSpec = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type ChatRequest = { system: string; messages: Message[]; tools?: ToolSpec[]; signal?: AbortSignal };

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
// end: the model finished; tool_use: it wants its tool calls run; max_tokens: it was cut off;
// refusal: it declined.
export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export type ChatEvent =
  | { type: "text"; text: string } // more of the reply, as it's written
  | { type: "notice"; text: string } // something the person should know, such as a fallback model taking over
  | { type: "tool_call"; call: ToolCallPart } // a complete tool call, after the reply is done
  | { type: "done"; message: AssistantMessage; stop: StopReason; model: string; usage?: Usage; detail?: string };

export type ModelInfo = { id: string; name?: string };

export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
  models(): Promise<ModelInfo[]>;
}

// A failure worth showing as is: no key, no such model, nothing listening at the address.
export class ProviderError extends Error {}

// The text of an assistant message.
export const textOf = (message: AssistantMessage) => message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

// Tool call ids must match ^[A-Za-z0-9_-]+$ for Anthropic; other providers are looser.
export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
