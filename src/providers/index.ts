// The provider named in the settings, with its model.
import type { Settings } from "../settings.ts";
import { AnthropicProvider, defaultModel } from "./anthropic.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { Provider } from "./types.ts";

export function createProvider(settings: Settings): Provider {
  if (settings.provider === "openai-compatible") return new OpenAICompatibleProvider(settings.model, settings.providers["openai-compatible"]);
  return new AnthropicProvider(settings.model, settings.providers.anthropic);
}

export const defaultModels: Record<Settings["provider"], string | undefined> = { anthropic: defaultModel, "openai-compatible": undefined };
export * from "./types.ts";
