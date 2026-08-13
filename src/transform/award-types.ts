/**
 * TypeScript mirror of the CommonGrants `AwardBase` model and the sub-models it
 * references.
 *
 * https://commongrants.org/protocol/models/award/
 *
 * The Award model landed in protocol v0.4 and `@common-grants/sdk` 0.6 covers
 * opportunities, so the SDK exports nothing for `AwardBase`, `AwdIds`,
 * `AwdStatus`, `AwdFunding`, `AwdTimeline`, `OppRef`, `OrgRef`, or the
 * identifier collections. Those are declared here to get compile-time checking
 * on the transform. Every shared field type comes from the SDK. Emitted records
 * are also checked at runtime against the canonical JSON Schema bundle, which
 * stays the source of truth.
 *
 * The SDK's date-bearing types (`Event`, `SystemMetadata`) hold `Date` values,
 * not strings. Those values must be produced by the SDK's own parsers, which
 * return `Date` subclasses whose `toJSON` emits the protocol's wire format
 * (`YYYY-MM-DD` for a plain date). See `dates.ts`.
 */

import type {
  DateRangeEvent,
  Event,
  Money,
  OtherEvent,
  SingleDateEvent,
  SystemMetadata,
} from "@common-grants/sdk/types";

export type {
  DateRangeEvent,
  Event,
  Money,
  OtherEvent,
  SingleDateEvent,
  SystemMetadata,
};

/** An identifier issued to a record by a registry. */
export interface Identifier {
  registry: { code: string; url?: string };
  id?: string;
  allIds?: Array<{ id: string; status: "active" | "archived" }>;
}

/** The hosting system's own identifier for a record. Its `id` is a UUID. */
export interface SystemId {
  registry: { code: string; url?: string };
  id?: string;
  allIds?: Array<{ id: string; status: "active" | "archived" }>;
}

/** Award identifier collection, including the FAIN base identifier. */
export interface AwdIds {
  systemId?: SystemId;
  otherIds?: Record<string, Identifier>;
  "awd:us:fain"?: Identifier;
}

/** Organization identifier collection, including the UEI base identifier. */
export interface OrgIds {
  systemId?: SystemId;
  otherIds?: Record<string, Identifier>;
  "org:us:ein"?: Identifier;
  "org:us:uei"?: Identifier;
  "org:xi:duns"?: Identifier;
}

export type AwdStatusValue = "awarded" | "completed" | "cancelled" | "custom";

export interface AwdStatus {
  value: AwdStatusValue;
  customValue?: string;
  description?: string;
}

export interface AwdFunding {
  details?: string;
  requestedAmount?: Money;
  awardedAmount?: Money;
  disbursedAmount?: Money;
}

export interface AwdTimeline {
  awardDate?: Event;
  periodOfPerformance?: Event;
  otherDates?: Record<string, Event>;
}

/**
 * Opportunity identifier collection.
 *
 * Not published as a schema yet. `opp:us:fon` and `opp:us:aln` are registered
 * base identifiers for the Opportunity model, but `OppRef` has no `identifiers`
 * property to hang them on.
 */
export interface OppIds {
  systemId?: SystemId;
  otherIds?: Record<string, Identifier>;
  "opp:us:fon"?: Identifier;
  "opp:us:aln"?: Identifier;
}

/**
 * A reference to an opportunity.
 *
 * `OppRef.yaml` specifies only `id` and `title` and closes itself with
 * `unevaluatedProperties: {not: {}}`, so `identifiers` is a forward-looking
 * addition that the current schema rejects. See `Config.opportunityIdentifiers`.
 */
export interface OppRef {
  id: string;
  title: string;
  identifiers?: OppIds;
}

export interface OrgRef {
  id: string;
  name: string;
  identifiers?: OrgIds;
}

export interface OrgRefCollection {
  primary: OrgRef;
  otherOrgs?: Record<string, OrgRef>;
}

/** A reference to an award, for a parent award on an amendment or tranche. */
export interface AwdRef {
  id: string;
  title: string;
  identifiers?: AwdIds;
}

/** A grant award. `createdAt` and `lastModifiedAt` come from `SystemMetadata`. */
export interface AwardBase extends SystemMetadata {
  id: string;
  title: string;
  identifiers?: AwdIds;
  description: string;
  status: AwdStatus;
  funding?: AwdFunding;
  keyDates?: AwdTimeline;
  opportunity?: OppRef;
  funders?: OrgRefCollection;
  recipientOrganizations?: OrgRefCollection;
  parent?: AwdRef;
  source?: string;
}
