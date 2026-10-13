/**
 * REAL CAPTURED VENDOR INTERSTITIALS, and the sensor that is not one.
 *
 * Every byte here came off the wire on 2026-09-10, except the facebook row
 * which came off it on 2026-09-12, the amazon rows on 2026-09-25 and the shein
 * rows on 2026-10-06 (bodies a production session stored, read back through
 * the sessions API), and all of
 * it is reproduced verbatim except where `elided` or the row's own comment says
 * otherwise. The capture paths, all stated per fixture
 * because they answer different halves of the question:
 *
 *   - `curl` with a curl user agent, which is how a vendor's block page is
 *     obtained on demand: leboncoin 403, g2 403, zillow 403.
 *   - the built fork (`Chrome/152.0.7977.64`) under launchd on CDP 9944-9947,
 *     dumped at the first sample holding no text, which is how the interstitial
 *     a REAL scrape sees is obtained: nordstrom 200, binance 202.
 *   - `curl -4` with a real Chrome user agent and no cookies, which is what it
 *     takes to be served a FIRST-PARTY challenge rather than a vendor's:
 *     facebook 403.
 *   - `curl` with a Chrome user agent through a residential mobile exit with a cookie
 *     jar, replaying Akamai's `bm-verify` hop the way the page's own script
 *     does, which is what it takes to be shown Amazon's one-press gate:
 *     amazon.com 200.
 *   - a production agent session's stored response bodies, which is how the
 *     page our browser was actually served is obtained without running one
 *     here: Shein's risk pages and front page, 200.
 *
 * `textLength` and `nodes` are not estimates, EXCEPT on the amazon rows. The
 * shein rows' `textLength` was read live on the fleet and their `nodes` is 0
 * (not measured). Each
 * other fixture was served back to the same fork over loopback and measured
 * with `document.body.innerText.length` and `getElementsByTagName('*').length`;
 * the amazon rows were captured after browsers stopped being run outside the
 * fleet, so theirs are computed from the bytes and say so.
 *
 * WHY THE FIXTURES ARE HERE AND NOT IN A DIRECTORY OF `.html` FILES: the bar
 * for a row in `INTERSTITIAL_MARKERS` is "present on the interstitial, absent
 * from that same site's loaded page", and the test that enforces it has to hold
 * both halves at once. A fixture module makes the pair one import.
 */

import type { InterstitialVendor } from '../../src/interstitial';

/** One captured document, with what it renders. */
export interface CapturedDocument {
  /** How it was obtained, so a re-capture reproduces it. */
  readonly provenance: string;
  readonly url: string;
  readonly status: number;
  /** `content-length` as served, before any trim below. */
  readonly servedBytes: number;
  /** Rendered text length, measured by serving this fixture back to the fork. */
  readonly textLength: number;
  /** `getElementsByTagName('*').length`, measured the same way. */
  readonly nodes: number;
  /** True when a middle section was cut. The markers are never in the cut. */
  readonly elided: boolean;
  readonly html: string;
}

/** A captured interstitial, and the vendor the table must name it as. */
export interface CapturedInterstitial extends CapturedDocument {
  readonly vendor: InterstitialVendor;
}

/**
 * The interstitial is 252,998 bytes of one obfuscated script and 53 tags. The elision is that script's middle; `istlWasHere` is its first statement and the XHR that clears the challenge is its last block, so both ends of the mechanism survive the trim.
 */
export const IMPERVA_NORDSTROM: CapturedInterstitial = {
  vendor: "imperva",
  provenance: "fork on CDP 9944, Runtime.evaluate of document.documentElement.outerHTML at t+581 ms, the first sample holding no text; the settle was parser-finished textLength=0 at t+622 ms",
  url: "https://www.nordstrom.com/",
  status: 200,
  servedBytes: 252998,
  textLength: 0,
  nodes: 6,
  elided: true,
  html: "<html><head>\n  <title></title>\n  <style>\n    html, body {\n      margin: 0;\n      padding: 0;\n      background-color: white;\n    }\n  </style>\n</head>\n<body>\n    <script>window['istlWasHere'] = true; (function(Z,u,t,U){var OF={},Oh={};var Oi=ReferenceError,OA=TypeError,OL=Object,OQ=RegExp,OE=Number,Ob=String,OP=Array,Ol=OL.bind,OO=OL.call,OX=OO.bind(Ol,OO),q=OL.apply,OD=OX(q),d=[].push,z=[].pop,N=[].slice,h=[].splice,a=[].join,s=[].map,y=OX(d),R=OX(N),v=OX(a),H=OX(s),k={}.hasOwnProperty,o=OX(k),X=JSON.stringify,V=OL.getOwnPropertyDescriptor,Ow=OL.defineProperty,OU=Ob.fromCharCode,I=Math.min,Og=Math.floor,OT=OL.create,m=\"\".indexOf,F=\"\".charAt,j=OX(m),OY=OX(F),Ox=typeof Uint8Array===\"function\"?Uint8Array:OP;var r=[\"NKFwOYxQ8Bk\",\"yZ9FZrxImzvjVYM\",\"G0GMz2fyJPAmkGitCqD0rbdNsg\",\"OPR\",\"L8IGQ+YExQmMTfhz\",\"FZ9ndoBDn0ze\",\"NqdbFaUZmHS7OP0SqF9YF14\",\"reY4eNsup0w\",\"pFely039TIEshG8\",\"8UeOtEKJUN0zuFzoeQ\",\"U+EISPxP9GXmdok\",\"rhf1uhO4JpcIhA\",\"MNIJBOkq+znBDuY\",\"ckqisxbiFuMg6w\",\"rTHPgiusH4wNlmqG\",\"xpxURqFE0G\n<!-- 251,498 bytes of the same obfuscated script elided; see `elided` -->\nieZlflFtnjOiP9CMiYfz736FAY8631Wucpw7wH9eCOfvosJeCA==\",\"VAt4MYeH_EKWlZsj71bX5RzyhD6uQmL2vPgfToUIik80pGwcdnBFa-x9OqCN=J3Sr\",[],[2018005968,100721521,865026350,151228740,797554822,1073569672,1098459910,100219578],document.currentScript&&document.currentScript.nonce||\"Ks073ackNn4OPZsE8oTJw/ds\",document.currentScript&&document.currentScript.nonce||\"Ks073ackNn4OPZsE8oTJw/ds\",[],typeof arguments===\"undefined\"?void 0:arguments,(document.currentScript||{})&&(document.currentScript||{}).src||null]))</script>\n  </body></html>",
};

/**
 * Response carried `x-datadome: protected` and set a `datadome` cookie. The visible `<p id='cmsg'>` is animated from opacity 0 and its script host is unreachable from loopback, which is why the measured text is 0 rather than the 43 characters the live page shows.
 */
export const DATADOME_LEBONCOIN: CapturedInterstitial = {
  vendor: "datadome",
  provenance: "curl -A 'curl/8.7.1' https://www.leboncoin.fr/, 403, verbatim and whole",
  url: "https://www.leboncoin.fr/",
  status: 403,
  servedBytes: 771,
  textLength: 0,
  nodes: 9,
  elided: false,
  html: "<html lang=\"en\"><head><title>leboncoin.fr</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style=\"margin:0\"><p id=\"cmsg\">Please enable JS and disable any ad blocker</p><script data-cfasync=\"false\">var dd={'rt':'c','cid':'AHrlqAAAAAMAkKOsBSYpSXYAjzrfVQ==','hsh':'05B30BD9055986BD2EE8F5A199D973','t':'bv','qp':'','s':2089,'e':'3d7f2d840228b343b3c3915987c428907e70231f16f11951cab03aef57614e13ebec99dabddc2785e19485761fddeacd','host':'geo.captcha-delivery.com','cookie':'TqZMHx5~r9HP1innThu3bxNTeUnWwPSN373UAunjjJnwP2taRGEp6Me14SGZd1kbIkrmfVIeCHexCvxQQtXg9HD1lGdhW0ZdDUYuN5RbJ95bMbcMAOaos8S2OSlfkgHp'}</script><script data-cfasync=\"false\" src=\"https://ct.captcha-delivery.com/c.js\"></script></body></html>",
};

/**
 * A second site for the same vendor, because one site cannot show that a marker is the VENDOR's and not that site's.
 */
