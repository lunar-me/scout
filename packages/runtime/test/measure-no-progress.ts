/**
 * Where to cut a run that has stopped moving the page, measured rather than
 * chosen — the derivation behind {@link NO_PROGRESS_TOLERANCE}.
 *
 * ── The defect this measures ────────────────────────────────────────────────
 *
 * Measured over the post-fix sweep (`bench/results/postfix-all-r1r2-pooled.md`,
 * 84 scored cells, 2 repeats): passing cells have a median of 7 steps and only
 * two of 34 ever exceeded 19, while 13 cells sat at exactly the 60-step ceiling
 * and returned ONE pass between them for 41.3% of the sweep's spend. Steps 20
 * through 60 were therefore buying almost nothing — but the fix is not a lower
 * ceiling, because two winners live up there. Something has to distinguish a
 * deep run that is working from one that is not.
 *
 * ── What the agent is actually doing up there ───────────────────────────────
 *
 * `test/fixtures/recorded-page-states.json` is the only per-step page-state
 * record that exists: bench run 20260908122325 with `OUTCRAWL_TREE_LOG` set,
 * which dumped the FILTERED tree behind every one of its 282 page reads across
 * 12 tasks. Each read is re-hashed here with the production `hashSnapshot` —
 * the same function, over the same trees the loop hashed — so a streak in the
 * fixture is a streak the loop could have seen.
 *
 * The three capped runs hold a page whose tree is IDENTICAL for 55, 55 and 33
 * consecutive reads. Not similar: byte-identical under the hash the action
 * cache keys on. The agent is not navigating away, not cycling between pages
 * and not retrying a failing action against a moving page — it is issuing
 * actions the page does not answer, against a tree that never changes, until
 * the ceiling stops it. (The raw dumps differ only in churned StaticText
 * backend node ids, which `hashSnapshot` deliberately excludes.)
 *
 * ── Why 25 ─────────────────────────────────────────────────────────────────
 *
 * The two populations do not overlap, and the gap between them is empty:
 *
 *     capped runs        longest identical streak   55, 55, 33
 *     every other run    longest identical streak   17, 6, 6, 5, 4, 3, 2, 1, 1
 *     empty gap          18 – 32
 *
 * 25 is the midpoint of that gap: the cut with the most room on both sides, 8
 * reads clear of the deepest streak in a run that finished and 8 clear of the
 * shallowest streak in a run that capped. A rule this far from both edges does
 * not need the corpus to be complete to be safe; it needs it to be right about
 * which side each run is on, and the outcome column is recorded, not inferred.
 *
 * The worst false-fire candidate is the one to watch rather than the average:
 * `wv-allrecipes-40` sat on the Allrecipes home page for 17 identical reads,
 * broke out at read 19 and answered at 21 — and the same row PASSES at exactly
 * 60 steps in the sweep. It survives at 25 with 8 reads to spare. That is the
 * regression test in `test/no-progress.test.ts`, not a footnote here.
 *
 * ── RE-DERIVING IT ON A NEW ACTUATOR ───────────────────────────────────────
 *
 * The 282 reads were taken with `scout-1` at the first hands model,
 * which the provider withdrew hours after this landed. The mechanism does not
 * depend on the model; 25 does. So this script takes a FRESH corpus as
 * arguments rather than only the committed fixture:
 *
 *     bun run test/measure-no-progress.ts                       # the fixture
 *     bun run test/measure-no-progress.ts <tree-log.jsonl> <bench-result.json>
 *
 * The log is what `OUTCRAWL_TREE_LOG` appends (`packages/bench/src/run.ts`),
 * one line per page read beside a `<log>.trees/<task>-<nnn>.json` dump of the
 * filtered tree; the bench result JSON supplies each row's outcome, which is
 * the only thing the log does not carry and the only thing that says which side
 * of the cut a run belongs on. Trees are hashed here with the production
 * `hashSnapshot`, so a streak in the report is a streak the loop could see.
 *
 * ONE WARNING IT PRINTS AND YOU MUST READ: the loop counts one hash per STEP
 * and this counts one per READ. They were equal on all 12 rows of the committed
 * corpus, and they are not equal in general — a settle poll or a think-window
 * re-read is a second read inside one step. When they differ the script says so
 * per row, and the streaks it prints are then an UPPER BOUND on the loop's own.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { NO_PROGRESS_TOLERANCE } from '../src/loop';
import type { AxTree } from '../src/snapshot';
import { hashSnapshot } from '../src/snapshot';

interface RecordedRun {
  readonly task: string;
  readonly steps: number;
  readonly capSteps: number;
  readonly outcome: string;
  readonly stopReason: string;
  readonly pass: boolean;
  readonly usd: string;
  readonly page: readonly { readonly url: string; readonly hash: string }[];
}

interface Fixture {
  readonly source: string;
  readonly runId: string;
  readonly snapshots: number;
  readonly runs: readonly RecordedRun[];
}

/**
 * The corpus: the committed fixture, or a fresh `OUTCRAWL_TREE_LOG` pair.
 *
 * The LOG and not the dump directory, because the log carries `loopStep` — the
 * step each read served — and the loop counts one hash per STEP. Where a step
 * took several reads (a settle poll, a think-window re-validation) the LAST is
 * the one kept, because the last read before a step is recorded is the tree its
 * action was chosen against, which is what lands on `StepTrace.snapshotHash`.
 *
 * A log written before `loopStep` existed falls back to one-hash-per-read and
 * says so: on such a corpus every streak is an upper bound on the loop's own
 * and the saving column is not computable at all, because a read index cannot
 * be subtracted from a step count.
 */
