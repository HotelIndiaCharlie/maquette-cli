# Roadmap: Maquette as an AI terminal

Today `maquette` is a prompt that takes tool calls (`chart_create firstlight:slot:01 @spec.json`) and an HTTP server that lets other terminals and Claude Code sessions drive the same DesignCraft document. To do anything with a model you open a second terminal, run `claude`, and paste the "driving it from another session" prompt.

The goal of this roadmap is one terminal: you type `maquette`, you talk to it in plain sentences, it plans and calls DesignCraft, Maquette's tools, MCP servers and shell commands itself, and it shows you what it did. The model behind it is a setting, and it can be any model, including one running on your own machine.

## Principles

- **One terminal.** Chat, tool calls, shell commands and renders all happen at the `maquette ›` prompt. Nothing requires a second window.
- **The model is a setting, not a dependency.** Maquette talks to a `Provider` interface. Anthropic is the first and best-supported provider. Any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, …) is the second, so a local model works out of the box.
- **Keep what works.** Typing a tool name still calls it directly, with no model in the way. `maquette call`, `maquette tools` and the HTTP interface stay exactly as they are, so existing scripts and other Claude Code sessions keep working.
- **Same conventions as Claude Code** where they fit: `.mcp.json`-style MCP config, `SKILL.md` skills, a project instructions file, slash commands, `!` for shell. People who know Claude Code should feel at home, and skills can be shared between the two.

## Phases

Each phase is shippable on its own. Later phases don't block earlier ones from being useful.

### Phase 0: Settings (done)

The foundation everything else reads from.

