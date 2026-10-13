/**
 * A URL's site: its registrable domain, approximated without a public-suffix
 * list as the last two labels, or three under a common second-level suffix
 * (`co.uk`, `com.au`, `ne.jp`...). An IP literal is its own site. `undefined`
 * for anything that is not http(s), such as `about:blank`.
 *
 * The one copy in the workspace: the replay player, the session digest and the
 * agent's navigate check all read it. The workspace carries no public-suffix
 * list, so a PRIVATE suffix (`github.io`, `vercel.app`) is not known to be one:
 * `a.github.io` and `b.github.io` read as one site. A caller deciding anything
 * that matters on it adds its own guard (the navigate check also requires the
 * same path and https on both sides).
 */
export function siteOf(url: string): string | undefined {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    host = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.startsWith('[') || /^[0-9.]+$/u.test(host)) return host;
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1] as string;
  const second = labels[labels.length - 2] as string;
  const take = last.length === 2 && SECOND_LEVEL_SUFFIXES.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Second-level labels that are public suffixes under a country TLD. */
const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  'ac', 'co', 'com', 'edu', 'gob', 'gov', 'go', 'mil', 'ne', 'net', 'nic', 'or', 'org',
]);