function fromTreeLog(logPath: string, resultPath: string): { fixture: Fixture; perStep: boolean } {
  const report = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    readonly runId: string;
    readonly rows: readonly RecordedRun[];
  };
  const lines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly task: string;
          readonly step: number;
          readonly loopStep?: number;
          readonly tree: string;
        },
    );
  const perStep = lines.every((line) => line.loopStep !== undefined);
  const reads = new Map<string, Map<number, { url: string; hash: string }>>();
  for (const line of lines) {
    const dump = JSON.parse(readFileSync(line.tree, 'utf8')) as { readonly tree: AxTree };
    const byKey = reads.get(line.task) ?? new Map<number, { url: string; hash: string }>();
    // Last write wins, which is the point: several reads inside one step
    // collapse onto the read the step actually acted on.
    byKey.set(perStep ? (line.loopStep ?? line.step) : line.step, {
      url: dump.tree.url,
      hash: hashSnapshot(dump.tree),
    });
    reads.set(line.task, byKey);
  }
  const runs: RecordedRun[] = [];
  for (const [task, byKey] of reads) {
    const row = report.rows.find((one) => one.task === task);
    if (row === undefined) {
      console.log(`  ${task}: in the tree log and not in ${resultPath} — skipped`);
      continue;
    }
    const page = [...byKey.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, state]) => ({ url: state.url, hash: state.hash }));
    if (page.length !== row.steps) {
      console.log(
        `  ${task}: ${String(page.length)} ${perStep ? 'steps with reads' : 'reads'} against ` +
          `${String(row.steps)} recorded steps${perStep ? '' : ' — streaks below are an UPPER BOUND'}`,
      );
    }
    runs.push({ ...row, page });
  }
  return {
    fixture: {
      source: `${logPath} + ${resultPath}${perStep ? '' : ' (NO loopStep: per-read, upper bound)'}`,
      runId: report.runId,
      snapshots: runs.reduce((sum, run) => sum + run.page.length, 0),
      runs: runs.sort((a, b) => a.task.localeCompare(b.task)),
    },
    perStep,
  };
}

const [logArg, resultArg] = process.argv.slice(2);
const loaded =
  logArg !== undefined && resultArg !== undefined
    ? fromTreeLog(logArg, resultArg)
    : {
        fixture: JSON.parse(
          readFileSync(new URL('./fixtures/recorded-page-states.json', import.meta.url), 'utf8'),
        ) as Fixture,
        // The committed corpus took exactly one read per step on all 12 rows,
        // asserted in `no-progress.test.ts` rather than assumed here.
        perStep: true,
      };
const { fixture, perStep } = loaded;

/**
 * The step count a run would have ended on, or `null` for a run the rule never
 * touches. Deliberately a re-implementation of the loop's counter rather than a
 * call into it: this script answers "where would the cut have fallen", and the
 * test beside it answers "does the loop cut there".
 */
function firesAt(run: RecordedRun, tolerance: number): number | null {
  let unchanged = 0;
  for (let index = 1; index < run.page.length; index += 1) {
    unchanged = run.page[index]?.hash === run.page[index - 1]?.hash ? unchanged + 1 : 0;
    if (unchanged >= tolerance) {
      return index + 1;
    }
  }
  return null;
}

function longestStreak(run: RecordedRun): number {
  let best = 0;
  let unchanged = 0;
  for (let index = 1; index < run.page.length; index += 1) {
    unchanged = run.page[index]?.hash === run.page[index - 1]?.hash ? unchanged + 1 : 0;
    best = Math.max(best, unchanged);
  }
  return best;
}

const capped = fixture.runs.filter((run) => run.outcome === 'capped');
const finished = fixture.runs.filter((run) => run.outcome !== 'capped');

