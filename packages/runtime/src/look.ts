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
 * {@link MAX_LOOKS_PER_RUN}.
 */

import type { JsonSchema, Usage } from '@outcrawl/scout-core';

import type { ExposedTool, ToolCallOutcome, ToolPort } from './loop';
import type { StepTrace } from './result';
import type { NodeRef } from './snapshot';
import { formatNodeRef, parseNodeRef } from './snapshot';

export const LOOK_TOOL = 'page.look';

/**
 * How many looks one run may make.
 *
 * A look costs one vision call and a couple of seconds, so the bound is on
 * TIME and runaway loops rather than money: eight is two or three reads plus a
 * verification on each of a few pages, which is more than any measured
 * perception failure needed, and small enough that a model asking the same
 * question every step stops within eight steps instead of spending its budget.
 */
export const MAX_LOOKS_PER_RUN = 8;

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

/** One photograph of the focused tab's viewport. */
export interface LookShot {
  readonly image: { readonly mediaType: 'image/png'; readonly base64: string };
  /** The viewport the picture covers, in CSS pixels. The picture may be larger (device pixels). */
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * Where the element the question named sits in the viewport, when it named
   * one. The picture is always the whole viewport — see {@link LookCamera}.
   */
  readonly focus?: ViewportRect;
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
   * The whole viewport, as it is painted now. With `ref`, also where that
   * node sits — and a refusal (throw) when it is not on screen, because this
   * never scrolls: a scroll is an input, and input is the actuator's to send.
   */
  shoot(ref?: NodeRef): Promise<LookShot>;
  /** The node of the page's tree painted at `point`, or `undefined` when no node there has a reference. */
  locate(point: ViewportPoint): Promise<LookLocation | undefined>;
}

/** One question about one picture, as the vision model receives it. */
export interface LookQuestion {
  readonly question: string;
  readonly image: LookShot['image'];
  /** The named element's box on the model's 0-1000 grid, when the question named one. */
  readonly focus?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

/** The vision model's reply, already parsed. */
export interface LookAnswer {
  readonly answer: string;
  /** False when the picture does not show what was asked. */
  readonly found: boolean;
  /** Where the thing asked about is, on a 0-1000 grid of the picture, when the question asked where. */
  readonly point?: ViewportPoint;
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
        'Optional: a [frame-backendNode] reference from the tree, written as "F-N", to direct the look at that element.',
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
  'check a visual result such as a shape you drew. Ask WHERE something is to get its position and, when an ' +
  'element is painted there, its [F-N] reference to act on. It sees only what is on screen: scroll first ' +
  `for anything below. It takes a few seconds and is limited to ${String(MAX_LOOKS_PER_RUN)} per run.`;

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

/** A viewport rectangle on the model's 0-1000 grid, clamped to the picture. */
export function toGrid(
  rect: ViewportRect,
  viewport: LookShot['viewport'],
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  const clamp = (value: number): number => Math.min(1000, Math.max(0, Math.round(value)));
  return {
    x0: clamp((rect.x / viewport.width) * 1000),
    y0: clamp((rect.y / viewport.height) * 1000),
    x1: clamp(((rect.x + rect.width) / viewport.width) * 1000),
    y1: clamp(((rect.y + rect.height) / viewport.height) * 1000),
  };
}

/**
 * A point on the 0-1000 grid, in viewport CSS pixels.
 *
 * The grid is a fraction OF THE PICTURE, and the picture is the viewport, so
 * no device scale factor appears anywhere — the same argument `cdp-widget.ts`
 * makes for its clip. A point outside the grid is not a point in the picture
 * and is refused rather than clamped: clamping would aim at an edge the model
 * never named.
 */
export function fromGrid(point: ViewportPoint, viewport: LookShot['viewport']): ViewportPoint | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  if (point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 1000) return undefined;
  return {
    x: Math.round((point.x / 1000) * viewport.width),
    y: Math.round((point.y / 1000) * viewport.height),
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export interface LookToolOptions {
  readonly camera: LookCamera;
  readonly vision: LookVision;
  /** Defaults to {@link MAX_LOOKS_PER_RUN}. */
  readonly maxLooks?: number;
  /**
   * Looks this RUN already took on earlier browsers — {@link looksTaken} over
   * the resumed intent's steps. The port is rebuilt with every browser the
   * run acquires, so without this seed a crash would hand the run a fresh
   * allowance and the limit would hold per browser, not per run.
   */
  readonly taken?: number;
}

/**
 * How many looks a run's recorded steps show it took: every `page.look` step
 * that did not fail. That is exactly what {@link lookToolPort} counts — a look
 * the vision model ANSWERED — so the durable step history is the whole record
 * of the allowance and a resume on any machine reads it back unchanged.
 */
export function looksTaken(steps: readonly StepTrace[]): number {
  return steps.filter(
    (step) => step.action.type === 'callTool' && step.action.tool === LOOK_TOOL && step.error === undefined,
  ).length;
}

/**
 * The `page.look` port for ONE run on one browser. The count lives in this
 * closure, seeded with {@link LookToolOptions.taken}.
 *
 * A look is COUNTED when the vision model answers it, not when it is asked:
 * that is the one event the step history records unambiguously (the step
 * succeeded), so the in-process count and the durable one cannot drift.
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
  const limit = options.maxLooks ?? MAX_LOOKS_PER_RUN;
  const tools = lookTools();
  let used = options.taken ?? 0;
  let failedAsks = 0;
  let lastFailure = '';

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

    let shot: LookShot;
    try {
      shot = await options.camera.shoot(ref);
    } catch (error) {
      // Not counted: nothing was asked of the model, so nothing was spent.
      return { isError: true, text: `${LOOK_TOOL} could not photograph the page: ${errorText(error)}` };
    }

    let answer: LookAnswer;
    try {
      answer = await options.vision.ask({
        question,
        image: shot.image,
        ...(shot.focus === undefined ? {} : { focus: toGrid(shot.focus, shot.viewport) }),
      });
    } catch (error) {
      failedAsks += 1;
      lastFailure = errorText(error);
      return { isError: true, text: `${LOOK_TOOL} failed to read the screenshot: ${lastFailure}` };
    }
    used += 1;

    const tally = `${LOOK_TOOL} (${String(used)} of ${String(limit)})`;
    if (!answer.found) {
      return { isError: false, text: `${tally}: not visible on screen. ${answer.answer}`, usage: answer.usage };
    }
    const lines = [`${tally}: ${answer.answer}`];
    const point = answer.point === undefined ? undefined : fromGrid(answer.point, shot.viewport);
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
            `is painted there; to press that point, use {"type":"click","at":${JSON.stringify(point)}}.`,
        );
      } else {
        const wire = formatNodeRef(location.ref);
        const label = location.name === undefined || location.name === '' ? '' : ` "${location.name}"`;
        lines.push(
          `It is at (${String(point.x)}, ${String(point.y)}) in the viewport, on [${wire}] ${location.role}${label}. ` +
            `To act on it, use ref "${wire}"; to press that exact point inside it (a canvas, a map), ` +
            `use {"type":"click","at":${JSON.stringify(point)}}.`,
        );
      }
    }
    return { isError: false, text: lines.join('\n'), usage: answer.usage };
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
