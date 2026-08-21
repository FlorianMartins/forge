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

const prices = {};
let kept = 0;
for (const m of data ?? []) {
  const p = m.pricing ?? {};
  // OpenRouter quotes USD per token as a string; the catalogue stores USD per million, which is
  // how everyone reads prices and avoids a float with nine leading zeros.
  const perMillion = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Number((n * 1_000_000).toFixed(4)) : 0;
  };
  const entry = { in: perMillion(p.prompt), out: perMillion(p.completion) };
  const cached = perMillion(p.input_cache_read);
  if (cached) entry.cachedIn = cached;
  // A free endpoint is worth recording as free: it is what makes `:free` variants usable.
  if (!entry.in && !entry.out && !/:free$/.test(m.id)) continue;
  prices[m.id] = entry;
  kept++;

  // Native APIs use the bare id (`claude-sonnet-4-5`, `gpt-5`); OpenRouter prefixes it with the
  // vendor. Alias the bare form so the same model is priced whichever door it came through.
  const bare = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : undefined;
  if (bare && !prices[bare]) prices[bare] = entry;
}

// Local inference costs electricity, not tokens — and the wildcard makes that explicit rather than
// leaving a local model "unknown cost".
prices["local/*"] = { in: 0, out: 0 };

const body = `// GENERATED FILE — do not edit by hand.
// Written by \`npm run models\` (scripts/update-models.mjs); a scheduled workflow commits the diff.
// ${kept} priced models, in USD per million tokens.
//
// A model that is absent from this table is reported as "unknown cost" rather than guessed: a
// wrong price silently spends someone's budget.

import type { Price } from "./pricing.js";

export const GENERATED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};

export const GENERATED_PRICES: Record<string, Price> = {
${Object.entries(sortKeys(prices))
  .map(([id, p]) => `  ${JSON.stringify(id)}: ${JSON.stringify(p)},`)
  .join("\n")}
};
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

// One line per model: a 400-entry table pretty-printed over four lines each turns every daily
// refresh into an unreadable diff.
function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
