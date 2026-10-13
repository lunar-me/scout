/**
 * THE LOOP CAN SEE A CHALLENGE, AND WHAT IT DOES ABOUT ONE.
 *
 * ## The defect, measured
 *
 * `run_…`, `www.nordstrom.com`, 2026-09-11. The document was Imperva's
 * interstitial — one obfuscated script, zero rendered text, no vendor URL
 * anywhere for a URL table or a browser event to match — and the loop had no
 * way to say so. Step 0 settled `blank` in zero milliseconds; steps 1, 2 and 3
 * carried the SAME snapshot hash with no settle recorded at all, because
 * `quiescentAt` in `loop.ts` answers a step whose tree has not moved from the
 * reading before it. The model, shown a tree with nothing in it and told only
 * that the page "may still be loading", filed the run's headline finding as an
 * absence: "No product categories, featured products, or navigation links were
 * found in the provided accessibility tree." The real page arrived at t+1,696
 * ms, because Imperva clears itself.
 *
 * So three separate things had to be true and none of them were: the loop had
 * to RECOGNISE the document, it had to WAIT rather than buy a model call on a
 * page that was about to replace itself, and when waiting was not worth
 * anything it had to hand the model the word for what it was looking at.
 *
 * ## What is under test, and what is deliberately not
 *
 * The gate is `interstitialOf` in `@outcrawl/scout-core` — the same function the
 * scrape path has run since 2026-09-10, keyed on the document's own body and
 * conjoined with the same 256-character floor. Nothing here re-tests that
 * function's own contract, which `packages/core/test/interstitial.test.ts`
 * owns; every fixture below is a captured shape from that table's own
 * measurements, present so the LOOP's behaviour can be driven by a real one.
 *
 * Nothing here solves a challenge, and there is no test asking it to. The
 * solve path is the browser's `Outcrawl.challengeSolving` hold, and a
 * body-signature interstitial raises no such hold by construction — which is
 * the entire reason the body is the signal.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { BUSY_RETRY_CEILING_MS, MAX_TAB_REOPENS, runAgent } from '../src/loop';
import { DEFAULT_SETTLE_POLICY } from '../src/settle';
import type { DocumentProbe, SettledDocument } from '../src/settle';
import type { AxTree } from '../src/snapshot';
import { type Harness, VirtualClock, harness, node, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const done: Action = { type: 'done', summary: 'finished' };
const SITE = 'https://www.nordstrom.com/';

/* ------------------------------------------------------------------ *
 * The captured shapes
 * ------------------------------------------------------------------ */

/**
 * DataDome's, to the shape. `www.g2.com`, 403, 1,704 bytes rendering 43
 * characters, carrying the vendor's `dd` config object — `INTERSTITIAL_MARKERS`
 * has the capture. It is the shape that matters here rather than the byte
 * count: 43 characters of real, settled text with nothing to act on, which is a
 * document the settle accepts as a legitimately sparse PAGE after a quarter of
 * a second. That is the arm a challenge leaves by, and it is why this vendor and
 * not Imperva is the fixture for the wait: Imperva's zero-text shell is
 * root-only and the settle already waits on it for its own reasons.
 */
const DATADOME_SHELL =
  '<html><head><title>g2.com</title></head><body>' +
  "<script>var dd={'rt':'c','cid':'AHrlqAA','hsh':'05B30BD','t':'fe'}</script>" +
  '<script src="https://ct.captcha-delivery.com/c.js"></script>' +
  '<p>Please enable JS and disable any ad blocker</p></body></html>';

/** Measured, `INTERSTITIAL_SELF_CLEARS`: 5,322 / 5,552 / 5,896 ms over three runs. */
const DATADOME_CLEARS_AT_MS = 5_322;

/**
 * Kasada's. `www.canadagoose.com`, 429, 698 bytes: one `window.KPSDK`
 * assignment and one script tag, and the marker is the whole path with the
 * `ips.js` leaf on it, because the UUID prefix alone also serves a passing
 * `www.twitch.tv` page.
 *
 * THE ONE MEASURED REFUSAL TO CLEAR: three consecutive loads in one warm
 * profile, 429 every time with a fresh `x-kpsdk-ct`.
 */
const KASADA_SHELL =
  '<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};</script>' +
  '<script src="/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js?x-kpsdk-im=AAJQ"></script>' +
  '<p>Something went wrong</p></body></html>';

