# Changelog

Notable changes, newest first. Dates are the day the work landed on `main`.

## 0.3.0 — 2026-08-21

**English interface, and a translation that cannot silently rot.**

- The interface is now English in the source, with French as a translation: one catalogue
  (`src/shared/i18n.fr.ts`) for the panel, the extension and the terminal client, plus
  `package.nls.json` / `package.nls.fr.json` for the manifest. It follows VS Code's display
  language.
- A test reads the source and fails when a string has no entry in the catalogue, and another fails
  on entries for strings the code no longer uses.
- The system prompts no longer assume the user writes French: the assistant answers in whatever
  language the question was asked in.
- `forge.language` pins the interface language independently of the editor's, which is also what
  makes the translated interface testable without installing a VS Code language pack.
- Command words in the terminal client stay untranslated — `/mute` and `/muet` both work, because a
  command that moves with the interface language is a command nobody can rely on.

## 0.2.0 — 2026-08-21

**Renamed to Forge, and the panel rebuilt around what the assistant may do.**

- Four screens — conversation, history, models, permissions — in the editor's own visual language.
  Not one hex colour: every value is a VS Code theme variable. Icons are inline SVG (Unicode glyphs
  rendered as empty boxes in the editor's UI font).
- **Modes** (chat / plan / agent) decide the tool set *in code*: plan mode has no writing tool to
  reach for.
- **Permissions** apply to the shape of an action, never to one occurrence: trusting `npm test`
  does not trust `npm publish`, and a refusal always wins.
- **Reasoning** is a budget the user sets, translated per provider — an effort word for OpenRouter,
  a token budget for Anthropic.
- **Model picker** with input, output and cache prices side by side, plus what the local endpoint
  actually serves. Opening it sends no request anywhere.
- **Search** inside the open conversation and across the history; history filters by period, mode
  and cost, with four sort orders.
- Context menu: active file, open tabs, disk import, VS Code's own file picker.
- Settings, commands and storage keys moved from `hiveyForge.*` to `forge.*`.

### Fixed

- The egress gate fell back to the **unredacted** messages when the user refused mid-turn — that
  is, it sent the data precisely when the answer was “do not send it”. It now aborts the turn.
- Inline completion sent the raw prefix and suffix; on a remote endpoint that was the one path that
  skipped pseudonymisation.

## 0.1.0 — 2026-08-21

First working version: reversible pseudonymisation, providers (Ollama, LM Studio, vLLM, LiteLLM,
OpenRouter, Anthropic), local-first routing with consented escalation, per-request and daily
budgets, inline fill-in-the-middle completion, sidebar chat with an agent mode, editor commands,
a terminal client, an egress log and a cost report — with no runtime dependency and no telemetry.