export const DATADOME_G2: CapturedInterstitial = {
  vendor: "datadome",
  provenance: "curl https://www.g2.com/products/notion/reviews, 403, verbatim and whole",
  url: "https://www.g2.com/products/notion/reviews",
  status: 403,
  servedBytes: 1704,
  textLength: 0,
  nodes: 11,
  elided: false,
  html: "<html lang=\"en\"><head><title>g2.com</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style=\"margin:0\"><p id=\"cmsg\">Please enable JS and disable any ad blocker</p><script data-cfasync=\"false\">var dd={'rt':'c','cid':'AHrlqAAAAAMA9TQM4vc_D14A9yIjyw==','hsh':'229542D5C186C7F5A5BB092FBDD92B','t':'bv','qp':'','s':48636,'e':'ee096530acc01e9c715092062542ffd5320bb593633fa2b36c7c45d431c0ed7aa1a1a4ab039798379ebb0417acb460b8','host':'geo.captcha-delivery.com','cookie':'t4XDh8tF8Auka2jG6GmXNTweQSMNOuL6uCMdk7nStQXRgl1ZNPU9HzKIFblmt6zsEPfjc11JWw2dxIeBR5X_hPNZxjkbMEDT_cChmEus1yWu_yiEwNmVMJxNbzb1OyAj'}</script><script data-cfasync=\"false\" src=\"https://ct.captcha-delivery.com/c.js\"></script><script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.innerHTML=\"window.__CF$cv$params={r:'a38c69809d2cb399',t:'MTc4OTAyMjEyMQ=='};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);\";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script></body></html>",
};

/**
 * THE ONE THAT RENDERS SOMETHING: 106 characters of "Press & Hold to confirm you are a human", well under the 256 floor. The elision is a base64 error-badge PNG and its stylesheet; all three markers are in the head that survives.
 */
export const PX_ZILLOW: CapturedInterstitial = {
  vendor: "px",
  provenance: "curl https://www.zillow.com/, 403 with `x-px-blocked: 1`",
  url: "https://www.zillow.com/",
  status: 403,
  servedBytes: 5776,
  textLength: 106,
  nodes: 24,
  elided: true,
  html: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <meta name=\"description\" content=\"px-captcha\">\n    <title>Access to this page has been denied</title>\n    \n</head>\n<body>\n    <script>\n        /* PerimeterX assignments */\n        window._pxVid = '';\n        window._pxUuid = 'db240558-ace0-11f1-9eec-bbd4d4924ddb';\n        window._pxAppId = 'PXHYx10rg3';\n        window._pxHostUrl = '/HYx10rg3/xhr';\n        window._pxCustomLogo = 'https://www.zillowstatic.com/s3/pfs/static/z-logo-default.svg';\n        window._pxJsClientSrc = '/HYx10rg3/init.js';\n        window._pxMobile = false;\n        window._pxFirstPartyEnabled = true;\n\n        var pxCaptchaSrc = '/HYx10rg3/captcha/captcha.js?a=c&u=db240558-ace0-11f1-9eec-bbd4d4924ddb&v=&m=0&b=aHR0cHM6Ly93d3cuemlsbG93LmNvbS8=&h=R0VU';\n        var script = document.createElement('script');\n        script.src = pxCaptchaSrc;\n        script.onload = onScriptLoad;\n        script.onerror = onScriptError;\n        var onScriptErrorCalled;\n        document.head.appendChild(script);\n        var timeoutID = setTimeout(onScriptError, 5000);\n        function onScriptLoad() {\n            clearTimeout(timeoutID);\n            setTimeout(function() {\n                if (!isContentLoaded()) {\n                    onScriptError();\n                }\n            }, 2500);\n        }\n        function onScriptError() {\n            if (onScriptErrorCalled) {\n                \n<!-- 4,276 bytes elided: the base64 error-badge PNG and its stylesheet -->\n</script></body></html>",
};

/**
 * The fork DOES label this one: `documentSettled reason=challenge textLength=0` at t+1,206 ms, because `token.awswaf.com/.../challenge.js` is a vendor URL its table knows. It cleared itself with a real second commit at t+1,330 ms.
 */
export const AWSWAF_BINANCE: CapturedInterstitial = {
  vendor: "awswaf",
  provenance: "fork on CDP 9947, dumped at t+252 ms; the response was 202 with `x-amzn-waf-action: challenge`",
  url: "https://accounts.binance.com/en/register",
  status: 202,
  servedBytes: 1301,
  textLength: 0,
  nodes: 9,
  elided: false,
  html: "<html lang=\"en\"><head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <title></title>\n    <style>\n        body {\n            font-family: \"Arial\";\n        }\n    </style>\n    <script type=\"text/javascript\">\n    window.awsWafCookieDomainList = ['binance.com','binance.bh','binance.info','binance.me','binance.click'];\n    window.gokuProps = {\n\"key\":\"AQIDAHjcYu/GjX+QlghicBgQ/7bFaQZ+m5FKCMDnO+vTbNg96AEPM1ztUEerBZt4CZN2qxciAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMar9uPkfjbHRb92e3AgEQgDsLRU95DKkb+45sKqB5Z7fTgHuP+ylSydN69wrcCOT+NZEH4UyRfE+OwXUnZBHvQMnKmaAVOkn5YjH10A==\",\n          \"iv\":\"A6wBMAG4OAAAAFhK\",\n          \"context\":\"eDQh8pznzQVmPOJnDqWFEzklIzNqpIsQVM5RYEBFUWK/QivoLREThUYarRGVBLIK4UbTkl3JJGdFCA8ES4vkuwkT3iWjkzEdz9RZrQuOgTwhha9I606LP9wNUr/WAT8+ZPrGABnxSM1fPGxERirfF+Aw12J/jA+DPJdS3lxUPFAeqEHBvmep2RerJTFwuPDjyav/RfaA+8rykAB5elp4LpD1U02sakc4EipcohzSZUB/lirrIDCk3p7ZVvKX3us0Uus3mK6Jld3EA/KowqBRqtT1uHQXSzvWXp+oB1jjE+tMeuadqASG4HZ445E9hEc+QFIF3cdr9/Z29SSaP76Ht6BPh5DuuE3ej0uZu26EXohZPpQffOUB2iRhBy8VrJ7KMwtxfYIa2OpqfR3AzD6NTDvff+VMaqLzkA==\"\n};\n    </script>\n    <script src=\"https://fe4385362baa.ead381d8.eu-west-1.token.awswaf.com/fe4385362baa/53e033075707/a68049276785/challenge.js\"></script></head></html>",
};


/**
 * Akamai's `sec-cpt` countdown, whole and verbatim.
 *
 * THE CLEANEST NEGATIVE CONTROL IN THIS FILE, and it is same-site: the very
 * same URL loaded through the fork came back as 1,663,445 bytes rendering
 * 36,410 characters and 648 links, carrying none of the five markers. So the
 * absence is measured against the page this interstitial stands in front of,
 * rather than against a different host.
 *
 * It clears itself by mechanism rather than by clock: `cp_clge_done()` is
 * declared in the head and calls `location.reload(true)`, and the base64
 * `challenge=` on its `<iframe id="sec-cpt-if">` declares
 * `{"difficulty":500,"timeout":1000,"powduration":1}`.
 */
