// Two reports, both answering questions a team asks before it adopts a tool: what left this
// machine, and what did it cost. They are rendered as plain webviews with no script at all — a
// report about privacy that runs code would be a poor joke.

import * as vscode from "vscode";
import { language, t } from "../shared/i18n.js";
import { catalogueAge } from "./prices.js";
import type { EgressGate, EgressRecord } from "./egress.js";
import type { Settings } from "./config.js";

export function showEgressReport(gate: EgressGate, settings: Settings): void {
  const ledger = gate.ledger();
  const panel = vscode.window.createWebviewPanel("forge.egress", t("Forge — outgoing data"), vscode.ViewColumn.Active, {
    enableScripts: false,
  });
  const totals = ledger.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      tokens: acc.tokens + r.promptTokens + r.completionTokens,
      usd: acc.usd + r.usd,
      redactions: acc.redactions + r.redactions,
    }),
    { calls: 0, tokens: 0, usd: 0, redactions: 0 },
  );

  panel.webview.html = page(
    t("Outgoing data"),
    `
    <p class="lede">
      ${escapeHtml(
        t(
          "Every row is a request that left this machine for a remote provider. The content is never " +
            "logged — only the fact that a request happened, where it went and what it cost. Requests to a " +
            "local server do not appear here: they do not leave.",
        ),
      )}
    </p>
    <div class="cards">
      ${card(t("Remote requests"), String(totals.calls))}
      ${card(t("Tokens"), totals.tokens.toLocaleString(uiLocale()))}
      ${card(t("Total cost"), `$${totals.usd.toFixed(4)}`)}
      ${card(t("Pseudonymised values"), String(totals.redactions))}
    </div>
    <p class="note">
      ${escapeHtml(t("Redaction policy:"))} <code>${escapeHtml(settings.privacy.redaction)}</code> ·
      ${escapeHtml(t("consent:"))} <code>${escapeHtml(settings.privacy.egressPolicy)}</code> ·
      ${escapeHtml(t("log:"))} <code>${escapeHtml(settings.privacy.auditLog ? t("on") : t("off"))}</code>.
    </p>
    ${
      ledger.length
        ? `<table>
      <thead><tr>${[t("When"), t("Destination"), t("Model"), t("Tokens"), t("Cache"), t("Cost"), t("Pseudonymised")].map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${ledger.map(row).join("")}</tbody>
    </table>`
        : `<p class="empty">${escapeHtml(t("No remote request recorded. Everything happened on this machine."))}</p>`
    }`,
  );
}

export function showCostReport(gate: EgressGate, settings: Settings): void {
  const ledger = gate.ledger();
  const byModel = new Map<string, { calls: number; usd: number; tokens: number; cached: number }>();
  for (const r of ledger) {
    const cur = byModel.get(r.model) ?? { calls: 0, usd: 0, tokens: 0, cached: 0 };
    cur.calls++;
    cur.usd += r.usd;
    cur.tokens += r.promptTokens + r.completionTokens;
    cur.cached += r.cachedTokens;
    byModel.set(r.model, cur);
  }
  const spent = gate.budget.spentToday();
  const daily = settings.budget.dailyUsd;
  const pct = daily > 0 ? Math.min(100, Math.round((spent / daily) * 100)) : 0;

  const panel = vscode.window.createWebviewPanel("forge.costs", t("Forge — cost"), vscode.ViewColumn.Active, {
    enableScripts: false,
  });
  panel.webview.html = page(
    t("Cost"),
    `
    <div class="cards">
      ${card(t("Spent today"), `$${spent.toFixed(4)}`)}
      ${card(t("Daily cap"), daily > 0 ? `$${daily.toFixed(2)}` : t("none"))}
      ${card(t("Per-request cap"), `$${settings.budget.perRequestUsd.toFixed(2)}`)}
      ${card(t("Remote calls"), String(gate.budget.callsToday()))}
    </div>
    ${daily > 0 ? `<div class="bar"><div class="fill" style="width:${pct}%"></div></div><p class="note">${escapeHtml(t("{0} % of today's cap.", pct))}</p>` : ""}
    <p class="lede">
      ${escapeHtml(
        t(
          "Inline completion and the chores run locally by construction: they never appear here, whatever " +
            "their volume. This table counts only what was deliberately sent to a paid provider.",
        ),
      )}
    </p>
    ${
      byModel.size
        ? `<table>
      <thead><tr>${[t("Model"), t("Calls"), t("Tokens"), t("Served from cache"), t("Cost")].map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${[...byModel.entries()]
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(
          ([model, v]) =>
            `<tr><td><code>${escapeHtml(model)}</code></td><td>${v.calls}</td><td>${v.tokens.toLocaleString(uiLocale())}</td><td>${
              v.tokens ? Math.round((v.cached / v.tokens) * 100) : 0
            } %</td><td>$${v.usd.toFixed(4)}</td></tr>`,
        )
        .join("")}</tbody>
    </table>`
        : `<p class="empty">${escapeHtml(t("Nothing spent. That is the default behaviour."))}</p>`
    }
    <p class="note">${escapeHtml(t("Price catalogue updated {0}.", catalogueAge()))}</p>`,
  );
}

function row(r: EgressRecord): string {
  const when = new Date(r.at).toLocaleString(uiLocale());
  const cached = r.promptTokens ? Math.round((r.cachedTokens / r.promptTokens) * 100) : 0;
  return `<tr>
    <td>${escapeHtml(when)}</td>
    <td><code>${escapeHtml(r.host)}</code></td>
    <td><code>${escapeHtml(r.model)}</code></td>
    <td>${(r.promptTokens + r.completionTokens).toLocaleString(uiLocale())}</td>
    <td>${cached} %</td>
    <td>$${r.usd.toFixed(4)}</td>
    <td>${r.redactions ? escapeHtml(r.redactionSummary || String(r.redactions)) : "—"}</td>
  </tr>`;
}

/** Numbers and dates follow the interface language, not the machine's locale. */
function uiLocale(): string {
  return language() === "fr" ? "fr-FR" : "en-GB";
}

function card(label: string, value: string): string {
  return `<div class="card"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.5rem 2rem; max-width: 70rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  .lede, .note { color: var(--vscode-descriptionForeground); max-width: 46rem; line-height: 1.5; }
  .note { font-size: 0.85em; }
  .cards { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.25rem 0; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent);
          border-radius: 6px; padding: 0.75rem 1rem; min-width: 9rem; }
  .card .value { font-size: 1.4rem; font-weight: 600; }
  .card .label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 0.15rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.9em; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  code { font-family: var(--vscode-editor-font-family); }
  .empty { font-style: italic; color: var(--vscode-descriptionForeground); }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-editorWidget-background); overflow: hidden; max-width: 30rem; }
  .fill { height: 100%; background: var(--vscode-charts-yellow, #d7a13b); }
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
