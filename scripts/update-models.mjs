#!/usr/bin/env node
// Regenerates the price catalogue from OpenRouter's public model list.
//
// Why a generated file rather than a fetch at runtime: prices must be known BEFORE a request, to
// refuse one that would blow the budget, and an extension that phones a catalogue endpoint on
// startup is an extension that talks to the network before the user asked it to. So the list is
// baked in, refreshed by a scheduled job, and reviewable as a diff.
//
// Why never by hand: the sidebar project learned this the expensive way. A hard-coded model id or
// price is correct on the day it is written and wrong within weeks, silently.
//
//   node scripts/update-models.mjs          rewrite the catalogue
//   node scripts/update-models.mjs --check  exit 1 if it is out of date (CI)

import { readFile, writeFile } from "node:fs/promises";

const OUT = "src/core/router/catalog.generated.ts";
const check = process.argv.includes("--check");

const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { Accept: "application/json" } });
if (!res.ok) {
  console.error(`OpenRouter answered ${res.status}. Leaving the catalogue as it is.`);
  process.exit(check ? 0 : 1);
}
const { data } = await res.json();

// Compact tuples rather than objects: 400 models, one line each, and a daily diff a human can read.
// [id, display name, vendor, context window, $/M in, $/M out, $/M cached-in]
const rows = [];
let kept = 0;
for (const m of data ?? []) {
  const p = m.pricing ?? {};
  // OpenRouter quotes USD per token as a string; the catalogue stores USD per million, which is
  // how everyone reads prices and avoids a float with nine leading zeros.
  const perMillion = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Number((n * 1_000_000).toFixed(4)) : 0;
  };
  const inUsd = perMillion(p.prompt);
  const outUsd = perMillion(p.completion);
  const cachedUsd = perMillion(p.input_cache_read);
  // A free endpoint is worth recording as free: it is what makes `:free` variants usable.
  if (!inUsd && !outUsd && !/:free$/.test(m.id)) continue;

  const vendor = m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "";
  const name = String(m.name ?? m.id).replace(/^[^:]+:\s*/, "");
  rows.push([m.id, name, vendor, Number(m.context_length ?? 0), inUsd, outUsd, cachedUsd]);
  kept++;
}
rows.sort((a, b) => a[0].localeCompare(b[0]));

const body = `// GENERATED FILE — do not edit by hand.
// Written by \`npm run models\` (scripts/update-models.mjs); a scheduled workflow commits the diff.
// ${kept} priced models. Tuples: [id, name, vendor, context, $/M in, $/M out, $/M cached-in].
//
// A model that is absent from this table is reported as "unknown cost" rather than guessed: a
// wrong price silently spends someone's budget.

import type { Price } from "./pricing.js";

export const GENERATED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};

export type ModelRow = [string, string, string, number, number, number, number];

export const GENERATED_MODELS: ModelRow[] = [
${rows.map((r) => `  ${JSON.stringify(r)},`).join("\n")}
];

/**
 * Prices, keyed by id. Bare ids are aliased too: a native API calls it \`claude-sonnet-4-5\` where
 * OpenRouter calls it \`anthropic/claude-sonnet-4.5\`, and both should be priced.
 */
export const GENERATED_PRICES: Record<string, Price> = (() => {
  const table: Record<string, Price> = { "local/*": { in: 0, out: 0 } };
  for (const [id, , , , inUsd, outUsd, cachedUsd] of GENERATED_MODELS) {
    const price: Price = cachedUsd ? { in: inUsd, out: outUsd, cachedIn: cachedUsd } : { in: inUsd, out: outUsd };
    table[id] = price;
    const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : undefined;
    if (bare && !table[bare]) table[bare] = price;
  }
  return table;
})();
`;

const previous = await readFile(OUT, "utf8").catch(() => "");
const strip = (s) => s.replace(/export const GENERATED_AT = "[^"]*";/, "");

if (strip(previous) === strip(body)) {
  console.log(`Catalogue already current (${kept} models).`);
  process.exit(0);
}
if (check) {
  console.error(`Catalogue out of date: ${kept} models available. Run \`npm run models\`.`);
  process.exit(1);
}
await writeFile(OUT, body, "utf8");
console.log(`Wrote ${OUT} — ${kept} models.`);
