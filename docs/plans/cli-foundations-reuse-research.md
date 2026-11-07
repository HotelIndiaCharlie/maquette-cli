# Reuse assessment before CLI implementation

Date: 7 November 2026. Planning only; no package installation, implementation or connection test performed.

## Required decision before coding

Before implementing HOT-54, HOT-55, HOT-63 or HOT-56, check maintained libraries, official examples and the actual target app's existing MCP server. Record: candidate/version, capabilities reused, license/maintenance, dependency and migration cost, missing Maquette behavior, and chosen approach. Refresh this research at implementation kickoff; versions and APIs can change. The existing detailed contracts describe outcomes, not permission to rebuild library functionality.

Prefer existing components. A custom component requires a concrete uncovered requirement, not a preference for owning every layer. Do not rewrite transports, JSON-RPC, MCP negotiation, tool schema handling or OAuth exchange flows. If a framework eliminates more code than it introduces, revise the plan to use it.

## Candidates checked

| Component | Evidence | Fit and planning decision |
| --- | --- | --- |
| Official MCP TypeScript SDK | [Official v1 client guide](https://ts.sdk.modelcontextprotocol.io/client) documents stdio, Streamable HTTP, legacy SSE, tool discovery/calls and OAuth helpers/examples. Local package is MIT-licensed 1.32.2; its installed declarations contain Client.listTools/callTool, the three transports and OAuthClientProvider. | Preferred starting point for HOT-54 because the project already uses it. Reuse transport/auth/protocol behavior; write only integration with Maquette's shared runtime, configuration, queue and permissions. Local declarations confirm availability, not end-to-end behavior. |
| Vercel AI SDK MCP client | [Official MCP guide](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) provides createMCPClient and adapts MCP capabilities into its SDK. | A real alternative if adopting its model/tool abstraction reduces total work. Current Maquette has its own Provider and Message interfaces, so compare conversion/migration costs before adding it. Do not assume a new agent stack is required just to connect another app. |
| LangChain MCP adapters | [Maintainer's TypeScript package](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters) provides multi-server integration for LangChain tools. | Compare multi-server lifecycle/namespacing reuse against the cost of adapting LangChain tool objects to the existing engine. Not selected solely because it is a larger framework. |
| LangGraph persistence | [Official TypeScript persistence guide](https://docs.langchain.com/oss/javascript/langgraph/persistence) provides graph-state checkpointers and cross-thread stores. | Evaluate for HOT-56 if a graph runtime is otherwise justified. Checkpoints are not proof of unchanged replay of Maquette's provider-native signed payloads. Require that compatibility check before adoption. A small append-only journal may be simpler in the existing loop, but that choice must be justified against maintained persistence options. |
| Agent Skills standard | [Official integration guide](https://agentskills.io/client-implementation/adding-skills-support) describes discovery, metadata catalogues, on-demand bodies and support files. | Follow the existing SKILL.md ecosystem for HOT-55. Use a maintained YAML parser. Recheck strict name/validation choices in the earlier spec against interoperability; do not invent a new skill format. |
| Node filesystem primitives | The workspace already has confined read_file, glob, grep and survey tools. | HOT-63 reuses these and one bounded folder traversal helper. No new agent framework is justified solely by a folder map. |

These fit assessments are engineering judgments from the checked documentation and local architecture; no candidate was benchmarked or integrated.

## What is actually Maquette-specific

- One DesignCraft document shared by terminal, model, HTTP and MCP callers, with serial execution and existing sidecars.
- Mapping connection/tool identity into the existing permissions, prompt snapshots and tool catalogue.
- Discovering and attaching to the correct project runtime.
- Resume semantics that preserve provider-native history and never replay an uncertain write.
- Reading project files into the existing init workflow while preserving the designer's memory.

SDKs should handle the generic connection machinery. Only the uncovered application behavior above should need custom integration.

## HOT-56: personal-use first delivery

Deliver session saving, listing and resume first. This does not need the new external MCP connections: it can use the existing DesignCraft runtime. Keep compaction and the cross-client change feed as later slices in the same issue; the change feed integrates with HOT-54 when available.

Personal acceptance scenario:
1. Start Maquette on a disposable DesignCraft document and ask it to inspect a page.
2. Make a small requested edit and explicitly save the document.
3. Close Maquette and restart with --resume.
4. Ask what was done and what remains; verify the conversation is retained.
5. Inspect the current document and continue. Resuming must not repeat the previous edit.
6. Start a new conversation separately and verify the old one remains listed.

The journal preserves conversation; saving the layout remains an explicit document operation. Use ordinary targeted recovery/provider-history checks for correctness; the owner can try this workflow without running a chart study or recruiting designers.

## Active scope

HOT-54 → HOT-55 → HOT-63 → HOT-56. HOT-56's first resume slice can be delivered independently of HOT-54; only later shared-change integration requires its runtime contract.

HOT-57 (headless JSON automation/hooks) is deferred and excluded from this implementation plan. Its specification remains on its Linear issue for later reuse. HOT-61 and HOT-65 remain outside scope. No implementation is authorized by these planning updates.


## Implementation refresh — 7 November 2026

Official MCP v1 client guide and installed declarations agree: Client.connect/listTools/callTool, StdioClientTransport, StreamableHTTPClientTransport and SSEClientTransport cover connection machinery. Installed SDK is 1.32.2 (MIT), Node is 24.22.1. No protocol implementation or interactive OAuth flow is needed.

Rechecked AI SDK MCP tools, LangGraph persistence and Agent Skills specification/client implementation, plus yaml official documentation. Retain the current provider-native message loop: moving it to AI SDK/LangGraph would require translating signed provider history and replacing permissions/UI integration. Node filesystem JSONL covers the required single-writer append journal; Maquette owns only commit ordering, recovery and request views. The shared registry/root ownership remain application-specific. Agent Skills supplies format and progressive loading; yaml 2 will parse frontmatter.

The real acceptance target is the installed pinned DesignCraft engine shared over the Maquette facade with an SDK MCP client. stdio/HTTP/SSE fixtures establish transport behavior only; no Figma/application-specific compatibility or interactive OAuth is claimed.
