// The panel. Runs in the webview sandbox: no network, no node, no `innerHTML` on anything a model
// wrote — every node in the transcript is built with `createElement` and `textContent`, so a code
// block that contains `<img onerror=…>` renders as the characters the model produced and nothing
// happens. That is the whole reason there is a renderer here instead of a markdown library.

import type { ToExtension, ToPanel, UiEntry, UiState } from "../shared/protocol.js";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: ToExtension) => vscode.postMessage(m);

let state: UiState | undefined;
let streaming = false;
let streamNode: HTMLElement | undefined;
let historyOpen = false;

const app = document.getElementById("app")!;

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

function render(): void {
  if (!state) return;
  app.textContent = "";
  app.append(header(state), historyOpen ? historyPanel(state) : transcript(state), composer(state));
  scrollToEnd();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label: string, title: string, onClick: () => void, className = "icon"): HTMLButtonElement {
  const b = el("button", className, label);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function header(s: UiState): HTMLElement {
  const bar = el("header", "bar");
  const left = el("div", "bar-left");

  const badge = el("span", `badge ${s.remote ? "remote" : "local"}`, s.remote ? "distant" : "local");
  badge.title = s.remote
    ? "Ce fournisseur est distant : ce que vous envoyez est anonymisé, et vous êtes prévenu avant chaque nouvelle destination."
    : "Ce fournisseur tourne sur votre machine ou votre réseau : rien ne sort.";
  left.append(badge);

  const model = button(s.model, "Changer de modèle", () => send({ type: "pickModel" }), "model");
  left.append(model);

  const right = el("div", "bar-right");
  const ctx = el("span", "tokens", `${formatTokens(s.contextTokens)} de contexte`);
  ctx.title = "Ce que la prochaine question enverra, une fois les échanges muets retirés.";
  right.append(ctx);

  if (s.budget.dailyUsd > 0 || s.budget.spentTodayUsd > 0) {
    const cost = button(
      `$${s.budget.spentTodayUsd.toFixed(3)}`,
      "Dépense distante d'aujourd'hui — cliquer pour le détail",
      () => send({ type: "openEgress" }),
      "cost",
    );
    right.append(cost);
  }
  right.append(button("☰", "Historique des discussions", () => {
    historyOpen = !historyOpen;
    render();
  }));
  right.append(button("＋", "Nouvelle discussion", () => send({ type: "newSession" })));

  bar.append(left, right);
  return bar;
}

function historyPanel(s: UiState): HTMLElement {
  const wrap = el("div", "history");
  if (!s.history.length) wrap.append(el("p", "empty", "Aucune discussion enregistrée."));
  for (const h of s.history) {
    const row = el("div", `history-row${h.id === s.session.id ? " current" : ""}`);
    const open = el("button", "history-open");
    open.append(el("span", "history-title", h.title || "(sans titre)"));
    open.append(el("span", "history-date", new Date(h.updatedAt).toLocaleString("fr-FR")));
    open.addEventListener("click", () => {
      historyOpen = false;
      send({ type: "openSession", id: h.id });
    });
    row.append(open, button("✕", "Supprimer cette discussion", () => send({ type: "deleteSession", id: h.id })));
    wrap.append(row);
  }
  return wrap;
}

function transcript(s: UiState): HTMLElement {
  const list = el("div", "transcript");
  if (!s.session.entries.length) list.append(welcome());
  for (const entry of s.session.entries) list.append(renderEntry(entry));
  return list;
}

function welcome(): HTMLElement {
  const w = el("div", "welcome");
  w.append(el("h2", undefined, "Hivey Forge"));
  w.append(
    el(
      "p",
      undefined,
      "Posez une question sur le code ouvert, ou décrivez un changement. En mode agent, l'assistant lit le dépôt, modifie des fichiers et vous demande votre accord avant chaque écriture.",
    ),
  );
  const tips = el("ul", "tips");
  for (const t of [
    "Joindre le fichier actif : le bouton 📎 sous la saisie.",
    "Retirer un échange du contexte : l'icône 🚫 sur le message — il reste affiché, il n'est plus envoyé.",
    "Épingler un message : il survit à la coupe quand le contexte est plein.",
  ]) {
    tips.append(el("li", undefined, t));
  }
  w.append(tips);
  return w;
}

function renderEntry(entry: UiEntry): HTMLElement {
  const wrap = el("article", `entry ${entry.role}${entry.included ? "" : " muted"}${entry.error ? " failed" : ""}`);

  const head = el("div", "entry-head");
  head.append(el("span", "who", entry.role === "user" ? "Vous" : "Forge"));
  if (entry.model) head.append(el("span", "meta", entry.model));
  if (entry.usdCost) head.append(el("span", "meta", `$${entry.usdCost.toFixed(4)}`));
  if (!entry.included) head.append(el("span", "meta warn", "hors contexte"));
  if (entry.pinned) head.append(el("span", "meta", "épinglé"));

  const actions = el("div", "entry-actions");
  actions.append(
    button(entry.included ? "🚫" : "↩", entry.included ? "Retirer du contexte (reste affiché)" : "Remettre dans le contexte", () =>
      send({ type: "setIncluded", id: entry.id, included: !entry.included }),
    ),
  );
  actions.append(
    button(entry.pinned ? "📌" : "📍", entry.pinned ? "Ne plus épingler" : "Épingler (survit à la coupe)", () =>
      send({ type: "setPinned", id: entry.id, pinned: !entry.pinned }),
    ),
  );
  if (entry.role === "user") {
    actions.append(button("✎", "Modifier et renvoyer", () => startEdit(entry)));
  }
  actions.append(button("⧉", "Copier", () => send({ type: "copy", text: entry.text })));
  actions.append(button("🗑", "Supprimer définitivement", () => send({ type: "dropEntry", id: entry.id })));
  head.append(actions);
  wrap.append(head);

  if (entry.context?.length) {
    const chips = el("div", "chips");
    for (const c of entry.context) {
      const chip = el("span", "chip", `${c.label}`);
      chip.title = `${c.kind} · ~${formatTokens(c.tokens)}`;
      chips.append(chip);
    }
    wrap.append(chips);
  }

  if (entry.error) {
    wrap.append(el("div", "error", entry.error));
  } else {
    wrap.append(markdown(entry.text));
  }
  return wrap;
}

function startEdit(entry: UiEntry): void {
  const area = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!area) return;
  area.value = entry.text;
  area.focus();
  const original = entry.text;
  const onSend = () => {
    if (area.value !== original) send({ type: "editEntry", id: entry.id, text: area.value });
  };
  area.dataset["editing"] = entry.id;
  area.addEventListener("keydown", function once(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      area.removeEventListener("keydown", once);
      delete area.dataset["editing"];
      onSend();
      area.value = "";
    }
  });
}

