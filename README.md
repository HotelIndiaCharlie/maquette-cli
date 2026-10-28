# Maquette

One [DesignCraft](https://github.com/storytold/designcraft) for every session. Type `maquette` in a folder, as you'd type `claude`. It starts DesignCraft headless and gives you a prompt where you say what you want done: the model calls DesignCraft's and Maquette's tools itself, and shows each call as it goes. Tool calls typed directly still run as before, and other terminals, scripts and Claude Code sessions can send calls to the same open document.

```
  ███╗   ███╗ █████╗  ██████╗ ██╗   ██╗███████╗████████╗████████╗███████╗
  ████╗ ████║██╔══██╗██╔═══██╗██║   ██║██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝
  ██╔████╔██║███████║██║   ██║██║   ██║█████╗     ██║      ██║   █████╗
  ██║╚██╔╝██║██╔══██║██║▄▄ ██║██║   ██║██╔══╝     ██║      ██║   ██╔══╝
  ██║ ╚═╝ ██║██║  ██║╚██████╔╝╚██████╔╝███████╗   ██║      ██║   ███████╗
  ╚═╝     ╚═╝╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝

  ■ ■ ■ ■  one DesignCraft for every session

  ✓ DesignCraft 0.13.0 CLI, headless, with Maquette's tools (29 tools)
  ✓ Working in ~/projects/annual-report: DesignCraft reads and writes only here
  ✓ Listening on http://127.0.0.1:8787 for other sessions
  ✓ Renders go to maquette-renders/20261027-160346/
  ✓ Model claude-opus-5-5 from anthropic, effort high, permission mode ask

❯ open the example report and put the revenue chart in the first slot, then show me page one

  I'll open the report, draw the chart and render the page.
  ✓ open_document --path example/annual-report.designcraft · 0.4 s
  ✓ chart_create --frame firstlight:slot:01 --spec {"data":{"url":… · 2.1 s · maquette-renders/20261027-160346/002-chart_create.png
  ✓ render_page --page 0 · 0.6 s · maquette-renders/20261027-160346/003-render_page.png

  Done. The revenue chart sits in the first slot; page one is at maquette-renders/20261027-160346/003-render_page.png.
─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
 ? for shortcuts                                claude-opus-5-5 · high · ask · 14.2k in / 310 out · $0.06
```

**Why:** each Claude Code session that lists DesignCraft as an MCP server starts its own engine with its own document, so two sessions can't work on the same page. Maquette runs one engine and shares it.

**Tools:** besides DesignCraft's own tools, Maquette adds coarse tools that do in one call what takes dozens of DesignCraft commands. The first is the chart tool. More will come as tool modules (see [Adding a tool](#adding-a-tool)).

## Install

You need macOS and Node 24 or later.

```bash
npm install -g https://github.com/HotelIndiaCharlie/maquette-cli/tarball/main
```

It installs two names for the same command: `maquette`, and `mqt` for short. Everything in this README works with either, such as `mqt ask "…"` or `mqt config`.

The shorter `npm install -g github:HotelIndiaCharlie/maquette-cli` hits a bug in global installs from git in npm 10 and 11. It leaves `maquette` pointing at a temporary folder that npm has already deleted, so use the tarball URL above.

The first time you run `maquette`, it checks for the **DesignCraft CLI**, DesignCraft's headless engine. If it isn't there, Maquette says so and offers to install it. It downloads only the CLI (101 MB) from DesignCraft's GitHub release, never the desktop app. It checks the download against the SHA-256 pinned in [`designcraft-pin.json`](designcraft-pin.json) and keeps the CLI in `~/.maquette/designcraft/<version>/`. You can also install it ahead of time:

```bash
maquette install-designcraft
```

Already have a DesignCraft CLI you want to use instead? Pass `--designcraft <path>` or set `DESIGNCRAFT_CLI`. DesignCraft publishes its CLI for macOS only. On other systems, build `designcraft-cli` from source and point Maquette at it the same way.

## Quick start

```bash
mkdir annual-report && cd annual-report
maquette
```

Set `ANTHROPIC_API_KEY` (or pick another model, see [Models](#models)). At the prompt:

```
❯ example
❯ open the example report, save a copy as report.designcraft, and put the revenue chart from example/specs/01-revenue.json in the first slot
❯ make the chart's title shorter, then show me page one
❯ open
❯ save it
❯ exit
```

1. `example` copies a five-page example report into `./example/`, with its data and five chart specs.
2. The sentences go to the model. It opens and saves the document and draws the chart, asking you before each change (`y`, `n`, or `a` for always). Each call gets one line, with its render's path.
3. `open` shows the last render in Preview.

The same job as tool calls, with no model in the way:

```
❯ open_document example/annual-report.designcraft
❯ save_document --path report.designcraft
❯ chart_create firstlight:slot:01 @example/specs/01-revenue.json
❯ render_page --page 0
```

DesignCraft reads and writes only inside the folder where you started Maquette. All paths are relative to it.

## The prompt

What you type decides what happens:

| Type | Does |
| --- | --- |
| A sentence | Goes to the model, which calls tools until the job is done. Each call gets a line: `✓` or `✗`, the tool, its arguments, how long it took, any render's path. |
| `<tool> …` | Calls a tool yourself, with its arguments as flags (below), with no model in the way. The model is told what you ran. |
| `!<command>` | Runs a shell command in Maquette's folder. Its output shows and stays in the conversation, so you can ask about it. |
| `/help` | The slash commands: `/model [id]`, `/provider [name]`, `/permissions [ask\|auto\|plan]`, `/clear`, `/cost`, `/tools`, and `/init` (coming: for now it says what it will do) |
| `tools`, `help`, `help <tool>` | The tools one line each; how to type calls; one tool's description and flags. `help chart_create` gives the whole chart spec format. |
| `example` | Copies the example report into `./example/` |
| `open` | Opens the last image in Preview |
| `exit` | Stops Maquette and DesignCraft, as do Ctrl-D and Ctrl-C on an empty line |

**Permissions.** In `ask` mode, the default, the model's reads and renders run on their own; opening another document, changing it, saving, and anything else that writes asks first: `y` runs it, `n` refuses it and tells the model, `a` allows that tool for the rest of the session. `auto` runs everything. `plan` lets the model only read and render, and it ends with a plan. `/permissions <mode>` switches and saves the choice in this folder's `.maquette/settings.json`; `maquette config set permissions.mode auto` does the same from outside. Tool calls and `!` commands you type yourself never ask.

**Keys:** Tab completes tool names, flags, `/` commands and file paths; ↑ and ↓ bring back earlier lines; shift+enter, or a `\` at the end of the line, adds a line; Ctrl-C stops the model's turn, or clears the line, or on an empty line exits; `ctrl+o` expands the last tool line to its full arguments and result; `esc` dismisses a notice; `?` on an empty line lists the shortcuts.

- **The screen** is drawn with [Ink](https://github.com/vadimdemedes/ink), like Claude Code's: finished output scrolls up above, the answer streams in with its Markdown, and the input box and the footer (model, effort, permission mode, tokens and, for Claude, dollars) stay at the bottom. When Maquette has no terminal, as under a script or `maquette < /dev/null`, it runs the server alone and prints one plain log line per call, as before.
- **Other sessions:** their calls appear in the transcript marked `http`, in the order they ran between the model's own.
- **Renders go back to the model** as images, so a model that can see looks at its own work.
- **`MAQUETTE.md`** in the folder, if present, is read into the model's instructions on every turn, like `CLAUDE.md`. It's the project's design memory: purpose and audience, voice, look and feel, conventions and decisions, kept short. `/init` will write it from a survey of the document; until then, write it by hand.
- **Local models that can't call tools** fall back to a text protocol: the model writes `maquette call …` lines, Maquette asks before running each and sends back the results. The footer then says `text calls`.
- **Save before you stop:** the document lives only in DesignCraft until `save_document`.
- **One at a time:** a second `maquette` on the same port says which folder the first one is working in, and exits. Pick another port with `--port`.

## Arguments as flags

The prompt and `maquette call` read arguments the same way:

- **Flags:** `render_page --page 0`, `save_document --path report.designcraft`. `--flag=value` works too.
- **Required arguments** can go without their flag, in the order `help <tool>` lists them: `open_document example/annual-report.designcraft`, `chart_create firstlight:slot:01 @example/specs/01-revenue.json`.
- **Types** follow the tool: numbers, and `true` or `false`. A flag on its own means true (`--preview`), and `--no-render` means false.
- **Objects and arrays**, such as a chart's `--spec`, are JSON, or `@file` to read the JSON from a file. A dotted flag sets one field, with no braces: `chart_update firstlight:slot:01 --data.url example/data/01-revenue-updated.csv`.
- **Spaces:** quote the value, `--text "Two words"`.
- **All at once:** a single `{…}` or `@file` gives every argument, as JSON.
- **Paths**, `@file` included, are relative to the folder Maquette runs in; `~/` is your home folder.

## From other terminals and sessions

| Command | Does |
| --- | --- |
| `maquette call <tool> …` | Calls one tool, with the same flags as the prompt, and prints its text, then `image: <path>` for each image. Exits 1 if the tool reports an error or the call can't be made. `-` reads all the arguments as JSON from stdin. `--json` prints the whole reply instead. |
| `maquette tools` | The folder Maquette works in, its instructions, and every tool with its first sentence |
| `maquette tools <tool>` | One tool's description and flags |

### Driving it from another Claude Code session

Paste this into the session while `maquette` is running:

> DesignCraft is running as a shared server called Maquette. Drive it only with `maquette call <tool> --flag value …` from Bash; don't start another DesignCraft. `maquette tools` shows the folder Maquette works in, its instructions and the tools. `maquette tools <tool>` gives a tool's flags, and `maquette tools chart_create` explains the chart spec. Paths are relative to Maquette's folder. Required arguments can go without their flag, and objects take JSON or `@file`. Each call prints the tool's result, and `image: <path>` for each render, which you can look at with Read. A non-zero exit means the call failed, and the printed message says why. Other sessions may be using the same document, so check its state with `inspect_document` before changing it.
>
> 1. `maquette call open_document example/annual-report.designcraft` (if there's no `example/` folder, run `maquette example` in Maquette's folder first)
> 2. `maquette call save_document --path <name>.designcraft`, to work on your own copy
> 3. Write a chart spec to a JSON file (`example/specs/` has five), then `maquette call chart_create firstlight:slot:01 @<spec>.json`. The reply says whether every mark sits where the data puts it, and whether any text is overset, outside the frame or overlapping, and it gives a render. Add `--preview` to see the chart without placing it.
> 4. `maquette call save_document`
> 5. `maquette call render_page --page 0`, then Read the image path it prints

## Settings

Maquette reads its settings from four places, each overriding the one before key by key:

1. `~/.maquette/settings.json`, yours, for every project
2. `.maquette/settings.json` in the folder Maquette runs in, for this project
3. environment variables, such as `MAQUETTE_MODEL` and `MAQUETTE_PORT`
4. flags, such as `--port` and `--model`

| Command | Does |
| --- | --- |
| `maquette config` | Every setting, its value, and where the value comes from |
| `maquette config keys` | What each setting does, its choices, default and environment variable |
| `maquette config set <key> <value>` | Writes one setting to your file; `--project` writes this folder's instead |
| `maquette config unset <key>` | Removes it again; `--project` as above |
| `maquette config edit` | Opens your settings file in `$VISUAL` or `$EDITOR`, or else the system's text editor, creating it as `{}` if there's none yet. With an editor in the terminal, it checks the file once you close it. `--project` opens this folder's. |
| `maquette config get <key>` | Prints one value |

Keys are dotted: `maquette config set providers.anthropic.effort medium`. In the file they nest:

```json
{
  "model": "claude-sonnet-5-5",
  "providers": { "anthropic": { "effort": "medium" } }
}
```

Put in only what you want to change. A key you leave out keeps its default, and gets a better one if a later version of Maquette changes it. For reference, `maquette config edit` writes every key with its default to `~/.maquette/settings.defaults.json`. Maquette rewrites that file and never reads it, so changes there have no effect. API keys never go in these files. Each provider names the environment variable that holds its key (`providers.anthropic.apiKeyEnv`, `providers.openai-compatible.apiKeyEnv`), and `maquette config` says whether it's set. A value of the wrong type stops every command but `maquette config`, which shows the problem and can fix it.

## Models

The model behind the prompt is a setting: `provider` and `model`, or `/model` and `/provider` at the prompt for this session. `maquette ask` puts one question to a model from outside the prompt and streams the answer, for scripts and quick questions. It works with or without a running `maquette`; when one is running, the model is told its folder, its instructions and its tools, so it can answer with the `maquette call` lines that would do the job, though it can't call them itself from there.

```bash
maquette ask "how do I put a line chart in the second slot?"
maquette ask --image maquette-renders/20261027-160346/003-render_page.png "what's wrong with this page?"
git diff | maquette ask -
maquette models                  # what the provider offers, with the one in use marked
```

`--model <id>` and `--provider <name>` override the settings for one command.

**Claude** is the default: provider `anthropic`, model `claude-opus-5-5`. Set `ANTHROPIC_API_KEY`, or sign in with `ant auth login`. Maquette asks for adaptive thinking at the effort in `providers.anthropic.effort` (default `high`), caches the instructions and history between turns, and lets the API summarise early history when a conversation gets long. It also turns on the API's refusal fallback: if the model declines on policy grounds, the API retries on its default fallback model and Maquette says so. `maquette config set providers.anthropic.refusalFallback false` turns that off. Models older than Claude 4.6 get none of thinking, effort or summarising, since they don't support them.

**Any other model**, including one on your own machine, goes through provider `openai-compatible`: any server with an OpenAI-style `/v1/chat/completions`, such as Ollama, LM Studio, llama.cpp's server, vLLM or OpenRouter. With Ollama:

```bash
ollama pull qwen3:14b
maquette config set provider openai-compatible
maquette models
maquette config set model qwen3:14b
maquette ask "what can you do here?"
```

The server address is `providers.openai-compatible.baseUrl` (default `http://localhost:11434/v1`, Ollama's), or `OPENAI_BASE_URL`. A server that needs a key reads it from `OPENAI_API_KEY`. For a model that can't see images, set `providers.openai-compatible.vision` to `false`, and images are replaced by a note saying they were left out. A reasoning model's thinking, whether the server sends it in a field of its own or between `<think>` tags, is kept out of the answer. A model that can't call tools still works at the prompt, through the `maquette call` text protocol described under [The prompt](#the-prompt), just less smoothly.

## How it behaves

- **One document for everyone.** Calls from the prompt and from other sessions run one at a time, in the order they arrive. Every caller sees the effect of every other call. `open_document` opens a further document and makes it the active one for everyone.
- **One folder.** DesignCraft may read and write only inside the folder Maquette was started in. Anything else is refused.
- **Renders** that a tool returns are saved as `maquette-renders/<start time>/<call number>-<tool>.png` in that folder. Replies give their absolute paths instead of the image data.
- **Tool state** is saved beside the document: saving `report.designcraft` also writes `report.designcraft.maquette.json`, so a chart can still be updated after the document is reopened.
- **Local only.** The server listens on 127.0.0.1. It refuses requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, and calls that aren't sent as JSON, so a web page can't drive it.
- **Calls** may run for up to 10 minutes. If the engine stops, Maquette stops too and says so.

## The HTTP interface

`maquette call` and `maquette tools` are thin wrappers; anything that can send HTTP can be a client.

| Request | Reply |
| --- | --- |
| `POST /call` with `Content-Type: application/json` and body `{"tool": "<name>", "arguments": {…}}` | `{"id", "tool", "ok", "text", "images"}`: `ok` is false when the tool reported an error; `text` is the tool's text (DesignCraft's tools mostly return JSON as text); `images` are absolute paths |
| `GET /tools` | `{"root", "instructions", "tools"}`: Maquette's folder, its instructions and the tool list as MCP gives it, with input schemas |

An unknown tool, a body that isn't JSON, or `arguments` that aren't an object get a 400 with `{"ok": false, "text": "…"}`. A tool error is still a 200, with `ok: false`.

```bash
curl -s -X POST http://127.0.0.1:8787/call -H 'content-type: application/json' -d '{"tool":"chart_list"}'
```

## The chart tool

- **`chart_create <frame> <spec> [--preview] [--no-render]`** draws a whole chart into a frame in one call. The frame is given by its label (the example's slots are `firstlight:slot:01` to `05`) or by its id. The chart is made of ordinary DesignCraft items in the document's Chart styles, grouped and labelled. The tool then checks the drawing: marks where the data puts them, no overset text, nothing outside the frame, no overlapping labels. Then it renders the page. With `--preview` it removes the chart again, so you can propose one before placing it.
- **`chart_update <chart> [--data …] [--spec …]`** redraws a chart in place with new data or changed spec fields. It first lists anything changed by hand inside the chart. Keeping those changes isn't built yet, so they're redrawn and reported, never dropped silently. A move of the whole chart is kept.
- **`chart_list`** lists the charts drawn or loaded in this session.

The spec is a Vega-Lite subset (`data`, `transform: [{fold}]`, `mark` of `bar`, `line` or `point`, `encoding.x`, `encoding.y` and `encoding.color`, and `title`). It has print extensions: `source`, `highlight`, `labels` and `names`. `maquette tools chart_create` gives the whole format, and [`examples/specs/`](examples/specs/) has five worked specs. Every label is set and measured in DesignCraft before the layout is fixed, so labels fit the document's own type.

## Adding a tool

Tools beyond DesignCraft's own live in [`src/tools/`](src/tools/), one folder each. The chart tool, in [`src/tools/chart/`](src/tools/chart/), is the first. A new tool is a folder whose `index.ts` default-exports a factory. The factory gets the shared DesignCraft engine and the folder Maquette runs in, and returns its tools ([`src/tools/types.ts`](src/tools/types.ts)):

```ts
import type { ToolFactory } from "../types.ts";

const table: ToolFactory = ({ dc, root, readRoots }) => ({
  name: "table",                          // key for its state beside a saved document
  instructions: "To set a table, …",      // added to Maquette's instructions
  tools: [{ name: "table_create", description: "…", inputSchema: { type: "object", properties: { … } } }],
  async call(name, args) {
    // drive DesignCraft with dc.execute(command, params), dc.batch([...]) and dc.inspect()
    return { content: [{ type: "text", text: "…" }] };
  },
  saved: () => undefined,                 // optional: state to keep beside the document
  opened(state) {},                       // optional: that state, read back when a document opens
});

export default table;
```

Then add it to the list in [`src/tools/index.ts`](src/tools/index.ts). Its tools appear at the prompt, in `maquette tools`, over HTTP, and in completion and `help`, with no other changes.

## Layout

| Path | What it is |
| --- | --- |
| [`src/cli.ts`](src/cli.ts) | `maquette` and its commands: `call`, `tools`, `example`, `config`, `ask`, `models`, `install-designcraft` |
| [`src/server.ts`](src/server.ts) | The running Maquette: the engine as a child process, the queue that runs calls one at a time, the HTTP server |
| [`src/agent/`](src/agent/) | The agent loop ([`session.ts`](src/agent/session.ts)), routing of typed lines, permissions, the system prompt, `!` commands and costs. It emits events and knows nothing about the screen. |
| [`src/ui/`](src/ui/) | The Ink screen: transcript, streaming answer with Markdown, tool lines, permission prompt, input box, footer |
| [`src/args.ts`](src/args.ts) | How a typed line becomes a tool's arguments, shared by the prompt, `maquette call` and the text protocol |
| [`src/engine.ts`](src/engine.ts) | The engine, an MCP server on stdio: DesignCraft's tools passed through, plus each tool module's |
| [`src/designcraft.ts`](src/designcraft.ts) | Runs the DesignCraft CLI as an MCP server and calls its tools |
| [`src/install.ts`](src/install.ts) | Finds the DesignCraft CLI, or downloads, checks and unpacks the pinned one |
| [`src/settings.ts`](src/settings.ts) | The settings: their keys, types and defaults, the four layers, and writing one key |
| [`src/providers/`](src/providers/) | Model providers behind one interface ([`types.ts`](src/providers/types.ts)): [`anthropic.ts`](src/providers/anthropic.ts), [`openai-compatible.ts`](src/providers/openai-compatible.ts), and [`fake.ts`](src/providers/fake.ts) for tests |
| [`src/tools/`](src/tools/) | Tool modules; [`chart/`](src/tools/chart/) is the first |
| [`examples/`](examples/) | The example report (an A4 annual report for a fictional cooperative, with five labelled chart slots), its CSVs and their `-updated` versions, and five chart specs |
| [`designcraft-pin.json`](designcraft-pin.json) | The DesignCraft version Maquette is tested with, and its CLI's download and checksum |

## Development

```bash
git clone https://github.com/HotelIndiaCharlie/maquette-cli.git && cd maquette-cli
npm install
npm run dev          # runs src/cli.ts directly (Node 24 runs TypeScript as is); add -- call … and the rest
npm test             # draws the five example charts through the engine and checks them
npm run test:unit    # settings, providers, the agent loop, the screen and the server, against mock servers, a stub engine and a fake model: no DesignCraft, key or network
npm run smoke        # one scripted conversation end to end through the screen, with the stub engine and the fake model
npm run test:all     # all of the above
npm run typecheck
npm run build        # compiles src/ to dist/
```

To see what the agent does on each turn (every request to the model with its thinking, every tool call with where its time went, and why anything failed), run [Phoenix](https://github.com/Arize-ai/phoenix) and start Maquette with `MAQUETTE_TRACE=1 npm run dev`. [`docs/telemetry.md`](docs/telemetry.md) has the details.

`dist/` is committed, so installing from GitHub needs no build step or dev dependencies. Run `npm run build` and commit `dist/` with any change to `src/`. `npm test` needs the DesignCraft CLI (`maquette install-designcraft`). The screen's components are plain `.ts` files calling `React.createElement` through `h`, not `.tsx`, so Node runs the source as is. `MAQUETTE_ENGINE=<script>` runs another engine in place of `src/engine.ts`; the tests use [`test/stub-engine.ts`](test/stub-engine.ts), which needs no DesignCraft.

## Not built yet

[`ROADMAP.md`](ROADMAP.md) lays out the rest of the plan: built-in shell and file tools for the model, other MCP servers, skills, saved sessions and `/compact`, hooks and a JSON mode.

- **Tools of its own.** The model can only call DesignCraft's and Maquette's tools; it can't run shell commands or read files itself yet (Phase 3). You can, with `!`.
- **Saved conversations.** A conversation lasts as long as `maquette` runs (Phase 6).
- **Keeping hand changes** to a chart across `chart_update`. They're detected and reported.
- **More charts:** stacked or grouped bars, more than two series, and areas.
- **Live mode.** DesignCraft runs headless, so the tools that need the app window (`screenshot`, `click`, `menu_list` and the like) return an error.
- **Change notices.** Callers aren't told when another caller changes the document; they see it on their next call. The model is told other sessions share the document and to inspect before changing.
