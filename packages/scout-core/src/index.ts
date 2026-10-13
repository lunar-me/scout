/**
 * `@outcrawl/scout-core` — the agent's shared contract.
 *
 * What the agent loop, its model port and its browser binding exchange: caps,
 * steps and results, the time seams, exact decimal arithmetic, run rules,
 * interstitial detection, the secret placeholder grammar, the purchase wire
 * shapes and the errors the agent raises. No dependencies and no I/O.
 */

export * from './types';
export * from './decimal';
export * from './errors';
export * from './interstitial';
export * from './pdf-text';
export * from './rules';
export * from './secrets';
export * from './site';
export * from './spend';
