import { AnthropicProvider, defaultModel } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
export function createProvider(settings) {
    if (settings.provider === "openai-compatible")
        return new OpenAICompatibleProvider(settings.model, settings.providers["openai-compatible"]);
    return new AnthropicProvider(settings.model, settings.providers.anthropic);
}
export const defaultModels = { anthropic: defaultModel, "openai-compatible": undefined };
export * from "./types.js";
