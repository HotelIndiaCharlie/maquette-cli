import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AnthropicProvider, isLegacy, toAnthropic } from "../../src/providers/anthropic.ts";
import { type ChatEvent, ProviderError } from "../../src/providers/types.ts";
import { closeAll, closedPort, drain, json, mock, sse } from "./mock.ts";

after(closeAll);

const options = (baseUrl: string, more = {}) => ({ apiKeyEnv: "MAQUETTE_TEST_ANTHROPIC_KEY", baseUrl, effort: "high" as const, maxTokens: 64000, refusalFallback: true, compaction: true, ...more });
process.env.MAQUETTE_TEST_ANTHROPIC_KEY = "sk-ant-test";

const reply = (model: string, blocks: { start: object; deltas: object[] }[], stop: string, extra = {}) => [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } } },
  ...blocks.flatMap((b, index) => [{ type: "content_block_start", index, content_block: b.start }, ...b.deltas.map((delta) => ({ type: "content_block_delta", index, delta })), { type: "content_block_stop", index }]),
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

const thinking = { start: { type: "thinking", thinking: "", signature: "" }, deltas: [{ type: "signature_delta", signature: "sig123" }] };
const text = (...parts: string[]) => ({ start: { type: "text", text: "" }, deltas: parts.map((t) => ({ type: "text_delta", text: t })) });
const toolUse = { start: { type: "tool_use", id: "toolu_01", name: "render_page", input: {} }, deltas: [{ type: "input_json_delta", partial_json: '{"pa' }, { type: "input_json_delta", partial_json: 'ge": 0}' }] };

test("streams a turn with adaptive thinking, effort, caching, compaction and fallback, and replays it unchanged", async () => {
  const server = await mock((_, res) => sse(res, reply("claude-opus-5-5", [thinking, text("Rendering ", "page one."), toolUse], "tool_use"), true));
  const provider = new AnthropicProvider(undefined, options(server.url));
  const tools = [{ name: "render_page", description: "Renders a page.", inputSchema: { type: "object", properties: { page: { type: "integer" } } } }];
  const system = [{ name: "core", text: "You are Maquette.", cache: true }, { name: "environment", text: "In /tmp.", cache: true }, { name: "project", text: "No memory yet." }];
  const events: ChatEvent[] = await drain(provider.chat({ system, messages: [{ role: "user", parts: [{ type: "text", text: "Show me page one" }] }], tools }));

  const [req] = server.seen;
  assert.equal(req.url, "/v1/messages");
  assert.equal(req.headers["anthropic-beta"], "server-side-fallback-2026-07-01,compact-2026-01-12");
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.max_tokens, 64000);
  // A text block each, with a cache breakpoint on the stable ones only.
  assert.deepEqual(req.body.system, [
    { type: "text", text: "You are Maquette.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "In /tmp.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "No memory yet." },
  ]);
  assert.deepEqual(req.body.thinking, { type: "adaptive" });
  assert.deepEqual(req.body.output_config, { effort: "high" });
  assert.deepEqual(req.body.cache_control, { type: "ephemeral" });
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.context_management, { edits: [{ type: "compact_20260112" }] });
  assert.deepEqual(req.body.tools, [{ name: "render_page", description: "Renders a page.", input_schema: tools[0].inputSchema }]);
  assert.equal(req.body.temperature, undefined);

  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["Rendering ", "page one."]);
  const call = { type: "tool_call", id: "toolu_01", name: "render_page", input: { page: 0 } };
  assert.deepEqual(events.find((e) => e.type === "tool_call"), { type: "tool_call", call });
  const done = events.at(-1);
  assert.ok(done?.type === "done");
  assert.equal(done.stop, "tool_use");
  assert.equal(done.model, "claude-opus-5-5");
  assert.deepEqual(done.usage, { input: 900, output: 42, cacheRead: 4000, cacheWrite: 0 });
  assert.deepEqual(done.message.parts, [{ type: "text", text: "Rendering page one." }, call]);

  // The next turn sends the reply back block for block, thinking signature included.
  await drain(provider.chat({ system: [{ name: "core", text: "You are Maquette." }], messages: [{ role: "user", parts: [{ type: "text", text: "Show me page one" }] }, done.message, { role: "user", parts: [{ type: "tool_result", id: "toolu_01", name: "render_page", content: [{ type: "text", text: "Rendered." }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] }] }] }));
  const [, second] = server.seen;
  assert.deepEqual(second.body.messages[1].content, [
    { type: "thinking", thinking: "", signature: "sig123" },
    { type: "text", text: "Rendering page one." },
    { type: "tool_use", id: "toolu_01", name: "render_page", input: { page: 0 } },
  ]);
  assert.deepEqual(second.body.messages[2].content, [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "Rendered." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }]);
  await server.close();
});

