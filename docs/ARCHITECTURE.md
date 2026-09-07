# MenuGen architecture

MenuGen turns a spreadsheet of menu items into a ZIP of AI-generated dish photos.
It is a single Next.js 16 (App Router) + TypeScript application. The same
library powers the web UI, the HTTP API and the CLI.

```
src/
├── app/                    Next.js App Router
│   ├── layout.tsx          fonts, ThemeProvider (next-themes), Toaster, TooltipProvider
│   ├── page.tsx            the single-page workspace
│   ├── globals.css         Tailwind v4 + shadcn tokens (light + dark)
│   └── api/                Route Handlers (Node runtime) — see "HTTP API"
├── lib/                    Framework-agnostic core (importable from API, CLI, tests)
│   ├── types.ts            ★ shared contract — read this first
│   ├── models.ts           model registry (ids, pricing, sizes) + provider metadata
│   ├── prompt.ts           style presets + buildPrompt()
│   ├── parse.ts            CSV / XLSX → MenuItem[] (isomorphic: browser + Node)
│   ├── filename.ts         slugify dish names, de-duplicate within a job
│   ├── cost.ts             cost / time estimation + formatting helpers
│   ├── concurrency.ts      runPool() + retry() with exponential back-off, Retry-After
│   ├── image.ts            sharp: convert format, resize/crop to requested size
│   ├── zip.ts              manifest.csv + streaming ZIP (archiver)
│   ├── env.ts              server-only env access (API keys, DATA_DIR, defaults)
│   ├── errors.ts           ProviderError, ValidationError helpers
│   ├── providers/
│   │   ├── index.ts        getProvider(id), listProviders()
│   │   ├── openai.ts       Images API (POST /v1/images/generations)
│   │   ├── google.ts       Gemini API (generateContent with IMAGE modality; Imagen :predict)
│   │   ├── bfl.ts          Black Forest Labs API (async submit + poll)
│   │   └── mock.ts         returns bundled sample photos; no network, no key
│   └── jobs/
│       ├── store.ts        JobStore: in-memory map + JSON persistence in DATA_DIR/jobs/<id>/
│       ├── runner.ts       runJob()/regenerateItem(): pool, retries, events, cancellation
│       └── events.ts       per-job typed event bus used by the SSE route
├── cli/
│   └── index.ts            `npm run cli -- generate -i menu.csv -m <model>` and `models`
├── components/
│   ├── ui/                 shadcn/ui (base-nova style, Base UI primitives) — do not hand-edit
│   └── …                   feature components (see "UI")
└── hooks/                  useModels(), useJobEvents(jobId) (SSE with reconnect)
tests/                      vitest unit tests (node environment)
public/samples/*.jpg        fixture photos used by the mock provider
public/sample-menu.csv      demo input, loadable from the UI ("Use sample menu")
data/                       runtime data (gitignored): data/jobs/<jobId>/job.json + images/
```

## Principles

1. **Call vendors directly.** No Replicate/fal/aggregators. Each provider adapter
   uses `fetch` against the vendor's public REST API with the vendor's own key.
2. **Keys never leave the server.** API keys are read from environment variables
   in `src/lib/env.ts` only. The `/api/models` endpoint exposes *whether* a
   provider is configured, never the key.
3. **One contract.** Everything shares `src/lib/types.ts`. Do not duplicate types.
4. **Isomorphic core.** `parse.ts`, `prompt.ts`, `filename.ts`, `cost.ts`,
   `models.ts` must run in the browser (the UI parses files client-side for an
   instant preview). Node-only modules (`sharp`, `archiver`, `fs`) live in
   `image.ts`, `zip.ts`, `env.ts`, `providers/*`, `jobs/*` and are only imported
   from Route Handlers and the CLI.
5. **Cheap by default.** The default model is the best price/quality option for
   photorealistic food; the UI always shows the per-image and total estimate.
6. **Resumable.** Job state is persisted to disk after every item so a page
   refresh (or server restart) can show the gallery and retry failures.

## Data flow

```
Browser                              Server (Next.js Route Handlers)
──────────────────────────────────── ───────────────────────────────────────────
drop CSV/XLSX ─► parse.ts (client)
edit rows in table
pick model/style/size ◄──────────── GET /api/models (registry + configured flags)
click Generate ──────────────────► POST /api/jobs {items, settings}
                                     ├─ validate (zod), build prompts, filenames
                                     ├─ store.create(job) → data/jobs/<id>/job.json
                                     └─ runner.runJob(job) (fire-and-forget)
subscribe ◄──────────────────────── GET /api/jobs/:id/events (SSE)
  snapshot, item, job, log, end        runner emits events; store persists per item
render gallery cards ◄───────────── GET /api/jobs/:id/images/:itemId
regenerate one card ─────────────► POST /api/jobs/:id/items/:itemId/regenerate
download ◄───────────────────────── GET /api/jobs/:id/download (streamed ZIP + manifest.csv)
```

