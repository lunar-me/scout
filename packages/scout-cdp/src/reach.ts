import type { AxNode, AxTree } from '@outcrawl/runtime';

/** Roles a list control offers its choices as. */
export const LIST_OPTION_ROLES: ReadonlySet<string> = new Set(['option', 'menuitem', 'menuitemradio', 'treeitem']);
/** Controls a person types into to make an autocomplete list its options. */
export const TYPED_LIST_ROLES: ReadonlySet<string> = new Set(['combobox', 'textbox', 'searchbox']);
/**
 * How long a list is given to show its options once opened or typed into,
 * polled at the interval below, with the page LIVE: a list fed by a debounce
 * timer or a fetch arrives in hundreds of milliseconds, never under a freeze.
 */
export const LIST_OPTION_WAIT_MS = 2_500;
export const LIST_OPTION_POLL_MS = 150;
/** How long the page runs after the option is clicked, before the choice is checked. */
export const LIST_SELECT_SETTLE_MS = 400;

/** A name as a person compares it: whitespace collapsed, case ignored. */
export function normalisedName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * How many nodes OUTSIDE any list show `want` as their name or value. A
 * choice a control accepted is displayed somewhere that is not the list it
 * came from, so this rising across a click is the page saying the choice
 * took; the options themselves are skipped because they said so before.
 */
