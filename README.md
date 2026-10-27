# Maquette

One [DesignCraft](https://github.com/storytold/designcraft) for every session. Type `maquette` in a folder, as you'd type `claude`. It starts DesignCraft headless, gives you a prompt to work on a document, and lets other terminals, scripts and Claude Code sessions send tool calls to the same open document.

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

maquette › open_document example/annual-report.designcraft
maquette › chart_create firstlight:slot:01 @example/specs/01-revenue.json
maquette › render_page --page 0
maquette › open
```

**Why:** each Claude Code session that lists DesignCraft as an MCP server starts its own engine with its own document, so two sessions can't work on the same page. Maquette runs one engine and shares it.

**Tools:** besides DesignCraft's own tools, Maquette adds coarse tools that do in one call what takes dozens of DesignCraft commands. The first is the chart tool. More will come as tool modules (see [Adding a tool](#adding-a-tool)).

## Install

You need macOS and Node 24 or later.

```bash
npm install -g https://github.com/HotelIndiaCharlie/maquette-cli/tarball/main
```

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

At the prompt:

```
maquette › example
maquette › open_document example/annual-report.designcraft
maquette › save_document --path report.designcraft
maquette › chart_create firstlight:slot:01 @example/specs/01-revenue.json
maquette › open
maquette › save_document
maquette › exit
```

1. `example` copies a five-page example report into `./example/`, with its data and five chart specs.
2. `open_document` and `save_document` make your own copy of the report.
3. `chart_create` draws a chart into the report's first chart slot.
4. `open` shows the last render in Preview.
5. The second `save_document` saves the copy again.

DesignCraft reads and writes only inside the folder where you started Maquette. All paths are relative to it.

## The prompt

Type a tool's name and its arguments. Each call gets a log line (time, call number, tool, the start of its arguments, `ok` or the error, how long it took, any image it saved), then its result.

| Type | Does |
| --- | --- |
| `<tool> …` | Calls a tool, with its arguments as flags (below) |
| `tools` | Every tool, one line each |
| `help`, `help <tool>` | How to type calls; one tool's description and flags. `help chart_create` gives the whole chart spec format. |
| `example` | Copies the example report into `./example/` |
| `open` | Opens the last image in Preview |
| `exit` | Stops Maquette and DesignCraft, as do Ctrl-D and Ctrl-C on an empty line |

- **Keys:** Tab completes tool names and flags, ↑ brings back earlier lines, and Ctrl-C clears what you've typed.
- **Other sessions:** their calls appear above the prompt, marked `http`, without disturbing what you're typing.
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
| `maquette config get <key>` | Prints one value |

Keys are dotted: `maquette config set providers.anthropic.effort medium`. API keys never go in these files. Each provider names the environment variable that holds its key (`providers.anthropic.apiKeyEnv`, `providers.openai-compatible.apiKeyEnv`), and `maquette config` says whether it's set. A value of the wrong type stops every command but `maquette config`, which shows the problem and can fix it.

## Models

`maquette ask` puts one question to a model and streams the answer. It works with or without a running `maquette`. When one is running, the model is told its folder, its instructions and its tools, so it can answer with the `maquette call` lines that would do the job. It can't call tools itself yet, and the `maquette ›` prompt still takes tool calls only. Chat at the prompt, with the model calling tools, is the next step in the [roadmap](ROADMAP.md).

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

The server address is `providers.openai-compatible.baseUrl` (default `http://localhost:11434/v1`, Ollama's), or `OPENAI_BASE_URL`. A server that needs a key reads it from `OPENAI_API_KEY`. For a model that can't see images, set `providers.openai-compatible.vision` to `false`, and images are replaced by a note saying they were left out. Maquette will need models that can call tools; one that can't says so when asked.

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
| [`src/cli.ts`](src/cli.ts) | `maquette`: the start screen, the prompt, the HTTP server and the `call`, `tools`, `example` and `install-designcraft` commands |
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
npm run test:unit    # settings, providers and commands, against local mock servers: no DesignCraft, key or network
npm run typecheck
npm run build        # compiles src/ to dist/
```

`dist/` is committed, so installing from GitHub needs no build step or dev dependencies. Run `npm run build` and commit `dist/` with any change to `src/`. `npm test` needs the DesignCraft CLI (`maquette install-designcraft`).

## Not built yet

[`ROADMAP.md`](ROADMAP.md) lays out the plan for turning the prompt into an AI terminal: plain-sentence chat with an agent loop, any model (Anthropic or a local OpenAI-compatible endpoint) chosen in settings, MCP servers, skills and shell commands, all at the one `maquette ›` prompt.

- **Chat in plain sentences.** `maquette ask` answers one question but can't call tools, and the prompt takes tool calls only. Phase 2 of the [roadmap](ROADMAP.md) adds the agent loop.
- **Keeping hand changes** to a chart across `chart_update`. They're detected and reported.
- **More charts:** stacked or grouped bars, more than two series, and areas.
- **Live mode.** DesignCraft runs headless, so the tools that need the app window (`screenshot`, `click`, `menu_list` and the like) return an error.
- **Change notices.** Callers aren't told when another caller changes the document; they see it on their next call.
