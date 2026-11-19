# Mirror lifecycle

The server answers every screen from a local SQLite + FTS5 mirror of eleven OFAC, EU, UK, UN, BIS, and State sanctions and export-control lists and the GLEIF LEI data. The mirror loads out-of-band, never on the request path. Point `SANCTIONS_MIRROR_PATH` at it (default `./data/sanctions.db`).

## Scripts

| Script | Purpose |
|:---|:---|
| `bun run mirror:init` | Full load: all eleven watchlists, the name and identifier indexes, then the GLEIF golden copies (Level 1 with its name index, Level 2, and reporting exceptions), recording each file's `ContentDate` as the GLEIF checkpoint, and last the GLEIF exact-name index that ranks exact names first when strict resolution reaches its bound. Safe to re-run; an interrupted run starts over. Set `SANCTIONS_INIT_SKIP_GLEIF=1` to load the sanctions lists only. |
| `bun run mirror:refresh` | Re-harvest the sanctions lists, removing designations a list's complete document no longer publishes (at most half of a list per run). Then bring GLEIF current from its checkpoint: per dataset, the smallest delta window (`IntraDay` to `LastMonth`) that reaches back to the last file applied, deletions included. Reporting exceptions with no recorded load get their golden copy, and the script (never the cron) builds the GLEIF exact-name index if it is missing. Bounded at 4 hours. Set `SANCTIONS_REFRESH_SKIP_GLEIF=1` to skip GLEIF. |
| `bun run mirror:verify` | Report mirror readiness, per-source record counts, each sanctions list's last harvest and document date (`not recorded` for a list with no recorded harvest), the lists that failed in the last refresh, the GLEIF Level 1 / Level 2 / reporting-exception counts, whether GLEIF alternate names are indexed, whether entity status and successors are loaded, whether the exact-name index is built, and the GLEIF checkpoint. |
| `bun run mirror:seed` | Load a small synthetic fixture for local smoke tests, with no downloads. |

## Scheduled refresh

On HTTP deployments the same refresh runs on `SANCTIONS_REFRESH_CRON` (deltas only, bounded at 4 hours), in a separate process using the serving runtime and its runtime arguments. SQLite WAL keeps committed indexes readable while that child writes, so health and screening requests continue during a rebuild. The serving process reads updated freshness and reporting-exception counts without a restart.

Timeout or shutdown requests cancellation, allows up to 5 seconds for cleanup, then kills and awaits a child that has not exited. Every terminal outcome releases the slot for the next tick. A killed run can leave committed harvest pages behind; the next successful refresh rebuilds their derived indexes before completing.

## When a source fails

The six BIS/State adapters share one keyless CSL bulk download per run, validate the full envelope, and replay temporary per-list spools in bounded pages. `CSL_URL` overrides this mirror download, not a live search API. Other CSL feeds, including Treasury duplicates, are ignored. Temporary files close and are removed on success, failure, and cancellation.

A shared CSL download/parse failure fails all six adapters without pruning their rows; other sources still refresh. Missing expected list metadata fails that list; empty lists cannot authorize removals. Provider `id` values remain verbatim and missing types remain `unknown`. Sync and harvest timestamps report successful local sync, never export time or each agency's publication freshness; each list's `publishedAt` is the date its publisher put on the document, not proof of when the list changed.

**Sanctions lists.** A list that fails to download or arrives truncated keeps its stored rows and removes nothing, while every other list still refreshes and the name and identifier indexes are rebuilt. GLEIF still refreshes after it, and the run then exits non-zero naming each failed list (`ofac_sdn`, `eu`, …). `sanctionsAsOf` advances only on a run in which every list refreshed, and a first `mirror:init` with a failed list leaves the mirror not ready.

Each run's per-list outcomes are written with the index rebuild, and the run reads `in_progress` until that transaction commits. A failed list keeps its earlier `lastHarvestedAt` and `publishedAt`, and `sanctions_list_sources` reports `lastRefresh` with `status: "error"` and `failedSources` naming it. `failedSources` is empty when the run recorded its outcomes and none failed (it was cancelled or ran out of time), and absent when no outcome is recorded for the run (an earlier release made it, it stopped before any list finished, it lost its lease, or its index rebuild failed and the mirror has been reopened since), so which lists failed is unknown. While a refresh runs, `lastRefresh` reads `in_progress` and each list shows the last run that finished it; a refresh that was killed also reads `in_progress` until the next run, since elapsed time would only be a guess. The sync state commits `complete` or `error` before the rebuild: `sanctionsAsOf` advances with it, while `lastRefresh` stays `in_progress` until the per-list rows commit, so a finished status is never read beside the previous run's rows. The one exception is a process that first opens the mirror inside that window: its open rebuilds the name index under the new state, and it reads the finished status before the rows commit.

**GLEIF** advances all at once or not at all. `leiAsOf` and the checkpoint move only after every dataset's covering delta has applied, so an interrupted refresh leaves both where they were, and the next run re-applies from the same point. Two cases apply nothing to GLEIF, leave `leiAsOf` unchanged, and exit non-zero naming `mirror:init`: a checkpoint older than the one-month window, and a mirror with no checkpoint.

## Upgrading

**From 0.5.1 or earlier**, run `bun run mirror:refresh` to load the six newly supported BIS/State CSL lists. Existing source rows and readiness do not mean those new lists have been loaded; inspect their stored counts with `sanctions_list_sources`. Set `SANCTIONS_REFRESH_SKIP_GLEIF=1` to refresh watchlists without the GLEIF leg. No re-init is needed solely for CSL support.

