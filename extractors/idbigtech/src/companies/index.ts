import type { IdBigTechCompanyId } from "@shared/extractors/indonesia/index.js";
import type { CompanyFetcher } from "../types";
import { blibliFetcher } from "./blibli";
import { gotoFetcher } from "./goto";
import { grabFetcher } from "./grab";
import { shopeeFetcher } from "./shopee";
import { tiketFetcher } from "./tiket";
import { tiktokFetcher } from "./tiktok";
import { travelokaFetcher } from "./traveloka";
import { xenditFetcher } from "./xendit";

/** One fetcher per company id in `ID_BIG_TECH_COMPANIES`. */
export const COMPANY_FETCHERS: Readonly<
  Record<IdBigTechCompanyId, CompanyFetcher>
> = {
  grab: grabFetcher,
  goto: gotoFetcher,
  tiktok: tiktokFetcher,
  shopee: shopeeFetcher,
  traveloka: travelokaFetcher,
  tiket: tiketFetcher,
  blibli: blibliFetcher,
  xendit: xenditFetcher,
};
