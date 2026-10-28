// A provider that replays scripted turns, for tests: no key, no network. Each call to chat()
// takes the next turn, streams its text word by word and makes its tool calls. Every request
// is kept in `requests` so a test can check what the model was sent.
import type { AssistantMessage, ChatEvent, ChatRequest, ModelInfo, Provider, StopReason } from "./types.ts";

export type FakeTurn = { text?: string; calls?: { name: string; input?: Record<string, unknown> }[]; stop?: StopReason };

export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly model = "fake";
  readonly vision = true;
  requests: ChatRequest[] = [];
  turns: FakeTurn[];
  count = 0;

  constructor(turns: FakeTurn[]) {
    this.turns = [...turns];
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const turn = this.turns.shift() ?? { text: "" };
    const message: AssistantMessage = { role: "assistant", parts: [] };
    if (turn.text) {
      for (const piece of turn.text.match(/\S+\s*|\s+/g) ?? []) yield { type: "text", text: piece };
      message.parts.push({ type: "text", text: turn.text });
    }
    for (const c of turn.calls ?? []) {
      const call = { type: "tool_call" as const, id: `fake_${++this.count}`, name: c.name, input: c.input ?? {} };
      message.parts.push(call);
      yield { type: "tool_call", call };
    }
    const stop = turn.stop ?? (turn.calls?.length ? "tool_use" : "end");
    yield { type: "done", message, stop, model: this.model, usage: { input: 0, output: 0 } };
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "fake" }];
  }
}