console.log(`${fixture.source}\n${String(fixture.runs.length)} runs, ${String(fixture.snapshots)} page reads\n`);
console.log('run                   steps  outcome        pass  longest identical streak');
for (const run of [...fixture.runs].sort((a, b) => longestStreak(b) - longestStreak(a))) {
  console.log(
    `${run.task.padEnd(22)}${String(run.steps).padStart(5)}  ${run.outcome.padEnd(13)} ${run.pass ? 'yes ' : 'no  '}  ${String(longestStreak(run)).padStart(3)}`,
  );
}

/**
 * The cut needs BOTH populations. A corpus in which nothing finished — six of
 * six ended `cappedBy: budget` at step 5-9 on the GA actuator — has no gap to
 * find a midpoint in, and printing `-Infinity` as if it were a bound is how a
 * number nobody measured ends up in a commit message.
 */
if (finished.length === 0 || capped.length === 0) {
  console.log(
    `\nNO CUT DERIVABLE from this corpus: ${String(capped.length)} capped run(s) and ` +
      `${String(finished.length)} that finished. The threshold is the midpoint of the gap between ` +
      'the two populations, so both have to exist. What this corpus can say is the streak column above.',
  );
} else {
  const deepestFinished = Math.max(...finished.map(longestStreak));
  const shallowestCapped = Math.min(...capped.map(longestStreak));
  console.log(
    `\ndeepest streak in a run that FINISHED: ${String(deepestFinished)}` +
      `\nshallowest streak in a run that CAPPED: ${String(shallowestCapped)}` +
      (deepestFinished < shallowestCapped
        ? `\nempty gap: ${String(deepestFinished + 1)} - ${String(shallowestCapped - 1)}` +
          `, midpoint ${String(Math.round((deepestFinished + shallowestCapped) / 2))}`
        : '\nthe two populations OVERLAP: no threshold separates them on this corpus'),
  );
}

console.log('\ntolerance  caught/capped  false fires  steps saved  of steps spent by capped runs');
const cappedSteps = capped.reduce((sum, run) => sum + run.steps, 0);
for (const tolerance of [5, 10, 15, 17, 18, 20, 25, 30, 33, 34, 40]) {
  const caught = capped.filter((run) => firesAt(run, tolerance) !== null);
  const falseFires = finished.filter((run) => firesAt(run, tolerance) !== null);
  const saved = caught.reduce((sum, run) => sum + (run.steps - (firesAt(run, tolerance) ?? run.steps)), 0);
  const mark = tolerance === NO_PROGRESS_TOLERANCE ? ' <- shipped' : '';
  console.log(
    `${String(tolerance).padStart(9)}  ${`${String(caught.length)}/${String(capped.length)}`.padStart(13)}  ` +
      `${String(falseFires.length).padStart(11)}  ` +
      (perStep
        ? `${String(saved).padStart(11)}  ${((100 * saved) / cappedSteps).toFixed(1)}%`
        : `${'—'.padStart(11)}  —`) +
      mark +
      (falseFires.length > 0 ? `   [${falseFires.map((run) => run.task).join(', ')}]` : ''),
  );
}

if (!perStep) {
  console.log(
    '\nNO SAVING COLUMN: this log has no `loopStep`, so a fire position is a READ index and the ' +
      'step count it would be subtracted from is a STEP count. Re-run the arm on a tree that ' +
      'writes `loopStep` (packages/bench/src/run.ts) and the rest of this report becomes exact.',
  );
}

console.log(`\nat the shipped tolerance of ${String(NO_PROGRESS_TOLERANCE)}:`);
let savedSteps = 0;
let savedUsd = 0;
for (const run of capped) {
  const at = firesAt(run, NO_PROGRESS_TOLERANCE);
  if (at === null) {
    console.log(`  ${run.task.padEnd(22)} NOT CAUGHT`);
    continue;
  }
  const saved = run.steps - at;
  const usdPerStep = Number(run.usd) / run.steps;
  savedSteps += saved;
  savedUsd += saved * usdPerStep;
  console.log(
    `  ${run.task.padEnd(22)} stops at ${perStep ? '' : 'read '}${String(at)}/${String(run.steps)}` +
      (perStep
        ? ` — ${String(saved)} steps, ${String(saved)} model calls, $${(saved * usdPerStep).toFixed(6)}` +
          ` at the row's own $${usdPerStep.toFixed(6)}/step`
        : ' — saving not computable without `loopStep`'),
  );
}
console.log(
  `  TOTAL ${String(savedSteps)} steps and $${savedUsd.toFixed(6)} across ${String(capped.length)} capped runs` +
    `, and ${String(finished.filter((run) => firesAt(run, NO_PROGRESS_TOLERANCE) !== null).length)} runs that finished were touched`,
);
