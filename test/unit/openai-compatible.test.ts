import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OpenAICompatibleProvider, toOpenAI } from "../../src/providers/openai-compatible.ts";
import { type ChatEvent, type Message, ProviderError } from "../../src/providers/types.ts";
import { closeAll, closedPort, drain, json, mock, sse } from "./mock.ts";

after(closeAll);

const options = (baseUrl: string, more = {}) => ({ baseUrl, apiKeyEnv: "MAQUETTE_TEST_OPENAI_KEY", vision: true, ...more });
const chunk = (delta: object, finish: string | null = null) => ({ model: "llama3.1:8b", choices: [{ index: 0, delta, finish_reason: finish }] });
const png = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=", path: "maquette-renders/001-render_page.png" };

test("streams text, then tool calls whose arguments arrive in pieces", async () => {
  const server = await mock((_, res) =>
    sse(res, [
      chunk({ role: "assistant", content: "Opening " }),
      chunk({ content: "it." }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "open_document", arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"example/annual-report.designcraft"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_2", function: { name: "render_page", arguments: { page: 0 } } }] }),
      chunk({}, "tool_calls"),
      { model: "llama3.1:8b", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
      "[DONE]",
    ]),
  );
  process.env.MAQUETTE_TEST_OPENAI_KEY = "secret";
  const provider = new OpenAICompatibleProvider("llama3.1:8b", options(`${server.url}/v1/`));
  const tools = [{ name: "open_document", description: "Opens a document.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const events: ChatEvent[] = await drain(provider.chat({ system: [{ name: "core", text: "Be brief.", cache: true }, { name: "project", text: "Plain words." }], messages: [{ role: "user", parts: [{ type: "text", text: "Open the example" }] }], tools }));
  delete process.env.MAQUETTE_TEST_OPENAI_KEY;
  await server.close();

  const [req] = server.seen;
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer secret");
  assert.equal(req.body.model, "llama3.1:8b");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.messages, [{ role: "system", content: "Be brief.\n\nPlain words." }, { role: "user", content: "Open the example" }]);
  assert.deepEqual(req.body.tools, [{ type: "function", function: { name: "open_document", description: "Opens a document.", parameters: tools[0].inputSchema } }]);

  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["Opening ", "it."]);
  const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
  assert.deepEqual(calls, [
    { type: "tool_call", id: "call_1", name: "open_document", input: { path: "example/annual-report.designcraft" } },
    { type: "tool_call", id: "call_2", name: "render_page", input: { page: 0 } },
  ]);
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.stop, "tool_use");
  assert.deepEqual(done.usage, { input: 120, output: 30 });
  assert.deepEqual(done.message.parts, [{ type: "text", text: "Opening it." }, ...calls]);
});

test("arguments that aren't JSON become a call with an error, not a crash", async () => {
  const server = await mock((_, res) => sse(res, [chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "render_page", arguments: "{page: 0" } }] }, "tool_calls"), "[DONE]"]));
  const events = await drain(new OpenAICompatibleProvider("m", options(server.url)).chat({ system: [], messages: [] }));
  await server.close();
  const call = events.find((e) => e.type === "tool_call");
  assert.ok(call?.type === "tool_call" && call.call.error?.startsWith("The arguments weren't a JSON object"));
});

test("tool results go back as tool messages, with their images in a user message after", () => {
  const history: Message[] = [
    { role: "user", parts: [{ type: "text", text: "Render page one" }] },
    { role: "assistant", parts: [{ type: "text", text: "Rendering." }, { type: "tool_call", id: "call_1", name: "render_page", input: { page: 0 } }] },
    { role: "user", parts: [{ type: "tool_result", id: "call_1", name: "render_page", content: [{ type: "text", text: "Rendered." }, png] }] },
  ];
  const [, , assistant, tool, images] = toOpenAI("sys", history, true);
  assert.deepEqual(assistant, { role: "assistant", content: "Rendering.", tool_calls: [{ id: "call_1", type: "function", function: { name: "render_page", arguments: '{"page":0}' } }] });
  assert.deepEqual(tool, { role: "tool", tool_call_id: "call_1", content: "Rendered.\n[image 1: maquette-renders/001-render_page.png, shown below]" });
  assert.deepEqual(images, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] });

  const blind = toOpenAI("", [{ role: "user", parts: [png, { type: "text", text: "What's wrong with this page?" }] }], false);
  assert.equal(blind.length, 1);
  assert.match(blind[0].content as string, /^\[image maquette-renders\/001-render_page.png left out: this model is set up without vision/);
  assert.match(blind[0].content as string, /What's wrong with this page\?$/);
});

test("arguments sent as a whole object replace, rather than add to, what came before", async () => {
  const server = await mock((_, res) =>
    sse(res, [
      chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "render_page", arguments: { page: 0 } } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: { page: 0, scale: 2 } } }] }, "tool_calls"),
      "[DONE]",
    ]),
  );
  const events = await drain(new OpenAICompatibleProvider("m", options(server.url)).chat({ system: [], messages: [] }));
  await server.close();
  const call = events.find((e) => e.type === "tool_call");
  assert.ok(call?.type === "tool_call");
  assert.deepEqual(call.call.input, { page: 0, scale: 2 });
  assert.equal(call.call.error, undefined);
});

test("lists models from /models, leaving out entries without an id", async () => {
  const server = await mock((_, res) => json(res, 200, { object: "list", data: [{ id: "llama3.1:8b" }, { id: "" }, null, { object: "model" }, { id: "qwen3:14b" }] }));
  assert.deepEqual(await new OpenAICompatibleProvider(undefined, options(`${server.url}/v1`)).models(), [{ id: "llama3.1:8b" }, { id: "qwen3:14b" }]);
  assert.equal(server.seen[0].url, "/v1/models");
  await server.close();
});

test("failures say what to do", async () => {
  await assert.rejects(drain(new OpenAICompatibleProvider(undefined, options("http://127.0.0.1:9")).chat({ system: [], messages: [] })), /No model is set/);
  const nobody = `http://127.0.0.1:${await closedPort()}`;
  await assert.rejects(drain(new OpenAICompatibleProvider("m", options(nobody)).chat({ system: [], messages: [] })), (e: Error) => e instanceof ProviderError && e.message.startsWith(`Nothing is answering at ${nobody}.`));
  const server = await mock((s, res) =>
    s.body?.model === "gemma"
      ? json(res, 400, { error: { message: "registry.ollama.ai/library/gemma does not support tools" } })
      : s.body?.model === "nope"
        ? json(res, 404, { error: { message: 'model "nope" not found, try pulling it first' } })
        : json(res, 401, { error: { message: "Invalid API key" } }),
  );
  const run = (model: string) => drain(new OpenAICompatibleProvider(model, options(server.url)).chat({ system: [], messages: [] }));
  await assert.rejects(run("gemma"), /gemma can't call tools, which Maquette needs/);
  await assert.rejects(run("nope"), /has no model "nope" \(404\)/);
  await assert.rejects(run("other"), /didn't accept the key \(401\): Invalid API key\. Set MAQUETTE_TEST_OPENAI_KEY/);
  await server.close();
});

test("vision follows the setting, so the session knows whether the model can see", () => {
  const base = { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "OPENAI_API_KEY" };
  assert.equal(new OpenAICompatibleProvider("m", { ...base, vision: true }).vision, true);
  assert.equal(new OpenAICompatibleProvider("m", { ...base, vision: false }).vision, false);
});
