// The three ways to work, and what each one is allowed to touch.
//
// The distinction that matters is not "how clever is the model" but "what can it do to my
// machine". So the mode decides the tool set in CODE, and the prompt merely describes the mode it
// is already in. A plan-mode model that decides to write a file finds no tool to do it with.

import type { Tool } from "../agent/loop.js";
import { AGENT_PROMPT, PLAN_PROMPT, SYSTEM_PROMPT } from "../prompts.js";
import { t } from "../../shared/i18n.js";

export type Mode = "chat" | "plan" | "agent";

// Labels are read at call time rather than at module load, so the list follows the interface
// language even when this module was imported before the host announced it.
export const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "chat", label: t("Chat"), hint: t("Answers from what you attach. No access to the repository.") },
  { id: "plan", label: "Plan", hint: t("Reads the repository and proposes a plan. Changes nothing.") },
  { id: "agent", label: "Agent", hint: t("Reads, edits and proposes commands — with your approval.") },
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
