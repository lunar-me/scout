/**
 * The humanised input layer. One layer, five actions, no synthetic fallback.
 *
 * `./hands` declares {@link HandsPort} and the binding executes what it returns; this
 * module is the thing that PRODUCES a plan. Nothing here talks to a page: every
 * function is a pure planner over `agenthands`' measured generators, and the
 * binding dispatches the result verbatim through the one executor that already
 * exists. That is deliberate and it is the whole architecture — see
 * {@link HandsPort} for why a driver that re-times a path destroys the property
 * the browser's path commands were added for.
 *
 * ## Why `agenthands` and not the fork
 *
 * The fork humanises nothing, on purpose. Its PDL says so where
 * `dispatchPointerPath` is declared:
 *
 * > *"The timing model is not here and must not be: `agenthands` measures it
 * > and owns it. This is the entry point it lacks."*
 *
 * So the browser is the entry point and this module is the generator. They are
 * complements, not alternatives, and there is no second path generator to add.
 *
 * ## Why the keyboard is here in TypeScript and not in C++ next to the pointer
 *
 * `dispatchPointerPath` had to be C++ because `getCoalescedEvents()` returns
 * what the browser actually batched, and a driver sending one command per move
 * can never produce a non-degenerate list — coalescing is a property of where
 * the event enters the stack. `KeyboardEvent` has no `getCoalescedEvents()`, so
 * that entire motivation is absent. `dispatchWheelPath` had to be C++ for a
 * different reason — `Input.dispatchMouseWheel` has no `phase` parameter at all
 * — and `Input.dispatchKeyEvent` is missing nothing a real keystroke needs.
 *
 * What is left is timing precision, and it resolves on the numbers. The
 * discriminator is dispatch overhead against the cadence of the thing being
 * reproduced:
 *
 * | | measured cadence | overhead | distortion |
 * |---|---|---|---|
 * | wheel | 9.46 ms (`wheelEventGap.mean`) | ~6 ms | **63%** — needed C++, got it |
 * | key hold | 91 ms (corpus p50) | ~6 ms | 6.6% |
 * | key latency | 170 ms (corpus p50) | ~6 ms | 3.5% |
 *
 * A few ms of jitter on a hold whose own measured sd is 36 ms, or a latency
 * whose sd is 225 ms, is 6-37x inside the distribution's own width — a page
 * cannot separate it from human variation. THE CONDITION THAT WOULD CHANGE
 * THIS: a page reading `KeyboardEvent.timeStamp` deltas at sub-frame precision
 * would see the host's schedule rather than the requested instants, because
 * per-event dispatch stamps at `Now()` while `dispatchPointerPath` stamps at the
 * requested instant. If a target is ever measured doing that, a `dispatchKeyPath`
 * becomes worth building. Nothing observed does, today.
 *
 * No drift correction and no timer-overhead subtraction, and that is measured
 * rather than lazy. Over a 40-character field the un-planned CDP round trips add
 * roughly 3%, and `agenthands`' own 6 ms overhead subtraction would remove about
 * the same amount in the other direction. Both are inside a 225 ms standard
 * deviation, and a drift correction needs a clock whose `now()` advances — which
 * a fake clock's does not, so the correction would be exactly the kind of thing
 * that looks right in a test and is wrong in production.
 *
 * ## What is NOT humanised, deliberately
 *
 * `select` keeps `Runtime.callFunctionOn`. A `<select>` popup is drawn by the OS
 * on every desktop platform, so there is no in-page geometry to click and no key
 * sequence that reliably reaches an option; a planned gesture would be aimed at
 * coordinates that do not exist. It gains the click that focuses the control and
 * nothing else.
 *
 * A tenant's own CDP connection is the customer driving input themselves and is
 * not ours to re-time UNLESS THEY ASK: a `/connect` ticket with
 * `input: 'natural'` has its input re-planned through this same port by
 * `./natural-input`, and without it every frame is forwarded as sent.
 * `packages/player`'s live-stream input is a real human's captured events
 * replayed verbatim, and passing those through a generator would replace
 * measured human signal with modelled signal — the exact error this module
 * exists to avoid.
 *
 * ## Provenance of every number
 *
 * Nothing here is invented. Pointer constants come from `agenthands`' `HUMAN`
 * profile; keystroke timing is REPLAYED from a recorded corpus rather than drawn
 * from a fitted distribution:
 *
 *   * **KeyRecs**, <https://zenodo.org/records/7886743>, CC-BY-4.0 (commercial
 *     use permitted). 99 people's ordered streams, n=108,900 keystrokes.
 *     Measured across the whole corpus: hold mean 98.5 ms sd 36.1 (p50 91),
 *     latency mean 237.2 ms sd 224.7 (p50 170, p90 463).
 *   * Two structural properties a distribution cannot give and this corpus does.
 *     **17.0% of keystrokes overlap** — the next key goes down before the
 *     current one comes up — which a `down/sleep/up/sleep` loop cannot produce
 *     AT ALL, and keydown/keyup ordering is visible to any listener. And hold
 *     and latency come from the SAME recorded keystroke, so their correlation
 *     survives; drawing them from two distributions breaks it.
 *
 * The cost is real and was priced before it was chosen: 237 ms/char, so a
 * 40-character field takes ~9.5 s and bills ~0.79 credits at Agent's +5
 * credits/minute. A realistic login run is ~12 s of input, about half a cent.
 * `HUMAN_FAST` would save a third of a cent and give up the overlap structure,
 * which is a bad trade; a per-field time cap would make the last field of a long
 * form type faster than the first, which nothing human does.
 */

