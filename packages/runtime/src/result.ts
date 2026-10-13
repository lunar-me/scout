/**
 * What a run returns.
 *
 * Published task success rates are 42–71% — WebVoyager 59.1%, WebArena 71.2%,
 * Online-Mind2Web 42.3%, GAIA 52.3% — so a run that does not reach `completed`
 * is the common case, not the exception. Data collected before the end comes
 * back on **every** status. The literature scores partial as failure; a paying
 * customer with four of six fields does not.
 */

import type { ModelPricing } from './caps';
import {
  addDecimal,
  type AgentQuestion,
  type AgentResult as WireAgentResult,
  type AgentStatus,
  type AgentStep,
  type AgentStopReason,
  type CapName,
  type ExtractCut,
  type JsonSchema,
  type ObservedAction,
  type SettledAgentResult,
  type StepVerification,
  type Timestamp,
  type Usage,
  ZERO_CREDITS,
} from '@outcrawl/scout-core';

import type { Action, PlanStep, TabId } from './actions';
import { describeAction } from './actions';
import type { ExitSwitch } from './resume';
import type { SettleReport } from './settle';
import type { NodeRef } from './snapshot';
import type { CheckTrace } from './verify';

/** Cache metadata as core spells it, present on every step and every result. */
export type CacheInfo = NonNullable<Usage['cache']>;

/* ------------------------------------------------------------------ *
 * Plan and memory
 * ------------------------------------------------------------------ */

export type GoalStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * A sub-goal and what became of it.
 *
 * `active` is DERIVED and never stated by the model: it is the first goal in
 * plan order that is neither `done` nor `failed`. One fewer thing for a model to
 * keep consistent, one fewer field to disagree with the plan, and reordering is
 * expressed the only way it should be — by revising the plan.
 */
export interface GoalState extends PlanStep {
  readonly status: GoalStatus;
  /** What closed it: the confirmation on `done`, the reason on `failed`. */
  readonly summary?: string;
  readonly closedAtStep?: number;
}

/**
 * Something learned that outlives the page it came from.
 *
 * The action log records that a button was clicked; it never records what the
 * page said. A price read at step 3 and needed at step 38 exists nowhere in a
 * flat history except as the fact that an `extract` happened. This is where it
 * lives instead, and it is exempt from compaction for exactly that reason.
 */
export interface Finding {
  readonly step: number;
  /** The sub-goal that was active when it was recorded. */
  readonly goal?: string;
  /**
   * Set on an entry that is PAGE DATA the run extracted (JSON-quoted text from
   * a page), not a note the model wrote. Carried with the findings so a resumed
   * run gets it back, and rendered in its own prompt block, never as the
   * model's memory. Absent on every model-authored finding.
   */
  readonly page?: true;
  /**
   * A reply received through this run's authenticated human-answer channel,
   * not a model note or page claim. Never inferred from the prose in `text`.
   */
  readonly humanAnswer?: { readonly question: string; readonly answer: string };
  readonly text: string;
}

/** An approach already tried and abandoned, kept so a later step does not repeat it. */
export interface RuledOut {
  readonly step: number;
  readonly goal?: string;
  readonly text: string;
}

/**
 * A question the run parked on, as the customer's channels carry it.
 *
 * The body of a `question` {@link DurableRecord}, which is what makes the
 * question REACHABLE: it lands in the run's own log, so it is on
 * `GET /v1/agent/{id}/events` at level `step`, on the webhook, and on the run
 * row a poller reads — three channels that already existed, and no fourth one
 * invented for a park. A question a customer has to be watching a socket to
 * see is a question nobody answers at 02:00.
 */
export interface AskedQuestion {
  /** The step whose action was the `ask`. */
  readonly step: number;
  readonly question: string;
  /** The replies the model offered, when it offered any. Advisory, never enforced. */
  readonly options?: readonly string[];
  /**
   * How long the run will wait before it gives up on an answer and carries on.
   *
   * On the record deliberately, and not left as a fact the reader has to know
   * our defaults to compute: it is the one number that tells a customer
   * whether they can answer this after lunch.
   */
  readonly waitMs: number;
  /**
   * The structured question beside the string one, when the park is not a
   * free-text `ask`: a purchase approval waiting on `/answer { approve }`.
   * The binding copies it onto the run's `pause.ask`, so a client reads the
   * kind and never parses `question`.
   */
  readonly ask?: AgentQuestion;
}

/**
 * What came back, or the fact that nothing did.
 *
 * `answer: undefined` is a REAL, expected outcome and not an error: nobody
 * answered inside the window. The run is told so in the same place an answer
 * would have gone and decides for itself, which is why a park needs no new
 * stop reason and cannot become a state a run is stuck in.
 */
export interface AskAnswer {
  readonly answer: string | undefined;
  /** Who answered, when the channel knows. Recorded, never trusted for anything. */
  readonly answeredBy?: string;
}

/**
 * Where an {@link AskedQuestion} goes and how its answer comes back.
 *
 * AWAITED, so the run really is parked for the duration — the loop is
 * suspended at this call and the browser it holds stays warm and drivable. It
 * is the sink's job to bound the wait; a sink that never settles is a run that
 * never ends, so every binding resolves with `answer: undefined` at its own
 * deadline.
 *
 * Absent on a run with nowhere to ask — a script, a benchmark, this package's
 * own tests — and then an `ask` is answered "nothing on this run can reach a
 * human", which is the truth and is a thing the model can act on. It is never
 * silently dropped: an unanswerable question that read as answered would be
 * the model deciding on an answer nobody gave.
 */
export type AskSink = (asked: AskedQuestion) => Promise<AskAnswer>;

/**
 * The run's state that is not the page: where it is going, and what it has
 * learned.
 *
 * ── IF ANYONE MAKES A RUN RESUMABLE, THIS IS THE UNIT, AND HERE IS THE RULE ──
 *
 * Written down before the feature exists, because the easy half of it is
 * obvious and the half that matters is not, and a successor who derives only
 * the obvious half ships a second charge on a customer's card.
 *
 * WHAT CAN BE CARRIED ACROSS A RESTART: this object, `StepTrace[]`, `CapState`,
 * the task, the schema, and `AgentRequest.profile` — which already persists
 * cookies and logged-in state across runs today.
 *
 * WHAT CANNOT: the live DOM, scroll position, in-flight requests, the freeze
 * `PageSession` holds, and every `NodeRef` in the run — backend node ids are
 * per-renderer-process and collide, which is why they are frame-qualified in
 * the first place. A resumed run therefore starts a NEW browser and replays
 * INTENT, never state. It re-navigates and re-reads.
 *
 * THE RULE — IS THE WORK IDEMPOTENT ON REPLAY?
 *
 *   Research-shaped — reading, searching, comparing, extracting — IS resumable
 *   and it is worth a great deal. Re-reading a page costs one step and returns
 *   the same bytes, and the findings above ARE the deliverable, so a run that
 *   died at hour three loses the current page and not the work.
 *
 *   Transaction-shaped — anything that has already mutated third-party state:
 *   a submitted checkout, a sent message, a booked seat — is NOT resumable and
 *   MUST NOT be retried blindly. The failure is not a wasted step, it is a
 *   SECOND CHARGE, and the run cannot distinguish "the order went through and
 *   the confirmation page died with the browser" from "the order never went
 *   through", because that evidence lived in the DOM that died.
 *
 *   So: a run is resumable until its first non-idempotent action and
 *   permanently un-resumable after it. Past that point a resume may REPORT what
 *   the run knew and must refuse to ACT.
 *
 * `profile` makes this MORE urgent and not less: the resumed run is logged in
 * as the same person, so a blind retry does not bounce — it succeeds.
 */
export interface AgentMemory {
  readonly goals: readonly GoalState[];
  readonly findings: readonly Finding[];
  readonly ruledOut: readonly RuledOut[];
}

