# sgg-usaspending-awards

Standalone script that joins Simpler.Grants.gov opportunities to USAspending
assistance awards and emits every match as a [CommonGrants
`AwardBase`](https://commongrants.org/protocol/models/award/) record.

The join key is the federal funding opportunity number. USAspending reports it on
assistance awards as `funding_opportunity.number`, and the Grants.gov plugin
exposes the same value on an opportunity as
`customFields.federalOpportunityNumber`.

## Install

```bash
pnpm install
```

## Configuration

`SGG_API_KEY` is the only value you need to set. Everything else has a default.

| Variable                       | Default                                 | Purpose                                                                                         |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SGG_API_KEY`                  | (none)                                  | Simpler.Grants.gov API key. Required for opportunity lookups.                                   |
| `SGG_BASE_URL`                 | `https://api.simpler.grants.gov`        | Simpler.Grants.gov CommonGrants API.                                                            |
| `SGG_AUTH_HEADER`              | `X-API-Key`                             | Header the API key is sent in. Set to `X-Auth` if the key is rejected.                          |
| `USASPENDING_BASE_URL`         | `https://api.usaspending.gov`           | USAspending API. Needs no key.                                                                  |
| `USASPENDING_AGENCIES`         | 7 agencies (see below)                  | Comma-separated toptier awarding agency names.                                                  |
| `USASPENDING_AWARD_TYPE_CODES` | `02,03,04,05`                           | Assistance award types (block, formula, project, cooperative agreement).                        |
| `USASPENDING_START_DATE`       | `2024-10-01`                            | Start of the action-date window.                                                                |
| `USASPENDING_END_DATE`         | `2025-09-30`                            | End of the action-date window.                                                                  |
| `CANDIDATES_PER_AGENCY`        | `15`                                    | Awards pulled per agency, per sort order (two orders are used).                                 |
| `TARGET_AWARD_COUNT`           | unset                                   | Optional cap on emitted awards. Unset emits every joined award.                                 |
| `CONCURRENCY`                  | `8`                                     | Max in-flight requests to USAspending.                                                          |
| `SGG_CLOSE_DATE_START`         | derived                                 | Override the export window's opening date. Widen it to cover older awards.                      |
| `SGG_CLOSE_DATE_END`           | derived                                 | Override the export window's closing date.                                                      |
| `SGG_AGENCIES`                 | derived                                 | Comma-separated agency codes for the export filter. Set to a single space to disable it.        |
| `SGG_EXPORT_MAX_ITEMS`         | `20000`                                 | Ceiling on opportunities pulled by the export.                                                  |
| `SGG_AUDIT_MISSES`             | `10`                                    | Unmatched numbers to re-check with a direct search. `0` skips the audit.                        |
| `REFRESH_EXPORT`               | unset                                   | Set to `1` to re-export instead of reusing `opportunity-export.json`.                           |
| `OPPORTUNITY_IDENTIFIERS`      | `omit`                                  | `include` to emit `opportunity.identifiers`, which the current schema rejects. See below.       |
| `REFRESH_CANDIDATES`           | unset                                   | Set to `1` to re-sample USAspending instead of reusing stage 1 output.                          |
| `CG_SCHEMA_DIR`                | unset                                   | Local CommonGrants YAML schema directory. Schemas are fetched from commongrants.org when unset. |
| `CG_SCHEMA_BASE_URL`           | `https://commongrants.org/schemas/yaml` | Where to fetch schemas from.                                                                    |
| `OUT_DIR`                      | `./out`                                 | Output directory.                                                                               |

The default agency list is HHS, Education, EPA, Justice, Interior, NSF, and
Energy. DOT, USDA, and HUD are left out because they report `NOT APPLICABLE` for
the opportunity number on effectively every assistance award, so they only
contribute candidates that get filtered back out.

## Run

```bash
export SGG_API_KEY="your-api-key"
pnpm build:awards
```

Three commands are available:

- `pnpm fetch:candidates` runs stage 1 only. It samples USAspending and reports
  how many awards carry a usable opportunity number. No API key needed.
- `pnpm build:awards` runs the full pipeline. It reuses stage 1 output when
  present, resolves opportunity numbers, joins, filters, transforms, and
  validates.
- `pnpm validate:awards` re-validates an existing `out/awards.json`.

Output lands in `out/`:

| File                          | Contents                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `awards.json`                 | The sample of CommonGrants `AwardBase` records.                                                                               |
| `report.json`                 | Run metadata, the stage-by-stage funnel, which opportunity numbers matched, and any validation failures or known schema gaps. |
| `usaspending-candidates.json` | Raw USAspending award records from stage 1.                                                                                   |
| `opportunity-export.json`     | The exported opportunities and the window they were taken with. Reused when the window matches.                               |

Once an export is on disk the pipeline runs without an API key, which is how the
join and transform stages can be exercised offline.

## How the pipeline works

**Stage 1, sample USAspending.** The USAspending search endpoint neither filters
on the opportunity number nor returns it as a field. It only appears on the
per-award detail response. So there is no way to query awards by opportunity
number; the script pages through awards and reads each detail record. Awards
whose opportunity number is missing, or is one of the placeholder values
agencies submit in its place (`NOT APPLICABLE`, `N/A`, and similar), are dropped
here.

**Stage 2, export opportunities.** There is no filter for the opportunity number
here either, so rather than querying once per number, the script exports a batch
of opportunities bounded by close date and agency and indexes them by number. One
paged export replaces N queries, and matching is an exact comparison against
`federalOpportunityNumber` (case-insensitive, trimmed) rather than an
interpretation of search ranking.

The tradeoff is coverage: a number outside the export cannot match. The window is
derived from the awards being joined rather than pinned to the current year,
because the opportunity an award references is older than the award. In one
155-award sample only 26% were signed in 2025, while 99% were signed in 2015 or
later, so a 2025 window would have missed most of the set. Spanning the sample's
own signing dates keeps every candidate eligible.

The export is written to `opportunity-export.json` along with the window it was
taken with, and reused when the window matches. Changing the window rebuilds
automatically rather than answering from the wrong bounds. `REFRESH_EXPORT=1`
forces a re-export.

**Stage 3, join.** Every award whose opportunity number resolved is emitted. One
opportunity can account for dozens of awards, one per recipient, so awards are
ordered round-robin across opportunity numbers rather than left grouped by
program. That makes the output read across the sample instead of in program-sized
blocks. Set `TARGET_AWARD_COUNT` to cap the output; the round-robin ordering
makes the cap a spread of opportunities rather than the first one or two
programs. `report.json` records `awardsDroppedByCap` so a cap is never silent.

**Stage 4, transform and validate.** Each pair maps to an `AwardBase`, and every
emitted record is validated against the published JSON Schema bundle with Ajv
(draft 2020-12, which the bundle's `unevaluatedProperties` assertions need).
Validation failures are reported and written to `report.json`; they do not stop
the run, so you can inspect what failed.

Records are validated after a JSON round-trip rather than in memory. Date-bearing
fields hold `Date` values until `toJSON` converts them to protocol strings, so
validating the in-memory objects would check a shape no consumer ever sees.

## Layout

```
src/
  index.ts            CLI and stage orchestration
  config.ts           environment configuration
  concurrency.ts      bounded parallel map, shared by both stages
  fetch/
    usaspending.ts    award sampling and detail records
    sgg.ts            opportunity lookup and the lookup cache
  transform/
    join.ts           join on the opportunity number, then order and cap
    award.ts          USAspending award plus opportunity to AwardBase
    award-types.ts    AwardBase model types
    dates.ts          protocol date construction
    ids.ts            deterministic UUIDs
    validate.ts       JSON Schema validation
```

### Types and dates

`@common-grants/sdk` 0.6 covers opportunities, so it exports nothing for
`AwardBase`, `AwdIds`, `AwdStatus`, `AwdFunding`, `AwdTimeline`, `OppRef`,
`OrgRef`, or the identifier collections. Those are declared in
`transform/award-types.ts`. Every shared field type comes from the SDK, including
`Money`, `Event`, `SingleDateEvent`, `DateRangeEvent`, and `SystemMetadata`.

The SDK's date-bearing types hold `Date` values, not strings. A plain `Date` would
serialize to a full timestamp, which the schema's `format: date` assertion rejects
on a date-only field, so the SDK returns a `Date` subclass whose `toJSON` emits
the protocol's wire format ([#1024](https://github.com/HHS/simpler-grants-protocol/pull/1024)).
That subclass is internal, so the only way to obtain one is to parse through
`ISODateSchema`. `transform/dates.ts` routes all date construction through the
SDK's parsers for that reason, and passes parsed values along untouched, since
`new Date(value)` or `structuredClone` would lose the behavior.

## Match quality

Precision does not depend on the export. A hit only counts when the
opportunity's own `federalOpportunityNumber` equals the number being looked up,
so there are no fuzzy joins.

Recall is where an export can quietly lose matches: a number outside the window,
an agency filter that excludes sub-agency coding like `HHS-NIH`, an opportunity
with no close date, or the export hitting its item cap. Rather than assume, each
run re-checks a bounded sample of unmatched numbers with a direct search and
reports how many were recoverable:

```
audit: re-checked 10 unmatched number(s) with a direct search, 0 were recoverable
```

Zero recoverable means the misses are genuinely absent from Simpler.Grants.gov
rather than artifacts of the window. Anything above zero means the export is
losing real matches, and the run says so and points at the knobs to widen. A
truncated export is reported the same way, so a capped run never reads as a
complete one.

## Field mapping

Most fields come straight from the USAspending award record.

| `AwardBase` field                                                   | Source                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identifiers.systemId`                                              | The award's UUID, under `awd:usaspending:system`                                                                                                                                                 |
| `identifiers["awd:us:fain"]`                                        | `fain`                                                                                                                                                                                           |
| `identifiers.otherIds["awd:usaspending:generated-unique-award-id"]` | `generated_unique_award_id`                                                                                                                                                                      |
| `identifiers.otherIds["awd:usaspending:uri"]`                       | `uri`                                                                                                                                                                                            |
| `status`                                                            | Derived from the period of performance                                                                                                                                                           |
| `funding.awardedAmount`                                             | `total_obligation`                                                                                                                                                                               |
| `funding.disbursedAmount`                                           | `total_outlay`, falling back to `total_account_outlay`                                                                                                                                           |
| `keyDates.awardDate`                                                | `date_signed`                                                                                                                                                                                    |
| `keyDates.periodOfPerformance`                                      | `period_of_performance.start_date` and `.end_date`                                                                                                                                               |
| `opportunity`                                                       | The matched Simpler.Grants.gov opportunity's id and title                                                                                                                                        |
| `opportunity.identifiers`                                           | `opp:us:fon` from the join key, `opp:us:aln` from `cfda_info[0].cfda_number`, and the opportunity's own UUID under `opp:grants.gov:system`. Emitted only when `OPPORTUNITY_IDENTIFIERS=include`. |
| `funders`                                                           | `awarding_agency`, with the subtier agency and any distinct funding agency under `otherOrgs`                                                                                                     |
| `recipientOrganizations`                                            | `recipient`, with UEI and DUNS identifiers and any parent recipient                                                                                                                              |
| `source`                                                            | `https://www.usaspending.gov/award/{generated_unique_award_id}`                                                                                                                                  |

### Opportunity identifiers

`opp:us:fon` and `opp:us:aln` describe the opportunity rather than the award, so
they belong on `opportunity.identifiers`. `OppRef` does not specify an
`identifiers` property yet and closes itself with `unevaluatedProperties: {not:
{}}`, so emitting them is a deliberate schema violation.

`OPPORTUNITY_IDENTIFIERS` picks which shape to produce. The default, `omit`,
leaves them out and every record validates. `include` emits them and the
validator classifies the resulting `/opportunity/identifiers must NOT be valid`
error as a known gap, reported separately from real failures in both the console
output and `report.json`.

Errors elsewhere are unaffected: a malformed `opportunity.id` or a missing
`opportunity.title` is still a failure. Note that nothing inside the
`identifiers` subtree is checked at all while the schema does not describe it, so
the contents of those identifiers are unvalidated in `include` mode.

### Recipient identity

A recipient's `id` is USAspending's own entity UUID. It comes from
`recipient.recipient_hash`, which is a UUID with a one-character level suffix
appended (`-R` for a recipient, `-P` for a parent, `-C` for a child of a parent).
The bare UUID becomes `id` and `identifiers.systemId`, and the full suffixed
string is preserved under `org:usaspending:recipient-hash`, since the suffix
records the entity level and is the form USAspending's own lookups expect.

```json
"primary": {
  "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8",
  "name": "NYS DEPARTMENT OF HEALTH",
  "identifiers": {
    "systemId": {
      "registry": { "code": "org:usaspending:system" },
      "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8"
    },
    "otherIds": {
      "org:usaspending:recipient-hash": {
        "registry": { "code": "org:usaspending:recipient-hash" },
        "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8-R"
      }
    },
    "org:us:uei": {
      "registry": { "code": "org:us:uei", "url": "..." },
      "id": "F863WQVMZSK7"
    }
  }
}
```

When a record has no recipient hash the UUID falls back to a UUIDv5 derived from
the UEI, or from the name when there is no UEI, and no `systemId` is emitted.
Claiming one for a UUID this script minted would misstate where it came from.

Four required fields have no USAspending equivalent and are derived. Each
derivation is documented at the code that performs it.

- **`id`, and the UUIDs on agency references.** USAspending has no UUID for an
  award or an agency. These are UUIDv5 values derived from source keys (the
  generated unique award id, the toptier and subtier agency codes), so the same
  source record always yields the same UUID and output stays diffable across runs.
  Recipient UUIDs are not derived; see "Recipient identity" above.
- **`title`.** USAspending assistance awards have no title. Award descriptions of
  150 characters or fewer read as titles and are used directly; longer ones fall
  back to the opportunity title plus the FAIN.
- **`status`.** There is no status field on assistance awards. A period of
  performance that has ended maps to `completed`, anything else to `awarded`.
  Terminated awards are not distinguishable in this data, so `cancelled` is never
  emitted.
- **`createdAt` and `lastModifiedAt`.** These describe the record, which
  USAspending does not timestamp. The award's signing date and the transaction's
  last modified date stand in, and `lastModifiedAt` is floored at `createdAt` so
  the pair stays coherent.

## Coverage limits

The opportunity number became a USAspending data element in DAIMS v2.2 (June
2022), and the validation rule requiring it for grants and cooperative agreements
took effect as a warning on October 1, 2023. Two limits follow from how agencies
actually report it.

Population varies by agency. Across a 250-award sample spanning ten agencies,
about 60% carried a real value. HHS, EPA, DOJ, Interior, Education, and NSF
populate it; DOT, USDA, and HUD reported `NOT APPLICABLE` on every award sampled,
and Energy on most.

Not every populated value is a posted opportunity number. HHS in particular
reports two distinct shapes. NIH (`PAR-21-293`), CDC (`CDC-RFA-CK19-1904`), HRSA
(`HRSA-22-116`), AHRQ (`RFA-HS-23-012`), and the
`HHS-YYYY-<OPDIV>-<PROGRAM>-NNNN` format used by ACF, ACL, and IHS all resolve.
Alongside those is an internal tracking convention (`SM00-PAIMI`,
`EP-U3R-24-001`, `IW-SIW-18-001`) that has no grants.gov counterpart. ASPR, OASH,
and CMS use it exclusively. Those numbers cannot resolve, which is why the
resolver treats a miss as a miss instead of trying to normalize toward a match.

For awards where the number is absent or internal, the assistance listing number
plus the awarding sub-agency is a coarser fallback join. This script does not
implement it.