// Embedded, not read at runtime: a host may ship as a single-file compiled
// executable with no `node_modules` to resolve against. See `loadKeystrokeCorpus`.
import embeddedCorpus from 'agenthands/data/keystrokes.json' with { type: 'json' };

import {
  HUMAN,
  HUMAN_FAST,
  HUMAN_WHEEL_MOUSE,
  KeyboardPlayer,
  clamp,
  generateStroke,
  generateWheelPath,
  sample,
  transitionClass,
  type InputProfile,
  type KeyboardCorpus,
  type Rng,
} from 'agenthands';

import type { HandsContext, HandsPort, HandsScrollRequest, HandsStep, HandsTarget, PointerSample } from './hands';
import { editingChord, keyEventParams, type EditingChord } from './keyboard';

/** Where the planner says why it bound, or why it did not. Any structured logger fits. */
export interface HandsLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Which device this fleet's input claims to be.
 *
 * Not a style knob, and not defaulted silently. Chrome APPLIES a precise-pixel
 * scroll directly and smooth-scroll ANIMATES a pixel one, and the difference is
 * visible from the page as scroll frames per wheel event: measured 1.00 for a
 * real trackpad against 21.75 for a real notched mouse, on the same 40px per
 * event. A trackpad profile and a wheel-mouse profile also differ by two orders
 * of magnitude in events per gesture, so they cannot be blended.
 */
const PROFILE_ENV = 'OUTCRAWL_INPUT_PROFILE';

const PROFILES: Record<string, InputProfile | undefined> = {
  trackpad: HUMAN,
  'wheel-mouse': HUMAN_WHEEL_MOUSE,
  fast: HUMAN_FAST,
};

/** Left button, pressed. `Input.dispatchMouseEvent`'s bitmask. */
const BUTTONS_LEFT = 1;

/**
 * `PointerEvent.pressure` for a held button on real desktop hardware.
 *
 * Not an approximation. Real hardware leaves `PointerDetails::force` at NaN and
 * Blink substitutes exactly 0.5; CDP cannot transmit NaN, so sending 0.5 is
 * bit-identical to what a physical mouse produces. Omitting it delivers 0.0,
 * measured against our own binary, which no physical mouse can report. See
 * {@link MouseButtonParams}.
 */
const PRESSED_FORCE = 0.5;

/**
 * `samples` as a page can receive them: every one inside the viewport, and
 * none that has not moved since the one before (`after` is where the pointer
 * already is, so a first sample on it is dropped too).
 *
 * WHY EVERY STROKE AND NOT ONLY A HELD ONE. `agenthands`' overshoot is not
 * bounded by the window. Measured 2026-10-06 against this planner: from a
 * point inside a 1200x720 viewport to a target near its edge, 457 of 2,000
 * approaches had a sample outside it, the worst 844 px out. And the browser
 * delivers them: on the fleet (production `/connect`, example.com, n=2) the
 * page received trusted `mousemove`/`mouseover` at clientX -1 and clientY -1
 * while `pointermove` read 0, then a 110 px jump where the samples outside
 * were dropped. A real cursor stops at the window's edge.
 *
 * A zero move is not something a device reports. Its time is not lost: the
 * next sample that does move keeps its own offset, so offsets stay
 * non-decreasing and the gap reads as the pointer resting.
 */