// ── Markdown, rendered as DOM nodes rather than as HTML ──────────────────────────────────────

function markdown(text: string): HTMLElement {
  const body = el("div", "body");
  const lines = text.split("\n");
  let i = 0;
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    body.append(inline(paragraph.join("\n"), "p"));
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```([a-zA-Z0-9+#-]*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      body.append(codeBlock(code.join("\n"), lang));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      body.append(el(`h${Math.min(4, heading[1]!.length + 2)}` as "h4", "md-h", heading[2]!));
      i++;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      const ul = el("ul", "md-list");
      while (i < lines.length) {
        const b = lines[i]!.match(/^\s*[-*]\s+(.*)$/);
        if (!b) break;
        ul.append(inline(b[1]!, "li"));
        i++;
      }
      body.append(ul);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return body;
}

/** Inline spans: `code`, **bold**, *italic*. Everything else stays literal text. */
function inline<K extends keyof HTMLElementTagNameMap>(text: string, tag: K): HTMLElementTagNameMap[K] {
  const node = el(tag, "md");
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith("`")) node.append(el("code", "md-code", token.slice(1, -1)));
    else if (token.startsWith("**")) node.append(el("strong", undefined, token.slice(2, -2)));
    else node.append(el("em", undefined, token.slice(1, -1)));
    last = m.index + token.length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
  return node;
}

function codeBlock(code: string, lang: string): HTMLElement {
  const wrap = el("div", "code-block");
  const head = el("div", "code-head");
  head.append(el("span", "lang", lang || "code"));
  const tools = el("div", "code-tools");
  tools.append(button("Copier", "Copier ce bloc", () => send({ type: "copy", text: code }), "text"));
  tools.append(button("Insérer", "Remplacer la sélection dans l'éditeur", () => send({ type: "insertCode", code }), "text"));
  head.append(tools);
  const pre = el("pre", "code");
  pre.append(el("code", undefined, code));
  wrap.append(head, pre);
  return wrap;
}

// ── Composer ─────────────────────────────────────────────────────────────────────────────────

