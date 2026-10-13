/**
 * WHETHER A SETTLED DOCUMENT IS A VENDOR INTERSTITIAL, decided from the
 * document's own bytes.
 *
 * ── THE GAP THIS CLOSES, AND WHY IT IS NOT WHERE IT LOOKS LIKE IT IS ────────
 *
 * `familyOf` in `@outcrawl/captcha` answers `null` for `datadome`, `px` and
 * `imperva`, and that answer is correct and must stay: they are continuous
 * behavioural systems, there is no widget for a solver to look at and no token
 * that settles them, and — the measurement that makes it concrete — they fire
 * on pages that are NOT challenging us. An UNCHALLENGED `zillow.com` carries a
 * 1x1 `js.px-cloud.net` frame. Routing that to a solver pays a model to look at
 * a page with no puzzle on it, once per protected page load.
 *
 * What `null` ALSO meant, silently, is that there was no route at all for the
 * case where the fingerprint does not hold. When one of these vendors does
 * challenge us, nothing anywhere said so, and the interstitial was extracted
 * and shipped as the page.
 *
 * ── WHY THE FORK'S OWN LABEL CANNOT COVER IT ────────────────────────────────
 *
 * `Outcrawl.documentSettled` carries `reason: 'challenge'`, which is the
 * renderer stating that a terminated document has a challenge vendor loaded AND
 * renders under the text floor. Both halves are right. The first half is
 * decided by `::outcrawl::ClassifyChallengeUrl`, a table of vendor URLs — and
 * an interstitial served by a behavioural vendor loads NO vendor URL, because
 * the interstitial IS the site's own document at the site's own address.
 *
 * MEASURED, `www.nordstrom.com`, 2026-09-10, through the built fork
 * (`Chrome/152.0.7977.64`) on CDP 9944:
 *
 *     t+  353 ms  200  https://www.nordstrom.com/   istl-response: 1
 *     t+  355 ms  main-frame commit
 *     t+  622 ms  documentSettled reason=parser-finished textLength=0
 *                 252,998 bytes of HTML, 53 tags, ZERO rendered text
 *     t+1,696 ms  the real page, IN THE SAME DOCUMENT — no second response,
 *                 no second commit: 4,322 chars, 204 links
 *     t+9,211 ms  10,641 chars, 313 links
 *
 * One settle event, `parser-finished`, on a document holding no page. Zero
 * `Outcrawl.challengeDetected`. That is the whole failure: the label cannot
 * fire, the settle is terminal and truthful, and the read ends on the shell.
 *
 * So the discriminator has to be the interstitial's own BODY, which is the one
 * thing a URL table cannot see. This is a second table beside the fork's on
 * purpose, and the reason is a measurement rather than a preference: every row
 * here is a vendor whose interstitial carried no vendor URL at the instant it
 * settled. Where a row names a third-party vendor its spelling is the same
 * string as `CHALLENGE_DETECTORS` in `@outcrawl/captcha`, deliberately, so a
 * body match and a URL match cannot name one vendor two ways. `facebook` is the
 * one row with no such spelling to agree with, because the challenge is Meta's
 * own and no URL table anywhere can classify it; see {@link InterstitialVendor}
 * for why that is the rule holding rather than the rule bending.
 *
 * ── THE NEGATIVE CONTROL IS THE POINT, AND IT REMOVED TWO ROWS ──────────────
 *
 * "A marker for the vendor" is not the test. The test is "a marker only an
 * INTERSTITIAL carries". Measured the same night, the FULLY LOADED pages,
 * dumped from the same four browsers:
 *
 *     www.nordstrom.com      560,820 B  10,641 chars  313 links   no marker
 *     www.leboncoin.fr       934,012 B   7,887 chars  454 links   no marker
 *     accounts.binance.com    86,000 B     475 chars    1 link    no marker
 *     www.zillow.com         412,838 B   3,170 chars  274 links   `_pxAppId`,
 *                                                                 `px-cloud.net`
 *
 * `_pxAppId` and `px-cloud.net` are on the page PerimeterX did not challenge.
 * They are the sensor, and they are exactly the fact `familyOf`'s `null`
 * branches are argued from. They are therefore NOT markers here, and the rows
 * that survive for that vendor are the three the block page alone carries:
 * `px-captcha`, `_pxHostUrl` and `_pxJsClientSrc`.
 *
 * ── AND WHY IT IS A CONJUNCTION WITH THE CALLER'S TEXT FLOOR ────────────────
 *
 * Neither half stands alone.
 *
 * A marker alone fires on a page that is fine — the paragraph above IS that
 * case, and no table curated by hand can be trusted to have caught every leak
 * of a vendor's sensor into a healthy document. The floor is the second line,
 * and it holds even for a marker that leaked: the unchallenged `zillow.com`
 * renders 3,170 characters.
 *
 * A floor alone fires on a document that is legitimately bare. `parser-finished`
 * with almost no text is a real state for a sitemap, a `robots.txt` or a JSON
 * document — `apple.com/sitemap.xml` renders 114 characters out of 72,718 bytes
 * — and holding a customer's read open for a challenge ceiling on one of those
 * would buy nothing and cost seconds.
 *
 * The floor is the CALLER's, passed in rather than defaulted, because a
 * caller reads it off the same renderer it reads the document from. The
 * product's number is {@link DEFAULT_MIN_TEXT_LENGTH}, below, which is also the
 * browser's own `kChallengeTextFloor`.
 */

