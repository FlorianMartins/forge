// The conversation screen: transcript, live turn, composer.
//
// The layout follows the one convention every developer already has in their fingers — the
// assistant panel in VS Code — because a coding tool is not the place to teach someone a new set of
// gestures. What sits inside that layout is this project's own: the mode selector says what the
// assistant is ALLOWED to do rather than how clever it is, the model button carries its price, and
// every exchange can be muted out of the context without being deleted from the story.

import { button, closeMenu, el, formatTokens, icon, ICON, menu, menuItem, menuTitle, separator } from "./dom.js";
import { markdown } from "./markdown.js";
import { t } from "../shared/i18n.js";
import type { Mode, Reasoning, ToExtension, UiEntry, UiState } from "../shared/protocol.js";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "chat", label: t("Chat"), hint: t("Answers from what you attach. No access to the repository.") },
  { id: "plan", label: t("Plan"), hint: t("Reads the repository and proposes a plan. Changes nothing.") },
  { id: "agent", label: t("Agent"), hint: t("Reads, edits, proposes commands — with your approval.") },
];

const REASONING: Array<{ id: Reasoning; label: string; hint: string }> = [
  { id: "none", label: t("Direct"), hint: t("No thinking budget. Fastest, cheapest.") },
  { id: "low", label: t("Brief"), hint: t("A few hundred tokens of thinking.") },
  { id: "medium", label: t("Standard"), hint: t("For diagnosis and design work.") },
  { id: "high", label: t("Deep"), hint: t("For genuinely hard problems. Costs the most.") },
];

export interface ChatDeps {
  send: (m: ToExtension) => void;
  state: () => UiState | undefined;
  rerender: () => void;
}

export function chatScreen(state: UiState, deps: ChatDeps): HTMLElement {
  const wrap = el("div", "screen chat-screen");
  wrap.append(transcript(state, deps), composer(state, deps));
  return wrap;
}

// ── Transcript ───────────────────────────────────────────────────────────────────────────────

function transcript(state: UiState, deps: ChatDeps): HTMLElement {
  const list = el("div", "transcript");
  if (!state.session.entries.length) {
    list.append(welcome(state, deps));
    return list;
  }
  const matches = new Set(state.matches);
  for (const entry of state.session.entries) {
    if (state.searchQuery && !matches.has(entry.id)) continue;
    list.append(renderEntry(entry, state, deps));
  }
  if (state.searchQuery && !matches.size) {
    list.append(el("p", "empty", t("No message contains “{0}”.", state.searchQuery)));
  }
  return list;
}

function welcome(state: UiState, deps: ChatDeps): HTMLElement {
  const w = el("div", "welcome");
  w.append(el("div", "welcome-title", "Forge"));
  w.append(
    el(
      "p",
      "welcome-lede",
      state.remote
        ? t("The selected model is remote: what leaves is pseudonymised, and you are asked before the first request.")
        : t("The model runs on your machine. Nothing you write here leaves the network."),
    ),
  );

  const cards = el("div", "welcome-cards");
  for (const m of MODES) {
    const card = el("button", `welcome-card${state.mode === m.id ? " selected" : ""}`);
    card.append(el("span", "welcome-card-title", m.label));
    card.append(el("span", "welcome-card-hint", m.hint));
    card.addEventListener("click", () => deps.send({ type: "setMode", mode: m.id }));
    cards.append(card);
  }
  w.append(cards);

  const tips = el("ul", "welcome-tips");
  for (const tip of [
    t("“#” attaches a file · “/” opens the commands · ⏎ sends."),
    t("A bad answer can leave the context without leaving the screen."),
    t("Agent mode asks for your approval before every write and every command."),
  ]) {
    tips.append(el("li", undefined, tip));
  }
  w.append(tips);
  return w;
}

