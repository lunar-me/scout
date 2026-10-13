/**
 * Research: read a live page and return structured results.
 *
 *   SCOUT_BASE_URL=https://your-endpoint/v1 SCOUT_API_KEY=... SCOUT_HANDS_MODEL=your-model-id \
 *     npx tsx examples/research.ts
 */
import { Scout } from '@outcrawl/scout';

import { modelsFromEnv } from './models';

const scout = new Scout({ browser: { launch: {} }, models: modelsFromEnv() });

const result = await scout.run(
  'Go to https://news.ycombinator.com and report the three stories with the most comments on the front page: ' +
    'title, link and comment count for each.',
  {
    caps: { steps: 15, duration: '8m' },
    schema: {
      type: 'object',
      properties: {
        stories: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              comments: { type: 'integer' },
            },
            required: ['title', 'url', 'comments'],
          },
        },
      },
      required: ['stories'],
    },
    onStep: (step) => console.log(`step ${String(step.index)}: ${step.action.description}`),
  },
);

console.log(result.status, result.stopReason);
console.log(JSON.stringify(result.data, null, 2));
if (result.error !== undefined) console.log('missing:', result.error);