/**
 * A vendor whose interstitial this table can recognise from its body.
 *
 * NOT "every challenge vendor". A row exists here only where an interstitial
 * was captured and its markers checked against a fully loaded page — the same
 * site's wherever the vendor would let one through. `cloudflare`, `recaptcha`,
 * `hcaptcha`, `geetest` and `arkose` are absent because they did not need to be
 * present: those serve their challenge from a vendor URL, so the fork's own
 * `reason: 'challenge'` already labels them, and adding an unmeasured row here
 * would be a guess wearing a measurement's clothes.
 *
 * `f5` is absent for a stronger reason: it cannot be named from a body at all.
 * Its telemetry is on outgoing REQUEST headers under rotating per-deployment
 * names, so there is nothing in a document to match.
 *
 * Adding one is cheap and the bar is fixed: capture the interstitial, capture a
 * loaded page, and show the marker on the first and not the second. That is
 * what `test/interstitial.test.ts` asserts, per row.
 *
 * ── `facebook` IS THE FIRST ROW WHOSE ISSUER IS THE SITE ─────────────────────
 *
 * Every other member is a third-party vendor and is spelled exactly as
 * `CHALLENGE_DETECTORS` in `@outcrawl/captcha` spells it, so that a body match
 * and a URL match cannot name one vendor two ways. `facebook` is not in that
 * list and cannot be: `CHALLENGE_DETECTORS` mirrors the fork's
 * `outcrawl_challenge_url.cc`, a table of VENDOR URLS, and Meta's challenge is
 * served by Meta's own edge from a path on the site's own origin. There is no
 * URL spelling for it to disagree with, so the rule that produced the shared
 * spellings is satisfied vacuously rather than broken.
 *
 * WHAT THAT DOES NOT LICENSE. It is not "any site may have a row". The bar is
 * unchanged and it is the only thing that admits one — captured challenge,
 * captured loaded page, marker on the first and not the second. What this row
 * establishes is that a first-party issuer is not disqualified by being
 * first-party, which is the same argument the module header already makes about
 * behavioural vendors: the interstitial IS the site's own document at the
 * site's own address, and that is precisely why a URL table cannot see it.
 *
 * The name is the property it was measured on and not `meta`, because
 * `www.facebook.com` is the only one it was measured on. If `/__rd_verify` is
 * ever captured on `instagram.com` the MARKER already covers it and the NAME is
 * the thing to revisit.
 *
 * ── `amazon-continue` IS THE FIRST ROW A PERSON CLEARS WITH ONE PRESS ────────
 *
 * Amazon's own soft gate: a 200 at the site's own address holding one heading,
 * "Click the button below to continue shopping", and one `<form method="get"
 * action="/errors_page/validateCaptcha">` whose only visible control is a
 * "Continue shopping" submit button. No vendor script, no puzzle, no timer — so
 * it neither clears itself nor needs a solver; it stands until the button is
 * pressed. Named for the GATE rather than the site, because Amazon serves other
 * gates from the same `validateCaptcha` path (the image captcha, "Enter the
 * characters you see below") that a press does not clear, and those must never
 * match this row. See {@link INTERSTITIAL_CONTROLS}.
 *
 * ── `shein-js-challenge` IS NAMED FOR ITS GATE, FOR AMAZON'S REASON ──────────
 *
 * Shein's risk service serves several checks from one page,
 * `/risk/challenge?captcha_type=<n>`, and the page's own configuration names
 * them: `RISK_SDK_TYPE: {"903":"js_challenge","904":"slide","905":"click",
 * "909":"one_pass","910":"nine_captcha"}`. Only 903 is a check the page answers
 * by itself; 909 is the "I am human" box a person presses (`page.verify`'s
 * Shein reader). Both are the same template with the same header and footer,
 * so the row names 903 alone, and the others must never match it.
 */
export type InterstitialVendor =
  | 'imperva'
  | 'datadome'
  | 'px'
  | 'awswaf'
  | 'akamai'
  | 'kasada'
  | 'facebook'
  | 'amazon-continue'
  | 'cloudflare'
  | 'anubis'
  | 'shein-js-challenge';

/** A vendor interstitial, and the literal that proved it. */
export interface Interstitial {
  readonly vendor: InterstitialVendor;
  /**
   * The matched literal, carried so a log line names the EVIDENCE and not just
   * the verdict. A gate that fires on the wrong page is diagnosed from this
   * field and from nothing else on the wire.
   */
  readonly marker: string;
}

/**
 * The markers, by vendor. Every one of these was read out of a captured
 * interstitial on 2026-09-10 and checked absent from that site's loaded page.
 *
 * Ordered most specific first within a vendor, because the first match is what
 * gets reported and a `<meta>` naming the block page is a better log line than
 * a variable name.
 */
