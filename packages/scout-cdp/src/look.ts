

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

/**
 * How large an enlarged look (an element named by `ref`, or a zoom region) is
 * photographed: its long side reaches this many device pixels, at no less
 * than the device's own resolution and at most {@link LOOK_ZOOM_MAX_SCALE}
 * times it. `Page.captureScreenshot`'s clip scale re-rasterises the area, so
 * an image the page shows shrunk is drawn from its own pixels, not stretched.
 *
 * MEASURED on neutral fixtures (2026-10-16, stock headless shell, DSF 2, n=5
 * per cell): a 1,600 px table scan shown as a 300 px thumbnail was misread on
 * 20 of 20 looks at the viewport's 2,560 px; its text is ~2-3 CSS px there.
 * The look model is billed about the same tokens for any picture size
 * (`MODEL_RATES`' look row: flat across DSF 1 and 2), so a crop costs no more
 * than the viewport and gives the named element all of it.
 */
export const LOOK_ZOOM_LONG_PX = 1_600;
export const LOOK_ZOOM_MAX_SCALE = 4;

/**
 * Paint stability for an enlarged look: the clip is re-taken this far apart,
 * up to this many times, until two in a row are identical — a chart mid-draw
 * or an image mid-decode is not photographed half done. The text-captcha
 * reader's rule (`shootElement`), at a shorter poll: a look's element is
 * usually painted already, and every read here is a customer's wall time.
 */
export const LOOK_PAINT_READS = 5;
export const LOOK_PAINT_POLL_MS = 150;

/**
 * How long a retake waits for content the look model said was not drawn yet
 * (`LookAnswer.unpainted`: an empty chart frame, a spinner): until the aimed
 * area differs from the picture the model was shown and then holds still, at
 * most this long and {@link LOOK_UNPAINTED_READS} captures. MEASURED on the
 * fixtures above: a chart whose data arrives 2 s after load was empty on 10
 * of 10 looks taken after the loop's settle; 4 s covers that with room, and
 * stays well inside the look model's own 20 s.
 */
export const LOOK_UNPAINTED_WAIT_MS = 4_000;
export const LOOK_UNPAINTED_POLL_MS = 250;
export const LOOK_UNPAINTED_READS = 16;

/**
 * An element named by `ref` whose picture is one flat colour on at least
 * this share of a {@link LOOK_FLAT_GRID}-square sample grid has not drawn
 * yet, so the camera waits for it as for `unpainted`
 * ({@link LOOK_UNPAINTED_WAIT_MS}) before the model is asked at all. The
 * model alone did not say so reliably: MEASURED on the fixtures above, a
 * canvas whose data arrives 2 s after load, looked at by reference, was
 * answered "the image is blank" with no retake on 5 of 5 looks.
 */
export const LOOK_FLAT_SHARE = 0.98;
export const LOOK_FLAT_GRID = 48;
