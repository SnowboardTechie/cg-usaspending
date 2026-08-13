/**
 * Simpler.Grants.gov opportunity export, via the CommonGrants SDK and the
 * Grants.gov plugin.
 *
 * The plugin binds its Opportunity schema and its registered search filters, so
 * `customFields.federalOpportunityNumber` comes back typed and validated. That
 * field is the join key: USAspending reports the same value in
 * `funding_opportunity.number`.
 *
 * There is no filter for the opportunity number, so rather than querying once
 * per number, this pulls a batch of opportunities bounded by close date and
 * agency and indexes them by number. One paged export replaces N queries, and
 * matching becomes an exact comparison against the field itself rather than an
 * interpretation of free-text search ranking.
 *
 * The tradeoff is coverage: a number outside the export cannot match. The window
 * is derived from the awards being joined rather than pinned to the current
 * year, and `auditMisses` measures whether the tradeoff is costing anything.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Auth } from "@common-grants/sdk/client";
import { F } from "@common-grants/sdk/extensions";
import plugin from "@common-grants/cg-grants-gov";
import type { Config } from "../config.js";
import type { CandidateSet } from "./usaspending.js";

type Opportunity = z.infer<typeof plugin.schemas.Opportunity.commonSchema>;

/** Page size used while paging through the export. */
const EXPORT_PAGE_SIZE = 100;

/** How many search hits to scan when auditing a miss. */
const SEARCH_PAGE_SIZE = 25;

/** The subset of an opportunity this script keeps for the join and the output. */
export interface ResolvedOpportunity {
  /** The opportunity's CommonGrants UUID. */
  id: string;
  title: string;
  /** The federal opportunity number, as reported by Simpler.Grants.gov. */
  federalOpportunityNumber: string;
  status?: string;
  agencyCode?: string | null;
  agencyName?: string | null;
}

export interface ExportWindow {
  /** Inclusive `closeDate` range for the export. */
  closeDateRange: { min: string; max: string };
  /** Top-level agency codes to restrict the export to. Empty means no filter. */
  agencies: string[];
}

/** An export, indexed by opportunity number. */
export interface OpportunityIndex {
  byNumber: Map<string, ResolvedOpportunity>;
  window: ExportWindow;
  /** Opportunities the export returned. */
  exported: number;
  /** Of those, how many reported an opportunity number. */
  indexed: number;
  /** True when the export stopped at the item cap, so coverage is incomplete. */
  truncated: boolean;
  /** True when the export was read from disk rather than fetched. */
  fromCache: boolean;
}

// =============================================================================
// Export window
// =============================================================================

/** Years to pad the window by, covering the gap between an opportunity closing
 * and its awards being signed, and opportunities closing after the sample. */
const WINDOW_LEAD_YEARS = 2;
const WINDOW_TRAIL_YEARS = 1;

/**
 * Derives the export window from the awards being joined.
 *
 * The opportunity an award references is older than the award itself, often by
 * years, so a window pinned to the current year misses most of the set. On one
 * 155-award sample only 26% were signed in 2025. Spanning the sample's own
 * signing dates keeps every candidate eligible to match.
 *
 * Agency codes come from the awards' awarding agency abbreviations (HHS, ED, and
 * so on), which share a namespace with the opportunity `agency` filter.
 */
export function deriveExportWindow(
  config: Config,
  candidates: CandidateSet,
): ExportWindow {
  const years = candidates.withOpportunityNumber
    .map((award) => Number.parseInt((award.date_signed ?? "").slice(0, 4), 10))
    .filter((year) => !Number.isNaN(year));
  const thisYear = new Date().getFullYear();
  const earliest = years.length > 0 ? Math.min(...years) : thisYear;
  const latest = years.length > 0 ? Math.max(...years) : thisYear;

  const agencies = [
    ...new Set(
      candidates.withOpportunityNumber
        .map((award) =>
          award.awarding_agency?.toptier_agency?.abbreviation?.trim(),
        )
        .filter((code): code is string => Boolean(code)),
    ),
  ].sort();

  return {
    closeDateRange: {
      min: config.sggCloseDateStart ?? `${earliest - WINDOW_LEAD_YEARS}-01-01`,
      max: config.sggCloseDateEnd ?? `${latest + WINDOW_TRAIL_YEARS}-12-31`,
    },
    agencies: config.sggAgencies ?? agencies,
  };
}

// =============================================================================
// Indexing
// =============================================================================

/** Keys the index the way the two systems disagree in practice: surrounding
 * whitespace and letter case vary, everything else must be equal. */
function indexKey(federalOpportunityNumber: string): string {
  return federalOpportunityNumber.trim().toLowerCase();
}

/** Finds the opportunity an award's funding opportunity number refers to. */
export function findOpportunity(
  index: OpportunityIndex,
  federalOpportunityNumber: string,
): ResolvedOpportunity | undefined {
  return index.byNumber.get(indexKey(federalOpportunityNumber));
}

function createClient(config: Config) {
  if (!config.sggApiKey) {
    throw new Error("SGG_API_KEY is required to reach Simpler.Grants.gov");
  }
  return plugin.getClient({
    baseUrl: config.sggBaseUrl,
    auth: Auth.apiKey(config.sggApiKey, config.sggAuthHeader),
  });
}