**From 0.3.0 or earlier**, run `mirror:init` once. Those mirrors have no GLEIF checkpoint, and 0.3.0 stored other names without their types and no transliterated names at all, so the GLEIF name index is built from the golden copy `mirror:init` loads, never from the stored rows. Until then:

- traces read unpublished parents as `unknown`
- `sanctions_resolve_entity` searches legal names only, with a notice saying alternate names are not yet indexed; its fuzzy pass blocks on the first three distinctive words of a longer name and says its candidate bound was reached

Every GLEIF write after that keeps the index current.

**From any earlier release**, the mirror upgrades in place on first open:

- the `designation` table gains its `reference_number` and `un_reference_number` columns, each with its index (the first open of a 39,995-designation mirror took 0.3 to 0.4 s for the `un_reference_number` column and index, and 4 to 6 ms thereafter)
- the `source_harvest` and `lei_entity_status_stamp` tables are created empty
- the sanctions name index is rebuilt from the stored designations before the first screen (about 4 s on the 2026-10-03 lists)
- the identifier index is built from the stored records before the first lookup, so `sanctions_screen_identifier` answers from a populated mirror without a re-init
- the GLEIF mirror drops the `lei_entity` status index, which no resolution query reads: about 2 s on the full corpus, freeing ~54 MiB that later writes reuse (the file shrinks only after a manual `VACUUM`)

Then run `mirror:refresh` rather than waiting for the cron. What the earlier release did not read, or read wrongly — reference numbers, the OFAC and UK identifiers beyond identity documents, dates at published precision, OFAC designation dates taken from each file's own lists, `legalBasis`, `features`, UN reference numbers, the UK `DesignationSource` and `SanctionsImposed` features, the UK and UN native-script names, the EU primary name, and each list's harvest time and document date — arrives with the next sanctions refresh, which re-harvests and rewrites every stored designation in full (no list is skipped as unchanged). Until then `sanctions_get_designation` returns `features: []` for every stored record, every `un_reference_number` is NULL so a UN reference number looked up on `uk` or `eu` is `designation_not_found`, UK payloads lack the two feature types, names and EU primary names are those the earlier release stored, `sanctions_list_sources` carries no `lastHarvestedAt` or `publishedAt` and no `lastRefresh` unless the earlier release's last refresh failed or is still running (an `error` then carries no `failedSources`), and a placeholder an earlier release stored as an identifier (the UK's `N/A` passport) still matches in `sanctions_screen_identifier`. Each list fills at its own next successful harvest, and a `uk` record without a `DesignationSource` feature was stored before its list's first harvest by this release (`eu` has no such marker). The same refresh builds the GLEIF exact-name index when its GLEIF leg runs; until then a strict resolution that reaches its 2,000-name bound runs without it and misses an exact name the scan did not reach.

**GLEIF entity status and successors** are not read by an earlier release. A mirror one wrote opens with every record reading `entityStatusLoaded: false` and carrying no `entityStatus` or `successors`, and `sanctions_list_sources` reports `entityStatusLoaded: false`. A GLEIF delta fills the fields on the records it carries, so a record a delta carries reads `entityStatusLoaded: true` while the mirror-wide flag stays false. That flag turns true only after a completed golden-copy load, so `mirror:init` is what loads them for every entity. A record that reads `entityStatusLoaded: false` says nothing about whether the entity has a successor.

## Rollbacks

The identifier index is rebuilt on open whenever a sync it did not follow has changed the stored records, such as one an earlier release ran after a rollback. A GLEIF write by an earlier release leaves the GLEIF name index behind, and resolution returns to legal names and the notice until the next `mirror:init`. The same write turns the mirror-wide `entityStatusLoaded` false until the next `mirror:init`, and each record it rewrites reads `entityStatusLoaded: false` until a load by this release carries it again.

0.6.1 (framework 0.13.22, which skips migrations when the stored version is at or above its target) opens a mirror this release has written, with its version-3 `designation` store, without error and reads designations. It returns each stored payload as it is, so until 0.6.1 itself refreshes, its designation outputs carry what this release stored (the two UK feature types, native-script aliases, the EU primary names) and `sanctions://entity/{lei}` carries `entityStatus` and `successors`; it emits no `unReferenceNumber` and no `entityStatusLoaded`, and the shape of its outputs is unchanged. Its upsert lists only the columns it declares, so a sanctions refresh under 0.6.1 rewrites `payload` as 0.6.1 parses the lists, dropping the two UK feature types, and leaves `un_reference_number` as it found it: stale until this release refreshes again. A row 0.6.1 inserts has it NULL. 0.6.1 never reads or writes `source_harvest` or `lei_entity_status_stamp`, so after such a refresh each list still shows the `lastHarvestedAt` and `publishedAt` of this release's last harvest, older than `sanctionsAsOf`, over records 0.6.1 wrote, and a `uk` record without a `DesignationSource` feature no longer marks a list this release has yet to harvest. The next refresh by this release rewrites every record and date.

## Resource use

Every leg of `mirror:init` and `mirror:refresh` streams in bounded batches, so peak memory tracks the batch size, not the source size.

| Source | Size |
|:---|:---|
| Existing sanctions XML (OFAC SDN/Consolidated, EU, UK, UN) | ~172 MB |
| CSL bulk JSON | Downloaded once per run and spooled by selected list; size varies |
| GLEIF Level 1 golden copy | ~3.4M records (~890 MB compressed); dominates disk use |
| GLEIF name index (~4M names) | ~0.8 GB, part of the Level 1 footprint |
| GLEIF reporting exceptions | ~6.4M rows (~525 MiB on disk) |
