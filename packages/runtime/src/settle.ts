/**
 * Render settling: deciding whether the page in front of the loop has actually
 * rendered, and waiting for it if it has not.
 *
 * ## The defect this exists for
 *
 * Measured in production twice on one task. `AgentDeps.perform({type:'navigate'})`
 * resolves when `Page.navigate` resolves, which is main-frame COMMIT — the
 * response has started, nothing is painted, and on a JS-rendered site nothing
 * is hydrated. `SessionTabs.open` in `@outcrawl/worker` hands the first page
 * back on the same terms. Nothing on the agent path waits for
 * `Page.loadEventFired`, `Page.frameStoppedLoading`, a quiet network or a frame
 * of animation, so the first snapshot of a run is routinely taken against a
 * document that has committed and not rendered.
 *
 * The model then does the only reasonable thing with a tree that has no
 * controls in it: `{"type":"fail","reason":"No input fields are visible in the
 * provided accessibility tree."}` — an action the loop advertises on every
 * prompt. One run of the pair died on step 2 in 3.6 s at 1,513 input tokens;
 * the other completed the same task in 15 steps. A third run asking only for a
 * description of the page saw all three controls at 6,272 tokens, so the tree
 * is correct once the page has rendered.
 *
 * ## Why the wait cannot live inside the action-lock
 *
 * `AgentDeps.lock` is `Outcrawl.lock`, which is `ScopedIgnoreInputEvents` in
 * the browser and `VirtualTimePolicy::kPause` in the renderer. A frozen page's
 * timers are stopped, so it cannot render while the loop holds it — the same
 * fact `@outcrawl/worker`'s `frozen` bookkeeping is there to prevent, where a
 * tab left locked "would then never load, never fire a timer and never answer a
 * snapshot". So this was never a race lost half the time by luck: past commit,
 * freezing the page GUARANTEES it cannot finish rendering for the read. It also
 * rules out the obvious wrong fix — a sleep, or any wait, between `lock` and
 * `snapshot` is dead time by construction. Settling happens at lock depth 0,
 * with the page live. See `PageSession.settle`.
 *
 * ## The signal, and why it is not size
 *
 * A page can be legitimately almost empty, so treating SMALL as BROKEN would
 * hang on sparse pages forever. Size is also not what went wrong: 1,513 tokens
 * was a React shell plus the prompt's own scaffolding, not an empty tree.
 *
 * MEASURED, against the shipped binary, navigating to `www.saucedemo.com` three
 * times. `Page.navigate` resolves — commit — at 173-233 ms, and then the page
 * passes through FOUR states, not two:
 *
 *     t+0 .. +30-130ms   `Outcrawl.getAXTree` THROWS -32000 "No accessibility
 *                        tree was produced". There is no tree at all yet.
 *     .. +100-250ms      a ROOT-ONLY tree: nodes=1, no children, and the site's
 *                        real url. HASH-STABLE across reads 100 ms apart, and
 *                        its hash is byte-identical to `about:blank`'s, because
 *                        `hashSnapshot` deliberately excludes the url.
 *     from ~400ms        nodes=13, actionable=3 — Username, Password, Login —
 *                        and stable from then on.
 *
 * So the rules, all read off the RAW tree before `filterTree`, because
 * filtering first and then asking whether anything is there is how you conclude
 * a page is empty because you emptied it:
 *
 *     an actionable node AND the tree has STOPPED GROWING    -> go now
 *     an actionable node and it is still growing, and the
 *       growth budget is spent                               -> go now, `growing`
 *     no actionable node, root HAS children, one hash
 *       held for `quietMs`                                   -> go now
 *     root-only AND the url is a blank document               -> go now
 *     root-only at a real url, or the read threw              -> wait
 *
 * The quiet rule is the one a reader will be tempted to delete, and it is the
 * only thing between us and a legitimately sparse page timing out on every
 * single read. A page with no controls is a real page — a text-only article, an
 * error body — and what separates it from an unrendered one is that it has
 * STOPPED CHANGING, not that it is small. SMALL IS NOT BROKEN. Anyone
 * "improving" this with a node-count or character floor hangs every sparse page
 * for the whole budget on every read.
 *
 * The blank rule is the one a reader will be tempted to call a special case, and
 * it is not: `about:blank` is DEFINED to have no content, so waiting for it to
 * grow some is waiting for something that cannot happen, and every run whose
 * first action is a `navigate` starts there. The url is the only thing that
 * separates it from state two above, whose hash is identical.
 *
 * A degenerate real page — `<html></html>` at a real url — is root-only and
 * never satisfies the quiet or blank rules, so it costs the whole budget once
 * per read and is then handed to the model anyway. Named rather than fixed: the
 * alternative is accepting root-only trees at real urls, which is precisely the
 * production failure.
 *
 * ## Why the first rule is GROWTH and not just "something to act on"
 *
 * `link` is in {@link ACTIONABLE_ROLES}, so essentially every rendered page has
 * something actionable in it the instant its NAV BAR paints — while its article,
 * its product block and its reviews are still arriving. Until 2026-09-08 that
 * alone ended the settle, and this is what it cost, measured by `Diagnose` with
 * this module's own `settleTree` and `DEFAULT_SETTLE_POLICY` against 22 real
 * pages, each compared with the same page polled to stability:
 *
 *     verdict=actionable on 22 of 22 urls, polls=1 on 11 of them
 *     served text under 95% of the settled page on 7 of 22
 *     amazon product page   1,095 chars served vs 23,590 settled      5%
 *     allrecipes recipe    13,336 chars        vs 18,693             71%
 *
 * A 5% read is a nav bar. `wv-allrecipes-17` failed for exactly this: 388 nodes
 * served where the settled page has 549, and the literal "easy to make" is in
 * the settled tree and not in the one the loop got.
 *
 * So the first rule now asks a second question — has the tree STOPPED GROWING —
 * and the criterion is growth rather than stability on purpose:
 *
 *   - Stability is UNREACHABLE on the live web. An ad, a ticker, a clock or a
 *     carousel changes the hash forever, so a hash rule would poll to the
 *     ceiling on a page that has been complete for seconds. That is why the
 *     `quietMs` arm is only ever reached by a page with nothing actionable on
 *     it.
 *   - Growth TERMINATES, because it is measured against a MONOTONE HIGH-WATER
 *     MARK of nodes and of content mass. A carousel that swaps a 40-character
 *     caption for another 40-character caption never exceeds its own maximum, so
 *     it is not growth and cannot hold the loop. Only genuine accumulation — a
 *     comment feed, a stock tape — keeps pushing the mark up, and
 *     `growthBudgetMs` is the answer to that.
 *
 * The high-water mark is the part that looks like over-engineering and is not.
 * Comparing each poll with the PREVIOUS poll makes any oscillation read as
 * growth forever; comparing with the maximum ever seen makes a bounded
 * oscillator produce at most one growth event per new record and then go quiet.
 *
 * Content mass — the summed length of every name and value — is the primary
 * signal rather than node count, because `Truncation` measured 282 production
 * reads and found literal survival tracking mass and not nodes: on
 * `wv-apple-17` the 3-node and the 21-node reads both miss the answer and the
 * 226-node read has it, so a rendered 22-node nav bar looks like progress by
 * node count and looks like nothing by mass.
 *
 * ## The caller's read is poll zero
 *
 * `settleTree` takes the tree the caller has ALREADY read as `seen`, so proving
 * "this page has stopped growing" costs one extra snapshot instead of a fresh
 * two-poll settle. It is stamped as observed at the settle's START rather than
 * at its true, earlier time, so the shortcut can only ever make the settle wait
 * LONGER than the truth and never shorter: a shortcut that can only err toward
 * patience is safe, one that can err toward haste is the defect being fixed.
 *
 * ## A poll and not a sleep
 *
 * The same argument `serpReaderFor` makes in `@outcrawl/worker`'s render path:
 * "A poll and not a sleep, because `Page.navigate` resolves on the COMMIT of
 * the main frame's document... the fix is not a longer guess. The loop stops
 * the moment rows appear, so a fast engine costs one round trip and only a slow
 * one pays." Identically here, and it is also the ruling this package already
 * recorded for the dropped first keystroke: a fixed idle was rejected because
 * the window is a property of the page and the hardware, not a number we know.
 *
 * ## A document that is not the page, and never was going to be
 *
 * Every rule above asks "has this page finished arriving". None of them can
 * ask "is this a page at all", and there is a whole class of document where
 * that is the only question worth asking: a vendor's bot-check interstitial,
 * served at the site's own address in place of its content.
 *
 * The loop had no word for one. MEASURED, `run_…` on
 * `www.nordstrom.com`, 2026-09-11: the document was Imperva's interstitial —
 * zero rendered text over 252,998 bytes of obfuscated script — and the model,
 * shown a tree with nothing in it and told only that the page "may still be
 * loading", reported the run's headline finding as an ABSENCE: "No product
 * categories, featured products, or navigation links were found in the
 * provided accessibility tree." The real page arrived about 1.7 seconds later,
 * because Imperva clears itself; three steps and the answer were spent on a
 * document that was about to replace itself.
 *
 * So the settle asks the question, and it asks it with the detector that
 * already exists rather than a second one of its own. `interstitialOf` in
 * `@outcrawl/scout-core` is keyed on the document's own BODY precisely because a
 * behavioural vendor rewrites the site's page in place and loads no vendor URL
 * at all — there is nothing for a URL table or a browser event to see — and it
 * conjoins that marker with the same text floor the renderer uses, because an
 * unchallenged `zillow.com` carries `_pxAppId` on 3,170 characters of real
 * page. The scrape path (`runPipeline` in `@outcrawl/render`) has run exactly
 * this gate since 2026-09-10; this is the same gate on the agent path, not a
 * sibling of it.
 *
 * ### What the settle DOES about one, which is the whole point
 *
 * `INTERSTITIAL_SELF_CLEARS` splits the answer, and the split is measured:
 * Imperva's own script produces the real page at t+1,696 ms, `awswaf` commits a
 * second document at t+1,330 ms, DataDome clears at 5.3-5.9 s, while Kasada
 * answered `www.canadagoose.com` with a 429 three consecutive times.
 *
 *   self-clearing -> KEEP POLLING, to the budget. Handing the shell to the
 *     model costs a step and a model call to describe a document that is about
 *     to be replaced, and that is precisely what was measured above. This is
 *     the same argument the settle already makes for a page mid-render; a
 *     challenge is just the case where the tree stops moving and still is not
 *     the page, which is what lets it out through the `quiet` arm early.
 *
 *   not self-clearing, or the budget is gone -> `verdict: 'challenge'`, at
 *     once. Re-reading a document that has been measured never to relent buys
 *     nothing, and the model is owed the truth now rather than ten seconds
 *     from now.
 *
 * Nothing here solves a challenge, and that is deliberate. The solve path is
 * `PageSession.withSolve`, driven by the browser's own `Outcrawl.challengeSolving`
 * — and a body-signature interstitial emits no such event by construction, so
 * there is nothing here to route. This module's job is that the loop and the
 * model KNOW. See {@link challengeNotice}.
 *
 * ### What the document read costs, and why it is not on every poll
 *
 * The read is the whole DOM serialised (`outerHTML`), so it is spent only on a
 * document that the tree already says is contentless: the probe is consulted
 * at the moment a verdict is about to be returned, and only when the tree's
 * own content mass is under the caller's floor. A page with 256 characters of
 * accessible names never pays a byte. The two quantities are not the same
 * quantity — AX mass is names and values, the floor is rendered text — and
 * that is safe in the one direction that matters: a real page that is tiny by
 * mass pays one read and is answered `null` by the detector, while nothing
 * over the floor can hide a challenge, because `interstitialOf` would call it
 * a page anyway.
 *
 * Every wait goes through the injected `Clock`, so a test drives a virtual
 * clock instead of sleeping.
 */