export const INTERSTITIAL_MARKERS: Record<InterstitialVendor, readonly string[]> = {
  /**
   * `www.nordstrom.com`, 200, 252,998 bytes, 53 tags, 0 rendered text. The
   * whole document is one obfuscated script that opens with this assignment,
   * and the response carries `istl-response: 1`.
   */
  imperva: ['istlWasHere'],
  /**
   * `www.leboncoin.fr`, 403, 771 bytes rendering 43 characters ("Please enable
   * JS and disable any ad blocker"), and `www.g2.com`, 403, 1,704 bytes. Both
   * carry the vendor's `dd` config object and its challenge script host.
   */
  datadome: ['captcha-delivery.com', "var dd={'rt'"],
  /**
   * `www.zillow.com`, 403, 5,776 bytes. `px-captcha` is the block page's own
   * `<meta name="description">`; the two `window._px*` names are the first-party
   * challenge endpoints it writes for its captcha script.
   *
   * `_pxAppId` and `px-cloud.net` are NOT here. Measured on the same site's
   * unchallenged 412,838-byte page, which carries both.
   */
  px: ['px-captcha', '_pxHostUrl', '_pxJsClientSrc'],
  /**
   * `accounts.binance.com/en/register`, 202 with `x-amzn-waf-action: challenge`,
   * 1,301 bytes, 8 nodes, 0 rendered text. The fork DOES label this one
   * `reason: 'challenge'` — measured at t+1,206 ms — because the shell loads
   * `token.awswaf.com/.../challenge.js`, a vendor URL. The row is here anyway:
   * the label depends on a subresource load winning a race with the settle, and
   * the body is already in hand.
   */
  awswaf: ['awsWafCookieDomainList', 'token.awswaf.com'],
  /**
   * `www.walgreens.com/search/results.jsp?Ntt=vitamin`, 200, 1,891 bytes. Akamai's
   * `sec-cpt` challenge, which is a COUNTDOWN rather than a puzzle: the base64
   * `challenge=` attribute on its `<iframe id="sec-cpt-if">` decodes to
   * `{"difficulty":500,"timeout":1000,"powduration":1,...}`, the page computes a
   * proof of work, and `cp_clge_done()` — declared in the head — calls
   * `location.reload(true)`.
   *
   * The negative control is the same URL loaded through the fork: 1,663,445
   * bytes rendering 36,410 characters and 648 links, carrying NONE of these
   * five. That is the cleanest control in this table, because it is the same
   * site both ways.
   */
  akamai: [
    '<title>Challenge Validation</title>',
    'sec-cpt-if',
    'sec-if-container',
    'sec-text-if',
    'cp_clge_done',
  ],
  /**
   * `www.canadagoose.com/us/en/home-page`, 429, 698 bytes, and the body is one
   * `window.KPSDK` assignment plus one script tag. THE MARKER IS THE WHOLE
   * PATH AND THE `ips.js` LEAF IS THE LOAD-BEARING PART OF IT.
   *
   * The UUID pair is not per customer — it is Kasada's, byte-identical across
   * deployments — and `www.twitch.tv` carries it on a 309,920-byte page
   * rendering 2,072 characters behind a 200, where the same prefix serves
   * `p.js`, `fp` and `tl` and never `ips.js`. So the prefix alone fails this
   * table's bar and the prefix plus the leaf passes it. Measured both ways,
   * 2026-09-10.
   *
   * `window.KPSDK` is deliberately NOT a marker: the interstitial sets it and so
   * does the sensor on a passing page, which makes it presence rather than
   * challenge — the same mistake `_pxAppId` would have been.
   */
  kasada: ['/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js'],
  /**
   * `www.facebook.com/ads/library/?…&q=shopify&search_type=keyword_unordered`,
   * HTTP/2 403, 481 bytes, 5 elements, 0 rendered text, `content-length: 481`,
   * `x-fb-rd: 1` and `proxy-status: http_request_denied; e_proxy=…;
   * e_fb_twtaskhandle=…`. Captured 2026-09-12 19:05:10 UTC by `curl -4` with no
   * cookies; verified on disk at 481 bytes with this literal occurring once.
   *
   * Meta's own edge and not a vendor's. The entire body is one IIFE that POSTs
   * to `/__rd_verify_<per-request-token>?challenge=3` and then calls
   * `window.location.reload()` in a `.finally`, so the clearance MECHANISM is
   * legible in the bytes rather than only in a timeline — the same standing as
   * the `cp_clge_done` evidence in the akamai row above, and here it is
   * corroborated by the timing too. See `INTERSTITIAL_SELF_CLEARS`.
   *
   * THE MARKER IS THE PATH PREFIX AND STOPS BEFORE THE TOKEN. The verify path
   * carries a per-request token, so only `/__rd_verify` is stable across
   * requests. The leading slash is part of it: this is a path, and it is what
   * distinguishes the literal from a variable that happens to be named that.
   * Nothing is assumed about the separator that follows, because one capture
   * cannot establish it.
   *
   * `executeChallenge` IS DELIBERATELY NOT A MARKER, and it is the whole reason
   * this row has one literal and not two. It occurs three times in the
   * challenge and zero times on the loaded page, so it passes the table's bar
   * as stated — and it is a bare function name in first-party script, which is
   * the `_pxAppId` mistake with a different spelling. A generic identifier that
   * any site might declare buys nothing here (the path prefix already names the
   * document) and risks a challenge ceiling on a healthy page that happens to
   * have a function by that name.
   *
   * The negative control is the same URL on the same day, 19:03:52 UTC, through
   * `POST /v1/scrape`: 2,238,068 bytes, 9,456 elements, 30,240 rendered
   * characters, 88 anchors, and `__rd_verify` and `executeChallenge` at ZERO —
   * both counts verified on disk. Same site both ways, which is this table's
   * strongest form of control.
   */
  facebook: ['/__rd_verify'],
  /**
   * Cloudflare's managed challenge, "Just a moment...". The fork names it from
   * its vendor URL when the challenge-platform script loads, but an agent's
   * settle reads bodies, and its interstitial carries 280-370 characters of
   * text ("Performing security verification ... This website uses a security
   * service ..."), over the text floor, so it needs a marker that holds above
   * it: see {@link EXCLUSIVE_MARKER_TEXT_CEILING}.
   *
   * `window._cf_chl_opt` is the challenge page's own configuration object
   * (`cType: 'managed'`, `cRay`, `cvId`). Measured 2026-09-26 by plain HTTP
   * fetch with a Chrome user agent: present on 4 of 4 "Just a moment..." 403s
   * (stackoverflow.com/questions, udemy.com, coinbase.com, medium.com) and on
   * the dictionary.cambridge.org interstitial in replay sess_…; absent
   * from 5 of 5 loaded Cloudflare-fronted pages (cloudflare.com, discord.com,
   * nowsecure.nl, patreon.com, and dictionary.cambridge.org's own 281,253-byte
   * page). A loaded page's bot-management script is `__CF$cv$params`, which is
   * NOT a marker.
   */
  cloudflare: ['window._cf_chl_opt'],
  /**
   * `www.amazon.com/`, 200, 3,781 bytes (1,333 gzipped), 39 elements, captured
   * 2026-09-25 17:24:56Z and again 17:28:52Z through a residential mobile exit by
   * `curl` with a Chrome user agent, after the page's own Akamai `bm-verify`
   * hop. The two captures differ only in the form's per-request `amzn` and
   * `field-keywords` values. Production served the same gate at `amazon.in`
   * (2 of 2 scrapes, 2026-09-25 ~17:30Z, 345 characters of markdown under
   * "#### Click the button below to continue shopping").
   *
   * THE MARKER IS THE HEADING, NOT THE FORM. `/errors_page/validateCaptcha` and
   * a "Continue shopping" button are ALSO on Amazon's image captcha, which a
   * press does not clear; only the heading names the one-press gate.
   *
   * The negative control is the same site both ways: the page the second
   * capture's own form submitted to — `www.amazon.com/`, 777,863 bytes — and
   * a loaded `www.amazon.in/`, 1,084,229 bytes, both carry the heading ZERO
   * times and `validateCaptcha` zero times.
   */
  'amazon-continue': ['Click the button below to continue shopping'],
  /**
   * Anubis (TecharoHQ/anubis), a proof-of-work gate a site runs in front of
   * itself. Its page computes SHA-256 in a Web Worker, then navigates to
   * `/.within.website/x/cmd/anubis/api/pass-challenge`, which sets a cookie and
   * redirects to the page asked for. While it works, the DOM does not change and
   * nothing is fetched, so a stop rule that waits only for quiet stops on it.
   *
   * CAPTURED 2026-09-29 20:45Z by `curl` with a Chrome user agent:
   * `books.openedition.org/pur/12467?lang=en`, 200, 5,302 bytes, 492 characters
   * of text from the bytes; `proforto.nl/werkschoenen/...`, 200, 5,405 bytes,
   * 379 characters. The same URLs through our browser in the a fleet Mac lab
   * (2026-09-29, mix200 WPR, Throughput's arms) rendered 418-542 characters of
   * markdown, and `redlib.catsarch.com/r/stocks/top` rendered 1,476. So the text is
   * over the floor, and the marker is trusted up to
   * {@link EXCLUSIVE_MARKER_CEILINGS}'s 2,048 for this vendor.
   *
   * THE MARKER IS THE CHALLENGE'S OWN CONFIGURATION ELEMENT,
   * `<script id="anubis_challenge" type="application/json">`: the random data
   * and the difficulty the page's worker hashes. The negative control is the
   * same site: the page the solved challenge redirected to (248,890 bytes,
   * `books.openedition.org`; 644,447 bytes, `proforto.nl`) holds `anubis_challenge`
   * and `.within.website` ZERO times, both counted on the full documents.
   */
  anubis: ['id="anubis_challenge"'],
  /**
   * `us.shein.com/risk/challenge?captcha_type=903&redirection=…&risk-id=…`,
   * 200, 362,958-363,212 bytes, the redirect a deep url such as
   * `/pdsearch/winter%20jackets/` gets from Shein's risk service. Stored by
   * production sessions 2026-10-06/07 (Stealth Bench task 15; four stored
   * bodies of eight served). The page is the site's header and footer and
   * nothing else; the check is `risk_challenge-*.js`, which runs the type the
   * url names and `location.replace`s to `redirection` when it passes.
   *
   * THE MARKER IS THE PAGE'S OWN URL IN ITS SERVER STATE: `gbRawData`'s
   * `"originalUrl":"/risk/challenge?captcha_type=903…"`, 4 of 4 stored bodies.
   * Read live on the fleet (2026-10-07, `sess_…`, isolated world): in
   * the document's outerHTML from its first parsed chunk to the end. The
   * negative controls are the same site and the same template: 7 of 7 stored
   * 909 pages (the box a person presses) carry `captcha_type=909` there and
   * this literal zero times, as do 8 of 8 stored `us.shein.com/` front pages
   * and the stored cart; the live front page and live 909 (same session) did
   * not carry it either.
   */
  'shein-js-challenge': ['/risk/challenge?captcha_type=903'],
};

