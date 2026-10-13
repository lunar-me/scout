import { describe, expect, test } from 'bun:test';

import {
  INTERSTITIAL_CONTROLS,
  INTERSTITIAL_MARKERS,
  INTERSTITIAL_SELF_CLEARS,
  interstitialMarkerOf,
  interstitialOf,
} from '../src/interstitial';
import {
  AMAZON_CONTINUE_COM,
  AMAZON_LOADED_HOMEPAGE,
  ANUBIS_LOADED_OPENEDITION,
  ANUBIS_OPENEDITION,
  CAPTURED_INTERSTITIALS,
  CLOUDFLARE_JSD_ON_A_FINE_PAGE,
  CLOUDFLARE_MEDIUM,
  IMPERVA_NORDSTROM,
  KASADA_PREFIX_ON_A_FINE_PAGE,
  PX_SENSOR_ON_A_FINE_PAGE,
  SHEIN_JS_CHALLENGE,
  SHEIN_LOADED_HOMEPAGE,
  SHEIN_ONE_PASS_BOX,
} from './fixtures/interstitials';

/**
 * The floor the callers use. `DEFAULT_MIN_TEXT_LENGTH` in `@outcrawl/render`
 * and `kChallengeTextFloor` in the fork are this same number; it is written out
 * here because a test that imported one of them would stop being a test of the
 * contract and become a test of that constant.
 */
const FLOOR = 256;

describe('a captured interstitial is named as its vendor', () => {
  test.each(CAPTURED_INTERSTITIALS.map((captured) => [captured.url, captured] as const))(
    '%s',
    (_url, captured) => {
      expect(interstitialOf({ html: captured.html, textLength: captured.textLength, textFloor: FLOOR }))
        .toEqual({ vendor: captured.vendor, marker: expect.any(String) });
    },
  );

  test('the marker reported is one of that vendor\u2019s own, and is in the bytes', () => {
    // The `marker` field exists so a log line names the EVIDENCE. A verdict
    // carrying a marker the document does not contain would make every such
    // log line unfalsifiable.
    for (const captured of CAPTURED_INTERSTITIALS) {
      const found = interstitialOf({
        html: captured.html,
        textLength: captured.textLength,
        textFloor: FLOOR,
      });
      // Narrowed, not `found?.marker`. Passing `undefined` through would turn
      // "the detector returned NOTHING for a captured interstitial" into a
      // marker mismatch — the two failures have different causes, and the
      // preceding case is the one that owns the first.
      if (found === null) throw new Error(`no verdict for ${captured.url}`);
      expect(INTERSTITIAL_MARKERS[captured.vendor]).toContain(found.marker);
      expect(captured.html).toContain(found.marker);
    }
  });
});