import {
  type Clock,
  type Interstitial,
  INTERSTITIAL_CONTROLS,
  INTERSTITIAL_PRESS_ATTEMPTS,
  INTERSTITIAL_SELF_CLEARS,
  interstitialOf,
  interstitialReadCeiling,
} from '@outcrawl/scout-core';

import { ACTIONABLE_ROLES, hashSnapshot, type AxNode, type AxTree } from './snapshot';

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

export interface SettlePolicy {
  /**
   * The ceiling on ONE page read, in milliseconds.
   *
   * Spent only on a page with nothing actionable on it that is still changing,
   * and the caller clamps it to what the run's `duration` cap has left, so a
   * settle can never overrun a ceiling the customer set.
   */
  readonly budgetMs: number;
  /** The first gap. Small, because most late renders are late by one frame. */
  readonly firstIntervalMs: number;
  /** The gap stops doubling here, so a long wait is still ~10 polls not 200. */
  readonly maxIntervalMs: number;
  /**
   * How long a page with nothing actionable on it must hold ONE hash before it
   * is accepted as a real, sparse page.
   *
   * A span and not a poll count, because polls are not time: at a 50 ms first
   * interval, "two identical reads" is 50 ms of evidence, and 50 ms of evidence
   * is not enough. MEASURED against the shipped binary on `saucedemo.com`: after
   * `Page.navigate` commits, `Outcrawl.getAXTree` answers with a ROOT-ONLY tree
   * — `nodes: 1`, no children, the site's real URL — and holds it, hash-stable,
   * for 100 to 250 ms before React mounts anything. A poll-count rule accepted
   * that at 50 ms and handed the model exactly the empty tree the production run
   * refused. 250 ms clears the whole of that measured window.
   */
  readonly quietMs: number;
  /**
   * How long the tree must stop GROWING before a page with something actionable
   * on it is accepted.
   *
   * This is the dial that decides both halves of the trade, and both were
   * measured on one captured timeline per url (see
   * `packages/bench/scripts/price-settle-policy.ts`): it is the content this
   * recovers on a page that is still arriving, and it is ALSO the tax an
   * already-settled page pays on a step, because a page that has stopped has to
   * hold still for this long to prove it.
   */
  readonly growthQuietMs: number;
  /**
   * The ceiling on waiting for growth to stop, distinct from {@link budgetMs}
   * and far tighter.
   *
   * `budgetMs` governs a page with NOTHING to act on, which is a page the step
   * would have failed on anyway, so ten seconds there is nearly never spent. A
   * page that HAS something to act on is already usable, so every millisecond
   * spent improving it is charged to a customer whose `caps.duration` is
   * ticking. When this expires the tree goes to the model with
   * `verdict: 'growing'` — the page was still filling in and we stopped waiting,
   * which is a different outcome from a settled page and is recorded as one.
   *
   * Never allowed to exceed `budgetMs`, so a caller that clamped the budget to
   * what the duration cap has left cannot be overrun through this field.
   */
  readonly growthBudgetMs: number;
  /**
   * THE CEILING FOR A PAGE STILL ARRIVING, past {@link budgetMs}: a document
   * still being parsed ({@link DocumentProbe.parsing}) with nothing actionable
   * on it, on a tab the network was still delivering to within
   * {@link RECEIVING_WINDOW_MS} ({@link DocumentProbe.lastNetworkAt}). Only
   * then: a page that has gone silent, or one a model can already act on,
   * ends at `budgetMs` as before. `budgetMs` 0 (`settle: false`) waits for
   * nothing, this included; a caller that clamps `budgetMs` to its caps
   * clamps this the same way.
   *
   * MEASURED, run_… (production 2026-10-03 10:37Z, demoqa, n=1, from
   * its replay): the 436-byte document committed at 3.6 s, its 921 KB module
   * bundle took 17.3 s through the run's exit (~53 KB/s) and held
   * `DOMContentLoaded` until ~20.9 s. The settle stopped at the 10 s budget
   * with `parsingMs` 9,840 and reported `unrendered`, and the run spent four
   * steps (wait, navigate again, a second tab, a look) on a page that was
   * still downloading.
   */
  readonly loadingBudgetMs: number;
}

