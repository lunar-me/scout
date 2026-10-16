/**
 * `page.look`: eyes for an actuator that reads the page as text.
 *
 * scout-1's actuator is a text-only hands model (`input_modalities` is `['text']`), so
 * everything it knows about a page is the accessibility tree. Measured on the
 * failure probes (fleet 54476fe6, 2026-09-24), that is the whole of three
 * failure classes:
 *
 *   * text painted as pixels (PG2, 0/3): `run_…` called a tool named
 *     `img2txt` that does not exist; `run_…` asked `extract` for "the
 *     code painted on the canvas" six times and got `""` six times, because
 *     `extract` reads the same tree; `run_…` declared `done` on the
 *     strength of those empty extractions.
 *   * a canvas UI whose result only exists as pixels (IW6): every scored run
 *     either said it could not see the canvas or ran out of budget clicking it.
 *   * state carried by colour or glyph (a rating drawn as five identical star
 *     glyphs coloured by a CSS class): the tree reads five stars on every item.
 *
 * The lab's `vision` arm fixes perception by replacing the actuator with an
 * image-capable model on every step. This does not: the actuator stays text,
 * and when it needs to see, it ASKS — one screenshot, one question, one short
 * answer from a cheap vision model, delivered as text on the next prompt.
 *
 * ── Why a built-in tool and not a new verb ──────────────────────────────────
 *
 * The `web.*` tools argue it already (`worker/src/web-tools.ts`): `callTool`
 * holds the freeze across the call, echoes the answer into the next prompt,
 * and turns a failure into one failed step. A new action type would earn none
 * of that for free and would need a dispatch case the loop's `default:
 * page.perform` could silently swallow.
 *
 * ── Why the camera runs on the live page ────────────────────────────────────
 *
 * It used to run under the freeze on the argument that an already-painted
 * frozen page answers a capture in about 118 ms (`PageSession.capture`). In
 * production that argument did not hold. After the model call the freeze is
 * retaken over a page that has just run, so the renderer is often caught
 * mid-frame, and a capture sent then is not answered until it runs again.
 * Measured on the 2026-09-26 re-pilot: 9 of 12 failed looks, at the capture
 * deadline. So `PageSession.callTool` takes the freeze down for a look and
 * puts it back afterwards. Only the photograph is taken live, and it is
 * still invisible to the page. The host still bounds the capture, and a
 * timeout is a failed look, never a hung step.
 *
 * ── What it costs ───────────────────────────────────────────────────────────
 *
 * Nothing in credits. The rate card declines to price tokens (`OUTCRAWL_CREDIT_
 * RATES.tokens`: an agent run's model spend is what its minutes buy), so a look
 * is billed exactly like an `extract`: through the wall time it adds, on the
 * one figure the ledger and the invoice already share. Its tokens ride
 * {@link ToolCallOutcome.usage} into the step's usage and the run's `tokens`
 * meter row, so cost accounting sees them. Bounded per run by
 * {@link lookAllowance}: a share of the run's own budget.
 */

import type { JsonSchema, Usage } from '@outcrawl/scout-core';

import type { ExposedTool, ToolCallOutcome, ToolPort } from './loop';
import type { StepTrace } from './result';
import { mergeUsage } from './result';
import type { NodeRef } from './snapshot';
import { formatNodeRef, parseNodeRef } from './snapshot';

export const LOOK_TOOL = 'page.look';

/**
 * How many looks a run may make when nothing says what it can afford: the
 * allowance every run had before it scaled with the budget, and still what a
 * binding given no `maxLooks` hands out (Scout, whose budget is in another
 * unit, and tests).
 */
export const DEFAULT_LOOKS_PER_RUN = 8;

