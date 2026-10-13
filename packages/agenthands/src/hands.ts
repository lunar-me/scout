// The driver. Holds cursor state, resolves targets, and emits input at
// measured human rates.

import { CorpusPlayer, type StrokeCorpus } from './corpus.js';
import { KeyboardPlayer, transitionClass, type KeyboardCorpus } from './keyboard.js';
import { createPersona, type Persona } from './persona.js';
import { generateStroke } from './path.js';
import { HUMAN, type InputProfile } from './profile.js';
import {
  clamp,
  defaultRng,
  gaussian,
  type Rng,
  sample,
  seededRng,
  sleep,
} from './random.js';
import { generateWheelPath, type WheelPathDispatcher } from './wheel.js';
import type { BoundingBox, PageLike, Point, Target } from './types.js';

export interface HandsOptions {
  // Measured profile to sample from. Defaults to HUMAN.
  profile?: InputProfile;
  // Where the cursor starts. Defaults to { x: 0, y: 0 }.
  start?: Point;
  // Seed for reproducible sessions. Omit for non-deterministic behaviour.
  seed?: number;
  // Recorded strokes to replay. With a corpus supplied, moves are warped from
  // real measured strokes wherever one exists at the required distance, which
  // is the only mode that survives a trained classifier - see CALIBRATION.md.
  corpus?: StrokeCorpus;
  // Recorded keystroke streams. Supplied, typing replays a real person's
  // timings for the transitions being typed instead of sampling them.
  keystrokes?: KeyboardCorpus;
  // Ties this instance to one recorded individual. Pass the same fingerprint id
  // on every session and the identity keeps its pace and habits; drawing fresh
  // from the population each time is itself a signal, since real typing pace
  // varies more than threefold between people.
  persona?: string | number;
  // A batched wheel entry point that carries a phase per sample - on Outcrawl,
  // `Outcrawl.dispatchWheelPath`. Supplied, `scroll()` emits one path per call
  // and produces a real gesture; absent, it falls back to `mouse.wheel()`,
  // which cannot express phase at all. This is the same division as the pointer
  // path: the timing model is here, the entry point is the browser's.
  wheelPath?: WheelPathDispatcher;
}

// setTimeout cannot reliably schedule below a few milliseconds, and the
// overhead lands on top of every requested delay. Subtracting it keeps the
// emitted event rate inside the target band instead of undershooting.
const TIMER_OVERHEAD_MS = 6;

// The wheel path targets much shorter gaps than the pointer path, where the
// timer floor is a larger share of the sleep. Measured delivered-vs-target on
// the wheel stream: 9ms, against 6ms for the slower pointer cadence.
const WHEEL_TIMER_OVERHEAD_MS = 4;

export class AgentHands {
  private readonly page: PageLike;
  private readonly profile: InputProfile;
  private readonly rng: Rng;
  private cursor: Point;
  /** Cached result of the wheel-tick capability probe. */
  private subTickWheel: boolean | null;
  /** Recorded strokes to replay, when one was supplied. */
  private readonly corpus: CorpusPlayer | null;
  /** Recorded keystroke timings, when supplied. */
  private readonly keys: KeyboardPlayer | null;
  /** The identity this instance behaves as, when one was requested. */
  readonly persona: Persona | null;
  /** Batched wheel entry point, when the driver has one. */
  private readonly wheelPath: WheelPathDispatcher | null;

  constructor(page: PageLike, options: HandsOptions = {}) {
    this.page = page;
    this.profile = options.profile ?? HUMAN;
    this.rng = options.seed === undefined ? defaultRng : seededRng(options.seed);
    this.subTickWheel = null;
    this.persona = options.persona
      ? createPersona(options.persona, {
          strokes: options.corpus,
          keystrokes: options.keystrokes,
        })
      : null;
    this.corpus = options.corpus
      ? new CorpusPlayer(options.corpus, this.rng, this.persona?.mouse)
      : null;
    this.keys = options.keystrokes
      ? new KeyboardPlayer(options.keystrokes, this.persona?.keyboard ?? 0, this.rng)
      : null;
    this.wheelPath = options.wheelPath ?? null;
    this.cursor = options.start ?? { x: 0, y: 0 };
  }

  /** Current tracked cursor position. */
  position(): Point {
    return { ...this.cursor };
  }

