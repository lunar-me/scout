/**
 * What the vacuity hold costs in STEPS, measured rather than argued.
 *
 * A stop condition that never fires is as broken as one that fires too early —
 * it spends the caller's whole ceiling to reach the same data — so
 * {@link VACUOUS_HOLD_TOLERANCE} has to be checked against the answers the
 * product actually produces, not against invented ones.
 *
 * Method, and it spends NOTHING: every recorded `answer` in
 * `packages/bench/results` is replayed through the REAL loop with the test
 * harness's browser, under both ways a schema'd run can stop — extract-only
 * (the loop reading the schema as satisfied) and extract-then-`done` (the
 * model's own claim). No model, no browser, no money.
 *
 * PESSIMISTIC BY CONSTRUCTION: the simulated model never changes its answer
 * when it is shown the notice, so every held row pays the full tolerance. A
 * real model that fixes its answer pays less, and one that reports `fail`
 * instead pays one step.
 *
 * The gate-OFF arm is this same script with the first guard of `vacuousAnswer`
 * in `src/loop.ts` forced to return `undefined`; that is the pre-change loop.
 * Measured 2026-09-08 over the 118 recorded answers committed at the time,
 * identical on both doors — the row count tracks whatever is in
 * `bench/results`, so re-run both arms rather than quoting these:
 *
 *     steps      OFF 236 -> ON 344   (+108, every held row +3)
 *     capped     OFF 0   -> ON 0
 *     rows held  36/118, of which rows the judge PASSED: 0
 *
 * Of those 36, 33 are rows whose recorded answer is empty because the run had
 * already capped, errored or given up — the gate never sees those, because it
 * only ever judges data the schema already accepts. THREE runs in the whole
 * committed history actually terminated on a vacuous answer, and every one
 * went out a different-looking door of the same defect: `wv-arxiv-6`
 * `schema-satisfied` at step 24 of 60 with `"Not found"` (`cap-voyager-60`),
 * `wv-arxiv-6` `schema-satisfied` at step 6 with `"not found"`
 * (`baseline-pre-space-fix`), and `wv-arxiv-14` `task-complete` at step 14 of
 * 60 with `"no results"` (`cap-verify-60`). One defect, both doors, which is
 * why the bound is asked at both.
 *
 * All three are also rows whose judge key is NOT ON THE RENDERED PAGE, so they
 * were honest refusals and no hold makes them pass. What the hold changes for
 * them is the report: a held step, a recorded `done was declined`, and an
 * accepted non-answer instead of `completed`. Do not read the held count as a
 * correctness forecast. See {@link VACUOUS_HOLD_TOLERANCE}.
 *
 * Run: `bun run test/measure-vacuous-hold.ts` from `packages/runtime`. It
 * lives beside its fixtures rather than in `scripts/`: runtime's
 * `tsconfig.json` covers src+scripts and `tsconfig.test.json` covers src+test,
 * so a file under `scripts/` that imports `test/support` cannot typecheck
 * under either config.
 */
import { readdirSync, readFileSync } from 'node:fs';

// `Action` is declared and exported in `../src/actions`; `loop.ts` only
// `import type`s it and never re-exports it, so importing it from there is a
// TS2459. Identical to the defect `prove-durable-records.ts` carried earlier
// tonight — a script reaching for a public type through the wrong module.
import type { Action } from '../src/actions';
import type { ModelChoice } from '../src/loop';
import { runAgent } from '../src/loop';
import { evaluateSubstance } from '../src/result';
import { catalogueTree, harness } from './support';

const RESULTS = new URL('../../bench/results/', import.meta.url).pathname;
const page = catalogueTree();
/** The WebVoyager answer shape: one required string, which any string satisfies. */
const ANSWER = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };

interface BenchRow {
  readonly task?: string;
  readonly answer?: string;
  readonly capSteps?: number;
  readonly pass?: boolean;
}

const rows: { file: string; task: string; answer: string; cap: number; pass: boolean }[] = [];
for (const file of readdirSync(RESULTS).filter((name) => name.endsWith('.json'))) {
  const parsed = JSON.parse(readFileSync(`${RESULTS}${file}`, 'utf8')) as { rows?: BenchRow[] };
  for (const row of parsed.rows ?? []) {
    if (typeof row.answer !== 'string' || row.task === undefined) continue;
    rows.push({
      file,
      task: row.task,
      answer: row.answer,
      cap: row.capSteps ?? 60,
      pass: row.pass === true,
    });
  }
}

const doors: readonly { readonly name: string; readonly after: Action }[] = [
  { name: 'extract-only     ', after: { type: 'extract' } },
  { name: 'extract-then-done', after: { type: 'done', summary: 'finished' } },
];

for (const door of doors) {
  let steps = 0;
  let capped = 0;
  const held: string[] = [];
  for (const row of rows) {
    const h = harness({
      tree: page,
      model: (_prompt, step): ModelChoice => ({
        action: step === 0 ? { type: 'extract' } : door.after,
      }),
      extract: () => ({ data: { answer: row.answer } }),
    });
    const result = await runAgent(h.deps, {
      task: row.task,
      caps: { steps: row.cap, budget: '100.00', duration: '60m' },
      schema: ANSWER,
      stepFailures: null,
    });
    steps += result.stepsUsed;
    if (result.status === 'capped') capped += 1;
    // Two steps is this replay's healthy path: one to extract, one to answer
    // the plan demand on a run whose ceiling funds planning.
    if (result.stepsUsed > 2) {
      held.push(
        `    ${row.task} <${row.file}> pass=${String(row.pass)} steps=${String(result.stepsUsed)} ` +
          `stop=${result.stopReason} answer=${JSON.stringify(row.answer.slice(0, 40))}`,
      );
    }
  }
  const vacuous = rows.filter(
    (row) => !evaluateSubstance(ANSWER, { answer: row.answer }).substantive,
  );
  console.log(`${door.name}  rows ${String(rows.length)}  steps ${String(steps)}  capped ${String(capped)}`);
  console.log(
    `                   vacuous answers ${String(vacuous.length)}  held ${String(held.length)}  ` +
      `held rows the judge passed ${String(held.filter((line) => line.includes('pass=true')).length)}`,
  );
  console.log(held.join('\n'));
}
