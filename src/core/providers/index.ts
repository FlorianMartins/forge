// Where a configuration becomes a provider. Everything above this line is settings; everything
// below it is HTTP.

import { isLocalEndpoint } from "../redaction/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export { OpenAICompatibleProvider, isOllama } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";

export type ProviderId = "local" | "openrouter" | "openai-compatible" | "anthropic";

export interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
  apiKey?: string;
}

export const ATTRIBUTION = {
  referer: "https://github.com/FlorianMartins/hivey-forge",
  title: "Hivey Forge",
};

export function makeProvider(cfg: ProviderConfig): Provider {
  if (cfg.id === "anthropic") {
    return new AnthropicProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey ?? "" });
  }
  return new OpenAICompatibleProvider({
    id: cfg.id,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    // "local" is a claim about the endpoint, not about the setting name: someone who points the
    // local provider at api.openai.com must still get redaction. The URL decides.
    isLocal: isLocalEndpoint(cfg.baseUrl),
    referer: ATTRIBUTION.referer,
    title: ATTRIBUTION.title,
  });
}