/**
 * How many characters of remembered fact ONE memory block may render.
 *
 * ── Why these two blocks are the ones that needed a ceiling ──────────────────
 *
 * `HISTORY_WINDOW` bounds the step history and `TREE_CHAR_BUDGET` bounds the
 * page. `findings`, `ruledOut` and `goals` had no bound of any kind: they are
 * pushed to on any step whose reply carries the envelope field, they are never
 * evicted, and `renderPrompt` emits every one of them on every subsequent step.
 * They were the only terms in the prompt that grew with the length of the run.
 *
 * Measured with `o200k_base` against the real `renderPrompt`, one block varied
 * at a time with the tree pinned at its ceiling: a finding costs 17.76 tokens,
 * a ruled-out entry 13.33, a sub-goal 30.00, and the growth is exactly linear
 * (17.765 tok/entry at a thousand entries, 17.753 at five thousand). At a
 * quarter of a finding per step that is 6.11 tokens/step, so **memory overtakes
 * the whole 5,000-token page budget at step 794** and the prompt has doubled by
 * step 597. Nobody had run far enough to see it: at step 12, where the split was
 * last measured, these three blocks are 103 tokens and 3.9% of the prompt. This
 * ceiling saves nothing on a twelve-step run and is not defended as a cost
 * lever; what it prevents is a ten-thousand-step run reading 61,214 tokens of
 * its own notes in front of a 5,000-token page.
 *
 * 2,500 chars is 1,000 tokens at `CHARS_PER_TOKEN`, i.e. one fifth of the tree's
 * ceiling and about 56 findings — comfortably more than any measured run has
 * produced, so it binds on the long horizon and never on the short one.
 *
 * IN CHARACTERS, for the reason `TREE_CHAR_BUDGET` is: a tokenizer in the
 * runtime would be a per-vendor dependency and a nondeterminism in a function
 * whose determinism is what makes a cached choice reproducible.
 */
export const MEMORY_CHAR_BUDGET = 2_500;

/**
 * How many characters the FINDINGS block may render: four times
 * {@link MEMORY_CHAR_BUDGET}, because findings are the one memory block that
 * is often the deliverable itself.
 *
 * The shared 2,500 was sized on "about 56 findings" of ~45 characters. A
 * frontier actuator writes findings four times that wide, and on a research
 * task each one is a list the answer is built from. Measured on BU Bench V1,
 * `bufull-web-20261001` (n=100 runs, 2026-10-01): median finding 185
 * characters; 7 of 100 runs crossed 2,500, and the eviction is visible in
 * three of their answers. `run_…` recorded two items as confirmed at
 * steps 8-9, lost both from the prompt, and its answer listed only the three
 * it could still see; `run_…` recorded two of the lists it needed at
 * steps 2-6 and its answer called one of them "not available in this run's
 * records"; `run_…` read the same two pages three times over, each
 * time after the previous read's findings had been withheld.
 *
 * 10,000 characters is 4,000 tokens at `CHARS_PER_TOKEN`, under the tree's
 * 12,500-character ceiling, and 1.7x the largest findings total of those 100
 * runs (5,896 characters, `run_…`), so none of them would have lost a
 * finding. It stays a ceiling: the ten-thousand-step argument above holds,
 * only at a width findings actually have.
 */
export const FINDINGS_CHAR_BUDGET = 10_000;

/** What survived a block's ceiling, and what did not. */
export interface BoundedMemory<T> {
  /** Rendered verbatim, in original order. */
  readonly kept: readonly T[];
  /** Compacted out of the prompt. Still on the result — see {@link AgentResult}. */
  readonly dropped: readonly T[];
}

/**
 * Spends a block's character ceiling on its NEWEST entries, and rewrites the
 * block as rarely as arithmetic allows.
 *
 * ── The hysteresis is the whole design ───────────────────────────────────────
 *
 * The prompt is ordered by mutability so that a provider's prefix cache, which
 * matches from the first byte and stops at the first difference, survives a
 * growing prompt. These three blocks sit where they do BECAUSE they are
 * append-only: everything before them is byte-stable, so a new finding extends
 * the prefix rather than invalidating it.
 *
 * A ceiling that evicted the oldest entry on every append would destroy exactly
 * that. The block would be rewritten from its first line every single step, and
 * a bound that saves a thousand tokens by costing a cache hit on a four-thousand
 * token prefix is not a saving.
 *
 * So the window only ever moves when the ceiling is CROSSED, and when it moves
 * it goes all the way down to half the budget. Between two crossings the kept
 * set is unchanged and the rendered block is byte-identical plus appended lines
 * — append-only, as before. The cost is one prefix break per HALF A BUDGET of
 * new text: at 2,500 chars and ~45 characters a finding, one break per ~28
 * findings, which at a quarter of a finding per step is one break per ~112
 * steps. Compare one break per step.
 *
 * Written as a fold over the whole array rather than as incremental state, so
 * the answer is a pure function of the entries and a re-render of the same
 * memory produces the same string — which is what the action cache's
 * reproducibility rests on.
 *
 * ── What it does not do ──────────────────────────────────────────────────────
 *
 * It does not order by relevance to the active sub-goal, and that was tried and
 * rejected rather than overlooked. Relevance changes when a goal CLOSES, which
 * is an event that has nothing to do with the ceiling, so a relevance-ordered
 * block mutates on goal closure and takes the prefix cache with it — the precise
 * failure the hysteresis exists to avoid. It is also the wrong trade on a
 * research run, where a fact learned under the first sub-goal unblocking the
 * fourth is the point of having a memory at all.
 *
 * @param pinned entries that may never be dropped however old they are. Used for
 *   open sub-goals: a plan that evicted its own remaining work would be a bound
 *   on the prompt bought with the run's objective.
 */
export function boundMemory<T>(
  entries: readonly T[],
  lengthOf: (entry: T) => number,
  pinned?: (entry: T) => boolean,
  budget: number = MEMORY_CHAR_BUDGET,
): BoundedMemory<T> {
  const half = budget / 2;
  let from = 0;
  let held = 0;
  for (let index = 0; index < entries.length; index += 1) {
    held += lengthOf(entries[index] as T);
    if (held <= budget) {
      continue;
    }
    // Never the entry just added, however large it is on its own: a single
    // oversized finding is still the most recent thing the run learned, and a
    // block that renders nothing is worse than a block that renders one line.
    while (from < index && held > half) {
      const candidate = entries[from] as T;
      if (pinned?.(candidate) !== true) {
        held -= lengthOf(candidate);
      }
      from += 1;
    }
  }
  if (from === 0) {
    return { kept: entries, dropped: [] };
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    if (index >= from || pinned?.(entry) === true) {
      kept.push(entry);
    } else {
      dropped.push(entry);
    }
  }
  return { kept, dropped };
}

/**
 * What the unfreeze and the motor program did on one step.
 *
 * Present only on a run that enabled either, and it is the evidence for both.
 * The claim "releasing the freeze across the model call is cheap" is only worth
 * anything as a measured rate, so the rate is recorded per step rather than
 * asserted per design: `rung` says how the chosen reference survived the live
 * window, `reobserves` counts the model calls the moving page cost, and
 * `chained` counts the actions performed without asking again.
 */
export interface ReflexTrace {
  /**
   * How the chosen reference survived the think window.
   *
   * `frozen` is the run that never released the freeze. `same` is an unchanged
   * snapshot hash, `node` a changed page whose named node held, `xpath` a
   * reference that died and was healed through `AxNode.xpath`.
   */
  readonly rung: 'frozen' | 'same' | 'node' | 'xpath';
  /** Extra model calls this step spent because the page moved under the answer. */
  readonly reobserves: number;
  /** Actions performed after the head, with no further model call. */
  readonly chained: number;
  /** How many chained actions ran before the sequence was stopped. */
  readonly abortedAfter?: number;
  /** Why the sequence stopped. See `chainAbort` in the loop. */
  readonly abortReason?: string;
}

/**
 * One tab a fanned step tried to drive, and what came of it.
 *
 * `ok: false` with a `reason` is the ordinary outcome for a background tab
 * that moved while the model was thinking, not an error: a fan element is a
 * bet on a page holding still, `fanAbort` is the thing that checks, and the
 * model is told on the very next prompt. It is recorded rather than swallowed
 * because a step whose four elements were all refused is indistinguishable
 * from a step whose four all landed by every other measure the run keeps.
 */