/**
 * The most one vision call costs, in credits: what {@link lookAllowance}
 * divides the budget's share by. The allowance counts calls, so a look that
 * takes a retake (see {@link lookToolPort}) is charged two. MEASURED in
 * production, 7 days to 2026-10-14, n=692 answered looks (one call each
 * then): the vision call's own cost was $0.00075 at the median and
 * $0.0039 at p99 (11,596 input and 785 output tokens), which at the dearest
 * credit (the Builder plan: 10,000 credits for $49, model spend marked up
 * 1.70) is 0.26 and 1.34 credits; its inference took 2.1 s at the median and
 * 10.7 s at p99, another 0.04 to 0.18 credits of browser time at a credit a
 * minute. So 1.5 is the p99 look, rounded up, and the median look costs about
 * a fifth of it.
 */
export const LOOK_CREDITS_BOUND = 1.5;

/**
 * The share of a run's budget its looks may spend, priced at
 * {@link LOOK_CREDITS_BOUND} each.
 *
 * A FIXED EIGHT starved long runs and let short ones spend out of proportion.
 * Production, the same 7 days: 14 runs took all eight, 8 of them on
 * 2,000-credit budgets that ended between 119 and 1,539 credits spent (one
 * that ended at 865 was refused its ninth look), while eight p99 looks are 12
 * credits, 60% of a 20-credit run. A fifth of the budget gives a 60-credit
 * run the eight it had, 300 credits 40, 2,000 credits 266, and 20 credits
 * two; at the median look the share actually spent is about 4%. The run's
 * own budget cap still bounds every credit.
 */
export const LOOK_BUDGET_SHARE = 0.2;

/**
 * How many vision calls a run with `budget` credits may make: as many p99 calls as
 * {@link LOOK_BUDGET_SHARE} of it buys, and at least one. `budget` is
 * `caps.budget`, a decimal credit string; one that does not parse gets
 * {@link DEFAULT_LOOKS_PER_RUN}.
 */
export function lookAllowance(budget: string): number {
  const credits = Number(budget);
  if (!Number.isFinite(credits) || credits < 0) return DEFAULT_LOOKS_PER_RUN;
  return Math.max(1, Math.floor((credits * LOOK_BUDGET_SHARE) / LOOK_CREDITS_BOUND));
}

/**
 * How many times the vision model may FAIL a look before `page.look` is
 * withdrawn for the rest of the run. A provider that failed three asks in one
 * run is down or refusing this page; each further ask costs up to the look
 * timeout of the customer's time for nothing.
 */
export const MAX_FAILED_LOOKS = 3;

/** A question is one question. Longer than this is a prompt, and is refused. */
export const LOOK_QUESTION_MAX_CHARS = 400;

/** A point or rectangle in the focused tab's viewport, CSS pixels. */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a look photographs: the whole viewport (neither field), one element
 * (`ref`), or a part of the viewport (`region`, CSS px).
 */
export interface LookAim {
  readonly ref?: NodeRef;
  readonly region?: ViewportRect;
}

/** One photograph of the focused tab: its viewport, or a part of it enlarged. */
export interface LookShot {
  readonly image: { readonly mediaType: 'image/png'; readonly base64: string };
  /** The viewport, in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * The part of the viewport the picture shows, CSS px, when it is not the
   * whole viewport: a named element or a zoomed region, photographed at more
   * pixels per CSS pixel than the viewport shot. A point the model names on
   * the picture's 0-1000 grid is a point inside this rectangle.
   */
  readonly region?: ViewportRect;
}

/** What the tree says is painted at a point. */
export interface LookLocation {
  readonly ref: NodeRef;
  readonly role: string;
  readonly name?: string;
}

/**
 * The host's camera, bound to the FOCUSED tab.
 *
 * Every method must be invisible to the page: no script in the main world, no
 * DOM mutation, no scroll, no focus change, no resize. A screenshot and a
 * DevTools hit test meet that; anything else does not belong here.
 */
export interface LookCamera {
  /**
   * What `aim` names, as it is painted now: the viewport, or an element or
   * region enlarged. An element is refused (throw) when it is not on screen,
   * because this never scrolls: a scroll is an input, and input is the
   * actuator's to send.
   *
   * `awaitPaint`: the last picture showed the thing asked about not yet drawn
   * (see {@link LookAnswer.unpainted}), so wait, within the camera's own
   * bound, for that part of the page to change and hold still before
   * photographing it.
   */
  shoot(aim?: LookAim, awaitPaint?: boolean): Promise<LookShot>;
  /** The node of the page's tree painted at `point`, or `undefined` when no node there has a reference. */
  locate(point: ViewportPoint): Promise<LookLocation | undefined>;
}

