/**
 * A login flow: sign in, read a page that is only there once you are signed
 * in, and sign out again.
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

const username = process.env['DEMO_USERNAME'] ?? 'tomsmith';
const password = process.env['DEMO_PASSWORD'] ?? 'SuperSecretPassword!';

const scout = new Scout({ browser: { launch: {} }, models: modelsFromEnv() });

const result = await scout.run(
  `Go to https://the-internet.herokuapp.com/login and sign in with username "${username}" and password ` +
    `"${password}". Report the heading and the message shown once you are signed in, then log out and ` +
    'report the message shown after logging out.',
  {
    caps: { steps: 15, duration: '4m' },
    schema: {
      type: 'object',
      properties: {
        signedInHeading: { type: 'string' },
        signedInMessage: { type: 'string' },
        signedOutMessage: { type: 'string' },
      },
      required: ['signedInHeading', 'signedInMessage', 'signedOutMessage'],
    },
  },
);

console.log(result.status, result.stopReason);
console.log(JSON.stringify(result.data, null, 2));