/**
 * WHETHER WAITING FOR THIS VENDOR TO CLEAR ITSELF IS WORTH ANYTHING.
 *
 * ── THE ASYMMETRY IS DELIBERATE: `true` IS THE DEFAULT AND NEEDS NO PROOF ───
 *
 * The two answers do not carry the same risk. Waiting on a vendor that never
 * relents costs a challenged page some latency it was never going to spend
 * well. Refusing to wait on a vendor that WOULD have cleared ships the
 * interstitial, which is the entire defect this module exists to close. So
 * `true` is what a vendor gets by default, and only a MEASURED refusal to clear
 * turns it off.
 *
 * ── THE ONE MEASURED REFUSAL ────────────────────────────────────────────────
 *
 * Kasada. `www.canadagoose.com`, 2026-09-10, three consecutive loads in one
 * warm fork profile: 429 every time, each with a fresh `x-kpsdk-ct`. Re-reading
 * that document for a 15-second ceiling cannot produce a page, so it does not.
 * The LABEL is unaffected — a document under the text floor behind a challenge
 * is never reported as a terminal one, whatever this table says.
 *
 * ── WHY EACH `true` IS ALSO EVIDENCE AND NOT AN ASSUMPTION ──────────────────
 *
 * `imperva`: the real page arrived at t+1,696 ms in the same document,
 * `www.nordstrom.com`, measured. `awswaf`: a second commit at t+1,330 ms and a
 * second settle at t+3,104 ms, `accounts.binance.com`, measured. `datadome`:
 * 403 -> 200 at 5,322 / 5,552 / 5,896 ms across three runs on
 * `g2.com/products/notion/reviews`, measured. `akamai`: read out of the
 * captured bytes rather than clocked — the interstitial's own `cp_clge_done()`
 * calls `location.reload(true)` when its proof of work completes, and its
 * declared `powduration` is 1 second. `facebook`: BOTH, and it is the
 * best-evidenced row here — the body calls `window.location.reload()` in the
 * `.finally` of its own verify POST, and the reload was clocked in Chromium on
 * the root frame's Document responses at 403 t+352 ms -> 200 t+857 ms, 505 ms,
 * ending on a document rendering 30,236 characters. `px`: NOT measured either
 * way. Its captured block page renders "Press & Hold to confirm you are a
 * human", which argues for a gesture rather than a countdown; it stays `true`
 * because that is what an unmeasured vendor gets, and the cost of being wrong
 * here is latency on a page that was already blocked.
 *
 * ── WHAT 505 ms COSTS: NOTHING, AND NOT FOR THE REASON IT LOOKS LIKE ───────
 *
 * Reasoning from the recheck schedule says two or three extra reads and half a
 * second of wall time: the sleeps are 150, 300 and 600 ms
 * (`INTERSTITIAL_RECHECK_FLOOR_MS` doubling towards
 * `INTERSTITIAL_RECHECK_CEILING_MS`), so 505 ms would land in the third window.
 * THAT IS NOT WHAT HAPPENS. Measured through the shipped binding against these
 * exact bytes, with the verify POST's 505 ms reproduced: `reads: 1`,
 * `settleMs: 540`, the single read at t+575 ms, and the gate never armed.
 *
 * The shell never settles. `parser-finished` needs the `ResourceFetcher`
 * drained, and the shell's own verify POST is in flight for the whole 505 ms,
 * so no terminal condition is reached before the reload commits. The settle the
 * pipeline waits for is the SECOND document's, and the one read it takes lands
 * on the page. A clearing Facebook challenge costs this gate nothing because
 * the gate is never reached.
 *
 * SO THE ROW IS NOT FOR THE ENDING THAT CLEARS. It is for the one that does
 * not: a verify that fails, or a clearance slower than
 * `DEFAULT_SETTLE_CEILING_MS`, leaves the 481-byte 403 as the document in hand,
 * and without a marker there is nothing to stop it being extracted and shipped
 * as the page under `parser-finished`. That ending is UNMEASURED on this site —
 * the captured script reloads unconditionally in its `.finally`, so a failing
 * verify is a reload loop rather than a static shell, and what Meta's edge does
 * after N of those has not been observed here. `true` is what an unmeasured
 * clearance gets, and this one is measured positively anyway.
 *
 * The RELOAD is still why none of the same-document machinery applies. Imperva
 * produces no event, so that case has to observe quiescence — two consecutive
 * reads at one rendered length — and buys the difference with one extra tick. A
 * commit is authoritative; there is nothing to observe.
 */
