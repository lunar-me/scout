/**
 * TEXT-IN-IMAGE CAPTCHAS: a site's own picture of distorted characters, a text
 * field and a submit button (OC-280).
 *
 * Found on BU Bench V1 #10 (pngtree, `run_…`, 2026-10-01): the page is
 * an `<img src=/api/captcha/captcha-code>`, an input and "Submit". Nothing in
 * the existing paths answers it:
 *
 *   * the browser raises no hold, because its widget detector keys on an id or
 *     class containing "captcha" and this image carries neither;
 *   * no route in `@outcrawl/captcha` sells a text task on our keys;
 *   * the actuator will not type a code it read itself — 3 of 3 BU runs that
 *     day ended `fail` with "Solving a CAPTCHA is meant for a person".
 *
 * So the HOST answers it, below the model, exactly as it answers every other
 * challenge a run meets. The code is read by the run's own `page.look` vision
 * model (already bought for the run, no new vendor) from a photograph of the
 * image element alone — re-fetching the image's URL would mint a new code and
 * strand the one on screen. It is then typed and submitted as two ordinary
 * steps through the same human-modelled input path every model action takes.
 *
 * NOTHING ON THE PAGE IS HIDDEN, ALTERED OR SCRIPTED. The find is a DevTools
 * DOM read (no page script), the photograph is a compositor read, and the
 * typing and the press are the hands every other step uses — see
 * `worker/src/widget-cloak.ts` for why an element-keyed cover is refused.
 *
 * A form with another field still empty (a login with a captcha) is never
 * submitted by the host: the code is typed and the model is told, so the run
 * fills the rest and submits it itself.
 */

import type { Usage } from '@outcrawl/scout-core';

import type { AxTree, NodeRef } from './snapshot';
import { findNode, formatNodeRef, walk } from './snapshot';

/** One text captcha on the focused page, as the host found it. */
export interface TextCaptchaSighting {
  /** The image element holding the code. Read from the DOM: an unnamed image may have no tree line. */
  readonly image: NodeRef;
  /** The field the code goes into: a `textbox` in the tree, empty. */
  readonly input: NodeRef;
  /**
   * How the code is submitted: the form's own button; `'enter'` in the field
   * when the form has no button; `'model'` when another field of the same
   * form is still empty — that form is the run's to finish and submit, so the
   * host types the code and leaves the rest to the model.
   */
  readonly submit: NodeRef | 'enter' | 'model';
}

/** The code the vision model read off the image. */
export interface TextCaptchaReading {
  readonly code: string;
  readonly usage?: Usage;
}

/**
 * The host's half, bound to the FOCUSED tab. Both methods must be invisible to
 * the page: a DevTools DOM read and a compositor capture, never a script.
 */
export interface TextCaptchaPort {
  /** Under the freeze: is there a text captcha on this page, and where. */
  find(tree: AxTree): Promise<TextCaptchaSighting | undefined>;
  /** With the page live (a frozen page composites nothing): photograph the image and read it. Throws when unreadable. */
  read(sighting: TextCaptchaSighting): Promise<TextCaptchaReading>;
}

/**
 * Answers per page url per run. A wrong answer reloads a fresh image; three is
 * what a person gets on most of these forms before they lock, and what bounds
 * a host that is reading wrong to three steps and three ~$0.0004 looks.
 */
export const TEXT_CAPTCHA_ATTEMPTS = 3;

/** The question the look model is asked about the cropped image. */
export const TEXT_CAPTCHA_QUESTION =
  'This picture is a verification code image from a web form. Copy the characters it shows, in order, ' +
  'exactly as painted (letters and digits only, keep case). Answer with the characters alone.';

/**
 * Words a text-captcha page shows somewhere: its heading, its prompt, the
 * field's label or placeholder. Only a CHEAP GATE in front of the DOM read, so
 * a page without one pays nothing; the decision itself is the DOM's.
 */
const PAGE_WORDS =
  /captcha|verif|security (?:code|check)|enter (?:the )?(?:code|characters)|characters (?:you see|shown|below|above)|not a robot|are you (?:a )?human|human check|验证/i;

/**
 * Whether this tree MAY hold a text captcha: a textbox, an image (or none
 * named: an unnamed `<img>` can be dropped from the tree), and the page's own
 * words. Cheap, run on every read; the DOM read behind it is not.
 */
export function mayHoldTextCaptcha(tree: AxTree): boolean {
  let textbox = false;
  let words = PAGE_WORDS.test(tree.url);
  for (const node of walk(tree)) {
    if (node.role === 'textbox' && node.state?.disabled !== true && node.state?.readonly !== true) {
      textbox = true;
    }
    if (!words && ((node.name !== undefined && PAGE_WORDS.test(node.name)) || (node.value !== undefined && PAGE_WORDS.test(node.value)))) {
      words = true;
    }
    if (textbox && words) return true;
  }
  return false;
}

/**
 * The code in a look's answer, or `undefined` when the answer is not one.
 *
 * Letters and digits, 3-12 of them, after stripping quotes and spaces: the
 * shape of every text captcha this ticket targets. Anything else — a sentence,
 * "unreadable", an arithmetic prompt — is a failed read and is never typed.
 */
export function textCaptchaCode(answer: string): string | undefined {
  const code = answer.trim().replace(/^["'`“”‘’]+|["'`“”‘’.]+$/g, '').replace(/\s+/g, '');
  return /^[A-Za-z0-9]{3,12}$/.test(code) ? code : undefined;
}

/** Whether `ref` names an EMPTY, editable textbox in `tree`: the only field the host types into. */
export function emptyTextbox(tree: AxTree, ref: NodeRef): boolean {
  const node = findNode(tree, ref);
  return (
    node?.role === 'textbox' &&
    node.state?.disabled !== true &&
    node.state?.readonly !== true &&
    (node.value ?? '') === ''
  );
}

/** The reasoning a host step records in its trace, in place of the model's. */
export const TEXT_CAPTCHA_FILL_REASON =
  'Outcrawl: the page shows a text verification code in an image; the code was read from that image and typed in by the host.';
export const TEXT_CAPTCHA_SUBMIT_REASON = 'Outcrawl: submitting the text verification code the host typed.';

/** What the model is told after the host submitted a code. */
export function textCaptchaSubmittedNotice(attempt: number): string {
  return (
    `This page's text verification code (attempt ${String(attempt)} of ${String(TEXT_CAPTCHA_ATTEMPTS)}) was read and ` +
    'submitted by Outcrawl, the way other verification checks are handled for you. If the page above is the site, ' +
    'carry on with the task. If the same check is showing again, the answer was refused and Outcrawl tries again by ' +
    'itself; you do not need to type the code.'
  );
}

/** What the model is told when the host typed the code but left the form to it. */
export function textCaptchaTypedNotice(input: NodeRef): string {
  return (
    `Outcrawl typed this page's text verification code into [${formatNodeRef(input)}] for you. The form has other ` +
    'fields: fill them as the task needs and submit the form yourself. Do not change the code.'
  );
}

/** What the model is told when the host could not answer, so it decides with the truth. */
export function textCaptchaUnansweredNotice(reason: string): string {
  return (
    `This page shows a text verification code that Outcrawl could not answer (${reason}). ` +
    'Reach the information by another route if there is one, or report that the site is blocking access.'
  );
}
