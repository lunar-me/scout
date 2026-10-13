/**
 * `page.verify`: complete a site's own picture check — a slider puzzle,
 * pictures to click until they face one way, objects to drag into boxes.
 *
 * OC-281. Temu sends a search click to `/bgn_verification.html`, a puzzle
 * slider it builds itself (`slider_verify`, `/api/phantom/obtain_captcha`).
 * Nothing names it a captcha, so the browser never holds it and no solver is
 * called; the model then reads a slider it has no way to answer and fails the
 * run — BU Bench #80, `run_…` (2026-10-01) and `run_…`
 * (2026-10-02 14:09Z): "Solving a CAPTCHA is meant for a human, so I didn't
 * try it."
 *
 * The model cannot answer it with `drag` either, and not for want of trying:
 * the piece has to stop on a gap it can only see while the button is held
 * (Temu swaps both pictures in on the press), so a press-move-release chosen
 * from a screenshot taken before the press aims at a decoy. The host does the
 * whole gesture — press, look, slide, release — through the same human pointer
 * path every other drag uses. See `worker/src/slider-puzzle.ts`.
 *
 * Temu serves two more kinds on the same page (`run_…` and
 * `run_…`, 2026-10-02 17:07Z): a grid of one picture turned different
 * ways ("click each image as needed so that the objects all face the same
 * direction") and objects to drag into boxes ("fill each box with the
 * required number of objects"), and after a passed slider a line to drag over
 * shapes (`run_…`, 18:12Z). One tool serves all four, because the model
 * cannot be expected to tell which one it is looking at before calling it:
 * `worker/src/rotate-puzzle.ts`, `worker/src/drop-puzzle.ts`,
 * `worker/src/line-puzzle.ts`.
 *
 * And PerimeterX's "Press & Hold" (Stealth Bench V1, 2026-10-05/06: seven
 * failed instances, each with the model calling this tool and nothing on the
 * page holding the button): `worker/src/hold-check.ts`. And GeeTest's "Click
 * to verify" with its "Select in this order" icon picture, served inside
 * Imperva's block page (task 63, smythstoys): `worker/src/geetest-check.ts`.
 *
 * Runs on the LIVE page, as `page.look` does (`PageSession.callTool`): input
 * reaches no frozen renderer.
 *
 * ── AND WITHOUT BEING ASKED, ONCE PER CHECK ─────────────────────────────────
 *
 * The browser already clears a reCAPTCHA or hCaptcha hold without the model
 * asking. A check these solvers know was left on screen until the model
 * thought to call this tool, and it often did not: Stealth Bench task 15,
 * `run_…` (2026-10-07, n=1), read every answer through Shein's "I am
 * human" box and never called it; the judge saw the box in the last two
 * screenshots and failed the run. In runs 11-14 (2026-10-07) Shein's box or
 * PerimeterX's Press & Hold stood in 3 to 9 of the judge's screenshots before
 * or without a call on 7 of 43 misses. So when the host SIGHTS such a check on
 * screen before a page read ({@link SiteCheckToolOptions.sight}: the solvers'
 * own vendor-specific anchors, one tree walk), the loop has it worked by the
 * same solvers, through the same hands, before the read
 * ({@link SiteCheckPort.workSighted}), and the outcome reaches the step trace
 * and the model as any browser solve does (`PageSession.takeChallengeOutcomes`).
 */

import type { ChallengeOutcomeNote, ExposedTool, SightedCheckPort, ToolCallOutcome, ToolPort } from './loop';

export const SITE_CHECK_TOOL = 'page.verify';

/**
 * How many times one run may call it. Each call already retries a puzzle the
 * page re-serves (see the host), so a run that needs a fourth call is a page
 * refusing us, and the model is better told so than allowed to loop.
 */
export const MAX_SITE_CHECK_CALLS_PER_RUN = 3;

export const SITE_CHECK_TOOL_DESCRIPTION =
  'Complete a verification check the site itself is showing: a "Press & Hold" button, a "Click to verify" check with ' +
  'icons to select in order, a slider puzzle ("slide to complete the puzzle"), a grid of pictures to click until they ' +
  'all face the same way, objects to drag into the boxes that ask for them, or a line to drag over a set of shapes. ' +
  'It works the check as a person would ' +
  'and says whether the page accepted it. ' +
  'Use it whenever such a check stands between you and the task instead of giving up or asking for help. ' +
  `It takes several seconds and is limited to ${String(MAX_SITE_CHECK_CALLS_PER_RUN)} per run.`;

/** What one host attempt established. */
export interface SiteCheckResult {
  /**
   * `solved`: the check is gone or the page moved on. `refused`: it is still
   * there after every attempt. `absent`: no check this tool knows on the page.
   * `unreadable`: there is one, but it could not be worked (off screen, say).
   */
  readonly outcome: 'solved' | 'refused' | 'absent' | 'unreadable';
  /** One sentence for the model, already phrased. */
  readonly detail: string;
  /** Whether any input reached the page. Only a touched check is recorded by {@link SiteCheckPort.workSighted}. */
  readonly touched?: boolean;
}