export interface FanTrace {
  /** The tab driven. Absent for `openTab`, which had no tab to name. */
  readonly tab?: TabId;
  /** The tab opened, when the element was an `openTab` that succeeded. */
  readonly opened?: TabId;
  /**
   * The validated action, when the element reached validation. Absent for an
   * element `planFan` refused before it had one — a malformed object, an
   * ineligible type, a tab nobody read.
   */
  readonly action?: Action;
  readonly ok: boolean;
  /** Why it did not run, or what it threw. Absent when it ran. */
  readonly reason?: string;
  /**
   * WHAT THIS ELEMENT DID, on its own tab, judged on its own.
   *
   * Per element and never aggregated, because "the fan worked" is precisely the
   * shape that let three identical extractions pass as three answers: four
   * elements on four origins are four separate claims, and one verdict covering
   * them cannot distinguish four that landed from one that landed and three
   * that were ignored.
   *
   * Absent when the element performed nothing a single structural read can
   * falsify — `extract`, whose outcome is data judged by the schema, and the
   * two tab-lifecycle verbs, whose post-condition is the tab list the next step
   * reads anyway — and absent on the whole path when the run did not ask for
   * verification.
   */
  readonly check?: CheckTrace;
  /** Set when this element's extraction read a cut page. See `ExtractCut` in `@outcrawl/scout-core`. */
  readonly extractCut?: ExtractCut;
}

/**
 * One step, as it happened. Emitted whether the step succeeded or threw.
 *
 * This is the run's evidence: it is what the replay is rendered beside and
 * what a customer disputing a charge reads. A step that is missing because it
 * failed is the one a dispute is about.
 */
export interface StepTrace {
  /** 0-based. */
  readonly index: number;
  readonly action: Action;
  /** The node acted on, when the action named one. */
  readonly ref?: NodeRef;
  /**
   * The same action in core's wire form, present when it named a node. This is
   * the cache unit and the reviewable form; it carries the XPath heal path,
   * which the in-memory `ref` cannot survive a session to provide.
   */
  readonly observed?: ObservedAction;
  /** What the model said it was doing. */
  readonly reasoning?: string;
  /** Reasoning tokens for this step, when the model reports them. */
  readonly reasoningTokens?: number;
  /**
   * Which rank of the model chain chose this step's action, 0 being the
   * primary, when the port is a chain. A change between consecutive steps is a
   * demotion or a recovery; see `HarnessModelPort` in `@outcrawl/model`.
   */
  readonly modelRank?: number;
  /** HIT means the model was never called for this step. */
  readonly cache: CacheInfo;
  readonly elapsedMs: number;
  /** The tree the action was chosen against. The cache's key input. */
  readonly snapshotHash: string;
  /** Credits charged for this step, exact. */
  readonly credits: string;
  /**
   * TOTAL BILLABLE CREDITS AFTER THIS STEP, and the number a customer watching
   * a live run needs most.
   *
   * Cumulative where `credits` above is per-step, and the two are genuinely
   * different quantities rather than a convenience: `credits` is only what was
   * EXPLICITLY charged, which is `'0'` on every step of every production run,
   * because the model client's `creditsPerUsd` is deliberately unset. So a
   * consumer summing `credits` over a run gets zero and reports a free run.
   *
   * This is `CapLedger.billedCredits` — charges plus the run's time and pages
   * at the published rate — which is the figure the invoice is argued from.
   * NOT `CapLedger.credits`: that getter is `billedCredits` PLUS a defensive
   * reserve against bandwidth this package cannot see yet, and it is what
   * `caps.budget` is enforced against, never what a customer is shown — see
   * `CapLedger.credits`'s own doc in `packages/runtime/src/caps.ts`. This
   * field used to read the reserve-inclusive getter, and because
   * `packages/persistence`'s `REPORT_RUN` never lets a run's stored `credits`
   * column fall, one such report permanently floored it: a capped run could
   * settle correctly and still show the customer the pessimistic figure
   * forever after. One number, read at every step, and it has to be the
   * charged one.
   *
   * Measured on `run_…`: 53 steps, every one
   * carrying `credits: "0"`, and a run that settled at 39.2714 credits. A
   * customer polling at 90 s was shown `spent 0 of 360.0`.
   */
  readonly spent: string;
  /**
   * PAGE LOADS AFTER THIS STEP, across every browser this run has held.
   *
   * Required for the reason `CapState.pages` and `toWireResult`'s positional
   * `pages` argument are: a page is a published credit, so an absent count
   * reads as a legal zero-page run rather than as a field somebody forgot —
   * and the run that forgot it showed `pages 0` to a customer for 173 s and
   * then billed them for 22.
   *
   * Read from the host's own committed-navigation counter through
   * `CapLedger.pages`, never inferred from the URL of the tab the loop
   * snapshots: see `AgentDeps.pageLoads` for why the loop cannot count this
   * itself.
   */
  readonly pages: number;
  /**
   * RUN TIME AFTER THIS STEP, in milliseconds on the ledger's own clock:
   * `RunBilling.measuredMs` from the same `CapLedger.billing()` reading as
   * {@link spent} and {@link pages}. Not this step's own duration, which is
   * {@link elapsedMs}.
   *
   * On the frame because the API's live row had no other honest source for
   * it. `driveRun` in `packages/api` reported its OWN wall clock instead,
   * which starts before this ledger's and keeps running after its final
   * reading, and the row keeps the greatest duration it is ever told, so the
   * larger figure outlived the settlement. Measured 2026-09-23: on 17 of the
   * 25 most recent runs the row's `durationMs` exceeded the loop's own
   * measured time, by up to 5.2 s, and by 153.8 s on `run_...9eb8290a`.
   */
  readonly durationMs: number;
  /**
   * BANDWIDTH BYTES PRICED INTO {@link spent}, across every browser and every
   * machine this run has had: `RunBilling.billedBandwidthBytes` from the same
   * reading.
   *
   * Durable because a run that loses its machine is resumed from its last
   * recorded step, and bandwidth is the one priced term a new machine cannot
   * re-derive: time is re-derived from {@link durationMs} and pages are
   * {@link pages}. Without it the resuming machine carried the earlier
   * attempts' bandwidth forward as an anonymous charge — priced into the
   * credits the customer was shown, metered as `proxy_bytes` nowhere.
   * Measured 2026-09-24 on `run_……`: reported 54.133260, metered
   * 50.141962, the difference exactly the first attempt's bandwidth.
   */
  readonly bandwidthBytes: number;
  /**
   * PROVIDER USD THE RUN'S MODEL CALLS HAD COST AFTER THIS STEP, across every
   * attempt, from the same reading as {@link spent}. Durable for
   * {@link bandwidthBytes}'s reason: a run that loses its machine resumes from
   * its last recorded step, and a new machine's cost ledger starts at zero.
   * Optional because steps recorded before W44 (2026-09-25) do not carry it.
   * INTERNAL: a live frame projects `spent`, never this.
   */
  readonly modelCostUsd?: string;
  /**
   * THE PART OF {@link durationMs} THE RUN HAD SPENT PARKED ON A HUMAN, across
   * every attempt, from the same reading as {@link spent}:
   * `RunBilling.parkedMs`. Durable for {@link bandwidthBytes}'s reason: a run
   * resumed on a new machine seeds `CapState.parkedMs` from it, so a park on
   * the lost attempt stays off `caps.duration`. Optional because steps
   * recorded before it existed do not carry it; absent reads as no park.
   */
  readonly parkedMs?: number;
  /**
   * SUBSCRIPTION CALLS AFTER THIS STEP, across every attempt (OC-286), for
   * {@link modelCostUsd}'s reason: a new machine's cost ledger starts at zero,
   * so the earlier attempts' count travels here. Absent when none.
   * INTERNAL attribution; nothing prices it.
   */
  readonly subscriptionCalls?: number;
  readonly usage: Usage;
  readonly at: Timestamp;
  /** The sub-goal this step was working, when the run had a plan. */
  readonly goal?: string;
  /**
   * The tab this step ran on, when the run has tab control.
   *
   * Present so a replay can say which tree a mutation belongs to, and that is
   * the whole reason it exists rather than an incidental label. Every tab's
   * renderer claims main-frame ordinal 0, so a recording that does not namespace
   * by tab has nothing to distinguish tab B's mutations from tab A's and the
   * player applies them to whichever tree it happens to hold. A five-tab task
   * recorded without this is a replay that lies. Do not delete it as unused: the
   * consumer is the replay player, not this package.
   */
  readonly tab?: TabId;
  /**
   * The think window and the motor program, when the run enabled either.
   *
   * Absent on every step of every run on the frozen arm, so the A/B is legible
   * from the trace alone: a row with no `reflex` was taken with the page
   * stopped.
   */
  readonly reflex?: ReflexTrace;
  /**
   * WHAT THE ACTION ACTUALLY DID, when the run verifies its outcomes.
   *
   * Absent on every step of every run with `verify` off, so the A/B is legible
   * from the trace alone — the `reflex` precedent above, and for the same
   * reason. Present, it is the only field on a step that was written after the
   * action rather than before it: every other check in this loop validates a
   * choice against the tree it was chosen from, which says nothing about what
   * the page then did with it.
   *
   * `verdict: 'contradicted'` beside `error: undefined` is not a contradiction
   * in terms. The step did not throw — the page accepted the input and then did
   * not do the thing — and that distinction is exactly what was invisible
   * before this field existed.
   */
  readonly check?: CheckTrace;
  /**
   * THE OTHER TABS THIS STEP DROVE, when the run is on the parallel arm.
   *
   * One entry per element of `Envelope.also`, dispatched or refused, in the
   * order the model asked for them. Absent on every step of every serial run,
   * so the A/B is legible from the trace alone — a row with no `fan` drove one
   * tab.
   *
   * This is the evidence for the arm and it is not optional to record. A fanned
   * step is one step that performed up to five actions across five origins, so
   * `action` and `tab` alone cannot say what happened: a step whose four
   * elements were all refused looks identical, in step count and wall clock, to
   * a step whose four elements all landed — and the first is the arm failing
   * silently while reporting a speed-up. `ok` per element is what separates
   * them, and `reason` is what the next prompt tells the model.
   *
   * Do not delete it as unused outside this package: the consumers are the
   * benchmark's per-arm columns and the replay player, which needs to know
   * which tab a mutation belongs to when four of them moved in one step.
   */
  readonly fan?: readonly FanTrace[];
  /**
   * Set on the one step that spent the run's pre-finish check
   * (`AgentRunRequest.finishCheck`): its verdict. A resumed run reads it so the
   * check is never run — or a finish refused — twice.
   */
  readonly answerCheck?: 'passed' | 'refused';
  /**
   * Set on a step whose finish the loop held rather than honoured, for the
   * doors a resumed run must not grant again: `incomplete-final`, a
   * schema-less final extraction kept as a look because its page did not
   * state the whole answer; `gate-fail`, a `fail` declined once on a page
   * held by a failed verification check; `unconfirmed`, a `done` declined
   * once for listing conditions it had not confirmed with most of the run's
   * budget unspent; `dropped-evidence`, a schema-less final extraction
   * declined once because its answer leaves out the unverified observations
   * the run had already recorded. Counted from the steps on resume.
   */
  readonly held?: 'incomplete-final' | 'gate-fail' | 'unconfirmed' | 'dropped-evidence';
  /**
   * SET WHEN THIS STEP'S EXTRACTION READ ONLY PART OF THE PAGE, and how much.
   *
   * An extraction may spend a fifth of what the run's budget has left
   * (`EXTRACT_BUDGET_SHARE` in `./loop.ts`); a page longer than that is cut
   * before it is sent. On the step because the step record is what a customer
   * reads through `/events` and the live stream (`toWireStep`), so a partial
   * extraction is never silent: a value the run did not find on the part it
   * read is distinguishable from one the page does not have. The model is
   * told too, in the extraction prompt and on the next prompt.
   */
  readonly extractCut?: ExtractCut;
  /**
   * THE SETTLE THIS STEP PAID FOR, when it paid for one.
   *
   * Absent on a step whose page had not moved since a settle already answered
   * it, which is most steps of a run that stays on one page — see
   * `quiescentHash` in `loop.ts`. So the presence of this field is itself the
   * per-step cost, and `waitedMs` summed over a run is the whole latency the
   * render wait added to it.
   *
   * On the trace rather than in a log line because `verdict: 'growing'` — a
   * page still filling in when the growth ceiling expired — is a DIFFERENT
   * outcome from a page that settled, and the two are indistinguishable in a
   * tree. A failing state that renders identically to a passing one is how a
   * whole night of late-render loss stayed invisible, and this is the field
   * that makes the next sweep able to count it.
   */
  readonly settle?: SettleReport;
  /**
   * WHAT A `callTool` STEP'S TOOL ANSWERED, as far as a run may keep it: the
   * tool's verdict, and its own note when the tool's port wrote one
   * (`ToolCallOutcome.note`). Never the reply's text, which reaches only the
   * next prompt. Absent on every other step.
   */
  readonly tool?: ToolTrace;
  /**
   * THE SITE CHECKS THE BROWSER FINISHED WORKING since the previous step read
   * the page, in the order they ended, each with its vendor and the outcome
   * the browser's own solve reported (`PageSession.solve`'s resolution, never
   * a reading of the page): solved, failed, or left without a verdict. See
   * `StepVerification` in `@outcrawl/scout-core`. Drained where the step reads the
   * page, which is where the model is told the same thing, so a solve the
   * model was told of is a solve the trace shows. Absent when none ended; a
   * check still being worked when the run stopped is on no step.
   *
   * On the step because the step record is what a customer reads through
   * `/events`: before it, a check the browser solved left no line in the
   * trace, and a reader saw the challenge page and nothing after it
   * (run_…, 2026-10-07: reCAPTCHA solved in 45.6 s, page moved on to
   * the results, trace silent).
   */
  readonly verification?: readonly StepVerification[];
  /** Present when the step threw or the model produced an unusable action. */
  readonly error?: string;
}

