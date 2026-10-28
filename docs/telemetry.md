# Tracing the agent with Phoenix

For developing Maquette's tools: see what the agent did on each turn, not just the result. That covers every request to the model (the whole prompt, the reply, its thinking and its tokens), every tool call (its arguments, its result, and whether its time went on your y/n, the queue or the engine), and a reason on everything that failed.

It's off unless `MAQUETTE_TRACE` is set, and it runs only from a clone, since the OpenTelemetry packages are dev dependencies. Traces go to [Arize Phoenix](https://github.com/Arize-ai/phoenix), which runs locally in one process, or to any collector that takes OTLP over HTTP.

## Run it

Start Phoenix, in a terminal of its own:

```bash
pip install arize-phoenix
phoenix serve
```

Or with Docker:

```bash
docker run -p 6006:6006 arizephoenix/phoenix:latest
```

Then run Maquette from the clone with tracing on, and open http://localhost:6006:

```bash
MAQUETTE_TRACE=1 npm run dev
```

`MAQUETTE_TRACE=1` sends to Phoenix at `http://localhost:6006`. Set it to a URL to send somewhere else, such as `MAQUETTE_TRACE=http://127.0.0.1:4318` for another OTLP collector. A notice says when the first spans arrived, or why they couldn't be sent. Traces land in Phoenix's **maquette** project.

The server alone (`maquette < /dev/null`) traces too: calls from other terminals and sessions each get a trace of their own. `maquette ask` isn't traced.

## What a trace shows

One trace per sentence you send. A Phoenix session spans the whole `maquette` run.

```
turn                       AGENT  your sentence → the answer; steps, tool calls, failures
├─ llm claude-opus-5-5     LLM    the whole request as a chat, the tools offered, the reply, tokens, cost
│  └─ thinking                    the model's reasoning for this request
├─ tool open_document      TOOL   arguments → result, permission answer, images by path
│  ├─ permission                  waiting on your y/n
│  ├─ queue                       waiting behind calls from other sessions
│  └─ engine                      running in DesignCraft; its stderr lines are events here
├─ llm claude-opus-5-5            the next request, which sees the results
└─ …
```

Calls you type at the prompt, and calls from other terminals and sessions over HTTP, appear as `tool …` traces of their own, with `maquette.source` set to `prompt` or `http`.

Images never go into a trace: a render shows as its path under `maquette-renders/`.

## Finding failures

A span that failed has status ERROR and `maquette.failure` set to one of these reasons:

| Reason | What happened |
|---|---|
| `provider.error` | the model's API failed: no key, no network, rate limit, overload; the message says which |
| `provider.no_reply` | the stream ended without a reply |
| `fallback.text_protocol` | the model can't call tools, so it writes `maquette call` lines from here on |
| `model.refusal` | the model declined |
| `model.max_tokens` | the reply was cut off |
| `model.bad_args` | the arguments weren't a JSON object, or didn't fit the tool |
| `model.unknown_tool` | a tool name that doesn't exist |
| `tool.error` | the tool ran and failed; the result says why |
| `policy.plan_denied` | plan mode stopped a call that would change something |
| `user.declined` | you answered n |
| `user.interrupted` | you pressed Ctrl-C |

The turn lists every reason that happened in it, in `maquette.failures`, and adds `loop.repeat` when the model made the same call with the same arguments three times. A turn is ERROR when anything failed that wasn't your own doing: `user.declined` and `user.interrupted` are recorded but don't turn it red. In Phoenix, `status_code == 'ERROR'` in the span filter lists them, and `span_kind == 'TOOL'` lists the tool calls.

## Thinking

| Model | What the trace shows |
|---|---|
| Claude 4.6 and later | a summary of the thinking. Maquette asks for it with `display: "summarized"`; it isn't billed beyond the thinking itself |
| Open reasoning models (Qwen3, DeepSeek-R1, gpt-oss, …) through `openai-compatible` | the whole reasoning, from the `reasoning_content` or `reasoning` field, or from between `<think>` tags in the text, which is taken out of the answer you see |
| OpenAI's hosted reasoning models | nothing: the API keeps it hidden. The reasoning token count shows when the server sends it |
| Models that don't reason | nothing |

For an open model, the server has to be one that returns the reasoning. Ollama and LM Studio do for their thinking models. vLLM and llama.cpp do when started with a reasoning parser (`--reasoning-parser` in vLLM, `--reasoning-format` in llama.cpp); without one, the `<think>` tags come in the text and Maquette takes them out itself.

## Taking it out

Tracing is for development. To remove it, delete `src/telemetry/` and `test/unit/telemetry.test.ts`, the `trace` function in `src/cli.ts` and its two callers, and the `@opentelemetry/*` dev dependencies. The step and failure events in `src/agent/events.ts` stay: the screen ignores them, and a JSON mode or remote logging can use them.