export const AKAMAI_WALGREENS: CapturedInterstitial = {
  vendor: 'akamai',
  provenance: "curl -A 'curl/8.7.1' 'https://www.walgreens.com/search/results.jsp?Ntt=vitamin', 200, verbatim and whole",
  url: 'https://www.walgreens.com/search/results.jsp?Ntt=vitamin',
  status: 200,
  servedBytes: 1891,
  textLength: 0,
  nodes: 17,
  elided: false,
  html: "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, shrink-to-fit=no\"><title>Challenge Validation</title><link rel=\"stylesheet\" type=\"text/css\" href=\"/ShpajsWPcR/gw8n8w/nchn/V0Yt/OQd7XxMRMgs/fT1jMQkB/ExdZ\"><script type=\"text/javascript\">function cp_clge_done(){location.reload(true);}</script><script src=\"/ShpajsWPcR/gw8n8w/nchn/V0Yt/OQd7XxMRMgs/Q3t5WHAW/Fjgu\" async defer></script><script type=\"text/javascript\">sessionStorage.setItem('data-duration', 1);</script></head><body><div class=\"sec-container\"><div id=\"sec-text-container\"><iframe title=\"Challenge Message\" id=\"sec-text-if\" class=\"custmsg crypto\" src=\"/ShpajsWPcR/gw8n8w/nchn/V0Yt/OQd7XxMRMgs/ByMoAmhk/bCsBAQ\"></iframe></div><div id=\"sec-if-container\"><iframe title=\"Challenge Content\" id=\"sec-cpt-if\" provider=\"crypto\" class=\"crypto\" challenge=\"eyJ0b2tlbiI6IkFBUUFBQUFOX19fX181NWUzalBCYURWcW1MdnZtWnFWSUczZDkyamxaRXQtYnNUYjBEckk2cGdGTEIwT3ZBNnIxN2t5TS1SV3lUaGVtckFZazNxM2lKSFQzWHloM3A0Mm51Y1JteUVCdzRLMEZKVDROczRMajZYOEpLd3Q2aWRZSmpKV3lCUzRydEtxZ2NvNGpsUHVzWWNsMFBVQ1RNdEVRZ3ZVVGFNMkY5dWhKYmNVUjJsNWxJekVENHU1enZCbkc5VjdjU0tlc1ZhcnktdzQwaDhGcmVlMjU5ZTJrb2llQlNEU3dKenkxX1NnaXdZN1RaNXYtWWV6YTV1UUZyWVN1ekQtTDJBazUwY19LRUthS3gyaTB2Qnh4VHV6UHBxUU9pN3VqNHYzQWRoN3lRSnRFa2pwRU54bWdvLXVyVmk3QzFnb2RhRmdjYmhMUVpjX2pxbGhTRHNjcmhkc0FlYk0iLCJ0aW1lc3RhbXAiOjE3ODkwMjMwNjYsIm5vbmNlIjoiYmY0YmM0NmIwNmI5YjA4NmIwNDkiLCJkaWZmaWN1bHR5Ijo1MDAsImNvdW50IjoxLCJ0aW1lb3V0IjoxMDAwLCJjcHUiOmZhbHNlLCJ2ZXJpZnlfdXJsIjoiaHR0cHM6Ly93d3cud2FsZ3JlZW5zLmNvbS9TaHBhanNXUGNSL2d3OG44dy9uY2huL1YwWXR6bWtFMWYvT1FkN1h4TVJNZ3MvY2trNVRBdzIvU3dvIn0=\"  data-key=\"\" data-duration=1 src=\"/ShpajsWPcR/gw8n8w/nchn/V0Yt/OQd7XxMRMgs/alpHdj1F/d359\"></iframe></div></div><div><input type=\"hidden\" name=\"verify-url\" value=\"ShpajsWPcR/gw8n8w/nchn/V0YtzmkE1f/OQd7XxMRMgs/ckk5TAw2/Swo\"></div></body></html>",
};

/**
 * Kasada's, whole and verbatim: two script tags and nothing else.
 *
 * THE ONLY VENDOR IN THIS FILE MEASURED NOT TO CLEAR ITSELF. Three consecutive
 * loads in one warm fork profile answered 429 each time with a fresh
 * `x-kpsdk-ct`, which is why `INTERSTITIAL_SELF_CLEARS.kasada` is `false`.
 */
export const KASADA_CANADAGOOSE: CapturedInterstitial = {
  vendor: 'kasada',
  provenance: "curl -A 'curl/8.7.1' https://www.canadagoose.com/us/en/home-page, 429, verbatim and whole",
  url: 'https://www.canadagoose.com/us/en/home-page',
  status: 429,
  servedBytes: 698,
  textLength: 0,
  nodes: 5,
  elided: false,
  html: "<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.now=typeof performance!=='undefined'&&performance.now?performance.now.bind(performance):Date.now.bind(Date);KPSDK.start=KPSDK.now();</script><script src=\"/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js?akm_bmfp_b2=0bKpLlCJRUc50LsHwfQGVLwr1BtT70x9KqThnXpS6umdUJyYPOHYTR4HInos3d56hxTcRw3aCRinuPPXqNlBeYdDPL0j2slJDbJ0afNCSX9c1iSZoes4znMtbhwtSgGjPsnKrC21LWBteqc8EUh4jDGJJ8e7bVSDm3F1XislDBj&amp;x-kpsdk-im=AAJQ-KhgkCwVO86Slgwr6sZ9PAlXLdemmZnd_lSonfsiC5GaH46zJZvQ1BZxIVKMaVh1vcGH5V63oa4Jzeh6V7Lwfs3B7aKg0BmqS2auETxr-bfwRisyj4FYP5ujmTUdlaZ7ghxJYiPQpy_WYYEA-OK_RUqHQo7tOxhPKA-p\"></script></body></html>",
};

/**
 * META'S OWN CHALLENGE, AND THE FIRST ROW IN THIS FILE WHOSE ISSUER IS NOT A
 * THIRD-PARTY VENDOR.
 *
 * Whole and verbatim at 481 bytes -- there is nothing to elide. The body is one
 * IIFE that POSTs to `/__rd_verify_<per-request-token>?challenge=3` and calls
 * `window.location.reload()` in the `.finally`, so BOTH halves of the row are
 * legible in the bytes: what names it, and why waiting works.
 *
 * The token in the path is per request, which is why the marker stops at
 * `/__rd_verify`. `executeChallenge` occurs three times here and zero times on
 * the loaded page and is still not a marker -- see the row in
 * `INTERSTITIAL_MARKERS` for why a bare function name in first-party script is
 * the `_pxAppId` mistake wearing different clothes.
 *
 * The negative control is the same URL the same day through `POST /v1/scrape`:
 * 2,238,068 bytes, 9,456 elements, 30,240 rendered characters, 88 anchors, and
 * both candidate literals at ZERO. Not stored here -- two megabytes to prove an
 * ABSENCE is the one thing a fixture cannot do better than a number -- but
 * counted on disk, as the akamai and nordstrom controls were.
 */
export const FACEBOOK_ADLIBRARY: CapturedInterstitial = {
  vendor: 'facebook',
  provenance:
    'curl -4, no cookies, Chrome 131 macOS UA, 2026-09-12 19:05:10 UTC; HTTP/2 403, content-length 481, x-fb-rd: 1, proxy-status: http_request_denied. Re-verified on disk at 481 bytes, sha256 d14287769a5f9169, with /__rd_verify occurring once and executeChallenge three times',
  url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=shopify&search_type=keyword_unordered',
  status: 403,
  servedBytes: 481,
  textLength: 0,
  nodes: 5,
  elided: false,
  html: "<!DOCTYPE html>\n<html>\n<head>\n<title>Ad Library</title>\n</head>\n<body>\n<script>\n\n(function() {\n  if (document.readyState !== 'loading') {\n    executeChallenge();\n  } else {\n    document.addEventListener('DOMContentLoaded', executeChallenge);\n  }\n  function executeChallenge() {\n    fetch('/__rd_verify_Q_6hBQQMLT8LQcMjz-xr5lG4x0ejc0WKfUeJh1MB_in7OwR-ZQ?challenge=3', {\n      method: 'POST',\n    })\n    .finally(() => window.location.reload());\n  }\n})();\n\n</script>\n</body>\n</html>\n",
};

/**
 * THE SECOND NEGATIVE CONTROL, AND IT IS WHY THE KASADA MARKER IS THE WHOLE
 * PATH RATHER THAN THE UUID PAIR.
 *
 * A verbatim window out of the 309,920-byte `www.twitch.tv` document the fork
 * loaded on CDP 9946, which rendered 2,072 characters and 95 links behind a
 * 200. Kasada's UUID pair is not per customer: this page carries the identical
 * prefix and serves `p.js` from it. It does NOT serve `ips.js`, and that leaf
 * is the whole discriminating power of the marker.
 */
export const KASADA_PREFIX_ON_A_FINE_PAGE: CapturedDocument = {
  provenance: 'fork on CDP 9946, the window around Kasada\u2019s UUID pair in the fully loaded document',
  url: 'https://www.twitch.tv/',
  status: 200,
  servedBytes: 309920,
  textLength: 2072,
  nodes: 0,
  elided: true,
  html: "61f33438b8350f39f.js\" crossorigin=\"anonymous\"></script><script src=\"https://assets.twitch.tv/assets/core-fb4fc40310d97a827bdc.js\" crossorigin=\"anonymous\"></script><script src=\"https://k.twitchcdn.net/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/p.js\"></script><script>performance.mark(\"html:end\")</script><script id=\"pc-chromecast-sender\" async=\"\" src=\"https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1\"></",
};