function inViewport(
  samples: readonly PointerSample[],
  viewport: { readonly width: number; readonly height: number },
  after?: { readonly x: number; readonly y: number },
): PointerSample[] {
  const kept: PointerSample[] = [];
  let at = after;
  for (const s of samples) {
    const x = clamp(s.x, 0, viewport.width - 1);
    const y = clamp(s.y, 0, viewport.height - 1);
    if (at !== undefined && x === at.x && y === at.y) continue;
    kept.push({ x, y, offsetMs: s.offsetMs });
    at = { x, y };
  }
  return kept;
}

/**
 * The corpus, EMBEDDED at build time rather than read from `node_modules`.
 *
 * This host ships as a `bun build --compile` single-file executable
 * (`scripts/publish-agent.sh:102`), so on a fleet Mac there is no
 * `node_modules` to walk to. An earlier version resolved `agenthands`' entry
 * point at RUNTIME and read its sibling `data/keystrokes.json`, which works
 * from the repo and cannot work from the artifact we actually deploy — the
 * first install of it logged `host.no_hands` on the fleet within a minute,
 * naming its own cause. The warning did its job; the loader was wrong.
 *
 * `import ... with { type: 'json' }` is what bun embeds into the executable,
 * so the corpus travels inside the binary and the deploy cannot lose it.
 *
 * `agenthands` exports `./data/keystrokes.json`, so the specifier is the
 * package's own and the bundler resolves it at build time.
 *
 * 1.6 MB in the binary, paid once per release, against a capability that
 * cannot run without it.
 */
export function loadKeystrokeCorpus(): KeyboardCorpus {
  const parsed: unknown = embeddedCorpus;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('people' in parsed) ||
    !Array.isArray(parsed.people) ||
    parsed.people.length === 0
  ) {
    throw new TypeError(
      "agenthands' keystrokes.json carries no non-empty `people` array: it is not a KeyboardCorpus",
    );
  }
  return parsed as KeyboardCorpus;
}

