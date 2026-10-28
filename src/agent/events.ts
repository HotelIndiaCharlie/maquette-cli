// What the agent tells whoever is listening: the Ink screen, the plain log, the tests, and
// later a JSON mode. The agent knows nothing about how they're drawn.
import type { AssistantMessage, ChatRequest, StopReason, Usage } from "../providers/types.ts";
import type { Source } from "../server.ts";

export type PermissionAnswer = "y" | "n" | "a";
export type Level = "info" | "warn" | "error";
export type Choice = { id: string; label: string; hint?: string };

// Why something didn't go as asked, one word each, so a trace can be filtered by it.
export type Failure =
  | "provider.error" // the model's API failed: no key, no network, overloaded, …
  | "provider.no_reply" // the stream ended without a reply
  | "fallback.text_protocol" // the model can't call tools; it writes `maquette call` lines from here on
  | "model.refusal"
  | "model.max_tokens"
  | "model.bad_args" // the arguments weren't JSON, or didn't fit the tool
  | "model.unknown_tool" // a tool name that doesn't exist
  | "policy.plan_denied"
  | "user.declined"
  | "user.interrupted"
  | "tool.error"; // the tool ran and failed

// Where a model's call spent its time, in ms: waiting on the person's y/n, waiting in the queue
// behind other calls, and running in the engine.
export type Timing = { permission: number; queue: number; run: number };

export type Status = {
  provider: string;
  model: string;
  effort?: string;
  mode: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
  turns: number;
  textProtocol: boolean;
};

export type AgentEvent =
  | { type: "user"; text: string } // a line the person sent to the model
  | { type: "text"; text: string } // a piece of the answer, as it streams in
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; source: Source } // the model asked for a call; a result follows
  | { type: "tool_result"; id: string; name: string; ok: boolean; text: string; images: string[]; ms: number; failure?: Failure; timing?: Timing; permission?: PermissionAnswer | "allowed" }
  // One request to the model and its reply, inside a turn. The request's messages are the live
  // history, so a listener that keeps them copies them before returning.
  | { type: "step_start"; step: number; provider: string; model: string; request: Omit<ChatRequest, "signal"> }
  | { type: "step_end"; step: number; ms: number; message?: AssistantMessage; stop?: StopReason; model?: string; usage?: Usage; thinking?: string; failure?: Failure; error?: string }
  | { type: "ask_permission"; id: string; name: string; input: Record<string, unknown>; reply: (answer: PermissionAnswer) => void }
  | { type: "choose"; title: string; options: Choice[]; current?: string; reply: (id: string | null) => void } // a list to pick from: arrows and numbers, esc for none
  | { type: "shell"; command: string; output: string; code: number | null } // a `!` command the person ran
  | { type: "output"; text: string; ok?: boolean; images?: string[] } // a direct tool call's result or a command's text
  | { type: "notice"; text: string; level: Level }
  | { type: "done"; stop?: StopReason; usage?: Usage; interrupted?: boolean } // the turn is over
  | { type: "status"; status: Status }
  | { type: "exit" };
