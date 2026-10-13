/**
 * The fan: one decision, several tabs.
 *
 * ```
 * read K tabs concurrently -> ONE model call carrying K trees
 *                          -> dispatch up to K actions concurrently
 *                          -> fold K outcomes into one step
 * ```
 *
 * **Parallel pages is the trap; parallel decisions is the win.** Model latency
 * is 40-45% of a production run's wall clock and the page is frozen for 64.9%
 * of it (measured on the root-headful rig, three rows). So overlapping page
 * work alone — prefetching the other tabs while the loop drives one — can
 * return at most the page share, and only the overlapping part of that. The
 * term worth attacking is the model call, and the only way to attack it is to
 * make one call decide for several tabs: K sites fold into 1/K as many calls.
 * A five-site comparison is five reads that do not depend on one another, and
 * spending five model calls on them spends the expensive half of a step five
 * times for one decision.
 *
 * ## What this module is, and what the loop keeps
 *
 * The head action still drives the FOCUSED tab through the loop's own
 * `PageSession`, under its freeze, on the path that has always existed. This
 * module is the other half: `Envelope.also` carries tab-qualified actions,
 * {@link planFan} decides which of them may run, and {@link fanAbort} is the
 * gate each one passes immediately before it is dispatched. Nothing here
 * touches a page, opens a socket or knows what a lock is.
 *
 * ## The gate, and why it never looks at a hash
 *
 * `hashSnapshot` deliberately excludes node references — it must, or an action
 * cache would never hit on a second visit to a page, since backend node ids are
 * minted per renderer. The consequence is sharp: a React re-render that
 * recreates every node produces a tree with an IDENTICAL hash and not one live
 * reference in common. So {@link fanAbort} resolves the reference and compares
 * node identity, and consults no hash at all. The lookup is the authority.
 *
 * That is one of two independent gates, which is the only construction that
 * holds. The second is not here and needs nothing from here: the per-tab
 * binding in `@outcrawl/worker` already refuses a reference whose frame ordinal
 * is not its own CDP session's, and ordinals are browser-global
 * `FrameTreeNodeId`s, so an element aimed at the wrong tab cannot act even if
 * everything in this file is wrong about it.
 */

import type { Action, TabId } from './actions';
import { describeAction, hasRef, validateAction } from './actions';
import type { AxTree } from './snapshot';
import { findNode, sameNode, serializeTree } from './snapshot';

/**
 * How many tabs beyond the focused one a single reply may drive.
 *
 * Four, so head-plus-four is five tabs in one reply, which is the five-site
 * comparison shape and nothing wider. ENFORCED by truncation in
 * {@link planFan} rather than asked for in the prompt.
 *
 * ── Read this before raising it to 8 ──────────────────────────────────────
 *
 * The renderers are not the binding constraint. `MAX_TABS_PER_SESSION` is 8 and
 * a renderer is 40-60 MB, so a full session is 320-480 MB on a 16 GB box that
 * also serves other tenants — uncomfortable, survivable.
 *
 * THE REPLAY BUDGET BINDS FIRST. `DEFAULT_ASSET_POLICY` in
 * `@outcrawl/replay-store` allows 8 MiB per origin against 48 MiB per session,
 * so five origins drawing their full per-origin share is 40 MiB — 83.3% of the
 * session ceiling. A sixth origin cannot get its share, and `SessionIngest`
 * starts refusing bodies as `DropReason.BudgetExhausted`. The run still works;
 * the REPLAY quietly stops being whole, which is worse than an absent one
 * because a customer watches it and believes it. Five tabs is the width at
 * which a fan and a truthful replay still coexist. Raising this without raising
 * that spends the replay to buy wall clock.
 */
export const MAX_FAN = 4;

/**
 * Characters of serialised page the non-focused tabs share, together.
 *
 * The same figure as the focused tab's own ceiling, so a fanned step shows at
 * most 2x the page a serial step shows however many tabs are open: the focused
 * tree keeps its whole budget and the others split this one evenly. Constant in
 * tab count is the property that matters — a per-tab budget would make prompt
 * size grow with ambition, which is how a step that visits five sites comes to
 * cost more than the five steps it replaced.
 *
 * At five tabs that is 12,500 + 4 x 3,125 = 25,000 chars, about 10,000 tokens
 * of page. Set against a step count falling by roughly 2.5x, which is the trade
 * the arm exists to measure rather than assert.
 */
