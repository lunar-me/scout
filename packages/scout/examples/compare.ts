/**
 * A multi-page compare: find two products, open each one's page, and compare
 * them in one answer.
 *
 * A brain model helps here, where the run moves across several pages: set
 * SCOUT_BRAIN_MODEL as well as SCOUT_HANDS_MODEL.
 *
 *   SCOUT_BASE_URL=https://your-endpoint/v1 SCOUT_API_KEY=... SCOUT_HANDS_MODEL=your-model-id \
 *   SCOUT_BRAIN_MODEL=your-brain-model-id npx tsx examples/compare.ts
 */
import { Scout } from '@outcrawl/scout';

import { modelsFromEnv } from './models';

const scout = new Scout({ browser: { launch: {} }, models: modelsFromEnv() });

const result = await scout.run(
  'On https://books.toscrape.com find the books "A Light in the Attic" and "Tipping the Velvet". ' +
    "Open each book's own page and report its price and how many copies are in stock, then say which is cheaper.",
  {
    caps: { steps: 30, duration: '15m' },
    // One named field per book rather than a list: Scout merges what each page
    // gives it field by field, so the first book's details survive while it
    // reads the second book's page. A list is replaced whole by each new read.
    schema: {
      type: 'object',
      properties: {
        lightInTheAttic: book(),
        tippingTheVelvet: book(),
        cheaper: { type: 'string', description: 'The title of the cheaper book' },
      },
      required: ['lightInTheAttic', 'tippingTheVelvet', 'cheaper'],
    },
  },
);

console.log(result.status, `${String(result.pages)} pages, ${String(result.stepsUsed)} steps`);
console.log(JSON.stringify(result.data, null, 2));
for (const goal of result.goals ?? []) console.log(`goal ${goal.id}: ${goal.status}`);

function book() {
  return {
    type: 'object',
    properties: {
      price: { type: 'string' },
      inStock: { type: 'integer', description: 'How many copies are in stock' },
    },
    required: ['price', 'inStock'],
  };
}