export const INTERSTITIAL_SELF_CLEARS: Record<InterstitialVendor, boolean> = {
  imperva: true,
  datadome: true,
  px: true,
  awswaf: true,
  akamai: true,
  kasada: false,
  facebook: true,
  // Read out of the captured bytes: the document carries no script at all, so
  // nothing in it can navigate. It clears by a PRESS; see
  // `INTERSTITIAL_CONTROLS`.
  'amazon-continue': false,
  // Measured 2026-09-25, dictionary.cambridge.org run_… (n=1, from its
  // replay): committed at +34.3 s, replaced by the page itself at +50.9 s, with
  // no token delivered. g2.com and stackoverflow.com clear the same way (see
  // `PageChallengeOutcome`'s `self-cleared`).
  cloudflare: true,
  // Read out of the captured bytes and measured in the lab: the page's own
  // script solves its proof of work and navigates to the page asked for. The
  // a fleet Mac lab (2026-09-29, arms without a quiet-window switch) read the real
  // page on 156 of 156 renders of three Anubis-gated URLs.
  anubis: true,
  // MEASURED from production sessions' network, 2026-10-06/07, 8 of 8 served
  // 903 pages (Stealth Bench task 15): the page loaded `gee_js_challenge.js`
  // 1.8-7.8 s after its document, posted `/risk/verify/identity/validation/
  // check` and `/api/risk/flow_check`, and replaced itself with its
  // `redirection` 4.0-13.1 s after the document, every time with no input. The
  // redirection was then answered with Shein's 909 box in 7 of 8 and with the
  // results in 1, so waiting buys the page AFTER the check, never the check
  // itself. One fresh session loading a 903 url with no `risk-id` directly
  // (2026-10-07, `sess_…`) stayed on it 17 s; that is the latency the
  // asymmetry above accepts.
  'shein-js-challenge': true,
};

