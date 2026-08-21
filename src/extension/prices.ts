// Price lookup. The catalogue is generated (scripts/update-models.mjs, refreshed by a scheduled
// workflow) so that no price and no model id is ever hard-coded by hand — the rule the sidebar's
// model catalogue arrived at after the third time a hard-coded version went stale.

import type { Price } from "../core/router/pricing.js";
import { t } from "../shared/i18n.js";
import { GENERATED_PRICES, GENERATED_AT } from "../core/router/catalog.generated.js";

export function loadPrices(): Record<string, Price> {
  return GENERATED_PRICES;
}

export function catalogueAge(): string {
  if (!GENERATED_AT) return t("never updated");
  const days = Math.floor((Date.now() - Date.parse(GENERATED_AT)) / 86_400_000);
  return days <= 0 ? t("today") : t("{0} day(s) ago", days);
}