describe('a detector firing on a page that is fine is not a block', () => {
  test('PerimeterX\u2019s sensor on an unchallenged zillow.com is not an interstitial', () => {
    // THE MEASUREMENT THE `null` FAMILIES ARE ARGUED FROM, now applied to the
    // body rather than to a frame list: this document is 412,838 bytes
    // rendering 3,170 characters and 274 links behind a 200, and it carries
    // `_pxAppId` and a 1x1 `js.px-cloud.net` iframe. Holding a customer's read
    // open for a challenge ceiling on it is the failure this gate must not
    // introduce while fixing the other one.
    const fine = PX_SENSOR_ON_A_FINE_PAGE;
    expect(fine.html).toContain('_pxAppId');
    expect(fine.html).toContain('px-cloud.net');
    expect(interstitialOf({ html: fine.html, textLength: fine.textLength, textFloor: FLOOR })).toBeNull();
  });

  test('and it is not even a marker match, so the floor is not the only thing saving it', () => {
    // The row-exclusion regression. Re-adding `_pxAppId` or `px-cloud.net` to
    // the table would leave this document one thin render away from a 15-second
    // wait, and a listing page that has not painted yet is exactly that.
    expect(interstitialMarkerOf(PX_SENSOR_ON_A_FINE_PAGE.html)).toBeNull();
  });

  test('an interstitial\u2019s own bytes stop being one once the page is there', () => {
    // The other half of the conjunction, and the one that makes a hand-curated
    // marker table safe: even a marker that leaks onto a healthy page cannot
    // fire, because a healthy page renders.
    expect(
      interstitialOf({ html: IMPERVA_NORDSTROM.html, textLength: FLOOR, textFloor: FLOOR }),
    ).toBeNull();
  });

  test('Kasada\u2019s UUID pair on a loaded twitch.tv page is not an interstitial', () => {
    // THE SAME MISTAKE AS `_pxAppId`, ONE LEVEL DEEPER. Kasada's UUID pair is
    // not per customer, so it appears on pages Kasada is only WATCHING: this
    // window comes out of a 309,920-byte twitch.tv document rendering 2,072
    // characters, where the identical prefix serves `p.js`. The marker is the
    // whole path including the `ips.js` leaf precisely so this cannot match.
    const fine = KASADA_PREFIX_ON_A_FINE_PAGE;
    expect(fine.html).toContain('149e9513-01fa-4fb0-aad4-566afd725d1b');
    expect(interstitialMarkerOf(fine.html)).toBeNull();
    expect(interstitialOf({ html: fine.html, textLength: fine.textLength, textFloor: FLOOR })).toBeNull();
  });

  test('a bare function named executeChallenge on a thin page is not an interstitial', () => {
    // THE `_pxAppId` MISTAKE IN ITS THIRD SPELLING, and the reason the facebook
    // row admits ONE literal out of the two its capture offers.
    //
    // `executeChallenge` occurs three times in Meta's 481-byte challenge and
    // zero times on the same URL's 2,238,068-byte loaded page, so it passes
    // this table's stated bar. It is still excluded, because the bar is a
    // NECESSARY condition and not a sufficient one: a bare function name in
    // first-party script is a string any site may declare, and the path prefix
    // already names the document. Admitting it would buy nothing and would put
    // a 15-second challenge ceiling on a thin page whose author happened to
    // pick that name.
    //
    // MUTATION THIS CATCHES: `executeChallenge` added to the facebook row.
    const fine =
      '<html><head><title>Puzzle of the day</title></head><body><script>' +
      'function executeChallenge(){ startTimer(); } executeChallenge();' +
      '</script><p>Loading your puzzle…</p></body></html>';
    expect(fine).toContain('executeChallenge');
    expect(interstitialMarkerOf(fine)).toBeNull();
    expect(interstitialOf({ html: fine, textLength: 21, textFloor: FLOOR })).toBeNull();
  });

  test('the facebook row is named by its path prefix and not by the per-request token', () => {
    // The token in `/__rd_verify_<token>?challenge=3` is per request, so a
    // marker carrying any of it would match exactly one capture and nothing a
    // customer ever hits. The prefix is the stable part, and the leading slash
    // is what keeps it a PATH rather than a variable that happens to be spelled
    // that way.
    //
    // MUTATION THIS CATCHES: the marker widened to the whole captured path.
    const facebook = CAPTURED_INTERSTITIALS.find((captured) => captured.vendor === 'facebook');
    if (facebook === undefined) throw new Error('no facebook row');
    expect(facebook.html).toContain('/__rd_verify_Q_6hBQQ');
    // A DIFFERENT request's token, which is what the next customer gets.
    const rotated = facebook.html.replace(
      '/__rd_verify_Q_6hBQQMLT8LQcMjz-xr5lG4x0ejc0WKfUeJh1MB_in7OwR-ZQ',
      '/__rd_verify_AdIFFERENTtokenENTIRELY_0000000000000000000000',
    );
    expect(rotated).not.toContain('Q_6hBQQ');
    expect(interstitialOf({ html: rotated, textLength: 0, textFloor: FLOOR })).toEqual({
      vendor: 'facebook',
      marker: '/__rd_verify',
    });
  });

  test('Amazon\u2019s own loaded page, with a GET form and a submit button, is not the gate', () => {
    // THE SAME SITE BOTH WAYS: the homepage the gate's own form submitted to.
    // Its header search is a GET form with a submit control, which is the
    // shape a form-and-button marker would have fired on.
    const fine = AMAZON_LOADED_HOMEPAGE;
    expect(fine.html).toContain('type="submit"');
    expect(interstitialMarkerOf(fine.html)).toBeNull();
    expect(interstitialOf({ html: fine.html, textLength: 0, textFloor: FLOOR })).toBeNull();
  });

  test('Amazon\u2019s image captcha is not the one-press gate, though it shares the form', () => {
    // A press does not clear the image captcha, so it must never be named as
    // the row that gets pressed. It posts to the same `validateCaptcha` path
    // with the same "Continue shopping" button; only the heading differs. This
    // variant is BUILT from the captured gate by swapping that heading for the
    // image captcha's own ("Enter the characters you see below"), not captured.
    //
    // MUTATION THIS CATCHES: the marker widened to the form action or the
    // button label.
    const image = AMAZON_CONTINUE_COM.html.replace(
      'Click the button below to continue shopping',
      'Enter the characters you see below',
    );
    expect(image).toContain('validateCaptcha');
    expect(image).toContain('Continue shopping');
    expect(interstitialOf({ html: image, textLength: 0, textFloor: FLOOR })).toBeNull();
  });
});

