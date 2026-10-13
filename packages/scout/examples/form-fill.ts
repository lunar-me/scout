/**
 * A form fill: text fields, radio buttons, checkboxes and a submit, then read
 * back what the server received.
 *
 *   SCOUT_BASE_URL=https://your-endpoint/v1 SCOUT_API_KEY=... SCOUT_HANDS_MODEL=your-model-id \
 *     npx tsx examples/form-fill.ts
 */
import { Scout } from '@outcrawl/scout';

import { modelsFromEnv } from './models';

const scout = new Scout({ browser: { launch: {} }, models: modelsFromEnv() });

const result = await scout.run(
  'Open https://httpbin.org/forms/post and order a pizza: customer name Ada Lovelace, telephone 555-0100, ' +
    'email ada@example.com, size Large, toppings Bacon and Extra Cheese, delivery time 19:30, ' +
    'delivery instructions "Ring twice". Submit the order, then report the customer name, size and toppings ' +
    'exactly as the page that loads after submitting shows them.',
  {
    caps: { steps: 25, duration: '10m' },
    schema: {
      type: 'object',
      properties: {
        customer: { type: 'string' },
        size: { type: 'string' },
        toppings: { type: 'array', items: { type: 'string' } },
      },
      required: ['customer', 'size', 'toppings'],
    },
  },
);

console.log(result.status, result.stopReason, `${String(result.stepsUsed)} steps`);
console.log(JSON.stringify(result.data, null, 2));
