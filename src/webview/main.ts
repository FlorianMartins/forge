// The panel: state, routing between screens, and the live turn.
//
// One state object arrives from the extension and the whole panel is rebuilt from it. That is
// deliberate: the alternative — patching the DOM as messages arrive — is how a chat panel ends up
// showing a muted message as active, or a model name that changed three turns ago. The only thing
// rendered incrementally is the answer being streamed, because that one has to be.

import { button, closeMenu, el, icon, ICON, menu, menuItem, menuTitle, searchInput, separator } from "./dom.js";
import { chatScreen, collapsible, isStreaming, setStreaming, type ChatDeps } from "./chat.js";
import { historyScreen } from "./history.js";
import { modelsScreen } from "./models.js";
import { permissionsScreen } from "./permissions.js";
import { markdown } from "./markdown.js";
import type { ToExtension, ToPanel, UiState } from "../shared/protocol.js";
import { t } from "../shared/i18n.js";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: ToExtension) => vscode.postMessage(m);

let state: UiState | undefined;
let searchOpen = false;
let live: LiveTurn | undefined;

const app = document.getElementById("app")!;

const deps: ChatDeps = {
  send,
  state: () => state,
  rerender: () => render(),
};

// ── Shell ────────────────────────────────────────────────────────────────────────────────────

function render(): void {
  if (!state) return;
  closeMenu();
  app.textContent = "";
  app.append(header(state));
  if (searchOpen && state.screen === "chat") app.append(searchBar(state));

  switch (state.screen) {
    case "history":
      app.append(historyScreen(state, send));
      break;
    case "models":
      app.append(modelsScreen(state, send, render));
      break;
    case "permissions":
      app.append(permissionsScreen(state, send));
      break;
    case "chat":
    default:
      app.append(chatScreen(state, deps));
      break;
  }
  live = undefined;
  scrollToEnd();
}

function header(s: UiState): HTMLElement {
  const bar = el("header", "topbar");
  const left = el("div", "topbar-left");

  if (s.screen !== "chat") {
    left.append(
      button({
        icon: ICON.back,
        title: t("Back to the conversation"),
        className: "btn icon-only",
        onClick: () => send({ type: "openScreen", screen: "chat" }),
      }),
    );
    left.append(el("span", "topbar-title", screenTitle(s)));
  } else {
    const title = el("span", "topbar-title", s.session.title || t("New conversation"));
    title.title = s.session.title || "";
    left.append(title);
    const badge = el("span", `badge ${s.remote ? "remote" : t("local")}`, s.remote ? t("remote") : t("local"));
    badge.title = s.remote
      ? t("Remote provider: what leaves is pseudonymised, and an egress log is kept.")
      : t("Local provider: nothing leaves your machine or your network.");
    left.append(badge);
  }

  const right = el("div", "topbar-right");
  if (s.screen === "chat") {
    right.append(
      button({
        icon: ICON.search,
        title: t("Search this conversation"),
        className: `btn icon-only${searchOpen ? " active" : ""}`,
        onClick: () => {
          searchOpen = !searchOpen;
          if (!searchOpen && s.searchQuery) send({ type: "search", query: "" });
          else render();
        },
      }),
    );
  }
  right.append(
    button({
      icon: ICON.history,
      title: t("Conversation history"),
      className: `btn icon-only${s.screen === "history" ? " active" : ""}`,
      onClick: () => send({ type: "openScreen", screen: "history" }),
    }),
    button({
      icon: ICON.add,
      title: t("New conversation"),
      className: "btn icon-only",
      onClick: () => send({ type: "newSession" }),
    }),
  );

  const more = button({
    icon: ICON.more,
    title: t("More"),
    className: "btn icon-only",
    onClick: () =>
      menu(more, (close) => {
        const panel = el("div", "menu-list");
        panel.append(menuTitle(t("Privacy and cost")));
        panel.append(
          menuItem({
            label: t("Outgoing data"),
            hint: t("What left this machine, without the content"),
            onClick: () => {
              send({ type: "openEgress" });
              close();
            },
          }),
          menuItem({
            label: t("Cost and budget"),
            detail: `${s.budget.spentTodayUsd.toFixed(3)} $`,
            hint: t("Today's spend, by model"),
            onClick: () => {
              send({ type: "openCosts" });
              close();
            },
          }),
          separator(),
          menuItem({
            label: t("Agent permissions"),
            hint: t("What runs without asking"),
            onClick: () => {
              send({ type: "openScreen", screen: "permissions" });
              close();
            },
          }),
          menuItem({
            label: t("Forge settings"),
            onClick: () => {
              send({ type: "openSettings" });
              close();
            },
          }),
        );
        return panel;
      }),
  });
  right.append(more);

  bar.append(left, right);
  return bar;
}

function screenTitle(s: UiState): string {
  switch (s.screen) {
    case "history":
      return t("Conversations");
    case "models":
      return t("Models");
    case "permissions":
      return t("Permissions");
    default:
      return "Forge";
  }
}

function searchBar(s: UiState): HTMLElement {
  const wrap = el("div", "search-bar");
  wrap.append(
    searchInput({
      value: s.searchQuery,
      placeholder: t("Search this conversation…"),
      onInput: (query) => send({ type: "search", query }),
      onEscape: () => {
        searchOpen = false;
        send({ type: "search", query: "" });
      },
    }),
  );
  if (s.searchQuery) {
    wrap.append(el("span", "muted", t("{0} messages", s.matches.length)));
  }
  return wrap;
}

