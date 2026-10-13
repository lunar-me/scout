import type { HandsStep } from './hands';

/**
 * How far the held path goes before the gesture looks for an HTML5 drag.
 * Blink starts one on the first move at least 4 CSS px from the press
 * (`kDragThresholdX`/`Y`, mouse_event_manager.cc); twice that, so the move
 * that crosses it is inside the lift whatever the sample spacing.
 */
const DRAG_LIFT_PX = 8;

/**
 * How long, after the lift, `Input.dragIntercepted` is waited for before the
 * gesture carries on as a plain pointer drag. The renderer starts the drag
 * synchronously on the move that crosses the threshold, but its message to
 * the browser and the pointer path's reply travel on different pipes, so the
 * event may land just after the reply. NOT MEASURED on the fleet binary; a
 * pointer-driven widget pays at most this as a pause in its held path.
 */
export const DRAG_START_WAIT_MS = 100;

/** Drag updates no closer together than one frame, the cadence a real drag's updates arrive at. */
export const DRAG_OVER_INTERVAL_MS = 16;

/** A drag's held path cut at the drag threshold. See `dispatchDrag`. */
interface Html5DragSplit {
  /** The held path up to and including the first sample {@link DRAG_LIFT_PX} from the press. */
  readonly lift: Extract<HandsStep, { command: 'Outcrawl.dispatchPointerPath' }>;
  /** The rest, offsets from its own first sample, `delayMs` the gap the cut left. */
  readonly carry: Extract<HandsStep, { command: 'Outcrawl.dispatchPointerPath' }>;
}

/** What `dispatchGesture` needs to carry a drag the page may turn into an HTML5 one. */
export interface Html5DragArm extends Html5DragSplit {
  /** The plan's press; the held path is the step after it. */
  readonly pressAt: number;
  /** Resolves when `Input.dragIntercepted` arrives. */
  readonly started: Promise<void>;
  /** The intercepted drag data, or `undefined` while the page has started none. */
  readonly intercepted: () => unknown;
}

/** `held` cut at the drag threshold, or `undefined` when it never leaves it or nothing follows the cut. */
export function liftOf(held: Extract<HandsStep, { command: 'Outcrawl.dispatchPointerPath' }>): Html5DragSplit | undefined {
  const path = held.params.path;
  const first = path[0];
  if (first === undefined) return undefined;
  const cut = path.findIndex((sample) => Math.hypot(sample.x - first.x, sample.y - first.y) >= DRAG_LIFT_PX);
  const crossed = path[cut];
  const next = path[cut + 1];
  if (cut < 0 || crossed === undefined || next === undefined) return undefined;
  return {
    lift: { command: held.command, params: { ...held.params, path: path.slice(0, cut + 1) }, ...(held.delayMs === undefined ? {} : { delayMs: held.delayMs }) },
    carry: {
      command: held.command,
      params: { ...held.params, path: path.slice(cut + 1).map((sample) => ({ ...sample, offsetMs: sample.offsetMs - next.offsetMs })) },
      delayMs: next.offsetMs - crossed.offsetMs,
    },
  };
}
