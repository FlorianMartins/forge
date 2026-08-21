// The model list the picker shows.
//
// Two sources, merged: the generated catalogue (411 models with prices and context windows, no
// network) and whatever the configured endpoint actually serves. The second matters more than it
// sounds — a team running vLLM has three models with names nobody outside knows, and a catalogue
// that cannot show them is a catalogue nobody uses.

import * as vscode from "vscode";
import { t } from "../shared/i18n.js";
import { GENERATED_MODELS } from "../core/router/catalog.generated.js";
import { isLocalEndpoint } from "../core/redaction/index.js";
import type { UiModel } from "../shared/protocol.js";
import { endpointFor, providerFor, type Keys, type Settings } from "./config.js";

/** Models a provider is currently serving, or an empty list when it cannot be reached. */
async function served(settings: Settings, keys: Keys, provider: Settings["chat"]["provider"]): Promise<string[]> {
  try {
    const p = await providerFor(settings, keys, provider);
    return await p.listModels();
  } catch {
    return [];
  }
}

export async function listModels(settings: Settings, keys: Keys, current: string): Promise<UiModel[]> {
  const out: UiModel[] = [];
  const seen = new Set<string>();

  // 1. What the local endpoint serves. Always first: it is the free tier, and the default.
  const localUrl = safe(() => endpointFor(settings, "local"));
  if (localUrl) {
    for (const id of await served(settings, keys, "local")) {
      seen.add(id);
      out.push({
        id,
        name: id,
        vendor: "local",
        context: 0,
        inUsd: 0,
        outUsd: 0,
        cachedInUsd: 0,
        provider: "local",
        local: true,
        current: id === current,
      });
    }
  }

  // 2. An internal gateway, if one is configured — same idea, someone else's hardware.
  const gatewayUrl = safe(() => endpointFor(settings, "openai-compatible"));
  if (gatewayUrl) {
    for (const id of await served(settings, keys, "openai-compatible")) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: id,
        vendor: t("gateway"),
        context: 0,
        inUsd: 0,
        outUsd: 0,
        cachedInUsd: 0,
        provider: "openai-compatible",
        local: isLocalEndpoint(gatewayUrl),
        current: id === current,
      });
    }
  }

  // 3. The priced catalogue. No request: it ships with the extension and refreshes by workflow.
  for (const [id, name, vendor, context, inUsd, outUsd, cachedInUsd] of GENERATED_MODELS) {
    if (seen.has(id)) continue;
    out.push({
      id,
      name,
      vendor: vendor || "divers",
      context,
      inUsd,
      outUsd,
      cachedInUsd,
      provider: "openrouter",
      local: false,
      current: id === current,
    });
  }

  return out;
}

/** A short label for the composer button: the name without the vendor, plus a price hint. */
export function labelFor(models: UiModel[], id: string): string {
  const found = models.find((m) => m.id === id);
  if (!found) return id;
  return found.name;
}

/** Reasoning is only worth offering on models that actually do it. */
export function supportsReasoning(id: string): boolean {
  return /o[134]|gpt-5|claude|sonnet|opus|haiku|fable|deepseek|qwen3|reason|think|magistral|grok-[34]|gemini-[23]/i.test(id);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function openFiles(): Array<{ path: string; active: boolean; language: string; dirty: boolean }> {
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  const docs = vscode.workspace.textDocuments.filter(
    (d) => !d.isClosed && d.uri.scheme === "file" && !d.uri.path.endsWith(".git"),
  );
  return docs.map((d) => ({
    path: vscode.workspace.asRelativePath(d.uri, false),
    active: d.uri.toString() === active,
    language: d.languageId,
    dirty: d.isDirty,
  }));
}