/**
 * How recently the tab must have received something for a document still
 * being parsed to count as arriving (see {@link SettlePolicy.loadingBudgetMs}).
 * A body streams in chunks of at most 64 KiB, so 3 s still sees one at
 * ~22 KB/s, under half the slowest exit measured (run_…, ~53 KB/s).
 */
export const RECEIVING_WINDOW_MS = 3_000;

/**
 * The time a document that finished arriving after {@link SettlePolicy.budgetMs}
 * is given to render: past the budget, `budgetMs` itself would end the settle
 * on the first read after `DOMContentLoaded`, before an app bundle that just
 * ran had drawn anything. The growth ceiling's own measured window.
 */
const ARRIVED_GRACE_MS = 2_500;

/**
 * Ten seconds, 50 ms escalating to 800 ms, a quarter-second of stability, and a
 * quarter-second of no growth under a 2.5 s growth ceiling.
 *
 * `budgetMs` is generous because it is nearly never spent: it is reached only by
 * a page that produces no interactive node and never holds still for ten
 * seconds, which is a page the step was going to fail on anyway. The escalation
 * is what keeps a fast page fast — a render that lands at 60 ms is caught at
 * 50 ms, not at the end of a fixed interval — while a page that takes eight
 * seconds costs ~15 snapshots rather than 160.
 *
 * `growthQuietMs: 250` IS THE KNEE OF A MEASURED CURVE, not a guess, and the
 * curve is in `packages/bench/results/settle-policy.md`. This module's real
 * `settleTree` was replayed on a virtual clock against 21 live poll timelines
 * captured on 2026-09-08, each poll charged the read latency it actually
 * measured. Served/settled content, and the wait added to a step that has to
 * settle:
 *
 *     growthQuietMs      content served      urls under 95%      added ms
 *              0              92.3%             3 of 21          +122 / +103
 *            150              92.5%             3 of 21          +281 / +257
 *            250              98.5%             1 of 21          +484 / +294
 *            400              98.6%             1 of 21          +786 / +477
 *            600             100.0%             0 of 21        +1,310 / +779
 *
 * (added ms: median on a navigating step / median on an already-settled page.)
 * 250 buys six points of content for 37 ms; 400 buys a tenth of a point for
 * another 183; 600 buys the last 1.4 points for 485. So the ratio stops
 * improving materially per millisecond bought exactly here.
 *
 * That it lands on the same number as `quietMs` is not a coincidence and not a
 * shared constant: both are measuring the same physical thing from different
 * sides — a mid-render page holds one state for up to about a quarter-second
 * before the next chunk arrives. They are separately named because a future
 * measurement can move one without the other.
 *
 * `growthBudgetMs: 2_500` covers the whole of the measured arrival window:
 * `Diagnose` timed 1,755-2,707 ms to stability over 3-4 reads on these pages,
 * and the worst url in the replay settles at 2,109 ms.
 */
export const DEFAULT_SETTLE_POLICY: SettlePolicy = {
  budgetMs: 10_000,
  firstIntervalMs: 50,
  maxIntervalMs: 800,
  quietMs: 250,
  growthQuietMs: 250,
  growthBudgetMs: 2_500,
  loadingBudgetMs: 30_000,
};

/* ------------------------------------------------------------------ *
 * Reading the tree
 * ------------------------------------------------------------------ */

/** What a poll saw. The numbers a notice and a step trace quote come from here. */
export interface TreeSurvey {
  /** Every node including the root. */
  readonly nodes: number;
  readonly actionable: number;
  /**
   * CONTENT MASS: the summed length of every name and value on the tree.
   *
   * The growth signal, and the primary one — see the module comment on why mass
   * beats node count. Summed rather than concatenated because this is asked of
   * every poll of every settle and a joined string would allocate the whole
   * page to measure it.
   */
  readonly chars: number;
}

/**
 * Counts nodes, actionable nodes and content mass in one pass.
 *
 * One pass and no allocation, because the settle asks this of every poll of
 * every step. It COUNTS rather than early-exiting on the first actionable node,
 * which is what its predecessor `hasActionable` did: "at least one link" is the
 * signal that served a 5% page as a finished one, and the report is evidence, so
 * a number is owed rather than a boolean.
 */