/** The opportunity number an item reports, if it reports a usable one. */
function reportedNumber(opportunity: Opportunity): string | undefined {
  const value = opportunity.customFields?.federalOpportunityNumber?.value;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toResolved(
  opportunity: Opportunity,
  number: string,
): ResolvedOpportunity {
  const agency = opportunity.customFields?.agency?.value;
  return {
    id: opportunity.id,
    title: opportunity.title,
    federalOpportunityNumber: number,
    status: opportunity.status?.value,
    agencyCode: agency?.code,
    agencyName: agency?.name,
  };
}

/**
 * Indexes opportunities by number.
 *
 * When two report the same number the first wins, which keeps the index
 * deterministic for a given export order.
 */
function indexByNumber(
  opportunities: readonly ResolvedOpportunity[],
): Map<string, ResolvedOpportunity> {
  const byNumber = new Map<string, ResolvedOpportunity>();
  for (const opportunity of opportunities) {
    const key = indexKey(opportunity.federalOpportunityNumber);
    if (!byNumber.has(key)) byNumber.set(key, opportunity);
  }
  return byNumber;
}

// =============================================================================
// Export snapshot
// =============================================================================

const SnapshotSchema = z.object({
  window: z.object({
    closeDateRange: z.object({ min: z.string(), max: z.string() }),
    agencies: z.array(z.string()),
  }),
  exported: z.number(),
  truncated: z.boolean(),
  opportunities: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      federalOpportunityNumber: z.string(),
      status: z.string().optional(),
      agencyCode: z.string().nullish(),
      agencyName: z.string().nullish(),
    }),
  ),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

function snapshotPath(config: Config): string {
  return path.join(config.outDir, "opportunity-export.json");
}

/**
 * Reads a previous export, if one covers the same window.
 *
 * The snapshot records the window it was built with, so changing the window
 * rebuilds automatically rather than silently answering from the wrong bounds.
 */
async function readSnapshot(
  config: Config,
  window: ExportWindow,
): Promise<Snapshot | undefined> {
  if (process.env.REFRESH_EXPORT === "1") return undefined;
  try {
    const raw = await fs.readFile(snapshotPath(config), "utf8");
    const snapshot = SnapshotSchema.parse(JSON.parse(raw));
    const sameWindow =
      JSON.stringify(snapshot.window) === JSON.stringify(window);
    return sameWindow ? snapshot : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Loads the opportunity index, from a matching snapshot when one exists and from
 * the API otherwise.
 *
 * Without an API key the snapshot is the only source, which lets a run proceed
 * offline once an export has been taken.
 */
export async function loadOpportunityIndex(
  config: Config,
  window: ExportWindow,
): Promise<OpportunityIndex> {
  const cached = await readSnapshot(config, window);
  if (cached) {
    const byNumber = indexByNumber(cached.opportunities);
    return {
      byNumber,
      window,
      exported: cached.exported,
      indexed: cached.opportunities.length,
      truncated: cached.truncated,
      fromCache: true,
    };
  }

  if (!config.sggApiKey) {
    throw new Error(
      `No opportunity export at ${snapshotPath(config)} for this window, and no ` +
        `SGG_API_KEY to fetch one. Set SGG_API_KEY, or point OUT_DIR at a directory ` +
        `holding an export taken with the same window.`,
    );
  }

  const client = createClient(config);
  const filters: Record<string, { operator: string; value: unknown }> = {
    closeDateRange: F.between(
      window.closeDateRange.min,
      window.closeDateRange.max,
    ),
  };
  if (window.agencies.length > 0) filters.agency = F.in(window.agencies);

  const result = await client.opportunities.search({
    filters,
    pageSize: EXPORT_PAGE_SIZE,
    maxItems: config.sggExportMaxItems,
  });

  // Opportunities with no opportunity number cannot participate in the join, so
  // they count toward the export total but stay out of the index.
  const opportunities: ResolvedOpportunity[] = [];
  for (const item of result.items) {
    const number = reportedNumber(item);
    if (number) opportunities.push(toResolved(item, number));
  }

  const snapshot: Snapshot = {
    window,
    exported: result.items.length,
    // Hitting the cap means the export stopped early, so a miss could be an
    // artifact of truncation rather than a real absence.
    truncated: result.items.length >= config.sggExportMaxItems,
    opportunities,
  };
  await fs.mkdir(config.outDir, { recursive: true });
  await fs.writeFile(
    snapshotPath(config),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );

  return {
    byNumber: indexByNumber(opportunities),
    window,
    exported: snapshot.exported,
    indexed: opportunities.length,
    truncated: snapshot.truncated,
    fromCache: false,
  };
}

// =============================================================================
// Miss audit
// =============================================================================

/**
 * Checks whether unmatched numbers were genuinely absent or merely missed.
 *
 * A miss from an export is ambiguous: the opportunity may not exist, or it may
 * sit outside the window, be coded under a sub-agency the filter excluded, carry
 * no close date, or have fallen past the item cap. This runs a targeted search
 * for a small sample of misses and reports how many were recoverable. Anything
 * above zero means the export is losing real matches.
 *
 * Deliberately a bounded sample rather than a per-miss fallback: the point is to
 * measure the strategy, not to paper over it.
 */
export async function auditMisses(
  config: Config,
  unmatchedNumbers: readonly string[],
  limit: number,
): Promise<{ checked: number; recovered: string[] }> {
  if (!config.sggApiKey || limit <= 0 || unmatchedNumbers.length === 0) {
    return { checked: 0, recovered: [] };
  }

  const client = createClient(config);
  const sample = unmatchedNumbers.slice(0, limit);
  const recovered: string[] = [];

  for (const number of sample) {
    const result = await client.opportunities.search({
      query: number,
      page: 1,
      pageSize: SEARCH_PAGE_SIZE,
    });
    const hit = result.items.some(
      (item) => indexKey(reportedNumber(item) ?? "") === indexKey(number),
    );
    if (hit) recovered.push(number);
  }

  return { checked: sample.length, recovered };
}
