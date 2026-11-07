# CLI foundations: implementation specification and delivery plan

Status: implementation authorized and started on 7 November 2026, per explicit owner handover. No release, deploy or automatic merge is authorized.

Execution order: HOT-56 save/list/resume → HOT-54 → HOT-55 → HOT-63 → HOT-56 compaction/change notices. The real integration is DesignCraft shared by the terminal and an external MCP client; other applications are fixture-only in this scope. This supersedes historical planning-only and target-app-open notes below.

Scope: [HOT-54](https://linear.app/hotelindiajuliet/issue/HOT-54), [HOT-55](https://linear.app/hotelindiajuliet/issue/HOT-55), [HOT-63](https://linear.app/hotelindiajuliet/issue/HOT-63), [HOT-56](https://linear.app/hotelindiajuliet/issue/HOT-56). These are accepted foundations for app connectivity and recurring publication work. They are assigned to Bet 2 for ownership; this does not assert that its gate has opened.

The active scope is HOT-54, HOT-55, HOT-63 and HOT-56. The owner has deferred HOT-57 and retained HOT-56 for direct personal use of Maquette with DesignCraft. HOT-54/56 are no longer Parked. This supersedes earlier scope/parking notes for these issues. D2 still stands: the CLI is the shared engine interface and development surface; Maquette's product front end remains separate. D3 (living data components first) and the Bet 1 gate remain unchanged. No cycle, deadline, assignment, implementation or release is initiated.

## Verified implementation baseline

Inspected local source on 7 November 2026:
- src/server.ts owns an engine child process, one FIFO queue, HTTP /tools and /call. Its tool list is currently static and its Reply normalizes results to text and image paths.
- src/engine.ts is already a stdio MCP server over DesignCraft and the chart, survey, memory and workspace modules. It saves module sidecars on document save.
- src/agent/session.ts owns the agent loop, in-memory Message history, per-process permission grants and a special initSkill() resolver. src/agent/prompt.ts already reads MAQUETTE.md and notices changes.
- src/providers/types.ts already retains normalized messages plus provider-native assistant content. Preserving this representation is necessary for signed thinking/compaction payloads.
- src/cli.ts ask() invokes a provider without callable tools. It must not be described as an existing one-shot executing agent.
- src/settings.ts currently validates scalar dotted settings. MCP maps require explicit structured validators and merge semantics.
- skills/init/SKILL.md, src/tools/survey/ and src/tools/memory/ implement document survey, design-memory writing and rerun consent.
- package.json already pins @modelcontextprotocol/sdk 1.32.2 and includes dist, skills and prompts in packages. Node >=24 is required. No new MCP SDK dependency is assumed.
- The local checkout has no applicable AGENTS.md/CLAUDE.md at the inspected workspace/parent locations. Linear marks HOT-82 done, but that guide is absent here: implementers must check the actual target branch before applying this plan.

This is a checkout-based baseline, not a claim that local source equals the latest remote main. Each implementation PR must recheck the target branch and adjust changed integration points.

## Reuse research is required before implementation

See [reuse assessment and sources](cli-foundations-reuse-research.md). The installed official MCP SDK already supplies the connection/protocol layer; compare it with Vercel AI SDK and LangChain adapters before writing custom integration. Reuse maintained transports, tool discovery/calls and authentication helpers. Record the chosen library/version and the concrete gaps requiring custom code. Refresh the assessment at kickoff, including existing servers for the first target app.

HOT-56 stays in scope specifically for the owner's direct personal trials with Maquette and DesignCraft. Deliver save/list/resume first, independently of new external MCP connections; follow with context compaction and shared change notices. Personal acceptance: inspect/edit/save a disposable document, exit, resume the conversation, inspect the current document and continue without replaying edits. This requires no designer study.

## Delivery order and dependencies

| Order | Issue | Deliverable | Prerequisite within this plan |
| --- | --- | --- | --- |
| 1 | HOT-54 | Typed MCP configuration; common runtime registry; app connections; shared stdio facade | None |
| 2 | HOT-55 | Shared skill resolver/catalogue, engine reader, /<skill>, bundled guidance | None; lands after 54 to integrate with the final catalogue |
| 3 | HOT-63 | Bounded folder map; survey integration; file-aware init | HOT-55's unified init resolver |
| 4 | HOT-56 | Session journal/resume first for personal use; compaction and change notices later | First resume slice is independent; shared change feed integrates with HOT-54 |

The order is a review/landing sequence, not a requirement to code all four in a single change. Each numbered slice inside an issue is a separate reviewable PR candidate. Use issue IDs rather than the old phase numbers to determine order. No estimated calendar dates are committed before the first connectivity slice establishes actual app/auth requirements and the implementation owner is assigned.

At implementation kickoff, name the first external app and whether it offers stdio, HTTP, configured credentials or OAuth-only auth. This is the only product integration input still outstanding. It does not prevent implementing fixtures, common MCP support, skills, folder discovery or session contracts. It does prevent declaring a named app integration complete without live evidence.

## Cross-cutting implementation rules

1. Keep one authoritative dispatcher and queue. The terminal, model, HTTP and MCP facade see the same tool ownership and live registry; no second engine path.
2. Keep the agent independent from Ink. JSON automation and hooks (HOT-57) are deferred.
3. Preserve existing tool calls and HTTP fields. Add explicit optional fields/endpoints; do not silently change tool-less ask into an executing agent.
4. Snapshot changing catalogues at model-step boundaries. Permission decisions bind to the tool identity and registry revision shown for that call; reconnecting/replacing a tool invalidates cached "always" grants for it. Recheck identity before dispatch.
5. Project instructions, skill bodies and external server descriptions cannot grant permissions. Session resume refreshes actual settings.
6. Keep tests offline with fake providers and SDK/stub servers. Live DesignCraft/app verification is a separate release gate with recorded evidence.
7. Ship each slice behind absence-by-default configuration where possible. A failed optional server or malformed skill must not disable the built-in DesignCraft path. Existing sessions and config files continue to work.
8. Keep source and generated dist together when implementation changes src. This planning change touches documentation only.

## Validation and release gates

For each implementation slice, run npm run typecheck and targeted meaningful unit checks. Before merging an issue's completed feature, run npm run test:unit, npm run smoke and npm run build; check generated dist and packaging. Before the combined release, run npm test on macOS with pinned DesignCraft, a packed-install check from a temporary directory, and the live checks below.

| Gate | Required evidence |
| --- | --- |
| Shared runtime | Terminal and MCP facade interleave calls against one document; root mismatch is refused; two simultaneous starts cannot create competing runtimes |
| External connection | Tool discovery and calls work through stdio and Streamable HTTP fixtures; named real app succeeds with its real auth method |
| Design guidance | Project skill and bundled init retain their precedence; folder-aware init cites a brief and preserves existing memory on rerun |
| Recovery | Restart/resume preserves provider-native history, never retries an uncertain mutation and notices runtime/document changes |
| Regression | Existing calls/tools/HTTP, chart fixtures, image round trips, project memory and the terminal still work |

No tests or live integrations have been run for this planning-only change. Acceptance cases describe future required evidence, not present results.

## Main risks and limits

- App connectivity is bounded by the selected app's server capabilities and authentication. A generic MCP client alone does not create a Figma or Adobe integration, nor a live DesignCraft window connection.
- The shared HTTP result currently loses some MCP structure; raw-result preservation is part of HOT-54, before the facade ships.
- Signed provider histories cannot be casually trimmed. HOT-56 deliberately uses new context branches for compaction and never edits retained native blocks.
- A session journal is not a saved layout document. Restarting still requires explicit inspection of the current engine/document.
- HOT-65 (PDF reader) and HOT-61 (studio/user prompt layers) stay outside this scope. PDF discovery can ship with an explicit unread-file limitation.
- Legacy SSE is a compatibility transport. New HTTP integrations use Streamable HTTP. See [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); tool pagination, list changes and content contracts follow the [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). These protocol sources were checked during planning; implementation must verify the installed SDK API before coding.

## HOT-54 — MCP connections and a shared Maquette MCP bridge

**Outcome:** Maquette can use tools from other apps through MCP, and another MCP client can operate the same DesignCraft document as the terminal. DesignCraft remains the built-in connection; adding another server must never start a second DesignCraft or bypass the document queue.

### Contract
- Add an object-valued `mcpServers` setting. Resolve whole server entries by name in this order: user settings < project `.mcp.json` < project settings. A higher entry replaces the whole lower entry, avoiding accidental credential/argument inheritance. `disabled: true` suppresses a lower entry. Preserve unrelated settings on edits; config output redacts secret values.
- A stdio entry accepts `type: "stdio"` (optional when command is present), `command`, `args: string[]`, `env: Record<string,string>`. An HTTP entry accepts `type: "http"` (default for URL), `url`, optional `headers`; explicit `type: "sse"` enables legacy SSE. Reject command+URL ambiguity. Relative executables run from the project root; no shell expansion.
- Resolve `${ENV_VAR}` references in env/header values; a missing variable disables that server with an actionable error. Inherit the parent process environment for stdio compatibility. Never echo env/header values into UI, traces, sessions or errors. Prefer env references over stored credentials.
- Project MCP configuration can launch programs. Before its first use, require trust for the canonical root and effective config hash; persist that local trust outside the repository. Changed effective project configuration invalidates trust. Noninteractive startup skips untrusted project entries with an error identifying how to trust them interactively; user-level configuration is explicitly user-controlled.
- Initial transports: stdio, Streamable HTTP, explicit legacy SSE. Use the installed SDK and negotiated protocol. Do not promise arbitrary Claude Code config extensions, automatic OAuth, sampling, elicitation, prompts/resources browsing, an app marketplace or live DesignCraft window control. Auth-required servers show that state and an actionable message; first release supports configured credentials. An OAuth-only app needs a separately scoped auth issue before promising its connection.
- Create a registry owned by the running server in `src/server.ts`, with built-in engine and external client adapters. Suggested modules: `src/mcp/config.ts`, `clients.ts`, `registry.ts`, `bridge.ts`. Keep the built-in engine/sidecar logic in `src/engine.ts`.
- Preserve built-in tool names. External tools have a deterministic provider-safe name `<server>__<tool>`; retain an exact reverse map, sanitize and shorten to at most 64 ASCII letters/digits/underscore/hyphen with a stable hash when needed. Reject ambiguous mappings; reserve built-in names. Never infer the original remote name by splitting the exposed name.
- Fetch all tool pages, preserve schemas, annotations and structured results. Keep an immutable registry snapshot for each model request; publish reconnect/list-change updates between model steps. Removed tools return a clear unavailable result. Update `byName`, prompt catalogue, completion, HTTP list and MCP list together.
- Bound startup to 10 seconds per external server and calls to 120 seconds by default (configurable call timeout, maximum 600 seconds). An unavailable optional server is reported once and does not prevent built-in tools working. States: disabled, untrusted, connecting, connected, auth-required, failed. `/mcp` lists state, transport, source and tool count; `/mcp reconnect <name>` replaces one connection. Close owned child processes/transports on shutdown. Never automatically replay a call whose outcome is uncertain.
- All calls enter the existing FIFO queue initially, including external tools. Keep permission waits outside it. External tool names never inherit the built-in read-name heuristic: unreviewed external tools count as changes; a per-server explicit trusted-read policy may honor readOnlyHint. In plan mode only vetted reads are offered. Tool descriptions and server instructions are attributed external content below core policy.
- Add `maquette mcp`: a stdio MCP facade with tools/list and tools/call. Discover the selected-port runtime, verify canonical project root and a runtime/protocol marker, then attach. If no runtime exists, start one through the same server startup path, with an exclusive per-root/port ownership lock and startup handshake. A different-root or non-Maquette listener is an error, not a fallback. Do not attach merely because a port responds.
- The facade owns only a runtime it starts; disconnecting an attached client never kills the terminal's runtime. On parent shutdown clients fail cleanly; next startup may reconnect, without replaying writes. Forward raw MCP content, structuredContent and isError; extend the internal queue result while keeping existing HTTP text/images fields compatible. Tool list changes are notified to capable clients.
- Keep stdout exclusively MCP JSON-RPC in bridge mode, with diagnostics on stderr. Existing local HTTP callers and MCP callers are direct tool invocations governed by their host's authorization; they must not wait for an Ink approval. They are recorded as external calls for HOT-56. The downstream host must enforce permissions. Do not claim the terminal's plan mode governs other clients.

### Implementation slices
1. Typed configuration, trust and redaction; stub transport fixtures.
2. Shared registry, lifecycle, dispatch, result preservation and live catalogue refresh.
3. Terminal MCP controls and read policy.
4. Stdio facade, root-checked discovery, ownership lock and shared queue integration.

### Acceptance
- An SDK fixture exposes two pages of tools, text+image+structured results and list-change notifications. Every surface agrees after reconnect; collisions never route to the wrong tool.
- A second stdio server echoes a value from the prompt; a local HTTP fixture does the same over Streamable HTTP; legacy SSE has a separate fixture.
- Broken config, missing env, untrusted project config, connection failure and timeout leave DesignCraft usable and reveal no credentials.
- A facade and terminal targeting the same root/port operate one stub document, in FIFO order. Two simultaneous facade starts produce one runtime. Another root on the port is refused.
- Disconnect during a write reports an uncertain outcome without retrying. Shutdown leaves no owned child processes.
- A live DesignCraft check plus one available external app connection is recorded before release. The target app and its authentication requirement must be named at implementation kickoff; fixture success alone is not evidence of app compatibility.

---

## HOT-55 — One skill catalogue for the agent, CLI and /init

**Outcome:** A designer can install a folder containing SKILL.md, invoke it by name, or let the agent load it when relevant. Preserve existing MAQUETTE.md behavior and /init's survey, questions and write consent.

### Contract
- Introduce a shared resolver in `src/skills/`. Engine, terminal and CLI use the same root/home/package locations and resolution. Precedence: project `.maquette/skills` > project `.claude/skills` > user `~/.maquette/skills` > bundled `skills/`. This preserves existing project/user /init overrides while adding Claude-compatible project folders.
- Discover only direct `<name>/SKILL.md` folders. Require YAML frontmatter with nonempty `name` and `description`; name must match directory, use lowercase letters/digits/hyphens, length 1–64. Limit entry file to 128 KiB and catalogue description to 1024 characters; warn and skip invalid entries. Use a maintained YAML parser with an explicitly chosen pinned version at implementation time, not regex parsing of arbitrary YAML.
- Resolve skill paths canonically within the declared skill root; reject traversal and symlink escape. Duplicate valid names use precedence above; show shadowed sources in details. An invalid higher entry is reported and the next valid entry may win. Built-in command collisions other than init are reported and skipped; /init remains the specialized lifecycle invoking the resolved init body.
- Only names, descriptions and source identifiers go in the environment prompt block; bodies load on demand. Refresh catalogues at turn boundaries and on listing. `/skills` and `maquette skills [name]` work without a model or running engine and show source, override and validation diagnostics. Add completion for valid /<skill> names; preserve current routing of built-in slash commands.
- Add an ordinary read-only `skill` tool, taking `name`, returning body, source and base directory. It is available to the model and direct/HTTP/MCP tool callers through the engine. `/<name> <arguments>` injects the resolved body with clearly separated user arguments into the agent turn. Resolve supporting relative paths from the skill directory, without changing the session cwd.
- Supporting files outside the project (user/bundled skills) need a bounded read path: extend the skill reader with an optional relative `path` argument that returns UTF-8 text, confined to that resolved skill directory, capped at 128 KiB with a truncation notice. Do not broadly relax workspace confine(). Executable scripts do not run automatically and no permission is granted by loading a skill.
- Skill instructions are task guidance below the core and current request. Every subsequent tool invocation retains normal permission checks, including plan mode. Catalogue and body changes invalidate the relevant prompt snapshot/cache and produce a short notice.
- Unify the existing initSkill() special resolver with this resolver. Keep /init context (existing memory, nonvision warning, plan restriction and optional note). MAQUETTE.md is already read on every turn and exposed over HTTP: retain that implementation, rather than adding another instruction layer.
- Bundle init (existing), chart, report-review and designcraft. Chart guidance uses the current chart schema and installed example specs; report-review inspects and renders each page and reports evidence; designcraft documents the pinned engine's actual tool conventions. Skills are copied by the existing package files inclusion and work from both src and dist.

### Implementation slices
1. Resolver/parser, override rules and catalogue diagnostics.
2. Engine skill reader, prompt catalogue and /<name> routing; /init migration.
3. CLI listing/completion, bundled guidance and packaging checks.

### Acceptance
- Fixtures exercise all four roots, invalid YAML, duplicate names, missing files, reserved commands and symlink/traversal denial.
- Captured fake-provider requests prove that unloaded bodies are absent, a requested body is present only after loading, and the catalogue updates on the next turn.
- Both explicit /brand-check and a scripted model's skill call load the same body/source. Plan mode still refuses a write requested by that skill.
- Existing /init and MAQUETTE.md change-notice tests continue to pass, including custom init overrides and rerun preservation.
- A packed-install check finds the bundled skills and their support files. A manual report-review renders real pages; do not use a live model's voluntary skill selection as a deterministic unit test.

---

## HOT-63 — Folder-aware /init with bounded discovery

**Outcome:** /init uses the brief, style guidance and linked images actually present beside the document, then asks only what remains unanswered.

### Contract
- Share one folder-map implementation between a read-only workspace `tree` tool and the `folder` property of document_survey. Suggested file `src/tools/workspace/tree.ts`; preserve the existing survey response and render content.
- Inputs: `path` defaults to ".", `depth` defaults to 3, allowed 0–6. Sort deterministically by path; include file names and byte sizes. Directories carry counts by case-insensitive extension and aggregate bytes, explicitly labeled as sampled/partial when limits are reached.
- Exclude hidden entries, node_modules, .git, .maquette and maquette-renders. Use confine() for the requested path and every followed entry; do not traverse directory symlinks, list them as links without reading targets. Report unreadable entries without failing the entire map.
- Collapse a directory with more than 20 immediate visible entries to its summary. The caller can request that directory directly for a bounded first page of its entries (same 20-entry display cap, explicit omitted count); it can then use existing glob/grep for a narrower search.
- Bound discovery: at most 2000 visited entries, 250 emitted lines, 24 KiB output, 2 seconds elapsed. Counts and bytes are for visited entries only when incomplete; never present them as exact recursive totals. No content sniffing or file reads for the map. Escape control characters in names; show truncation and a narrower-path/depth hint. Root summary counts do not depend on whether UI children are collapsed.
- document_survey includes this map even when no document is open, so selection of a source document and brief can happen together. Given the same root/depth, survey.folder and tree return the same map structure (timing metadata excluded).
- Extend the bundled init skill between survey and design study: choose at most five supporting text files and three reference/linked images, state the selection and reason in one line, then use read_file/view_image within their existing limits. File roles are inferred by the model from names and contents; the map contains no heuristic "brand guide" tags.
- Prefer direct evidence from brief/guide to visual guesses. Name each authority by relative path in MAQUETTE.md, with a concise statement of its role, and omit the house-style question when already answered. If guides conflict, ask which governs; do not choose silently. Keep inferred findings labeled and preserve the existing ~2000-token memory budget. Never copy whole source files into memory.
- HOT-65 is optional. Until read_pdf exists, do not promise PDF understanding: only use installed pdftotext through bash with normal permissions, otherwise state which PDF remains unread and ask for the missing guidance. Do not install converters as an /init side effect. A nonvision model receives the existing limitation notice.
- On rerun, retain the current propose-and-agree workflow; changing a brief never automatically overwrites the person's existing memory.

### Implementation slices
1. Pure bounded map builder and workspace tree tool.
2. Survey integration for open/no-document cases.
3. Init skill file-reading step and evidence-based question reduction.

### Acceptance
- Fixtures cover a large Links folder, nested packages, hidden files, permissions failures, symlinks and traversal. Output and traversal budgets hold; partial totals are marked.
- Shared-tree equality is checked for both survey cases. Existing survey fields and page images remain available.
- A scripted /init reads brief.md and selected images, identifies the guide by path, omits answered questions, and proposes a concise memory. Rerun keeps unrelated prose unchanged.
- A PDF-only guide without pdftotext produces an explicit limitation/question, not an invented brand rule. No dependency on HOT-65 is required to ship.

---

## HOT-56 — Durable sessions, safe context compaction and document notices

**Outcome:** Restarting the terminal can continue a conversation without replaying tool effects, and long sessions remain valid for the selected provider. Saved chat is not a backup of the DesignCraft document.

### Contract
- Add `src/agent/sessions.ts` for persistence and `src/agent/context.ts` for constructing provider requests. Save append-only versioned JSONL under `.maquette/sessions/<id>.jsonl`; record canonical root, session ID, timestamps, application/schema versions, provider/model changes, committed messages, native assistant payloads, usage, direct calls/shell output, tool outcomes and interruption markers. Do not persist callback-bearing UI events or raw step_start request copies.
- Persist user input before a request, final assistant/native payload before dispatching its calls, and each tool outcome before another model step. Record call start before execution. A trailing incomplete JSON line after a crash is ignored with a warning; malformed interior records or unsupported versions fail with recovery guidance. Use owner-only directories/files and one writer lock per session; another terminal must fork into a new session to continue it.
- Native provider content is replayed unchanged for that provider, including signed thinking and compaction blocks. Store normalized parts as well for provider switches; do not send one provider's native representation to another. Same-provider resume requires model compatibility or an explicit fresh summary branch; incompatible history must not be sent speculatively.
- `maquette --resume` chooses the latest resumable session in the current canonical root; `--resume <id>` selects one. `/sessions` lists ID, date, first-message excerpt and provider/model. No session produces an actionable message. `/clear` closes the conversation and creates a new ID, retaining the current process cost-total behavior.
- Resume restores conversation, not previous permissions or document state. Read current settings, reset session "always" grants, refresh tools/skills/project memory and inspect current document before any dependent mutation. Explain that unsaved document state may have been lost. Do not auto-open an old path or run prior tools to reconstruct state.
- A crash after call-start with no durable result leaves an uncertain outcome. Never retry it automatically. Complete provider call/result pairing with an explicit unknown-outcome marker in the restored request view, then inspect/ask before continuing. Interrupted partial text is not a completed native assistant reply.
- `/compact [focus]` works at an idle, completed call/result boundary using the current provider. Summarize purpose, constraints, authoritative file references, approved decisions, completed work, unresolved tasks and uncertainty. On failure/cancellation retain the old context. Persist a compaction record referencing the retained message boundary; build the next request from summary + intact recent message groups, preserving the original journal.
- Preserve native signed blocks byte-for-byte within retained groups. Compaction creates a new active context branch; it must never splice or edit native blocks. Test alongside existing Anthropic server-side compaction and retain its native output when provided.
- Automatic trimming never edits recorded or previously sent native/tool blocks. Apply text caps and image-size policy when a result is first ingested, with durable paths to complete local outputs. Older heavy results are removed only as whole groups via explicit compaction. Provide an estimated context-size warning; do not claim exact cross-provider token counts. No automatic client-side summarization in this increment.
- Add monotonic runtime ID + change sequence at the shared server. Maintain a bounded 1000-event ring and expose a root-checked `GET /changes?runtime=<id>&after=<seq>` endpoint. Record successful potentially mutating calls from all callers, including open_document; classify conservatively with registry metadata.
- Before each model step, append an attributed concise notice for unseen changes made by other sessions/callers. Never call an external mutation a local document edit without evidence. Own calls are not echoed. A runtime restart or ring gap says state may have changed and requires inspection before dependent edits. Persist the cursor; change notices are coordination signals, not document snapshots.

### Implementation slices
1. Versioned journal, writer lock, crash recovery and message commit integration.
2. Resume/session listing/clear semantics.
3. Compaction branches, request views and bounded initial result ingestion.
4. Shared change feed, per-session cursors and notices.

### Acceptance
- Round-trip normalized and native messages, images, provider switches and server compaction; assert signed payload preservation.
- Crash fixtures cover partial final line, corrupt middle, in-flight write, interrupted response and competing writers. No tool runs during resume.
- Fake-provider /compact tests prove paired message groups and exact retained native content; failure preserves active history.
- Two stub clients mutate one document; only the other session is notified. Reconnect, runtime restart and ring overflow produce explicit gaps.
- Manually restart after a saved document edit, resume, inspect current state and continue without duplicate writes.

