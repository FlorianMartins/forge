// The history screen: every conversation, searchable and filterable.
//
// The filters are not decoration. A month into using an assistant there are two hundred
// conversations, and the questions people actually ask of that pile are always the same four:
// "where is the one about the invoices", "what did I do this week", "which ones cost money", and
// "what did I ask it to plan". So: full-text search that looks inside the messages and shows the
// matching fragment, a period, a mode, and a paid-only switch.

import { button, el, ICON, relativeDate, searchInput } from "./dom.js";
import type { ToExtension, UiHistoryFilter, UiHistoryRow, UiState } from "../shared/protocol.js";

const PERIODS: Array<{ id: UiHistoryFilter["period"]; label: string }> = [
  { id: "all", label: "Tout" },
  { id: "today", label: "Aujourd'hui" },
  { id: "week", label: "7 jours" },
  { id: "month", label: "30 jours" },
];

const MODES: Array<{ id: UiHistoryFilter["mode"]; label: string }> = [
  { id: "all", label: "Tous modes" },
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "chat", label: "Discussion" },
];

const SORTS: Array<{ id: UiHistoryFilter["sort"]; label: string }> = [
  { id: "updated", label: "Modifiée récemment" },
  { id: "created", label: "Créée récemment" },
  { id: "messages", label: "La plus longue" },
  { id: "cost", label: "La plus coûteuse" },
];

export function historyScreen(state: UiState, send: (m: ToExtension) => void): HTMLElement {
  const wrap = el("div", "screen history-screen");
  const filter = state.historyFilter;

  const bar = el("div", "filter-bar");
  bar.append(
    searchInput({
      value: filter.query,
      placeholder: "Rechercher dans les conversations…",
      onInput: (query) => send({ type: "setHistoryFilter", filter: { query } }),
    }),
  );

  const chips = el("div", "filter-chips");
  for (const p of PERIODS) {
    chips.append(
      button({
        label: p.label,
        className: `chip-btn${filter.period === p.id ? " selected" : ""}`,
        onClick: () => send({ type: "setHistoryFilter", filter: { period: p.id } }),
      }),
    );
  }
  chips.append(el("div", "filter-gap"));
  for (const m of MODES) {
    chips.append(
      button({
        label: m.label,
        className: `chip-btn${filter.mode === m.id ? " selected" : ""}`,
        onClick: () => send({ type: "setHistoryFilter", filter: { mode: m.id } }),
      }),
    );
  }
  bar.append(chips);

  const row2 = el("div", "filter-row");
  row2.append(
    button({
      label: "Payantes seulement",
      ...(filter.paidOnly ? { icon: ICON.check } : {}),
      className: `chip-btn${filter.paidOnly ? " selected" : ""}`,
      title: "Ne garder que les conversations qui ont coûté quelque chose",
      onClick: () => send({ type: "setHistoryFilter", filter: { paidOnly: !filter.paidOnly } }),
    }),
  );
  const select = el("select", "sort-select");
  for (const s of SORTS) {
    const option = el("option", undefined, s.label);
    option.value = s.id;
    if (filter.sort === s.id) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () =>
    send({ type: "setHistoryFilter", filter: { sort: select.value as UiHistoryFilter["sort"] } }),
  );
  row2.append(el("div", "spacer"), el("label", "sort-label", "Trier :"), select);
  bar.append(row2);
  wrap.append(bar);

  const list = el("div", "history-list");
  if (!state.history.length) {
    list.append(
      el(
        "p",
        "empty",
        filter.query || filter.period !== "all" || filter.mode !== "all" || filter.paidOnly
          ? "Aucune conversation ne correspond à ces filtres."
          : "Aucune conversation enregistrée. Les discussions apparaissent ici dès le premier message.",
      ),
    );
  }
  for (const row of state.history) list.append(historyRow(row, state, send));
  wrap.append(list);

  const total = state.history.reduce((sum, r) => sum + r.usdCost, 0);
  wrap.append(
    el(
      "div",
      "history-footer",
      `${state.history.length} conversation(s)${total > 0 ? ` · ${total.toFixed(3)} $ au total` : " · aucun coût"}`,
    ),
  );
  return wrap;
}

function historyRow(row: UiHistoryRow, state: UiState, send: (m: ToExtension) => void): HTMLElement {
  const wrap = el("div", `history-row${row.id === state.session.id ? " current" : ""}`);

  const open = el("button", "history-open");
  const title = el("div", "history-title", row.title);
  open.append(title);
  if (row.excerpt) open.append(el("div", "history-excerpt", row.excerpt));

  const meta = el("div", "history-meta");
  meta.append(el("span", `mode-tag mode-${row.mode}`, modeLabel(row.mode)));
  meta.append(el("span", undefined, relativeDate(row.updatedAt)));
  meta.append(el("span", undefined, `${row.messages} message${row.messages > 1 ? "s" : ""}`));
  if (row.usdCost > 0) meta.append(el("span", "history-cost", `${row.usdCost.toFixed(4)} $`));
  open.append(meta);
  open.title = `Créée le ${new Date(row.createdAt).toLocaleString("fr-FR")}\nModifiée le ${new Date(row.updatedAt).toLocaleString("fr-FR")}`;
  open.addEventListener("click", () => send({ type: "openSession", id: row.id }));

  wrap.append(open);
  wrap.append(
    button({
      icon: ICON.trash,
      title: "Supprimer cette conversation",
      className: "btn icon-only",
      onClick: () => send({ type: "deleteSession", id: row.id }),
    }),
  );
  return wrap;
}

function modeLabel(mode: UiHistoryRow["mode"]): string {
  return mode === "agent" ? "Agent" : mode === "plan" ? "Plan" : "Discussion";
}
