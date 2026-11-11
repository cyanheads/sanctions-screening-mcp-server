/**
 * @fileoverview Advertised input constraints and observable normalization at MCP boundaries.
 * @module mcp-server/normalize-inputs
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { readInputNormalization } from '@/config/server-config.js';

const normalizeInputs = readInputNormalization();
const rewrites = createCounter(
  'mcp.sanctions.input_rewrites',
  'Normalized sanctions inputs',
  '{rewrites}',
);

type LeiSurface = 'sanctions_get_entity' | 'sanctions_trace_ownership' | 'sanctions://entity/{lei}';
type LimitSurface = 'sanctions_screen_name' | 'sanctions_resolve_entity';

/** GLEIF LEI syntax. Check digits are validated only after a lookup miss. */
export const LeiInputSchema = z
  .string()
  .regex(
    normalizeInputs ? /^[A-Za-z0-9]{18}[0-9]{2}$/ : /^[A-Z0-9]{18}[0-9]{2}$/,
    'LEI must be 20 chars: 18 alphanumerics + 2 check digits.',
  );

/** Canonicalize a validated LEI before any lookup, output, or cursor binding. */
export function canonicalLei(lei: string, surface: LeiSurface, ctx: Pick<Context, 'log'>): string {
  const canonical = lei.toUpperCase();
  if (canonical !== lei) {
    const fields = { surface, operation: 'uppercase_lei' };
    ctx.log.info('Canonicalized LEI input to uppercase.', fields);
    rewrites.add(1, fields);
  }
  return canonical;
}

/** A positive page size, with a schema maximum when normalization is disabled. */
export function pageLimitSchema(max: number, fallback: number, description: string) {
  const positive = z.number().int().min(1);
  return (normalizeInputs ? positive : positive.max(max))
    .default(fallback)
    .describe(
      normalizeInputs ? `${description} Values above ${max} are clamped to ${max}.` : description,
    );
}

/** Clamp a validated page size, appending an explanation to any other notices. */
export function clampPageLimit(
  requested: number,
  max: number,
  surface: LimitSurface,
  ctx: Pick<Context, 'log'>,
  notices: string[],
): number {
  if (requested <= max) return requested;
  const fields = { surface, operation: 'clamp_limit' };
  ctx.log.info('Clamped page limit.', { ...fields, requested, effective: max });
  rewrites.add(1, fields);
  notices.push(`Requested limit ${requested} clamped to ${max} records.`);
  return max;
}
