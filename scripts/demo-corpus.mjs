// The demo corpus the README's screenshots are taken against. `npm run demo:capture`.
//
// ★ EVERY STRING IN THIS FILE IS INVENTED. No real path, no real project name, no
// real session title, no real prompt. That matters because nothing automated can
// ever check it: `fixture-residue.test.ts` reads text under two roots and a
// committed PNG is not text. This file is deliberately the ENTIRE reviewable
// surface for that promise — one generator a human can read top to bottom, rather
// than a tree of transcripts nobody will open.
//
// The fictional project is `mosaic`, an internal photo-tiling service. Its cwd is
// `/Users/dev/mosaic` and its slug is `-Users-dev-mosaic`. The name carries NO
// HYPHEN on purpose: `decodeProjectDir` splits a slug on `-`, so a hyphenated
// project name would decode to a path that disagrees with the `cwd` the projected
// header reads off the envelope, and the screenshot would show two truths.
//
// ★ THE LINE SHAPES ARE BUILT HERE, NOT IMPORTED. `src/db/__tests__/fixtures`
// has `humanLine`/`toolCallLine`/`toolResultLine`, but they pin `cwd` to a
// different project and carry no title, no prose and no reasoning. Adding those
// three shapes under `src/` would cost `one-door.test.ts` suppressions for the
// harness field names and could re-key the ordinals its manifest pins. In
// `scripts/` they cost nothing: the one-door scan reads `src/**/*.ts` only. The
// directory writers ARE imported — they are the production-adjacent half, and a
// copy of them here would be the drift this comment exists to prevent.
//
// ★ REASONING BLOCKS ARE ELIDED, AND THAT IS NOT LAZINESS. A `thinking` block
// whose `thinking` field is empty projects as the marker
// `reasoning not recorded (signature only)`, which is what the harness actually
// writes and therefore what the product actually shows. The render gate's thread
// probe asserts one marker per reasoning event and zero empty rows, so a corpus
// with invented reasoning PROSE in it would photograph a screen no reader will
// ever see and redden a gate at the same time.
//
// ★ THE CORPUS MUST BE DRIFT-FREE. `report.ts` scores the drift probe on
// `before === 0`: the alarm has to be silent before the gate appends its own
// unknown record. So every line type here is one `src/transcript/line.ts` names,
// every top-level field is in that type's measured inventory, every `tool_use`
// has a `tool_result` answering it in the same file, and the one spilled result
// points at a file that exists.
//
// ★ THE NEWEST SESSION IS THE RICHEST, because `openFirstSession` opens the first
// row and every later shot is taken inside it. Its LAST turn carries the work:
// `initialExpanded` opens the latest turn and nothing else, and the sub-agent
// probe scrolls but never opens a turn — an `Agent` row in an earlier turn would
// be invisible to it.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeSession, writeSidecar, writeToolResult } from '../src/corpus/__tests__/fixtures.js';

/** The fictional checkout every session in the corpus ran in. */
export const DEMO_CWD = '/Users/dev/mosaic';

/** Its transcript-directory slug. `decodeProjectDir(DEMO_SLUG) === DEMO_CWD`. */
export const DEMO_SLUG = '-Users-dev-mosaic';

const HARNESS_VERSION = '2.1.212';
const BRANCH = 'main';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ----------------------------------------------------------- line shapes --- */

let serial = 0;

