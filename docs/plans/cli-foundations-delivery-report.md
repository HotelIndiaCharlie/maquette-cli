# CLI foundations — delivery evidence

Date: 7 November 2026. Branch: `codex/cli-foundations`. Implemented for review, not merged or released. Active issues: HOT-54, HOT-55, HOT-63, HOT-56. HOT-57/61/65 excluded. Bet 2 ownership and Bet 1 gates unchanged; execution was explicitly advanced by the owner.

## Delivered behavior

- HOT-56 A: append-only versioned journal, single writer, native/normalized messages, tool/direct/shell effects and interruptions; `/sessions`, `--resume [id]`, `/clear`; recovery into a separate copy, unknown-outcome pairing without replay and current-state inspection before model edits.
- HOT-54: SDK MCP 1.32.2 transports, structured configuration/whole-entry precedence and hash/root trust, paginated runtime registry with exact reverse names, per-step identities/permission checks, optional-server isolation, `/mcp` controls and stdio facade on the root/version-checked shared FIFO. Raw MCP results remain available alongside HTTP text/images; structured results also enter the agent's first-ingestion view.
- HOT-55: yaml 2.9.1 (ISC), one resolver for four skill roots, on-demand body/resource reader, CLI and slash commands, completion, prompt catalogue and four bundled skills. Scripts and permissions are not activated by skill loading.
- HOT-63: one bounded folder map for tree/survey, including no-document cases; supporting-file selection and evidence citations in init, unresolved/conflicting-authority questions and rerun consent preserved.
- HOT-56 E: explicit provider-based compaction branches, intact recent native groups, heavy-result limits at first ingestion with complete-output references, attributed cross-client notices with runtime identity/monotonic sequence/1000-event ring, cursors and restart/gap handling. Mutations based on a model step preceding another caller's change are refused until state is rechecked.

## Checks actually executed

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run test:unit` | 113 passed, 0 failed |
| `npm run smoke` | Passed: 18 tools, 8 scripted model turns, 8 queued calls |
| `npm run build` | Passed; generated dist included |
| `npm test` | Passed on macOS with pinned DesignCraft 0.13.0: 5 chart creates, save/reopen, 2 chart updates |
| `npm run test:foundations:live` | Passed with real DesignCraft and separate SDK MCP client: shared chart, external data update, 5 rendered pages, save/restart/resume, no duplicate create, clear retains old journal |
| `npm run test:package` | Passed: local tarball, temporary install without dev dependencies, installed binary, four bundled skills, supporting resource, tree and real DesignCraft facade |
| `git diff --check` | Passed |

The final combined validation command exited 0:

```sh
npm run test:unit && npm run smoke && npm test && npm run test:foundations:live && npm run test:package
```

Final live artifacts (temporary directories, not committed):

- Chart regression: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-test-IlWNki`
- Shared runtime/resume trial: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-foundations-live-D8gUh5`
- Packed install: `/private/var/folders/y_/ph41165j66j4hzn0n77vbg040000gn/T/maquette-package-F2Myui`

## Practical limits and review

The actual app integration verified is DesignCraft shared between the terminal's AgentSession and an external MCP SDK client. Additional stdio/Streamable HTTP/legacy SSE servers are local fixtures. Figma, real search services and interactive OAuth are not claimed. The live acceptance uses a scripted provider with the real engine; a person's chosen model and credentials remain the manual trial in the [testing guide](../cli-foundations-testing.md). Existing provider tests exercise signed/native thinking and server compaction with deterministic HTTP fixtures.

A journal is conversation state, not layout persistence: save the document explicitly, reopen it explicitly after a fresh runtime, then inspect. `/compact` is explicit; no client-side automatic summarization was introduced. PDF extraction requires an already installed pdftotext under normal bash permissions. Internal chart hand changes are still reported rather than preserved by chart_update; the bundled chart skill states this limit.

The four issues are ready for In Review. Done awaits review/integration under the project workflow. No publication, deployment or automatic merge is authorized or performed.