/** The most of a tool's note a step keeps. A `page.verify` answer is one sentence plus up to three attempt lines. */
export const MAX_TOOL_NOTE_CHARS = 600;

/** See {@link StepTrace.tool}. */
export interface ToolTrace {
  /** The tool's own verdict on its call. */
  readonly isError: boolean;
  /** At most {@link MAX_TOOL_NOTE_CHARS}. */
  readonly note?: string;
}

/**
 * What a run learned, handed out the instant it exists rather than at the end.
 *
 * ── Why this type is here and not a field on {@link StepTrace} ──────────────
 *
 * A step is an ACTION. A finding, a ruled-out approach and a plan revision are
 * not actions: they arrive on the non-action half of a model reply, they cost
 * the run no step, and `applyEnvelope` in the loop is the only thing that has
 * ever seen them. Until this existed a `Finding` lived in exactly two places —
 * the array `runAgent` accumulates and the string `renderPrompt` builds — so
 * the prompt's own sentence, "These pages are gone; this is the only record",
 * was literally true, and a process that died at step 400 of 10,002 destroyed
 * every fact the run had bought. The run had already billed for all of them.
 *
 * ── The body is `unknown`, and that is the dependency direction ─────────────
 *
 * The consumer is a durable store, and this package cannot import one:
 * `@outcrawl/runtime` depends on `@outcrawl/scout-core` alone, and the
 * persistence layer depends on it too. So the shape is structural and the cast happens
 * where both packages are already in scope, which is `packages/worker`. Same
 * arrangement, and the same reason, as `RowPage` and the challenge-outcome sink
 * in `@outcrawl/persistence`.
 *
 * `body` per kind, and nothing enforces this but the binding site:
 * `result` — whatever `extract` returned, or the closing summary;
 * `finding` — {@link Finding}; `ruled-out` — {@link RuledOut};
 * `goal` — the whole plan as `readonly GoalState[]`, because a plan revision is
 * a new plan and not a delta; `step` — {@link StepTrace};
 * `question` — {@link AskedQuestion}, appended the instant the run parks and
 * before anything is waited on, because a question recorded after its answer
 * is a question nobody could have answered;
 * `irreversible` — the mark `packages/runtime/src/resume.ts` defines, which is
 * the one kind this loop never emits: it is written by the seam that gates a
 * dispatch, because a record the loop emitted after the fact would be a record
 * written after the charge it was meant to prevent;
 * `integration` — a connector call or an unusable granted connector, the
 * value the host's own wire contract describes. Also never
 * emitted by this loop: the connector port the host binds writes it, because
 * the port is the only thing that saw the call leave and come back.
 */
export interface DurableRecord {
  readonly kind: DurableRecordKind;
  /**
   * The step the fact belongs to. `-1` for a fact that belongs to the run and
   * not to any step — the closing summary above all, which is promoted after
   * the loop has stopped and has no step to name. Not optional: a nullable
   * step number is a field every consumer has to remember to handle, and the
   * one that forgets sorts `undefined` into the middle of a run.
   */
  readonly step: number;
  readonly body: unknown;
}