/** Deterministic within a run, distinct across lines, and shaped like a uuid. */
function nextUuid() {
  serial += 1;
  const tail = String(serial).padStart(8, '0');
  return `${tail}-4a1c-4b2d-8e3f-${tail}c0de`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** The fields every projected line carries. Nothing outside the measured set. */
function envelope(sessionId, fields) {
  return {
    uuid: nextUuid(),
    parentUuid: null,
    sessionId,
    version: HARNESS_VERSION,
    cwd: DEMO_CWD,
    gitBranch: BRANCH,
    ...fields,
  };
}

/**
 * The session's title. `type: 'ai-title'` carries exactly three fields, and the
 * fold takes the LAST occurrence, so one per session is the whole story.
 */
function titleLine(sessionId, title) {
  return { type: 'ai-title', aiTitle: title, sessionId };
}

/**
 * A person's prompt. `origin.kind` is what marks it human, and `promptId` is what
 * segments one turn from the next — one id per turn, never shared.
 */
function humanLine(sessionId, text, at, turn) {
  return envelope(sessionId, {
    type: 'user',
    timestamp: iso(at),
    promptId: `${sessionId.slice(0, 8)}-turn-${turn}`,
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
  });
}

/** An assistant reply in prose. */
function textLine(sessionId, text, at, model, usage) {
  return envelope(sessionId, {
    type: 'assistant',
    timestamp: iso(at),
    requestId: `req-${nextUuid().slice(0, 12)}`,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

/**
 * A reasoning block with no recorded prose — see the header. The signature is a
 * block field, and drift counts unknown block TYPES, so this adds none.
 */
function thinkingLine(sessionId, at, model) {
  return envelope(sessionId, {
    type: 'assistant',
    timestamp: iso(at),
    requestId: `req-${nextUuid().slice(0, 12)}`,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'thinking', thinking: '', signature: `sig-${nextUuid().slice(0, 8)}` }],
    },
  });
}

/** An assistant line carrying one `tool_use` block, and the usage it billed. */
function callLine(sessionId, callId, name, input, at, model, usage) {
  return envelope(sessionId, {
    type: 'assistant',
    timestamp: iso(at),
    requestId: `req-${nextUuid().slice(0, 12)}`,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: callId, name, input }],
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

/** The answering half. Every `tool_use` above gets exactly one of these. */
function resultLine(sessionId, callId, content, at) {
  return envelope(sessionId, {
    type: 'user',
    timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content }] },
  });
}

/**
 * The harness's spill marker, at index 0 exactly as it writes it. The resolver
 * re-anchors on the BASENAME, so the directory named here is cosmetic and the
 * file `writeToolResult` plants is what makes the pointer resolve.
 */
function spillMarker(name, kb) {
  return (
    '<persisted-output>\n' +
    `Output too large (${kb}KB). Full output saved to: ${DEMO_CWD}/.mosaic/tool-results/${name}.txt\n` +
    'tail'
  );
}

/* ---------------------------------------------------------------- usage --- */

/**
 * Token counts, scaled so the Tokens and Cost columns read plausibly rather than
 * uniformly. `PRICING_TABLE` prices every model named in this file, so no row
 * falls back to a blank cost cell.
 */
function usage(scale) {
  return {
    input_tokens: 420 * scale,
    output_tokens: 180 * scale,
    cache_read_input_tokens: 9_400 * scale,
    cache_creation_input_tokens: 2_100 * scale,
  };
}

/* ------------------------------------------------------- the rich session --- */

const RICH_ID = 'c1d4e7a2-9b35-4f61-8c08-7ad2e9f41b60';
const RICH_AGENT_CALL = 'toolu_01MosaicWebhookCallSites';
const RICH_SPILL = 'qa-report';

/**
 * Seven turns in the fictional `mosaic` repo, ending in the turn the gate
 * photographs. The word `idempotency` recurs across its events on purpose:
 * `pickSearchTerm` scores a term on how many EVENTS carry it, so a word with
 * breadth is what gives the search shot a query and a hit instead of a null.
 */