/**
 * AMAZON'S ONE-PRESS GATE, "Click the button below to continue shopping".
 *
 * `curl` with a Chrome user agent through a residential mobile exit (US, session-bound
 * node), 2026-09-25 17:24:56Z: the first response was Akamai's `bm-verify`
 * interstitial, whose own `/_sec/verify` POST was replayed with the page's own
 * `pow`, and the re-GET of `/` answered this. Verbatim except that the form's
 * two per-request values (`amzn`, `field-keywords`) are replaced with
 * `REDACTED` placeholders; a second capture at 17:28:52Z differed from this
 * one in exactly those two values.
 *
 * `textLength` is COMPUTED, not measured in a browser (no browser may run
 * outside the fleet): the body's text with comments and tags removed and
 * whitespace collapsed is 142 characters, which is the most `innerText` can be
 * here since the page has no hidden text. `nodes` is the count of start tags.
 */
export const AMAZON_CONTINUE_COM: CapturedInterstitial = {
  vendor: 'amazon-continue',
  provenance:
    'curl, Chrome UA, residential mobile US exit, 2026-09-25 17:24:56Z, after replaying the Akamai bm-verify hop; per-request form values redacted',
  url: 'https://www.amazon.com/',
  status: 200,
  servedBytes: 1333,
  textLength: 142,
  nodes: 39,
  elided: false,
  html: "<!DOCTYPE html>\n<!--[if lt IE 7]> <html lang=\"en-us\" class=\"a-no-js a-lt-ie9 a-lt-ie8 a-lt-ie7\"> <![endif]-->\n<!--[if IE 7]>    <html lang=\"en-us\" class=\"a-no-js a-lt-ie9 a-lt-ie8\"> <![endif]-->\n<!--[if IE 8]>    <html lang=\"en-us\" class=\"a-no-js a-lt-ie9\"> <![endif]-->\n<!--[if gt IE 8]><!-->\n<html class=\"a-no-js\" lang=\"en-us\"><!--<![endif]--><head>\n<meta http-equiv=\"content-type\" content=\"text/html; charset=UTF-8\">\n<meta charset=\"utf-8\">\n<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge,chrome=1\">\n<title dir=\"ltr\">Amazon.com</title>\n<meta name=\"viewport\" content=\"width=device-width\">\n<link rel=\"stylesheet\" href=\"https://images-na.ssl-images-amazon.com/images/G/01/AUIClients/AmazonUI-3c913031596ca78a3768f4e934b1cc02ce238101.secure.min._V1_.css\">\n</head>\n<body>\n\n<!--\n        To discuss automated access to Amazon data please contact api-services-support@amazon.com.\n        For information about migrating to our APIs refer to our Marketplace APIs at https://developer.amazonservices.com/ref=rm_c_sv, or our Product Advertising API at https://affiliate-program.amazon.com/gp/advertising/api/detail/main.html/ref=rm_c_ac for advertising use cases.\n-->\n\n<!--\nCorreios.DoNotSend\n-->\n\n<div class=\"a-container a-padding-double-large\" style=\"min-width:350px;padding:44px 0 !important\">\n\n    <div class=\"a-row a-spacing-double-large\" style=\"width: 350px; margin: 0 auto\">\n\n        <div class=\"a-row a-spacing-medium a-text-center\"><i class=\"a-icon a-logo\" alt=\"Amazon logo\"></i></div>\n\n        <div class=\"a-box a-alert a-alert-info a-spacing-base\">\n            <div class=\"a-box-inner\">\n                <i class=\"a-icon a-icon-alert\" alt=\"Alert icon\"></i>\n                <h4>Click the button below to continue shopping</h4>\n                </div>\n            </div>\n\n            <div class=\"a-section\">\n\n                <div class=\"a-box a-color-offset-background\">\n                    <div class=\"a-box-inner a-padding-extra-large\">\n\n                        <form method=\"get\" action=\"/errors_page/validateCaptcha\" name=\"\">\n                            <input type=\"hidden\" name=\"amzn\" value=\"REDACTED-PER-REQUEST-TOKEN\" /><input type=\"hidden\" name=\"amzn-r\" value=\"&#047;\" />\n                            <input type=\"hidden\" name=\"field-keywords\" value=\"REDACTED\" />\n                            <div class=\"a-section a-spacing-extra-large\">\n\n                                <div class=\"a-row\">\n                                    <span class=\"a-button a-button-primary a-span12\">\n                                        <span class=\"a-button-inner\">\n                                            <button type=\"submit\" class=\"a-button-text\" alt=\"Continue shopping\">Continue shopping</button>\n                                        </span>\n                                    </span>\n                                </div>\n\n                            </div>\n                        </form>\n\n                    </div>\n                </div>\n\n            </div>\n\n        </div>\n\n        <div class=\"a-divider a-divider-section\"><div class=\"a-divider-inner\"></div></div>\n\n        <div class=\"a-text-center a-spacing-small a-size-mini\">\n            <a href=\"https://www.amazon.com/gp/help/customer/display.html/ref=footer_cou?ie=UTF8&nodeId=508088\">Conditions of Use</a>\n            <span class=\"a-letter-space\"></span>\n            <span class=\"a-letter-space\"></span>\n            <span class=\"a-letter-space\"></span>\n            <span class=\"a-letter-space\"></span>\n            <a href=\"https://www.amazon.com/gp/help/customer/display.html/ref=footer_privacy?ie=UTF8&nodeId=468496\">Privacy Policy</a>\n        </div>\n        <div class=\"a-text-center a-size-mini a-color-base\">\n          &copy; 1996-2025, Amazon.com, Inc. or its affiliates\n        </div>\n    </div>\n</body></html>\n\n",
};

/**
 * Cloudflare's managed challenge, `medium.com`, 403, 5,636 bytes, fetched
 * 2026-09-26 by `curl` with a Chrome user agent. The head, the body up to the
 * inline script, and the first 700 characters of the `window._cf_chl_opt`
 * assignment, verbatim; the rest of that script is elided. `textLength` is the
 * text of the bytes with no script run (58: "Just a moment... Enable
 * JavaScript and cookies to continue"); a browser that runs the page renders
 * 280-370 (336 on dictionary.cambridge.org, production step settle, n=1),
 * which is the case the exclusive-marker ceiling exists for.
 */
export const CLOUDFLARE_MEDIUM: CapturedInterstitial = {
  provenance: 'curl, Chrome user agent, 2026-09-26; text computed from the bytes, not rendered',
  url: 'https://medium.com/',
  status: 403,
  servedBytes: 5_636,
  textLength: 58,
  nodes: 0,
  elided: true,
  vendor: 'cloudflare',
  html: "<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title></head><body><div class=\"main-wrapper\" role=\"main\"><div class=\"main-content\"><noscript><div class=\"h2\"><span id=\"challenge-error-text\">Enable JavaScript and cookies to continue</span></div></noscript></div></div><script nonce=\"zoLDcKkO2JC8Vo2KsfMS29\">(function(){window._cf_chl_opt = {cFPWv: 'b',cH: 'exlUx3zgOSBRdLWTAnPQ6K1_583SqC9fyiuX66lZwVg-1790380374-1.2.1.1-PlcQL21gvz6_d3_KPV19fYQAqEzg8MpBH5iaLi5Lid_P15GhDSmEuKIHB1ujjyGV',cITimeS: '1790380374',cN: 'zoLDcKkO2JC8Vo2KsfMS29',cRay: 'a40df1fedb15d200',cTplB: '0',cTplC:0,cTplO:0,cTplV:5,cType: 'managed',cUPMDTk:\"/?__cf_chl_tk=841LDV2MH4UhqK.10m25.7bHb8jDbtM_6_6OebMohK0-1790380374-1.0.1.1-Ww7dg5u7Bw8NVGx.DESN0RQBvL7h39Ma02q4r4H5Qd8\",cvId: '3',cZone: 'medium.com',fa:\"/?__cf_chl_f_tk=841LDV2MH4UhqK.10m25.7bHb8jDbtM_6_6OebMohK0-1790380374-1.0.1.1-Ww7dg5u7Bw8NVGx.DESN0RQBvL7h39Ma02q4r4H5Qd8\",md: 'YhzF3kSHdxVlAM5cFo5aVGHfHYESNKDQy1um6uaCBnA-1790380374-1.2.1\u2026</script></body></html>",
};

