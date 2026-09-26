// The shape of a harness-reported model id, and nothing else.
//
// Imports NOTHING, on purpose: the browser bundle imports this module directly
// (`@shared/model-id.ts`) to shorten ids for the session list, and `pricing.ts`
// beside it imports `node:crypto`. Keep it that way — a Node import here would
// drag a builtin into the UI.

/** A trailing Claude build stamp: `-20250929`. Anchored, so `-4-5` is safe. */
export const BUILD_SUFFIX = /-\d{8}$/;

/** A context-window variant tag the harness appends: `claude-opus-5-5[1m]`. Same rate. */
export const CONTEXT_TAG = /\[[^\]]*\]$/;

/** Bedrock/Vertex-style vendor prefixes: `us.anthropic.`, `anthropic.`. */
export const VENDOR_PREFIX = /^(?:[a-z]{2,4}\.)?anthropic\./;

/**
 * The bare family-and-version id: drops the context tag, then the vendor
 * prefix, then the build suffix. `us.anthropic.claude-opus-5-5-20260101[1m]`
 * gives `claude-opus-5-5`. An id with none of the three comes back unchanged.
 */
export function stripModelId(raw: string): string {
  return raw.replace(CONTEXT_TAG, '').replace(VENDOR_PREFIX, '').replace(BUILD_SUFFIX, '');
}
