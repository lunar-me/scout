/**
 * The research example again, on Outcrawl's cloud browser. One option changes:
 * `browser: 'outcrawl'`. Same agent, same models, same result shape.
 *
 * What the cloud adds:
 * - residential exits, so the run reaches sites that refuse datacenter traffic;
 * - captcha solving, handled by the browser while the agent waits;
 * - natural input: the browser plans every pointer move, scroll and keystroke;
 * - a recording of the session, with a replay link on the result.
 *
 * It is billed as an ordinary Outcrawl browser session; your model calls still
 * go to your own endpoint.
 *
 *   OUTCRAWL_API_KEY=... SCOUT_BASE_URL=https://your-endpoint/v1 SCOUT_API_KEY=... \
 *   SCOUT_HANDS_MODEL=your-model-id npx tsx examples/outcrawl.ts
 */
import { Scout } from '@outcrawl/scout';

import { modelsFromEnv } from './models';

// Reads OUTCRAWL_API_KEY. Pass { outcrawl: { apiKey, proxy, record } } to set them in code.
const scout = new Scout({ browser: 'outcrawl', models: modelsFromEnv() });

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
  },
);

console.log(result.status, result.stopReason);
console.log(JSON.stringify(result.data, null, 2));
console.log('watch the run:', result.replayUrl ?? '(not recorded)');