/**
 * The negative control: Cloudflare's bot-management script on a page it let
 * through. `discord.com`, 200, 170,075 bytes, fetched 2026-09-26 the same way;
 * this is its one `__CF$cv$params` script, verbatim. It loads
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` and carries no
 * `_cf_chl_opt`, which is why neither that path nor that global is a marker.
 */
export const CLOUDFLARE_JSD_ON_A_FINE_PAGE: CapturedDocument = {
  provenance: 'curl, Chrome user agent, 2026-09-26; one script window out of the loaded page',
  url: 'https://discord.com/',
  status: 200,
  servedBytes: 170_075,
  textLength: 400,
  nodes: 0,
  elided: true,
  html: "<script nonce=\"MjgsODAsMjM3LDU5LDE4NiwxNjYsMTIxLDQw\">(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.nonce='MjgsODAsMjM3LDU5LDE4NiwxNjYsMTIxLDQw';d.innerHTML=\"window.__CF$cv$params={r:'a40df2b3dbf24f47',t:'MTc5MDM4MDQwMw=='};var a=document.createElement('script');a.nonce='MjgsODAsMjM3LDU5LDE4NiwxNjYsMTIxLDQw';a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);\";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script>",
};

/**
 * Anubis's proof-of-work gate, verbatim and whole. The challenge's
 * `X-Real-Ip` (the capturing laptop's address) is replaced by 192.0.2.1, the
 * documentation range; nothing else is changed. `textLength` is computed from
 * the bytes (scripts and styles removed, whitespace collapsed), not measured in
 * a browser: none may be launched outside the fleet.
 */
export const ANUBIS_OPENEDITION: CapturedInterstitial = {
  vendor: 'anubis',
  provenance: "curl -A '<Chrome 140 macOS user agent>' -H 'Accept: text/html', 2026-09-29 20:45:43Z, 200, verbatim and whole",
  url: 'https://books.openedition.org/pur/12467?lang=en',
  status: 200,
  servedBytes: 5302,
  textLength: 492,
  nodes: 0,
  elided: false,
  html: "<!DOCTYPE html>\n<html lang=\"en\">\n\t<head>\n\t\t<script id=\"anubis_version\" type=\"application/json\">\"v1.26.2\"\n</script><script id=\"anubis_challenge\" type=\"application/json\">{\"rules\":{\"algorithm\":\"fast\",\"difficulty\":2},\"challenge\":{\"issuedAt\":\"2026-09-29T22:45:42.957442106+02:00\",\"metadata\":{\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36\",\"X-Real-Ip\":\"192.0.2.1\"},\"id\":\"01a0eeea-88ad-769f-ba00-c080d126ab0b\",\"method\":\"fast\",\"randomData\":\"7e263eb4903526d6ed6a95d931a5ee6fa7c6a79c34b37f0e207786f1b452bfa515474241b559748f237349db6876148dc4fc0c254a09f14946f4b9be4319e560\",\"policyRuleHash\":\"ac980f49c4d35fab\",\"difficulty\":2,\"spent\":false}}\n</script><script id=\"anubis_base_prefix\" type=\"application/json\">\"\"\n</script><script id=\"anubis_public_url\" type=\"application/json\">\"\"\n</script>\n\t\t<link rel=\"stylesheet\" href=\"/.within.website/x/cmd/anubis/static/css/challenge.css\"/>\n\t</head>\n\t<body>\n\t\t<div class=\"challenge\">\n\t\t\t<img\n\t\t\t\tclass=\"challenge__logo\"\n\t\t\t\tsrc=\"/.within.website/x/cmd/anubis/static/img/oe-logo.png\"\n\t\t\t\talt=\"OpenEdition\"\n\t\t\t>\n\t\t\t<div class=\"centered-div\"><p id=\"status\">Loading...</p><p id=\"anubis-script-error\" style=\"display:none;\">Anubis could not load its JavaScript. The server may be overloaded. Please reload the page to try again.</p><script id=\"anubis-main\" async type=\"module\" src=\"/.within.website/x/cmd/anubis/static/js/main.mjs?cacheBuster=v1.26.2\"></script><script>/*\n@licstart  The following is the entire license notice for the\nJavaScript code in this page.\n\nCopyright (c) 2026 Xe Iaso <xe.iaso@techaro.lol>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.\n\n@licend  The above is the entire license notice\nfor the JavaScript code in this page.\n\n## Rationale\n\nThis script catches `main.mjs` failing to load and re-injects it with\njittered exponential backoff.\n\nWithout this any failures loading `main.mjs` leaves the challenge page\nsitting on the \"Loading...\" message forever with no error messaging\noutside of the browser console, which is unavailable on mobile browsers.\n\nDisable loading this script at your peril. You have been warned.\n*/\n(()=>{var f=(e,t=750,n=1e4)=>Math.random()*Math.min(n,t*Math.pow(e,2));var d=(e,t={},n=[])=>{let s=typeof e==\"function\"?e(t):Object.assign(document.createElement(e),t);return Array.isArray(n)||(n=[n]),s.append(...n),s};var i=e=>document.getElementById(e);var _=e=>e.map(i);(()=>{let e=i(\"anubis-main\");if(!e){console.debug(\"can't find anubis main.mjs element via ID `anubis-main`, bailing\");return}let t=e.getAttribute(\"src\");if(!t){console.debug(\"can't find src attribute of script element `anubis-main`, bailing\");return}let n=t.indexOf(\"?\")===-1?\"?\":\"&\",s=4,E=750,A=1e4,c=1e4,a=0,l=0,u=()=>window.__anubisBooted===!0,p=()=>{let r=_([\"anubis-script-error\",\"status\",\"progress\"]);if(r.filter(D=>D==null).length!==0){console.debug(\"missing one of the following elements: anubis-script-error, status, progress. cannot proceed, bailing.\");return}let[o,M,T]=r;o.style.display=\"block\",M.style.display=\"none\",T.style.display=\"none\"},m=r=>()=>{if(u()||r!==l)return;if(l++,a++,a>s){p();return}let o=f(a,E,A);setTimeout(y,o)},y=()=>{if(u())return;let r=m(l),o=d(\"script\",{async:!0,type:\"module\",src:t+n+\"anubisRetry=\"+a,onerror:r});document.head.appendChild(o),setTimeout(r,c)},b=m(0);e.onerror=b,setTimeout(b,c)})();})();\n</script><div id=\"progress\" role=\"progressbar\" aria-labelledby=\"status\"><div class=\"bar-inner\"></div></div><div id=\"testarea\"></div></div>\n\t\t\t<div class=\"challenge__block\">\n\t\t\t\t<p class=\"challenge__block__text\">\n\t\t\t\t\tCe site utilise Anubis, un outil qui filtre les robots nuisibles.<br />\n\t\t\t\t\tNous vérifions actuellement que vous n’êtes pas un robot.\n\t\t\t\t</p>\n\t\t\t\t<p class=\"challenge__block__text\">\n\t\t\t\t\tEn cas de problème, contactez-nous à contact(at)openedition.org\n\t\t\t\t</p>\n\t\t\t</div>\n\t\t\t<div class=\"challenge__block\">\n\t\t\t\t<p class=\"challenge__block__text challenge__block__text--en\">\n\t\t\t\t\tThis site uses Anubis, a tool which filters out harmful bots.<br />\n\t\t\t\t\tWe’re currently verifying that you’re not a robot.\n\t\t\t\t</p>\n\t\t\t\t<p class=\"challenge__block__text challenge__block__text--en\">\n\t\t\t\t\tIf you encounter a problem, please contact us at contact(at)openedition.org\n\t\t\t\t</p>\n\t\t\t</div>\n\t\t\t<div class=\"spinner\"></div>\n\t\t</div>\n\t</body>\n</html>\n",
};