/**
 * The closed set of durable record kinds.
 *
 * Rendered into a `check` constraint by `@outcrawl/persistence`, which holds a
 * one-way proof that every member here is a member there — so a kind added
 * without the constraint is a compile error rather than a row the database
 * silently refuses at 3am. That cross-check is the only construction that
 * catches this class: `sessions_outcome_known` and core's `SessionOutcome`
 * disagreed for weeks while both looked correct in isolation, and a customer
 * filtering `outcome=timeout` matched nothing.
 *
 * `control` is written by the host and never by this loop: the api's
 * `driveRun` owns the `agent.control` hold and records its expiry. It is here
 * because this union IS the vocabulary the constraint is proved against.
 */
export type DurableRecordKind =
  | 'result'
  | 'finding'
  | 'ruled-out'
  | 'goal'
  | 'step'
  | 'irreversible'
  | 'question'
  | 'integration'
  | 'control';

export interface AgentResult<T = unknown> {
  readonly id: string;
  /**
   * `capped` and `partial` both return data and mean opposite things: capped
   * is the system doing exactly what the caller asked, and the fix is a bigger
   * ceiling; partial is the run genuinely falling short, and the fix is in the
   * task or the site.
   */
  readonly status: AgentStatus;
  /**
   * Collected so far, on every status. Never discarded.
   *
   * With a schema, this is what `extract` gathered. WITHOUT one it is the
   * `summary` the model closed with — see the `terminal === 'done'` branch in
   * `loop.ts`, which promotes it rather than making the run buy the same
   * sentence twice. `undefined` means the run had nothing to report, which is
   * an ordinary outcome for a task that asked no question and not an error.
   */
  readonly data: T | undefined;
  readonly steps: readonly StepTrace[];
  readonly stepsUsed: number;
  readonly stopReason: AgentStopReason;
  /** Which ceiling fired, when the status is `capped`. */
  readonly cappedBy?: CapName;
  /** Summed over every step. */
  readonly usage: Usage;
  /**
   * Credits spent, exact — the number that appears on the bill: `charged`
   * plus the run's model usage, browser time and bandwidth at its plan, each
   * as far as the budget funded it. `CapLedger.billing().credits`, which is
   * also the figure `caps.budget` is enforced against.
   */
  readonly credits: string;
  /**
   * The part of {@link credits} that was EXPLICITLY charged — the agent's own
   * web tools and any per-action cost the browser reported.
   *
   * Here for exactly one consumer: a resume has to carry it forward, and it is
   * the only part of `credits` that cannot be re-derived or re-priced. Time
   * comes back from the seeded `elapsedMs`, and model usage and bandwidth
   * travel as quantities — so seeding those from `credits` would charge a
   * resumed run twice. See `CapState.charged`, whose contract this satisfies.
   */
  readonly charged: string;
  /** How long the run was OPEN, as the ledger measured it — parks included. See `billedMs`. */
  readonly durationMs: number;
  /**
   * The part of {@link durationMs} the run spent parked on a human, across
   * every attempt. Billed like any open minute, off `caps.duration`; a resume
   * carries it forward as `CapState.parkedMs`.
   */
  readonly parkedMs: number;
  /**
   * The milliseconds of {@link durationMs} the budget paid for, present only
   * when that is fewer: `caps.budget` is a hard ceiling on what a run is
   * billed, so time the budget could not fund is measured and not billed. The
   * API meters `context_seconds` from this when present. See `CapLedger`'s
   * billing in `packages/runtime/src/caps.ts`.
   */
  readonly billedMs?: number;
  /**
   * Provider USD every model call of this run cost, across every attempt, as
   * the provider stated it. INTERNAL: metered as `model_cost_usd`, never shown
   * to a customer.
   */
  readonly modelCostUsd: string;
  /** The part of {@link modelCostUsd} the budget funded, which is what is metered. */
  readonly billedModelCostUsd: string;
  /**
   * Model calls a lab subscription served at '0' USD (OC-286), across every
   * attempt. Absent when none. INTERNAL attribution, stamped on the
   * `model_cost_usd` row as `metadata.subscriptionCalls`.
   */
  readonly subscriptionCalls?: number;
  /** The plan and key the run's model usage is priced at. */
  readonly pricing: ModelPricing;
  /**
   * Sub-goals and their outcomes, empty when the run never stated a plan.
   *
   * A five-part task has five completions and one report, and this is the five.
   * `status` alone cannot carry it: a run that bought four of five items is
   * neither a success nor a failure, and the only honest answer is the list.
   */
  readonly goals: readonly GoalState[];
  /**
   * Everything the run learned, complete — including whatever
   * {@link boundMemory} compacted out of the prompt.
   *
   * ── This field is what makes the prompt's ceiling legitimate ─────────────
   *
   * Until it existed, a `Finding` lived in exactly two places: the array
   * `runAgent` accumulates and the string `renderPrompt` builds. It was on no
   * `StepTrace`, on no result and in no table, so the prompt's own sentence —
   * "These pages are gone; this is the only record" — was literally true, and
   * any bound on the rendered block would have been a silent deletion of the
   * only copy rather than a bound. Now the prompt carries the recent memory and
   * the result carries all of it.
   *
   * ── And it is worth having for its own sake ──────────────────────────────
   *
   * A research-shaped run's findings ARE its deliverable. `data` holds what the
   * schema asked for; this holds what the run learned on the way, including on
   * a run that was capped before it could extract anything. A customer whose
   * eight-minute run stopped at `max-duration` used to receive a step log and
   * no facts.
   */
  readonly findings: readonly Finding[];
  /**
   * Approaches the run tried and abandoned, complete. The other half of
   * {@link findings}, and the half that tells a caller re-running a failed task
   * what not to pay for twice.
   */
  readonly ruledOut: readonly RuledOut[];
  /**
   * There is deliberately NO `pages` here.
   *
   * The page count is a billed quantity and it belongs on the wire, but this
   * layer cannot count it honestly. The loop only ever sees the URL of the tab
   * it snapshots, so it would have to infer a navigation from that URL changing
   * — which misses a reload or a POST that re-renders the same URL, and misses
   * anything that loads in a tab it is not looking at. The browser session
   * counts real page loads and already reports the same number as
   * `SessionSummary.pages`, so sourcing it there gives one tally where two would
   * otherwise have to be reconciled in front of a customer. It enters at
   * {@link toWireResult}, as a required argument, so it cannot be forgotten.
   */
  /**
   * Present when a step threw or the model chose `fail` — and on every other
   * `failed` or `partial` run too, where it says which unmet condition made it
   * so (see {@link unmetReason}). A capped run does not set it: nothing
   * went wrong, the caller's ceiling was reached, and `stopReason` with
   * `cappedBy` already says which one.
   */
  readonly error?: string;
  /**
   * Set when the run stopped because its BROWSER went away, carrying the throw
   * that said so.
   *
   * Its own field beside {@link error} rather than a shape a caller has to
   * pattern-match out of an error string, because exactly one consumer acts on
   * it and the action is expensive: the worker re-acquires a browser and
   * resumes this run's intent on it. A supervisor that had to sniff `error` for
   * "the CDP connection closed" would re-provision a context on any run whose
   * task text happened to contain that phrase, and would miss the next
   * disconnect message the fork learns to emit.
   *
   * A lost browser is NOT a failed task — every finding, every closed sub-goal
   * and everything extracted is on this result exactly as a capped run's is —
   * so `status` and `data` are untouched by this field and a caller that does
   * not resume reads a perfectly ordinary partial run. See `./resume.ts`.
   */
  readonly browserLost?: string;
  /**
   * Set when the attempt ended because the run's exit could not carry it to a
   * destination and the host has another exit that can: a provider that does
   * not refuse it, or a fresh exit in place of one whose session ended. The
   * host re-opens the run's context there and resumes. Like
   * {@link browserLost}, a caller that does not resume reads an ordinary
   * partial run. See `ExitSwitchError` in `./resume.ts`.
   */
  readonly exitSwitch?: ExitSwitch;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function addCounts(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : a + b;
}

/**
 * Sums two usage records. Counters only — the cache field is per-call and is
 * aggregated separately by `aggregateCache`, because "HIT" for a seven-step
 * run where two steps hit would be a lie.
 */
export function mergeUsage(a: Usage, b: Usage): Usage {
  const inputTokens = addCounts(a.inputTokens, b.inputTokens);
  const outputTokens = addCounts(a.outputTokens, b.outputTokens);
  const reasoningTokens = addCounts(a.reasoningTokens, b.reasoningTokens);
  const cachedInputTokens = addCounts(a.cachedInputTokens, b.cachedInputTokens);
  const inferenceTimeMs = addCounts(a.inferenceTimeMs, b.inferenceTimeMs);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(inferenceTimeMs !== undefined ? { inferenceTimeMs } : {}),
  };
}

