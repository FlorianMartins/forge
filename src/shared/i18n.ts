// Translation, with the English string as its own key.
//
// The convention is gettext's, and VS Code's own `vscode.l10n`: what you write in the code IS the
// English text, and a table maps it to the other languages. Two properties fall out of that, and
// both matter more than they sound:
//
//   • a missing translation degrades to correct English rather than to `chat.composer.placeholder`;
//   • the code stays readable — `t("Send")` says what it renders, `t("btn.send")` does not.
//
// There is one implementation for the extension host, the panel and the terminal client, because
// three would drift. Each surface only has to say which language it is in:
//   host   → vscode.env.language
//   panel  → document.documentElement.lang (set by the host when it builds the HTML)
//   CLI    → $LC_ALL / $LC_MESSAGES / $LANG

import { FR } from "./i18n.fr.js";

export type Lang = "en" | "fr";

const TABLES: Record<Lang, Record<string, string>> = { en: {}, fr: FR };

let current: Lang = "en";

/**
 * Guess the language at import time.
 *
 * This is not a convenience: several modules build their labels at module scope — the mode list,
 * the period filters, the slash commands — and those run BEFORE any `setLanguage()` call the entry
 * point could make, because ES modules evaluate their imports first. Detecting here means every
 * one of them is already correct; a host that knows better still overrides it.
 */
function detect(): string | undefined {
  if (typeof document !== "undefined") return document.documentElement.lang;
  if (typeof process !== "undefined" && process.env) {
    return process.env["LC_ALL"] ?? process.env["LC_MESSAGES"] ?? process.env["LANG"];
  }
  return undefined;
}

export function setLanguage(tag: string | undefined): Lang {
  // VS Code hands out tags like `fr`, `fr-CA`, `pt-br`; only the primary subtag decides.
  const primary = (tag ?? "en").toLowerCase().split(/[-_.]/)[0];
  current = primary === "fr" ? "fr" : "en";
  return current;
}

export function language(): Lang {
  return current;
}

/**
 * Translate, and fill `{0}`, `{1}`… with the arguments.
 *
 * Placeholders are numbered rather than concatenated because word order is not a constant: "3 files
 * omitted" and "3 fichiers omis" agree, but plenty of pairs do not, and a translator who cannot
 * move the value has to choose between correct grammar and correct meaning.
 */
export function t(text: string, ...args: Array<string | number>): string {
  const table = TABLES[current];
  const translated = table[text] ?? text;
  if (!args.length) return translated;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/** Every English string the French table claims to translate — used by the coverage test. */
export function translationKeys(lang: Lang): string[] {
  return Object.keys(TABLES[lang]);
}

setLanguage(detect());