// ── The live turn ────────────────────────────────────────────────────────────────────────────

class LiveTurn {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private text?: HTMLElement;
  private thinking?: { wrap: HTMLElement; body: HTMLElement };
  private buffer = "";

  constructor(list: HTMLElement) {
    this.root = el("article", "entry assistant streaming");
    const head = el("div", "entry-head");
    head.append(el("span", "entry-who", "Forge"));
    head.append(el("span", "entry-meta pulse", t("thinking…")));
    this.root.append(head);
    this.body = el("div", "entry-body");
    this.root.append(this.body);
    list.append(this.root);
  }

  appendText(chunk: string): void {
    this.buffer += chunk;
    if (!this.text) {
      this.text = el("div", "live-text");
      this.body.append(this.text);
    }
    this.text.textContent = this.buffer;
  }

  appendReasoning(chunk: string): void {
    if (!this.thinking) {
      const wrap = collapsible(t("Reasoning"), "");
      const body = wrap.querySelector<HTMLElement>(".collapsible-body")!;
      this.thinking = { wrap, body };
      this.body.prepend(wrap);
    }
    this.thinking.body.textContent = (this.thinking.body.textContent ?? "") + chunk;
  }

  appendStatus(text: string, tool?: string, ok?: boolean): void {
    const row = el("div", `step${ok === false ? " failed" : ""}`);
    if (tool) {
      row.append(icon(ok === false ? "cross" : "check", "step-ico"));
      row.append(el("span", "step-tool", tool));
    } else {
      row.append(el("span", "step-ico dot", "·"));
    }
    row.append(el("span", "step-summary", text));
    this.body.append(row);
  }

  appendError(message: string): void {
    this.body.append(el("div", "error", message));
  }

  /** The approval card: four answers, because "yes" and "yes forever" are different decisions. */
  appendApproval(id: string, tool: string, description: string, command?: string): void {
    const card = el("div", "approval");
    const head = el("div", "approval-head");
    head.append(icon("shield", "approval-ico"));
    head.append(el("span", undefined, t("Approval requested")));
    card.append(head);
    card.append(el("div", "approval-body", description));
    if (command) card.append(el("pre", "approval-command", command));

    const actions = el("div", "approval-actions");
    const answer = (a: "once" | "session" | "always" | "no", label: string) => {
      send({ type: "approve", id, answer: a });
      card.replaceChildren(el("div", "approval-done", label));
    };
    actions.append(
      button({ label: t("Allow"), className: "btn primary", onClick: () => answer("once", t("Allowed once.")) }),
      button({
        label: t("Always (this conversation)"),
        className: "btn",
        title: t("Stop asking for {0} until the next conversation", tool),
        onClick: () => answer("session", t("Allowed for this conversation.")),
      }),
      button({
        label: t("Always"),
        className: "btn",
        title: t("Write a permanent rule for this action"),
        onClick: () => answer("always", t("Permanent rule saved.")),
      }),
      button({ label: t("Refuse"), className: "btn danger", onClick: () => answer("no", t("Refused.")) }),
    );
    card.append(actions);
    this.body.append(card);
    scrollToEnd();
  }

  /** Replace the raw stream with rendered markdown once the turn ends. */
  finish(): void {
    if (this.text && this.buffer) {
      const rendered = markdown(this.buffer, {
        onCopy: (code) => send({ type: "copy", text: code }),
        onInsert: (code) => send({ type: "insertCode", code }),
        onApply: (code, language) => send({ type: "applyCode", code, language }),
      });
      this.text.replaceWith(rendered);
      this.text = undefined;
    }
    this.root.classList.remove("streaming");
  }
}

function ensureLive(): LiveTurn {
  if (live) return live;
  const list = document.querySelector<HTMLElement>(".transcript") ?? app;
  // The welcome block is not part of the conversation; it goes as soon as one starts.
  list.querySelector(".welcome")?.remove();
  live = new LiveTurn(list);
  scrollToEnd();
  return live;
}

function scrollToEnd(): void {
  requestAnimationFrame(() => {
    const list = document.querySelector(".transcript");
    if (list) list.scrollTop = list.scrollHeight;
  });
}

// ── Messages from the extension ──────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<ToPanel>) => {
  const m = event.data;
  switch (m.type) {
    case "state":
      state = m.state;
      render();
      break;
    case "turnStart":
      setStreaming(true);
      render();
      ensureLive();
      break;
    case "turnEnd":
      setStreaming(false);
      live?.finish();
      break;
    case "delta":
      ensureLive().appendText(m.text);
      scrollToEnd();
      break;
    case "reasoning":
      ensureLive().appendReasoning(m.text);
      break;
    case "status":
      ensureLive().appendStatus(m.text, m.tool, m.ok);
      scrollToEnd();
      break;
    case "approval":
      ensureLive().appendApproval(m.id, m.tool, m.description, m.command);
      break;
    case "error":
      ensureLive().appendError(m.message);
      setStreaming(false);
      break;
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeMenu();
  // The editor's own find shortcut, applied to the conversation.
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "f" && state?.screen === "chat") {
    ev.preventDefault();
    searchOpen = true;
    render();
    document.querySelector<HTMLInputElement>(".search-input")?.focus();
  }
});

send({ type: "ready" });
export { isStreaming };