/** `{ subscriptionCalls }` when there were any, `{}` otherwise, so a run with none carries no key. */
export function subscriptionCallsField(count: number | undefined): { readonly subscriptionCalls?: number } {
  return count !== undefined && count > 0 ? { subscriptionCalls: count } : {};
}

/**
 * One cache verdict for a whole run. `HIT` only when every step hit, because
 * the number a customer is reading it for is "did this cost me model tokens".
 */
export function aggregateCache(steps: readonly StepTrace[]): CacheInfo {
  if (steps.length === 0) {
    return { status: 'MISS', reason: 'no steps ran' };
  }
  let hits = 0;
  let disabled = 0;
  for (const step of steps) {
    if (step.cache.status === 'HIT') {
      hits += 1;
    } else if (step.cache.status === 'DISABLED') {
      disabled += 1;
    }
  }
  if (disabled === steps.length) {
    return { status: 'DISABLED', reason: 'cache disabled for this run' };
  }
  if (hits === steps.length) {
    return { status: 'HIT', reason: `${String(hits)} of ${String(steps.length)} steps replayed from cache` };
  }
  return {
    status: 'MISS',
    reason: `${String(hits)} of ${String(steps.length)} steps replayed from cache`,
  };
}

/** Total credits across a trace, exact. */
export function totalCredits(steps: readonly StepTrace[]): string {
  let total = ZERO_CREDITS;
  for (const step of steps) {
    total = addDecimal(total, step.credits);
  }
  return total;
}

/**
 * Folds a new extraction into what the run has already collected. Records
 * merge field by field, so a run that gets two fields on step 3 and two more
 * on step 7 returns four; anything else replaces.
 */