## HTTP API

All responses are JSON unless noted. Errors use `ApiError` (`{ error, code, details? }`)
with 400 (validation_error), 404 (not_found), 409 (conflict, e.g. job running),
422 (provider_not_configured), 500 (internal_error).

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/api/models` | – | `ModelsResponse` |
| GET | `/api/jobs` | `?limit=20` | `{ jobs: JobSummary[] }` newest first |
| POST | `/api/jobs` | `CreateJobRequest` | `202 { job: Job }` — generation starts immediately |
| GET | `/api/jobs/:jobId` | – | `{ job: Job }` |
| DELETE | `/api/jobs/:jobId` | – | `204` — cancels if running, deletes files |
| GET | `/api/jobs/:jobId/events` | – | `text/event-stream` of `JobEvent`; first event is `snapshot`; `: ping` comment every 15 s; stays open until the client disconnects (so later regenerate/retry events arrive on the same stream) |
| POST | `/api/jobs/:jobId/cancel` | – | `{ job: Job }` |
| POST | `/api/jobs/:jobId/retry-failed` | – | `202 { job: Job }` — re-queues failed/cancelled items |
| POST | `/api/jobs/:jobId/items/:itemId/regenerate` | `RegenerateItemRequest` | `202 { item: JobItem }` |
| GET | `/api/jobs/:jobId/images/:itemId` | `?v=<n>` | image bytes, `Content-Type: image/*`, `Cache-Control: private, max-age=31536000, immutable` |
| GET | `/api/jobs/:jobId/download` | – | `application/zip`, `Content-Disposition: attachment; filename="menugen_<sourceStem>_<jobId8>.zip"` |

SSE wire format: `event: <type>\ndata: <json JobEvent>\n\n`. The `data` JSON
always contains `type` as well, so clients can use either `addEventListener(type)`
or `onmessage`. The server never closes the stream on its own: `end` only marks
that the job reached a terminal state; a later regenerate/retry re-emits
`job`/`item`/`end` events on the same stream. The client closes the
`EventSource` when it leaves the results view.

### Validation limits (enforced server-side with zod)

- `items`: 1 … `MAX_ITEMS_PER_JOB` (env, default 500); `dishName` 1–200 chars; `description`/`category` ≤ 1000 chars.
- `settings.concurrency`: 1–8; `settings.maxRetries`: 0–5; `size` must be in the model's `sizes`; `format` ∈ jpeg|png|webp; `modelId` must exist in the registry; `quality` must be one of the model's `qualityOptions` when present.
- `customPrompt` ≤ 2000 chars.
- Regenerate/retry return 409 while the job is `running` and the item is `running`.

## Job runner semantics

- `runJob(jobId)`: marks job `running`, sets `startedAt`, runs `runPool(items, settings.concurrency, worker, signal)`.
- Worker per item: `retry(() => provider.generate(model, req), { maxRetries, baseDelayMs: 1500, factor: 2, jitter: true, shouldRetry: err => err.retryable, retryAfterMs from ProviderError })`.
- After success: `normalizeImage(bytes, mime, { format, size })` via sharp, write to `data/jobs/<id>/images/<itemId>.<ext>`, set `imageUrl = /api/jobs/<id>/images/<itemId>?v=<attempts>`, `costUsd = model price for the chosen quality`, `generatedAt`, `durationMs`; persist; emit `item`.
- After final failure: `status = failed`, `error = message` (truncate to 500 chars); persist; emit `item`.
- Cancellation: `AbortController` per job; pending items → `cancelled`, running items abort their fetch and become `cancelled`; job → `cancelled`.
- Job ends `done` when no item failed, otherwise `failed` (partial success is still `failed` at the job level but the ZIP contains every successful image; the UI shows "N of M generated").
- `regenerateItem(jobId, itemId, overrides)`: rebuilds prompt from (possibly edited) fields, runs the same worker for that single item while the job status becomes `running` if it was finished; emits `item`/`job`/`end`.
- The store is a `globalThis`-cached singleton (survives Next.js dev HMR). On first access it loads `data/jobs/*/job.json`; any job persisted as `running`/`queued` is marked `failed` with error "Interrupted by server restart" and its pending/running items become `failed` (so the UI can offer "Retry failed").
- Events: `events.ts` keeps an `EventEmitter`-like bus per job. The SSE route sends a `snapshot` from the store, then forwards events. When the job is already terminal at subscribe time it sends `snapshot` then `end` immediately, and keeps the stream open for later regenerate/retry events.

## Prompting

`buildPrompt(item, preset, customPrompt?)` — see `src/lib/prompt.ts`. Subject is
`"<dishName>"`, then `", <description>"` if present, then `" (<category>)"` if present.
Presets: `editorial` (default), `delivery-clean`, `rustic-dark`, `bright-minimal`, `custom`.
Prompts are phrased positively (no "negative prompt" syntax — modern models ignore it)
and always end with the no-text/no-people/no-watermark clause.

## Filenames

`toFilenameStem("Crème Brûlée!")` → `creme_brulee` (NFKD → strip diacritics →
lower → non-alphanumerics to `_` → collapse → trim; empty → `dish`). `assignFilenames(items, ext)`
appends `_2`, `_3` … for duplicates, preserving order. Max stem length 80.

## Cost

`estimateJobCost(model, quality, count)` → `{ perImageUsd, totalUsd }`.
`estimateDurationSeconds(model, count, concurrency)` uses a per-provider typical latency
(`openai` 25 s, `google` 12 s, `bfl` 10 s, `mock` 1 s) / concurrency.
`formatUsd(n)` → `$0.011`, `$1.20` (3 decimals under $1, else 2).

## UI

Single route `/`. Layout: sticky header (wordmark, "Docs" link to GitHub README,
theme toggle), `max-w-7xl` content, footer with provider status dots.

Workspace states:

1. **Compose** (no active job): two-column on ≥ lg. Left (2/3): Upload card
   (react-dropzone; `.csv .xlsx .xls`; "Use sample menu" button loads
   `/sample-menu.csv`) then the editable **Menu table** (dish name, description,
   category; inline edit on click; add row; delete row; search filter; row count;
   inline validation for empty dish names; shows the built prompt in a tooltip/expander).
   Right (1/3, sticky): **Settings** card — model select (grouped by provider,
   price badge, tags, disabled + "Add OPENAI_API_KEY" hint when not configured),
   quality (if any), style preset, size, format, advanced (concurrency, retries,
   extra prompt / custom template) — and the **Estimate** card (per-image ×
   count = total, ~time) with the primary **Generate N images** button.
2. **Results** (job selected): header with job name, model, status pill,
   progress bar (done/failed/total, elapsed, ETA), actions: Download ZIP,
   Retry failed, Cancel (while running), New batch. Then the **Gallery** grid
   (responsive 2–4 columns) of cards: image (or shimmer skeleton while
   pending/running, error state with message and Retry), dish name, category
   badge, hover actions (Regenerate, Open). Clicking opens a **Lightbox** dialog
   with the full image, prompt, attempts, duration, filename, cost, and
   Regenerate / Download single.
3. **Resume banner** on load when `/api/jobs` returns a recent job.

Live updates use `useJobEvents(jobId)` (EventSource, reconnects with back-off,
re-fetches `/api/jobs/:id` on reconnect). Toasts (sonner) for job completion,
failures, copy-to-clipboard.

Design: shadcn "base-nova" + Geist Sans; neutral surfaces with a warm
primary (`--primary` terracotta in light, amber in dark) reserved for the main
action and progress; Lucide icons only (no emoji icons); every icon-only button
has `aria-label`; focus rings visible; `prefers-reduced-motion` respected; works
at 375 / 768 / 1024 / 1440 px with no horizontal scroll.

## CLI

```
npm run cli -- models                       # list models, prices, configured providers
npm run cli -- generate -i menu.csv [-m openai/gpt-image-1-mini] [-o ./output]
                          [--style editorial] [--size 1024x1024] [--format jpeg]
                          [--quality medium] [--concurrency 3] [--retries 3] [--yes]
