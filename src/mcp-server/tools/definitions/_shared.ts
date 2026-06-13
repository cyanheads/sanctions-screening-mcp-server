/**
 * @fileoverview Shared constants for the sanctions screening tool surface. The
 * decision-support caveat is load-bearing — it appears in every screening tool's
 * output so a consuming model cannot present a fuzzy hit as a verdict.
 * @module mcp-server/tools/definitions/_shared
 */

/**
 * The decision-support caveat carried in every screening tool's output. States
 * the three load-bearing facts: results are potential matches to verify, a hit
 * is not a finding of fact, and an empty result is not a clearance.
 */
export const SCREENING_CAVEAT =
  'Screening aid, not a compliance determination. Results are potential matches to verify against the official source — a hit is not a finding of fact, and an empty result is not a clearance. Real sanctions compliance is a legal process this server feeds, not one it performs.';