function renderEntry(entry: UiEntry, state: UiState, deps: ChatDeps): HTMLElement {
  const wrap = el(
    "article",
    `entry ${entry.role}${entry.included ? "" : " muted"}${entry.error ? " failed" : ""}`,
  );

  const head = el("div", "entry-head");
  head.append(el("span", "entry-who", entry.role === "user" ? t("You") : "Forge"));
  if (entry.model && entry.role === "assistant") head.append(el("span", "entry-meta", entry.model));
  if (entry.usdCost) head.append(el("span", "entry-meta", `${entry.usdCost.toFixed(4)} $`));
  if (!entry.included) head.append(el("span", "entry-tag", t("out of context")));
  if (entry.pinned) head.append(el("span", "entry-tag", t("pinned")));

  const actions = el("div", "entry-actions");
  actions.append(
    button({
      icon: entry.included ? ICON.mute : ICON.unmute,
      title: entry.included ? t("Remove from context — stays on screen, stops being sent") : t("Put back into the context"),
      className: "btn icon-only",
      onClick: () => deps.send({ type: "setIncluded", id: entry.id, included: !entry.included }),
    }),
    button({
      icon: ICON.pin,
      title: entry.pinned ? t("Unpin") : t("Pin — survives trimming when the context is full"),
      className: `btn icon-only${entry.pinned ? " active" : ""}`,
      onClick: () => deps.send({ type: "setPinned", id: entry.id, pinned: !entry.pinned }),
    }),
  );
  if (entry.role === "user") {
    actions.append(
      button({ icon: ICON.edit, title: t("Edit and resend"), className: "btn icon-only", onClick: () => startEdit(entry, deps) }),
    );
  }
  actions.append(
    button({ icon: ICON.copy, title: t("Copy"), className: "btn icon-only", onClick: () => deps.send({ type: "copy", text: entry.text }) }),
    button({ icon: ICON.trash, title: t("Delete permanently"), className: "btn icon-only", onClick: () => deps.send({ type: "dropEntry", id: entry.id }) }),
  );
  head.append(actions);
  wrap.append(head);

  if (entry.context?.length) {
    const chips = el("div", "chips");
    for (const c of entry.context) {
      const chip = el("span", "chip", c.label);
      chip.title = t("{0} · ~{1} tokens", c.kind, formatTokens(c.tokens));
      chips.append(chip);
    }
    wrap.append(chips);
  }

  if (entry.reasoning) wrap.append(collapsible(t("Reasoning"), entry.reasoning));
  if (entry.steps?.length) wrap.append(stepList(entry.steps));

  if (entry.error) {
    wrap.append(el("div", "error", entry.error));
    wrap.append(
      button({ label: t("Retry"), className: "btn tiny", onClick: () => deps.send({ type: "retry" }) }),
    );
  } else {
    wrap.append(
      markdown(
        entry.text,
        {
          onCopy: (code) => deps.send({ type: "copy", text: code }),
          onInsert: (code) => deps.send({ type: "insertCode", code }),
          onApply: (code, language) => deps.send({ type: "applyCode", code, language }),
        },
        state.searchQuery || undefined,
      ),
    );
  }
  return wrap;
}

export function stepList(steps: Array<{ tool: string; summary: string; ok: boolean }>): HTMLElement {
  const list = el("div", "steps");
  for (const s of steps) {
    const row = el("div", `step${s.ok ? "" : " failed"}`);
    row.append(icon(s.ok ? "check" : "cross", "step-ico"));
    row.append(el("span", "step-tool", s.tool));
    row.append(el("span", "step-summary", s.summary));
    list.append(row);
  }
  return list;
}

export function collapsible(title: string, body: string): HTMLElement {
  const wrap = el("div", "collapsible");
  const head = el("button", "collapsible-head");
  head.append(icon("chevron", "collapsible-chevron"));
  head.append(el("span", undefined, title));
  const content = el("div", "collapsible-body", body);
  content.hidden = true;
  head.addEventListener("click", () => {
    content.hidden = !content.hidden;
    wrap.classList.toggle("open", !content.hidden);
  });
  wrap.append(head, content);
  return wrap;
}

function startEdit(entry: UiEntry, deps: ChatDeps): void {
  const area = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!area) return;
  area.value = entry.text;
  area.dataset["editing"] = entry.id;
  area.focus();
  autoGrow(area);
}

// ── Composer ─────────────────────────────────────────────────────────────────────────────────

