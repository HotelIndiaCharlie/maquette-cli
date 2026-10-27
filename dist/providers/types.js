// What Maquette needs from a model provider: one streamed turn of a conversation at a time,
// with tools the model may call and images it may look at, plus the list of models on offer.
// Messages are kept in this neutral form so a conversation can move between providers;
// a provider's own reply is also kept as it came (`native`) and sent back to that provider
// unchanged, so nothing it relies on, such as thinking or compaction blocks, is lost.
// A failure worth showing as is: no key, no such model, nothing listening at the address.
export class ProviderError extends Error {
}
// The text of an assistant message.
export const textOf = (message) => message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
// Tool call ids must match ^[A-Za-z0-9_-]+$ for Anthropic; other providers are looser.
export const safeId = (id) => id.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