function richSession(endedAt) {
  const t = (minutes) => endedAt - 34 * MINUTE + minutes * MINUTE;
  const model = 'claude-opus-5';
  const lines = [titleLine(RICH_ID, 'Make the payments webhook idempotent')];

  lines.push(
    humanLine(
      RICH_ID,
      'Stripe retried a webhook last night and we charged the same gallery order twice. ' +
        'I want the handler to be idempotent before we touch anything else. Start by ' +
        'showing me how the handler is wired up today.',
      t(0),
      1,
    ),
    thinkingLine(RICH_ID, t(1), model),
    textLine(
      RICH_ID,
      'A duplicate delivery is the normal case for a webhook, so the handler needs an ' +
        'idempotency record rather than a guard against retries. Let me read the route first.',
      t(1) + 20 * SECOND,
      model,
      usage(3),
    ),
    callLine(
      RICH_ID,
      'toolu_01MosaicReadWebhookRoute',
      'Read',
      { file_path: 'services/payments/webhook_route.py' },
      t(2),
      model,
      usage(2),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicReadWebhookRoute',
      [
        '     1\tfrom mosaic.payments import orders, signatures',
        '     2\t',
        '     3\t@router.post("/webhooks/payments")',
        '     4\tasync def receive(request: Request) -> Response:',
        '     5\t    body = await request.body()',
        '     6\t    event = signatures.verify(body, request.headers["X-Signature"])',
        '     7\t    orders.apply(event)',
        '     8\t    return Response(status_code=204)',
      ].join('\n'),
      t(2) + 4 * SECOND,
    ),
  );

  lines.push(
    humanLine(
      RICH_ID,
      'Right, `orders.apply` runs unconditionally. Find every place that writes an order ' +
        'so I know how wide the change is.',
      t(5),
      2,
    ),
    callLine(
      RICH_ID,
      'toolu_01MosaicGrepOrderWrites',
      'Grep',
      {
        pattern: 'orders\\.(apply|settle|refund)',
        path: 'services/payments',
        output_mode: 'content',
      },
      t(6),
      model,
      usage(2),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicGrepOrderWrites',
      [
        'services/payments/webhook_route.py:7:    orders.apply(event)',
        'services/payments/reconcile_job.py:41:    orders.settle(batch, at=cutoff)',
        'services/payments/reconcile_job.py:58:    orders.refund(order, reason="duplicate")',
        'services/payments/admin_actions.py:19:    orders.refund(order, reason=form.reason)',
        '4 matches in 3 files',
      ].join('\n'),
      t(6) + 2 * SECOND,
    ),
  );

  lines.push(
    humanLine(
      RICH_ID,
      'Three files is manageable. Write the migration that gives us somewhere to store an ' +
        'idempotency key.',
      t(9),
      3,
    ),
    thinkingLine(RICH_ID, t(10), model),
    callLine(
      RICH_ID,
      'toolu_01MosaicWriteMigration',
      'Write',
      {
        file_path: 'services/payments/migrations/0042_order_idempotency_key.sql',
        content:
          'ALTER TABLE orders ADD COLUMN idempotency_key TEXT;\n' +
          'CREATE UNIQUE INDEX orders_idempotency_key ON orders (idempotency_key)\n' +
          '  WHERE idempotency_key IS NOT NULL;\n',
      },
      t(10) + 30 * SECOND,
      model,
      usage(4),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicWriteMigration',
      'Wrote services/payments/migrations/0042_order_idempotency_key.sql (3 lines).',
      t(11),
    ),
  );

  lines.push(
    humanLine(RICH_ID, 'Now make the handler claim that key before it applies anything.', t(14), 4),
    callLine(
      RICH_ID,
      'toolu_01MosaicEditHandler',
      'Edit',
      {
        file_path: 'services/payments/webhook_route.py',
        old_string: '    orders.apply(event)',
        new_string:
          '    if not orders.claim_idempotency_key(event.id):\n' +
          '        return Response(status_code=204)\n' +
          '    orders.apply(event)',
      },
      t(15),
      model,
      usage(3),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicEditHandler',
      'Applied 1 edit to services/payments/webhook_route.py.',
      t(15) + 3 * SECOND,
    ),
  );

  lines.push(
    humanLine(
      RICH_ID,
      'The reconcile job settles batches on its own schedule. Does it need the same ' +
        'idempotency key, or is the unique index enough there?',
      t(18),
      5,
    ),
    textLine(
      RICH_ID,
      'The index is enough for `settle`, because it writes one row per order and a second ' +
        'pass would collide on the key. `refund` is the one that still needs a guard: it ' +
        'writes a new row rather than updating the claimed one.',
      t(19),
      model,
      usage(2),
    ),
  );

  lines.push(
    humanLine(
      RICH_ID,
      'Good. Check the refund path and tell me whether the admin action shares it.',
      t(22),
      6,
    ),
    callLine(
      RICH_ID,
      'toolu_01MosaicReadRefundPath',
      'Read',
      { file_path: 'services/payments/reconcile_job.py', offset: 50, limit: 12 },
      t(23),
      model,
      usage(2),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicReadRefundPath',
      [
        '    50\tdef refund_duplicates(batch: Batch) -> int:',
        '    51\t    refunded = 0',
        '    52\t    for order in batch.duplicates():',
        '    53\t        # admin_actions.refund_order calls straight into this helper',
        '    54\t        orders.refund(order, reason="duplicate")',
        '    55\t        refunded += 1',
        '    56\t    return refunded',
      ].join('\n'),
      t(23) + 3 * SECOND,
    ),
  );

  // The last turn. `initialExpanded` opens it and nothing else, so this is the
  // only turn whose rows are on screen when the session opens — which is why the
  // multi-line tool call, the sub-agent and the spill all live here.
  lines.push(
    humanLine(
      RICH_ID,
      'Last thing: confirm the idempotency key is actually read on every write path, then ' +
        'run the payments suite.',
      t(27),
      7,
    ),
    thinkingLine(RICH_ID, t(28), model),
    callLine(
      RICH_ID,
      'toolu_01MosaicGrepClaimSites',
      'Grep',
      { pattern: 'claim_idempotency_key', path: 'services/payments', output_mode: 'content' },
      t(28) + 20 * SECOND,
      model,
      usage(2),
    ),
    resultLine(
      RICH_ID,
      'toolu_01MosaicGrepClaimSites',
      [
        'services/payments/orders.py:88:def claim_idempotency_key(event_id: str) -> bool:',
        'services/payments/orders.py:94:    """Insert the idempotency key, or report that it was already taken."""',
        'services/payments/webhook_route.py:7:    if not orders.claim_idempotency_key(event.id):',
        'services/payments/reconcile_job.py:58:    if orders.claim_idempotency_key(order.refund_id):',
        '4 matches in 3 files',
      ].join('\n'),
      t(28) + 24 * SECOND,
    ),
    callLine(
      RICH_ID,
      RICH_AGENT_CALL,
      'Agent',
      {
        description: 'Audit idempotency key call sites',
        prompt:
          'Read every module under services/payments and report each write path that ' +
          'reaches the orders table without first claiming an idempotency key.',
        subagent_type: 'Explore',
      },
      t(30),
      model,
      usage(5),
    ),
    resultLine(
      RICH_ID,
      RICH_AGENT_CALL,
      'Three write paths reach the orders table. Two now claim an idempotency key first ' +
        '(webhook_route.receive, reconcile_job.refund_duplicates). admin_actions.refund_order ' +
        'delegates to reconcile_job, so it inherits the guard rather than needing its own.',
      t(31),
    ),
    callLine(
      RICH_ID,
      'toolu_01MosaicRunQaReport',
      'Bash',
      { command: 'bin/qa --quick', description: 'Verify the order write paths' },
      t(32),
      model,
      usage(2),
    ),
    resultLine(RICH_ID, 'toolu_01MosaicRunQaReport', spillMarker(RICH_SPILL, 61.2), t(33)),
    textLine(
      RICH_ID,
      'The suite is green: 214 passed. The handler now claims an idempotency key before it ' +
        'applies an event, the refund helper does the same, and the unique index makes a ' +
        'second claim fail closed rather than duplicating the order.',
      t(34),
      model,
      usage(3),
    ),
  );

  return lines;
}