describe('a Cloudflare managed challenge renders over the floor', () => {
  test('its marker is trusted over the floor on a small page, and not on a large one', () => {
    const rendered = { html: CLOUDFLARE_MEDIUM.html, textFloor: FLOOR };
    expect(interstitialOf({ ...rendered, textLength: 336 })).toEqual({ vendor: 'cloudflare', marker: 'window._cf_chl_opt' });
    expect(interstitialOf({ ...rendered, textLength: 1_500 })).toBeNull();
  });

  test('Cloudflare\u2019s bot-management script on a page it let through is not an interstitial', () => {
    expect(
      interstitialOf({ html: CLOUDFLARE_JSD_ON_A_FINE_PAGE.html, textLength: CLOUDFLARE_JSD_ON_A_FINE_PAGE.textLength, textFloor: FLOOR }),
    ).toBeNull();
    expect(interstitialMarkerOf(CLOUDFLARE_JSD_ON_A_FINE_PAGE.html)).toBeNull();
  });
});

describe('an Anubis proof-of-work gate renders over the floor', () => {
  test('its marker is trusted over the floor, up to the longest gate measured, and not on a larger page', () => {
    // MUTATION THIS CATCHES: `anubis` left out of the exclusive ceilings, or
    // held to Cloudflare's 1,024. The gate renders 379-1,476 characters
    // (openedition, proforto, redlib's Turkish one), all over the floor, and
    // was shipped as the page 80 times in the lab when a quiet rule stopped on it.
    const rendered = { html: ANUBIS_OPENEDITION.html, textFloor: FLOOR };
    const found = { vendor: 'anubis', marker: 'id="anubis_challenge"' } as const;
    expect(interstitialOf({ ...rendered, textLength: ANUBIS_OPENEDITION.textLength })).toEqual(found);
    expect(interstitialOf({ ...rendered, textLength: 1_476 })).toEqual(found);
    expect(interstitialOf({ ...rendered, textLength: 2_048 })).toBeNull();
  });

  test('the page the solved gate leads to carries no marker', () => {
    expect(interstitialMarkerOf(ANUBIS_LOADED_OPENEDITION.html)).toBeNull();
    expect(interstitialOf({ html: ANUBIS_LOADED_OPENEDITION.html, textLength: 600, textFloor: FLOOR })).toBeNull();
  });

  test('Cloudflare keeps its own ceiling', () => {
    expect(interstitialOf({ html: CLOUDFLARE_MEDIUM.html, textLength: 1_476, textFloor: FLOOR })).toBeNull();
  });
});

describe('Shein\u2019s js challenge renders the site\u2019s header and footer over the floor', () => {
  test('it is named from its own url in the page state, at every length it was read at live', () => {
    // MUTATION THIS CATCHES: no row, or a row left out of the exclusive
    // ceilings. The page renders 384-1,372 characters (fleet, 2026-10-07), all
    // over the floor, and the agent was handed it as a page on 8 of 8 serves:
    // the model typed into its header search while the check replaced it.
    const rendered = { html: SHEIN_JS_CHALLENGE.html, textFloor: FLOOR };
    const found = { vendor: 'shein-js-challenge', marker: '/risk/challenge?captcha_type=903' } as const;
    expect(interstitialOf({ ...rendered, textLength: 384 })).toEqual(found);
    expect(interstitialOf({ ...rendered, textLength: 1_372 })).toEqual(found);
    expect(interstitialOf({ ...rendered, textLength: 2_048 })).toBeNull();
  });

  test('the box a person presses, on the same template, is not it, and neither is the front page', () => {
    // MUTATION THIS CATCHES: a marker taken from the shared template (the
    // risk page's script, its `page_risk_crawler_block` name), which would
    // hold every 909 box for the settle's whole budget waiting for a page
    // that only a press brings.
    expect(interstitialMarkerOf(SHEIN_ONE_PASS_BOX.html)).toBeNull();
    expect(interstitialOf({ html: SHEIN_ONE_PASS_BOX.html, textLength: SHEIN_ONE_PASS_BOX.textLength, textFloor: FLOOR })).toBeNull();
    expect(interstitialMarkerOf(SHEIN_LOADED_HOMEPAGE.html)).toBeNull();
    expect(interstitialOf({ html: SHEIN_LOADED_HOMEPAGE.html, textLength: SHEIN_LOADED_HOMEPAGE.textLength, textFloor: FLOOR })).toBeNull();
  });
});