/** A box on the model's 0-1000 grid of a picture. */
export interface GridBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One question about one picture, as the vision model receives it. */
export interface LookQuestion {
  readonly question: string;
  readonly image: LookShot['image'];
  /** The picture is one element or region of the page, enlarged, not the whole screen. */
  readonly enlarged?: boolean;
  /**
   * The model may ask for ONE retake instead of answering: a closer picture
   * of a box ({@link LookAnswer.zoom}) or a later one ({@link LookAnswer.unpainted}).
   * Absent, it answers from this picture.
   */
  readonly retake?: boolean;
}

/** The vision model's reply, already parsed. */
export interface LookAnswer {
  readonly answer: string;
  /** False when the picture does not show what was asked. */
  readonly found: boolean;
  /** Where the thing asked about is, on a 0-1000 grid of the picture, when the question asked where. */
  readonly point?: ViewportPoint;
  /** Offered a retake: the thing asked about is in this box, too small to read here. */
  readonly zoom?: GridBox;
  /** Offered a retake: the thing asked about is not drawn yet (an empty chart, a spinner, a placeholder). */
  readonly unpainted?: boolean;
  readonly usage: Usage;
}

/** The cheap vision model. `@outcrawl/model`'s `ModelPageLook` is the production one. */
export interface LookVision {
  ask(question: LookQuestion): Promise<LookAnswer>;
}

/** Tool arguments as the model sends them: unvalidated, see {@link parseLookArgs}. */
export interface LookArgs {
  readonly question: string;
  readonly ref?: NodeRef;
}

const LOOK_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'One question about what is visible on screen right now.',
    },
    ref: {
      type: 'string',
      description:
        'Optional: a [frame-backendNode] reference from the tree, written as "F-N". The look then photographs that ' +
        'element alone, enlarged, so small print in an image or the labels of a chart can be read.',
    },
  },
  required: ['question'],
  additionalProperties: false,
};

/**
 * Rendered verbatim in the prompt's tool catalogue, so every "when to use this"
 * fact lives here: the shared tool rule (`loop.ts` `toolRule`) has to stay true for connector tools.
 */
export const LOOK_TOOL_DESCRIPTION =
  'Look at the page the way a person would: take a screenshot of the visible viewport and get a short ' +
  'answer to one question about it. Use it for what the tree cannot show — text painted in a canvas or an ' +
  'image, a chart or map, which item is coloured, highlighted or selected, ratings drawn as icons, or to ' +
  'check a visual result such as a shape you drew. To read an image or chart, pass its reference as "ref": ' +
  'the picture is then that element enlarged. Ask WHERE something is to get its position and, when an ' +
  'element is painted there, its [F-N] reference to act on. It sees only what is on screen: scroll first ' +
  "for anything below. It takes a few seconds, and the run's budget sets how many it gets: each answer says how " +
  'many are used.';