/**
 * What the spilled run wrote, in full. Invented, like everything else.
 *
 * ★ IT DELIBERATELY SHARES NO WORD WITH THE CALL THAT PRODUCED IT. Search unions
 * `events_fts` over an event's own payload with `spill_fts` over its spilled body,
 * and the results list keys a row on the event id — so one event matching the
 * query on BOTH halves yields two rows under one key, which the browser reports as
 * a console error and the gate scores as a failure. The command, its description
 * and the spill marker contribute `quick`, `verify`, `order`, `write`, `paths`,
 * `persisted`, `output`, `large`, `saved`, `users`, `mosaic`, `results` and
 * `report`; nothing below repeats any of them. Underscores help: `\b` does not
 * split `test_webhook_route`, so those segments are not candidate terms at all.
 */
const RICH_SPILL_BODY = [
  '============================= test session starts ==============================',
  'collected 214 items',
  '',
  'tests/test_webhook_route.py ......................... [ 11%]',
  'tests/test_claim_key.py ............................. [ 29%]',
  'tests/test_reconcile_job.py .......................... [ 48%]',
  'tests/test_admin_actions.py ...................... [ 61%]',
  'tests/test_signatures.py .......................... [ 78%]',
  'tests/test_orders.py ............................... [100%]',
  '',
  '============================= 214 passed in 18.44s =============================',
].join('\n');