export const FAN_TREE_CHAR_BUDGET = 12_500;

/** One tab the model was shown a tree for. Both the prompt's input and the gate's. */
export interface FanTab {
  readonly tab: TabId;
  readonly tree: AxTree;
}

/** One element of the fan that may be dispatched, and what to check it against. */
export interface FanStep {
  /** The tab this element drives. Absent only for `openTab`, which has no tab yet. */
  readonly tab?: TabId;
  readonly action: Action;
  /**
   * The tree this element was chosen from, when the dispatch has to be gated
   * against a fresh read of that tab. Absent for `openTab`, `closeTab` and
   * `navigate`, which read no page: the first two touch tab lifecycle only, and
   * the third replaces the page it would have been checked against.
   */
  readonly chosenFrom?: AxTree;
}

/** An element that will not be dispatched, and what the model should hear about it. */
export interface FanRefusal {
  readonly tab?: TabId;
  readonly reason: string;
}

export interface FanPlan {
  readonly steps: readonly FanStep[];
  /**
   * Never silently empty. An element dropped for width is a site not visited,
   * so unlike `then` — whose useful prefix is exactly what the model meant —
   * every drop here is reported and reaches the next prompt.
   */
  readonly refused: readonly FanRefusal[];
}

/**
 * The action types a fan element may be, and why each is in or out.
 *
 * IN, and note this is a wider set than `CHAINABLE`: an element runs against
 * its OWN tab, so the argument that excludes `navigate` from a motor program —
 * that it replaces the page every later element was chosen against — does not
 * apply. Nothing else in the reply references that tab's page.
 *
 *   the six input actions   the ordinary work of a step
 *   `navigate`              the "visit five sites at once" primitive
 *   `extract`               the "read the price on all five" primitive, and the
 *                           most valuable element there is: it costs a model
 *                           call of its own, and K of them run concurrently
 *                           instead of over K steps
 *   `openTab`              names no tab; the url IS the target
 *   `closeTab`             closes a tab whose sub-goal is finished
 *
 * OUT:
 *
 *   `focusTab`   focus is one thing and the head action owns it. A fan that
 *                could refocus would race the head's own freeze.
 *   `done`/`fail` a run must not end on an action appended to another one. The
 *                finish is refused, declined or honoured by machinery that runs
 *                once per step, and `planOwed` is part of it.
 *   `ask`        a park is a whole-run state and a fan element is a fragment of
 *                one step. Four elements each parking on their own question
 *                would be four questions from one reply, none of which the
 *                model could act on until all of them were answered. One
 *                question at a time, as the head action, is the only shape a
 *                human can be asked in.
 */
const FAN_ELIGIBLE: Readonly<Record<string, true>> = {
  click: true,
  fill: true,
  hover: true,
  press: true,
  scroll: true,
  select: true,
  navigate: true,
  extract: true,
  openTab: true,
  closeTab: true,
};

export interface PlanFanInput {
  /** `Envelope.also`, raw. Elements are validated here and nowhere earlier. */
  readonly also: readonly unknown[];
  /** The tab the head action drives. The fan may not touch it. */
  readonly focused: FanTab;
  /** Tabs whose trees were in the prompt. The only tabs an element may act on. */
  readonly others: readonly FanTab[];
  /** Every live tab, so `closeTab` can name one whose tree was not shown. */
  readonly live: readonly TabId[];
  /** {@link MAX_FAN}, already clamped by the caller. */
  readonly limit: number;
}

/**
 * Decides which of the model's tab-qualified actions may run.
 *
 * Five refusals, and each one is a failure mode rather than a formality:
 *
 * 1. **Past the width ceiling.** Truncated, and every drop reported.
 * 2. **Not fan-eligible.** See {@link FAN_ELIGIBLE}.
 * 3. **The focused tab.** The head action holds that tab's freeze; a second
 *    action on it in the same step would be a second mutation against one tree
 *    read, and a second lock against a refcount that is already open.
 * 4. **A tab whose tree was not shown.** THE IMPORTANT ONE. An element aimed at
 *    a tab the prompt carried no tree for is an action chosen against a page
 *    the model never saw, which is exactly the failure the whole lock
 *    discipline exists to prevent — arriving by a new door. `closeTab` is
 *    exempt because it reads no page.
 * 5. **A tab another element already named.** One element per tab per step.
 *    Two concurrent locks on one tab is a self-deadlock, and two mutations
 *    against one tree read is the TOCTOU race with extra steps.
 *
 * Then `validateAction`, against the tree of the tab the element names — the
 * sanctioned validator, called here rather than reimplemented, so a reference
 * this module accepts is one the loop would accept.
 */
