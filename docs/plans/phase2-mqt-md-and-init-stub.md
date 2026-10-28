# Plan: rename MAQUETTE.md to MQT.md, stub /init, confirm the image round trip

For the Phase 2 session, on branch `claude/loving-davinci-yg185d`. Three small changes to land with Phase 2, so that `/init` and the project memory file can be built on top of it afterwards without renaming anything people already have.

## Why

`MQT.md` is going to be Maquette's project memory file: the design memory of a project (purpose, audience, voice, look and feel, conventions, design decisions stated and inferred), kept short and read into the system prompt on every turn, like `CLAUDE.md` in Claude Code. `/init` will write it the first time, from a survey of the document plus a short interview. That comes after Phase 2. What Phase 2 has to get right now is the file name, the command name, and the path that carries renders back to the model, because `/init` depends on all three.

`mqt` is the short alias of `maquette`, so `MQT.md` matches it. `MAQUETTE.md` stays as a fallback for one release.

Warnings from opening a document (missing links, skipped fonts, conversion warnings) are not part of this plan and never go into `MQT.md`. They go to the person, through notices, later.

## 1. Rename MAQUETTE.md to MQT.md

Files: `src/agent/prompt.ts`, `README.md`, `ROADMAP.md`, `test/unit/agent.test.ts`.

In `src/agent/prompt.ts`:

- `projectInstructions(root)` looks for `MQT.md` first, then `MAQUETTE.md`. Return the first that exists and is not empty. Export the file name it found, or return `{ file, text }`, so the prompt and the notice below can name it.
- The prompt line becomes `Instructions from the project's MQT.md:` (or whichever file was found). Change the header comment on line 2 too.
- When only `MAQUETTE.md` is found, emit one notice at session start: `MAQUETTE.md is now MQT.md; rename it. Maquette will stop reading MAQUETTE.md in a later release.` One notice per session, not per turn. The session already has `notice()`; the prompt builder is pure, so the check that decides whether to warn belongs in `AgentSession`'s start-up, next to where `systemPrompt` is first built.
- The file is read on every turn today. Keep that: a person editing `MQT.md` mid-session should see the change on their next message, as with `CLAUDE.md`.

Do not read `~/.maquette/MQT.md` yet. The roadmap mentions a user-level file for Phase 5; leave it there.

In `README.md` (the Phase 2 bullet list under the prompt section, currently "**`MAQUETTE.md`** in the folder, if present, is read into the model's instructions, like `CLAUDE.md`."):

- Rename to `MQT.md` and add one sentence on what it is for: the project's design memory, which `/init` will write; keep it short, it is in every prompt.
- Say that `MAQUETTE.md` is still read, with a warning, until the next release.

In `ROADMAP.md`:

- Lines 66 and 110 name `MAQUETTE.md`. Change both to `MQT.md`.
- Add to Phase 5 (or a new short Phase 5a) one paragraph: `/init` surveys the open document (inspect, every page rendered, the stories' text), asks two or three questions (what the document is for and who reads it, what the agent may change, whether a house style exists), and writes `MQT.md` as design memory, not inventory: purpose and audience, voice, visual identity by role (palette, type, grid, imagery), conventions, decisions stated and inferred (inferred ones marked so the person can confirm or strike them), do and don't. On rerun it proposes changes rather than rewriting. Facts with bounds and item IDs stay out; the agent gets those from `inspect_document`. The survey step is a coarse tool, `document_survey`, built as a tool module; the writing step is a bundled skill.

Tests, `test/unit/agent.test.ts`:

- The prompt is built from `this.server.root` (`session.ts` line 281), and `fakeServer()` in `test/unit/fake-server.ts` makes a fresh temp folder as its root, so the test writes the file to `server.root`. Add a test that writes `MQT.md` there, submits a message, and asserts the system prompt in `provider.requests[0].system` contains `Instructions from the project's MQT.md:` followed by the file's text.
- A second case writes only `MAQUETTE.md`: the prompt contains its text under the `MAQUETTE.md` name, and one `notice` event matching `/MAQUETTE.md is now MQT.md/` was emitted, once, across two submits.
- A third case writes both: `MQT.md` wins and no rename notice appears.

## 2. Stub /init

Files: `src/agent/route.ts`, `src/agent/session.ts`, `README.md`.

- `route.ts`: add `"/init": "write MQT.md, the project's design memory (coming)"` to `slashAbout`. Completion and `/help` pick it up from there.
- `session.ts`: in `slashHelp`, add a line `/init                 survey the document and write MQT.md (coming: for now, says what it will do)`. In `slash()`, before the fall-through, handle `init`:
  - If `MQT.md` already exists in the root: notice, `MQT.md exists. /init will update it in a later release; edit it by hand for now.`
  - Else: emit an `output` event with four or five lines: what `/init` will do when it ships (survey the open document, render its pages, ask what the document is for and what may change, write `MQT.md`), and that until then the person can write `MQT.md` by hand: purpose and audience, voice, palette and type by role, conventions, decisions, do and don't. Keep the text as a `const initStub` next to `slashHelp` so the real `/init` replaces one constant.
  - If the provider cannot see images (see section 3), add one line to that output saying `/init` will need a model with vision to describe look and feel.
- Do not open a document, call a tool, or write any file. The stub is text only.
- `README.md`: add `/init` to the `/help` row in the commands table, marked as coming, in the same style as the other commands.

Test, in `test/unit/agent.test.ts`, extending the slash-commands test or a new one: `/init` with no `MQT.md` emits an `output` whose text mentions `MQT.md`; with `MQT.md` present it emits a `notice` saying the file exists; no server call is made either way (`server.calls` unchanged).

## 3. Confirm the image round trip

What exists: the first test in `test/unit/agent.test.ts` already proves that a `render_page` result reaches the next provider request as an `image` part with `image/png`, and `src/agent/session.ts` (around line 435) reads each image path, detects the type with `imageType`, and attaches it. The Anthropic provider sends image parts as content blocks. So the plumbing is covered at the unit level against the fake provider.

Two things to do:

- **Run it live once** on the Mac with the real engine and Claude: open the example report, render page 0, and ask the model to describe the page. The answer should name things that are only visible in the render (the colours, the chart on the page), not only things in the tool's text. Note the result in the PR description. If the model cannot describe the render, the problem is in the Anthropic provider's message conversion, not the loop.
- **Close the no-vision gap.** `src/providers/openai-compatible.ts` drops images when `providers.openai-compatible.vision` is false and replaces them with a note. `/init` will depend on vision, and today nothing tells the session whether the provider can see. Add a `vision: boolean` field to the `Provider` interface in `src/providers/types.ts` (Anthropic: `true`; fake: `true`; OpenAI-compatible: from its option). `AgentSession` reads `this.provider.vision`. Use it in the `/init` stub line above, and nowhere else for now. Keep the change to those four files plus one assertion in a provider test.

Nothing else about images should change in this plan.

## Order

1. Section 3's `vision` field first, since the stub reads it.
2. Section 1, the rename, with its tests.
3. Section 2, the stub, with its test.
4. `npm run typecheck`, `npm run test:unit`, and `npm run build` so `dist/` matches, as the branch's other commits do.
5. The live render check, noted in the PR.

Three commits, one per section, is fine. No new dependencies.

## Not in this plan

- The `document_survey` tool, the `/init` skill, the interview, the additive rerun. They come after Phase 2 lands.
- Open-document warnings to the person, and their storage beside the document for later fix tools.
- `~/.maquette/MQT.md`.
