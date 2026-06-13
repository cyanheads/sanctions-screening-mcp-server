/**
 * @fileoverview Barrel collecting all resource definitions into
 * `allResourceDefinitions` for `createApp()`.
 * @module mcp-server/resources/definitions/index
 */

import { designationResource } from './designation.resource.js';
import { entityResource } from './entity.resource.js';
import { sourcesResource } from './sources.resource.js';

export const allResourceDefinitions = [designationResource, entityResource, sourcesResource];

export { designationResource, entityResource, sourcesResource };