/**
 * WHETHER THIS VENDOR'S INTERSTITIAL HAS BEEN SEEN TO CLEAR ITSELF AFTER THE
 * SOLVER GAVE UP ON ITS WIDGET.
 *
 * {@link INTERSTITIAL_SELF_CLEARS} answers "is waiting worth anything" with no
 * solver in the picture. This answers the narrower question a wait has once
 * the solver has already answered `unsupported`, `exhausted` or `timeout` for
 * the page's in-page widget and nothing else is in flight: is the page still
 * going to arrive on its own? `false` ends the wait there, and the
 * interstitial is returned with its `blocked_interstitial` warning.
 *
 * MEASURED, fleet logs of both Macs, 2026-09-25 17:14Z to 2026-09-26 01:40Z,
 * every `/v1/scrape` with an unsolved in-page hold:
 *
 *   cloudflare  0 of 20 cleared after the solver refused its Turnstile widget
 *               (viewdns.info, primoo.nl, fleuriste-leparadisdesfleurs.fr,
 *               indeed.com, stockx.com, e-atrbpn.net). primoo.nl 01:30Z: the
 *               refusal landed at +3.5 s and the read held to +15.0 s on a
 *               document that never changed.
 *   datadome    2 of 4 cleared after the refusal (arabianbusiness.com, 2 of 2;
 *               etsy.com 0 of 2), the later one 12 s after it.
 *   awswaf      1 of 7 cleared (amazon.in, 18 s after the refusal).
 *
 * RE-MEASURED, fleet logs of both Macs, 2026-10-01T00:45Z to
 * 2026-10-02T16:12Z, scrape traces carrying an `unsupported` verdict, counted
 * per trace:
 *
 *   px          0 of 36 cleared AFTER the verdict. Four www.target.com pages
 *               replaced themselves 0.09-0.16 s BEFORE it (4.4-4.9 s into the
 *               hold), 17 were already-served pages (same document, 200), 10
 *               stayed 403. zoominfo.com held 8 s direct plus 15 s
 *               residential behind one on 2026-10-02 14:19Z for nothing.
 *   imperva     0 of 24 cleared after it: 7 already-served pages within
 *               0.2 s, 17 stayed blocked.
 *   datadome    129 of 153 cleared after it (verdict to clear p50 3.9 s,
 *               max 12.5 s), so it keeps waiting. Cloudflare's NATIVE
 *               navigation verdict likewise (286 of 337), which is the
 *               no-widget case below and never reaches this table.
 *
 * A Cloudflare challenge with NO in-page widget refused — the navigation hold
 * alone answers `unsupported` in 5 ms on every Cloudflare interstitial — keeps
 * its whole wait: that is the self-clearing precursor stackoverflow.com and
 * dictionary.cambridge.org replace without any token (see
 * {@link INTERSTITIAL_SELF_CLEARS}). Vendors never measured after a refusal
 * keep `true`, for the asymmetry {@link INTERSTITIAL_SELF_CLEARS} gives. Kasada
 * and the one-press gate never clear by waiting at all.
 *
 * A WIDGET THE SOLVER LEFT TO THE PAGE IS NOT A REFUSAL and never reaches this
 * table: Cloudflare's own Turnstile on Cloudflare's own interstitial, which
 * the orchestrator hands back because nothing can be bought for it
 * (`leftToPage`). The page then clears itself or shows its checkbox
 * ({@link INTERSTITIAL_CONTROLS}); digikey.com cleared itself in 5.8-13.1 s
 * for our browser, real Brave and real Chrome (a fleet Mac, 2026-09-27, n=2 exits).
 */
