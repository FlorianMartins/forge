// The three ways to work, and what each one is allowed to touch.
//
// The distinction that matters is not "how clever is the model" but "what can it do to my
// machine". So the mode decides the tool set in CODE, and the prompt merely describes the mode it
// is already in. A plan-mode model that decides to write a file finds no tool to do it with.

import type { Tool } from "../agent/loop.js";
import { AGENT_PROMPT, PLAN_PROMPT, SYSTEM_PROMPT } from "../prompts.js";

export type Mode = "chat" | "plan" | "agent";

export const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "chat", label: "Discussion", hint: "Répond avec ce que vous joignez. Aucun accès au dépôt." },
  { id: "plan", label: "Plan", hint: "Lit le dépôt et propose un plan. Ne modifie rien." },
  { id: "agent", label: "Agent", hint: "Lit, modifie et propose des commandes — avec votre accord." },
];

/** Tools that only observe. The allow-list is explicit: a new tool is powerless until named here. */
const READ_ONLY = new Set(["read_file", "list_files", "search_text", "get_diagnostics"]);

export function toolsForMode(all: Tool[], mode: Mode): Tool[] {
  switch (mode) {
    case "chat":
      return [];
    case "plan":
      return all.filter((t) => READ_ONLY.has(t.schema.name));
    case "agent":
      return all;
  }
}

export function promptForMode(mode: Mode): string {
  switch (mode) {
    case "chat":
      return SYSTEM_PROMPT;
    case "plan":
      return PLAN_PROMPT;
    case "agent":
      return AGENT_PROMPT;
  }
}