export function textOutsideLists(tree: AxTree, want: string): number {
  let count = 0;
  const visit = (node: AxNode): void => {
    if (LIST_OPTION_ROLES.has(node.role) || node.role === 'listbox' || node.role === 'menu') {
      return;
    }
    if (normalisedName(`${node.name ?? ''} ${node.value ?? ''}`).includes(want)) {
      count += 1;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(tree.root);
  return count;
}

/**
 * How many scroll gestures one click will spend reaching its target.
 *
 * Three, because each one aims the box's centre at the viewport's centre, so a
 * single gesture reaches anything within {@link MAX_REACH_GESTURE_PX} and the
 * spare two exist for the pages that move under you: a lazy-loading feed that
 * grows while the wheel is in flight, a sticky header that eats the top 80 px
 * on first scroll, a banner that appears at the fold. Past that the page is
 * not converging, and a fourth gesture is a run spending a second a step to
 * stay in the same place — which is the failure this whole change exists to
 * remove, wearing different clothes.
 *
 * Only gestures aimed at the WHOLE remaining distance count here. A gesture
 * cut short by {@link MAX_REACH_GESTURE_PX} is the approach to a far target,
 * not a failure to converge, and {@link MAX_REACH_TOTAL_PX} bounds those.
 */
export const MAX_SCROLLS_TO_REACH = 3;

/**
 * The furthest ONE scroll-to-reach gesture travels, in CSS pixels.
 *
 * A wheel path's duration grows with its distance: `generateWheelPath` spends
 * about 1.4 s per 1,000 px on the fleet's `trackpad` profile (`HUMAN`), and
 * `Outcrawl.dispatchWheelPath` answers only once its last sample has gone out.
 * With no bound, aiming at a far target sent one gesture that outlived the
 * 30,000 ms `CdpConnection` command deadline. MEASURED on 2026-09-24: in
 * `run_bb83d0c7` step 13 the model clicked `#close-settings` on
 * codepen.io/pen/, which sits about 30,000 px down the page. The replay shows
 * the document scrolling from y=0 at 13:22:47.09 to y=30034 at 13:23:29.59, a
 * 42.5 s gesture. The step failed at 30 s with "Outcrawl.dispatchWheelPath did
 * not answer within 30000ms", and the browser went on scrolling for 12.6 s
 * into the next step. `run_3a01a7b5` step 3 failed the same way on the same
 * button.
 *
 * 8,000 px measured over 1,000 seeds of `HUMAN`: p50 11.3 s, p99 12.9 s, max
 * 13.2 s. The slowest gesture therefore finishes in under half the command
 * deadline. A target further away is walked in several such gestures, up to
 * {@link MAX_REACH_TOTAL_PX} in total.
 */
export const MAX_REACH_GESTURE_PX = 8_000;

/**
 * The furthest one click scrolls, in total, to reach its target, in CSS
 * pixels.
 *
 * Covers the measured codepen case (about 30,000 px) with room to spare: four
 * gestures of at most 8,000 px. The worst case is five full gestures, about
 * 5 x 13.2 s of wheel input in one step. A target further than this is refused
 * BEFORE any gesture goes out, with its distance, so a page that is simply
 * very long costs the run no wheel time at all. The step cannot spend more
 * than about a minute scrolling, and a lazy feed that keeps growing under the
 * wheel runs into this ceiling rather than scrolling forever.
 */
export const MAX_REACH_TOTAL_PX = 40_000;

/**
 * When a scroll is treated as having come to rest, and how long that is waited
 * for.
 *
 * `Outcrawl.dispatchWheelPath` returns when the last sample went out, not when
 * the compositor finished scrolling, and `scroll-behavior: smooth` animates for
 * a few hundred milliseconds after that. 1.2 s is comfortably past a smooth
 * scroll and short enough that a page which never settles costs a step rather
 * than a run.
 */
export const SCROLL_REST_TIMEOUT_MS = 1_200;
export const SCROLL_REST_POLL_MS = 50;
/** Two reads this close together are the page saying it has stopped moving. */
export const REST_EPSILON_PX = 0.5;
/**
 * Less movement than this from a whole wheel gesture means the element does not
 * scroll with the page: it is `position: fixed`, or it lives in a container the
 * page-level wheel does not drive. Two pixels rather than zero because a
 * sub-pixel layout shift is not progress.
 */
export const SCROLL_PROGRESS_PX = 2;
/**
 * The smallest on-screen rect worth aiming at, per axis.
 *
 * `#landing` clamps its point one pixel inside each edge, so a rect under two
 * pixels has no interior to land in.
 */
export const MIN_HITTABLE_PX = 2;

/**
 * The side of the box a viewport point is aimed through, in CSS pixels.
 *
 * A point goes to the planner as a box so it lands the way every other click
 * does: `#landing` draws its offset as a FRACTION of the box (sd 15.04/90 of
 * the width, `agenthands`' `HUMAN.clickOffsetX`) and clamps one pixel inside
 * each edge. At 6 px that is about 1 px of spread and never more than 2 px
 * from the point on either axis — a hand aiming at a spot, not a teleport onto
 * an integer, which is what a point copied off a picture always is.
 */
export const POINT_AIM_PX = 6;

/**
 * How deep and how wide a zero-area target is searched for a painted
 * descendant before it is refused. A link whose only child is an absolutely
 * positioned image has a 0x0 inline box of its own and a real one one level
 * down — measured in production on IW11-hover, `run_f38297e7` step 1: "Fork me
 * on GitHub", box 0x0 at (100, 32). Three levels and sixteen box reads cover
 * a wrapper around a wrapper without walking a container's whole subtree.
 */
export const PAINTED_DESCENDANT_DEPTH = 3;
export const PAINTED_DESCENDANT_READS = 16;

/**
 * How many landings the hand draws over a click target's whole on-screen rect
 * before the landing is steered: the first, and four more when the hit test
 * puts a press on something drawn over the target. A redraw keeps the hand's
 * own spread (`AgentHandsPort.#landing`, a fraction of the rect it is given)
 * rather than pinning the press to a point we chose, so a target that is
 * covered only in part is still pressed wherever a person might have pressed
 * it. Each draw is one hit test: DevTools reads, nothing the page sees.
 */
export const LANDING_DRAWS = 5;

/**
 * Where in a click target's on-screen rect the hit test looks for a point the
 * target itself paints, once {@link LANDING_DRAWS} landings have all hit a
 * cover, as fractions of the rect: the centre first, then a ring. Nine hit
 * tests at most, all DevTools reads.
 */
export const HIT_SAMPLES: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.25, 0.5],
  [0.75, 0.5],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
];

/**
 * How far a sampled point the target paints is grown toward each edge of the
 * rect, as fractions of the distance to that edge, stopping at the first that
 * is not the target's. The window it gives the hand is the painted run around
 * the sample, so the landing spreads over the part a person could see and
 * press rather than collapsing onto the sample. Sixteen hit tests at most.
 */
export const PAINTED_RUN_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1];

/**
 * The smallest side of that window: `#landing` clamps one pixel inside each
 * edge, so a run the samples found no wider than the sample itself still has
 * an interior for the hand to choose from.
 */
export const HIT_WINDOW_PX = 6;

/** An element's tag and attributes, as `DOM.describeNode` reports them. */
export interface DescribedElement {
  readonly tag: string;
  attribute(key: string): string | undefined;
}