export interface HandsBinderOptions {
  /**
   * Read by the caller rather than in here, so the process has one place that
   * touches the environment. Same rule as `modelBinderFor`.
   */
  readonly env: Record<string, string | undefined>;
  readonly logger: HandsLogger;
  /**
   * Injected so a test can be deterministic without reaching into the module.
   * Production draws from `agenthands`' own generator.
   */
  readonly rng?: Rng;
  /** Injected so the corpus failure path is reachable in a test. */
  readonly loadCorpus?: () => KeyboardCorpus;
  /**
   * Which modifier the select-all chord holds: Meta on macOS, Control
   * elsewhere. Injected so a test can reach the other one; production reads
   * `process.platform`.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * The input layer, or `null` with a `host.no_hands` line naming what is missing.
 *
 * Same shape as `modelBinderFor` and for the same reason: this worker still
 * serves scrape, crawl, search and the CDP front door without hands, and taking
 * those away to protect a capability the operator misconfigured would be a wider
 * outage than the mistake. `null` makes every input action refuse with
 * {@link HandsUnavailableError}, which names itself.
 *
 * `agenthands`' CODE is a static import, and that is a considered difference
 * from `packages/sdk`, which loads it through a constant specifier because it is
 * an optional peer dependency there. Here it is a hard dependency of a host
 * process: if it is absent the install is broken and nothing boots, which is true
 * of every other dependency in this package and is not a degradable condition.
 * What IS degradable is the corpus file — 1.6 MB of data shipped alongside `dist`
 * and unreachable through the package's own exports map — so that is the failure
 * this function catches and reports.
 */
export function handsPortFor(options: HandsBinderOptions): HandsPort | null {
  const { env, logger } = options;
  // `agenthands`' own `defaultRng` is `Math.random` but is not re-exported from
  // its index, so this is that value rather than a second choice.
  const rng = options.rng ?? Math.random;

  const requested = env[PROFILE_ENV] ?? 'trackpad';
  const profile = PROFILES[requested];
  if (profile === undefined) {
    logger.warn('host.no_hands', {
      config: { [PROFILE_ENV]: requested },
      consequence:
        `${PROFILE_ENV} is "${requested}", which names no input profile, so this worker has ` +
        'no hands: POST /v1/agent refuses click, hover, scroll, drag, fill and press with ' +
        'HandsUnavailableError on the first input step of any task that needs one. Navigate ' +
        'and extract still work, and scrape, crawl, search and the CDP front door are ' +
        'unaffected. Refused rather than defaulted because the choice is observable from the ' +
        'page: a trackpad scroll and a notched-wheel scroll differ by 1.00 against 21.75 ' +
        'scroll frames per wheel event, so guessing wrong is a fingerprint, not a preference.',
      fix: `set ${PROFILE_ENV} to one of: ${Object.keys(PROFILES).join(', ')}. Unset means trackpad.`,
    });
    return null;
  }

  let corpus: KeyboardCorpus;
  try {
    corpus = (options.loadCorpus ?? loadKeystrokeCorpus)();
  } catch (error) {
    logger.warn('host.no_hands', {
      config: { [PROFILE_ENV]: requested },
      consequence:
        "agenthands' recorded keystroke corpus could not be read, so this worker has no hands " +
        'at all: POST /v1/agent refuses click, hover, scroll, drag, fill and press with ' +
        'HandsUnavailableError. The pointer half is refused together with the keyboard half on ' +
        'purpose — a run that clicks like a person and then types like a robot is a worse ' +
        'outcome than one that refuses, because the mixed signature is what gets an exit ' +
        'burned. Navigate and extract still work; scrape, crawl, search and CDP are unaffected.',
      fix:
        'reinstall agenthands so its `data/keystrokes.json` is present — `bun install` in the ' +
        'repo root. A deploy that copies only `dist/` loses it. Do NOT work around this by ' +
        'letting the keyboard fall back to Input.insertText: a silent downgrade from human to ' +
        'synthetic input is invisible to us and obvious to the page.',
      error,
    });
    return null;
  }

  logger.info('host.hands', {
    profile: profile.name,
    device: requested,
    granularity: profile.wheelGranularity ?? 'precisePixel',
    keystrokes: {
      corpus: 'KeyRecs (https://zenodo.org/records/7886743), CC-BY-4.0',
      people: corpus.people.length,
    },
    cost:
      'typing is metered: ~237ms/char, so a 40-character field is ~9.5s and ~0.79 credits at ' +
      '+5 credits/minute. This is a deliberate trade — see the header of hands-deps.ts.',
  });

  return new AgentHandsPort(profile, rng, corpus, (options.platform ?? process.platform) === 'darwin');
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

class AgentHandsPort implements HandsPort {
  readonly #profile: InputProfile;
  readonly #rng: Rng;
  /**
   * ONE recorded person, for the life of the binding, built here rather than
   * lazily.
   *
   * `KeyboardPlayer.next` scans FORWARD through that person's stream, so
   * consecutive keys keep the rhythm they were typed with rather than being
   * drawn independently. Two things follow, and both are the reason this is a
   * `readonly` field set in the constructor instead of a `??=` on first use:
   *
   *   * A player rebuilt per `type()` call would restart the scan, so adjacent
   *     fields would come from unrelated parts of the recording — a typist
   *     whose rhythm resets on a boundary the page can see.
   *   * A lazy `??=` is a branch, and the difference between taking it once and
   *     taking it every time is not observable in the emitted plan. Eager
   *     construction removes the branch rather than leaving behind a property
   *     that cannot be tested. There is nothing to defer: the corpus is already
   *     in hand.
   */
  readonly #keys: KeyboardPlayer;
  /** Whether chords are a Mac keyboard's (Cmd) or everyone else's (Ctrl): see `editingChord`. */
  readonly #mac: boolean;

  constructor(
    profile: InputProfile,
    rng: Rng,
    corpus: KeyboardCorpus,
    mac: boolean,
  ) {
    this.#profile = profile;
    this.#rng = rng;
    this.#keys = new KeyboardPlayer(corpus, Math.floor(rng() * corpus.people.length), rng);
    this.#mac = mac;
  }

  click(target: HandsTarget, context: HandsContext): readonly HandsStep[] {
    const to = this.#landing(target);
    const steps: HandsStep[] = [...this.#approach(to, context)];
    // Settle, then press, then hold, then release. The dwell is the click
    // duration and it is the reason `delayMs` exists in the plan at all.
    steps.push({
      command: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: BUTTONS_LEFT,
        clickCount: 1,
        // The field whose absence delivers pressure 0.0. See PRESSED_FORCE.
        force: PRESSED_FORCE,
      },
      delayMs: sample(this.#profile.clickSettle, this.#rng),
    });
    steps.push({
      command: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        // Released: no button held. Blink zeroes `pressure` whenever `buttons`
        // is empty for every pointer type, which is what real hardware reports
        // on a `pointerup` too, so `force` here would be a no-op and is absent.
        buttons: 0,
        clickCount: 1,
      },
      delayMs: sample(this.#profile.clickDwell, this.#rng),
    });
    return steps;
  }

  hover(target: HandsTarget, context: HandsContext): readonly HandsStep[] {
    // A hover is the approach and nothing else. No settle: the dwell before a
    // click is the hand deciding to press, and there is no press here.
    return this.#approach(this.#landing(target), context);
  }

  /**
   * Approach, press, held path, release: the shape a slider-puzzle solver
   * drags with, over this port's own profile and RNG.
   *
   *   * THE GRAB DWELL is `clickSettle` before the press and `clickDwell`
   *     between the press and the first move: the hand commits before it
   *     moves. BORROWED, as `planDrag` says: in the corpus the next thing
   *     after a press was a release, here it is motion.
   *   * THE RELEASE is at the path's LAST SAMPLE, not at the requested point:
   *     the stroke may overshoot and come back, and releasing anywhere but
   *     where the pointer is would be a teleport under a held button.
   *   * EVERY HELD SAMPLE IS KEPT INSIDE THE VIEWPORT ({@link inViewport}), as
   *     every approach sample is. Both ends are inside it by construction, but
   *     the stroke's overshoot is not bounded by the window, and a held path
   *     that left it would end the drag somewhere the page cannot see.
   *   * No lateral bound. `planDrag` bounds cross-axis wander by the grip when
   *     dragging a slider thumb along a track; an agent's drag is a free reach
   *     from one place to another, and clamping a reach is the tell the other
   *     way.
   */
  drag(from: HandsTarget, to: HandsTarget, context: HandsContext): readonly HandsStep[] {
    const grab = this.#landing(from);
    const drop = this.#landing(to);
    // The press point itself is not sent again under the held button: see
    // {@link inViewport}.
    const held = inViewport(this.#stroke(grab, drop), context.viewport, grab);
    const last = held[held.length - 1];
    if (last === undefined) {
      throw new RangeError('the drag stroke never left the press point');
    }
    const base = (held[0] as PointerSample).offsetMs;
    return [
      ...this.#approach(grab, context),
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          x: grab.x,
          y: grab.y,
          button: 'left',
          buttons: BUTTONS_LEFT,
          clickCount: 1,
          force: PRESSED_FORCE,
        },
        delayMs: sample(this.#profile.clickSettle, this.#rng),
      },
      {
        command: 'Outcrawl.dispatchPointerPath',
        // `buttons: 1` is what makes this a drag: the fork holds the left
        // button on every sample. Offsets rebased onto the first held sample,
        // which is the command's contract.
        params: {
          path: held.map((s) => ({ x: s.x, y: s.y, offsetMs: s.offsetMs - base })),
          pointerType: 'mouse',
          buttons: BUTTONS_LEFT,
        },
        delayMs: sample(this.#profile.clickDwell, this.#rng),
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 },
        delayMs: sample(this.#profile.clickDwell, this.#rng),
      },
    ];
  }

  /**
   * The gesture, and the motion that has to come first when the wheel is not
   * aimed where the pointer already is.
   *
   * A WHEEL PATH IS NOT A POINTER PATH — `dispatchWheelPath` takes ONE position
   * for the whole gesture because the wheel-latching slop region is 10 CSS px,
   * and the fork's own PDL says a cursor that moves during a scroll is a
   * pointer path and belongs to the other command. So the wheel carries no
   * motion, and the browser agrees: `last_known_mouse_position_` is written
   * only from `kMouseMove`/`kMouseLeave` (`event_handler.cc:1058`), from
   * `mousePressed` (`mouse_event_manager.cc:643`) and from `mouseReleased`
   * (`event_handler.cc:1261`) — never from a wheel.
   *
   * Which is why {@link #scrollAt} aiming at a container's centre, or at the
   * viewport centre for a pointer that has never moved, was a wheel arriving
   * somewhere the cursor had never been: no `pointerover` on the element that
   * scrolled, and the browser's own last-known position left pointing
   * elsewhere. No hand does that, and every click on this path is carefully
   * humanised, so the wheel was the one gesture that teleported.
   *
   * The approach is therefore the ordinary stroke and not a special case. When
   * the anchor IS where the pointer is — a plain page scroll, the common case,
   * where `#scrollAt` returns `context.from` itself — nothing is prepended and
   * the dispatch is byte-identical to what it was. When it is not, the run pays
   * one stroke: ~40-60 samples over 0.7-1.1 s, ~0.09 credits at +5/minute.
   */
  scroll(request: HandsScrollRequest, context: HandsContext): readonly HandsStep[] {
    // UNDER ONE CSS PIXEL THERE IS NO WHEEL TO TURN. `generateWheelPath` emits
    // whole-pixel deltas and returns an EMPTY path for |dy| < 1, which the fork
    // refuses with -32602 "'path' must carry at least one sample": 19 step
    // errors over 8 production runs in the 7 days to 2026-09-24, 18 of them a
    // click's reveal scroll and one a model's `{"type":"scroll","dy":0}`. A
    // scroll of nothing is a no-op — no wheel, and no approach stroke toward a
    // wheel that will not turn.
    if (Math.abs(request.dy) < 1) {
      return [];
    }
    const at = this.#scrollAt(request, context);
    const from = context.from;
    const approach = from !== undefined && from.x === at.x && from.y === at.y ? [] : this.#approach(at, context);
    // `generateWheelPath` returns `{ x, y, path, granularity }` — field for
    // field the parameter object `Outcrawl.dispatchWheelPath` takes, verbatim,
    // by design. There is deliberately no mapping step here to get wrong.
    const path = generateWheelPath(request.dy, at, this.#profile, this.#rng);
    return [...approach, { command: 'Outcrawl.dispatchWheelPath', params: path }];
  }

  type(text: string, options: { readonly replace: boolean }): readonly HandsStep[] {
    // One line break is one Return, whichever convention the text came with:
    // `\r\n` typed as two keys would put two line breaks in the field.
    const chars = [...text.replace(/\r\n?/g, '\n')];
    if (chars.length === 0) {
      // Not an empty plan: `dispatchGesture` refuses one, correctly, because
      // dropping the freeze to dispatch nothing is a page touched for no reason.
      throw new RangeError('fill arrived with no text to type');
    }
    const player = this.#keys;

    // The schedule first, then the events in time order. This is the only shape
    // that can express overlap, and 17% of recorded keystrokes overlap: the next
    // key goes down before the current one comes up. A per-character
    // down/hold/up/flight loop cannot produce a single one of them.
    type Transition = { readonly at: number; readonly down: boolean; readonly ch: string; readonly seq: number };
    const events: Transition[] = [];
    let at = 0;
    for (let index = 0; index < chars.length; index += 1) {
      const ch = chars[index] as string;
      const previous = index > 0 ? (chars[index - 1] as string) : undefined;
      // `cls: 3, rowDist: 1` for the first key is `agenthands`' own encoding for
      // "no preceding key", and matching it is what keeps the corpus lookup on
      // the same axis the recording used.
      const transition = previous === undefined ? { cls: 3, rowDist: 1 } : transitionClass(previous, ch);
      const timing = player.next(transition.cls, transition.rowDist, ch);
      events.push({ at, down: true, ch, seq: index * 2 });
      events.push({ at: at + timing.hold, down: false, ch, seq: index * 2 + 1 });
      at += timing.latency;
    }
    // Ties keep their natural order, so a key never comes up before it went
    // down. `seq` is the tiebreak and not a stable-sort assumption.
    events.sort((left, right) => left.at - right.at || left.seq - right.seq);

    // THE FIELD'S CONTENT IS SELECTED FIRST, so the first character types over
    // it: `fill` means "the field now holds this", and without the chord a fill
    // appended. Measured 2026-09-23 on the production binary through this
    // binding, the same address filled twice into one field read back doubled,
    // on Honey Birdette's checkout and on httpbin alike, and the model that
    // re-filled a wrong email on a live checkout doubled it on every attempt
    // until its budget ran out.
    //
    // A person's chord: modifier down, A down under it, A up, modifier up,
    // each after a measured hold. `commands` is what makes it select: on macOS
    // Cmd+A belongs to the application menu, which a synthetic key event never
    // reaches, so the renderer is told the editing command the chord means.
    // Nothing is inserted — neither key carries `text`.
    //
    // Only when asked to replace: focus with no text of its own (a date
    // segment) gets no chord, because there the chord selects the document.
    const hold = (): number => sample(this.#profile.keyDwell, this.#rng);
    const steps: HandsStep[] = options.replace ? [...this.#chord(editingChord('Control+a', this.#mac) as EditingChord)] : [];
    // The first character goes down a measured beat after the modifier comes
    // up, not in the same millisecond.
    let emitted = -hold();
    for (const event of events) {
      steps.push({
        command: 'Input.dispatchKeyEvent',
        params: keyEventParams(event.ch, event.down ? 'keyDown' : 'keyUp'),
        delayMs: event.at - emitted,
      });
      emitted = event.at;
    }
    return steps;
  }

  press(key: string): readonly HandsStep[] {
    // An editing chord (`Control+a`) is pressed as this platform's keyboard
    // presses it; see `editingChord`, which refuses one it does not perform.
    const chord = editingChord(key, this.#mac);
    if (chord !== undefined) return this.#chord(chord);
    // A named key gets the measured hold and nothing else. There is no
    // transition to look up in the corpus — `press` is one key in isolation, and
    // the corpus encodes latency BETWEEN keys — so this is the one place the
    // profile's fitted `keyDwell` is the right source rather than the stream.
    // Its quantiles are the same KeyRecs dwells, fitted: median 91 ms.
    return [
      { command: 'Input.dispatchKeyEvent', params: keyEventParams(key, 'keyDown') },
      {
        command: 'Input.dispatchKeyEvent',
        params: keyEventParams(key, 'keyUp'),
        delayMs: sample(this.#profile.keyDwell, this.#rng),
      },
    ];
  }

  /**
   * A person's chord: each modifier down in turn, the key down under them,
   * the key up, the modifiers up in reverse, each after a measured hold.
   * Every event carries the modifiers held at that instant, as hardware
   * reports them. The editing command rides on the key's `keyDown`, which is
   * what makes it act on macOS (see `editingChord`). Nothing is inserted: no
   * event carries `text`.
   */
  #chord(chord: EditingChord): readonly HandsStep[] {
    const hold = (): number => sample(this.#profile.keyDwell, this.#rng);
    const key = keyEventParams(chord.key, 'keyDown');
    const plain = { key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode, nativeVirtualKeyCode: key.nativeVirtualKeyCode };
    const steps: HandsStep[] = [];
    let bits = 0;
    for (const mod of chord.modifiers) {
      bits |= mod.bit;
      steps.push({
        command: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.keyCode, nativeVirtualKeyCode: mod.keyCode, modifiers: bits },
        ...(steps.length === 0 ? {} : { delayMs: hold() }),
      });
    }
    steps.push(
      {
        command: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', ...plain, modifiers: bits, ...(chord.command === undefined ? {} : { commands: [chord.command] }) },
        delayMs: hold(),
      },
      { command: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...plain, modifiers: bits }, delayMs: hold() },
    );
    for (const mod of [...chord.modifiers].reverse()) {
      bits &= ~mod.bit;
      steps.push({
        command: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.keyCode, nativeVirtualKeyCode: mod.keyCode, ...(bits === 0 ? {} : { modifiers: bits }) },
        delayMs: hold(),
      });
    }
    return steps;
  }

  /**
   * Where in the box the pointer lands.
   *
   * `agenthands` keeps its own `landingPoint` private but exports the measured
   * distributions, so this is the library's formula with the library's constants
   * rather than a second copy of the numbers. Note that `clickOffsetX` is a
   * FRACTION OF BOX WIDTH — `{ mean: 8.07/90, sd: 15.04/90 }`, measured on a
   * 90px-wide target — so reading it as pixels would be a silent 90x error.
   *
   * Never the exact centre, and never rounded. Playwright clicks the centre of
   * the box every single time with zero variance, and integral coordinates on
   * every click are themselves a signal.
   */
  #landing(target: HandsTarget): { readonly x: number; readonly y: number } {
    const fx = sample(this.#profile.clickOffsetX, this.#rng);
    const fy = sample(this.#profile.clickOffsetY, this.#rng);
    // Clamped one pixel inside the edge rather than resampled: resampling would
    // bias the distribution back towards the centre, which is the tell.
    return {
      x: clamp(target.x + target.width * (0.5 + fx), target.x + 1, target.x + target.width - 1),
      y: clamp(target.y + target.height * (0.5 + fy), target.y + 1, target.y + target.height - 1),
    };
  }

  /**
   * The stroke, as one `dispatchPointerPath`, every sample inside the
   * viewport ({@link inViewport}).
   *
   * A pointer with no known position starts where a hand resting on the
   * desk would have left it: a point inside the viewport, away from its
   * edges. NOT THE ORIGIN, which this used to be on the reasoning that
   * Chromium's virtual mouse starts there. The page does not see the virtual
   * mouse, only the events, and a first stroke from (0, 0) was the most
   * visible input this fleet sent. Measured 2026-10-06: 195 of 200 such
   * approaches left the viewport (down to x -279, y -531); production
   * recorded the first stroke of every PerimeterX hold on bloomberg and
   * samsclub (Stealth Bench fix runs r1-r3) leaving through x -2; and the
   * fleet page saw its first trusted events at (-1, 0).
   */
  #approach(
    to: { readonly x: number; readonly y: number },
    context: HandsContext,
  ): readonly HandsStep[] {
    const { width, height } = context.viewport;
    const from = context.from ?? {
      x: width * (0.2 + 0.6 * this.#rng()),
      y: height * (0.3 + 0.5 * this.#rng()),
    };
    return [
      {
        command: 'Outcrawl.dispatchPointerPath',
        params: { path: inViewport(this.#stroke(from, to), context.viewport), pointerType: 'mouse' },
      },
    ];
  }

  /** `agenthands`' measured stroke from `from` to `to`, as `PointerSample`s. */
  #stroke(
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
  ): PointerSample[] {
    const samples = generateStroke(from, to, {
      rng: this.#rng,
      submovements: this.#profile.submovements,
      deviation: this.#profile.deviation,
      durationScale: this.#profile.durationScale,
      sampleGap: this.#profile.sampleGap,
      jitterFrac: this.#profile.jitterFrac,
      speedNoise: this.#profile.speedNoise,
    });

    // `StrokeSample.dt` is the gap BEFORE that sample, so the sample's own time
    // is the running sum. Rebased so the first offset is 0: the command's
    // contract is "milliseconds from the first sample", the C++ subtracts the
    // first offset from every other anyway, and `livestream.ts` rebases the same
    // way for the same contract. Rebasing preserves every interval, which is the
    // measured part; the origin carries no information.
    const path: PointerSample[] = [];
    let offsetMs = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const stroke = samples[index] as { x: number; y: number; dt: number };
      if (index > 0) {
        offsetMs += stroke.dt;
      }
      // `pressure` deliberately absent, not 0. The C++ reads an absent pressure
      // as NaN and Blink turns NaN into 0.5 while a button is held, which is
      // what real hardware reports; 0 is what `Input.dispatchMouseEvent` sends
      // and is the tell.
      path.push({ x: stroke.x, y: stroke.y, offsetMs });
    }
    if (path.length === 0) {
      // `generateStroke` returns at least one sample for any input, so this is a
      // library contract change rather than a reachable state. Refused loudly
      // rather than dispatching an empty path the browser would reject with
      // "Failed to deserialize params.path".
      throw new RangeError('generateStroke returned no samples');
    }
    return path;
  }

  /**
   * Where the wheel gesture happens.
   *
   * One position for the whole path, because the wheel-latching slop region is
   * 10 CSS px and a cursor that moves during a scroll is a pointer path, not a
   * scroll. Over the target's centre when the action named a container,
   * otherwise wherever the pointer already is — and the viewport centre when it
   * has never been anywhere, because a scroll dispatched at the origin lands on
   * whatever is in the top-left corner rather than on the content.
   */
  #scrollAt(
    request: HandsScrollRequest,
    context: HandsContext,
  ): { readonly x: number; readonly y: number } {
    if (request.target !== undefined) {
      return {
        x: request.target.x + request.target.width / 2,
        y: request.target.y + request.target.height / 2,
      };
    }
    return context.from ?? { x: context.viewport.width / 2, y: context.viewport.height / 2 };
  }
}
