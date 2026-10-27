// What the agent tells whoever is listening: the Ink screen, the plain log, the tests, and
// later a JSON mode. The agent knows nothing about how they're drawn.
import type { StopReason, Usage } from "../providers/types.ts";
import type { Source } from "../server.ts";

export type PermissionAnswer = "y" | "n" | "a";
export type Level = "info" | "warn" | "error";

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
  | { type: "tool_result"; id: string; name: string; ok: boolean; text: string; images: string[]; ms: number }
  | { type: "ask_permission"; id: string; name: string; input: Record<string, unknown>; reply: (answer: PermissionAnswer) => void }
  | { type: "shell"; command: string; output: string; code: number | null } // a `!` command the person ran
  | { type: "output"; text: string; ok?: boolean; images?: string[] } // a direct tool call's result or a command's text
  | { type: "notice"; text: string; level: Level }
  | { type: "done"; stop?: StopReason; usage?: Usage; interrupted?: boolean } // the turn is over
  | { type: "status"; status: Status }
  | { type: "exit" };
