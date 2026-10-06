// `npm run demo:capture` — the README's screenshots, regenerated.
//
// Drives the REAL UI in Chrome against the invented corpus in `demo-corpus.mjs`,
// then copies the reviewed shots into `docs/images/`. The images in the README are
// therefore photographs of the product, not drawings of it, and a UI change that
// strands the page is one command away from being seen.
//
// ★ WHY A WRAPPER AND NOT `npm run render-gate`. `runRenderGate` takes an
// `outRoot`, which is exactly the seam this needs — but `parseArgv` accepts
// `--task` and refuses every other argument, deliberately, so the command line
// cannot reach the field. Calling the function is the supported path and costs no
// change under `src/`.
//
// ★ THE CORPUS IS PLANTED IN A THROWAWAY DIRECTORY AND NEVER COMMITTED. Two env
// vars point the drive away from anything real:
//
//   AGENT_LENS_DEV_DIR         the data dir whose `archive/` the sweep indexes
//   AGENT_LENS_TRANSCRIPT_ROOT the source tree the boot path measures
//
// The second one exists for a narrow reason worth writing down: `chromeDriver`
// calls `startDevServer()` with no options, so `projects` falls back to the slug
// of the CURRENT WORKING DIRECTORY and `requireSlugsExist` throws if that slug is
// absent under the transcript root. So the slug is created, empty — the sweep
// reads `<dataDir>/archive` and nothing else, so an empty source tree changes no
// reading.
//
// ★ THREE OF THE TEN SHOTS CARRY THE GATE'S OWN WRITING, and that is mechanical
// rather than a matter of taste. The live probe appends a record whose body names
// the gate; the drift probe appends a record the projector cannot classify and
// photographs the alarm it raises. Both revert at teardown, but both happen
// BEFORE `06-thread.png` is taken, and the alarm draws above the tree/thread
// split. So `06`, `08` and `09` are not copied, and the copy list below is a
// whitelist rather than an exclusion list — a shot nobody has read cannot arrive
// in `docs/images/` by being added upstream.
//
// ★ NO AUTOMATED GATE READS A PNG. `fixture-residue.test.ts` scans text under two
// roots; an image is not text. The contact sheet is printed at the end for that
// reason: every committed image is read by a human at full size before the commit
// that adds it.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRenderGate } from '../src/render-gate/index.js';
import { slugFor } from '../src/dev/server.js';
import { plantDemoCorpus } from './demo-corpus.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The render-gate task id, and therefore the output directory's name. */
const TASK = 'readme';

/** Exactly the shots a human has read. See the header. */
const PUBLISHED = ['01-sessions.png', '05-tool-call.png', '07-subagent.png', '10-search.png'];

const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');

function heading(text) {
  console.log(`\n── ${text}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-lens-demo-'));
const dataDir = join(scratch, 'data');
const transcriptRoot = join(scratch, 'projects');

try {
  heading('Planting the invented demo corpus');
  // The cwd's own slug, so `requireSlugsExist` is satisfied without a real tree.
  mkdirSync(join(transcriptRoot, slugFor(process.cwd())), { recursive: true });
  const manifest = plantDemoCorpus(dataDir);
  console.log(
    `   ${manifest.sessions} sessions, ${manifest.sidecars} sub-agent transcript, ` +
      `${manifest.spills} spilled result`,
  );
  console.log(`   project ${manifest.cwd} (slug ${manifest.slug})`);
  console.log(`   newest: ${manifest.newestTitle}`);
  console.log(`   archive: ${manifest.archiveRoot}`);

  // Set after the plant and before the drive: `devDataDir()` and
  // `defaultTranscriptRoot()` both read these at call time, not at import time.
  process.env.AGENT_LENS_DEV_DIR = dataDir;
  process.env.AGENT_LENS_TRANSCRIPT_ROOT = transcriptRoot;

  heading('Driving the real UI in Chrome');
  const code = await runRenderGate({ task: TASK, outRoot: scratch });

  const outDir = join(scratch, '.render-gate', TASK);
  heading(`Copying the reviewed shots into ${IMAGES_DIR}`);
  mkdirSync(IMAGES_DIR, { recursive: true });
  const missing = [];
  for (const name of PUBLISHED) {
    const from = join(outDir, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    copyFileSync(from, join(IMAGES_DIR, name));
    console.log(`   ok  ${name}`);
  }
  for (const name of missing) console.log(`   MISSING  ${name} — the drive never took it`);

  console.log(`\n   contact sheet: ${join(outDir, 'index.html')}`);
  console.log('   Read every copied image at full size before committing it: no test does.\n');

  // ★ THE SCRATCH TREE IS KEPT, ON EVERY PATH. The contact sheet is the only
  // thing that makes the manual image read practical, and a script that prints a
  // path it has just deleted is worse than one that leaves a directory in the
  // system temp tree for the OS to reap. All ten shots stay there too, which is
  // what lets a reviewer check that the three excluded ones were excluded for the
  // reason the header gives.
  console.log(`   all ten shots and the report: ${outDir}\n`);

  if (missing.length > 0) {
    console.error(`demo:capture: ${missing.length} published shot(s) were never taken`);
    process.exitCode = 1;
  } else {
    process.exitCode = code;
  }
} catch (err) {
  console.error(`demo:capture: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`demo:capture: artifacts kept for inspection at ${scratch}`);
  process.exitCode = 1;
}