function composer(state: UiState, deps: ChatDeps): HTMLElement {
  const wrap = el("div", "composer");
  const card = el("div", "composer-card");

  if (state.attachments.length) {
    const chips = el("div", "chips attached");
    for (const a of state.attachments) {
      const chip = el("span", "chip removable", `${a.label}`);
      chip.title = `${a.kind} · ~${formatTokens(a.tokens)} jetons`;
      chip.append(
        button({
          icon: ICON.close,
          title: t("Remove"),
          className: "btn chip-x",
          onClick: () => deps.send({ type: "removeAttachment", label: a.label }),
        }),
      );
      chips.append(chip);
    }
    card.append(chips);
  }

  const area = el("textarea", "composer-input");
  area.rows = 2;
  area.placeholder =
    state.mode === "agent"
      ? t("Describe the change. “#” attaches a file, “/” opens the commands.")
      : state.mode === "plan"
        ? t("Describe what to investigate. Forge will read the repository without changing anything.")
        : t("Ask your question. Attach the context you need: this mode does not read the repository.");
  area.addEventListener("input", () => {
    autoGrow(area);
    if (area.value.endsWith("#")) {
      area.value = area.value.slice(0, -1);
      deps.send({ type: "attach", what: "mention" });
    }
    slashHints(hints, area, deps);
  });
  area.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submit(area, deps);
    }
    if (ev.key === "Escape") {
      delete area.dataset["editing"];
      area.value = "";
      autoGrow(area);
      hints.textContent = "";
    }
  });
  card.append(area);

  const hints = el("div", "slash-hints");
  card.append(hints);

  // Two rows rather than one: the sidebar is often 300 px wide, and a single row of controls wraps
  // into an unreadable staircase. Row one says WHAT is answering, row two WITH WHAT and the send.
  const rowTop = el("div", "composer-toolbar");
  rowTop.append(modeButton(state, deps), modelButton(state, deps));
  if (state.reasoningAvailable) rowTop.append(reasoningButton(state, deps));
  card.append(rowTop);

  const rowBottom = el("div", "composer-toolbar bottom");
  rowBottom.append(contextButton(state, deps));
  rowBottom.append(el("div", "spacer"));

  const tokens = el("span", "composer-tokens", t("{0} tokens", formatTokens(state.contextTokens)));
  tokens.title = t("What the next question will send, once muted exchanges are removed.");
  rowBottom.append(tokens);

  rowBottom.append(
    isStreaming()
      ? button({ icon: ICON.stop, title: t("Stop the answer"), className: "btn primary", onClick: () => deps.send({ type: "stop" }) })
      : button({ icon: ICON.send, title: t("Send (⏎)"), className: "btn primary", onClick: () => submit(area, deps) }),
  );
  card.append(rowBottom);
  wrap.append(card);
  // Size the box to its content on first paint, not only after the first keystroke.
  requestAnimationFrame(() => autoGrow(area));
  return wrap;
}

function autoGrow(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  const height = Math.min(220, Math.max(46, area.scrollHeight));
  area.style.height = `${height}px`;
  // The scrollbar only appears once the box has stopped growing.
  area.style.overflowY = area.scrollHeight > 220 ? "auto" : "hidden";
}

let streaming = false;
export function setStreaming(value: boolean): void {
  streaming = value;
}
export function isStreaming(): boolean {
  return streaming;
}

function contextButton(state: UiState, deps: ChatDeps): HTMLElement {
  const b = button({
    icon: ICON.attach,
    label: t("Context"),
    title: t("Add context to the next question"),
    className: "btn ghost",
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle(t("Add to the context")));
        panel.append(
          menuItem({
            label: t("Active file"),
            hint: t("The open file, or the selection if there is one"),
            onClick: () => {
              deps.send({ type: "attach", what: "active" });
              close();
            },
          }),
          menuItem({
            label: t("Pick a file…"),
            hint: t("VS Code's own picker, with fuzzy search"),
            onClick: () => {
              deps.send({ type: "attach", what: "mention" });
              close();
            },
          }),
          menuItem({
            label: t("Import a file…"),
            hint: t("From disk, even outside the workspace"),
            onClick: () => {
              deps.send({ type: "attach", what: "browse" });
              close();
            },
          }),
        );

        if (state.openFiles.length) {
          panel.append(separator(), menuTitle(t("Open tabs ({0})", state.openFiles.length)));
          panel.append(
            menuItem({
              label: t("Attach all"),
              hint: t("The files currently open"),
              onClick: () => {
                deps.send({ type: "attach", what: "openFiles" });
                close();
              },
            }),
          );
          for (const f of state.openFiles.slice(0, 12)) {
            panel.append(
              menuItem({
                label: f.path,
                detail: f.active ? t("active") : f.dirty ? t("edited") : "",
                onClick: () => {
                  deps.send({ type: "attachPath", path: f.path });
                  close();
                },
              }),
            );
          }
        }
        return panel;
      }),
  });
  return b;
}

