// Settings, keys, and the providers they produce.
//
// Two rules this file exists to enforce:
//   • an API key is never a setting. Settings sync to a Microsoft account, appear in
//     `settings.json`, and get committed by accident. Keys live in SecretStorage, which is the
//     OS keychain, and the only way to set one is the command that prompts for it.
//   • the endpoint decides what is local, not the setting name. Someone who points the "local"
//     provider at a public URL gets redaction and consent like any other remote provider.

import * as vscode from "vscode";
import { makeProvider, type Provider, type ProviderId } from "../core/providers/index.js";
import { isLocalEndpoint } from "../core/redaction/index.js";
import type { RedactionLevel, RedactionPolicy } from "../core/redaction/types.js";
import type { EscalationPolicy, RouterConfig } from "../core/router/route.js";

export const SECTION = "forge";

export interface Settings {
  chat: { provider: ProviderId; model: string };
  completion: { provider: ProviderId | "off"; model: string; enabled: boolean; debounceMs: number; maxTokens: number; multiline: boolean };
  endpoints: Record<ProviderId, string>;
  privacy: {
    redaction: RedactionLevel;
    allowUnredacted: boolean;
    blockedGlobs: string[];
    egressPolicy: "ask-once" | "ask-always" | "trust";
    auditLog: boolean;
    customTerms: string[];
  };
  budget: { perRequestUsd: number; dailyUsd: number };
  context: { maxTokens: number; repoMap: boolean };
  escalation: { policy: EscalationPolicy; provider: ProviderId; model: string };
}

export function readSettings(scope?: vscode.Uri): Settings {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const level = c.get<RedactionLevel>("privacy.redaction", "strict");
  const allowUnredacted = c.get<boolean>("privacy.allowUnredacted", false);
  return {
    chat: {
      provider: c.get<ProviderId>("chat.provider", "local"),
      model: c.get<string>("chat.model", "qwen2.5-coder:7b"),
    },
    completion: {
      provider: c.get<ProviderId | "off">("completion.provider", "local"),
      model: c.get<string>("completion.model", "qwen2.5-coder:7b"),
      enabled: c.get<boolean>("completion.enabled", true),
      debounceMs: c.get<number>("completion.debounceMs", 220),
      maxTokens: c.get<number>("completion.maxTokens", 128),
      multiline: c.get<boolean>("completion.multiline", true),
    },
    endpoints: {
      local: c.get<string>("endpoints.local", "http://127.0.0.1:11434/v1"),
      "openai-compatible": c.get<string>("endpoints.openaiCompatible", ""),
      openrouter: c.get<string>("endpoints.openrouter", "https://openrouter.ai/api/v1"),
      anthropic: c.get<string>("endpoints.anthropic", "https://api.anthropic.com/v1"),
    },
    privacy: {
      // "off" is only honoured when the user also ticked the box that says they mean it.
      redaction: level === "off" && !allowUnredacted ? "balanced" : level,
      allowUnredacted,
      blockedGlobs: c.get<string[]>("privacy.blockedGlobs", []),
      egressPolicy: c.get<"ask-once" | "ask-always" | "trust">("privacy.egressPolicy", "ask-once"),
      auditLog: c.get<boolean>("privacy.auditLog", true),
      customTerms: c.get<string[]>("privacy.customTerms", []),
    },
    budget: {
      perRequestUsd: c.get<number>("budget.perRequestUsd", 0.25),
      dailyUsd: c.get<number>("budget.dailyUsd", 2),
    },
    context: {
      maxTokens: c.get<number>("context.maxTokens", 8000),
      repoMap: c.get<boolean>("context.repoMap", true),
    },
    escalation: {
      policy: c.get<EscalationPolicy>("escalation.policy", "ask"),
      provider: c.get<ProviderId>("escalation.provider", "openrouter"),
      model: c.get<string>("escalation.model", ""),
    },
  };
}

export function redactionPolicy(s: Settings): RedactionPolicy {
  return { level: s.privacy.redaction, customTerms: s.privacy.customTerms, blockOnSecret: true };
}

export function routerConfig(s: Settings): RouterConfig {
  return {
    chat: s.chat,
    completion: { provider: s.completion.provider, model: s.completion.model },
    escalateTo: s.escalation.model ? { provider: s.escalation.provider, model: s.escalation.model } : undefined,
    escalation: s.escalation.policy,
    // A 7B model served by Ollama defaults to a 4k window and rarely exceeds 32k in practice.
    localContextTokens: 32000,
  };
}

export function endpointFor(s: Settings, id: ProviderId): string {
  const url = s.endpoints[id];
  if (url) return url;
  throw new Error(`No endpoint configured for “${id}”. Set ${SECTION}.endpoints in the settings.`);
}

export class Keys {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private static id(provider: ProviderId): string {
    return `${SECTION}.key.${provider}`;
  }

  get(provider: ProviderId): Thenable<string | undefined> {
    return this.secrets.get(Keys.id(provider));
  }

  store(provider: ProviderId, key: string): Thenable<void> {
    return this.secrets.store(Keys.id(provider), key.trim());
  }

  delete(provider: ProviderId): Thenable<void> {
    return this.secrets.delete(Keys.id(provider));
  }
}

/** Build the provider for a role, resolving its endpoint and (if remote) its key. */
export async function providerFor(s: Settings, keys: Keys, id: ProviderId): Promise<Provider> {
  const baseUrl = endpointFor(s, id);
  const local = isLocalEndpoint(baseUrl);
  const apiKey = local && id === "local" ? undefined : await keys.get(id);
  if (!local && !apiKey && id !== "openai-compatible") {
    throw new Error(`No API key stored for “${id}”. Run “Forge: Enregistrer une clé de fournisseur”.`);
  }
  return makeProvider({ id, baseUrl, apiKey });
}

/** True when this role would send data off the machine — the question consent depends on. */
export function isRemote(s: Settings, id: ProviderId): boolean {
  try {
    return !isLocalEndpoint(endpointFor(s, id));
  } catch {
    return false;
  }
}
