# agenthands

Human mouse and keyboard input for browser agents, with every timing constant
**measured from real human sessions** instead of guessed.

This is the input layer for [Outcrawl](https://outcrawl.ai) agents. It works with
any Playwright-compatible page, on any browser.

```bash
npm install github:aeonmindai/agenthands
```

```ts
import { chromium } from 'playwright';
import { createHands } from 'agenthands';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
const hands = createHands(page);

await page.goto('https://example.com');
await hands.click('#login');
await hands.fill('#email', 'someone@example.com');
await hands.press('Enter');
```

## Why an agent needs this

An agent that reasons perfectly and clicks like a robot is still a robot. Every
number below is a surface a detector reads, and the defaults of every automation
library are wrong on most of them — Playwright clicks the exact centre of a
bounding box, every single time, with zero variance. A human never does that
twice.

## Why this exists

Most input-simulation libraries model the *shape* of a mouse path — Bézier
curves, overshoot, easing — and then use invented constants for everything else.
The shape is the part detectors care least about.

This library was written the other way round. A probe page recorded real human
sessions and the same page recorded a bot, on the same machine, in the same
browser. The constants come from that comparison. Some of them are the opposite
of what the intuition says:

| Measurement | Human | Naive bot | Note |
|---|---|---|---|
| Click landing offset | mean 8.1px, **sd 15.0** | **0.0, sd 0.0** | Playwright clicks bbox centre, every time |
| Click dwell | med 100ms, p90 **170** | mean 69ms, sd 39.8 | Right-skewed: tight centre, long tail |
| Key dwell | mean 83.7ms, sd 28.3 | — | |
| Key flight | mean 127.4ms, **sd 89.4** | sd 34.3 | Typing needs *more* variance, not less |
| Pointer rate | 59–80 Hz | varies | |
| Fractional coordinates | ~100% | 0% in some stacks | Rounding coordinates is a tell |
| Sub-movements per stroke | med **3** | **30** with per-sample tremor | Noise added "to look organic" is the loudest tell |
| Peak-velocity position | **0.40** | 0.50 for any eased curve | Human velocity is asymmetric, not symmetric |
| Path / straight line | 1.07, p90 **2.13** | 1.12, p90 **1.14** | Synthetic strokes are all equally direct |
| `getCoalescedEvents()` | mean 1.01, max 7 | **hard 1, no variance** | Emergent from dispatch rate, not an API to spoof |
| `PointerEvent.pressure` | 0 / 0.5 | 0 / 0.5 | Already correct — not a signal |
| `wheelDeltaY` vs `deltaY` | locked ratio (-3 macOS, -1.2 Windows) | **any ratio** | Naive scroll emits pairs no device can produce |
| Scroll `deltaY` | mean 7.1, sd 5.6, integers | 225.15, 288.24, … | Trackpads report many small integer deltas |
| Cancelable wheel events per gesture | **1 of 134** | **199 of 199** | Phase, not timing: `Input.dispatchMouseWheel` stamps every event `began` |
| `scrollend` events per gesture | **1** | **136** | Needs no wheel listener at all to observe |
| Scroll frames per wheel event | 1.00 trackpad / **21.75** notched mouse | 1.00 always | Precise-pixel is applied directly, pixel is animated |

Two findings worth calling out because they are counter-intuitive:

- **Click duration is right-skewed, not tight.** An early 25-click sample put the
  standard deviation at 14ms, and this README used to say so. Two public
  datasets — 148,860 clicks from Balabit and 2,901 from an in-browser search
  study — agree that the real spread runs from roughly 70ms at p10 to 170ms at
  p90, with a tail past 300ms. The centre was right; the width was wrong,
  because 25 clicks from one person in one context cannot show a tail.
- **Keystroke flight should be wide, not tight.** Real typing has bursts and
  thinking pauses — a standard deviation near 90ms, with occasional gaps beyond
  half a second. Constant-rate typing is one of the oldest automation signals.
- **Movement is ballistic-plus-corrections, not a curve.** A stroke is a large
  opening thrust followed by a few homing corrections, each with an asymmetric
  velocity profile. That is why real velocity peaks at 40% of the way through
  rather than the midpoint, and why a stroke contains about three velocity
  peaks. Per-sample tremor produced thirty.
- **Coalesced pointer samples are a rate artefact, not an API.** Browsers merge
  samples that arrive faster than they can paint, so real input occasionally
  produces a `pointermove` carrying several. Injected input never does, because
  each dispatch gets its own frame. This library reproduces it by modelling the
  cause — a rare missed frame — so the coalescing is genuinely produced by the
  browser. Overcorrecting is its own tell: pipelining every move yields a mean
  near 1.8 against a human 1.01.
- **Scroll distance is not a free parameter.** `wheelDeltaY` is derived from the
  wheel *tick* count, not from `deltaY`, and a driver can only ever send one
  tick. So the only self-consistent scroll event is exactly one tick of pixels
  (40 on macOS); anything else reports a `deltaY`/`wheelDeltaY` pair that no
  mouse or trackpad can generate. Distance is built from whole ticks instead.
- **A scroll is a gesture, and the gesture is not expressible over stock CDP.**
  This is the wheel equivalent of the coalescing finding, and it is larger. A
  scroll device stamps every wheel event with where it sits in the gesture —
  `NSEvent.phase` on macOS, `WebMouseWheelEvent::phase` in Chromium — and the
  browser reads that field to decide where one scroll starts and the last one
  finished. `Input.dispatchMouseWheel` has no parameter for it: it stamps every
  event `began` and sends a synthetic `ended` behind it, so every event is a
  complete one-event gesture. A page sees one cancelable wheel event and one
  `scrollend` **per event** where a real trackpad gives one of each **per
  gesture** — measured 199 of 199 against 1 of 134, and 136 `scrollend` events
  against 1. The `scrollend` count needs no wheel listener at all. The cause was
  isolated rather than argued: real macOS `CGEvent` scrolls posted to the HID tap
  reproduce the injected signature exactly when every event is stamped `began`
  and the real signature when the phases are real, with identical deltas and
  cadence. Nothing in JavaScript can reach the field, so `scroll()` emits a
  `WheelPath` for a browser entry point that carries it — on Outcrawl,
  `Outcrawl.dispatchWheelPath` — and falls back to `mouse.wheel()` elsewhere.
- **A notched wheel and a trackpad have different scroll physics, not just
  different deltas.** A continuous device reports precise pixels, which Chrome
  applies directly; a notched wheel reports pixels, which Chrome smooth-scroll
  animates. Measured at the same 40px per event and the same `deltaY`/
  `wheelDeltaY` pair: 1.00 scroll frames per wheel event for a trackpad, **21.75
  for a real notched mouse**. Every CDP wheel event is precise-pixel, so
  `HUMAN_WHEEL_MOUSE` sent through the fallback emits notch-sized deltas with
  trackpad physics. The profile now carries `wheelGranularity`, and only the
  path route can express it.

Where a large public dataset exists, the profile carries its **empirical
quantile curve** rather than a fitted mean and standard deviation, because human
timing is right-skewed — a floor near the motor limit, then a long tail of
hesitation — and a gaussian cannot represent that shape.

| Source | What it provides | Sample |
|---|---|---|
| [Balabit Mouse Dynamics](https://github.com/balabit/Mouse-Dynamics-Challenge) | click dwell, wheel bursts | 148,860 clicks / 34,965 bursts |
| [SERP mouse & eye movements](https://zenodo.org/records/15236546) | in-browser move, wheel, click | 564,356 moves / 17,851 bursts |
| [KeyRecs](https://zenodo.org/records/7886743) | key dwell and flight | 553,680 free / 197,718 fixed |
| SERP, reconstructed | wheel deltas per device type | 14,890 wheel-mouse / 2,963 trackpad |
| Local browser capture | wheel deltas, coalescing, pressure | 174 wheel events |

Two of these are independent of each other and of the local capture, and they
agree — which is what makes the corrections above trustworthy rather than one
person's habits.

See [CALIBRATION.md](./CALIBRATION.md) for the full method, the raw numbers, and
how to re-measure on your own hardware.

## Does it actually pass?

A gradient-boosted classifier, 30 features per stroke, human folds split by
participant so it scores on people it never saw. Two arbitrary halves of the
real participants score **0.532** against each other - that is the floor.

| | AUC | floor |
|---|---|---|
| `corpus` replay | **0.525** | 0.528 |
| Parametric model | **0.90** | 0.53 |

The parametric model matches every measured distribution *individually* - turn
angle AUC 0.511, peak-velocity position 0.535 - and a classifier still separates
it, because matching each marginal is not the same as matching the joint
distribution. Replaying measured strokes does match it.

```ts
import corpus from 'agenthands/data/strokes.json' with { type: 'json' };
import keystrokes from 'agenthands/data/keystrokes.json' with { type: 'json' };

// Pass the same fingerprint id every session and the identity keeps its habits.
const hands = new AgentHands(page, { corpus, keystrokes, persona: fingerprintId });
```

### Typing

Latency is not one distribution. Measured over 460,812 real transitions,
alternating hands runs 160ms, the same hand 180ms, the same finger on a
different key 186ms, and row distance adds monotonically on top - so the same
person types `th` in 131ms and `<space>t` in 222ms. Typing replays a real
person's recorded stream, matched on the transition being typed, with hold and
latency taken from the same keystroke.

That pairing matters for a reason that is easy to miss: **23% of real keystrokes
overlap**, meaning the next key goes down before the current one comes up. A
loop that presses and releases each key in turn produces zero. Typing is
scheduled on a timeline and emitted in time order, so overlap happens the way
it does in real typing.

### Personas

Real typing pace varies **3.6x** between people - median latency runs from 86ms
to 309ms. An identity that returns typing at a different speed every visit is
describing someone who is not the same person, so drawing fresh from the
population each session is itself a signal. A persona pins one recorded
individual, their pointer pace and their click character to a seed; the same
fingerprint always resolves to the same habits.

Strokes are drawn without replacement: a finite corpus repeats if you exhaust
it, and repetition is itself detectable. The player binary-searches for the
stroke recorded closest to the distance you need, because warping one away from
its own scale is the only step that measurably degrades it - at 3,953 strokes
the median warp is 0.1%. Where the corpus has nothing close enough, the
parametric model fills in.

## API

### `createHands(page, options?)`

`page` is anything exposing Playwright's `mouse`, `keyboard` and `locator`
surface. Playwright is an *optional* peer dependency — the library depends on
structural types, not on the package.

```ts
interface HandsOptions {
  profile?: InputProfile;  // defaults to HUMAN
  start?: { x: number; y: number };
  seed?: number;           // reproducible sessions
  corpus?: StrokeCorpus;
  keystrokes?: KeyboardCorpus;
  persona?: string | number;
  wheelPath?: (path: WheelPath) => Promise<unknown>;
}
```

### `wheelPath` — the scroll entry point

Supplied, `scroll()` emits the whole scroll as one `WheelPath` and hands it over
instead of calling `mouse.wheel()`. That is the only route that produces a real
scroll gesture, because a `WheelPath` carries a `phase` per sample and
`Input.dispatchMouseWheel` has no parameter for one. On Outcrawl:

```ts
const hands = createHands(page, {
  wheelPath: (path) => cdp.send('Outcrawl.dispatchWheelPath', path),
});
```

`generateWheelPath(deltaY, at, profile, rng)` is the same generator, exported for
callers that dispatch paths themselves.

A `WheelPath` is `{ x, y, path, granularity }` — every field named as that
command names it, so the object goes over the wire verbatim and the dispatcher
stays one line. Measured against the shipped binary: the array must be `path`,
and an object naming it `samples` is refused with `Failed to deserialize
params.path`.

**The dispatcher's rejection is raised, not retried.**
`Outcrawl.dispatchWheelPath` refuses while `Outcrawl.lock` is held, because the
lock drops every input event before the renderer sees it. `scroll()` does not
fall back to `mouse.wheel()` behind a refused path — that would dispatch into
the same void and return success. The fallback route is for a caller who never
supplied a dispatcher at all.

The division is deliberate and is the same one the pointer path uses: **this
library owns the timing model, the browser owns the entry point.** The command
dispatches the samples verbatim and synthesises nothing — which is also what
makes it correct for replaying a real human's captured scroll, where re-modelling
measured input would replace human signal with modelled signal.

A `WheelSample` carries an optional `momentumPhase` for exactly that case. This
library never sets it: momentum is a decaying delta ramp after the fingers lift,
no momentum sample exists in the corpus behind `wheelDelta`/`wheelEventGap`, and
a scroll that ends without momentum is what a slow deliberate drag produces.
Inventing a decay constant is the class of guess this project replaced.

### Methods

| Method | Description |
|---|---|
| `moveTo(target)` | Move to a selector or `{x, y}` along a bowed path at 60–80Hz |
| `click(target, opts?)` | Move, settle, press, hold, release |
| `clickAndVerify(sel, isFocused, attempts?)` | Click and confirm focus landed — see below |
| `type(text)` | Type with measured dwell and flight timing |
| `fill(selector, text)` | Click a field, then type into it |
| `press(key)` | Single key with human hold time |
| `scroll(deltaY)` | One gesture path with `wheelPath`, wheel increments without |
| `position()` | Current tracked cursor position |

### `clickAndVerify` — why it exists

Some elements swallow the first click. An `<iframe>` takes focus itself, so the
first click focuses the frame and the second reaches the input. A
visually-hidden checkbox sits off-canvas at `x: -9999` behind a styled label, so
coordinate clicks land nowhere at all.

When that happens, subsequent typing goes into whatever *did* have focus. In a
checkout form that means an email address silently typed into a postcode field
— the automation reports success and the data is corrupt.

```ts
const ok = await hands.clickAndVerify(
  '#card-number',
  () => page.evaluate(() => document.activeElement?.id === 'card-number')
);
if (!ok) throw new Error('focus never landed');
```

Verify focus before typing anything that matters.

## Profiles

`HUMAN` is the measured default. `HUMAN_FAST` keeps the same distribution shapes
with compressed timings — still inside human range, at the quick end.

Supply your own by implementing `InputProfile`. Offsets are stored as a
**fraction of element size**, not pixels, so the spread scales correctly on both
a 20px checkbox and a 350px button.

```ts
import { HUMAN, createHands } from 'agenthands';

const deliberate = { ...HUMAN, name: 'deliberate',
  clickSettle: { mean: 260, sd: 90, min: 80, max: 600 } };

const hands = createHands(page, { profile: deliberate, seed: 42 });
```

## Reproducible runs

Pass a `seed` and the session replays identically — same path, same jitter, same
timings. Useful for debugging a failing flow without the input changing
underneath you.

## What this does not do

Honest limitations, because they affect whether this is the right tool:

- **`getCoalescedEvents()` returns 1.** A physical mouse polls faster than the
  browser's frame rate, so several samples get merged into one `pointermove` and
  the coalesced list holds them all. Injected events produce exactly one, always.
  Measured human sessions reached 7. This is a property of *where* the event
  enters the stack, and no amount of path or timing work changes it — only
  OS-level injection (`CGEventPost`, `uinput`, `SendInput`) does.
- **`PointerEvent.pressure` is always 0.** Measured human sessions showed
  non-zero pressure on ~1% of moves.
- **Some browser builds quantise coordinates** to integers regardless of what
  you pass in. Measure before assuming yours does not.

If you need those, this library is not sufficient on its own. The Outcrawl
browser addresses the first two at the C++ level, where they are properties of
where the event enters the stack rather than of the path that produced it.

## Re-calibrating

The measured profile came from one person on one machine. Yours will differ.
`harness/probe.html` records both a human and a bot session and prints
comparable statistics — open it, interact, and read the report.

See [CALIBRATION.md](./CALIBRATION.md).

## Data attribution

The bundled stroke corpus (`data/strokes.json`) is derived from *A Versatile
Dataset of Mouse and Eye Movements on Search Engine Results Pages* by Kayhan
Latifzadeh, Jacek Gwizdka and Luis A. Leiva, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and reshaped into
normalised stroke geometry. Original: https://zenodo.org/records/15236546

Calibration also draws on the [Balabit Mouse Dynamics
Challenge](https://github.com/balabit/Mouse-Dynamics-Challenge) and
[KeyRecs](https://zenodo.org/records/7886743).

## License

MIT
