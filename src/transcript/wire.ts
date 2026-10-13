// `wireToolInputs` — what the harness actually SENT, against the `tool_use.input`
// the model asked for. The field is keyed by `tool_use.id`, so one tool call's
// wire form is an index lookup on the assistant line that emitted it.
//
// THE COMPARISON IS STRUCTURAL, AND THAT IS THE WHOLE REASON `sameValue` EXISTS.
// The harness reorders keys: a `Bash` call measured on this corpus carries the
// same four keys and the same four values with `timeout` and `run_in_background`
// swapped. Comparing serialized text would publish that row as a divergence and
// render a second command beside a first one it is identical to.

import { arr, obj } from './accessors.js';

/**
 * The wire form of one tool call, or `undefined` when the line carried none for
 * it. The SAME reference the line holds, on `accessors.ts`'s terms — copying a
 * nested payload per read would be behaviour this module must not have.
 *
 * `obj()` refuses an array and `null`, so a field of the wrong shape answers
 * `undefined` rather than a half-read entry. The lookup is over own keys only:
 * a transcript controls `toolUseId`, and an inherited `toString` must not answer.
 *
 * The `try` is required, not padding: unlike the five accessors this reads
 * PROPERTIES, and a property read is the one thing a live Proxy can trap. That
 * is the case `accessors.property.test.ts` keeps its booby-trapped rows for.
 */
export function wireInputOf(
  raw: unknown,
  toolUseId: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const field = obj(obj(raw, undefined)?.wireToolInputs, undefined);
    if (field === undefined || !Object.hasOwn(field, toolUseId)) return undefined;
    return obj(field[toolUseId], undefined);
  } catch {
    return undefined;
  }
}

/**
 * Whether two harness-supplied values say the same thing — key ORDER excluded.
 *
 * Total, like every reader in this tree: a value that cannot be walked answers
 * `true`, i.e. "nothing to report". That direction is deliberate. The only
 * caller stores a divergence by serializing the wire form, and a value this
 * function could not read is one `JSON.stringify` could not write either — so
 * answering `false` would turn an unreadable payload into a crash inside the
 * projector, where answering `true` degrades to rendering nothing extra.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  try {
    return same(a, b);
  } catch {
    return true;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  const aList = arr(a, undefined);
  const bList = arr(b, undefined);
  if (aList !== undefined || bList !== undefined) {
    if (aList === undefined || bList === undefined || aList.length !== bList.length) return false;
    return aList.every((item, index) => same(item, bList[index]));
  }

  const aObj = obj(a, undefined);
  const bObj = obj(b, undefined);
  if (aObj === undefined || bObj === undefined) return false;

  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  // `hasOwn` before the recursion: without it a key absent from `b` compares
  // `undefined` against a legal `undefined` value and reads as agreement.
  return aKeys.every((key) => Object.hasOwn(bObj, key) && same(aObj[key], bObj[key]));
}