describe('a bare document is not a challenge', () => {
  test('a sitemap holding almost no text and no vendor is not an interstitial', () => {
    // `apple.com/sitemap.xml` renders 114 characters out of 72,718 bytes and
    // settles `parser-finished` legitimately. A floor-only gate would hold a
    // customer's read for a challenge ceiling on every one of them.
    const sitemap = `<?xml version="1.0"?><urlset>${'<url><loc>https://example.com/a</loc></url>'.repeat(400)}</urlset>`;
    expect(interstitialOf({ html: sitemap, textLength: 114, textFloor: FLOOR })).toBeNull();
  });

  test('an empty document is not an interstitial either', () => {
    expect(interstitialOf({ html: '', textLength: 0, textFloor: FLOOR })).toBeNull();
  });
});

describe('the floor belongs to the caller', () => {
  test('there is no default: the same document answers differently per floor', () => {
    // A default here would be a third copy of 256 beside the renderer's and the
    // fork's, and the place a divergence between them would hide.
    const px = CAPTURED_INTERSTITIALS.find((captured) => captured.vendor === 'px');
    expect(px?.textLength).toBe(106);
    const document = { html: px?.html ?? '', textLength: px?.textLength ?? 0 };
    expect(interstitialOf({ ...document, textFloor: FLOOR })).not.toBeNull();
    expect(interstitialOf({ ...document, textFloor: 100 })).toBeNull();
  });
});

describe('waiting is the default and only a measured refusal turns it off', () => {
  test('every vendor waits except Kasada, measured not to relent, and a gate a press clears', () => {
    // THE ASYMMETRY, PINNED. Refusing to wait on a vendor that would have
    // cleared ships the interstitial, which is the whole defect; waiting on one
    // that never relents costs latency on a page that was already blocked. So
    // `true` is what an unmeasured vendor gets, and `kasada` is `false` on the
    // strength of three consecutive 429s in one warm profile. The only other
    // `false` is a gate with a control to press: its document has no script
    // that could ever replace it, so waiting is not how it clears.
    //
    // MUTATION THIS CATCHES: a new vendor added with `false` by copy-paste,
    // which would silently start shipping that vendor's shells.
    const refusing = Object.entries(INTERSTITIAL_SELF_CLEARS)
      .filter(([vendor, clears]) => !clears && !(vendor in INTERSTITIAL_CONTROLS))
      .map(([vendor]) => vendor);
    expect(refusing).toEqual(['kasada']);
  });

  test('a control always on screen is only ever named for a gate that does not clear itself', () => {
    // Pressing something on a page that was about to replace itself is a
    // click nobody needed, on a document the vendor is watching. A control in
    // a frame (`frame` set) is the exception by construction: the vendor shows
    // it only when its own check wants a person, and it is pressed only then.
    for (const [vendor, control] of Object.entries(INTERSTITIAL_CONTROLS)) {
      if (control?.frame !== undefined) continue;
      expect(INTERSTITIAL_SELF_CLEARS[vendor as keyof typeof INTERSTITIAL_SELF_CLEARS]).toBe(false);
    }
  });

  test('the amazon control names exactly the gate\u2019s one button, and nothing on the loaded page', async () => {
    // A selector that matched two elements would leave a caller choosing, and
    // one that matched the loaded page's search submit would press it. Matched
    // with Bun's own HTMLRewriter, a real CSS selector engine over the bytes.
    const control = INTERSTITIAL_CONTROLS['amazon-continue'];
    if (control === undefined) throw new Error('no amazon-continue control');
    const matches = async (html: string): Promise<string[]> => {
      const texts: string[] = [];
      let current = -1;
      await new HTMLRewriter()
        .on(control.selector, {
          element() {
            current = texts.push('') - 1;
          },
          text(chunk) {
            if (current >= 0) texts[current] += chunk.text;
          },
        })
        .transform(new Response(html))
        .text();
      return texts.map((text) => text.trim());
    };
    expect(await matches(AMAZON_CONTINUE_COM.html)).toEqual([control.label]);
    expect(await matches(AMAZON_LOADED_HOMEPAGE.html)).toEqual([]);
  });

  test('every vendor with markers has a clearance verdict', () => {
    // A vendor in one table and not the other is a gate that either cannot
    // decide whether to wait or waits for something it cannot name.
    expect(Object.keys(INTERSTITIAL_SELF_CLEARS).sort()).toEqual(
      Object.keys(INTERSTITIAL_MARKERS).sort(),
    );
  });
});