/**
 * Imperva's. `www.nordstrom.com`, 200 with `istl-response: 1`, 252,998 bytes
 * of obfuscated script rendering NOTHING, and the script opens with this
 * assignment. Truncated here because the byte count is not what is under test.
 */
const IMPERVA_SHELL =
  '<html><head><title></title></head><body><script>' +
  "window['istlWasHere'] = true; (function(Z,u,t,U){var OF={}," +
  `${'var OQ=RegExp,OE=Number,Ob=String,OP=Array;'.repeat(8)}}());</script></body></html>`;

/** The real storefront, well over the 256-character floor. */
const STOREFRONT_TEXT =
  'Nordstrom carries shoes and clothing from top brands. ' +
  'Free shipping and free returns on eligible items. '.repeat(6);

/* ------------------------------------------------------------------ *
 * The trees under those documents
 * ------------------------------------------------------------------ */

/**
 * The tree a block page like DataDome's or Kasada's produces: a root, one line
 * of text, nothing actionable. Hash-stable across reads, which is exactly what
 * makes the settle call it a real, sparse page — `nodes > 1` plus one hash held
 * for `quietMs`.
 */
function blockTree(text: string): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'nordstrom.com',
      children: [node({ role: 'StaticText', name: text })],
    }),
    SITE,
  );
}

/** Imperva's: root-only at the site's real url, and zero rendered text. */
const impervaTree = tree(node({ role: 'RootWebArea', name: '' }), SITE);

/** The page the customer asked for: links, text, and a lot of both. */
const storefrontTree = tree(
  node({
    role: 'RootWebArea',
    name: 'Nordstrom Online & in Store',
    children: [
      node({ role: 'link', name: 'Women' }),
      node({ role: 'link', name: 'Shoes' }),
      node({ role: 'StaticText', name: STOREFRONT_TEXT }),
    ],
  }),
  SITE,
);

/** A counting probe, so a test can assert what the document read actually cost. */
function probeFor(read: () => SettledDocument): DocumentProbe & { readonly calls: () => number } {
  let calls = 0;
  return {
    // The floor the product uses: `DEFAULT_MIN_TEXT_LENGTH` in
    // `@outcrawl/render` and `kChallengeTextFloor` in the fork are this same
    // number, written out here because a test that imported one of them would
    // stop being a test of the contract and become a test of that constant.
    textFloor: 256,
    read(): SettledDocument {
      calls += 1;
      return read();
    },
    calls: () => calls,
  };
}

