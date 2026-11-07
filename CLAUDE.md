# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Maquette (`maquette`, alias `mqt`) is a terminal agent over one shared, headless DesignCraft engine. The person types sentences, and the model calls DesignCraft's tools and Maquette's own. Other terminals and Claude Code sessions drive the same open document over HTTP. User-facing behaviour is in `README.md`. Phase history and the as-built notes are in `ROADMAP.md`. Read those sections only when you need them.

## Commands

Node 24 or later runs the TypeScript source as is (type stripping), so there is no build step for development or tests.

```bash
npm install
npm run dev -- <args>          # runs src/cli.ts, e.g. npm run dev -- call chart_list
npm run typecheck
npm run test:unit              # node --test test/unit/*.test.ts: mock servers, stub engine, fake model; no key, DesignCraft or network
node --test test/unit/settings.test.ts                       # one test file
node --test --test-name-pattern="<regex>" test/unit/agent.test.ts   # one test
npm run smoke                  # one scripted conversation through the Ink screen (stub engine + fake model)
npm test                       # draws the five example charts through the real engine; needs the DesignCraft CLI (`maquette install-designcraft`), so CI doesn't run it
npm run build                  # tsc: src/ → dist/
```

CI (`.github/workflows/test.yml`) runs typecheck, test:unit, smoke and a build on Linux and macOS. `dist/` is committed so that installing from GitHub needs no build, but **only on `main`**: the "Build dist" Action (`.github/workflows/dist.yml`) rebuilds and commits it after every merge. Don't commit `dist/` on a branch; a PR that changes it fails `.github/workflows/pr-rules.yml`. Run `npm run build` to check the build, then leave `dist/` out.

`npm run dev -- --trace` traces each turn to Phoenix in Docker (`docs/telemetry.md`).

## Architecture

The processes, from the outside in:

1. **`src/cli.ts`**: every subcommand (`call`, `tools`, `ask`, `models`, `config`, `example`, `install-designcraft`). With no subcommand it starts the server and, when there is a TTY, the Ink UI. Without a TTY it prints one plain log line per call and must never load Ink or React (`test/unit/no-ink-hook.ts` enforces this).
2. **`src/server.ts`**: spawns the engine as a child Node process over MCP stdio. It runs every call through one queue (one document, one call at a time, from any source: `prompt`, `model` or `http`). It saves renders to `maquette-renders/<start>/` and serves `POST /call` and `GET /tools` on 127.0.0.1, checking the `Host` header. It emits events and prints nothing.
3. **`src/engine.ts`**: the engine, itself an MCP server. It passes DesignCraft's tools through (`src/designcraft.ts` runs the DesignCraft CLI as an MCP client) and adds each tool module's tools. `MAQUETTE_ENGINE=<script>` swaps in another engine. The tests use `test/stub-engine.ts`, which needs no DesignCraft but carries the real workspace tools.
4. **DesignCraft CLI**: found or downloaded by `src/install.ts`, checked against `designcraft-pin.json`. It is confined to the folder Maquette started in.

Inside the process:

- **Tool modules** (`src/tools/<name>/index.ts`): each default-exports a `ToolFactory` (`src/tools/types.ts`) and is registered in `src/tools/index.ts`. Registration alone makes a tool appear at the prompt, in `maquette tools`, over HTTP, in completion and in `help`. A module can persist state beside the saved document (`<doc>.maquette.json`) via `saved()`/`opened()`. The modules: `chart` (Vega-Lite subset → native DesignCraft items, then checked and rendered), `survey` (`document_survey`), `memory` (`memory_write`/`memory_add` for `MAQUETTE.md`), `workspace` (bash, file tools, `view_image`, `open_file`; file paths go through `confine()`).
- **Agent** (`src/agent/`): `session.ts` is the loop (not "loop.ts"). `route.ts` decides what a typed line is: a sentence, a tool call, `!cmd`, `/slash` or a prompt command. `permissions.ts` sorts tools into read and change for the `ask` / `auto` / `plan` modes; it also honours MCP's `readOnlyHint`. A new tool that writes must be classified there. `shell.ts` is shared by `!` and the `bash` tool. The agent emits events and knows nothing about the screen.
- **System prompt**: `src/agent/prompt.ts` builds three blocks from `prompts/*.md`: **core** (fixed, cached), **environment** (this session, cached) and **project** (`MAQUETTE.md`, last and uncached). `{{name}}` is filled by code and `{{> file}}` includes another prompt file. Change what the model is told by editing `prompts/`, not strings in code. `skills/init/SKILL.md` is the `/init` turn.
- **Providers** (`src/providers/`): one streaming `Provider` interface (`types.ts`) with `anthropic.ts`, `openai-compatible.ts` (Ollama and similar; falls back to the `maquette call` text protocol for models without tool calling) and `fake.ts` for tests.
- **UI** (`src/ui/`): Ink components are plain `.ts` files calling `React.createElement` through `h`. Don't write `.tsx`, since Node must run the source unbuilt. Ink drops empty `Text` lines, so draw a space instead.
- **Arguments** (`src/args.ts`): turns a line into tool arguments (flags, positional required args, `@file` JSON, dotted flags). It is shared by the prompt, `maquette call` and the text protocol, so a change here changes all three.
- **Settings** (`src/settings.ts`): keys, types and defaults. Layers: user file → project `.maquette/settings.json` → env → flags. API keys come only from the env var a provider names.

## Conventions

- Imports use explicit `.ts` extensions (`rewriteRelativeImportExtensions`). With `erasableSyntaxOnly` you can't use enums, namespaces or parameter properties. `verbatimModuleSyntax` means type-only imports need `import type`.
- Tests that touch temp folders need `realpathSync` on macOS.
- The README is user documentation written in plain, short sentences. When behaviour changes, update the matching README section, and the phase's "As built" note in `ROADMAP.md` if it has one.

## Working with Linear

Work is tracked in Linear: project **Maquette CLI** (team `HOT`, issues `HOT-<n>`), https://linear.app/hotelindiajuliet/project/maquette-cli-be83f556f33d. The project description links to the planning rules, the decision log, the current bet's spec and "Maquette tools: what exists today". Read that last one before proposing a tool. Fetch these documents and issues only when the task needs them; don't copy their content here or into commits.

Two agents work in this project, Claude and Codex. The rules they share (labels, signing, the git workflow, editing shared documents, decision numbers) are in `AGENTS.md`:

@AGENTS.md

For every piece of work:

1. **Find or create the issue first.** Check `list_issues` for a duplicate. If you create one, put it in the project and the right milestone.
2. **Start:** set the issue to **In Progress**. Read the Handover comments on its parent and on the last Done sibling (the `linear-handover` skill in `.claude/skills/` describes how).
3. **Branch** with the issue's Linear `gitBranchName` (e.g. `davidebelo/hot-82-agent-guide-claudemd-with-commands`), so Linear links the branch and the PR by itself, in its own worktree, stacked on the branch it depends on if any ("Git workflow" in `AGENTS.md`). If the session forces another branch name, still put `HOT-<n>` in the commit messages and the PR title.
4. **Commit messages** end with `(HOT-<n>)`, as in the existing history. Commit before the turn ends, push, and open a draft PR.
5. **Finish:** mark the PR ready and set the issue to **In Review**, or **Done** when the work is merged or needs no review. Post the `## Handover` comment (linear-handover skill) with links to the branch, commit or PR instead of repeating them. Put long agent detail in a collapsible `+++ Agent notes` section, not in the human-readable text.