/** The same gate on a second site, captured the same minute the same way. */
export const ANUBIS_PROFORTO: CapturedInterstitial = {
  vendor: 'anubis',
  provenance: "curl -A '<Chrome 140 macOS user agent>' -H 'Accept: text/html', 2026-09-29 20:45:43Z, 200, verbatim and whole",
  url: 'https://proforto.nl/werkschoenen/veiligheidsschoenen/werkschoenen-sneakers/rucanor-work_gerba_shoes-for-crews_herock_unisex_groen_hoog-model',
  status: 200,
  servedBytes: 5405,
  textLength: 379,
  nodes: 0,
  elided: false,
  html: "<!DOCTYPE html>\n<html lang=\"en\">\n    <head>\n        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n        <title>Human verification</title>\n        <link rel=\"stylesheet\" href=\"/.within.website/x/cmd/anubis/static/css/botstopper.css\" />\n        <script id=\"anubis_version\" type=\"application/json\">\"1.27.0+hypernode1\"\n</script><script id=\"anubis_challenge\" type=\"application/json\">{\"rules\":{\"algorithm\":\"fast\",\"difficulty\":2},\"challenge\":{\"issuedAt\":\"2026-09-29T20:45:43.449593929Z\",\"metadata\":{\"User-Agent\":\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36\",\"X-Real-Ip\":\"192.0.2.1\"},\"id\":\"01a0eeea-8a99-7905-bcb0-db7190bcbdec\",\"method\":\"fast\",\"randomData\":\"6a60dbbb81e1580b088a3c8dc1897a4aabb601e09bd44290de7f052d6e5bad02575f5029e0053221b59741bf09b66cddf4436dbe9e82c9c659d8d1f496e83bde\",\"policyRuleHash\":\"ac980f49c4d35fab\",\"difficulty\":2,\"spent\":false}}\n</script><script id=\"anubis_base_prefix\" type=\"application/json\">\"\"\n</script><script id=\"anubis_public_url\" type=\"application/json\">\"\"\n</script>\n    </head>\n    <body>\n        <div class=\"page-content-wrapper\">\n            <div class=\"page-content\">\n                <img width=\"137\" height=\"17\" src=\"/.within.website/x/cmd/anubis/static/img/logo.svg\" />\n                <div class=\"content\">\n                    <h2>Checking if you're human</h2>\n                    <p>We are running a quick security check to protect this site from bots. This should only take a few seconds.</p>\n                    <div class=\"centered-div\"><p id=\"status\">Loading...</p><p id=\"anubis-script-error\" style=\"display:none;\">Anubis could not load its JavaScript. The server may be overloaded. Please reload the page to try again.</p><script id=\"anubis-main\" defer type=\"module\" src=\"/.within.website/x/cmd/anubis/static/js/main.mjs?cacheBuster=1.27.0+hypernode1\"></script><script>/*\n@licstart  The following is the entire license notice for the\nJavaScript code in this page.\n\nCopyright (c) 2026 Xe Iaso <xe.iaso@techaro.lol>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.\n\n@licend  The above is the entire license notice\nfor the JavaScript code in this page.\n\n## Rationale\n\nThis script catches `main.mjs` failing to load and re-injects it with\njittered exponential backoff.\n\nWithout this any failures loading `main.mjs` leaves the challenge page\nsitting on the \"Loading...\" message forever with no error messaging\noutside of the browser console, which is unavailable on mobile browsers.\n\nDisable loading this script at your peril. You have been warned.\n*/\n(()=>{var f=(e,t=750,n=1e4)=>Math.random()*Math.min(n,t*Math.pow(e,2));var d=(e,t={},n=[])=>{let s=typeof e==\"function\"?e(t):Object.assign(document.createElement(e),t);return Array.isArray(n)||(n=[n]),s.append(...n),s};var i=e=>document.getElementById(e);var _=e=>e.map(i);(()=>{let e=i(\"anubis-main\");if(!e){console.debug(\"can't find anubis main.mjs element via ID `anubis-main`, bailing\");return}let t=e.getAttribute(\"src\");if(!t){console.debug(\"can't find src attribute of script element `anubis-main`, bailing\");return}let n=t.indexOf(\"?\")===-1?\"?\":\"&\",s=4,E=750,A=1e4,c=1e4,a=0,l=0,u=()=>window.__anubisBooted===!0,p=()=>{let r=_([\"anubis-script-error\",\"status\",\"progress\"]);if(r.filter(D=>D==null).length!==0){console.debug(\"missing one of the following elements: anubis-script-error, status, progress. cannot proceed, bailing.\");return}let[o,M,T]=r;o.style.display=\"block\",M.style.display=\"none\",T.style.display=\"none\"},m=r=>()=>{if(u()||r!==l)return;if(l++,a++,a>s){p();return}let o=f(a,E,A);setTimeout(y,o)},y=()=>{if(u())return;let r=m(l),o=d(\"script\",{async:!0,type:\"module\",src:t+n+\"anubisRetry=\"+a,onerror:r});document.head.appendChild(o),setTimeout(r,c)},b=m(0);e.onerror=b,setTimeout(b,c)})();})();\n</script><div id=\"progress\" role=\"progressbar\" aria-labelledby=\"status\"><div class=\"bar-inner\"></div></div><div id=\"testarea\"></div></div>\n\n                    <img width=\"48\" height=\"48\" class=\"loader\" src=\"/.within.website/x/cmd/anubis/static/img/loader.png\" alt=\"Checking your browser\" />\n                    <p class=\"loader-alt\">Checking your browser...</p>\n\n                    <p>If this takes more than 30 seconds, try refreshing the page.</p>\n                    <p>Need help? <a href=\"mailto:support@hypernode.com\">Contact support</a></p>\n                </div>\n            </div>\n        </div>\n    </body>\n</html>\n",
};

/**
 * Shein's js challenge (`captcha_type=903`), the page a deep url is redirected
 * to by Shein's risk service. Stored by production session
 * `sess_…` (Stealth Bench task 15, run_…, 2026-10-06), request
 * `oc.6200.r2`, and read back through `GET /v1/sessions/{id}/request`. Two
 * verbatim windows: the server state carrying the page's own url, and the
 * risk page's configuration and check script at the end of the body.
 * `textLength` is the most the page rendered live on the fleet (2026-10-07,
 * `sess_…`, `document.body.innerText.length`, 384-1,372 over 17 s).
 */
export const SHEIN_JS_CHALLENGE: CapturedInterstitial = {
  vendor: 'shein-js-challenge',
  provenance: 'production session network body, sess_… oc.6200.r2, 2026-10-06; two verbatim windows of 362,958 characters',
  url: "https://us.shein.com/risk/challenge?captcha_type=903&redirection=https%3A%2F%2Fus.shein.com%2Fpdsearch%2Fwinter%2520jackets%2F%3Fcdn_rsite%3Dak%26ref%3Dwww%26rep%3Ddir%26ret%3Dus&risk-id=E4925014249216046720",
  status: 200,
  servedBytes: 365415,
  textLength: 1372,
  nodes: 0,
  elided: true,
  html: "erNavigatorUp\":false,\"topBannerContent\":[],\"topBannerTraceId\":\"40070a9a7b4b3d5c:5bcb791ef00e05b6:89c8f267d80added:0\",\"activeChannelId\":10,\"enlargeSearch\":true,\"isSearchPage\":false,\"originalUrl\":\"/risk/challenge?captcha_type=903&redirection=https%3A%2F%2Fus.shein.com%2Fpdsearch%2Fwinter%2520jackets%2F%3Fcdn_rsite%3Dak%26ref%3Dwww%26rep%3Ddir%26ret%3Dus&risk-id=E4925014249216046720\",\"us\":[{\"id\":\"916425\",\"firstFloorContent\":{\"props\":{\"id\":\"127423873\",\"metaData\":{\"categoryLanguageCopywritingGroupId\":\"3912\",\"c\n<!-- 233,391 bytes elided -->\n<script>\n  var SaPageInfo = {\n    page_name: 'page_risk_crawler_block',\n    page_id: 6407\n  }\n  var GB_RISK_CHALLEGE_LANG = {\n    SHEIN_KEY_PC_16509: \"Access timed out, please refresh the page and try again.\"\n  }\n  var GB_RISK_CHALLEGE_LIMIT = \"1\"\n  var GB_FLOW_CHECK_REDIRECTION = \"999\"\n</script>\n<script src=\"//sc.ltwebstatic.com/she_dist/assets/risk_challenge-341d2ad5778fda04.js\" crossorigin=\"anonymous\"></script>",
};