test("older models get no thinking, effort or compaction; settings can turn fallback off", async () => {
  assert.ok(isLegacy("claude-haiku-4-5") && isLegacy("claude-sonnet-4-5-20250929") && isLegacy("claude-3-7-sonnet-latest") && isLegacy("claude-opus-4-1"));
  assert.ok(!isLegacy("claude-opus-5-5") && !isLegacy("claude-sonnet-4-6") && !isLegacy("claude-opus-4-8") && !isLegacy("claude-fable-5-1") && !isLegacy("claude-haiku-5-5"));
  const server = await mock((_, res) => sse(res, reply("claude-haiku-4-5", [text("Hi.")], "end_turn"), true));
  await drain(new AnthropicProvider("claude-haiku-4-5", options(server.url, { refusalFallback: false })).chat({ system: [], messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }] }));
  const { body, headers } = server.seen[0];
  assert.equal(headers["anthropic-beta"], undefined);
  for (const key of ["system", "thinking", "output_config", "context_management", "fallbacks", "tools"]) assert.equal(body[key], undefined, key);
  await server.close();
});

test("a refusal comes back as a stop with its explanation", async () => {
  const server = await mock((_, res) => sse(res, reply("claude-opus-5-5", [text("I can't")], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "This looks like malware." } }), true));
  const events = await drain(new AnthropicProvider(undefined, options(server.url)).chat({ system: [], messages: [{ role: "user", parts: [{ type: "text", text: "…" }] }] }));
  const done = events.at(-1);
  assert.ok(done?.type === "done");
  assert.equal(done.stop, "refusal");
  assert.equal(done.detail, "This looks like malware.");
  await server.close();
});

test("messages from another provider are rebuilt as Messages API blocks", () => {
  const [assistant] = toAnthropic([{ role: "assistant", parts: [{ type: "text", text: "" }, { type: "tool_call", id: "call:1", name: "render_page", input: { page: 2 } }] }]);
  assert.deepEqual(assistant, { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "render_page", input: { page: 2 } }] });
});

test("lists models, and explains errors", async () => {
  const server = await mock((s, res) =>
    s.url.startsWith("/v1/models")
      ? json(res, 200, { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" })
      : s.body.model === "claude-bad-image"
        ? json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages.0.content.0.image.source.base64: The image was specified using the image/png media type, but the image appears to be a image/jpeg image" }, request_id: "req_1" })
      : s.body.model === "claude-nope"
        ? json(res, 404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } })
        : json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
  );
  assert.deepEqual(await new AnthropicProvider(undefined, options(server.url)).models(), [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  const ask = (model?: string) => drain(new AnthropicProvider(model, options(server.url)).chat({ system: [], messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }] }));
  await assert.rejects(ask("claude-bad-image"), (e: Error) => e.message === "Anthropic refused the request (400): messages.0.content.0.image.source.base64: The image was specified using the image/png media type, but the image appears to be a image/jpeg image");
  await assert.rejects(ask("claude-nope"), /Anthropic has no model "claude-nope" \(404\)/);
  await assert.rejects(ask(), (e: Error) => e instanceof ProviderError && /didn't accept the credentials \(401\)\. Set MAQUETTE_TEST_ANTHROPIC_KEY \(providers.anthropic.apiKeyEnv\)/.test(e.message));
  await server.close();
  const nobody = `http://127.0.0.1:${await closedPort()}`;
  const offline = new AnthropicProvider(undefined, options(nobody));
  offline.client.maxRetries = 0;
  await assert.rejects(drain(offline.chat({ system: [], messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }] })), new RegExp(`Can't reach the Claude API at ${nobody}`));
});