  /** The profile in use. */
  getProfile(): InputProfile {
    return this.profile;
  }

  private async box(selector: string): Promise<BoundingBox> {
    const locator = this.page.locator(selector);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`agenthands: no bounding box for selector ${selector}`);
    }
    return box;
  }

  // Landing point inside a box, offset from centre by the measured
  // distribution. Humans rarely hit dead centre, and a click within a pixel of
  // it is a known automation signal.
  private landingPoint(box: BoundingBox): Point {
    const fx = sample(this.profile.clickOffsetX, this.rng);
    const fy = sample(this.profile.clickOffsetY, this.rng);
    return {
      x: clamp(box.x + box.width * (0.5 + fx), box.x + 1, box.x + box.width - 1),
      y: clamp(box.y + box.height * (0.5 + fy), box.y + 1, box.y + box.height - 1),
    };
  }

  private async resolve(target: Target): Promise<Point> {
    if (typeof target !== 'string') return target;
    return this.landingPoint(await this.box(target));
  }

  /** Move the cursor to a selector or coordinate. */
  async moveTo(target: Target): Promise<void> {
    const to = await this.resolve(target);
    const distance = Math.hypot(to.x - this.cursor.x, to.y - this.cursor.y);
    if (distance < 1) {
      this.cursor = to;
      return;
    }

    // Prefer a recorded stroke where the corpus has one at this distance; the
    // parametric model covers everything else.
    const samples =
      this.corpus?.stroke(this.cursor, to) ??
      generateStroke(this.cursor, to, {
      rng: this.rng,
      submovements: this.profile.submovements,
      deviation: this.profile.deviation,
      durationScale: this.profile.durationScale,
      sampleGap: this.profile.sampleGap,
      jitterFrac: this.profile.jitterFrac,
      speedNoise: this.profile.speedNoise,
      });

    const pace = this.persona?.pace ?? 1;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      if (pace !== 1) s.dt *= pace;
      const dropping =
        this.profile.frameDropChance > 0 &&
        this.rng() < this.profile.frameDropChance &&
        i + 1 < samples.length;

      if (!dropping) {
        await this.page.mouse.move(s.x, s.y);
        if (s.dt > TIMER_OVERHEAD_MS) await sleep(s.dt - TIMER_OVERHEAD_MS);
        continue;
      }

      // Simulate a missed compositor frame: dispatch the next few samples
      // back-to-back so the browser genuinely coalesces them into one
      // pointermove, then pay back the elapsed time so the emitted sample rate
      // stays inside the measured band. The coalescing is real - it comes out
      // of the browser's own input pipeline, not a patched getCoalescedEvents.
      const burst = Math.min(
        Math.round(sample(this.profile.frameDropBurst, this.rng)),
        samples.length - i,
      );
      const inflight: Promise<void>[] = [];
      let owed = 0;
      for (let k = 0; k < burst; k++) {
        const b = samples[i + k]!;
        inflight.push(this.page.mouse.move(b.x, b.y));
        owed += b.dt;
      }
      await Promise.all(inflight);
      if (owed > TIMER_OVERHEAD_MS) await sleep(owed - TIMER_OVERHEAD_MS);
      i += burst - 1;
    }
    this.cursor = to;
  }

  /** Move to a target and click it, with measured press/release timing. */
  async click(
    target: Target,
    options: { button?: 'left' | 'right' | 'middle' } = {}
  ): Promise<void> {
    await this.moveTo(target);
    await sleep(sample(this.profile.clickSettle, this.rng));
    await this.page.mouse.down(options);
    await sleep(sample(this.profile.clickDwell, this.rng) * (this.persona?.clickPace ?? 1));
    await this.page.mouse.up(options);
  }

  /**
   * Click a target and confirm focus actually landed on it.
   *
   * Some elements swallow the first click - iframes take focus themselves, and
   * visually-hidden inputs sit off-canvas behind a label. Typing into whatever
   * happened to have focus instead is how automation silently corrupts a form,
   * so this returns false rather than guessing.
   */
  async clickAndVerify(
    selector: string,
    isFocused: () => Promise<boolean>,
    attempts = 2
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      await this.click(selector);
      if (await isFocused()) return true;
    }
    return false;
  }

  /** Type text with measured dwell and flight timing. */
  async type(text: string): Promise<void> {
    const chars = [...String(text)];
    if (!chars.length) return;

    if (!this.keys) {
      for (const ch of chars) {
        await this.page.keyboard.down(ch);
        await sleep(sample(this.profile.keyDwell, this.rng));
        await this.page.keyboard.up(ch);
        await sleep(this.flightDelay());
      }
      return;
    }

    // Build the whole schedule first, then emit in time order.
    //
    // Real typing overlaps: measured across 1,338 people, 23% of keystrokes
    // have the next key going down before the current one comes up. Pressing
    // and releasing each key before starting the next cannot produce that at
    // all, and the ordering of keydown/keyup is visible to any listener.
    type KeyEvent = { at: number; down: boolean; ch: string; seq: number };
    const events: KeyEvent[] = [];
    let at = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const previous = i > 0 ? chars[i - 1]! : null;
      const { cls, rowDist } = previous
        ? transitionClass(previous, ch)
        : { cls: 3, rowDist: 1 };
      const t = this.keys.next(cls, rowDist, ch);
      events.push({ at, down: true, ch, seq: i * 2 });
      events.push({ at: at + t.hold, down: false, ch, seq: i * 2 + 1 });
      at += t.latency;
    }
    // Ties keep their natural order: a key goes down before it comes up.
    events.sort((a, b) => a.at - b.at || a.seq - b.seq);

    let elapsed = 0;
    for (const e of events) {
      const wait = e.at - elapsed;
      if (wait > TIMER_OVERHEAD_MS) await sleep(wait - TIMER_OVERHEAD_MS);
      elapsed = e.at;
      if (e.down) await this.page.keyboard.down(e.ch);
      else await this.page.keyboard.up(e.ch);
    }
  }


  /** Click a field, then type into it. */
  async fill(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await sleep(sample(this.profile.clickSettle, this.rng));
    await this.type(text);
  }

  /** Press a single key with human hold time. */
  async press(key: string): Promise<void> {
    await this.page.keyboard.down(key);
    await sleep(sample(this.profile.keyDwell, this.rng));
    await this.page.keyboard.up(key);
  }

  /** Scroll in wheel increments with pauses, rather than one jump. */
  /**
   * Probe whether this browser derives wheel ticks from the delta, the way
   * real input paths do, or pins them to a single tick.
   *
   * Blink computes WheelEvent.wheelDeltaY from the tick count alone, so on a
   * browser that pins ticks the only self-consistent delta is exactly one
   * tick's worth of pixels; anything else reports a deltaY/wheelDeltaY pair no
   * device can produce. Where ticks follow the delta, the full fine-grained
   * range a continuous device emits becomes available instead.
   *
   * The probe sends one 20px event - inside the measured human range, so it is
   * an ordinary-looking scroll either way - and reads back the ratio.
   */
  private async supportsSubTickWheel(direction: number): Promise<boolean> {
    if (this.subTickWheel !== null) return this.subTickWheel;
    const evaluate = this.page.evaluate?.bind(this.page);
    if (!evaluate) {
      this.subTickWheel = false;
      return false;
    }
    const probe = Math.round(this.profile.wheelTickPx / 2);
    try {
      await evaluate(() => {
        (window as unknown as { __hiWheel?: number }).__hiWheel = undefined;
        const once = (e: WheelEvent) => {
          const wdy = (e as WheelEvent & { wheelDeltaY: number }).wheelDeltaY;
          (window as unknown as { __hiWheel?: number }).__hiWheel =
            e.deltaY === 0 ? 0 : wdy / e.deltaY;
          removeEventListener('wheel', once, true);
        };
        addEventListener('wheel', once, { capture: true, passive: true });
      });
      await this.page.mouse.wheel(0, direction * probe);
      // mouse.wheel resolves once the event is queued, not once the page has
      // handled it, so give the listener a moment before reading the result.
      let ratio: number | undefined;
      for (let i = 0; i < 10 && ratio === undefined; i++) {
        await sleep(20);
        ratio = await evaluate(
          () => (window as unknown as { __hiWheel?: number }).__hiWheel,
        );
      }
      // Ticks-from-delta gives the platform ratio; a pinned tick does not.
      this.subTickWheel = typeof ratio === 'number' && Math.abs(ratio + 3) < 0.2;
    } catch {
      this.subTickWheel = false;
    }
    return this.subTickWheel;
  }

  /**
   * Scroll `deltaY` CSS pixels. Positive scrolls down.
   *
   * Two routes, and they are not equivalent.
   *
   * With a `wheelPath` dispatcher, the whole scroll goes out as ONE path with a
   * phase per sample, which is the only route that produces a real gesture. The
   * phase field is what tells the browser where a scroll starts and ends, and
   * `Input.dispatchMouseWheel` has no parameter for it: it stamps every event
   * `began` and closes the gesture behind each one, so a page sees one
   * cancelable wheel event per event and one `scrollend` per event where a real
   * trackpad gives one of each per GESTURE. Measured against a real device: 1
   * cancelable of 134 and 1 `scrollend` for the trackpad, 199 of 199 and 136
   * for this library's fallback route. See src/wheel.ts.
   *
   * Without one, the fallback below is the best a stock CDP driver can do, and
   * it is still worth having: the deltas, the cadence and the gesture structure
   * are the measured ones, and the `deltaY`/`wheelDeltaY` pair is consistent.
   * What it cannot fix is the phase, and that is not fixable from JavaScript.
   */
  async scroll(deltaY: number): Promise<void> {
    const direction = Math.sign(deltaY);
    let remaining = Math.abs(deltaY);
    if (remaining < 1) return;

    if (this.wheelPath) {
      // No capability probe on this route. The entry point derives the tick
      // count from the delta by construction, so the question the probe exists
      // to answer cannot come out any other way - and skipping it removes the
      // half-tick jolt the probe itself emits.
      await this.wheelPath(
        generateWheelPath(deltaY, this.cursor, this.profile, this.rng),
      );
      return;
    }

    // Probe in the direction being scrolled and count it toward the distance,
    // so the capability check is part of the gesture rather than a visible
    // jolt against it.
    const probeSize = Math.round(this.profile.wheelTickPx / 2);
    if (this.subTickWheel === null && remaining >= probeSize) {
      await this.supportsSubTickWheel(direction);
      remaining -= probeSize;
    }
    const subTick = await this.supportsSubTickWheel(direction);

    while (remaining >= 1) {
      // One gesture: a run of events, then a pause before the next run.
      const inflight: Promise<void>[] = [];
      let budget = subTick
        ? Math.max(1, Math.round(sample(this.profile.wheelGestureEvents, this.rng)))
        : Math.max(1, Math.round(sample(this.profile.wheelGestureEvents, this.rng) / 8));

      while (budget > 0 && remaining >= 1) {
        // With ticks derived from the delta, emit the measured per-event size:
        // small integer deltas, the way a continuous device reports. Without
        // it, one whole tick is the only value that keeps deltaY and
        // wheelDeltaY consistent, so distance is built from whole ticks.
        const step = subTick
          ? Math.max(1, Math.round(sample(this.profile.wheelDelta, this.rng)))
          : this.profile.wheelTickPx;
        const emit = Math.min(step, Math.round(remaining));

        // Dispatch without awaiting: the CDP round-trip is ~10ms, which would
        // otherwise set a floor under the gap well above the measured cadence.
        // Pacing comes from the sleep below instead of from transport latency.
        inflight.push(this.page.mouse.wheel(0, direction * emit));
        if (inflight.length >= 24) await Promise.all(inflight.splice(0));
        remaining -= emit;
        budget -= 1;

        if (budget > 0 && remaining >= 1) {
          // Compensate for the timer floor, as the pointer path does, so the
          // delivered cadence lands on the measured gap rather than beyond it.
          const gap = sample(this.profile.wheelEventGap, this.rng);
          await sleep(Math.max(0, gap - WHEEL_TIMER_OVERHEAD_MS));
        }
      }

      await Promise.all(inflight);
      if (remaining >= 1) await sleep(sample(this.profile.wheelGesturePause, this.rng));
    }
  }


  // Most gaps between keys are short; a small fraction are thinking pauses.
  // Modelling only the mean produces typing that is far too metronomic.
  private flightDelay(): number {
    if (this.rng() < this.profile.keyPauseChance) {
      return sample(this.profile.keyPause, this.rng);
    }
    return sample(this.profile.keyFlight, this.rng);
  }
}

/** Convenience factory. */
export function createHands(
  page: PageLike,
  options: HandsOptions = {}
): AgentHands {
  return new AgentHands(page, options);
}
