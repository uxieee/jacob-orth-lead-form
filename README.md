# Jacob Orth Lead Form

The lead form, The Switch, and the Cloudflare Worker behind them.

| Piece | What it is | Where it runs today |
|---|---|---|
| `worker/` | The backend API. Takes form submissions, routes each lead to Jacob or the team, writes contacts and opportunities into GoHighLevel, books appointments, serves The Switch. | Cloudflare Workers, project `jacob-orth-lead-form` |
| `index.html`, `src/` | The lead form (embedded on the GHL landing page as an iframe). | Cloudflare Pages, project `jacob-orth-form` |
| `switch.html`, `src/switch.*` | The Switch: Jacob's routing rules and overflow toggle, at `/switch`. | Same Pages project |
| `shared/` | Routing rules logic, used by both the Worker and The Switch. | Bundled into both |
| `funnel/` | The HTML embeds pasted into the GHL landing and thank-you pages. | GoHighLevel |

## Run the tests

```sh
npm install
npm test
```

## Deploy to your own Cloudflare account

You need Node 18+ and a Cloudflare account. Log in once with `npx wrangler login`.

### 1. The Worker

```sh
cd worker
npx wrangler deploy
```

Then set its secrets (each command prompts for the value):

```sh
npx wrangler secret put GHL_API_TOKEN      # GoHighLevel Private Integration Token for the location
npx wrangler secret put GEOAPIFY_API_KEY   # Geoapify key, powers address autocomplete
```

Optional: `npx wrangler secret put SWITCH_SECRET` puts a passphrase on The Switch. Without it, saving on The Switch is open to anyone who has the unlisted `/switch` URL.

`ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to call the Worker. If the form moves to a new domain, add it there and redeploy.

The deploy prints the Worker's URL, something like `https://jacob-orth-lead-form.<your-subdomain>.workers.dev`.

### 2. The form and The Switch

Put the Worker URL from step 1 into `.env.production`:

```
VITE_BACKEND_URL=https://jacob-orth-lead-form.<your-subdomain>.workers.dev
```

Then build and deploy:

```sh
npm run build
npx wrangler pages deploy dist --project-name jacob-orth-form --branch main
```

### 3. Point the GHL pages at the new form

If the Pages URL changed, update the iframe `src` in the GHL landing page embed (`funnel/FILE 1 - Conversion Landing Page.html`) and add the new Pages origin to `ALLOWED_ORIGINS`.

## Local development

```sh
cp .env.example .env    # uses a mock backend, no API calls
npm run dev
```

To run the Worker locally, create `worker/.dev.vars` with the secrets above and run `npx wrangler dev` from `worker/`. That file is gitignored.

## Hardcoded GoHighLevel IDs

The location, pipeline, stage, calendar, custom field and custom value IDs live at the top of `worker/proxy.js`. They match Jacob's current GHL sub-account. If any of those objects are recreated in GHL, update the IDs there and redeploy the Worker.