function composer(s: UiState): HTMLElement {
  const wrap = el("div", "composer");

  if (s.attachments.length) {
    const chips = el("div", "chips");
    for (const a of s.attachments) {
      const chip = el("span", "chip removable", `${a.label} · ${formatTokens(a.tokens)}`);
      chip.append(button("✕", "Retirer", () => send({ type: "removeAttachment", label: a.label }), "chip-x"));
      chips.append(chip);
    }
    wrap.append(chips);
  }

  const area = el("textarea");
  area.placeholder = streaming ? "Réponse en cours…" : "Posez votre question. Entrée pour envoyer, Maj+Entrée pour un saut de ligne.";
  area.rows = 3;
  area.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submit(area);
    }
  });
  wrap.append(area);

  const row = el("div", "composer-row");
  const agent = el("label", "toggle");
  const box = el("input");
  box.type = "checkbox";
  box.checked = s.agentMode;
  box.addEventListener("change", () => {
    if (state) state.agentMode = box.checked;
  });
  agent.append(box, document.createTextNode(" mode agent"));
  agent.title = "L'assistant peut lire le dépôt, modifier des fichiers et proposer des commandes — toujours avec votre accord.";
  row.append(agent);

  row.append(button("📎 fichier actif", "Joindre le fichier ou la sélection en cours", () => send({ type: "attachActive" }), "text"));
  row.append(button("📁 parcourir", "Joindre d'autres fichiers", () => send({ type: "attachFile" }), "text"));

  const spacer = el("div", "spacer");
  row.append(spacer);

  if (streaming) {
    row.append(button("■ Arrêter", "Interrompre la réponse", () => send({ type: "stop" }), "primary"));
  } else {
    row.append(button("Envoyer", "Envoyer la question", () => submit(area), "primary"));
  }
  wrap.append(row);
  return wrap;
}

function submit(area: HTMLTextAreaElement): void {
  const text = area.value.trim();
  if (!text || streaming) return;
  const editing = area.dataset["editing"];
  area.value = "";
  if (editing) {
    delete area.dataset["editing"];
    send({ type: "editEntry", id: editing, text });
    return;
  }
  send({ type: "send", text, agentMode: state?.agentMode ?? true });
}

// ── Live turn ────────────────────────────────────────────────────────────────────────────────

function ensureStreamNode(): HTMLElement {
  if (streamNode) return streamNode;
  const list = document.querySelector(".transcript") ?? app;
  const wrap = el("article", "entry assistant streaming");
  const head = el("div", "entry-head");
  head.append(el("span", "who", "Forge"));
  head.append(el("span", "meta pulse", "…"));
  wrap.append(head);
  const body = el("div", "body live");
  wrap.append(body);
  list.append(wrap);
  streamNode = body;
  scrollToEnd();
  return body;
}

function statusLine(text: string): void {
  const node = ensureStreamNode();
  const line = el("div", "status", text);
  node.append(line);
  scrollToEnd();
}

function approvalCard(id: string, tool: string, description: string): void {
  const node = ensureStreamNode();
  const card = el("div", "approval");
  card.append(el("div", "approval-head", "Autorisation demandée"));
  card.append(el("div", "approval-body", description));
  card.append(el("div", "approval-tool", tool));
  const row = el("div", "approval-actions");
  const answer = (approved: boolean) => {
    send({ type: "approve", id, approved });
    card.replaceChildren(el("div", "approval-done", approved ? "Autorisé." : "Refusé."));
  };
  row.append(button("Autoriser", "Autoriser cette action", () => answer(true), "primary"));
  row.append(button("Refuser", "Refuser cette action", () => answer(false), "text"));
  card.append(row);
  node.append(card);
  scrollToEnd();
}

function scrollToEnd(): void {
  requestAnimationFrame(() => {
    const list = document.querySelector(".transcript");
    if (list) list.scrollTop = list.scrollHeight;
  });
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} k jetons` : `${n} jetons`;
}

// ── Messages from the extension ──────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<ToPanel>) => {
  const m = event.data;
  switch (m.type) {
    case "state":
      state = m.state;
      streamNode = undefined;
      render();
      break;
    case "turnStart":
      streaming = true;
      streamNode = undefined;
      render();
      break;
    case "turnEnd":
      streaming = false;
      streamNode = undefined;
      break;
    case "delta": {
      const node = ensureStreamNode();
      let tail = node.querySelector<HTMLElement>(".live-text");
      if (!tail) {
        tail = el("div", "live-text");
        node.append(tail);
      }
      tail.textContent = (tail.textContent ?? "") + m.text;
      scrollToEnd();
      break;
    }
    case "reasoning":
      break; // reasoning is not shown by default; the log has it
    case "status":
      statusLine(m.text);
      break;
    case "approval":
      approvalCard(m.id, m.tool, m.description);
      break;
    case "error": {
      const node = ensureStreamNode();
      node.append(el("div", "error", m.message));
      streaming = false;
      break;
    }
  }
});

send({ type: "ready" });