function modeButton(state: UiState, deps: ChatDeps): HTMLElement {
  const current = MODES.find((m) => m.id === state.mode) ?? MODES[2]!;
  const b = button({
    label: current.label,
    trailingIcon: ICON.chevron,
    title: t("Mode: {0}", current.hint),
    className: `btn ghost mode mode-${state.mode}`,
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle(t("What Forge is allowed to do")));
        for (const m of MODES) {
          panel.append(
            menuItem({
              label: m.label,
              hint: m.hint,
              selected: m.id === state.mode,
              onClick: () => {
                deps.send({ type: "setMode", mode: m.id });
                close();
              },
            }),
          );
        }
        panel.append(
          separator(),
          menuItem({
            label: t("Agent permissions…"),
            hint: t("What runs without asking"),
            onClick: () => {
              deps.send({ type: "openScreen", screen: "permissions" });
              close();
            },
          }),
        );
        return panel;
      }),
  });
  return b;
}

function modelButton(state: UiState, deps: ChatDeps): HTMLElement {
  const b = button({
    label: state.modelLabel,
    trailingIcon: ICON.chevron,
    title: state.remote ? t("Remote model — click to compare and change") : t("Local model — click to compare and change"),
    className: `btn ghost model${state.remote ? " remote" : " local"}`,
    onClick: () => {
      closeMenu();
      deps.send({ type: "openScreen", screen: "models" });
    },
  });
  return b;
}

function reasoningButton(state: UiState, deps: ChatDeps): HTMLElement {
  const current = REASONING.find((r) => r.id === state.reasoning) ?? REASONING[0]!;
  const b = button({
    label: current.label,
    trailingIcon: ICON.chevron,
    title: t("Reasoning: {0}", current.hint),
    className: `btn ghost reasoning${state.reasoning === "none" ? "" : " active"}`,
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle(t("Thinking budget")));
        for (const r of REASONING) {
          panel.append(
            menuItem({
              label: r.label,
              hint: r.hint,
              selected: r.id === state.reasoning,
              onClick: () => {
                deps.send({ type: "setReasoning", reasoning: r.id });
                close();
              },
            }),
          );
        }
        return panel;
      }),
  });
  return b;
}

const SLASH: Array<{ name: string; hint: string; prompt: string; attach?: boolean }> = [
  { name: t("/explain"), hint: t("explain the file or the selection"), prompt: t("Explain this code: what it does, how it fits into the rest, and what deserves attention."), attach: true },
  { name: "/tests", hint: t("write tests"), prompt: t("Write tests for this code, in the style and with the tools already used in this repository. Cover the edge cases."), attach: true },
  { name: t("/fix"), hint: t("find and fix the problem"), prompt: t("Find the defect in this code and fix it. Say in one sentence what was wrong."), attach: true },
  { name: t("/review"), hint: t("review: bugs, security, readability"), prompt: t("Review this code: bugs first, then security, then readability. Order by severity, cite the lines, and report nothing you are unsure of."), attach: true },
  { name: "/doc", hint: t("document"), prompt: t("Document this code: a note above it, in the language and style of the file."), attach: true },
];

function slashHints(container: HTMLElement, area: HTMLTextAreaElement, deps: ChatDeps): void {
  container.textContent = "";
  const value = area.value;
  if (!value.startsWith("/")) return;
  const typed = value.split(" ")[0] ?? "/";
  for (const c of SLASH.filter((s) => s.name.startsWith(typed))) {
    const row = el("button", "slash-hint");
    row.append(el("span", "slash-name", c.name));
    row.append(el("span", "slash-hint-text", c.hint));
    row.addEventListener("click", () => {
      area.value = `${c.name} `;
      area.focus();
      container.textContent = "";
    });
    container.append(row);
  }
}

function expandSlash(text: string): { text: string; attach: boolean } | undefined {
  const match = SLASH.find((c) => text === c.name || text.startsWith(`${c.name} `));
  if (!match) return undefined;
  const extra = text.slice(match.name.length).trim();
  return { text: extra ? `${match.prompt}\n\n${extra}` : match.prompt, attach: match.attach ?? false };
}

function submit(area: HTMLTextAreaElement, deps: ChatDeps): void {
  let text = area.value.trim();
  if (!text || isStreaming()) return;
  const editing = area.dataset["editing"];
  const expanded = expandSlash(text);
  if (expanded) {
    text = expanded.text;
    if (expanded.attach) deps.send({ type: "attach", what: "active" });
  }
  area.value = "";
  autoGrow(area);
  if (editing) {
    delete area.dataset["editing"];
    deps.send({ type: "editEntry", id: editing, text });
    return;
  }
  deps.send({ type: "send", text });
}
