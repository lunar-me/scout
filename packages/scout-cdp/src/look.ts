

/**
 * How long `page.look` waits for `Page.captureScreenshot`. The look is taken
 * on the LIVE page (`PageSession.callTool`), because a frozen page caught
 * mid-frame answers no capture until it runs again. A live capture answers,
 * but not fast on a heavy Retina page. Measured on the fleet (/connect,
 * browser .21, 2026-09-26, DPR 2, n=10): recreation.gov p50 2,282 ms,
 * max 2,516 ms, 2.7 MB. The old 3 s bound sat just above that, with no fleet
 * load. Eight seconds is three times that max, and still well under the look
 * model's own 20 s.
 */
export const LOOK_CAPTURE_DEADLINE_MS = 8_000;

/** The isolated world `page.look`'s hit test reads ancestors in. */
export const LOOK_WORLD = 'outcrawl-look';
/** Released as a group after every hit test, so no remote object outlives it. */
export const LOOK_OBJECT_GROUP = 'outcrawl-look';

/** How many ancestors a hit test walks to find one the tree has a reference for. */
export const LOOK_ANCESTOR_LIMIT = 8;
/**
 * How a text-captcha photograph waits for its image to paint: up to this many
 * clip captures, this far apart, until two in a row match. Bounded at ~3 s,
 * inside the look model's own 20 s. See `shootElement`.
 */
export const TEXT_CAPTCHA_PAINT_READS = 8;
export const TEXT_CAPTCHA_PAINT_POLL_MS = 400;
/**
 * Below this many base64 characters (~750 bytes of PNG) a clip is taken to be
 * an empty box: a near-uniform area compresses to a few hundred bytes, a
 * painted code to kilobytes. Not measured on pngtree's image; a floor, not a fit.
 */
export const TEXT_CAPTCHA_PAINTED_MIN_B64 = 1_000;
/**
 * The width, in device pixels, a text-captcha image is photographed at. A code
 * image is often ~100 CSS px wide; upscaled to this the look model reads each
 * character from a few dozen pixels rather than a few.
 */
export const TEXT_CAPTCHA_CLIP_WIDTH_PX = 400;