export const INTERSTITIAL_CLEARS_AFTER_REFUSAL: Record<InterstitialVendor, boolean> = {
  imperva: false,
  datadome: true,
  px: false,
  awswaf: true,
  akamai: true,
  kasada: false,
  facebook: true,
  'amazon-continue': false,
  cloudflare: false,
  // Nothing in an Anubis gate is a widget, so a solver never refuses one.
  anubis: true,
  // Nothing in it is a widget either: the check runs behind the header.
  'shein-js-challenge': true,
};

/** Whether a vendor string the browser reported names a vendor these tables know. */
export function isInterstitialVendor(vendor: string): vendor is InterstitialVendor {
  return Object.hasOwn(INTERSTITIAL_CLEARS_AFTER_REFUSAL, vendor);
}

/**
 * The one control a person presses to clear an interstitial that waiting never
 * will.
 *
 * `selector` is matched against the live document, and a caller that finds no
 * such element, or finds it outside the viewport, presses nothing: a press is
 * only ever aimed at what is on screen, the way a person's would be.
 * `label` is the control's visible text, so a model being told about the gate
 * is told what it would click.
 */
export interface InterstitialControl {
  readonly selector: string;
  readonly label: string;
  /**
   * Set when the control lives in a CROSS-ORIGIN FRAME the interstitial
   * embeds, and names the origin that frame is served from. `selector` is
   * then an accessibility role inside that frame rather than a CSS selector:
   * the frame is out of process and sits under a closed shadow root, so no
   * selector in the interstitial's own document reaches it.
   *
   * Such a control is not there when the document arrives. The page runs its
   * own check first and shows the control only when that check wants a
   * person, so a caller looks for it while it waits for the page to clear
   * itself and presses it once it is on screen, never before.
   */
  readonly frame?: string;
}

/**
 * The interstitials a press clears, and the control to press.
 *
 * A row here is a claim that one press of a real, human-modelled pointer on the
 * named control lets the page through. `amazon-continue` is measured at the
 * HTTP layer only: on 2026-09-25 17:28:52Z the captured form's own GET
 * (`/errors_page/validateCaptcha` with its three hidden fields, same exit, same
 * cookie jar) answered with the 777,863-byte `www.amazon.com/` homepage (n=1).
 * Through the browser it is not yet measured: no browser may be launched
 * outside the fleet.
 *
 * `cloudflare` is the "Verify you are human" checkbox Cloudflare's own
 * Turnstile shows on its interstitial when its check wants a person (viewdns,
 * sciencedirect, indeed). Measured on a fleet Mac, 2026-09-27 20:23-20:47Z
 * (CfStealth): waiting cleared none of those three for any browser, and one
 * press on the checkbox cleared ours 6 of 7 times with GPU painting on and 6
 * of 7 with it off, real Brave 1.94.117 4 of 5, real Chrome 6 of 7.
 */
export const INTERSTITIAL_CONTROLS: Partial<Record<InterstitialVendor, InterstitialControl>> = {
  'amazon-continue': {
    selector: 'form[action*="validateCaptcha"] button[type="submit"]',
    label: 'Continue shopping',
  },
  cloudflare: {
    selector: 'checkbox',
    label: 'Verify you are human',
    frame: 'https://challenges.cloudflare.com',
  },
};

/**
 * How many presses a caller spends on one gate before reporting it unresolved.
 * Two: one that may land before the page is ready for it, and one more. A gate
 * still standing after a second real press is refusing us, and a third is a
 * pattern a person would not produce.
 */
export const INTERSTITIAL_PRESS_ATTEMPTS = 2;

/**
 * `INTERSTITIAL_MARKERS` flattened once, at module load, into the order the
 * scan runs in.
 *
 * Built here rather than in the scan because the scan runs on every settled
 * document that holds no text, and rebuilding a table per call to walk it once
 * is the kind of allocation that does not show up until it is on every page of
 * every crawl.
 */