/** Every captured interstitial, for the per-row assertions. */
export const CAPTURED_INTERSTITIALS: readonly CapturedInterstitial[] = [
  IMPERVA_NORDSTROM,
  DATADOME_LEBONCOIN,
  DATADOME_G2,
  PX_ZILLOW,
  AWSWAF_BINANCE,
  AKAMAI_WALGREENS,
  KASADA_CANADAGOOSE,
  FACEBOOK_ADLIBRARY,
  AMAZON_CONTINUE_COM,
  CLOUDFLARE_MEDIUM,
  ANUBIS_OPENEDITION,
  ANUBIS_PROFORTO,
  SHEIN_JS_CHALLENGE,
];

/**
 * THE NEGATIVE CONTROL, AND THE REASON TWO ROWS ARE NOT IN THE TABLE.
 *
 * PerimeterX's sensor on a page PerimeterX did NOT challenge: two verbatim
 * windows out of the 412,838-byte `www.zillow.com` document the fork loaded on
 * CDP 9946, which rendered 3,170 characters and 274 links with a 200 response.
 * The first is where the page sets `window._pxAppId`; the second is the 1x1
 * `js.px-cloud.net` iframe it mounts.
 *
 * A marker-only gate fires here, and that is precisely the behaviour
 * `familyOf`'s `null` branches exist to prevent — it would pay a model, or in
 * this case hold a customer's read for a challenge ceiling, on a page with no
 * puzzle on it. Both strings are therefore excluded from
 * `INTERSTITIAL_MARKERS.px`, and the floor is the second line of defence for
 * any marker that leaks the same way in future.
 */
export const PX_SENSOR_ON_A_FINE_PAGE: CapturedDocument = {
  provenance: 'fork on CDP 9946, two windows out of the fully loaded document at t+10 s',
  url: 'https://www.zillow.com/',
  status: 200,
  servedBytes: 412838,
  textLength: 3170,
  nodes: 1259,
  elided: true,
  html: " = decodeURIComponent(raw);\n\n                    // Remove wrapping quotes if they exist\n                    return decoded.replace(/^\"|\"$/g, '');\n                }\n\n                if (allowedHosts.includes(window.location.host)) {\n                    window._pxAppId = 'PXHYx10rg3';\n                    // Custom parameters\n                    window._pxParam1 = getCookieValue('zguid');\n                    window._pxParam4 = getCookieValue('zjs_user_id');\n                    var p = document.getElementsByTagName('script')[0],\n                        s = \n<!-- 169,000 bytes elided -->\n); height: 1px; margin: -1px; overflow: hidden; padding: 0px; position: absolute; top: 0px; width: 1px; white-space: nowrap; overflow-wrap: normal;\"></p></next-route-announcer><iframe src=\"https://js.px-cloud.net/?t=d-uhqb360sp-1789022166448&amp;v=e6c40354-ace1-11f1-8b61-b63dbc0f267b&amp;h=d3d3LnppbGxvdy5jb20%3D&amp;a=PXHYx10rg3\" data-frame-token=\"d-uhqb360sp-1789022166448\" referrerpolicy=\"strict-",
};

/**
 * THE NEGATIVE CONTROL FOR `amazon-continue`, from the same site: the page the
 * second capture's own form submitted to (`/errors_page/validateCaptcha`, same
 * exit, same cookie jar, 2026-09-25 17:28:52Z), which answered the 777,863-byte
 * `www.amazon.com/` homepage. This is the verbatim window of its one GET form
 * with a submit control — the header search — which is the nearest thing on a
 * real Amazon page to the gate's own form. The heading appears nowhere in the
 * full document (0 occurrences), nor `validateCaptcha`; the same holds for a
 * loaded 1,084,229-byte `www.amazon.in/` captured the same afternoon.
 *
 * `textLength` is the FULL page's, computed from its bytes (scripts, styles and
 * comments removed, whitespace collapsed) rather than measured in a browser.
 */
export const AMAZON_LOADED_HOMEPAGE: CapturedDocument = {
  provenance:
    'curl, same exit and cookie jar as the second gate capture, 2026-09-25 17:28:52Z; the verbatim nav-search-bar-form window of the loaded homepage',
  url: 'https://www.amazon.com/',
  status: 200,
  servedBytes: 363839,
  textLength: 4703,
  nodes: 0,
  elided: true,
  html: "<form\n    id=\"nav-search-bar-form\"\n    accept-charset=\"utf-8\"\n    action=\"/s/ref=nb_sb_noss\"\n    class=\"nav-searchbar nav-progressive-attribute\"\n    method=\"GET\"\n    name=\"site-search\"\n    role=\"search\"\n  >\n\n    <div class=\"nav-left\">\n      <div id=\"nav-search-dropdown-card\">\n        \n  <div class=\"nav-search-scope nav-sprite\">\n    <div class=\"nav-search-facade\" data-value=\"search-alias=aps\">\n      <span id=\"nav-search-label-id\" class=\"nav-search-label nav-progressive-content\">All</span>\n      <i class=\"nav-icon\"></i>\n    </div>\n    <label id=\"searchDropdownDescription\" for=\"searchDropdownBox\" class=\"nav-progressive-attribute\" style=\"display:none\">Select the department you want to search in</label>\n    <select\n      aria-describedby=\"searchDropdownDescription\"\n      class=\"nav-search-dropdown searchSelect nav-progressive-attrubute nav-progressive-search-dropdown\"\n      data-nav-digest=\"dJExBKhZbs4+bzw1BCa+rKrK3Q8=\"\n      data-nav-selected=\"0\"\n      id=\"searchDropdownBox\"\n      name=\"url\"\n      style=\"display: block;\"\n      tabindex=\"0\"\n      title=\"Search in\"\n    >\n        <option selected=\"selected\" value=\"search-alias=aps\">All Departments</option>\n        <option value=\"search-alias=alexa-skills\">Alexa Skills</option>\n        <option value=\"search-alias=vehicles\">Amazon Autos</option>\n        <option value=\"search-alias=amazon-devices\">Amazon Devices</option>\n        <option value=\"search-alias=amazon-global-store\">Amazon Global Store</option>\n        <option value=\"search-alias=bazaar\">Amazon Haul</option>\n        <option value=\"search-alias=amazon-one-medical\">Amazon One Medical</option>\n        <option value=\"search-alias=amazon-pharmacy\">Amazon Pharmacy</option>\n        <option value=\"search-alias=warehouse-deals\">Amazon Resale</option>\n        <option value=\"search-alias=appliances\">Appliances</option>\n        <option value=\"search-alias=mobile-apps\">Apps & Games</option>\n        <option value=\"search-alias=arts-crafts\">Arts, Crafts & Sewing</option>\n        <option value=\"search-alias=audible\">Audible Books & Originals</option>\n        <option value=\"search-alias=automotive\">Automotive Parts & Accessories</option>\n        <option value=\"search-alias=baby-products\">Baby</option>\n        <option value=\"search-alias=beauty\">Beauty & Personal Care</option>\n        <option value=\"search-alias=stripbooks\">Books</option>\n        <option value=\"search-alias=popular\">CDs & Vinyl</option>\n        <option value=\"search-alias=mobile\">Cell Phones & Accessories</option>\n        <option value=\"search-alias=fashion\">Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=fashion-womens\">Women's Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=fashion-mens\">Men's Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=fashion-girls\">Girl's Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=fashion-boys\">Boy's Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=fashion-baby\">Baby Clothing, Shoes & Jewelry</option>\n        <option value=\"search-alias=collectibles\">Collectibles & Fine Art</option>\n        <option value=\"search-alias=computers\">Computers</option>\n        <option value=\"search-alias=financial\">Credit and Payment Cards</option>\n        <option value=\"search-alias=digital-music\">Digital Music</option>\n        <option value=\"search-alias=electronics\">Electronics</option>\n        <option value=\"search-alias=lawngarden\">Garden & Outdoor</option>\n        <option value=\"search-alias=gift-cards\">Gift Cards</option>\n        <option value=\"search-alias=grocery\">Grocery & Gourmet Food</option>\n        <option value=\"search-alias=handmade\">Handmade</option>\n        <option value=\"search-alias=hpc\">Health, Household & Baby Care</option>\n        <option value=\"search-alias=local-services\">Home & Business Services</option>\n        <option value=\"search-alias=garden\">Home & Kitchen</option>\n        <option value=\"search-alias=industrial\">Industrial & Scientific</option>\n        <option value=\"search-alias=prime-exclusive\">Just for Prime</option>\n        <option value=\"search-alias=digital-text\">Kindle Store</option>\n        <option value=\"search-alias=fashion-luggage\">Luggage & Travel Gear</option>\n        <option value=\"search-alias=luxury\">Luxury Stores</option>\n        <option value=\"search-alias=magazines\">Magazine Subscriptions</option>\n        <option value=\"search-alias=movies-tv\">Movies & TV</option>\n        <option value=\"search-alias=mi\">Musical Instruments</option>\n        <option value=\"search-alias=office-products\">Office Products</option>\n        <option value=\"search-alias=pets\">Pet Supplies</option>\n        <option value=\"search-alias=luxury-beauty\">Premium Beauty</option>\n        <option value=\"search-alias=instant-video\">Prime Video</option>\n        <option value=\"search-alias=samedaystore\">Same-Day Store</option>\n        <option value=\"search-alias=smart-home\">Smart Home</option>\n        <option value=\"search-alias=software\">Software</option>\n        <option value=\"search-alias=sporting\">Sports & Outdoors</option>\n        <option value=\"search-alias=specialty-aps-sns\">Subscribe & Save</option>\n        <option value=\"search-alias=subscribe-with-amazon\">Subscription Boxes</option>\n        <option value=\"search-alias=tools\">Tools & Home Improvement</option>\n        <option value=\"search-alias=toys-and-games\">Toys & Games</option>\n        <option value=\"search-alias=under-ten-dollars\">Under $10</option>\n        <option value=\"search-alias=videogames\">Video Games</option>\n        <option value=\"search-alias=wholefoods\">Whole Foods Market</option>\n    </select>\n  </div>\n\n      </div>\n    </div>\n    <div class=\"nav-fill\">\n      <div class=\"nav-search-field \">\n          <label for=\"twotabsearchtextbox\" style=\"display: none;\">Search Amazon</label>\n          <input\n            type=\"text\"\n            id=\"twotabsearchtextbox\"\n            value=\"\"\n            name=\"field-keywords\"\n            autocomplete=\"off\"\n            placeholder=\"Search Amazon\"\n            class=\"nav-input nav-progressive-attribute\"\n            dir=\"auto\"\n            tabindex=\"0\"\n            aria-label=\"Search Amazon\"\n            role=\"searchbox\"\n            aria-autocomplete=\"list\"\n            aria-controls=\"sac-autocomplete-results-container\"\n            aria-expanded=\"false\"\n            aria-haspopup=\"grid\"\n            spellcheck=\"false\"\n          >\n      </div>\n      <div id=\"nav-iss-attach\"></div>\n    </div>\n    <div class=\"nav-right\">\n      <div class=\"nav-search-submit nav-sprite\">\n        <span id=\"nav-search-submit-text\" class=\"nav-search-submit-text nav-sprite nav-progressive-attribute\" aria-label=\"Go\">\n          <input id=\"nav-search-submit-button\" type=\"submit\" class=\"nav-input nav-progressive-attribute\" value=\"Go\" tabindex=\"0\">\n        </span>\n      </div>\n    </div>\n  </form>",
};