describe('a challenge that clears itself is waited out, not described', () => {
  test('the model is shown the page, and no model call is spent on the shell', async () => {
    const clock = new VirtualClock();
    /** The document, as it is at the instant of each read. */
    const documentNow = (): SettledDocument =>
      clock.now() >= DATADOME_CLEARS_AT_MS
        ? { html: `<html><body><p>${STOREFRONT_TEXT}</p></body></html>`, textLength: STOREFRONT_TEXT.length }
        : { html: DATADOME_SHELL, textLength: 43 };
    const probe = probeFor(documentNow);
    const h = harness({
      clock,
      document: probe,
      // The tree the browser reports, tracking the same clock: the block page
      // until the vendor's own script replaces it, the storefront after.
      snapshot: () =>
        clock.now() >= DATADOME_CLEARS_AT_MS
          ? storefrontTree
          : blockTree('Please enable JS and disable any ad blocker'),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'find the product categories',
      caps: CAPS,
      stepFailures: 3,
      // The measured clearance is 5.3 s, so the wait needs a budget that can
      // reach it. `DEFAULT_SETTLE_POLICY.budgetMs` is 10 s and would do; it is
      // stated here so the assertion below is about a bound this test set.
      settle: { budgetMs: 8_000 },
    });

    expect(result.status).toBe('completed');

    // THE WHOLE POINT: ONE model call, and it read the storefront. Before the
    // gate existed the block page held one hash with nothing actionable on it,
    // so the settle accepted it as a sparse page after 250 ms and the model was
    // asked to describe Nordstrom's categories against 43 characters of
    // "Please enable JS".
    expect(h.events.filter((event) => event === 'model')).toHaveLength(1);
    const shown = h.prompts[0]?.tree;
    expect(shown?.root.children?.map((child) => child.name)).toEqual([
      'Women',
      'Shoes',
      // `filterTree` collapses and trims a name, so this is the storefront's
      // text as the model is actually shown it.
      STOREFRONT_TEXT.trim(),
    ]);
    expect(h.prompts[0]?.notice).toBeUndefined();

    // The wait really happened, and it happened on a LIVE page: the lock is
    // `VirtualTimePolicy::kPause`, so a challenge polled under the freeze could
    // never clear.
    expect(clock.now()).toBeGreaterThanOrEqual(DATADOME_CLEARS_AT_MS);
    expect(h.browser.liveTouches).toBeGreaterThan(0);
    expect(h.browser.frozen).toBe(false);

    // AND THE PRICE IS ON THE TRACE. The verdict is the page's own, because the
    // page is what the settle ended on; the vendor rides along as evidence that
    // the seconds were bought rather than wasted, which is the only way anyone
    // can audit a two-second settle on a run that worked.
    expect(result.steps[0]?.settle?.verdict).toBe('actionable');
    expect(result.steps[0]?.settle?.interstitial).toEqual({
      vendor: 'datadome',
      // The first marker of that vendor's row that matched, which is the
      // challenge script host: `INTERSTITIAL_MARKERS` is ordered most specific
      // first precisely so the reported literal is the better log line.
      marker: 'captcha-delivery.com',
    });
  });

  /**
   * Production 2026-09-25, dictionary.cambridge.org: a 336-character "Just a
   * moment..." tree was settled `actionable` and the model gave up on it 7 s
   * after it committed (run_…, run_…); the same challenge cleared
   * itself 16.6 s after commit on run_… (replay).
   */
  test('a Cloudflare managed challenge over the text floor is recognised and waited out', async () => {
    const clock = new VirtualClock();
    const CLEARS_AT_MS = 16_600;
    const shellText =
      'Performing security verification. dictionary.cambridge.org. This website uses a security service to ' +
      'protect against malicious bots. This page is displayed while the website verifies you are not a bot. ' +
      'Ray ID: a40d7e6de92a9163. Performance and Security by Cloudflare. Privacy';
    const shell =
      '<html lang="en-US"><head><title>Just a moment...</title></head><body>' +
      "<script>(function(){window._cf_chl_opt = {cType: 'managed',cRay: 'a40d7e6de92a9163',cvId: '3'};})();</script>" +
      `<p>${shellText}</p></body></html>`;
    const probe = probeFor(() =>
      clock.now() >= CLEARS_AT_MS
        ? { html: `<html><body><p>${STOREFRONT_TEXT}</p></body></html>`, textLength: STOREFRONT_TEXT.length }
        : { html: shell, textLength: shellText.length },
    );
    const h = harness({
      clock,
      document: probe,
      snapshot: () => (clock.now() >= CLEARS_AT_MS ? storefrontTree : blockTree(shellText)),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'find the definition',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 20_000 },
    });

    expect(shellText.length).toBeGreaterThan(256);
    expect(h.events.filter((event) => event === 'model')).toHaveLength(1);
    expect(h.prompts[0]?.tree.root.children?.map((child) => child.name)).toContain('Women');
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('cloudflare');
  });

  /**
   * Production 2026-10-06/07, Stealth Bench task 15, 8 of 8 serves of Shein's
   * js challenge (`captcha_type=903`): the page is the site's header and
   * footer, so its tree has a search box and links to act on, and it settled
   * `actionable` in 0.3-0.9 s. The model typed into the header search; the
   * check replaced the page 4.0-13.1 s after its document (shopgates-15-5,
   * run_…: 5.4 s), under the model's fill, and the run spent its
   * failures on references the replacement took away.
   */
  test('a challenge page that carries the site\u2019s own controls is waited out all the same', async () => {
    const clock = new VirtualClock();
    const CLEARS_AT_MS = 5_444;
    const SHEIN = 'https://us.shein.com/risk/challenge?captcha_type=903&redirection=x';
    // The two verbatim pieces that decide it, out of the 362,958-character
    // document `packages/scout-core/test/fixtures/interstitials.ts` holds.
    const shell =
      '<html lang="en"><body><header><input type="search" name="header-search"></header><script>var gbRawData = ' +
      '{"isSearchPage":false,"originalUrl":"/risk/challenge?captcha_type=903&redirection=https%3A%2F%2Fus.shein.com%2F' +
      'pdsearch%2Fwinter%2520jackets%2F&risk-id=E4925014249216046720"}</script><script>var SaPageInfo = { page_name: ' +
      "'page_risk_crawler_block', page_id: 6407 }</script></body></html>";
    const challengeTree = tree(
      node({
        role: 'RootWebArea',
        name: 'SHEIN',
        children: [
          node({ role: 'searchbox', name: '' }),
          node({ role: 'link', name: 'Account' }),
          node({ role: 'link', name: 'Cart' }),
          node({ role: 'StaticText', name: 'COMPANY INFO About SHEIN Social Responsibility HELP & SUPPORT Shipping Info Returns' }),
        ],
      }),
      SHEIN,
    );
    const probe = probeFor(() =>
      clock.now() >= CLEARS_AT_MS
        ? { html: `<html><body><p>${STOREFRONT_TEXT}</p></body></html>`, textLength: STOREFRONT_TEXT.length }
        : { html: shell, textLength: 1_372 },
    );
    const h = harness({
      clock,
      document: probe,
      snapshot: () => (clock.now() >= CLEARS_AT_MS ? storefrontTree : challengeTree),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'search for winter jackets', caps: CAPS, stepFailures: 3 });

    // One model call, on the page the check let through, never on the header.
    expect(h.events.filter((event) => event === 'model')).toHaveLength(1);
    expect(h.prompts[0]?.tree.root.children?.map((child) => child.name)).toContain('Women');
    expect(result.steps[0]?.settle?.verdict).toBe('actionable');
    expect(result.steps[0]?.settle?.interstitial).toEqual({
      vendor: 'shein-js-challenge',
      marker: '/risk/challenge?captcha_type=903',
    });
    expect(clock.now()).toBeGreaterThanOrEqual(CLEARS_AT_MS);
  });

  /**
   * Production 2026-10-07 07:22Z, crocs.com run_…: a Cloudflare managed
   * challenge (a 429 with `window._cf_chl_opt`, two links on it) POSTed its
   * clearance at +4.3 s; the settle concluded `actionable` at +5.4 s on the
   * challenge's tree, the extract found no products, and the judge failed the
   * run on that screen. Here the document read clears before the tree does.
   */
  test('a challenge tree still standing when the document has cleared is waited past', async () => {
    const clock = new VirtualClock();
    const DOCUMENT_CLEARS_AT_MS = 4_300;
    const TREE_CLEARS_AT_MS = 5_600;
    const shellText =
      'www.crocs.com Performing security verification This website uses a security service to protect against ' +
      'malicious bots. This page is displayed while the website verifies you are not a bot. Ray ID: a46b27aaab9a2dae';
    const shell =
      '<html lang="en-US"><head><title>Just a moment...</title></head><body>' +
      "<script>(function(){window._cf_chl_opt = {cType: 'managed',cRay: 'a46b27aaab9a2dae'};})();</script>" +
      `<p>${shellText}</p></body></html>`;
    const challengeTree = tree(
      node({
        role: 'RootWebArea',
        name: 'Just a moment...',
        children: [
          node({ role: 'StaticText', name: shellText }),
          node({ role: 'link', name: 'Cloudflare' }),
          node({ role: 'link', name: 'Privacy' }),
        ],
      }),
      SITE,
    );
    const probe = probeFor(() =>
      clock.now() >= DOCUMENT_CLEARS_AT_MS
        ? { html: `<html><body><p>${STOREFRONT_TEXT}</p></body></html>`, textLength: STOREFRONT_TEXT.length }
        : { html: shell, textLength: shellText.length },
    );
    const h = harness({
      clock,
      document: probe,
      snapshot: () => (clock.now() >= TREE_CLEARS_AT_MS ? storefrontTree : challengeTree),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'search lined clogs', caps: CAPS, stepFailures: 3, settle: { budgetMs: 10_000 } });

    expect(h.events.filter((event) => event === 'model')).toHaveLength(1);
    expect(h.prompts[0]?.tree.root.children?.map((child) => child.name)).toContain('Women');
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('cloudflare');
  });

  test('a page with content never pays for a document read', async () => {
    // The cost argument, as an assertion. The read is the whole DOM serialised,
    // so it is spent only where the tree already says there is nothing there:
    // `interstitialOf`'s own ordering, tested from this side.
    const probe = probeFor(() => {
      throw new Error('the gate read the document on a page that has content');
    });
    // Over the exclusive-marker read ceiling (2,048 characters, Anubis's), which
    // is what "has content" means once a small interstitial can sit over the floor.
    const fullStorefront = tree(
      node({
        role: 'RootWebArea',
        name: 'Nordstrom Online & in Store',
        children: [node({ role: 'link', name: 'Women' }), node({ role: 'StaticText', name: STOREFRONT_TEXT.repeat(7) })],
      }),
      SITE,
    );
    const h = harness({
      document: probe,
      snapshot: () => fullStorefront,
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, { task: 'read it', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('completed');
    expect(probe.calls()).toBe(0);
  });
});

describe('a challenge that will not clear itself is named, not waited on', () => {
  test('the notice names the vendor and refuses to call it a page that may still be loading', async () => {
    const clock = new VirtualClock();
    const probe = probeFor(() => ({ html: KASADA_SHELL, textLength: 21 }));
    const h = harness({
      clock,
      document: probe,
      snapshot: () => blockTree('Something went wrong'),
      // An honest stop: the model is told what the document is and what waiting
      // is worth against this vendor, and declines. That refusal is HONOURED,
      // unlike one taken against a page that had not rendered.
      model: () => ({ action: { type: 'fail', reason: 'the site is serving a bot check' } }),
    });

    const result = await runAgent(h.deps, { task: 'find the categories', caps: CAPS, stepFailures: 3 });

    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(1);

    const notice = h.prompts[0]?.notice ?? '';
    // The sentence the model needed. Named vendor, named shape, and the
    // instruction that stops the measured failure: do not report a fact as
    // absent on the strength of a document the site never showed us.
    expect(notice).toContain('bot-check interstitial');
    expect(notice).toContain('kasada');
    expect(notice).toContain('measured NOT to clear itself');
    expect(notice).toContain('is NOT evidence about the task');
    // The sentence it was given instead, and the reason this ticket exists: it
    // is true of a challenge and useless about one.
    expect(notice).not.toContain('may still be loading');
    expect(notice).not.toContain('produced no interactive elements');

    // NO WAIT WAS BOUGHT. Kasada answered three consecutive loads with a 429,
    // so re-reading is measured waste: the settle reports at once rather than
    // spending its 10-second budget on a document that has been shown never to
    // relent. `quietMs` is what it costs to prove the tree held still.
    expect(clock.now()).toBeLessThanOrEqual(DEFAULT_SETTLE_POLICY.quietMs * 2);
    expect(result.steps[0]?.settle?.verdict).toBe('challenge');
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('kasada');
  });

  test('a gate a press clears names its button, and is reported without a wait', async () => {
    // Amazon's one-press gate, the heading and form of the capture in
    // `packages/scout-core/test/fixtures/interstitials.ts` (2026-09-25), trimmed.
    // Its tree HAS an actionable node — the button — which is why the model
    // must be told what it is: otherwise it is a page with one button on it.
    //
    // MUTATION THIS CATCHES: the gate falling through to the waiting branch,
    // or the notice not naming the control a click would land on.
    const clock = new VirtualClock();
    const shell =
      '<html><body><h4>Click the button below to continue shopping</h4>' +
      '<form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="x">' +
      '<button type="submit" class="a-button-text">Continue shopping</button></form></body></html>';
    const probe = probeFor(() => ({ html: shell, textLength: 142 }));
    const h = harness({
      clock,
      document: probe,
      snapshot: () =>
        tree(
          node({
            role: 'RootWebArea',
            name: 'Amazon.com',
            children: [
              node({ role: 'StaticText', name: 'Click the button below to continue shopping' }),
              node({ role: 'button', name: 'Continue shopping' }),
            ],
          }),
          'https://www.amazon.com/',
        ),
      model: () => ({ action: { type: 'fail', reason: 'the site is serving a gate' } }),
    });

    const result = await runAgent(h.deps, { task: 'find the deals', caps: CAPS, stepFailures: 3 });

    const notice = h.prompts[0]?.notice ?? '';
    expect(notice).toContain('bot-check interstitial');
    expect(notice).toContain('amazon-continue');
    expect(notice).toContain('"Continue shopping" button is pressed');
    expect(notice).toContain('is NOT evidence about the task');
    expect(notice).not.toContain('replaces itself with the real page');
    expect(result.steps[0]?.settle?.verdict).toBe('challenge');
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('amazon-continue');
    expect(clock.now()).toBeLessThan(DEFAULT_SETTLE_POLICY.budgetMs);
  });

  test('a self-clearing challenge that outlasts the budget is told, and re-settled on the next step', async () => {
    // Imperva, not clearing. This is `run_…`'s exact shape: a root-only
    // tree at a real url that never moves. The bug was not that the loop failed
    // to wait — it waited — but that the SECOND step read the same unmoving tree
    // and got no settle, no notice and no word at all, because `quiescentAt`
    // answered it from the first step's reading.
    const clock = new VirtualClock();
    const probe = probeFor(() => ({ html: IMPERVA_SHELL, textLength: 0 }));
    const h = harness({
      clock,
      document: probe,
      snapshot: () => impervaTree,
      model: (_prompt, step) =>
        step === 0
          ? // What a model told "reloading it is a real option" does.
            { action: { type: 'navigate', url: SITE } }
          : { action: { type: 'fail', reason: 'still a bot check' } },
    });

    const result = await runAgent(h.deps, {
      task: 'find the categories',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 2_000 },
    });

    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(2);

    // Both steps settled, and both were told. The second settle is the
    // assertion: an identical tree at an identical url, and it is NOT taken as
    // "nothing left to wait for" — a challenge is the one document where an
    // unmoving tree means the page has not arrived.
    expect(result.steps[0]?.settle?.verdict).toBe('challenge');
    expect(result.steps[1]?.settle?.verdict).toBe('challenge');
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('imperva');
    expect(h.prompts[0]?.notice).toContain('imperva');
    expect(h.prompts[1]?.notice).toContain('imperva');
    // It waited the budget out before saying so, on both steps: Imperva DOES
    // clear itself, measured, so the only honest reason to stop waiting is that
    // the authorised budget is gone.
    expect(result.steps[0]?.settle?.waitedMs).toBeGreaterThanOrEqual(2_000);
    expect(result.steps[1]?.settle?.waitedMs).toBeGreaterThanOrEqual(2_000);
  });
});

/**
 * THE ORDERING, WHICH IS WHAT MADE THE GATE UNREACHABLE ON THE PAGE IT IS FOR.
 *
 * The loop locks before it reads, and it must. `Outcrawl.lock` is answered in
 * the renderer, so a page executing script HOLDS it — and an Imperva
 * interstitial is a CPU-bound proof of work, which is to say the state "a
 * challenge is running" and the state "this renderer will not answer a freeze"
 * are one state. MEASURED in production, `run_…`, 2026-09-11: failed, 8
 * steps, 4.55 credits, 36 s, "the renderer of https://www.nordstrom.com/ has
 * not answered Outcrawl.lock for 5.0s ... The page is executing script and
 * cannot be frozen." Every one of those steps died before a tree was read, so
 * the settle never ran and the gate above never fired.
 *
 * Reading the document BEFORE the lock instead does not work, and it is
 * measured rather than argued: `Runtime.evaluate` runs on the same main thread.
 * On the shipped binary against a page pegging its thread for 12 s, healthy
 * `Runtime.evaluate` answered in 6 ms and `Outcrawl.lock` in 0 ms; pegged, the
 * document read was HELD for 5,001 ms and the freeze for 5,002 ms, and both
 * replies arrived together when the thread freed.
 */
describe('a renderer that will not stop long enough to be frozen is waited out', () => {
  /** The host's own sentence, from `sendFreeze` in `packages/worker`. */
  function busyRenderer(): Error {
    const error = new Error(
      `Outcrawl.lock was refused without being sent: the renderer of ${SITE} has not answered ` +
        'Outcrawl.lock for 5.0s, and a freeze command sent now would queue behind it in that same ' +
        'renderer. The page is executing script and cannot be frozen.',
    );
    error.name = 'FreezeNotAnsweredError';
    return error;
  }

  test('the step survives the busy renderer and the gate then runs on the document', async () => {
    const clock = new VirtualClock();
    let refusals = 0;
    const probe = probeFor(() =>
      clock.now() >= DATADOME_CLEARS_AT_MS
        ? {
            html: `<html><body><p>${STOREFRONT_TEXT}</p></body></html>`,
            textLength: STOREFRONT_TEXT.length,
          }
        : { html: DATADOME_SHELL, textLength: 43 },
    );
    const h = harness({
      clock,
      document: probe,
      // Three refusals — the shape of a renderer mid-proof-of-work — and then
      // the thread frees and the freeze is answered.
      lock: () => {
        refusals += 1;
        if (refusals <= 3) throw busyRenderer();
      },
      snapshot: () =>
        clock.now() >= DATADOME_CLEARS_AT_MS
          ? storefrontTree
          : blockTree('Please enable JS and disable any ad blocker'),
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'find the product categories',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 8_000 },
    });

    // ONE step, no error, and the answer came off the real page. Before this,
    // the first refusal ended the step and three of them ended the run.
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.error).toBeUndefined();
    expect(h.events.filter((event) => event === 'lock').length).toBeGreaterThan(3);
    expect(h.prompts[0]?.tree.root.children?.map((child) => child.name)).toContain('Women');
    // And the gate reached the document, which is the whole point of waiting:
    // the freeze finally came down, the read happened, and the challenge was
    // recognised and waited out under it.
    expect(result.steps[0]?.settle?.interstitial?.vendor).toBe('datadome');
  });

  test('the page is taken the moment the renderer frees, not one rung later', async () => {
    // The retry gap is the only thing between "the thread freed" and "the loop
    // noticed", and it is pure added latency on the recovery this path exists
    // for: a retry during the hold sends nothing, because the host refuses
    // locally while a freeze command is outstanding. So the gap escalates from
    // 50 ms and stops at BUSY_RETRY_CEILING_MS rather than at the settle's
    // 800 ms — which on Imperva's measured 1,696 ms clearance is the
    // difference between noticing at 1,850 ms and noticing at 2,350 ms.
    const clock = new VirtualClock();
    /** Measured: the real page arrived at t+1,696 ms on www.nordstrom.com. */
    const FREES_AT_MS = 1_696;
    let lockedAt = -1;
    const h = harness({
      clock,
      document: probeFor(() => ({ html: IMPERVA_SHELL, textLength: 0 })),
      lock: () => {
        if (clock.now() < FREES_AT_MS) throw busyRenderer();
        if (lockedAt < 0) lockedAt = clock.now();
      },
      snapshot: () => storefrontTree,
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'read the page',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 8_000 },
    });

    expect(result.status).toBe('completed');
    // The freeze instant, not the model instant: everything after the freeze
    // is the settle doing its own measured job (a page that just arrived owes
    // `growthQuietMs` of stillness), and folding that in would make this a
    // second, worse test of the settle.
    expect(lockedAt).toBeGreaterThanOrEqual(FREES_AT_MS);
    expect(lockedAt - FREES_AT_MS).toBeLessThanOrEqual(BUSY_RETRY_CEILING_MS);
  });

  test('a page busy for some other reason still fails honestly, after a bounded wait', async () => {
    // The other half of the contract. Waiting is not a way to never report a
    // problem: a renderer that never frees ends the run with the host's own
    // sentence, and no model call is ever bought against a page nobody could
    // read. The tree here carries no interstitial marker at all — this is a
    // page that is merely busy.
    const clock = new VirtualClock();
    const probe = probeFor(() => ({ html: '<html><body>busy</body></html>', textLength: 4 }));
    const h = harness({
      clock,
      document: probe,
      lock: () => {
        throw busyRenderer();
      },
      snapshot: () => storefrontTree,
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'find the product categories',
      caps: CAPS,
      stepFailures: 2,
      settle: { budgetMs: 1_000 },
    });

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    // Code first and a sentence a caller can act on, then the host's own
    // sentence for whoever debugs it (run_… reached its owner as the
    // bare host sentence, naming a CDP method of ours).
    expect(result.error).toStartWith('page-unresponsive: ');
    expect(result.error).toContain('Retry the run');
    expect(result.error).toContain('cannot be frozen');
    // Each step still carries the host's sentence alone.
    expect(result.steps[0]?.error).toStartWith('Outcrawl.lock was refused without being sent');
    expect(h.events).not.toContain('model');
    // Bounded, and the bound is per pass: each failing step waited its
    // page-read budget of 1,000 ms and not a millisecond more, so the run's
    // whole cost is one budget per step it spent.
    expect(result.steps).toHaveLength(3);
    expect(clock.now()).toBe(result.steps.length * 1_000);
  });

  test('a tab that stops answering is reopened at the same url and the run reads it there', async () => {
    // OC-289, a fleet Mac 2026-10-02: a ra.co tab whose renderer spun in the page's
    // own script answered nothing again, while a NEW tab at the same url loaded
    // and read. Before, the run spent its whole tolerance on refused freezes and
    // ended `page-unresponsive` without the model being asked again.
    const clock = new VirtualClock();
    const tabs: { current?: Harness } = {};
    const h = harness({
      clock,
      document: probeFor(() => ({ html: '<html><body>busy</body></html>', textLength: 4 })),
      tabs: [{ id: 't0', url: SITE }],
      lock: () => {
        if (tabs.current?.tabState.active === 't0') throw busyRenderer();
      },
      snapshot: () => storefrontTree,
      model: () => ({ action: done }),
    });
    tabs.current = h;

    const result = await runAgent(h.deps, {
      task: 'find the product categories',
      caps: CAPS,
      stepFailures: 2,
      settle: { budgetMs: 1_000 },
    });

    expect(result.status).toBe('completed');
    expect(h.tabState.open.map((tab) => tab.url)).toEqual([SITE]);
    expect(h.tabState.active).not.toBe('t0');
    // The model was told what happened, on the first prompt it got.
    expect(h.prompts).toHaveLength(1);
    expect(JSON.stringify(h.prompts[0])).toContain('stopped answering');
  });

  test('a page that wedges every fresh tab still ends the run, after a bounded number of reopens', async () => {
    const clock = new VirtualClock();
    const h = harness({
      clock,
      document: probeFor(() => ({ html: '<html><body>busy</body></html>', textLength: 4 })),
      tabs: [{ id: 't0', url: SITE }],
      lock: () => {
        throw busyRenderer();
      },
      snapshot: () => storefrontTree,
      model: () => ({ action: done }),
    });

    const result = await runAgent(h.deps, {
      task: 'find the product categories',
      caps: { ...CAPS, steps: 20 },
      stepFailures: 2,
      settle: { budgetMs: 1_000 },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toStartWith('page-unresponsive: ');
    expect(h.events.filter((event) => event === 'tabs.open')).toHaveLength(MAX_TAB_REOPENS);
    expect(h.events).not.toContain('model');
  });

  /**
   * run_…, production 2026-10-01: the step's pass settled ra.co's event
   * page, the model finished `done` with a complete answer, and only then was
   * `Outcrawl.unlock` held by the renderer for 5 s. So the release fails from
   * the moment the model has decided, and every freeze before that is answered.
   */
  function heldAfterDecision(action: Action): Harness {
    let decided = false;
    return harness({
      clock: new VirtualClock(),
      unlock: () => {
        if (!decided) return;
        const error = new Error(
          `Outcrawl.unlock was not answered by the renderer of ${SITE} within 5000ms. The command is ` +
            'handled in the renderer, so a page busy executing script holds it rather than refusing it.',
        );
        error.name = 'FreezeNotAnsweredError';
        throw error;
      },
      snapshot: () => storefrontTree,
      model: () => {
        decided = true;
        return { action };
      },
    });
  }

  test('a finish whose freeze will not come down still returns its answer', async () => {
    // Before: the throw turned the finish into a failed step, the next steps
    // were refused on the same held unlock, and the run ended `failed` with
    // no data. The release is all that failed; the finish needs nothing more
    // from the page.
    const answer = 'Appetite On The Farm 2026, https://ra.co/events/2311488';
    const h = heldAfterDecision({ type: 'done', summary: answer });

    const result = await runAgent(h.deps, {
      task: 'find an event and give its link',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 1_000 },
    });

    expect(h.events.filter((event) => event === 'model')).toHaveLength(1);
    expect(h.events.indexOf('unlock', h.events.indexOf('model'))).toBeGreaterThan(0);
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toBe(answer);
    expect(result.error).toBeUndefined();
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.error).toBeUndefined();
  });

  test('a give-up whose freeze will not come down is still the model’s verdict', async () => {
    const h = heldAfterDecision({ type: 'fail', reason: 'the site lists no such event' });

    const result = await runAgent(h.deps, {
      task: 'find an event and give its link',
      caps: CAPS,
      stepFailures: 3,
      settle: { budgetMs: 1_000 },
    });

    expect(result.stopReason).toBe('gave-up');
    expect(result.error).toBe('the site lists no such event');
    expect(result.steps).toHaveLength(1);
  });
});
