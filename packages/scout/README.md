<a href="https://github.com/outcrawlai/scout">
  <img alt="Scout by outcrawl. The open-source browser agent." src="https://raw.githubusercontent.com/outcrawlai/scout/main/.github/assets/banner-light.png" width="100%">
</a>

# Tell it the task. It opens a browser and gets it done.

Scout is an open-source agent that uses a real browser to finish a task for you. Describe what you need in plain words. Scout reads the page, clicks, types and scrolls until the job is done, then hands back the answer. If it cannot finish, it tells you what is missing and returns what it found.

It is the agent behind Outcrawl's hosted agent, published as it runs there: the same loop, the same model harness and the same browser binding. You bring the browser and the models.

- **Best on Outcrawl's cloud.** One line, `browser: 'outcrawl'`, gives Scout a browser that sites treat like anyone at home, with captcha solving and a replay of every run. It also drives a local browser it launches for you, or any browser you already run over the DevTools protocol.
- **Your models, one per job.** Any endpoint that speaks the chat completions API: a hosted provider, a gateway, or a server on your own machine. There is no default model.
- **An answer even when a run falls short.** A run that hits a limit or cannot finish still returns what it found, and says what is missing.

<p>
<a href="https://github.com/outcrawlai/scout#readme">
  <img alt="The end of a recorded Scout run on Outcrawl's cloud. Task: Go to https://books.toscrape.com, open the first book in the Poetry category and report its title and price. Answer: title A Light in the Attic, price £51.77. Completed in 5 steps." src="https://raw.githubusercontent.com/outcrawlai/scout/main/.github/assets/demo-light.png" width="100%">
</a>
</p>

The end of a recorded run on Outcrawl's cloud, 13 October 2026. [Watch the whole run on GitHub](https://github.com/outcrawlai/scout#readme). Full documentation: [outcrawl.ai/docs/scout](https://outcrawl.ai/docs/scout/overview).

## Start in three steps

**1. Install Scout.** Node 22 or later, or Bun. On Outcrawl's cloud there is no browser to install.

```sh
npm i @outcrawl/scout
```

