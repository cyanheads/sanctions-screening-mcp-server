/**
 * @fileoverview Barrel collecting all prompt definitions into
 * `allPromptDefinitions` for `createApp()`.
 * @module mcp-server/prompts/definitions/index
 */

import { vetCounterpartyPrompt } from './vet-counterparty.prompt.js';

export const allPromptDefinitions = [vetCounterpartyPrompt];

export { vetCounterpartyPrompt };