/** The sub-agent's own transcript, linked back by `toolUseId`. */
function richSidecar(endedAt) {
  const id = 'f2a7c019-6d48-4e35-9b71-20c6ea53d8f4';
  const t = (seconds) => endedAt - 4 * MINUTE + seconds * SECOND;
  const model = 'claude-haiku-4-5';
  return [
    titleLine(id, 'Audit idempotency key call sites'),
    textLine(
      id,
      'Looking for every module that writes to the orders table, then checking which of ' +
        'them claims an idempotency key first.',
      t(0),
      model,
      usage(1),
    ),
    callLine(
      id,
      'toolu_01MosaicSidecarGlob',
      'Glob',
      { pattern: 'services/payments/**/*.py' },
      t(8),
      model,
      usage(1),
    ),
    resultLine(
      id,
      'toolu_01MosaicSidecarGlob',
      [
        'services/payments/orders.py',
        'services/payments/webhook_route.py',
        'services/payments/reconcile_job.py',
        'services/payments/admin_actions.py',
        'services/payments/signatures.py',
      ].join('\n'),
      t(10),
    ),
    callLine(
      id,
      'toolu_01MosaicSidecarGrep',
      'Grep',
      { pattern: 'INSERT INTO orders', path: 'services/payments', output_mode: 'content' },
      t(16),
      model,
      usage(1),
    ),
    resultLine(
      id,
      'toolu_01MosaicSidecarGrep',
      [
        'services/payments/orders.py:71:    INSERT INTO orders (id, gallery_id, amount_cents)',
        'services/payments/orders.py:89:    INSERT INTO orders (id, idempotency_key) ON CONFLICT DO NOTHING',
        '2 matches in 1 file',
      ].join('\n'),
      t(18),
    ),
    textLine(
      id,
      'Three write paths reach the orders table: webhook_route.receive, ' +
        'reconcile_job.refund_duplicates and admin_actions.refund_order. The first two claim ' +
        'an idempotency key before writing. The third delegates to reconcile_job, so it is ' +
        'covered by that guard rather than by one of its own.',
      t(24),
      model,
      usage(2),
    ),
  ];
}

/* ----------------------------------------------------- the other sessions --- */

/**
 * A plain session: a title, two or three turns of invented prose, and one tool
 * call per turn. Short on purpose — these rows exist to fill the session LIST
 * with believable titles, models and costs, and only the first row is ever opened.
 */
function plainSession(spec) {
  const { id, title, model, scale, endedAt, turns } = spec;
  const span = Math.max(turns.length * 4 * MINUTE, 6 * MINUTE);
  const t = (index, offset) => endedAt - span + index * 4 * MINUTE + offset;
  const lines = [titleLine(id, title)];

  turns.forEach((turn, index) => {
    const callId = `toolu_01Mosaic${id.slice(0, 8)}${index}`;
    lines.push(humanLine(id, turn.prompt, t(index, 0), index + 1));
    if (turn.reasoned === true) lines.push(thinkingLine(id, t(index, 20 * SECOND), model));
    lines.push(
      callLine(id, callId, turn.tool, turn.input, t(index, 40 * SECOND), model, usage(scale)),
      resultLine(id, callId, turn.output, t(index, 55 * SECOND)),
    );
    if (turn.reply !== undefined) {
      lines.push(textLine(id, turn.reply, t(index, 70 * SECOND), model, usage(scale)));
    }
  });

  return lines;
}

