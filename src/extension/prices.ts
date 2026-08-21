// Price lookup. The catalogue is generated (scripts/update-models.mjs, refreshed by a scheduled
// workflow) so that no price and no model id is ever hard-coded by hand — the rule the sidebar's
// model catalogue arrived at after the third time a hard-coded version went stale.

import type { Price } from "../core/router/pricing.js";
import { GENERATED_PRICES, GENERATED_AT } from "../core/router/catalog.generated.js";

export function loadPrices(): Record<string, Price> {
  return GENERATED_PRICES;
}

export function catalogueAge(): string {
  if (!GENERATED_AT) return "jamais mis à jour";
  const days = Math.floor((Date.now() - Date.parse(GENERATED_AT)) / 86_400_000);
  return days <= 0 ? "aujourd'hui" : `il y a ${days} jour(s)`;
}