/** A check the host found on screen, before a page read, that `solve` works. */
export interface SiteCheckSighting {
  /** Which check, as the step trace names its vendor: `px`, `shein`, `geetest`, `bytedance`. */
  readonly kind: string;
  /** The page it is on. */
  readonly url: string;
}

export interface SiteCheckToolOptions {
  /** The focused tab's solver. */
  readonly solve: () => Promise<SiteCheckResult>;
  /** The focused tab's sighting; absent, {@link SiteCheckPort.workSighted} never works anything. */
  readonly sight?: () => Promise<SiteCheckSighting | undefined>;
  /** Defaults to {@link MAX_SITE_CHECK_CALLS_PER_RUN}. */
  readonly maxCalls?: number;
}

/** The `page.verify` tool, and the browser's own once-per-check attempt, on one allowance. */
export interface SiteCheckPort extends ToolPort, SightedCheckPort {}

/**
 * Sightings of one check on one page that ended with nothing touched (a Press
 * & Hold whose button had not painted yet, say) before it is left to the
 * model: each costs a solver read, not an allowance.
 */
const UNTOUCHED_SIGHTINGS = 2;

export function siteCheckTools(): readonly ExposedTool[] {
  return [
    {
      name: SITE_CHECK_TOOL,
      description: SITE_CHECK_TOOL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

/** The `page.verify` port for one run on one browser. */
export function siteCheckToolPort(options: SiteCheckToolOptions): SiteCheckPort {
  const limit = options.maxCalls ?? MAX_SITE_CHECK_CALLS_PER_RUN;
  const tools = siteCheckTools();
  let used = 0;
  /**
   * Set by the model's own call, spent by the next {@link workSighted}: the
   * page it is standing on is the one the model just worked, so a check
   * still shown there is the model's, and is never worked again.
   */
  let modelJustCalled = false;
  /** `kind url` of every sighted check that was worked: never twice. */
  const worked = new Set<string>();
  /** `kind url` -> sightings that touched nothing. */
  const untouched = new Map<string, number>();

  /**
   * Every reply carries a `note` the step keeps (`StepTrace.tool`): the
   * outcome word and the host's own sentence, which describe what the solver
   * did and what the page answered and nothing the page says. Without it a
   * failed call left only "reported an error" on the run's record.
   */
  async function verify(): Promise<ToolCallOutcome> {
    modelJustCalled = true;
    if (used >= limit) {
      const text =
        `${SITE_CHECK_TOOL} has been used ${String(used)} of ${String(limit)} times this run and the page still ` +
        'refuses it. Reach the information another way, or fail naming the site\u2019s verification check.';
      return { isError: true, text, note: `limit: ${text}` };
    }
    used += 1;
    let result: SiteCheckResult;
    try {
      result = await options.solve();
    } catch (error) {
      const text = `${SITE_CHECK_TOOL} could not complete the check: ${error instanceof Error ? error.message : String(error)}`;
      return { isError: true, text, note: `threw: ${text}` };
    }
    const text = `${SITE_CHECK_TOOL} (${String(used)} of ${String(limit)}): ${result.detail}`;
    return { isError: result.outcome !== 'solved', text, note: `${result.outcome}: ${text}` };
  }

  /**
   * Works a sighted check once, on the run's allowance, and says what came
   * of it in the terms a browser solve reports. A check worked and still
   * there is `rejected`; one the solvers began and could not finish (the
   * look model placed no icons, say) is `exhausted`. Nothing touched is no
   * record and no allowance spent. A throw is counted and not retried, and
   * not recorded: input may have reached the page, and nothing is known.
   */
  async function workSighted(): Promise<ChallengeOutcomeNote | undefined> {
    if (options.sight === undefined || used >= limit) return undefined;
    const seen = await options.sight();
    const theModels = modelJustCalled;
    modelJustCalled = false;
    if (seen === undefined) return undefined;
    const key = `${seen.kind} ${seen.url}`;
    if (theModels) worked.add(key);
    const idle = untouched.get(key) ?? 0;
    if (worked.has(key) || idle >= UNTOUCHED_SIGHTINGS) return undefined;
    used += 1;
    let result: SiteCheckResult;
    try {
      result = await options.solve();
    } catch {
      worked.add(key);
      return undefined;
    }
    if (result.touched !== true) {
      used -= 1;
      untouched.set(key, idle + 1);
      return undefined;
    }
    worked.add(key);
    if (result.outcome === 'solved') return { kind: 'inpage', detector: seen.kind, solved: true };
    return { kind: 'inpage', detector: seen.kind, solved: false, reason: result.outcome === 'refused' ? 'rejected' : 'exhausted' };
  }

  return {
    list: () => tools,
    async call(tool): Promise<ToolCallOutcome> {
      if (tool !== SITE_CHECK_TOOL) {
        return { isError: true, text: `no tool is named "${tool}" here; this port serves ${SITE_CHECK_TOOL}.` };
      }
      return verify();
    },
    workSighted,
  };
}