const MARKER_PAIRS: readonly (readonly [InterstitialVendor, string])[] = Object.entries(
  INTERSTITIAL_MARKERS,
).flatMap(([vendor, markers]) =>
  markers.map((marker) => [vendor as InterstitialVendor, marker] as const),
);

/**
 * The vendor half: does this document carry an interstitial's own markup?
 *
 * ON ITS OWN THIS IS NOT A BLOCK, and calling it one is the mistake this whole
 * module exists to avoid. Use {@link interstitialOf} unless you specifically
 * want the vendor question without the "and it holds no page" half.
 */
export function interstitialMarkerOf(html: string): Interstitial | null {
  for (const [vendor, marker] of MARKER_PAIRS) {
    if (html.includes(marker)) return { vendor, marker };
  }
  return null;
}

/** One settled document, as much of it as this decision needs. */
export interface DocumentUnderTest {
  /** The document as the renderer has it: post-script, pre-transform. */
  readonly html: string;
  /** Rendered text length at the instant of the read. */
  readonly textLength: number;
  /**
   * Below how many characters a document is not evidence of a page.
   *
   * Required, and passed rather than defaulted: the caller states the floor
   * its renderer uses. {@link DEFAULT_MIN_TEXT_LENGTH} is the product's one
   * copy of that number.
   */
  readonly textFloor: number;
}

/**
 * WHETHER THIS DOCUMENT IS AN INTERSTITIAL RATHER THAN A PAGE.
 *
 * `null` for every document that holds a page, including one a challenge vendor
 * is watching — which is the overwhelmingly common case for these vendors and
 * is the whole reason `familyOf` refuses to route them.
 *
 * The floor is tested FIRST and it is an integer comparison, so a healthy page
 * pays one branch and never a scan of its own bytes. That ordering is why this
 * can sit on the settle path of every scrape.
 */
export function interstitialOf(document: DocumentUnderTest): Interstitial | null {
  if (document.textLength < document.textFloor) return interstitialMarkerOf(document.html);
  if (document.textLength >= EXCLUSIVE_MARKER_TEXT_CEILING) return null;
  for (const [vendor, ceiling] of EXCLUSIVE_MARKER_CEILINGS) {
    if (document.textLength >= ceiling) continue;
    for (const marker of INTERSTITIAL_MARKERS[vendor]) {
      if (document.html.includes(marker)) return { vendor, marker };
    }
  }
  return null;
}

/**
 * Vendors whose marker exists ONLY on a challenge document, so it is trusted
 * over the text floor, on a small page, and the most rendered text a document
 * may hold and still be tested for that vendor's marker. Cloudflare's
 * interstitial is 280-370 characters (every measured one is under 400; see its
 * row); Anubis's is 379-1,476 (see its row); Shein's js challenge renders its
 * header and footer, 384-1,372 characters measured live (fleet, 2026-10-07,
 * `sess_…`, 18 reads over 17 s). Every other row's marker was measured
 * leaking onto real pages or was never measured above the floor, so they keep
 * it.
 */
const EXCLUSIVE_MARKER_CEILINGS: readonly (readonly [InterstitialVendor, number])[] = [
  ['cloudflare', 1_024],
  ['anubis', 2_048],
  ['shein-js-challenge', 2_048],
];

/**
 * The most rendered text any {@link EXCLUSIVE_MARKER_CEILINGS} vendor is tested
 * at. Over it the answer is `null` from one integer compare, so a healthy page
 * still pays no scan.
 */
export const EXCLUSIVE_MARKER_TEXT_CEILING = Math.max(...EXCLUSIVE_MARKER_CEILINGS.map(([, ceiling]) => ceiling));

/**
 * Below how much text a caller should read a document's bytes at all to ask
 * {@link interstitialOf}: the floor, or the exclusive-marker ceiling when that
 * is higher.
 */
export function interstitialReadCeiling(textFloor: number): number {
  return Math.max(textFloor, EXCLUSIVE_MARKER_TEXT_CEILING);
}

/**
 * Below this many characters of rendered text, a document is not evidence of
 * anything: the score is clamped to zero, and the renderer labels a terminated
 * document carrying a challenge vendor `challenge` rather than done.
 *
 * Straight from the measurement. `stackoverflow.com` at 58 characters and
 * `etsy.com` at 52 were blocks, not pages. DataDome's g2.com interstitial is
 * 1,707 bytes of valid HTML that renders **43** characters; Cloudflare's
 * `precursor_interstitial` on stackoverflow.com is 5,306 bytes rendering
 * **46**. 256 is comfortably above all four and comfortably below any real page
 * in the corpus — an UNCHALLENGED zillow.com terminates at 53,805 characters,
 * which matters because zillow carries a 1x1 PerimeterX sensor frame on every
 * page and the vendor table is presence-only for that vendor. The floor is what
 * keeps that page labelled `network-idle` instead of waiting 15 s for a
 * clearance that was never coming.
 */
export const DEFAULT_MIN_TEXT_LENGTH = 256;