export function planFan(input: PlanFanInput): FanPlan {
  const steps: FanStep[] = [];
  const refused: FanRefusal[] = [];
  const byTab = new Map<TabId, FanTab>();
  for (const tab of input.others) {
    byTab.set(tab.tab, tab);
  }
  const claimed = new Set<TabId>();

  for (const [index, raw] of input.also.entries()) {
    if (steps.length >= input.limit) {
      refused.push({
        reason:
          `element ${String(index + 1)} was dropped: one reply may drive at most ` +
          `${String(input.limit)} other tabs. Ask for the rest next step.`,
      });
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      refused.push({ reason: `element ${String(index + 1)} is not an action object` });
      continue;
    }
    const element = raw as Record<string, unknown>;
    const type = element['type'];
    if (typeof type !== 'string' || FAN_ELIGIBLE[type] !== true) {
      refused.push({
        reason:
          `element ${String(index + 1)} cannot run beside another action: ` +
          `${typeof type === 'string' ? type : 'an element with no type'} is not one of ` +
          `${Object.keys(FAN_ELIGIBLE).join(', ')}`,
      });
      continue;
    }

    /**
     * Which tab this element is about.
     *
     * `closeTab` takes it from the action's own `tab`, which is the same field
     * and the same meaning — a routing field and a target that happen to
     * coincide, rather than two facts that could disagree. `openTab` is the
     * one type that names none: the url IS the target.
     */
    const needsNoTree = type === 'openTab' || type === 'closeTab';
    let tab: TabId | undefined;
    if (type !== 'openTab') {
      const named = element['tab'];
      if (typeof named !== 'string' || named === '') {
        refused.push({
          reason: `element ${String(index + 1)} (${type}) names no tab, so there is nowhere to run it`,
        });
        continue;
      }
      tab = named;
      if (tab === input.focused.tab) {
        refused.push({
          tab,
          reason:
            `element ${String(index + 1)} names the focused tab, which this reply's first action ` +
            'is already driving. One action per tab per reply.',
        });
        continue;
      }
      if (claimed.has(tab)) {
        refused.push({
          tab,
          reason: `element ${String(index + 1)} is a second action for tab ${tab} in one reply`,
        });
        continue;
      }
      if (needsNoTree) {
        if (!input.live.includes(tab)) {
          refused.push({ tab, reason: `element ${String(index + 1)} names tab ${tab}, which is not open` });
          continue;
        }
      } else if (!byTab.has(tab)) {
        refused.push({
          tab,
          reason:
            `element ${String(index + 1)} names tab ${tab}, which you were not shown a page for. ` +
            'Focus it to read it; an action chosen against a page nobody read is refused.',
        });
        continue;
      }
    }

    /**
     * The tree the reference resolves in. The element's own tab's, so a
     * reference is only ever accepted against the page it was read from; the
     * two tree-free types validate against the focused tree because
     * `validateAction` needs a tree to index and neither of them names a node.
     */
    const against =
      tab === undefined || needsNoTree ? input.focused.tree : (byTab.get(tab) as FanTab).tree;
    const validated = validateAction(element, against);
    if (!validated.ok) {
      refused.push({
        ...(tab === undefined ? {} : { tab }),
        reason: `element ${String(index + 1)} is unusable: ${validated.errors.join('; ')}`,
      });
      continue;
    }

    if (tab !== undefined) {
      claimed.add(tab);
    }
    // `extract` names no node and still reads the page, so it is gated on the
    // url clause alone — see `fanAbort`. Everything with a ref is gated on
    // both.
    const gated = hasRef(validated.value) || type === 'extract';
    steps.push({
      ...(tab === undefined ? {} : { tab }),
      action: validated.value,
      ...(gated && tab !== undefined ? { chosenFrom: (byTab.get(tab) as FanTab).tree } : {}),
    });
  }

  return { steps, refused };
}

