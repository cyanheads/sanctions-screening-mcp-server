---
name: sanctions-screening-guide
description: Investigate ambiguous counterparties with sanctions_* tools, recover incomplete ownership and screening results, and compare designation evidence without inventing identity or coverage. Use for counterparty due diligence, ownership-chain screening, or reviewing a possible sanctions or export-control match.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Gates

Before attributing an ownership graph to a counterparty, compare the candidate GLEIF record with the identity evidence supplied: jurisdiction, registration authority and number, and addresses. A ranked name match alone does not choose the legal entity. If competing records remain plausible, retain the alternatives and ask for identifying evidence; do not merge their ownership chains into one counterparty.

Before treating a search as exhausted, distinguish an empty page from an empty result set and a finished result set from a bounded candidate search. Drain available pages; where the search reports a lower bound, narrow with another identifying name word or a known jurisdiction. If an entity is absent under the default registration-status filter, broaden the status search before concluding it was not found. An unavailable alternate-name index is a coverage gap, not evidence that a trading or former name has no LEI.

Before using a designation to identify a person or organization, compare the published identifiers and corroborating details. Preserve partial or approximate birth dates; do not pair separate dates and birthplaces unless the record pairs them. Descriptive features can corroborate a candidate but are not searchable identifiers. Keep source-specific labels and units: similar feature names do not establish equivalent measurements. A CSL record with unknown entity type remains unknown; neither its list membership nor an end date establishes its current legal effect. Verify export-control restrictions against the named agency list and Federal Register material, using the published provenance when available.

## Workflows

### Finish an ownership investigation

Drain continuation pages for the same ownership segment before following its boundary records. Assemble nodes by LEI and edges by child LEI, parent LEI, and relationship type; an edge may refer to a node returned on another page. For each omitted branch, start a new trace at the boundary LEI on its specified walk side. Track already-processed LEI/side pairs to avoid cycles and overlapping work. Segment depth restarts at the new root; retain the original segment's node placement rather than treating the new depth as distance from the original counterparty.

If a cursor is rejected after the topology changes, restart that segment and reconcile its assembled records. Continuation does not freeze names, registration status, or screening results. A finished segment is not a complete group: follow remaining boundaries, and retain unresolved Level 1 records and parent-reporting exceptions as explicit gaps. Repeated paging cannot reveal an unreported parent or turn accounting-consolidation relationships into beneficial ownership.

### Expand a capped screening cross-reference

When an entity or ownership node discloses omitted hits, use its legal name and disclosed screened inputs to recover the underlying name and identifier searches. Fetch the GLEIF entity record if the graph node does not contain the required names. Merge resulting designations by source and entry ID, preserving the lists reported for a combined OFAC hit and which input produced it. Standalone name screening can add approximate candidates that the strict cross-reference never counted; do not present those as omitted strict hits. Registration numbers are scoped identity evidence: compare the issuing country and registration context before attributing a matching number to the counterparty.

If a node lacks a Level 1 record, do not screen its LEI placeholder as a company name. Its identifier lookup cannot recover names the mirror does not have. Likewise, screening that did not run cannot be repaired by interpreting an empty hit array; resolve the disclosed readiness gap first.
