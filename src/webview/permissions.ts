// The permission book: what the agent may do without asking.
//
// Two lists, deliberately separated. Rules written to disk survive restarts and are the ones worth
// reading twice; grants given for the current conversation disappear on their own. Showing them in
// one list would make a temporary yes look permanent, which is the mistake that makes people stop
// trusting a permission dialog.

import { button, el, icon, ICON } from "./dom.js";
import type { ToExtension, UiPermissionRule, UiState } from "../shared/protocol.js";

const TOOL_LABELS: Record<string, string> = {
  read_file: "Lire un fichier",
  list_files: "Lister les fichiers",
  search_text: "Chercher dans le dépôt",
  get_diagnostics: "Lire les diagnostics",
  write_file: "Écrire un fichier",
  edit_file: "Modifier un fichier",
  run_command: "Exécuter une commande",
};

const GRANTABLE = ["write_file", "edit_file", "run_command"];

export function permissionsScreen(state: UiState, send: (m: ToExtension) => void): HTMLElement {
  const wrap = el("div", "screen permissions-screen");

  wrap.append(
    el("p", "screen-lede",
      "Par défaut, Forge lit sans demander et demande avant toute écriture ou commande. Ce que vous " +
        "autorisez ici s'applique à la forme de l'action, jamais à une seule occurrence : autoriser " +
        "« npm test » n'autorise pas « npm publish ».",
    ),
  );

  const stored = state.permissions.filter((r) => !r.session);
  const session = state.permissions.filter((r) => r.session);

  wrap.append(sectionTitle("Règles permanentes", "Écrites sur le disque, valables jusqu'à ce que vous les retiriez."));
  const list = el("div", "perm-list");
  if (!stored.length) list.append(el("p", "empty", "Aucune règle : tout ce qui modifie est demandé."));
  for (const rule of stored) list.append(ruleRow(rule, send));
  wrap.append(list);

  wrap.append(sectionTitle("Accordé pour cette conversation", "Oublié à la prochaine discussion."));
  const temp = el("div", "perm-list");
  if (!session.length) temp.append(el("p", "empty", "Rien pour l'instant."));
  for (const rule of session) temp.append(ruleRow(rule, send));
  if (session.length) {
    temp.append(
      button({
        label: "Tout révoquer",
        className: "btn tiny",
        onClick: () => send({ type: "clearSessionPermissions" }),
      }),
    );
  }
  wrap.append(temp);

  wrap.append(
    sectionTitle(
      "Ajouter une règle permanente",
      "« Autoriser » cesse de demander pour cette action ; « Refuser » la bloque sans la proposer.",
    ),
  );
  const add = el("div", "perm-add");
  for (const tool of GRANTABLE) {
    const row = el("div", "perm-add-row");
    row.append(el("span", "perm-tool", TOOL_LABELS[tool] ?? tool));
    row.append(el("div", "spacer"));
    row.append(
      button({
        label: "Autoriser",
        className: "btn tiny",
        title: "Cette action ne sera plus demandée, dans tous les espaces de travail",
        onClick: () => send({ type: "setPermission", tool, level: "always" }),
      }),
      button({
        label: "Refuser",
        className: "btn tiny danger",
        title: "Cette action sera refusée sans être proposée",
        onClick: () => send({ type: "setPermission", tool, level: "never" }),
      }),
    );
    add.append(row);
  }
  wrap.append(add);

  wrap.append(
    el(
      "p",
      "screen-note",
      "Un refus l'emporte toujours sur une autorisation, et les chemins hors de l'espace de travail " +
        "ou couverts par la politique de confidentialité restent interdits quelles que soient ces règles.",
    ),
  );
  return wrap;
}

function sectionTitle(title: string, hint: string): HTMLElement {
  const wrap = el("div", "models-section");
  wrap.append(el("div", "models-section-title", title));
  wrap.append(el("div", "models-section-hint", hint));
  return wrap;
}

function ruleRow(rule: UiPermissionRule, send: (m: ToExtension) => void): HTMLElement {
  const row = el("div", `perm-row${rule.level === "never" ? " deny" : ""}`);
  row.append(icon(rule.level === "never" ? "cross" : "check", "perm-ico"));

  const main = el("div", "perm-main");
  main.append(el("span", "perm-tool", TOOL_LABELS[rule.tool] ?? rule.tool));
  if (rule.prefix) main.append(el("code", "perm-prefix", rule.prefix));
  row.append(main);

  row.append(el("span", "perm-level", rule.session ? "cette conversation" : rule.level === "never" ? "refusé" : "autorisé"));
  if (!rule.session) {
    row.append(
      button({
        icon: ICON.trash,
        title: "Retirer cette règle",
        className: "btn icon-only",
        onClick: () => send({ type: "forgetPermission", tool: rule.tool, ...(rule.prefix ? { prefix: rule.prefix } : {}) }),
      }),
    );
  }
  return row;
}