export function lookTools(): readonly ExposedTool[] {
  return [{ name: LOOK_TOOL, description: LOOK_TOOL_DESCRIPTION, inputSchema: LOOK_INPUT_SCHEMA }];
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function parseLookArgs(args: Readonly<Record<string, unknown>> | undefined): Parsed<LookArgs> {
  const question = args?.['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    return { ok: false, error: `${LOOK_TOOL} needs "question": the one thing you want to know about the screen.` };
  }
  if (question.length > LOOK_QUESTION_MAX_CHARS) {
    return {
      ok: false,
      error: `${LOOK_TOOL}'s "question" is ${String(question.length)} characters; ask one question in at most ${String(LOOK_QUESTION_MAX_CHARS)}.`,
    };
  }
  const wire = args?.['ref'];
  if (wire === undefined || wire === null || wire === '') {
    return { ok: true, value: { question: question.trim() } };
  }
  const ref = typeof wire === 'string' ? parseNodeRef(wire.replace(/^\[|\]$/g, '')) : undefined;
  if (ref === undefined) {
    return {
      ok: false,
      error: `${LOOK_TOOL}'s "ref" must be a reference printed beside a node, written "F-N"; got ${JSON.stringify(wire)}.`,
    };
  }
  return { ok: true, value: { question: question.trim(), ref } };
}

/**
 * A point on the picture's 0-1000 grid, in viewport CSS pixels.
 *
 * The grid is a fraction OF THE PICTURE, and the picture is the viewport or
 * {@link LookShot.region}, so no device scale factor appears anywhere — the
 * same argument `cdp-widget.ts` makes for its clip. A point outside the grid
 * is not a point in the picture and is refused rather than clamped: clamping
 * would aim at an edge the model never named.
 */
export function fromGrid(point: ViewportPoint, shot: Pick<LookShot, 'viewport' | 'region'>): ViewportPoint | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  if (point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 1000) return undefined;
  const area = shot.region ?? { x: 0, y: 0, ...shot.viewport };
  return {
    x: Math.round(area.x + (point.x / 1000) * area.width),
    y: Math.round(area.y + (point.y / 1000) * area.height),
  };
}

/**
 * How much a zoom box is widened on every side, as a share of its own size,
 * and the least it is widened, CSS px: a model's box is drawn tight to what
 * it saw at low resolution, and a retake that cuts the edge of a label off
 * reads half of it.
 */
export const LOOK_ZOOM_MARGIN = 0.15;
export const LOOK_ZOOM_MARGIN_MIN_PX = 12;

/**
 * The viewport rectangle a zoom box on `shot`'s picture names, widened by
 * {@link LOOK_ZOOM_MARGIN}, rounded outward to whole CSS px and held inside
 * what the picture showed; `undefined` for a box that is empty or off the grid.
 */
