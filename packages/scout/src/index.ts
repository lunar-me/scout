/**
 * `@outcrawl/scout`: the open-source browser agent behind Outcrawl's hosted
 * agent.
 *
 * ```ts
 * const scout = new Scout({
 *   browser: { launch: {} },
 *   models: { hands: { model: 'your-model-id', baseURL: 'https://your-endpoint/v1', apiKey: '...' } },
 * });
 * const result = await scout.run('Find the price of the first result for "usb-c cable" on example-shop.test');
 * ```
 */
export { Scout, type ScoutResult } from './scout';
export {
  ScoutBrowserError,
  ScoutConfigError,
  type BrowserOption,
  type LaunchOptions,
  type OutcrawlOptions,
  type RoleModel,
  type RunCaps,
  type RunOptions,
  type ScoutLogger,
  type ScoutModels,
  type ScoutOptions,
} from './options';
export type { RateCard, TokenRates } from '@outcrawl/model';
export type { HandsPort } from '@outcrawl/scout-cdp';
export type { AgentGoal, AgentStatus, AgentStep, AgentStopReason, JsonSchema, Usage } from '@outcrawl/scout-core';
export type { Finding } from '@outcrawl/runtime';
