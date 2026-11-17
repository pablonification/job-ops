import { defineTool, defineToolGroup } from "@server/mcp/kit";
import * as visaSponsors from "@server/services/visa-sponsors/index";
import { normalizeCountryKey } from "@shared/location-support.js";
import { z } from "zod";

const searchVisaSponsorsTool = defineTool({
  name: "search_visa_sponsors",
  title: "Search visa sponsor registers",
  description:
    "Fuzzy-search official visa sponsor registers (e.g. the UK licensed sponsor list) for an employer name. Returns matching organisations with a match score (0-100), country and register details.",
  scope: "read",
  input: z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Employer name to look up."),
      country: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Only this country's register, e.g. united kingdom."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Maximum results (1-200, default 20)."),
      minScore: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Minimum match score (0-100, default 30)."),
    })
    .strict(),
  handler: async ({ query, country, limit, minScore }) => {
    const results =
      (await visaSponsors.searchSponsors(query, {
        limit,
        minScore,
        countryKey: country ? normalizeCountryKey(country) : undefined,
      })) ?? [];
    return { query, results, total: results.length };
  },
});

export const visaSponsorsToolGroup = defineToolGroup({
  id: "visa-sponsors",
  tools: [searchVisaSponsorsTool],
});