```
Prints a preview table + cost estimate, asks for confirmation unless `--yes`,
shows per-item progress lines, writes `output/menugen_<stem>_<timestamp>.zip`,
exits 0 on full success, 2 on partial failure, 1 on input/config errors.

## Environment

See `.env.example`. `OPENAI_API_KEY`, `GEMINI_API_KEY`, `BFL_API_KEY`,
`MENUGEN_DATA_DIR` (default `./data`), `MENUGEN_MAX_ITEMS_PER_JOB` (500),
`MENUGEN_DEFAULT_MODEL`, `MENUGEN_ENABLE_MOCK` (`true` shows the mock model in the UI).
The mock provider is always available to the CLI and tests.

### Mock model visibility

`GET /api/models` includes `mock/sample` when `MENUGEN_ENABLE_MOCK=true` **or**
when no real provider is configured (first-run experience). The CLI and tests can
always use it. The mock adapter (`providers/mock.ts`) returns a bundled sample photo
when the dish name matches one in `public/samples/`, otherwise renders a labelled
placeholder with sharp; it sleeps 300–900 ms to exercise progress UI, honours
`AbortSignal`, and fails deterministically when the prompt contains `[fail]`
(retryable) or `[fatal]` (non-retryable) so error paths can be tested.

### Environment loading

Next.js loads `.env` itself. The CLI calls `loadDotEnv()` from `src/lib/env.ts`
(built on `process.loadEnvFile`, so there is no dotenv dependency).