**As built:** `src/settings.ts` and `maquette config` (list, `keys`, `get`, `set`, `unset` and `edit`, with `--project` for the folder's file). Settings files hold only what the person changed; the defaults go to a separate reference file, `~/.maquette/settings.defaults.json`, which Maquette never reads. Keys that belong to later phases (`permissions`, `mcpServers`) arrive with those phases rather than sitting unused. API keys are only ever read from environment variables named in the settings. The environment variables are `MAQUETTE_PROVIDER`, `MAQUETTE_MODEL`, `MAQUETTE_PORT`, `DESIGNCRAFT_CLI`, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. `--model` and `--provider` are read only by `ask` and `models`, so `maquette call` still passes flags of those names to tools.

- `~/.maquette/settings.json` (user) and `./.maquette/settings.json` (project), project wins per key. Environment variables override both (`MAQUETTE_MODEL`, `MAQUETTE_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, …).
- `maquette config` prints the merged settings and where each value came from. `maquette config set model claude-opus-5-5` writes one key.
- Schema, with defaults:

```jsonc
{
  "provider": "anthropic",            // or "openai-compatible"
  "model": "claude-opus-5-5",
  "providers": {
    "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY", "effort": "high" },
    "openai-compatible": { "baseUrl": "http://localhost:11434/v1", "apiKeyEnv": "OPENAI_API_KEY" }
  },
  "permissions": { "mode": "ask" },   // ask | auto | plan (see Phase 2)
  "mcpServers": {},                    // Phase 4
  "port": 8787
}
```

- New file: `src/settings.ts`. `src/cli.ts` reads `--port` and `--designcraft` through it instead of its own `option()` helper.

**Done when:** `maquette config` works and the existing prompt still behaves exactly as before.

### Phase 1: Model providers (done)

**As built:** `src/providers/` with the Anthropic (SDK 1.x), OpenAI-compatible and fake providers, plus `maquette ask` and `maquette models`. The Anthropic provider adds the API's refusal fallback, and leaves thinking, effort and compaction off for models older than Claude 4.6. `/model` and `/provider` move to Phase 2, since the prompt doesn't chat until then. `ask` gives the model Maquette's tool list in its instructions but no tools to call. Tests run against local mock servers of both APIs, so they need no key; nothing has been run against the live Claude API or a real Ollama yet.

- `src/providers/types.ts`: a `Provider` with one method, `chat(request) → async iterable of events`. The request carries the system prompt, the message history, the tool definitions (JSON Schema, which Maquette already has from MCP) and images. Events are `text`, `tool_call`, `usage` and `done`. Streaming is the only mode, so the prompt can print as the model writes.
- `src/providers/anthropic.ts`: the official `@anthropic-ai/sdk`. Default model `claude-opus-5-5`, adaptive thinking, `output_config.effort` from settings, prompt caching on the system prompt and tool list, tool results and images sent as proper content blocks, server-side compaction when the history gets long. Typed error classes mapped to one-line messages at the prompt (no key, rate limited, model not found).
- `src/providers/openai-compatible.ts`: `POST {baseUrl}/chat/completions` with `tools` and `stream: true`. This covers Ollama, LM Studio, llama.cpp server, vLLM, OpenRouter and most hosted models. Images are sent as `image_url` data URLs when the model accepts them, and dropped with a note when it doesn't. Models that don't support tool calling get a clear error at startup rather than a confused session.
- `maquette models` lists what the current provider offers (`GET /v1/models` on both). `/model <name>` switches mid-session; `/provider <name>` too.
- A `fake` provider that replays scripted answers, for tests. No test should need a key or a network.

**Done when:** `maquette ask "what tools do you have"` prints a streamed answer from Anthropic, and the same command with `MAQUETTE_PROVIDER=openai-compatible` and Ollama running does too.

### Phase 2: The agent loop and the Ink terminal UI

This is the phase that makes it an AI terminal. Tracked in Linear as HOT-52.

- **Routing a typed line.** If the first word is a tool name or a prompt command, it's a direct call, as today. If it starts with `/`, it's a slash command. If it starts with `!`, it's a shell command run in Maquette's folder, output shown in the terminal and kept in the conversation so the model can see it. Anything else is a message to the model.
- **The loop** (`src/agent/loop.ts`): send history plus tool list to the provider; for each `tool_call`, run it through the existing `enqueue()` so it's serialised with HTTP callers and gets the same log line (time, call number, tool, args, ok/error, duration, image path); append the result; repeat until the model stops. Tool results with images go back to the model as images, so a vision-capable model can look at its own renders.
- **The system prompt** (`src/agent/prompt.ts`): what Maquette is, the working folder, the engine's `instructions` (which already carry the chart spec format), the project instructions file `MAQUETTE.md` if present, the skill catalogue (Phase 5), and the rule that other sessions share the document, so inspect before changing.
- **Permissions.** `ask` (default): read-only tools and renders run freely; tools that change the document, write files or run shell ask `y/n/always` at the prompt. `auto`: everything runs. `plan`: the model may only read and inspect, and ends with a plan. `/permissions` switches; the setting persists per project.
- **Slash commands:** `/help`, `/model`, `/provider`, `/permissions`, `/clear` (new conversation), `/compact` (summarise history), `/cost` (tokens and, for Anthropic, dollars this session), `/tools`, `/mcp`, `/skills`.
- **Interrupting.** Ctrl-C during a model turn stops the turn (and the tool in flight if DesignCraft allows), not Maquette. Ctrl-C on an empty line still exits.
- **Status line** under the prompt: model, permission mode, tokens used, whether other sessions are connected over HTTP.
- `maquette ask "<message>"` for one-shot, non-interactive use from scripts and CI.

**The screen is built with [Ink](https://github.com/vadimdemedes/ink) from the start**, the React-for-terminals library Claude Code uses, so the prompt is rewritten once rather than in readline and then again:

- **The core knows nothing about the screen.** `src/agent/` (loop, routing, permissions) emits events (`text`, `tool_call`, `tool_result`, `ask_permission`, `notice`, `done`) and `src/ui/` draws them. The logic is tested without Ink against the fake provider, and the same events feed Phase 7's JSON mode.
- **No JSX.** Node runs `.ts` source but not `.tsx`, and running the branch from source depends on that. Components are plain `.ts` with `React.createElement` through a one-letter `h` helper, so no build step is added.
- **Finished output goes in Ink's `<Static>`**: written once, never redrawn. Only the live answer, the input box and the footer re-render, so long sessions stay fast.
- **No terminal, no Ink.** Without a TTY, and for `ask`, `call` and `tools`, Maquette prints plain lines as today.
- **Packages:** `ink@8` and `react@19.3`, `marked` for Markdown; `ink-testing-library` and `@types/react` for development. The input box is written in-house on Ink's `useInput`, for history, tab completion and Claude Code-style Ctrl-C.
- **Components:** `Banner` (version, provider, model, effort, folder, port), `Transcript` (finished items, other sessions' calls marked `http`), `Turn` (the answer streaming in, drawn from Markdown), `ToolLine` (one line per call, `ctrl+o` expands it), `PermissionPrompt` (`y / n / a`), `InputBox` (framed, `❯`, history, Tab, shift+enter), `Footer` (`? for shortcuts`; model, effort, mode, tokens, cost), `Notices` (esc dismisses).

**Done when:** `maquette`, then "open the example report and put the revenue chart in the first slot, then show me page one" does the whole thing, with each tool call logged and the render path printed, and nothing else open, in a Claude Code-style screen: input box at the bottom, footer, Markdown answers, one-line tool summaries.

### Phase 3: Built-in tools, so nothing needs a second terminal

Tools Maquette offers the model directly, beside DesignCraft's (`src/agent/tools/`):

- `bash`: run a command in Maquette's folder, with a timeout and output cap. Under `ask` it always prompts.
- `read_file`, `write_file`, `edit_file` (search and replace), `glob`, `grep`: confined to Maquette's folder, like DesignCraft.
- `view_image`: send a PNG (a render, a reference design) to the model as an image.
- `open`: open a file in the system viewer, what the `open` prompt command does today.

These are ordinary tool modules in the sense of `src/tools/types.ts`, so they also appear in `maquette tools` and over HTTP, and other sessions can call them.

**Done when:** "run the tests, then update the revenue chart with the new CSV and save" works from one prompt, including the shell step.

### Phase 4: MCP servers

Maquette already is an MCP client (of DesignCraft) and an MCP server (`src/engine.ts` on stdio). This phase generalises both.

- **Client:** `mcpServers` in settings, in the same shape as Claude Code's `.mcp.json` (`command`/`args`/`env` for stdio, `url` for HTTP and SSE). `src/mcp/clients.ts` starts them beside DesignCraft, prefixes their tool names (`figma__get_file`), merges their tools into the one tool list the model, the prompt, `maquette tools` and HTTP all see. Their instructions join the system prompt. Also read `./.mcp.json` so a project set up for Claude Code works unchanged.
- `/mcp` shows each server, its state and tool count; `/mcp reconnect <name>`.
- **Server:** `maquette mcp` runs the engine on stdio, so Claude Code (or any MCP client) can list Maquette itself as an MCP server and get DesignCraft plus Maquette's tools, with the same shared document when a `maquette` is already running (the stdio server forwards to the running HTTP server instead of starting a second engine).

**Done when:** a project with a `.mcp.json` listing a second server gets that server's tools at the `maquette ›` prompt, and Claude Code with Maquette in its own `.mcp.json` shares the running document.

### Phase 5: Skills and project instructions

- `MAQUETTE.md` in the project folder (and `~/.maquette/MAQUETTE.md`) is read into the system prompt, like `CLAUDE.md`.
- Skills live in `.maquette/skills/<name>/SKILL.md` and `~/.maquette/skills/`, with the same frontmatter as Claude Code's (`name`, `description`). `.claude/skills/` is read too, so one skill folder serves both tools. Only name and description go into the system prompt; the body is loaded when the model invokes a skill (through a `skill` tool) or you type `/<name>`.
- Maquette ships with a few: `chart` (how to go from a CSV and a sentence to a placed chart with the spec format), `report-review` (render every page, look at each, list layout problems), `designcraft` (the engine's conventions).
- `/skills` lists them; `maquette skills` from outside.

**Done when:** `/report-review` renders the document page by page and the model describes what it sees, and a user-written skill appears in the list with no code change.

### Phase 6: Sessions and context

- Conversations are saved as JSONL in `.maquette/sessions/`. `maquette --resume` picks the last one, `--resume <id>` a given one, `/sessions` lists them.
- `/compact` summarises the history with the current model so it works on every provider; on Anthropic the server-side compaction from Phase 1 does it automatically first.
- Tool results are trimmed in history after they have been seen (keep the first lines and the image path), since renders and `inspect_document` output are large.
- Change notices: when an HTTP caller changes the document, the next model turn gets a short note ("another session ran `chart_update` on slot 02"), closing the gap listed under "Not built yet" in the README.

### Phase 7: Polish

- Hooks in settings (`beforeTool`, `afterTool`, `onStop`), shell commands that run on events, as in Claude Code.
- A non-TTY mode that reads messages from stdin and writes JSON events to stdout, so Maquette itself can be driven as an agent by another program.
- Tests: the agent loop against the fake provider, routing of typed lines, settings merging, MCP tool prefixing. `npm test` still draws the five example charts.
- README rewritten around the conversation, with the tool-call prompt as the advanced path.

## File layout after the roadmap

| Path | What it will be |
| --- | --- |
| `src/cli.ts` | Argument parsing and the subcommands; the prompt and server move out |
| `src/ui/` | The Ink screen: banner, transcript, live answer, tool lines, permission prompt, input box, footer, notices |
| `src/server.ts` | The HTTP server and the call queue (unchanged behaviour) |
| `src/settings.ts` | Settings files, env overrides, `maquette config` |
| `src/providers/` | `types.ts`, `anthropic.ts`, `openai-compatible.ts`, `fake.ts` |
| `src/agent/` | `loop.ts`, `routing.ts`, `prompt.ts`, `permissions.ts`, `tools/` (bash, files, image); emits the events `src/ui/` draws |
| `src/mcp/` | `clients.ts` (servers from settings and `.mcp.json`), `serve.ts` (`maquette mcp`) |
| `src/skills.ts` | Skill discovery and loading |
| `src/sessions.ts` | JSONL history, resume, compaction |
| `skills/` | The skills Maquette ships with |

## Order and sizing

| Phase | Depends on | Size |
| --- | --- | --- |
| 0 Settings | nothing | small |
| 1 Providers | 0 | medium |
| 2 Agent loop and Ink UI | 1 | large; the heart of it |
| 3 Built-in tools | 2 | small |
| 4 MCP servers | 2 | medium |
| 5 Skills | 2 | small |
| 6 Sessions | 2 | medium |
| 7 Polish | all | ongoing |

Phases 3, 4 and 5 are independent of each other and can land in any order once Phase 2 is in.

## Open questions

- **Local models and tool calling.** Small local models call tools unreliably. Phase 1 should detect a model that can't call tools and fall back to a text protocol (the model writes `maquette call …` lines, Maquette runs them), so a local model is still usable, just less smooth.
- **Images for local models.** Only some local models accept images. When the model can't see a render, Maquette should run DesignCraft's checks (overset, overlap, out of frame, which `chart_create` already reports) and give the model the text instead.
- **Where the permission prompt lives** when a tool call comes from the model while an HTTP caller is also queued. The queue already serialises calls; the prompt must not block HTTP callers for longer than one answer.