/** Eight supporting sessions, newest first. Every string invented. */
function plainSpecs(now) {
  return [
    {
      id: '7e51b8c3-0a42-4d9f-8b16-4c7395ad2e11',
      title: 'Trace the duplicate charge in the refund queue',
      model: 'claude-sonnet-5',
      scale: 3,
      endedAt: now - 1 * HOUR - 50 * MINUTE,
      turns: [
        {
          prompt:
            'The refund queue drained twice on Tuesday and two galleries got credited for ' +
            'the same order. Find out which worker picked the job up second.',
          tool: 'Grep',
          input: { pattern: 'refund_queue.claim', path: 'services/payments' },
          output:
            'services/payments/refund_queue.py:33:    job = refund_queue.claim(worker_id)\n1 match in 1 file',
          reasoned: true,
          reply:
            'The claim is advisory, not exclusive — two workers can hold the same job if ' +
            'the first one is slow to acknowledge it.',
        },
        {
          prompt: 'Show me the acknowledgement path.',
          tool: 'Read',
          input: { file_path: 'services/payments/refund_queue.py', offset: 28, limit: 14 },
          output:
            '    28\tdef claim(worker_id: str) -> Job | None:\n' +
            '    29\t    row = db.fetch_one(NEXT_UNCLAIMED_SQL)\n' +
            '    30\t    if row is None:\n' +
            '    31\t        return None\n' +
            '    32\t    # No lease is taken here, which is the defect.\n' +
            '    33\t    job = refund_queue.claim(worker_id)\n' +
            '    34\t    return job',
        },
      ],
    },
    {
      id: '2b9fa045-7c81-4e26-9f53-18ad60b7c492',
      title: 'Cache the tile renderer behind a content hash',
      model: 'claude-sonnet-5',
      scale: 4,
      endedAt: now - 4 * HOUR - 40 * MINUTE,
      turns: [
        {
          prompt:
            'Rendering the same gallery tile twice costs us the full pipeline each time. ' +
            'Key the renderer cache on a hash of the source bytes plus the output size.',
          tool: 'Read',
          input: { file_path: 'services/tiles/renderer.py' },
          output:
            '     1\tfrom mosaic.tiles import pipeline\n' +
            '     2\t\n' +
            '     3\tdef render(source: Source, size: Size) -> Tile:\n' +
            '     4\t    return pipeline.run(source, size)',
          reasoned: true,
        },
        {
          prompt: 'Add the cache lookup around that call.',
          tool: 'Edit',
          input: {
            file_path: 'services/tiles/renderer.py',
            old_string: '    return pipeline.run(source, size)',
            new_string:
              '    key = content_hash(source.bytes, size)\n' +
              '    cached = tile_cache.get(key)\n' +
              '    if cached is not None:\n' +
              '        return cached\n' +
              '    return tile_cache.put(key, pipeline.run(source, size))',
          },
          output: 'Applied 1 edit to services/tiles/renderer.py.',
          reply:
            'The cache is keyed on the source bytes rather than the source id, so a re-upload ' +
            'under the same id renders again instead of serving the previous tile.',
        },
      ],
    },
    {
      id: '9c3d7e18-5f60-4a74-8d29-6b14ea82f035',
      title: 'Make the gallery grid keyboard navigable',
      model: 'claude-haiku-4-5',
      scale: 2,
      endedAt: now - 9 * HOUR - 15 * MINUTE,
      turns: [
        {
          prompt:
            'The gallery grid can only be driven with a mouse. Arrow keys should move the ' +
            'selection and Enter should open the tile.',
          tool: 'Read',
          input: { file_path: 'web/src/components/GalleryGrid.tsx' },
          output:
            '    14\t    <div role="grid" className="grid grid-cols-4 gap-2">\n' +
            '    15\t      {tiles.map((tile) => (\n' +
            '    16\t        <GalleryTile key={tile.id} tile={tile} onClick={open} />\n' +
            '    17\t      ))}\n' +
            '    18\t    </div>',
        },
        {
          prompt: 'Wire the key handler onto the grid rather than onto each tile.',
          tool: 'Edit',
          input: {
            file_path: 'web/src/components/GalleryGrid.tsx',
            old_string: '<div role="grid"',
            new_string: '<div role="grid" tabIndex={0} onKeyDown={moveSelection}',
          },
          output: 'Applied 1 edit to web/src/components/GalleryGrid.tsx.',
          reply:
            'One handler on the grid keeps the tab order to a single stop, which is what a ' +
            'grid role is supposed to do.',
        },
      ],
    },
    {
      id: '4f80ab27-3e95-4c13-8a6d-9d2571fc0b83',
      title: 'Split the uploader into resumable chunks',
      model: 'claude-opus-5',
      scale: 6,
      endedAt: now - 1 * DAY - 3 * HOUR,
      turns: [
        {
          prompt:
            'A 400 MB album upload fails on a dropped connection and starts over. Break the ' +
            'upload into chunks the client can resume.',
          tool: 'Read',
          input: { file_path: 'services/uploads/receiver.py' },
          output:
            '     8\tasync def receive(stream: Stream) -> Upload:\n' +
            '     9\t    blob = await stream.read_all()\n' +
            '    10\t    return store.put(blob)',
          reasoned: true,
        },
        {
          prompt: 'Chunk at 8 MB and record each part as it lands.',
          tool: 'Write',
          input: {
            file_path: 'services/uploads/chunks.py',
            content:
              'CHUNK_BYTES = 8 * 1024 * 1024\n\n' +
              'async def receive_chunk(upload_id: str, index: int, body: bytes) -> None:\n' +
              '    store.put_part(upload_id, index, body)\n' +
              '    manifest.mark_received(upload_id, index)\n',
          },
          output: 'Wrote services/uploads/chunks.py (5 lines).',
        },
        {
          prompt: 'What does the client need to ask for to resume?',
          tool: 'Read',
          input: { file_path: 'services/uploads/manifest.py', offset: 20, limit: 8 },
          output:
            '    20\tdef missing_parts(upload_id: str) -> list[int]:\n' +
            '    21\t    received = store.received_indexes(upload_id)\n' +
            '    22\t    total = manifest.part_count(upload_id)\n' +
            '    23\t    return [index for index in range(total) if index not in received]',
          reply:
            'One call to `missing_parts` is enough: the client asks which indexes are absent ' +
            'and re-sends only those.',
        },
      ],
    },
    {
      id: '6a17cd54-8b23-4f09-9e81-3c56da70e9b2',
      title: 'Backfill thumbnail dimensions for old uploads',
      model: 'claude-sonnet-5',
      scale: 3,
      endedAt: now - 2 * DAY - 1 * HOUR,
      turns: [
        {
          prompt:
            'Albums uploaded before March have no stored thumbnail dimensions, so the grid ' +
            'reflows while it loads. Backfill them without re-rendering every tile.',
          tool: 'Bash',
          input: {
            command: 'psql -c "select count(*) from thumbnails where width is null"',
            description: 'Count thumbnails missing dimensions',
          },
          output: ' count \n-------\n  18432\n(1 row)',
          reasoned: true,
        },
        {
          prompt: 'Read the dimensions out of the stored bytes instead of re-rendering.',
          tool: 'Write',
          input: {
            file_path: 'services/tiles/backfill_dimensions.py',
            content:
              'for row in thumbnails.where(width=None).batched(500):\n' +
              '    width, height = probe_dimensions(store.head(row.blob_id))\n' +
              '    thumbnails.update(row.id, width=width, height=height)\n',
          },
          output: 'Wrote services/tiles/backfill_dimensions.py (3 lines).',
          reply:
            'Reading the header is enough — the dimensions are in the first few hundred bytes, ' +
            'so the backfill never pulls a whole thumbnail out of storage.',
        },
      ],
    },
    {
      id: '8d26ef73-1a49-4b85-9c70-5e38ba91d7c6',
      title: 'Replace the polling status endpoint with a stream',
      model: 'claude-sonnet-4-6',
      scale: 2,
      endedAt: now - 3 * DAY - 6 * HOUR,
      turns: [
        {
          prompt:
            'The album page polls the upload status endpoint every second and most answers ' +
            'are unchanged. Stream the status instead.',
          tool: 'Grep',
          input: { pattern: 'setInterval', path: 'web/src' },
          output:
            'web/src/hooks/useUploadStatus.ts:12:  const timer = setInterval(refetch, 1000);\n1 match in 1 file',
        },
        {
          prompt: 'Swap the interval for an event stream on the same route.',
          tool: 'Edit',
          input: {
            file_path: 'web/src/hooks/useUploadStatus.ts',
            old_string: '  const timer = setInterval(refetch, 1000);',
            new_string: '  const stream = new EventSource(`/api/uploads/${id}/status`);',
          },
          output: 'Applied 1 edit to web/src/hooks/useUploadStatus.ts.',
          reply: 'The route keeps its path, so nothing else on the album page has to change.',
        },
      ],
    },
    {
      id: '3e94bf08-6d57-4a21-8f63-7b25ce10a948',
      title: 'Shorten the signed URL expiry window',
      model: 'claude-haiku-4-5',
      scale: 2,
      endedAt: now - 4 * DAY - 12 * HOUR,
      turns: [
        {
          prompt:
            'Signed gallery URLs are valid for seven days, which is longer than any share ' +
            'link needs. Bring it down and make the window configurable.',
          tool: 'Grep',
          input: { pattern: 'SIGNED_URL_TTL', path: 'services' },
          output:
            'services/sharing/signing.py:6:SIGNED_URL_TTL = timedelta(days=7)\n1 match in 1 file',
        },
        {
          prompt: 'Make it fifteen minutes by default and read it from the environment.',
          tool: 'Edit',
          input: {
            file_path: 'services/sharing/signing.py',
            old_string: 'SIGNED_URL_TTL = timedelta(days=7)',
            new_string:
              'SIGNED_URL_TTL = timedelta(minutes=int(env("MOSAIC_SIGNED_URL_MINUTES", "15")))',
          },
          output: 'Applied 1 edit to services/sharing/signing.py.',
          reply:
            'Fifteen minutes covers a share link being opened, and the environment override ' +
            'means a longer window is a deployment decision rather than a code change.',
        },
      ],
    },
    {
      id: '5b73da91-2c68-4e40-9a15-8f41cb27e063',
      title: 'Pin colour profile conversion to sRGB',
      model: 'claude-opus-5',
      scale: 4,
      endedAt: now - 6 * DAY,
      turns: [
        {
          prompt:
            'Tiles rendered from Display P3 originals look washed out in the grid. Convert ' +
            'to sRGB once, at ingest, rather than per tile.',
          tool: 'Read',
          input: { file_path: 'services/tiles/pipeline.py', offset: 30, limit: 10 },
          output:
            '    30\tdef run(source: Source, size: Size) -> Tile:\n' +
            '    31\t    image = decode(source.bytes)\n' +
            '    32\t    # No profile conversion happens anywhere in this path.\n' +
            '    33\t    return encode(resize(image, size))',
          reasoned: true,
        },
        {
          prompt: 'Convert at ingest and record which profile the original carried.',
          tool: 'Edit',
          input: {
            file_path: 'services/uploads/ingest.py',
            old_string: '    image = decode(blob)',
            new_string:
              '    image = decode(blob)\n' +
              '    uploads.record_profile(upload_id, image.profile_name)\n' +
              '    image = image.convert_to("sRGB")',
          },
          output: 'Applied 1 edit to services/uploads/ingest.py.',
          reply:
            'Converting at ingest means every tile derives from one colour space, and the ' +
            'recorded profile name keeps the original recoverable.',
        },
      ],
    },
  ];
}

