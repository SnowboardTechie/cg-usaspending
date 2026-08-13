/**
 * Joins USAspending awards to Simpler.Grants.gov opportunities on the federal
 * funding opportunity number.
 *
 * Every joined award is kept by default. A single opportunity can account for
 * dozens of awards (one NOFO, many recipients), so awards are ordered
 * round-robin across opportunity numbers rather than left grouped by program.
 * That makes the output read across the sample instead of in program-sized
 * blocks, and it means an optional cap yields a spread of opportunities rather
 * than the first one or two programs.
 */

import {
  findOpportunity,
  type OpportunityIndex,
  type ResolvedOpportunity,
} from "../fetch/sgg.js";
import type { AwardDetail, CandidateSet } from "../fetch/usaspending.js";
import { opportunityNumberOf } from "../fetch/usaspending.js";

export interface JoinedPair {
  award: AwardDetail;
  opportunity: ResolvedOpportunity;
}

export interface JoinResult {
  /** Awards whose opportunity number matched, ordered round-robin and capped. */
  selected: JoinedPair[];
  /** Awards whose opportunity number matched, before any cap. */
  matchedAwardCount: number;
  /** Opportunity numbers found in the export. */
  matchedNumbers: string[];
  /** Opportunity numbers the export has no entry for. */
  unmatchedNumbers: string[];
}

/** Groups awards by opportunity number, preserving input order within a group. */
function groupByNumber(
  awards: readonly AwardDetail[],
): Map<string, AwardDetail[]> {
  const groups = new Map<string, AwardDetail[]>();
  for (const award of awards) {
    const number = opportunityNumberOf(award);
    const group = groups.get(number);
    if (group) group.push(award);
    else groups.set(number, [award]);
  }
  return groups;
}

/** Draws awards one per opportunity number per pass, up to `limit`. */
function drawRoundRobin(
  groups: Map<string, AwardDetail[]>,
  limit: number,
): AwardDetail[] {
  const queues = [...groups.values()];
  const drawn: AwardDetail[] = [];

  let exhausted = false;
  while (drawn.length < limit && !exhausted) {
    exhausted = true;
    for (const queue of queues) {
      if (drawn.length >= limit) break;
      const award = queue.shift();
      if (award) {
        drawn.push(award);
        exhausted = false;
      }
    }
  }

  return drawn;
}

/**
 * Joins candidates against the opportunity index.
 *
 * `targetCount` is an optional cap. Undefined emits every joined award.
 */
export function joinAwardsToOpportunities(
  candidates: CandidateSet,
  index: OpportunityIndex,
  targetCount?: number,
): JoinResult {
  const matched = new Map<string, ResolvedOpportunity>();
  const unmatchedNumbers: string[] = [];

  for (const number of candidates.opportunityNumbers) {
    const opportunity = findOpportunity(index, number);
    if (opportunity) matched.set(number, opportunity);
    else unmatchedNumbers.push(number);
  }

  const matchedAwards = candidates.withOpportunityNumber.filter((award) =>
    matched.has(opportunityNumberOf(award)),
  );

  const limit = targetCount ?? Number.POSITIVE_INFINITY;
  const selected = drawRoundRobin(groupByNumber(matchedAwards), limit).map(
    (award) => ({
      award,
      opportunity: matched.get(
        opportunityNumberOf(award),
      ) as ResolvedOpportunity,
    }),
  );

  return {
    selected,
    matchedAwardCount: matchedAwards.length,
    matchedNumbers: [...matched.keys()].sort(),
    unmatchedNumbers: unmatchedNumbers.sort(),
  };
}
