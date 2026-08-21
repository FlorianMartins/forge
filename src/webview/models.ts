// The model picker, with prices side by side.
//
// A price only means something next to another price, so the list is a comparison rather than a
// menu: input and output cost per million tokens, the context window, and — the column that
// matters most here — whether the endpoint is local, in which case the answer is "free" and the
// question of cost does not arise at all.
//
// The catalogue ships with the extension (refreshed by a scheduled workflow), so opening this
// screen sends no request anywhere. Only the "served now" section talks to an endpoint, and only
// to the one the user configured.

import { button, el, formatContext, formatPrice, icon, searchInput } from "./dom.js";
import type { ToExtension, UiModel, UiState } from "../shared/protocol.js";

let query = "";

export function modelsScreen(state: UiState, send: (m: ToExtension) => void, rerender: () => void): HTMLElement {
  const wrap = el("div", "screen models-screen");

  const bar = el("div", "filter-bar");
  bar.append(
    searchInput({
      value: query,
      placeholder: "Filtrer par nom ou éditeur…",
      onInput: (value) => {
        query = value;
        rerender();
      },
    }),
  );
  const actions = el("div", "filter-row");
  actions.append(
    el("span", "muted", state.modelsLoading ? "Interrogation des points de terminaison…" : `${state.models.length} modèles`),
    el("div", "spacer"),
    button({ label: "Actualiser", className: "btn tiny", onClick: () => send({ type: "refreshModels" }) }),
    button({ label: "Réglages", className: "btn tiny", onClick: () => send({ type: "openSettings" }) }),
  );
  bar.append(actions);
  wrap.append(bar);

  const needle = query.trim().toLocaleLowerCase("fr");
  const matching = state.models.filter(
    (m) => !needle || m.name.toLocaleLowerCase("fr").includes(needle) || m.id.toLocaleLowerCase("fr").includes(needle),
  );

  const local = matching.filter((m) => m.local);
  const remote = matching.filter((m) => !m.local);

  const list = el("div", "models-list");
  if (local.length) {
    list.append(sectionTitle("Sur votre machine", "Coût nul, aucune donnée ne sort."));
    for (const m of local) list.append(modelRow(m, send));
  }
  if (remote.length) {
    list.append(
      sectionTitle(
        "Distants",
        "Prix en dollars par million de jetons. Ce qui part est anonymisé et compté dans le budget.",
      ),
    );
    // Cheapest first inside each vendor, vendors alphabetical: a comparison, not a catalogue dump.
    const byVendor = new Map<string, UiModel[]>();
    for (const m of remote) {
      const list = byVendor.get(m.vendor) ?? [];
      list.push(m);
      byVendor.set(m.vendor, list);
    }
    for (const [vendor, models] of [...byVendor.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.append(el("div", "models-vendor", vendor.replace(/^[~_-]+/, "")));
      for (const m of models.sort((a, b) => a.inUsd + a.outUsd - (b.inUsd + b.outUsd))) list.append(modelRow(m, send));
    }
  }
  if (!matching.length) {
    list.append(el("p", "empty", state.modelsLoading ? "Chargement…" : "Aucun modèle ne correspond."));
  }
  wrap.append(list);
  return wrap;
}

function sectionTitle(title: string, hint: string): HTMLElement {
  const wrap = el("div", "models-section");
  wrap.append(el("div", "models-section-title", title));
  wrap.append(el("div", "models-section-hint", hint));
  return wrap;
}

function modelRow(model: UiModel, send: (m: ToExtension) => void): HTMLElement {
  const row = el("button", `model-row${model.current ? " current" : ""}`);

  const main = el("div", "model-main");
  const name = el("div", "model-name", model.name);
  if (model.current) name.append(icon("check", "model-current"));
  main.append(name);
  main.append(el("div", "model-id", model.id));
  row.append(main);

  const stats = el("div", "model-stats");
  stats.append(stat(formatContext(model.context), "contexte"));
  if (model.local) {
    stats.append(stat("gratuit", "local"));
  } else {
    stats.append(stat(formatPrice(model.inUsd), "entrée"));
    stats.append(stat(formatPrice(model.outUsd), "sortie"));
    if (model.cachedInUsd) stats.append(stat(formatPrice(model.cachedInUsd), "cache"));
  }
  row.append(stats);

  row.title = model.local
    ? "Modèle servi par un point de terminaison local : aucun coût, aucune sortie de données."
    : `Entrée ${model.inUsd} $ / M · sortie ${model.outUsd} $ / M${model.cachedInUsd ? ` · cache ${model.cachedInUsd} $ / M` : ""}`;
  row.addEventListener("click", () => send({ type: "setModel", model: model.id, provider: model.provider }));
  return row;
}

function stat(value: string, label: string): HTMLElement {
  const wrap = el("div", "model-stat");
  wrap.append(el("span", "model-stat-value", value));
  wrap.append(el("span", "model-stat-label", label));
  return wrap;
}