/**
 * Why a fan element must not be dispatched, or `undefined` to go on.
 *
 * Called immediately before every gated element, against a read of that
 * element's own tab taken under that tab's own freeze. This function rather
 * than a paragraph, for `chainAbort`'s reason: an element cannot be dispatched
 * without passing through it.
 *
 * Two clauses, and they are `chainAbort`'s two clauses read across tabs instead
 * of across time.
 *
 * **The document must not have been replaced.** Observed by comparing urls, not
 * inferred from the action's type. A background tab runs live between steps —
 * deliberately, it is what lets a checkout page finish loading in tab 3 while
 * the loop reads tab 1 — so "the page moved while the model was thinking" is
 * the ordinary case here rather than the exception. An `extract` against a tab
 * that navigated returns another page's data under this page's name, which is a
 * silent wrong answer and the worst outcome available.
 *
 * **The target must be the node the model named.** Resolved and compared by
 * identity through {@link sameNode}. NO HASH IS CONSULTED, here or anywhere on
 * this path; see this module's header for why a hash cannot answer this.
 */
export function fanAbort(element: Action, chosenFrom: AxTree, now: AxTree): string | undefined {
  if (now.url !== chosenFrom.url) {
    return `this tab navigated to ${now.url} before the action ran`;
  }
  if (!hasRef(element)) {
    // `extract` reaches here, and the url clause above is the whole of its
    // gate: it names no node, and it is about to read the page it was chosen
    // from.
    return undefined;
  }
  const chosen = findNode(chosenFrom, element.ref);
  if (chosen === undefined) {
    // Validated against `chosenFrom` by `planFan`, so unreachable through the
    // loop. Reported rather than assumed away: a caller passing mismatched
    // trees gets a refusal, not a dispatch.
    return 'the action names a node that was not on the page it was chosen from';
  }
  const live = findNode(now, element.ref);
  if (live === undefined) {
    return `${describeAction(element, chosen)} is gone from this tab`;
  }
  if (!sameNode(chosen, live)) {
    return `${describeAction(element, chosen)} is now ${live.role} ${JSON.stringify(live.name ?? '')}${
      live.state?.disabled === true ? ' and disabled' : ''
    }`;
  }
  return undefined;
}

/**
 * The one line that offers the fan.
 *
 * A line about what it costs and what it refuses, for {@link programRule}'s
 * reason: an affordance whose limits the model learns by tripping over them
 * spends a step per lesson. The `extract` example is deliberate and is the
 * point of the whole arm — five prices in one step rather than five.
 */
export function fanRule(limit: number): string {
  return (
    `Your reply may also carry "also":[...] with up to ${String(limit)} actions for OTHER TABS, ` +
    'each naming its own tab: {"tab":"t2","type":"extract","instruction":"the price"}. They run at ' +
    'the same time as your first action and cost you no extra step, so five sites can be read in ' +
    'one step instead of five. Every element must name a tab you were shown a page for, one action ' +
    'per tab, and not the focused tab — your first action is already driving that. An element is ' +
    'dropped if its tab navigated or the node it names has gone, moved role, changed name or ' +
    'become disabled, and you are told which next step. openTab needs no tab, so several sites can ' +
    'be opened at once.'
  );
}

/**
 * The other tabs' pages, as prompt lines.
 *
 * Emitted after the focused tree because these are the most volatile block in
 * the prompt and must not cut the cacheable prefix earlier than the focused
 * tree already cuts it.
 *
 * The budget is shared and split evenly — see {@link FAN_TREE_CHAR_BUDGET} —
 * and `serializeTree` states its own elision, so a tab whose page did not fit
 * says so in its own block rather than appearing to be a short page. That
 * distinction decides whether the model focuses the tab to read it properly or
 * believes it has already seen all of it.
 */
export function renderFanTrees(
  tabs: readonly FanTab[],
  budget: number = FAN_TREE_CHAR_BUDGET,
): readonly string[] {
  if (tabs.length === 0) {
    return [];
  }
  const each = Math.max(1, Math.floor(budget / tabs.length));
  const lines: string[] = [
    'Other tabs, and these pages are LIVE — they are not frozen while you answer. Anything you ' +
      'name on one is re-checked against it before it is used and dropped if it moved:',
  ];
  for (const tab of tabs) {
    lines.push(`Tab ${tab.tab}, ${tab.tree.url}:`, serializeTree(tab.tree, { maxChars: each }));
  }
  return lines;
}
