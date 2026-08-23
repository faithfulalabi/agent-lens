// What the harness sent that agent-lens has never measured. Counting happens at
// classification because that is the only moment an unrecognised field is still
// visible: `classifyLine` reads the fields it knows through the accessors and
// keeps nothing else, so an unmeasured field would vanish one line later with no
// trace. RFC §7 makes drift a product surface (`GET /api/drift`), and that
// endpoint can only report what this counter was shown.
//
// Serialized into `sessions.drift_json`. Keys are SORTED and empty buckets are
// omitted, so the column is a deterministic string: two sessions that drifted
// identically must produce byte-identical rows, or every diff of the column is
// noise and nobody reads it.
//
// Counts, never throws. Drift is a report about a bad transcript, so making it
// fail on one would destroy the reason it exists.

/** Sorted `{name: count}`, or `undefined` when nothing was counted. */
function bucket(counts: ReadonlyMap<string, number>): Record<string, number> | undefined {
  if (counts.size === 0) return undefined;
  // `Object.fromEntries` DEFINES each key, so a literal `__proto__` field in a
  // transcript lands as an own property instead of reassigning the prototype.
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Accumulates one session's drift: unmeasured names, and unanswered calls. */
export class DriftCounter {
  // Maps, not plain objects: a transcript controls these key names, and a `Map`
  // has no prototype chain to walk into.
  private readonly lineTypes = new Map<string, number>();
  private readonly fields = new Map<string, number>();
  private readonly blockTypes = new Map<string, number>();
  /** A scalar, not a bucket: the spec declares `unjoined_tool_uses` a number. */
  private unjoinedToolUses = 0;

  /** Count every top-level key of `line` that `knownFields` does not list. */
  noteLine(line: Readonly<Record<string, unknown>>, knownFields: ReadonlySet<string>): void {
    for (const name of Object.keys(line)) {
      if (!knownFields.has(name)) bump(this.fields, name);
    }
  }

  /** Count one line whose `type` is not a kind agent-lens classifies. */
  noteUnknownType(rawType: string): void {
    bump(this.lineTypes, rawType);
  }

  /**
   * Count one content block whose `type` is not a kind agent-lens classifies.
   *
   * Blocks are counted at PROJECTION rather than at classification: a block is
   * still visible one layer later, and the projector is the first code that
   * knows which blocks a line actually contributed.
   */
  noteUnknownBlock(rawType: string): void {
    bump(this.blockTypes, rawType);
  }

  /**
   * Count one `tool_use` that no `tool_result` in its file ever answered.
   *
   * Counted at the JOIN, for the reason `noteUnknownBlock` counts at projection:
   * that is the first code which knows a call went unanswered. The corpus reads
   * 0 today and read 1 minutes earlier — an in-flight call on the last line of a
   * live session — so both readings are healthy. This is the tripwire for the
   * day a harness change breaks the join, which is otherwise invisible: an
   * unjoined `tool_use` projects as a perfectly plausible `running` row.
   */
  noteUnjoinedToolUse(): void {
    this.unjoinedToolUses += 1;
  }

  /** `sessions.drift_json`: sorted keys, and exactly `'{}'` when clean. */
  serialize(): string {
    return JSON.stringify({
      // Omitted at zero, never emitted as `0`: a clean session must serialize to
      // exactly `'{}'`, and `JSON.stringify` drops an undefined-valued key.
      // `'unjoined' < 'unknown'`, so this key sorts first.
      unjoined_tool_uses: this.unjoinedToolUses === 0 ? undefined : this.unjoinedToolUses,
      unknown_block_types: bucket(this.blockTypes),
      unknown_line_types: bucket(this.lineTypes),
      unknown_top_level_fields: bucket(this.fields),
    });
  }
}