/**
 * THE NEGATIVE CONTROL FOR `anubis`, from the same site: the page the solved
 * challenge redirected to (the capture's own proof of work, solved and passed
 * with the same user agent and cookie jar, 2026-09-29 ~20:5xZ), 200, 248,890
 * bytes, 71,926 characters from its bytes. `anubis_challenge` and
 * `.within.website` occur ZERO times in the full document. This is its verbatim
 * `<head>` window.
 */
export const ANUBIS_LOADED_OPENEDITION: CapturedDocument = {
  provenance: 'Anubis pass-challenge with the capture\'s own solved proof of work, same user agent and cookie jar, 2026-09-29; the verbatim <head> window of the loaded page',
  url: 'https://books.openedition.org/pur/12467?lang=en',
  status: 200,
  servedBytes: 248890,
  textLength: 71926,
  nodes: 0,
  elided: true,
  html: "<head>\n        <meta charset=\"utf-8\" />\n        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n                    <link rel=\"icon\" type=\"image/x-icon\" href=\"/assets/images/favicon.ico\" />\n            <link rel=\"shortcut icon\" type=\"image/x-icon\" href=\"/assets/images/favicon.ico\" />\n                <title>\n                                    Art et contestation -\n                8. La créativité comme arme révolutionnaire ? - \n                Presses universitaires de Rennes\n            </title>\n                                                                                                                                                                                                                    <meta name=\"keywords\"\n                    xml:lang=\"fr\"\n                    lang=\"fr\"\n                    content=\"France\" />\n                <meta name=\"citation_keywords\" content=\"France\" />\n                                                        <link rel=\"stylesheet\" href=\"/assets/front/css/front.02c78f83.css\" />\n                    <link rel=\"alternate\" type=\"application/rss+xml\" title=\"RSS\" href=\"https://books.openedition.org/pur/backend/?format=rss\" />",
};

/**
 * THE NEGATIVE CONTROLS FOR `shein-js-challenge`, the same site and the same
 * session as the capture: the 909 page (the "I am human" box a person presses,
 * `page.verify`'s Shein reader, which waiting never clears) is the SAME
 * template with `captcha_type=909` in its server state (request `oc.5657.r2`),
 * and the front page the warm-up loaded (`oc.6089.r1`) carries its own url
 * there. The 903 literal is in neither full body (0 occurrences each; 7 of 7
 * stored 909 bodies and 8 of 8 stored front pages across the eight 903 runs).
 * `textLength` is each page's live figure on the fleet (2026-10-07,
 * `sess_…`): the 909 page 384-1,372, the front page 1,252-1,253.
 */
export const SHEIN_ONE_PASS_BOX: CapturedDocument = {
  provenance: 'production session network body, sess_… oc.5657.r2, 2026-10-06; the verbatim server-state window',
  url: "https://us.shein.com/risk/challenge?captcha_type=909&redirection=https%3A%2F%2Fus.shein.com%2Fpdsearch%2Fwinter%2520jackets%2F%3Fcdn_rsite%3Dak%26ref%3Dwww%26rep%3Ddir%26ret%3Dus&risk-id=E4925014208581630209",
  status: 200,
  servedBytes: 365470,
  textLength: 1372,
  nodes: 0,
  elided: true,
  html: "erNavigatorUp\":false,\"topBannerContent\":[],\"topBannerTraceId\":\"590c25808e7e594c:456d458d2a867867:d19070f2901fde01:0\",\"activeChannelId\":10,\"enlargeSearch\":true,\"isSearchPage\":false,\"originalUrl\":\"/risk/challenge?captcha_type=909&redirection=https%3A%2F%2Fus.shein.com%2Fpdsearch%2Fwinter%2520jackets%2F%3Fcdn_rsite%3Dak%26ref%3Dwww%26rep%3Ddir%26ret%3Dus&risk-id=E4925014208581630209\",\"us\":[{\"id\":\"916425\",\"firstFloorContent\":{\"props\":{\"id\":\"127423873\",\"metaData\":{\"categoryLanguageCopywritingGroupId\":\"3912\",\"c",
};

export const SHEIN_LOADED_HOMEPAGE: CapturedDocument = {
  provenance: 'production session network body, sess_… oc.6089.r1, 2026-10-06; the verbatim server-state window',
  url: "https://us.shein.com/?cdn_rsite=ak&ref=www&rep=dir&ret=us",
  status: 200,
  servedBytes: 1146915,
  textLength: 1253,
  nodes: 0,
  elided: true,
  html: "5E6\"}]},\"__comp_name\":\"FreeShippingInfo\"}],\"topBannerTraceId\":\"43036e0937fa0916:f79ab6c00e67d560:bc668d065c51967b:0\",\"activeChannelId\":10,\"enlargeSearch\":true,\"isSearchPage\":false,\"originalUrl\":\"/?cdn_rsite=ak&ref=www&rep=dir&ret=us\",\"us\":[{\"id\":\"916425\",\"firstFloorContent\":{\"props\":{\"id\":\"127423873\",\"metaData\":{\"categoryLanguageCopywritingGroupId\":\"3912\",\"categoryType\":{\"gameT",
};
