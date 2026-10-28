// The agent's and the server's events as OpenTelemetry spans, named the OpenInference way so
// Phoenix draws them as an agent's trace: one trace per turn, an LLM span per request to the
// model (its whole input, output, thinking and tokens), a tool span per call (with where its
// time went), and a reason on everything that failed. Calls typed at the prompt or sent over
// HTTP get a trace of their own. Development only: nothing outside src/telemetry/ imports this.
import { context, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import type { AgentEvent, Failure } from "../agent/events.ts";
import { price } from "../agent/cost.ts";
import type { Message, ToolSpec } from "../providers/types.ts";
import type { ServerEvent } from "../server.ts";

type Attributes = Record<string, string | number | boolean | string[]>;
type Log = { at: number; text: string };

// Long enough for any prompt or tool result Maquette sends; images are never inlined.
const cap = (s: string, n = 100_000) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const json = (v: unknown) => cap(JSON.stringify(v));
// Milliseconds, finer than Date.now(), so spans a fake provider ends within one ms keep their order.
const clock = () => performance.timeOrigin + performance.now();

// The conversation as OpenInference's flattened message attributes, which Phoenix shows as a chat.
export function messageAttributes(prefix: string, system: string | undefined, messages: Message[]): Attributes {
  const out: Attributes = {};
  let i = 0;
  const put = (key: string, value: string) => void (out[`${prefix}.${i}.message.${key}`] = value);
  if (system) {
    put("role", "system");
    put("content", cap(system));
    i++;
  }
  for (const m of messages) {
    if (m.role === "assistant") {
      put("role", "assistant");
      put("content", cap(m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")));
      let j = 0;
      for (const p of m.parts) {
        if (p.type !== "tool_call") continue;
        out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.id`] = p.id;
        out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.name`] = p.name;
        out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.arguments`] = json(p.input);
        j++;
      }
      i++;
      continue;
    }
    const rest: string[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        put("role", "tool");
        put("tool_call_id", p.id);
        put("name", p.name);
        put("content", cap(`${p.isError ? "Error: " : ""}${p.content.map((c) => (c.type === "text" ? c.text : `[image${c.path ? ` ${c.path}` : ""}]`)).join("\n")}`));
        i++;
      } else rest.push(p.type === "text" ? p.text : `[image${p.path ? ` ${p.path}` : ""}]`);
    }
    if (rest.length) {
      put("role", "user");
      put("content", cap(rest.join("\n\n")));
      i++;
    }
  }
  return out;
}

const toolAttributes = (tools: ToolSpec[] = []): Attributes => Object.fromEntries(tools.map((t, i) => [`llm.tools.${i}.tool.json_schema`, json({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })]));

// Failures the person caused aren't the agent's: they're recorded but don't turn a turn red.
const isAgents = (f: Failure | "loop.repeat") => !f.startsWith("user.");

export class Tracing {
  tracer: Tracer;
  sessionId: string;
  // The engine's stderr, kept a while so each line can go on the span it was written during.
  logs: Log[] = [];
  turn?: { span: Span; started: number; answer: string; steps: number; calls: number; failed: number; failures: Set<string>; seen: Map<string, number>; inputs: Map<string, Record<string, unknown>> };
  step?: { span: Span; started: number; firstText?: number };

  constructor(tracer: Tracer, sessionId: string) {
    this.tracer = tracer;
    this.sessionId = sessionId;
  }

  start(name: string, attributes: Attributes, parent?: Span, startTime?: number): Span {
    const ctx = parent ? trace.setSpan(context.active(), parent) : undefined;
    return this.tracer.startSpan(name, { attributes: { "session.id": this.sessionId, ...attributes }, startTime: startTime ?? clock() }, ctx);
  }

  fail(span: Span, failure: string, message?: string) {
    span.setAttribute("maquette.failure", failure);
    span.setStatus({ code: SpanStatusCode.ERROR, message: message ? `${failure}: ${message}` : failure });
  }

  // The engine's lines written between two times, as events on the span that was running then.
  attachLogs(span: Span, from: number, to: number) {
    const keep: Log[] = [];
    for (const log of this.logs) {
      if (log.at >= from && log.at <= to) span.addEvent("engine stderr", { text: cap(log.text, 10_000) }, log.at);
      else if (log.at > to) keep.push(log);
    }
    this.logs = keep;
  }

  // A span for a stretch of time already over: where a tool call waited and ran.
  phase(parent: Span, name: string, from: number, ms: number) {
    this.start(name, { "openinference.span.kind": "CHAIN" }, parent, from).end(from + ms);
  }

  onAgent(e: AgentEvent) {
    const now = clock();
    switch (e.type) {
      case "user": {
        this.endTurn(now);
        this.turn = {
          span: this.start("turn", { "openinference.span.kind": "AGENT", "input.value": cap(e.text), "input.mime_type": "text/plain" }),
          started: now,
          answer: "",
          steps: 0,
          calls: 0,
          failed: 0,
          failures: new Set(),
          seen: new Map(),
          inputs: new Map(),
        };
        break;
      }
      case "step_start": {
        if (!this.turn) break;
        this.turn.steps = e.step;
        const { request } = e;
        this.step = {
          started: now,
          span: this.start(
            `llm ${e.model}`,
            {
              "openinference.span.kind": "LLM",
              "llm.provider": e.provider,
              "llm.system": e.provider,
              "llm.model_name": e.model,
              "maquette.step": e.step,
              "input.value": json({ messages: request.messages.length, tools: request.tools?.map((t) => t.name) ?? "text protocol" }),
              "input.mime_type": "application/json",
              ...messageAttributes("llm.input_messages", request.system, request.messages),
              ...toolAttributes(request.tools),
            },
            this.turn.span,
          ),
        };
        break;
      }
      case "text":
        if (this.turn) this.turn.answer += e.text;
        if (this.step && !this.step.firstText) this.step.firstText = now;
        break;
      case "step_end": {
        const step = this.step;
        if (!step) break;
        this.step = undefined;
        const { span } = step;
        if (e.model) span.setAttribute("llm.model_name", e.model);
        if (e.stop) span.setAttribute("maquette.stop", e.stop);
        if (step.firstText) span.setAttribute("maquette.time_to_first_text_ms", step.firstText - step.started);
        if (e.usage) {
          const u = e.usage;
          const prompt = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          span.setAttributes({ "llm.token_count.prompt": prompt, "llm.token_count.completion": u.output, "llm.token_count.total": prompt + u.output, "llm.token_count.prompt_details.cache_read": u.cacheRead ?? 0, "llm.token_count.prompt_details.cache_write": u.cacheWrite ?? 0 });
          if (u.reasoning) span.setAttribute("llm.token_count.completion_details.reasoning", u.reasoning);
          const cost = e.model ? price(e.model, u) : undefined;
          if (cost !== undefined) span.setAttribute("llm.cost.total", cost);
        }
        if (e.message) {
          span.setAttributes(messageAttributes("llm.output_messages", undefined, [e.message]));
          const text = e.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
          const calls = e.message.parts.flatMap((p) => (p.type === "tool_call" ? [{ name: p.name, input: p.input, ...(p.error ? { error: p.error } : {}) }] : []));
          span.setAttributes({ "output.value": json({ ...(e.thinking ? { thinking: e.thinking } : {}), text, calls }), "output.mime_type": "application/json" });
        }
        // The thinking as a span of its own, so it shows in the tree: the time before the
        // first text, or the whole request when there was none.
        if (e.thinking) {
          span.setAttribute("maquette.thinking", cap(e.thinking));
          this.start("thinking", { "openinference.span.kind": "CHAIN", "output.value": cap(e.thinking), "output.mime_type": "text/plain" }, span, step.started).end(step.firstText ?? now);
        }
        if (e.failure) {
          this.fail(span, e.failure, e.error);
          this.turn?.failures.add(e.failure);
        }
        span.end(now);
        break;
      }
      case "tool_call":
        if (!this.turn) break;
        this.turn.inputs.set(e.id, e.input);
        this.turn.calls++;
        {
          // The same call with the same arguments a third time in one turn: the agent is going round.
          const key = `${e.name} ${JSON.stringify(e.input)}`;
          const times = (this.turn.seen.get(key) ?? 0) + 1;
          this.turn.seen.set(key, times);
          if (times === 3) {
            this.turn.failures.add("loop.repeat");
            this.turn.span.addEvent("loop.repeat", { tool: e.name, arguments: json(e.input) }, now);
          }
        }
        break;
      case "tool_result": {
        if (!this.turn) break;
        const t = e.timing ?? { permission: 0, queue: 0, run: e.ms };
        const started = now - t.permission - t.queue - t.run;
        const input = this.turn.inputs.get(e.id) ?? {};
        const span = this.start(
          `tool ${e.name}`,
          {
            "openinference.span.kind": "TOOL",
            "tool.name": e.name,
            "tool.parameters": json(input),
            "input.value": json(input),
            "input.mime_type": "application/json",
            "output.value": cap(e.text),
            "output.mime_type": "text/plain",
            "maquette.ok": e.ok,
            "maquette.source": "model",
            ...(e.permission ? { "maquette.permission": e.permission } : {}),
            ...(e.images.length ? { "maquette.images": e.images } : {}),
          },
          this.turn.span,
          started,
        );
        if (e.permission && e.permission !== "allowed") this.phase(span, "permission", started, t.permission);
        if (t.queue) this.phase(span, "queue", started + t.permission, t.queue);
        if (t.run) this.phase(span, "engine", started + t.permission + t.queue, t.run);
        this.attachLogs(span, started, now);
        if (!e.ok) {
          this.turn.failed++;
          if (e.failure) {
            this.turn.failures.add(e.failure);
            this.fail(span, e.failure, e.text.split("\n")[0]);
          }
        }
        span.end(now);
        break;
      }
      case "notice":
        (this.step?.span ?? this.turn?.span)?.addEvent(`notice: ${e.level}`, { text: cap(e.text, 10_000) }, now);
        break;
      case "done":
        if (this.turn && e.interrupted) this.turn.failures.add("user.interrupted");
        this.endTurn(now);
        break;
    }
  }

  endTurn(now: number) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    this.step?.span.end(now);
    this.step = undefined;
    const failures = [...turn.failures];
    turn.span.setAttributes({ "output.value": cap(turn.answer), "output.mime_type": "text/plain", "maquette.steps": turn.steps, "maquette.tool_calls": turn.calls, "maquette.tool_failures": turn.failed, ...(failures.length ? { "maquette.failures": failures } : {}) });
    const agents = failures.filter((f) => isAgents(f as Failure));
    if (agents.length) turn.span.setStatus({ code: SpanStatusCode.ERROR, message: agents.join(", ") });
    this.attachLogs(turn.span, turn.started, now);
    turn.span.end(now);
  }

  onServer(e: ServerEvent) {
    const now = clock();
    if (e.type === "engine_log") {
      this.logs.push({ at: now, text: e.text });
      // Lines no span claimed within a minute are dropped.
      while (this.logs.length && this.logs[0].at < now - 60_000) this.logs.shift();
      return;
    }
    if (e.type === "engine_closed") {
      (this.turn?.span ?? this.start("engine closed", { "openinference.span.kind": "CHAIN" })).addEvent("engine closed", {}, now);
      return;
    }
    // The model's calls are traced from the agent's events; these are the ones typed at the
    // prompt or sent by other sessions.
    // The event comes as the call finishes, so now is its end.
    const { reply, args } = e;
    if (reply.source === "model") return;
    const end = now;
    const span = this.start(
      `tool ${reply.tool}`,
      {
        "openinference.span.kind": "TOOL",
        "tool.name": reply.tool,
        "tool.parameters": json(args),
        "input.value": json(args),
        "input.mime_type": "application/json",
        "output.value": cap(reply.text),
        "output.mime_type": "text/plain",
        "maquette.ok": reply.ok,
        "maquette.source": reply.source,
        ...(reply.images.length ? { "maquette.images": reply.images } : {}),
      },
      undefined,
      end - reply.ms,
    );
    this.attachLogs(span, end - reply.ms, end);
    if (!reply.ok) this.fail(span, "tool.error", reply.text.split("\n")[0]);
    span.end(end);
  }
}
