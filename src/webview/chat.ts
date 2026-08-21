// The conversation screen: transcript, live turn, composer.
//
// The layout follows the one convention every developer already has in their fingers — the
// assistant panel in VS Code — because a coding tool is not the place to teach someone a new set of
// gestures. What sits inside that layout is this project's own: the mode selector says what the
// assistant is ALLOWED to do rather than how clever it is, the model button carries its price, and
// every exchange can be muted out of the context without being deleted from the story.

import { button, closeMenu, el, formatTokens, icon, ICON, menu, menuItem, menuTitle, separator } from "./dom.js";
import { markdown } from "./markdown.js";
import type { Mode, Reasoning, ToExtension, UiEntry, UiState } from "../shared/protocol.js";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "chat", label: "Discussion", hint: "Répond avec ce que vous joignez. Aucun accès au dépôt." },
  { id: "plan", label: "Plan", hint: "Lit le dépôt et propose un plan. Ne modifie rien." },
  { id: "agent", label: "Agent", hint: "Lit, modifie, propose des commandes — avec votre accord." },
];

const REASONING: Array<{ id: Reasoning; label: string; hint: string }> = [
  { id: "none", label: "Direct", hint: "Aucun budget de réflexion. Le plus rapide, le moins cher." },
  { id: "low", label: "Bref", hint: "Quelques centaines de jetons de réflexion." },
  { id: "medium", label: "Standard", hint: "Pour du diagnostic et de la conception." },
  { id: "high", label: "Approfondi", hint: "Pour les problèmes vraiment durs. Coûte le plus cher." },
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
    list.append(el("p", "empty", `Aucun message ne contient « ${state.searchQuery} ».`));
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
        ? "Le modèle choisi est distant : ce qui part est anonymisé et vous êtes prévenu avant le premier envoi."
        : "Le modèle tourne sur votre machine. Rien de ce que vous écrivez ici ne quitte le réseau.",
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
  for (const t of [
    "« # » joint un fichier · « / » ouvre les commandes · ⏎ envoie.",
    "Une réponse ratée se retire du contexte sans disparaître de l'écran.",
    "Le mode Agent demande votre accord avant chaque écriture ou commande.",
  ]) {
    tips.append(el("li", undefined, t));
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
  head.append(el("span", "entry-who", entry.role === "user" ? "Vous" : "Forge"));
  if (entry.model && entry.role === "assistant") head.append(el("span", "entry-meta", entry.model));
  if (entry.usdCost) head.append(el("span", "entry-meta", `${entry.usdCost.toFixed(4)} $`));
  if (!entry.included) head.append(el("span", "entry-tag", "hors contexte"));
  if (entry.pinned) head.append(el("span", "entry-tag", "épinglé"));

  const actions = el("div", "entry-actions");
  actions.append(
    button({
      icon: entry.included ? ICON.mute : ICON.unmute,
      title: entry.included ? "Retirer du contexte — reste affiché, n'est plus envoyé" : "Remettre dans le contexte",
      className: "btn icon-only",
      onClick: () => deps.send({ type: "setIncluded", id: entry.id, included: !entry.included }),
    }),
    button({
      icon: ICON.pin,
      title: entry.pinned ? "Ne plus épingler" : "Épingler — survit à la coupe quand le contexte est plein",
      className: `btn icon-only${entry.pinned ? " active" : ""}`,
      onClick: () => deps.send({ type: "setPinned", id: entry.id, pinned: !entry.pinned }),
    }),
  );
  if (entry.role === "user") {
    actions.append(
      button({ icon: ICON.edit, title: "Modifier et renvoyer", className: "btn icon-only", onClick: () => startEdit(entry, deps) }),
    );
  }
  actions.append(
    button({ icon: ICON.copy, title: "Copier", className: "btn icon-only", onClick: () => deps.send({ type: "copy", text: entry.text }) }),
    button({ icon: ICON.trash, title: "Supprimer définitivement", className: "btn icon-only", onClick: () => deps.send({ type: "dropEntry", id: entry.id }) }),
  );
  head.append(actions);
  wrap.append(head);

  if (entry.context?.length) {
    const chips = el("div", "chips");
    for (const c of entry.context) {
      const chip = el("span", "chip", c.label);
      chip.title = `${c.kind} · ~${formatTokens(c.tokens)} jetons`;
      chips.append(chip);
    }
    wrap.append(chips);
  }

  if (entry.reasoning) wrap.append(collapsible("Raisonnement", entry.reasoning));
  if (entry.steps?.length) wrap.append(stepList(entry.steps));

  if (entry.error) {
    wrap.append(el("div", "error", entry.error));
    wrap.append(
      button({ label: "Réessayer", className: "btn tiny", onClick: () => deps.send({ type: "retry" }) }),
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
          title: "Retirer",
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
      ? "Décrivez le changement. « # » joint un fichier, « / » ouvre les commandes."
      : state.mode === "plan"
        ? "Décrivez ce qu'il faut étudier. Forge lira le dépôt sans rien modifier."
        : "Posez votre question. Joignez le contexte nécessaire : ce mode ne lit pas le dépôt.";
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

  const tokens = el("span", "composer-tokens", `${formatTokens(state.contextTokens)} jetons`);
  tokens.title = "Ce que la prochaine question enverra, une fois les échanges muets retirés.";
  rowBottom.append(tokens);

  rowBottom.append(
    isStreaming()
      ? button({ icon: ICON.stop, title: "Interrompre la réponse", className: "btn primary", onClick: () => deps.send({ type: "stop" }) })
      : button({ icon: ICON.send, title: "Envoyer (⏎)", className: "btn primary", onClick: () => submit(area, deps) }),
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
    label: "Contexte",
    title: "Ajouter du contexte à la prochaine question",
    className: "btn ghost",
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle("Ajouter au contexte"));
        panel.append(
          menuItem({
            label: "Fichier actif",
            hint: "Le fichier ouvert, ou la sélection s'il y en a une",
            onClick: () => {
              deps.send({ type: "attach", what: "active" });
              close();
            },
          }),
          menuItem({
            label: "Choisir un fichier…",
            hint: "Sélecteur de VS Code, avec recherche floue",
            onClick: () => {
              deps.send({ type: "attach", what: "mention" });
              close();
            },
          }),
          menuItem({
            label: "Importer un fichier…",
            hint: "Depuis le disque, même hors de l'espace de travail",
            onClick: () => {
              deps.send({ type: "attach", what: "browse" });
              close();
            },
          }),
        );

        if (state.openFiles.length) {
          panel.append(separator(), menuTitle(`Onglets ouverts (${state.openFiles.length})`));
          panel.append(
            menuItem({
              label: "Tout joindre",
              hint: "Les fichiers actuellement ouverts",
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
                detail: f.active ? "actif" : f.dirty ? "modifié" : "",
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
    title: `Mode : ${current.hint}`,
    className: `btn ghost mode mode-${state.mode}`,
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle("Ce que Forge a le droit de faire"));
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
            label: "Permissions de l'agent…",
            hint: "Ce qui est autorisé sans demander",
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
    title: state.remote ? "Modèle distant — cliquer pour comparer et changer" : "Modèle local — cliquer pour comparer et changer",
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
    title: `Raisonnement : ${current.hint}`,
    className: `btn ghost reasoning${state.reasoning === "none" ? "" : " active"}`,
    onClick: () =>
      menu(b, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle("Budget de réflexion"));
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
  { name: "/expliquer", hint: "expliquer le fichier ou la sélection", prompt: "Explique ce code : ce qu'il fait, comment il s'inscrit dans le reste, et ce qui mérite attention.", attach: true },
  { name: "/tests", hint: "écrire des tests", prompt: "Écris des tests pour ce code, dans le style et avec les outils déjà utilisés dans ce dépôt. Couvre les cas limites.", attach: true },
  { name: "/corriger", hint: "trouver et corriger le problème", prompt: "Trouve le défaut de ce code et corrige-le. Explique en une phrase ce qui n'allait pas.", attach: true },
  { name: "/revue", hint: "revue : bugs, sécurité, lisibilité", prompt: "Fais la revue de ce code : bugs d'abord, puis sécurité, puis lisibilité. Ordonne par gravité, cite les lignes, ne signale rien dont tu ne sois pas sûr.", attach: true },
  { name: "/doc", hint: "documenter", prompt: "Documente ce code : une note au-dessus, dans la langue et le style du fichier.", attach: true },
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