**2. Add your keys.** An Outcrawl key for the browser ([free at outcrawl.ai](https://outcrawl.ai): 1,000 credits every month, no card needed), then your model endpoint's base URL (the part before `/chat/completions`), its key, and the model id it expects:

```sh
export OUTCRAWL_API_KEY=your-outcrawl-key
export SCOUT_BASE_URL=https://your-endpoint/v1
export SCOUT_API_KEY=your-model-key
export SCOUT_HANDS_MODEL=your-model-id
```

**3. Give it a task.** Save this as `task.ts` and run `npx tsx task.ts`:

```ts
import { Scout } from '@outcrawl/scout';

const scout = new Scout({
  browser: 'outcrawl',
  models: {
    hands: {
      model: process.env.SCOUT_HANDS_MODEL!,
      baseURL: process.env.SCOUT_BASE_URL!,
      apiKey: process.env.SCOUT_API_KEY ?? '',
    },
  },
});

const result = await scout.run(
  'Go to https://books.toscrape.com, open the first book in the Poetry category and report its title and price.',
  {
    caps: { steps: 15, duration: '8m' },
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, price: { type: 'string' } },
      required: ['title', 'price'],
    },
    onStep: (step) => console.log(step.index, step.action.description),
  },
);

console.log(result.status, result.data);
console.log(result.replayUrl); // the whole run, step by step
```

You see each step as it happens, then something like `completed { title: '...', price: '£..' }` and the replay link.

**Rather use a browser on your own machine?** Install `playwright-core` (or `puppeteer-core`) and a browser with `npm i playwright-core && npx playwright install chromium`, then change the one line to `browser: { launch: {} }`. Pass `browser: { launch: { headless: false } }` to watch it work. Replays come with the cloud, so `replayUrl` stays empty on your own browser.

## Models

Scout calls models by job. Name a model for each job you use, each on any chat completions endpoint, each with its own key if you like:

```ts
const scout = new Scout({
  browser: 'outcrawl',
  models: {
    hands: { model: 'your-hands-model', baseURL: 'https://endpoint-a/v1', apiKey: keyA },
    brain: { model: 'your-brain-model', baseURL: 'https://endpoint-b/v1', apiKey: keyB, effort: 'low' },
    eyes: { model: 'your-vision-model', baseURL: 'https://endpoint-a/v1', apiKey: keyA },
    extract: { model: 'your-extract-model', baseURL: 'http://localhost:8000/v1', apiKey: '' },
  },
});
```

| Job | Required | What it does | What matters |
| --- | --- | --- | --- |
| `hands` | yes | Reads the page's accessibility tree and picks each action: click, type, scroll, navigate, read. | Called on every step, so it sets most of a run's speed and cost. A fast model that follows a JSON schema reliably. |
| `brain` | no | Decides every step from a compact view of the page and the run so far; `hands` carries the decision out. | Helps long tasks that cross several pages or need a plan. A stronger reasoning model. |
| `eyes` | no | Answers questions about a screenshot when the agent asks to look at the page. | Must accept images. Without it the agent works from the accessibility tree alone. |
| `extract` | no | Reads a page into the answer or into your schema. | Long pages and exact fields. Without it `hands` extracts. |

Each job takes:

- `model`: the id your endpoint expects.
- `baseURL`: the endpoint, the part before `/chat/completions`.
- `apiKey`: sent as a bearer token. `''` sends none, for a local server.
- `effort` (optional): `'minimal' | 'low' | 'medium' | 'high'`, for models that take a reasoning effort.
- `structuredOutput` (optional): how a JSON reply is asked for. `'tool_choice'` (default) asks for one function call whose parameters are the schema, which most endpoints support; `'tool_auto'` offers that function without forcing it, for a reasoning model whose endpoint will not force a call while it thinks; `'json_object'` asks for any JSON and spells the schema out; `'strict'` sends a strict `json_schema` response format. If your endpoint refuses one, the run's error names the job and the setting to change.
- `headers` (optional): extra headers for every request.

**Cost.** When your endpoint states a cost per call, `result.costUsd` is the run's model spend. To price models yourself, and to hold a run to a `caps.budget`, pass `models.rates` with every job's model:

```ts
models: {
  hands: { ... },
  rates: {
    'your-model-id': { input: '0.30', output: '1.20', cacheRead: null, cacheWrite: null, inputModalities: ['text'] },
  },
}
```

Prices are USD per million tokens. Without rates and without a stated cost, `costUsd` is absent rather than zero.

## Browsers

**Outcrawl's cloud is the best way to run Scout.** Many sites stop a browser that runs from a data center or behaves like a script; on the cloud, Scout gets a browser built to get through. Moving between browsers is one line; your models and your task stay the same.

```ts
// Outcrawl's cloud browser (recommended). Reads OUTCRAWL_API_KEY.
browser: 'outcrawl'
browser: { outcrawl: { apiKey, proxy: 'http://user:pass@host:port', record: false } }

// A local Chromium, launched and closed by Scout.
browser: { launch: {} }
browser: { launch: { headless: false, executablePath: '/path/to/chrome', args: ['--lang=en-GB'], driver: 'puppeteer' } }

// Any browser you already run, over CDP. Scout opens its own tab, closes it after, and leaves your browser running.
browser: { cdpUrl: 'http://127.0.0.1:9222' }      // or the ws:// webSocketDebuggerUrl
```

With `launch`, Scout uses `playwright-core` if it is installed (with Playwright's own Chromium), otherwise `puppeteer-core` (with your installed Chrome). Name one with `driver`.

### What `browser: 'outcrawl'` gives you

- **Residential connections.** Traffic leaves through ordinary home connections, so sites load the way they do for anyone at home.
- **Captcha solving.** Challenges are answered inside the browser, and the run carries on.
- **Natural input.** The browser plans every pointer move, scroll and keystroke itself, so Scout sends it plain actions.
- **Recordings.** Sessions are recorded by default, and `result.replayUrl` links to a step-by-step replay once the run ends. `record: false` turns it off.
- **Nothing to install.** No browser to download, update or keep running on your machine.

**Measured:** runs on Outcrawl's cloud reached 92.5% of pages on Browser Use's 80-site benchmark, scored with their own code; the next best reached 81.4%. Three full runs, 7 October 2026. [Method and every run](https://outcrawl.ai/resources/benchmarks).

A session is billed as an ordinary Outcrawl browser session, and your model calls still go to your own endpoints. Every account gets 1,000 free credits a month, no card needed. Get a key at [outcrawl.ai](https://outcrawl.ai).

## Runs

```ts
const result = await scout.run(task, {
  caps: { steps: 30, duration: '5m', budget: '0.50' },
  schema: { ... },
  signal: controller.signal,
  onStep: (step) => console.log(step.action.description),
});
```

- `caps`: when the run stops. `steps` (default 40) and `duration` (default `'10m'`) always apply; `budget` is model spend in USD and needs `models.rates`. Reaching a cap is a normal ending, not an error.
- `schema`: a JSON Schema for the answer. Without one, the answer is the agent's own summary.
- `signal`: stops the run; it ends as `cancelled` with what it found so far.
- `onStep`: each step as it is recorded.

The result:

| Field | |
| --- | --- |
| `status` | `completed`, `partial` (fell short), `capped` (a cap you set was reached) or `failed` |
| `data` | the answer: schema-shaped with a schema, the agent's summary without one; partly filled on a partial run |
| `stopReason` | why it stopped, for example `task-complete`, `schema-satisfied`, `max-steps`, `max-duration`, `cancelled` |
| `error` | on a partial or failed run, what went wrong or what is still missing |
| `steps`, `stepsUsed` | every step: the action taken, its timing and usage, and whether its effect was confirmed |
| `goals`, `findings` | the plan the agent made and the facts it established on the way |
| `usage`, `costUsd` | tokens, and model spend in USD when known |
| `durationMs`, `pages` | wall time and pages loaded |
| `replayUrl` | on Outcrawl, a link to watch the run |

`run` throws only when it cannot start: a bad option (`ScoutConfigError`) or a browser that cannot be launched or reached (`ScoutBrowserError`).

## Examples

Each reads its models from the environment (see [`examples/models.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/models.ts)):

- [`research.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/research.ts): the three most-commented stories on the Hacker News front page, as structured results.
- [`form-fill.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/form-fill.ts): fill in and submit an order form, then read back what the server received.
- [`compare.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/compare.ts): open two books and compare price and stock in one answer.
- [`login.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/login.ts): sign in and read the signed-in page.
- [`outcrawl.ts`](https://github.com/outcrawlai/scout/blob/main/packages/scout/examples/outcrawl.ts): the research task on Outcrawl's cloud, with a replay link.

## Licence

Apache-2.0. The vendored input planner, agenthands, keeps its own MIT licence. Source, issues and contributions: [github.com/outcrawlai/scout](https://github.com/outcrawlai/scout).