export function mergeData(collected: unknown, next: unknown): unknown {
  if (next === undefined) {
    return collected;
  }
  if (isRecord(collected) && isRecord(next)) {
    return { ...collected, ...next };
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Success detection
 * ------------------------------------------------------------------ */

export interface SchemaVerdict {
  readonly satisfied: boolean;
  /** Required fields absent or of the wrong declared type. */
  readonly missing: readonly string[];
}

function typeMatches(declared: unknown, value: unknown): boolean {
  if (typeof declared !== 'string') {
    return true;
  }
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * The success signal. When a caller supplies a schema, schema satisfaction
 * *is* the outcome — deterministic and free, rather than a second inference
 * pass asking a model whether it thinks it finished.
 *
 * Top-level `required` and top-level declared types only. A deeper check would
 * start rejecting data a customer would happily have taken.
 */
export function evaluateSchema(schema: JsonSchema, data: unknown): SchemaVerdict {
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as unknown[]).filter((key): key is string => typeof key === 'string')
    : [];
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};

  if (!isRecord(data)) {
    return { satisfied: false, missing: required.length > 0 ? required : ['<root>'] };
  }

  const missing: string[] = [];
  for (const key of required) {
    const value = data[key];
    if (value === undefined || value === null) {
      missing.push(key);
      continue;
    }
    const declared = properties[key];
    if (isRecord(declared) && !typeMatches(declared['type'], value)) {
      missing.push(key);
    }
  }

  if (required.length === 0) {
    return { satisfied: Object.keys(data).length > 0, missing: [] };
  }
  return { satisfied: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ *
 * Substance
 * ------------------------------------------------------------------ */

export interface SubstanceVerdict {
  /** Whether the data carries an answer, as opposed to the shape of one. */
  readonly substantive: boolean;
  /** Fields that are present and correctly typed, and say nothing. */
  readonly vacuous: readonly string[];
}

/**
 * Whole values that are the shape of an answer and not an answer.
 *
 * WHOLE VALUES ONLY, and that is the entire design of this list. A substring
 * test over these words rejects real answers — "the store is not available
 * today" and "no results were shown until the filter was cleared" both answer
 * the question they were asked, and both contain an entry below. Matching the
 * complete normalised value cannot make that mistake: a field holding exactly
 * `not found` is not an answer to anything.
 *
 * Every entry is a stock non-answer a model reaches for when it did not find
 * the value. Words that could be a genuine one-word answer are deliberately
 * absent: `error` and `failed` answer "what does the banner say", `0` and
 * `false` are answers, and neither is here.
 */
const NON_ANSWERS: Record<string, true> = {
  'n/a': true,
  'n a': true,
  na: true,
  nil: true,
  null: true,
  undefined: true,
  none: true,
  nothing: true,
  'nothing found': true,
  unknown: true,
  unclear: true,
  unavailable: true,
  missing: true,
  tbd: true,
  todo: true,
  'not found': true,
  'not available': true,
  'not applicable': true,
  'not specified': true,
  'not stated': true,
  'not provided': true,
  'not present': true,
  'not listed': true,
  'not visible': true,
  'not mentioned': true,
  'no answer': true,
  'no value': true,
  'no data': true,
  'no info': true,
  'no information': true,
  'no result': true,
  'no results': true,
  'i do not know': true,
  "i don't know": true,
  'i dont know': true,
  'do not know': true,
  "don't know": true,
  'dont know': true,
};

/**
 * One field's value, judged.
 *
 * The string arm normalises only as far as it must for the list above to mean
 * what it says — case, surrounding quotes and brackets, trailing sentence
 * punctuation, collapsed whitespace, and the typographic apostrophe a model
 * emits where the list has an ASCII one — so that `"Not found."` cannot smuggle
 * a non-answer past it on punctuation alone.
 */
function vacuousValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    const text = value
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\s"'`([{]+|[\s"'`)\]}.,;:!]+$/g, '')
      .trim()
      .toLowerCase();
    return text === '' || NON_ANSWERS[text] === true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0;
  }
  // A number, an integer, a boolean. `0` and `false` are answers.
  return false;
}

/**
 * Whether collected data ANSWERS, as distinct from whether it VALIDATES.
 *
 * {@link evaluateSchema} is correct and is not the place for this: `required`
 * means the property is present, `""` is a string, and a customer who asks for
 * `{ answer: string }` and wants an empty one is entitled to it. The defect was
 * never the validator — it was the loop reading shape validity as task
 * completion, so that the first `extract` writing anything at all into the only
 * required field ended a run with fifty steps left. This is the second opinion
 * that split apart: the verdict on the wire still comes from `evaluateSchema`,
 * and this decides only whether a satisfied schema may STOP the run.
 *
 * Mirrors `evaluateSchema`'s own quantifiers exactly, because the two are asked
 * about the same data on the same step and a different scope would read as a
 * bug: with `required`, every required field must answer; with no `required`,
 * where satisfaction is "at least one key", it takes one key that answers.
 *
 * Top-level only, for the reason `evaluateSchema` gives: a deeper walk starts
 * holding runs over data a customer would happily have taken.
 */
export function evaluateSubstance(schema: JsonSchema, data: unknown): SubstanceVerdict {
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as unknown[]).filter((key): key is string => typeof key === 'string')
    : [];
  if (!isRecord(data)) {
    return { substantive: false, vacuous: required.length > 0 ? required : ['<root>'] };
  }
  const keys = required.length > 0 ? required : Object.keys(data);
  const vacuous = keys.filter((key) => vacuousValue(data[key]));
  if (required.length === 0) {
    return { substantive: keys.length > vacuous.length, vacuous };
  }
  return { substantive: vacuous.length === 0, vacuous };
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export interface StatusInput {
  /** Set when a ceiling fired. Outranks everything: the caller chose it. */
  readonly cap?: CapName;
  /** The run threw, or the model chose `fail`. */
  readonly failed: boolean;
  readonly hasData: boolean;
  /**
   * Set when the run stopped because its owner cancelled it. A cancel is not
   * an outcome: a run that had already delivered something is `completed` and
   * that answer is real, and one that had not is `partial`, never `failed`.
   * The same rule `driveRun` in `@outcrawl/api` has always applied.
   */
  readonly cancelled?: boolean;
  /** `undefined` when no schema was supplied, so there is nothing to verify. */
  readonly schemaSatisfied?: boolean;
  /**
   * Set when the LOOP closed a sub-goal the model left open, rather than the
   * model closing it.
   *
   * Its own field rather than folded into {@link failed}, because it is a
   * different fact and it must not put an `error` string on a run that never
   * errored. Nothing threw and the model chose nothing — the run simply reached
   * its answer with outcomes it had said it would deliver and did not.
   */
  readonly abandonedGoals?: boolean;
  /**
   * The answer names its own gap — an item it marks "(missing)", "not
   * found", "not listed on the page" (see {@link answerMarksGap}). Such an
   * answer is not the whole answer, whatever the run's gates said, so the run
   * is `partial`, never `completed` (live10 on bundle 5f576d15, 2026-10-03:
   * `run_…` answered "61. (missing)" with ranks 62-70 shifted by one and
   * ended `completed`).
   */
  readonly answerGap?: boolean;
  /**
   * Set when the run bought RESULTS ON STEPS TAKEN AFTER ITS PLAN WAS ALREADY
   * FULLY CLOSED.
   *
   * The sibling of {@link abandonedGoals} and the opposite failure. That one is
   * a plan with errands nobody served; this one is work nobody planned — every
   * sub-goal `done` or `failed`, and the run then spending steps and buying
   * extractions that no sub-goal claims. A plan is the run's own statement of
   * its work, and `completed` beside a plan that describes a fraction of it
   * contradicts itself exactly as loudly.
   *
   * Measured on `run_…`, which asked for
   * three stories' comments: both sub-goals were closed `done` by step 10, the
   * second with the summary "Extracted top 3 comments for the FIRST story", and
   * the run then took 41 more steps and wrote 17 more `result` records. It
   * reported `completed` / `task-complete`, which is the status a run that
   * served all three would have carried.
   */
  readonly unplannedWork?: boolean;
}

/**
 * One place decides the status, so the loop cannot grow a second opinion.
 *
 * A cap outranks a failure: the run stopped because the caller said to stop,
 * and reporting that as a failure sends them looking for a bug in their task.
 *
 * A satisfied schema is NOT sufficient for `completed`, and that is the third
 * clause. A run that stated five errands, delivered one, and had the other four
 * closed for it by the loop has data worth returning and has not completed the
 * task it was given: `completed` there contradicts the run's own plan, which is
 * now on the wire beside it for anyone to read. It is `partial`, which is the
 * status this package already documents as normal rather than as an error.
 *
 * `unplannedWork` is the same clause read from the other end, and it is one
 * `||` rather than a second opinion for that reason: a plan that claimed to be
 * finished 41 steps and 17 extractions before the run stopped describes a
 * fraction of what the customer paid for, and the fraction is the thing they
 * are paying for.
 */
/** The words an answer uses to say one of its own items is absent. */
const GAP_WORDS = String.raw`missing|not found|not listed|not shown|not visible|not available|unavailable|not stated`;
/** `(missing)`, `[not found]` anywhere; a line or field that is only a gap word (`61. missing`, `French: Not listed on the page`). */
const GAP_MARKS: readonly RegExp[] = [
  new RegExp(String.raw`[([](${GAP_WORDS})[)\]]`, 'i'),
  new RegExp(String.raw`(^|\n|[:=]\s*|^\s*\d+[.)]\s*)(${GAP_WORDS})(\s+(on|from|in)\s+(the|this)\s+page)?\s*\.?\s*($|\n)`, 'im'),
];

/**
 * The first place an answer marks one of its own items absent, or
 * `undefined`. Reads every string in the answer — free text, or a schema
 * run's fields. Item markers only: a sentence that merely contains the word
 * ("the missing persons database") does not count, because the marker has to
 * stand in a value's place.
 */
export function answerMarksGap(answer: unknown): string | undefined {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(answer);
  // A value that is NOTHING but the word is a non-answer, not a gap in an
  // answer: `evaluateSubstance`'s door holds that one, with its own notice.
  const whole = new RegExp(String.raw`^\W*(${GAP_WORDS})\W*$`, 'i');
  for (const text of strings.filter((value) => !whole.test(value.trim()))) {
    for (const mark of GAP_MARKS) {
      const found = mark.exec(text);
      if (found !== null) {
        const line = text.slice(0, found.index + found[0].length).split('\n').filter((part) => part.trim() !== '').at(-1) ?? found[0];
        return line.trim().slice(0, 120);
      }
    }
  }
  return undefined;
}

export function resolveStatus(input: StatusInput): AgentStatus {
  if (input.cap !== undefined) {
    return 'capped';
  }
  if (input.cancelled === true) {
    return input.hasData ? 'completed' : 'partial';
  }
  if (
    input.failed ||
    input.schemaSatisfied === false ||
    input.abandonedGoals === true ||
    input.unplannedWork === true ||
    input.answerGap === true
  ) {
    return input.hasData ? 'partial' : 'failed';
  }
  return 'completed';
}

/**
 * WHY a run that nothing errored ended `failed` or `partial`, in a sentence a
 * customer can act on — or `undefined` when it ended neither way, or an error
 * already says why.
 *
 * {@link resolveStatus} returns `failed` (nothing collected) or `partial`
 * (something collected) for five things besides an error: an unsatisfied
 * schema, sub-goals the loop had to close, work the plan does not account for,
 * an answer that marks one of its own items absent, and a cancel. None of them
 * sets `error`, correctly, because nothing threw. But `error` is the ONE field
 * a run's reason travels in:
 *  - `failed`: without it the control plane wrote "the run failed and the
 *    machine serving it reported no reason". Production 2026-09-24
 *    14:00-14:05Z, three of three such runs (run_…, run_…,
 *    run_…).
 *  - `partial`: without it a customer got an answer, `stopReason:
 *    task-complete` and `partial`, and nothing anywhere saying what was short.
 *    Production 2026-10-03 run_… (the CLI README flight example).
 *
 * The sentence says what the run did not deliver and that no step failed, so
 * it is not read as a crash; the steps already hold what the agent saw.
 */
export function unmetReason(
  input: StatusInput & { readonly missing?: readonly string[]; readonly gap?: string },
  status: AgentStatus,
): string | undefined {
  if ((status !== 'failed' && status !== 'partial') || input.failed) {
    return undefined;
  }
  if (status === 'failed') {
    if (input.schemaSatisfied === false) {
      const missing = (input.missing ?? []).filter((field) => field !== '<root>');
      return (
        'The agent finished without extracting the data this run’s schema requires ' +
        `(${missing.length === 0 ? 'nothing was extracted' : `missing: ${missing.join(', ')}`}), so there ` +
        'is nothing to return and the run counts as failed. No step errored: the steps show what ' +
        'it saw and where it stopped.'
      );
    }
    if (input.abandonedGoals === true) {
      return (
        'The agent finished with sub-goals of its own plan still open and nothing extracted, so ' +
        'the run counts as failed. No step errored: the plan on this run shows which goals were ' +
        'left open.'
      );
    }
    return (
      'The agent finished with nothing extracted and work its own plan does not account for, so ' +
      'the run counts as failed. No step errored: the steps show what it did.'
    );
  }
  if (input.cancelled === true) {
    return 'The run was cancelled before it produced an answer.';
  }
  const reasons: string[] = [];
  if (input.schemaSatisfied === false) {
    const missing = (input.missing ?? []).filter((field) => field !== '<root>');
    reasons.push(
      `the answer does not satisfy this run’s schema${missing.length === 0 ? '' : ` (missing: ${missing.join(', ')})`}`,
    );
  }
  if (input.abandonedGoals === true) {
    reasons.push('the agent stopped with sub-goals of its own plan still open, so the answer covers part of the task');
  }
  if (input.unplannedWork === true) {
    reasons.push('the agent kept working after its plan said the task was done, so the answer may not cover all of it');
  }
  if (input.answerGap === true) {
    reasons.push(
      `the answer marks an item it could not find${input.gap === undefined ? '' : ` (“${input.gap}”)`}`,
    );
  }
  if (reasons.length === 0) return undefined;
  return (
    `The run returned an answer but counts as partial: ${reasons.join('; ')}. No step errored: the ` +
    'steps show what the agent saw.'
  );
}

/* ------------------------------------------------------------------ *
 * The wire form
 * ------------------------------------------------------------------ */

/**
 * Projects one step onto core's `AgentStep`, for a caller streaming steps as
 * they happen.
 *
 * Core's `AgentStep.action` is an `ObservedAction`, which requires a `ref` and
 * an `xpath`; `navigate`, `extract`, `done` and `fail` name no node. Those
 * emit `ref: '0-0'` and `xpath: ''` — 0 is Blink's invalid node id, so the
 * pair reads as "no node" rather than as a reference that could be resolved.
 * Neither is a heal path and neither should be followed.
 *
 * `spent` and `pages` cross because this projection is the ONE SEAM a live
 * counter can be read from. `@outcrawl/api` already derives `stepsUsed` from
 * `index + 1` here and writes it to the run row on every heartbeat; it had no
 * page count and no billable figure to write beside it, so it wrote the zeroes
 * it was holding. Two fields on the frame that already arrives is the whole
 * fix, and it cannot drift from the ledger the budget cap is enforced against
 * because it IS that ledger, read at the step it was read for.
 */
export function toWireStep(step: StepTrace): AgentStep {
  const action: ObservedAction = step.observed ?? {
    ref: '0-0',
    description: describeAction(step.action),
    method: step.action.type,
    xpath: '',
  };
  return {
    index: step.index,
    action,
    ...(step.reasoning !== undefined ? { reasoning: step.reasoning } : {}),
    at: step.at,
    ...(step.tab !== undefined ? { tab: step.tab } : {}),
    // Which sub-goal this step was working. Dropped here until now, for the
    // same reason `tab` was: nothing outside the loop could attribute a step to
    // an outcome, so a scorer counting long-horizon progress off these frames
    // had nothing to count and could not tell that it had nothing.
    ...(step.goal !== undefined ? { goal: step.goal } : {}),
    spent: step.spent,
    pages: step.pages,
    durationMs: step.durationMs,
    usage: { ...step.usage, cache: step.cache },
    ...(step.extractCut !== undefined ? { extractCut: step.extractCut } : {}),
    ...(step.verification !== undefined ? { verification: step.verification } : {}),
  };
}

/**
 * What became of a run's recording, as the host that armed it knows.
 *
 * Three states, and the union is what makes the fourth unrepresentable: a run
 * cannot carry both a replay link and a caller's refusal, so
 * {@link toWireResult} has nothing to validate and no way to be called wrongly.
 *
 *   * `{ url }` — a recording exists. Possibly still sealing; the link works
 *     either way.
 *   * `'declined'` — the caller declined it with `AgentRequest.record: false`.
 *     Nothing was armed and no bytes were written.
 *   * `null` — one was wanted and not obtained. Ours to fix.
 *
 * The string arm rather than `{ declined: true }` on purpose: there is exactly
 * one thing to say about a refusal, and an object would invite a second field
 * that the wire has nowhere to put.
 */
export type RunReplay = { readonly url: string } | 'declined' | null;

/**
 * Projects a run onto `@outcrawl/scout-core`'s `AgentResult`, which is what `POST
 * /agent` returns. Status, data and stop reason pass through unchanged; the
 * step trace does not cross, because the replay is where a run is watched.
 *
 * `durationMs` crosses, and it did not used to. Browser time is billed per
 * minute the run is open, and the minute was measured here the entire time,
 * by the same monotonic clock `CapBudget` enforces `AgentCaps.duration`
 * against. It was simply not projected.
 *
 * `pages` crosses for the same reason it was missing: a customer reads how
 * many pages their run loaded, and `@outcrawl/api` had no page count to
 * report.
 *
 * It is a REQUIRED ARGUMENT rather than a field on {@link AgentResult}, and that
 * placement is the decision. The loop cannot count pages honestly — it sees only
 * the URL of the tab it snapshots, so it would infer a navigation from that URL
 * changing, missing a reload, a POST that re-renders the same URL, and any load
 * in a tab it is not looking at. The browser session counts real page loads and
 * is already the source of `SessionSummary.pages`, so taking it from there means
 * the invoice and the session view are one number from one increment instead of
 * two tallies to reconcile in front of a customer. Required and positional so
 * the host cannot omit it: an optional page count reads as a legal zero-page
 * invoice rather than a missing field.
 *
 * `credits` crosses too: `CapLedger.billing().credits`, the run's own final
 * figure — model usage, browser time and bandwidth at the run's plan — the
 * same figure `caps.budget` stopped (or did not stop) the run against.
 * Withholding it once let `settleRun` price the run from `meter.credits()`
 * instead, which structurally never sees `proxy_bytes`; measured on
 * `run_...d31bfcd6` (2026-09-23) as `35.063744` reported against
 * `35.201944` charged. `@outcrawl/scout-core`'s `credits` is OPTIONAL rather than
 * required so a test double with no runtime ledger still type-checks.
 *
 * `modelCharge` rides beside the customer's result, not in it: see
 * `SettledAgentResult`. It is what the settlement meters `model_cost_usd`
 * from, at the plan the run was priced at.
 *
 * `replay` is the run's recording in THREE states, and it is one argument
 * rather than a url plus a flag so that the fourth, contradictory state — a
 * link on a run the caller refused to have recorded — cannot be constructed at
 * all. Validating against it would be catching a call that should not compile.
 *
 * `{ url }` means a recording exists, including one still sealing:
 * `sessions.replay_key` is written the moment the recorder arms, so a run
 * whose bytes are still flushing carries its link, which is what makes a live
 * follow work.
 *
 * `'declined'` means the CALLER declined it with `AgentRequest.record: false`.
 * No recorder was ever armed and no bytes were written. The wire result then
 * carries no `replayUrl` and `recordingDeclined: true`.
 *
 * `null` means one was WANTED and not obtained — the sink declined, the
 * browser refused to arm, or the host was booted with no replay credential.
 * `packages/worker/src/main.ts` `replayStore()` says why that host is
 * supported rather than refused: it records into a Map freed when the process
 * exits, so a link it published would 404 for the whole retention window.
 *
 * Both of the last two spread `replayUrl` away, because
 * `WireAgentResult.replayUrl` is optional and an absent field reads as "this
 * run was not recorded" where a dead link reads as "your product is broken".
 * What separates them on the wire is `recordingDeclined`, which is present
 * only on the refusal: an absent `replayUrl` used to mean both, which is a
 * satisfied request and an incident wearing one face.
 */
export function toWireResult(
  result: AgentResult,
  replay: RunReplay,
  pages: number,
): SettledAgentResult {
  return {
    // Model usage in provider dollars, for the settlement's `model_cost_usd`
    // row — internal, see `AgentModelCharge`. Never on a customer response.
    modelCharge: {
      usd: result.billedModelCostUsd,
      measuredUsd: result.modelCostUsd,
      plan: result.pricing.plan,
      byok: result.pricing.byok,
    },
    id: result.id,
    status: result.status,
    // SPREAD-GUARDED, and that is the whole contract fix for the empty case.
    // `WireAgentResult.data` is optional, so a run with nothing to report omits
    // the field deliberately. Assigned unconditionally it was omitted anyway —
    // `JSON.stringify` erases an `undefined` value — but the type said the
    // field was required, so we declared a mandatory key and shipped responses
    // without it. Same class as the `replayUrl` spread below: absent because we
    // meant absent, not because a serializer swallowed it.
    ...(result.data !== undefined ? { data: result.data } : {}),
    usage: { ...result.usage, cache: aggregateCache(result.steps) },
    durationMs: result.durationMs,
    // What the budget paid for, when it could not fund everything measured:
    // the API meters it, so the ledger prices exactly `credits` below.
    ...(result.billedMs !== undefined ? { billedMs: result.billedMs } : {}),
    // The run's own final, ledger-priced figure — see this function's own
    // header for the incident this closes. Always present in practice:
    // `runAgent` sets it unconditionally, this getter never throws, and it
    // is `'0.000000'` rather than absent for a run that spent nothing.
    credits: result.credits,
    ...(typeof replay === 'object' && replay !== null ? { replayUrl: replay.url } : {}),
    // Present only on a refusal, and typed `true` on the wire so there is no
    // `false` to write. A run that was wanted-and-not-recorded says nothing
    // here, which is what distinguishes ours from the caller's decision.
    ...(replay === 'declined' ? { recordingDeclined: true as const } : {}),
    stepsUsed: result.stepsUsed,
    stopReason: result.stopReason,
    pages,
    // The five completions behind the one report. Absent rather than `[]` on a
    // run with no plan: an empty array reads as "asked and answered nothing".
    //
    // `GoalState` is structurally core's `AgentGoal` and is spread rather than
    // rebuilt field by field, because a hand-copied projection is exactly how
    // this field came to be missing in the first place.
    ...(result.goals.length > 0 ? { goals: result.goals } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