export function surveyTree(tree: AxTree): TreeSurvey {
  let nodes = 0;
  let actionable = 0;
  let chars = 0;
  const visit = (node: AxNode): void => {
    nodes += 1;
    if (ACTIONABLE_ROLES.has(node.role)) {
      actionable += 1;
    }
    chars += (node.name?.length ?? 0) + (node.value?.length ?? 0);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(tree.root);
  return { nodes, actionable, chars };
}

/* ------------------------------------------------------------------ *
 * The settle
 * ------------------------------------------------------------------ */

/**
 * Why the settle stopped.
 *
 * `unrendered` is the only one that is not a green light, and it is still not an
 * error: the tree goes to the model anyway, with the truth about the wait
 * carried on the prompt's `notice`, because a model told "nothing appeared in
 * ten seconds" can reload or navigate, and that is a better move than anything
 * this module could pick on its behalf.
 *
 * `challenge` is the one verdict that is not about rendering at all: the
 * document under the tree tests as a vendor bot-check interstitial, so it is
 * not the site's page and no amount of further waiting will make it one — see
 * the module comment. It is what the loop and the model are told instead of
 * `unrendered`, whose notice ("it may still be loading") is true of a challenge
 * and useless about one.
 *
 * `actionable` and `growing` are BOTH usable trees and they are deliberately
 * two words: `actionable` is a page that stopped growing before we stopped
 * waiting, `growing` is a page that was still filling in when `growthBudgetMs`
 * ran out. A failing state that renders identically to a passing one is how a
 * whole night of late-render loss stayed invisible, so the distinction is on the
 * report and in the trace.
 */
export type SettleVerdict =
  | 'actionable'
  | 'growing'
  | 'quiet'
  | 'blank'
  | 'unrendered'
  | 'challenge';

export interface SettleReport {
  readonly verdict: SettleVerdict;
  /** Real elapsed milliseconds, rounded. Never a nominal or intended figure. */
  readonly waitedMs: number;
  /** Snapshots taken by the settle. Excludes the caller's own read. */
  readonly polls: number;
  /**
   * Reads that THREW. Its own count because it is its own state: for the first
   * 30-130 ms after a commit the browser answers `Outcrawl.getAXTree` with
   * -32000 and there is no tree to survey at all.
   */
  readonly failedReads: number;
  readonly nodes: number;
  readonly actionable: number;
  /** Content mass at the moment the settle returned. See {@link TreeSurvey}. */
  readonly chars: number;
  /**
   * The longest span, in milliseconds, over which one hash was held. What
   * separates "this page has stopped" from "this page is still being built", and
   * reported because it is the evidence for the verdict.
   */
  readonly stableMs: number;
  /**
   * Milliseconds from the settle's start to the last poll that pushed the
   * content-mass or node high-water mark up. The evidence for `actionable`
   * versus `growing`: a page whose mass was still climbing when the settle
   * returned has this within `growthQuietMs` of {@link waitedMs}.
   */
  readonly grewMs: number;
  /**
   * The vendor interstitial this document tested as, when it tested as one.
   *
   * Present with `verdict: 'challenge'` — the document in hand IS the
   * interstitial — and present with an ordinary verdict when the challenge
   * CLEARED while the settle waited it out, which is the outcome the wait
   * exists to buy and is worth a trace row of its own. Absent on every page
   * nobody challenged, which is nearly all of them.
   */
  readonly interstitial?: Interstitial;
  /**
   * Milliseconds from the settle's start to the last poll that found the
   * document still being parsed ({@link DocumentProbe.parsing}). Absent when
   * no poll did, which is every page that had finished parsing before it was
   * read. Present on a verdict reached after the wait, it is what the wait for
   * the document cost; present on `growing` or `unrendered`, the budget ran
   * out first.
   */
  readonly parsingMs?: number;
  /**
   * Milliseconds from the settle's start to the newest network activity on
   * the tab it saw ({@link DocumentProbe.lastNetworkAt}), when the settle
   * waited on a document still arriving. With `parsingMs` near `waitedMs` it
   * says the page was still downloading when the settle stopped.
   */
  readonly receivingMs?: number;
}

/**
 * Whether this url is a document that is EMPTY BY DEFINITION rather than one
 * that has not finished.
 *
 * `about:blank` is where every tab starts and where every run whose first action
 * is a `navigate` begins, and its tree is root-only and hash-identical to a
 * committed-but-unmounted document — so without this, either the loop waits ten
 * seconds for `about:blank` to grow content it can never grow, or it accepts the
 * unmounted document that killed the production run. The url is the only thing
 * that tells the two apart.
 *
 * Every `about:` url, not a list of two: `about:srcdoc`, `about:newtab` and the
 * rest are all documents whose content is not coming over the network. `''` is
 * an emitter that has no url to report, which is the same case.
 */
export function isBlankDocument(url: string): boolean {
  return url === '' || url.startsWith('about:');
}

/** One settled document's bytes, as much of it as the challenge gate needs. */
export interface SettledDocument {
  /** The document as the renderer has it: post-script, pre-transform. */
  readonly html: string;
  /** Rendered text length at the instant of the read. */
  readonly textLength: number;
}

/**
 * THE DOCUMENT SEAM, and the floor that goes with it.
 *
 * Injected on {@link AgentDeps} exactly as the tree read is, because this
 * package speaks no CDP. Absent means "this host cannot read the document
 * bytes", and then the settle behaves precisely as it did before the challenge
 * gate existed — every implementer of that shape is a test or a bench.
 *
 * The floor rides on the seam rather than on this module's policy, and it is
 * not a field looking for a home: `@outcrawl/scout-core`'s `DocumentUnderTest`
 * requires the caller to pass it, because `DEFAULT_MIN_TEXT_LENGTH` in
 * `@outcrawl/render` and `kChallengeTextFloor` in the fork are already the same
 * number and a copy here would be the third. The host that can read the
 * document is the host that holds that constant.
 *
 * Read with the page LIVE, from inside the settle, which is the only place in
 * a step where that is true: a frozen page is `VirtualTimePolicy::kPause`, and
 * a challenge that would have cleared cannot clear under the freeze.
 */
export interface DocumentProbe {
  /** Below how many rendered characters a document is not evidence of a page. */
  readonly textFloor: number;
  read(): SettledDocument | Promise<SettledDocument>;
  /**
   * Whether the document that last committed is STILL BEING PARSED: it has
   * committed and its `DOMContentLoaded` has not fired. A host answers from
   * the browser's own events, never from the page, and bounds the answer in
   * time so a lost event cannot hold every settle after it.
   *
   * Optional: absent means "this host cannot tell", and the settle decides on
   * the tree alone, exactly as it did before this existed.
   *
   * WHY THE TREE ALONE IS NOT ENOUGH. A page's HTML streams in, and the
   * parser can sit on a prefix of it for a second or more with that prefix
   * holding perfectly still. MEASURED through production 2026-10-03 04:24Z
   * (`sess_…`, n=1 each): github.com/rust-lang/rust committed and then
   * held a 2-node, 110-character tree ("Skip to content") for 1,150 ms before
   * its 4,416-character page arrived, 1.6 s before `DOMContentLoaded`; the
   * ordinary 250 ms window accepted it, and three runs since 03:00Z read that
   * 110-character tree into an extraction. amazon.in search held its 844-char
   * header for 270 ms and reached 19,226 characters only as `DOMContentLoaded`
   * fired 1.9 s after the commit; `run_…` stopped waiting at the 2.5 s
   * growth ceiling and extracted from the 883-character header.
   */
  parsing?(): boolean | Promise<boolean>;
  /**
   * When this tab last received anything from the network (a request
   * starting, a response, a chunk of a body, a load finishing), on the
   * settle's clock, or `undefined` when it has received nothing the host saw.
   * Optional: absent means "this host cannot tell", and a still-parsing
   * document is then waited for no longer than `budgetMs`.
   */
  lastNetworkAt?(): number | undefined | Promise<number | undefined>;
}

/**
 * The longest sleep between polls of a document still being parsed. Its
 * arrival is the event being waited for, and the content follows it within
 * one frame or two (amazon.in: 19,226 characters 66 ms after
 * `DOMContentLoaded`, measured 2026-10-03), so the escalating interval's
 * 800 ms would read the page up to that long after it was ready.
 */
const PARSE_POLL_MS = 200;

/**
 * A settle on the page a challenge solve just released.
 *
 * Production 2026-09-25, run_… (n=1, read from its replay): the captcha solver
 * solved a search engine's /sorry at 18:04:18.567Z and the delivery's callback
 * submitted the form; the results page committed at 18:04:19.804Z and its
 * results were inserted at 18:04:20.841Z, 1.04 s after the commit. The step
 * read the page in between, settled it in 253 ms on a 356-character, 7-node
 * tree that held still for the ordinary 250 ms window, and the model — shown
 * no results — gave up.
 *
 * So after a solve the settle does two things it does not do on an ordinary
 * step: it waits (up to {@link POST_SOLVE_DEPART_MS}) for the tree to leave
 * `departFrom`, because the submit's navigation has not necessarily started
 * when the page is read; and it holds the page it arrives at to a
 * {@link POST_SOLVE_QUIET_MS} quiet window instead of 250 ms, which covers the
 * measured 1.04 s gap. Both are paid only on the one step after a solve.
 */
export interface AfterSolve {
  /** The url the page was on when the challenge was solved. */
  readonly departFrom: string;
}

/** How long a post-solve settle waits for the page to leave the challenged url. */
export const POST_SOLVE_DEPART_MS = 4_000;
/** The quiet window a page reached through a solve must hold. See {@link AfterSolve}. */
export const POST_SOLVE_QUIET_MS = 1_500;
/** And the growth ceiling that goes with it, so the longer window can be reached. */
export const POST_SOLVE_GROWTH_BUDGET_MS = 5_000;

/**
 * Polls until the page has rendered, has demonstrably stopped, or the budget is
 * spent. The page must be LIVE: see the module comment on
 * `VirtualTimePolicy::kPause`.
 *
 * `read` is `AgentDeps.snapshot`, unlocked. The trees it returns are DISCARDED —
 * this is a readiness measurement, and every node reference in them belongs to
 * a page nothing has frozen. The tree the model is shown and acts on is always
 * re-read under the lock afterwards, which is what keeps the TOCTOU guarantee
 * the action-lock exists for intact.
 *
 * A READ THAT THROWS IS A STATE, NOT AN ERROR, and it is swallowed here on
 * purpose. `Outcrawl.getAXTree` answers -32000 "No accessibility tree was
 * produced" for the first 30-130 ms after every commit — measured on three
 * navigations of `saucedemo.com` — which is exactly the condition this function
 * exists to wait out. Propagating it would fail the step for the thing being
 * waited for. It is counted rather than hidden: `failedReads` reaches the
 * notice, and a page whose reads never succeed ends `unrendered` with the count
 * as its evidence.
 *
 * `document` is the challenge gate's half of the measurement, and it is
 * consulted only on the way out of a verdict and only for a tree whose content
 * mass is under its floor — see the module comment on what the read costs. A
 * document read that THROWS is swallowed on `read`'s terms: it is one more way
 * a page mid-navigation answers nothing, and a torn-down context must not fail
 * a step for the thing being waited for.
 */
export async function settleTree(
  read: () => AxTree | Promise<AxTree>,
  clock: Clock,
  given: SettlePolicy,
  seen?: AxTree,
  document?: DocumentProbe,
  afterSolve?: AfterSolve,
): Promise<SettleReport> {
  const started = clock.now();
  /** See {@link AfterSolve}: a longer quiet window on the page a solve led to. */
  const policy: SettlePolicy =
    afterSolve === undefined
      ? given
      : {
          ...given,
          quietMs: Math.max(given.quietMs, POST_SOLVE_QUIET_MS),
          growthQuietMs: Math.max(given.growthQuietMs, POST_SOLVE_QUIET_MS),
          growthBudgetMs: Math.max(given.growthBudgetMs, POST_SOLVE_GROWTH_BUDGET_MS),
        };
  const departBudget = Math.min(POST_SOLVE_DEPART_MS, policy.budgetMs);
  /** Whether the tree has left the challenged document. Trivially so with no solve. */
  let departed =
    afterSolve === undefined || (seen !== undefined && seen.url !== afterSolve.departFrom);
  let interval = policy.firstIntervalMs;
  let polls = 0;
  let failedReads = 0;
  let previous: string | undefined;
  /** When the current run of identical hashes began, and the longest span seen. */
  let stableSince = started;
  let stableMs = 0;
  let survey: TreeSurvey = { nodes: 0, actionable: 0, chars: 0 };
  /**
   * The MONOTONE high-water marks, and when either last moved. Maxima rather
   * than the previous poll's values, so an oscillating carousel or ticker
   * produces at most one growth event per new record instead of growing
   * forever. See the module comment.
   */
  let peakNodes = 0;
  let peakChars = 0;
  let grewAt = started;
  /**
   * The PREVIOUS poll's survey, which the current one has to match before the
   * page is accepted.
   *
   * The high-water mark alone says "nothing new has arrived"; it cannot tell
   * that state from "we are looking at the page mid-re-render". MEASURED on
   * `apple.com/macbook-pro/`, one capture, 21 reads: the tree goes 645 nodes /
   * 31,004 serialized characters at 616 ms, DIPS to 262 nodes / 14,596 at
   * 807 ms, and is back at 640 / 30,766 by 1,328 ms and stable from there. A
   * peak-only rule accepted the dip — no new record for a quarter-second is
   * exactly what a dip looks like — and served the model 47% of the page where
   * the old policy's luckier read got 101%. That was the one url of 21 this
   * change made WORSE, and it is why acceptance also requires the current read
   * to agree with the one before it.
   *
   * A pair of agreeing reads is not a substitute for the time span — see
   * `quietMs` on why polls are not time — it is an additional condition, and it
   * costs nothing on a page that has genuinely stopped, because such a page
   * agrees with itself on the first poll after `seen`.
   */
  let lastNodes = -1;
  let lastChars = -1;
  /**
   * The growth wait can never exceed the budget the caller authorised: that
   * budget is already clamped to what the run's `duration` cap has left.
   */
  const growthCeiling = Math.min(policy.growthBudgetMs, policy.budgetMs);
  /**
   * WHEN THE GROWTH CEILING STARTED COUNTING, which is not always when the
   * settle did.
   *
   * `growthBudgetMs` is a ceiling on waiting for a page that is ALREADY usable
   * to stop improving, and it is charged to a customer whose `duration` is
   * ticking — so it is measured from the settle's start everywhere except
   * across a challenge. Time spent waiting for an interstitial to clear bought
   * no page at all, and charging it here would hand the model the real page's
   * FIRST PAINT: the ceiling would already be spent when the document arrived,
   * so the `growing` arm would fire on the first poll that saw it and the page
   * would go out with its nav bar and none of its content. That is the
   * measured 5%-of-page defect `growthQuietMs` exists to prevent, reintroduced
   * through the back door. So the clearance resets it, and the page that
   * finally arrives gets the same window a page nobody challenged gets.
   */
  let growthFrom = started;

  /**
   * The interstitial this document tested as, once it has tested as one. Kept
   * even after it clears, because "this was a challenge and then became the
   * page" is the fact that makes a two-second settle on a working run legible.
   */
  let interstitial: Interstitial | undefined;
  /**
   * The tree's mass when the document last tested as {@link interstitial}.
   * While the tree still has exactly this mass it is the challenge's tree,
   * whatever one document read says; see `conclude`.
   */
  let interstitialTree: { readonly nodes: number; readonly chars: number } | undefined;

  /**
   * Whether the last successful poll found the document still parsing, and
   * when a poll last did. See {@link DocumentProbe.parsing}.
   */
  let parsing = false;
  let lastParsingAt: number | undefined;
  /** The newest network activity seen while waiting on a document past the budget. */
  let lastReceivingAt: number | undefined;
  /**
   * The settle's end. `budgetMs`, pushed out (to at most the loading ceiling)
   * while a document with nothing on it is still arriving: see
   * {@link SettlePolicy.loadingBudgetMs}.
   */
  let deadline = policy.budgetMs;
  const loadingCeiling = policy.budgetMs <= 0 ? 0 : Math.max(policy.budgetMs, policy.loadingBudgetMs);
  const receivedAt = async (): Promise<number | undefined> => {
    try {
      return await document?.lastNetworkAt?.();
    } catch {
      return undefined;
    }
  };
  const isParsing = async (): Promise<boolean> => {
    if (document?.parsing === undefined) return false;
    try {
      return (await document.parsing()) === true;
    } catch {
      return false;
    }
  };

  const report = (verdict: SettleVerdict): SettleReport => ({
    verdict,
    waitedMs: Math.round(clock.now() - started),
    polls,
    failedReads,
    nodes: survey.nodes,
    actionable: survey.actionable,
    chars: survey.chars,
    stableMs: Math.round(stableMs),
    grewMs: Math.round(grewAt - started),
    ...(interstitial === undefined ? {} : { interstitial }),
    ...(lastParsingAt === undefined ? {} : { parsingMs: Math.round(lastParsingAt - started) }),
    ...(lastReceivingAt === undefined ? {} : { receivingMs: Math.round(Math.max(0, lastReceivingAt - started)) }),
  });

  /**
   * THE VERDICT THIS POLL PROVED, unless the document under it is a challenge.
   *
   * `undefined` means "not a verdict yet, keep polling", and it is returned for
   * exactly one state: a self-clearing interstitial with budget left to wait
   * with. Everything else concludes — a page concludes as itself, and a
   * challenge that will not clear concludes as `challenge` at once.
   *
   * The floor comparison comes first and is an integer test, so a page with
   * content never reaches the document read. That ordering is `interstitialOf`'s
   * own and is why this can sit on the settle path of every step.
   */
  const conclude = async (verdict: SettleVerdict): Promise<SettleReport | undefined> => {
    // UNDER THE READ CEILING, not the floor: a Cloudflare managed challenge
    // carries 280-370 characters of text, over the floor, and its marker is
    // trusted up to `EXCLUSIVE_MARKER_TEXT_CEILING`. Production 2026-09-25
    // (run_…, run_…): a 336-character "Just a moment..." tree was
    // settled as `actionable` and the model gave up on it 7 s after it
    // committed; the same challenge cleared itself 16.6 s after commit on
    // run_….
    if (document === undefined || survey.chars >= interstitialReadCeiling(document.textFloor)) {
      return report(verdict);
    }
    // A failed read: nothing was learned about the document, so nothing is
    // claimed about it, and it is answered below as a read with no marker.
    let bytes: SettledDocument | undefined;
    try {
      bytes = await document.read();
    } catch {
      bytes = undefined;
    }
    const found = bytes === undefined ? null : interstitialOf({ ...bytes, textFloor: document.textFloor });
    if (found === null) {
      // A TREE THE CHALLENGE LEFT BEHIND IS NOT THE PAGE. Once this settle has
      // read the document as a self-clearing interstitial, a read that fails
      // or finds no marker while the tree has not moved is the document
      // swapping under a tree that has not caught up: the read can land on the
      // cleared document, or on none, while the tree is still the challenge's.
      // Concluding there hands the model the challenge as the page. Production
      // 2026-10-07 07:22Z, crocs.com run_… (n=1): a Cloudflare managed
      // challenge POSTed its clearance at +4.3 s and the settle concluded
      // `actionable` at +5.4 s on the 386-character "Performing security
      // verification" tree; the extract reported no products and the judge
      // failed the run on that screen, while the results page had loaded.
      // Which of the two reads it was is not measured; both are waited out
      // here, to the budget, and the tree's own verdict stands otherwise.
      const challengeTree =
        interstitial !== undefined &&
        interstitialTree !== undefined &&
        INTERSTITIAL_SELF_CLEARS[interstitial.vendor] &&
        survey.nodes === interstitialTree.nodes &&
        survey.chars === interstitialTree.chars;
      return challengeTree && clock.now() - started < policy.budgetMs ? undefined : report(verdict);
    }
    interstitial = found;
    interstitialTree = { nodes: survey.nodes, chars: survey.chars };
    if (INTERSTITIAL_SELF_CLEARS[found.vendor] && clock.now() - started < policy.budgetMs) {
      return undefined;
    }
    return report('challenge');
  };

  // POLL ZERO IS THE CALLER'S OWN READ. It is not counted in `polls` — that
  // field is snapshots this function took — and it is stamped as if it had been
  // observed right now, which is later than the truth and therefore only ever
  // makes the wait longer. Its whole job is to give the FIRST real poll
  // something to be compared against, so a page that has already stopped
  // growing proves it in one snapshot instead of two.
  if (seen !== undefined) {
    survey = surveyTree(seen);
    peakNodes = survey.nodes;
    peakChars = survey.chars;
    lastNodes = survey.nodes;
    lastChars = survey.chars;
  }

  // READ FIRST, THEN WAIT. The page has been running since the caller's freeze
  // came down, so the state that matters may already have arrived; sleeping
  // before looking would charge every caller one interval for nothing. Same
  // shape as `serpReaderFor`'s poll, which reads and only then decides whether
  // to wait again.
  for (;;) {
    /**
     * True when this poll PROVED a verdict and the gate withheld it, which
     * happens for exactly one state: a self-clearing interstitial with budget
     * left. The wait below is then bounded by the budget alone — the growth and
     * quiet windows are windows for a page that is already usable, and a
     * challenge is not one. It is also load-bearing arithmetic: without it
     * `growthLeft` goes negative on an interstitial that carries a button and
     * the loop spins on the read instead of sleeping.
     */
    let heldByChallenge = false;
    let tree: AxTree | undefined;
    try {
      tree = await read();
    } catch {
      failedReads += 1;
    }
    if (tree !== undefined) {
      polls += 1;
      survey = surveyTree(tree);
      if (!departed && afterSolve !== undefined) {
        // The page has not left the challenged document yet. Once it has — or
        // once the page has had its chance to and did not — this is a new
        // document, and everything measured about the old one is dropped so
        // the new one earns its verdict from scratch.
        if (tree.url !== afterSolve.departFrom || clock.now() - started >= departBudget) {
          departed = true;
          const now = clock.now();
          peakNodes = 0;
          peakChars = 0;
          growthFrom = now;
          lastNodes = -1;
          lastChars = -1;
          previous = undefined;
          stableSince = now;
        }
      }
      if (survey.nodes > peakNodes || survey.chars > peakChars) {
        peakNodes = Math.max(peakNodes, survey.nodes);
        peakChars = Math.max(peakChars, survey.chars);
        grewAt = clock.now();
      }
      const held = survey.nodes === lastNodes && survey.chars === lastChars;
      lastNodes = survey.nodes;
      lastChars = survey.chars;
      // A document still being parsed has not arrived, however still its
      // prefix holds: no verdict but the budget's is reached on it. See
      // `DocumentProbe.parsing`. Asked only when the host can answer, and a
      // probe that throws has said nothing.
      parsing = departed && (await isParsing());
      if (parsing) {
        lastParsingAt = clock.now();
        // STILL ARRIVING, with nothing to act on yet: the settle ends no
        // sooner than a grace after this read, up to the loading ceiling.
        // See `SettlePolicy.loadingBudgetMs`.
        const received = survey.actionable === 0 ? await receivedAt() : undefined;
        if (received !== undefined && clock.now() - received <= RECEIVING_WINDOW_MS) {
          lastReceivingAt = received;
          deadline = Math.max(deadline, Math.min(loadingCeiling, clock.now() - started + ARRIVED_GRACE_MS));
        }
      }
      if (!departed) {
        // Waited on exactly as a challenge is: nothing is concluded about a
        // document the submit is about to replace.
        heldByChallenge = true;
      } else if (parsing) {
        // Waited on, and the growth window has not started: it is a window
        // for a page that has ARRIVED to stop improving, and this one has not.
      } else if (survey.actionable > 0) {
        // Rule one. A page with something to act on, once nothing new has
        // arrived for `growthQuietMs` AND this read matches the one before it —
        // or once waiting for that has cost more than a page which is ALREADY
        // usable is worth, which is its own verdict.
        if (held && clock.now() - grewAt >= policy.growthQuietMs) {
          const decided = await conclude('actionable');
          if (decided !== undefined) return decided;
          heldByChallenge = true;
        } else if (clock.now() - growthFrom >= growthCeiling) {
          const decided = await conclude('growing');
          if (decided !== undefined) return decided;
          heldByChallenge = true;
        }
      } else {
        const hash = hashSnapshot(tree);
        if (hash !== previous) {
          previous = hash;
          stableSince = clock.now();
        }
        stableMs = Math.max(stableMs, clock.now() - stableSince);

        // The blank rule before the quiet rule, because the two states are
        // hash-identical and only the url separates them: `about:blank` is
        // accepted at once, and a root-only tree at a real url is never
        // accepted as quiet however long it holds still.
        if (isBlankDocument(tree.url)) {
          /**
           * AN `about:` DOCUMENT IS EMPTY BY DEFINITION and carries no bytes a
           * vendor could have written into it, so the gate is skipped and the
           * first step of every run — which reads the tab it starts on — pays
           * nothing at all for the challenge check.
           *
           * AN EMPTY URL IS A DIFFERENT FACT and gets the gate. `''` is a tree
           * that did not report where it is, which is not evidence that the
           * document is empty; `isBlankDocument` folds the two together
           * because for the RENDER question they behave alike, and they do not
           * behave alike here. A root-only tree with no url at a site that is
           * serving us an interstitial would otherwise be accepted as blank in
           * zero milliseconds, which is the one exit in this function that no
           * later step can reopen: the tree never moves, so `quiescentAt` in
           * `loop.ts` answers every subsequent step from the same reading and
           * no settle ever runs again.
           */
          if (!tree.url.startsWith('about:')) {
            const decided = await conclude('blank');
            if (decided !== undefined) return decided;
            heldByChallenge = true;
          } else {
            return report('blank');
          }
        }
        if (survey.nodes > 1 && clock.now() - stableSince >= policy.quietMs) {
          // A page with no controls that has held one hash for a measured
          // quarter-second is a real page and the model is entitled to see it
          // now. Deleting this arm is what makes every sparse page pay the
          // whole budget on every read.
          //
          // AND IT IS THE ARM A CHALLENGE LEAVES BY. DataDome's g2.com
          // interstitial renders 43 characters and Cloudflare's 403 renders 46:
          // both hold one hash, both are real, settled documents, and neither
          // is the page. So this verdict goes through the gate, and a
          // self-clearing one keeps polling from here.
          const decided = await conclude('quiet');
          if (decided !== undefined) return decided;
          heldByChallenge = true;
        }
      }
    }

    // Nothing proven yet. Wait again, if there is budget to wait with.
    const remaining = deadline - (clock.now() - started);
    if (remaining <= 0) {
      // A page that never produced anything actionable is `unrendered`; one
      // that did and was still growing is usable and says so. Through the gate
      // like every other exit: an interstitial that outlasted the whole budget
      // is reported as the challenge it is rather than as a page that might
      // still be loading — and `conclude` cannot ask for more polling here,
      // because there is no budget left to poll with.
      return (
        (await conclude(survey.actionable > 0 ? 'growing' : 'unrendered')) ??
        report('challenge')
      );
    }
    // Never past the budget: a poll scheduled beyond it would report a wait
    // longer than the one the caller authorised. Nor past the growth ceiling on
    // a page that is only being polled to see it stop growing — sleeping into
    // it would report a wait nobody authorised for content nobody is owed.
    const improving = !heldByChallenge && !parsing && survey.actionable > 0;
    if (heldByChallenge || parsing) {
      // The clearance has not happened yet, so the growth window has not
      // started. See `growthFrom`: charging a challenge's wait to the page that
      // replaces it is how the real page goes out at its first paint. The same
      // holds for a document still parsing: its growth window opens when it
      // has arrived.
      growthFrom = clock.now();
    }
    const growthLeft = improving ? growthCeiling - (clock.now() - growthFrom) : remaining;
    // NOR PAST THE MOMENT THE QUIET WINDOW ELAPSES. The escalation is there to
    // stop a ten-second wait costing 200 snapshots, and on a page with
    // something actionable on it the wait is `growthQuietMs`, not ten seconds:
    // an 800 ms sleep over a 250 ms deadline spends 550 ms this function has
    // already decided not to spend. Measured before this line existed: the
    // carousel case returned at 350 ms against a 250 ms window, and every
    // already-settled page paid the same overshoot on every step that touched
    // it. Floored at `firstIntervalMs` so a page that is mid-change — deadline
    // already past, reads disagreeing — still polls at a sane rate.
    const quietLeft = improving
      ? Math.max(policy.firstIntervalMs, policy.growthQuietMs - (clock.now() - grewAt))
      : remaining;
    // And never longer than PARSE_POLL_MS while the document parses: the
    // escalation would otherwise read it up to 800 ms after it finished.
    const parseLeft = parsing ? PARSE_POLL_MS : remaining;
    await clock.sleep(Math.max(0, Math.min(interval, remaining, growthLeft, quietLeft, parseLeft)));
    interval = Math.min(interval * 2, policy.maxIntervalMs);
  }
}

/**
 * What the model is told about a page that never rendered.
 *
 * EVERY NUMBER IS MEASURED. A fabricated hint is worse than no hint — it is a
 * sentence the model will reason from — so the wait, the poll count, the failed
 * reads and the stable span are the real ones off {@link SettleReport}, and the
 * notice says which shape it saw: a page still changing under us, a page holding
 * still with nothing on it, or a page whose tree could not be read at all.
 */
export function unrenderedNotice(report: SettleReport): string {
  const seconds = (report.waitedMs / 1000).toFixed(1);
  // STILL LOADING, which the browser says rather than the tree: its document
  // had not finished arriving at the last read (`parsingMs`), so this page is
  // a download in progress, not a page that rendered nothing.
  if (report.parsingMs !== undefined && report.waitedMs - report.parsingMs <= 1_000) {
    const receiving =
      report.receivingMs === undefined
        ? ''
        : `, and its tab last received data ${((report.waitedMs - report.receivingMs) / 1000).toFixed(1)}s before the last read`;
    return (
      `This page is STILL LOADING: ${seconds}s after this step began reading it, the browser had not finished ` +
      `loading its document${receiving}. It produced no interactive elements yet because it has not arrived, ` +
      `not because it is empty. Wait for it (a "wait" of several seconds) before acting on it; navigating to it ` +
      `again starts its download over. Do not report the task as impossible on the strength of this tree.`
    );
  }
  const shape =
    report.polls === 0
      ? `the browser could not produce an accessibility tree for it at all (${String(report.failedReads)} attempts)`
      : report.stableMs >= 1_000
        ? `it has held one unchanging, empty tree for ${(report.stableMs / 1000).toFixed(1)}s and reports ${String(report.nodes)} accessibility node(s)`
        : `it was still changing on almost every snapshot and reports ${String(report.nodes)} accessibility node(s)`;
  return (
    `This page produced no interactive elements. It was left running and re-read ` +
    `${String(report.polls + report.failedReads)} time(s) over ${seconds}s, and ${shape}. ` +
    `It may still be loading, or it may render nothing without something else happening first. ` +
    `Reloading it, navigating to it again, or going somewhere else are all real options. Do not ` +
    `report the task as impossible on the strength of this tree alone.`
  );
}

/**
 * WHAT THE MODEL IS TOLD ABOUT A CHALLENGE, and why it cannot be
 * {@link unrenderedNotice}.
 *
 * The measured failure is a sentence, not a missing feature. On `run_…`
 * the model was shown Imperva's interstitial and told the page "may still be
 * loading", which is TRUE of a challenge and useless about one — so it
 * described the document it had and filed the run's headline finding as an
 * absence: "No product categories, featured products, or navigation links were
 * found in the provided accessibility tree." That sentence is the deliverable,
 * and it is wrong in a way the model could not have detected: nothing it was
 * given said the site had not shown us its page.
 *
 * So this notice says four things and no more: that the document is a
 * challenge, which vendor's, what waiting is worth against that vendor
 * (measured, from `INTERSTITIAL_SELF_CLEARS`), and that the tree is therefore
 * not evidence about the task. The numbers are the ones off the report; the
 * marker literal is deliberately NOT quoted — it is a vendor script path, it
 * tells the model nothing it can act on, and a page that can read it back is a
 * page that learned what we detect it with.
 *
 * It does not tell the model to solve anything. The solve path is the
 * browser's, through `PageSession.withSolve`; a body-signature interstitial
 * emits no hold for it, so "click the checkbox" would be advice about a widget
 * that is not there.
 *
 * THE ONE EXCEPTION IS A GATE A PERSON CLEARS WITH ONE PRESS, and it is not a
 * solve: `INTERSTITIAL_CONTROLS` names a real button in the tree the model is
 * looking at (Amazon's "Continue shopping"), and a click on it goes through the
 * same human-modelled input as every other click. So the model is told the
 * button's name and the rule the scrape path keeps — at most two presses, then
 * the site is refusing us. A control inside a cross-origin frame (Cloudflare's
 * checkbox) is not in the tree the model reads, and its vendor clears itself
 * more often than not, so that vendor gets the waiting sentence instead.
 */
export function challengeNotice(report: SettleReport, found: Interstitial): string {
  const seconds = (report.waitedMs / 1000).toFixed(1);
  const control = INTERSTITIAL_CONTROLS[found.vendor];
  const waiting =
    control !== undefined && control.frame === undefined
      ? `A ${found.vendor} gate does not clear itself by waiting; it stands until its ` +
        `"${control.label}" button is pressed. Clicking that button once is what a person does ` +
        `here. If the gate is still standing after ${String(INTERSTITIAL_PRESS_ATTEMPTS)} ` +
        `clicks, the site is refusing us: reach the information by another route, or report that.`
      : INTERSTITIAL_SELF_CLEARS[found.vendor]
        ? `A ${found.vendor} challenge usually replaces itself with the real page within a few seconds; ` +
          `this one did not while the page was left running for ${seconds}s over ` +
          `${String(report.polls + report.failedReads)} re-read(s). Reloading it, navigating to it ` +
          `again, or reaching the same information by another route are all real options.`
        : `A ${found.vendor} challenge has been measured NOT to clear itself by waiting, so re-reading ` +
          `this document will not produce the page. Another route to the same information, or ` +
          `reporting that this site is refusing us, are the honest options.`;
  return (
    `This document is not the site's page: it is a bot-check interstitial served in place of it, ` +
    `and it carries ${found.vendor}'s own challenge markup over ${String(report.chars)} ` +
    `character(s) of accessible text. ${waiting} Whatever this tree does or does not contain, it ` +
    `is NOT evidence about the task — the site never showed us its content. Do not report a fact ` +
    `as missing, absent or unavailable on the strength of this page.`
  );
}