/* ----------------------------------------------------------------- plant --- */

/**
 * Write the whole corpus under `<dataDir>/archive/<slug>/`, which is the only
 * directory the dev server's sweep indexes.
 *
 * Returns a short manifest the capture script prints, so a run says what it
 * planted rather than leaving the reader to infer it from the screenshots.
 */
export function plantDemoCorpus(dataDir, now = Date.now()) {
  const archiveRoot = join(dataDir, 'archive');
  const sandbox = { archiveRoot };
  mkdirSync(join(archiveRoot, DEMO_SLUG), { recursive: true });

  const newest = now - 10 * MINUTE;
  writeSession(sandbox, RICH_ID, richSession(newest), DEMO_SLUG);
  writeSidecar(
    sandbox,
    RICH_ID,
    'idempotency-audit',
    richSidecar(newest),
    { toolUseId: RICH_AGENT_CALL },
    DEMO_SLUG,
  );
  writeToolResult(sandbox, RICH_ID, RICH_SPILL, RICH_SPILL_BODY, DEMO_SLUG);

  const specs = plainSpecs(now);
  for (const spec of specs) {
    writeSession(sandbox, spec.id, plainSession(spec), DEMO_SLUG);
  }

  return {
    archiveRoot,
    slug: DEMO_SLUG,
    cwd: DEMO_CWD,
    sessions: specs.length + 1,
    sidecars: 1,
    spills: 1,
    newestTitle: 'Make the payments webhook idempotent',
  };
}