export function zoomRegion(box: GridBox, shot: Pick<LookShot, 'viewport' | 'region'>): ViewportRect | undefined {
  const onGrid = [box.x0, box.y0, box.x1, box.y1].every((n) => Number.isFinite(n) && n >= 0 && n <= 1000);
  if (!onGrid || box.x1 <= box.x0 || box.y1 <= box.y0) return undefined;
  const area = shot.region ?? { x: 0, y: 0, ...shot.viewport };
  const x0 = Math.round(area.x + (box.x0 / 1000) * area.width);
  const y0 = Math.round(area.y + (box.y0 / 1000) * area.height);
  const x1 = Math.round(area.x + (box.x1 / 1000) * area.width);
  const y1 = Math.round(area.y + (box.y1 / 1000) * area.height);
  const padX = Math.max(LOOK_ZOOM_MARGIN_MIN_PX, (x1 - x0) * LOOK_ZOOM_MARGIN);
  const padY = Math.max(LOOK_ZOOM_MARGIN_MIN_PX, (y1 - y0) * LOOK_ZOOM_MARGIN);
  const left = Math.max(area.x, Math.floor(x0 - padX));
  const top = Math.max(area.y, Math.floor(y0 - padY));
  const right = Math.min(area.x + area.width, Math.ceil(x1 + padX));
  const bottom = Math.min(area.y + area.height, Math.ceil(y1 + padY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export interface LookToolOptions {
  readonly camera: LookCamera;
  readonly vision: LookVision;
  /** Defaults to {@link DEFAULT_LOOKS_PER_RUN}; a host that knows the run's budget passes {@link lookAllowance}. */
  readonly maxLooks?: number;
  /**
   * Looks this RUN already took on earlier browsers — {@link looksTaken} over
   * the resumed intent's steps. The port is rebuilt with every browser the
   * run acquires, so without this seed a crash would hand the run a fresh
   * allowance and the limit would hold per browser, not per run.
   */
  readonly taken?: number;
}

/** The running count a look's note opens with; see {@link looksTaken}. */
const LOOK_TALLY = /^page\.look \((\d+) of \d+\)/u;

/**
 * How many vision calls a run's recorded steps show it made: every answered
 * `page.look` step counts one, or what its own tally says when that is more —
 * a look that took a retake made two calls, and its note opens with the
 * port's running count (`page.look (N of M)`). That is exactly what
 * {@link lookToolPort} counts, so the durable step history is the whole record
 * of the allowance and a resume on any machine reads it back unchanged.
 */
export function looksTaken(steps: readonly StepTrace[]): number {
  let taken = 0;
  for (const step of steps) {
    if (step.action.type !== 'callTool' || step.action.tool !== LOOK_TOOL || step.error !== undefined) continue;
    const tally = LOOK_TALLY.exec(step.tool?.note ?? '');
    taken = Math.max(taken + 1, tally === null ? 0 : Number(tally[1]));
  }
  return taken;
}

/**
 * The `page.look` port for ONE run on one browser. The count lives in this
 * closure, seeded with {@link LookToolOptions.taken}.
 *
 * The count is of VISION CALLS the model answered, not of asks: that is the
 * one event the step history records unambiguously (the step succeeded, and
 * its note carries the running count), so the in-process count and the
 * durable one cannot drift. A look is one call, or two when it took a retake.
 *
 * ── The retake ──────────────────────────────────────────────────────────────
 *
 * One picture was not always enough, MEASURED on neutral fixtures
 * (2026-10-16, stock headless shell at DSF 2, the look model, n=5 per cell):
 *
 *   * a chart drawn from data fetched after load was photographed EMPTY on
 *     every look taken after the loop's settle (canvas and SVG, 0.5 s and 2 s
 *     fetches: 0 of 40), because the settle waits for the tree, which a
 *     canvas and a late SVG do not change;
 *   * a table printed in an image shown as a 300 px thumbnail of a 1,600 px
 *     scan was misread on every look (0 of 20: 1891, 1909, ... for 1874,
 *     1903, ...), with or without the image's reference, because the picture
 *     was always the whole viewport.
 *
 * So the first ask may answer with a RETAKE instead: a box to photograph
 * enlarged ({@link LookAnswer.zoom}), or that the thing is not drawn yet
 * ({@link LookAnswer.unpainted}), and the camera then waits for that part of
 * the page to paint. One retake per look, offered only while the allowance
 * has a call left for it, so a look is at most two calls.
 *
 * A FAILED ask is bounded separately, because the loop's `stepFailures`
 * counts CONSECUTIVE failures and a model alternating a failed look with any
 * other step never trips it — measured by the reviewer at 20 vision calls in
 * 40 steps, against 8 before looks were counted on answer. After
 * {@link MAX_FAILED_LOOKS} failed asks the tool refuses for the rest of the
 * run without calling the model. In-process: a new browser starts a new
 * tally, which the run's re-acquisition breaker already bounds.
 */
export function lookToolPort(options: LookToolOptions): ToolPort {
  const limit = options.maxLooks ?? DEFAULT_LOOKS_PER_RUN;
  const tools = lookTools();
  let used = options.taken ?? 0;
  let failedAsks = 0;
  let lastFailure = '';

  /** One vision call, counted on answer; a failure is counted against {@link MAX_FAILED_LOOKS} and rethrown. */
  async function ask(question: LookQuestion): Promise<LookAnswer> {
    try {
      const answer = await options.vision.ask(question);
      used += 1;
      return answer;
    } catch (error) {
      failedAsks += 1;
      lastFailure = errorText(error);
      throw error;
    }
  }

  async function look(args: Readonly<Record<string, unknown>> | undefined): Promise<ToolCallOutcome> {
    const parsed = parseLookArgs(args);
    if (!parsed.ok) {
      return { isError: true, text: parsed.error };
    }
    if (failedAsks >= MAX_FAILED_LOOKS) {
      return {
        isError: true,
        text:
          `${LOOK_TOOL} is unavailable this run: the vision model failed ${String(failedAsks)} times ` +
          `(last: ${lastFailure}). Work from the tree.`,
      };
    }
    if (used >= limit) {
      return {
        isError: true,
        text:
          `${LOOK_TOOL} has been used ${String(used)} of ${String(limit)} times this run and is spent. ` +
          'Answer from what you have already seen, or work from the tree.',
      };
    }
    const { question, ref } = parsed.value;
    const aim: LookAim = ref === undefined ? {} : { ref };

    let shot: LookShot;
    try {
      shot = await options.camera.shoot(aim);
    } catch (error) {
      // Not counted: nothing was asked of the model, so nothing was spent.
      return { isError: true, text: `${LOOK_TOOL} could not photograph the page: ${errorText(error)}` };
    }

    let answer: LookAnswer;
    try {
      answer = await ask({ question, image: shot.image, enlarged: shot.region !== undefined, retake: used + 1 < limit });
    } catch {
      return { isError: true, text: `${LOOK_TOOL} failed to read the screenshot: ${lastFailure}` };
    }
    let usage = answer.usage;
    const zoomed = answer.zoom === undefined ? undefined : zoomRegion(answer.zoom, shot);
    if ((zoomed !== undefined || answer.unpainted === true) && used < limit) {
      // The retake. A failure here leaves the first answer standing: it is an
      // answer, and the step it ends is not a failed look.
      try {
        const again = await options.camera.shoot(zoomed === undefined ? aim : { region: zoomed }, answer.unpainted === true);
        const second = await ask({ question, image: again.image, enlarged: again.region !== undefined });
        usage = mergeUsage(usage, second.usage);
        answer = second;
        shot = again;
      } catch {
        // Counted by `ask` when the model failed; a camera that failed spent nothing.
      }
    }

    const tally = `${LOOK_TOOL} (${String(used)} of ${String(limit)})`;
    // The answer is kept on the step (`ToolCallOutcome.note`): it is the
    // host's own reading of the page, and before it a look's answer lived
    // only in the next prompt, so no miss that turned on one could be read
    // back (8 of 20 research misses, 2026-10-13).
    if (!answer.found) {
      const text = `${tally}: not visible on screen. ${answer.answer}`;
      return { isError: false, text, note: text, usage };
    }
    const lines = [`${tally}: ${answer.answer}`];
    const point = answer.point === undefined ? undefined : fromGrid(answer.point, shot);
    if (point !== undefined) {
      let location: LookLocation | undefined;
      let failure: string | undefined;
      try {
        location = await options.camera.locate(point);
      } catch (error) {
        // A hit test that failed established nothing about the page, so it is
        // reported as a failure and never as "nothing is there".
        failure = errorText(error);
      }
      if (failure !== undefined) {
        lines.push(
          `It is at (${String(point.x)}, ${String(point.y)}) in the viewport; the element there could not ` +
            `be identified (${failure}).`,
        );
      } else if (location === undefined) {
        lines.push(
          `It is at (${String(point.x)}, ${String(point.y)}) in the viewport. No element with a reference ` +
            `is painted there; to press that point, use {"type":"click","at":${JSON.stringify(point)}}; to rest ` +
            `the pointer on it without a press (a tooltip, a chart's value), use {"type":"hover","at":${JSON.stringify(point)}}.`,
        );
      } else {
        const wire = formatNodeRef(location.ref);
        const label = location.name === undefined || location.name === '' ? '' : ` "${location.name}"`;
        lines.push(
          `It is at (${String(point.x)}, ${String(point.y)}) in the viewport, on [${wire}] ${location.role}${label}. ` +
            `To act on it, use ref "${wire}"; to press that exact point inside it (a canvas, a map), ` +
            `use {"type":"click","at":${JSON.stringify(point)}}; to rest the pointer there without a press ` +
            `(a tooltip, a chart's value), use {"type":"hover","at":${JSON.stringify(point)}}.`,
        );
      }
    }
    const text = lines.join('\n');
    return { isError: false, text, note: text, usage };
  }

  return {
    list: () => tools,
    async call(tool, args): Promise<ToolCallOutcome> {
      if (tool !== LOOK_TOOL) {
        return { isError: true, text: `no tool is named "${tool}" here; this port serves ${LOOK_TOOL}.` };
      }
      return look(args);
    },
  };
}
