/**
 * A login flow: sign in, then read the page that is only there once you are
 * signed in.
 *
 * The site is a public test site whose demo credentials are printed on its own
 * login page. For a real site, read the credentials from your environment
 * rather than writing them into the task.
 *
 *   SCOUT_BASE_URL=https://your-endpoint/v1 SCOUT_API_KEY=... SCOUT_HANDS_MODEL=your-model-id \
 *     npx tsx examples/login.ts
 */
import { Scout } from '@outcrawl/scout';

import { modelsFromEnv } from './models';

const username = process.env['DEMO_USERNAME'] ?? 'student';
const password = process.env['DEMO_PASSWORD'] ?? 'Password123';

const scout = new Scout({ browser: { launch: {} }, models: modelsFromEnv() });

// The read is named in the task: a small hands model told only to "report" what the
// signed-in page shows sometimes moves on before it has read that page.
const result = await scout.run(
  `Go to https://practicetestautomation.com/practice-test-login/ and sign in with username "${username}" and ` +
    `password "${password}". Once you are signed in, extract the heading and the message of the page that welcomes you.`,
  {
    caps: { steps: 25, duration: '10m' },
    schema: {
      type: 'object',
      properties: {
        heading: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['heading', 'message'],
    },
  },
);

console.log(result.status, result.stopReason);
console.log(JSON.stringify(result.data, null, 2));
