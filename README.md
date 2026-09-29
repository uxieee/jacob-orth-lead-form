# Jacob Orth Lead Form

The lead form, The Switch, and the Cloudflare Worker behind them.

| Piece | What it is | Where it runs today |
|---|---|---|
| `worker/` | The backend API. Takes form submissions, routes each lead to Jacob or the team, writes contacts and opportunities into GoHighLevel, books appointments, serves The Switch. | Cloudflare Workers, project `jacob-orth-lead-form` |
| `index.html`, `src/` | The lead form (embedded on the GHL landing page as an iframe). | Cloudflare Pages, project `jacob-orth-form` |
| `switch.html`, `src/switch.*` | The Switch: Jacob's routing rules and overflow toggle, at `/switch`. | Same Pages project |
| `shared/` | Routing rules logic, used by both the Worker and The Switch. | Bundled into both |
| `funnel/` | The HTML embeds pasted into the GHL landing and thank-you pages. | GoHighLevel |

## What you need before you start

| Account | Needed for | Cost | Sign up |
|---|---|---|---|
| Cloudflare | Hosting the Worker, the form and The Switch | Free plan is enough (100,000 Worker requests a day) | https://dash.cloudflare.com/sign-up |
| GoHighLevel | You already have it. The Worker reads and writes Jacob's sub-account. | Existing | |
| Geoapify | Address suggestions while a lead types a property address | Free plan is enough (3,000 lookups a day, no card needed) | https://myprojects.geoapify.com/ |
| Node.js 18 or newer | Running the deploy commands on your computer | Free | https://nodejs.org (pick the LTS version) |

Git is optional. You can download this repo as a ZIP from the green **Code** button on GitHub.

## The secrets

The Worker needs API keys that must never be committed to this repo. They are stored inside Cloudflare as encrypted secrets, set with `npx wrangler secret put <NAME>` (step 4 below). None of them are in this code.

### `GHL_API_TOKEN` (required)

A GoHighLevel **Private Integration Token** for Jacob's sub-account. Without it the form cannot create leads, book calls, or read The Switch.

It must come from the **sub-account** (location ID `nkdEvYCLAfHu5d0jtCUi`), not the agency. The pipeline, calendar and field IDs in `worker/proxy.js` belong to that sub-account.

To create it:

1. Log into GoHighLevel and switch into Jacob's sub-account.
2. Go to **Settings > Private Integrations**. If you don't see it, ask whoever runs the agency account to give your user access to it.
3. Click **Create new Integration**. Name it something you'll recognise later, for example `Lead Form Worker`.
4. Tick these scopes (permissions):

   | Scope | Why the Worker needs it |
   |---|---|
   | `contacts.write` | Create or update the lead's contact, add and remove tags, add notes, assign the contact to Jacob |
   | `contacts.readonly` | Read contacts back during create and update |
   | `opportunities.write` | Create and move the lead's opportunity in the `Leads` pipeline |
   | `opportunities.readonly` | Find an existing opportunity for a returning lead |
   | `calendars.readonly` | Load Jacob's open time slots |
   | `calendars/events.write` | Book the appointment |
   | `calendars/events.readonly` | Read the booked appointment back |
   | `locations/customValues.readonly` | Read the overflow switch and routing rules |
   | `locations/customValues.write` | Save changes made on The Switch |

5. Save, then **copy the token right away**. GHL only shows it once. It starts with `pit-`.
6. Keep it somewhere safe, like a password manager. Anyone who has it can read and edit contacts in the sub-account.

If the token ever leaks, delete it on the same Private Integrations page, create a new one, and run `npx wrangler secret put GHL_API_TOKEN` again with the new value.

### `GEOAPIFY_API_KEY` (recommended)

Gives address suggestions on the property address question. If it's missing, leads just type the full address themselves and the form still works.

To create it:

1. Sign up at https://myprojects.geoapify.com/ (email or Google login).
2. Click **Add a new project** and name it, for example `Jacob Orth Lead Form`.
3. The project page shows an **API key**. Copy it.

Leave the key's IP and referrer restrictions off. The Worker calls Geoapify from Cloudflare's servers, so a restriction would block it.

The free plan allows 3,000 lookups a day. Each keystroke pause while someone types an address counts as one lookup. You can see usage on the project page.

### `SWITCH_SECRET` (leave unset)

The Worker can lock The Switch behind a passphrase. **Don't set it yet.** The Switch page doesn't send a passphrase at the moment, so setting this secret would make every save on The Switch fail with "Unauthorized" and Jacob couldn't change his routing. Locking The Switch needs a small change to `src/switch.js` first so the page asks for the passphrase and sends it in an `x-switch-secret` header.

Right now anyone who finds the Worker URL can change the routing. They can't see or change any lead data.

### `ALLOWED_ORIGINS` (not a secret, already set)

This is a plain setting in `worker/wrangler.toml`, not a secret. It lists the websites allowed to call the Worker:

```toml
ALLOWED_ORIGINS = "https://jacob-orth-form.pages.dev,https://realestate.jacobslifeinvegas.com"
```

If the form moves to a new address (a new Pages project name or a custom domain), add that address here, comma separated, with no trailing slash, and redeploy the Worker. If the form's address is missing from this list, the form loads but every submission fails.

## Deploy to your own Cloudflare account

Run these from a terminal in the folder where you downloaded this repo.

### 1. Install

```sh
npm install
npm test
```

All tests should pass.

### 2. Log into Cloudflare

```sh
npx wrangler login
```

A browser window opens. Log in and click **Allow**.

The first time you use Workers, Cloudflare asks you to pick a `workers.dev` subdomain (for example `jacob-orth`). You can also set it in the dashboard under **Workers & Pages**.

### 3. Deploy the Worker

```sh
cd worker
npx wrangler deploy
```

It prints the Worker's URL, like `https://jacob-orth-lead-form.<your-subdomain>.workers.dev`. Copy it.

### 4. Set the secrets

Still in `worker/`, run each command and paste the value when it asks:

```sh
npx wrangler secret put GHL_API_TOKEN
npx wrangler secret put GEOAPIFY_API_KEY
```

Secrets take effect straight away. You don't need to redeploy.

To check the Worker is up: open `https://<your worker URL>/api/health` in a browser. It should show `{"ok":true,"service":"jacob-orth-backend"}`. That only proves the Worker runs. To prove the GHL token works, open `https://<your worker URL>/api/switch`. It should show `{"ok":true,"mode":"off"}` (or `"on"`). A token that's wrong or missing a scope shows up as failed submissions, so also do the test lead in step 7.

To see which secrets are set (names only, never values): `npx wrangler secret list`.

You can also set or replace secrets in the dashboard: **Workers & Pages > jacob-orth-lead-form > Settings > Variables and Secrets**. Choose type **Secret**, not Text.

### 5. Point the form at your Worker

Go back to the repo folder (`cd ..`) and open `.env.production`. Replace the URL with your Worker URL from step 3:

```
VITE_BACKEND_URL=https://jacob-orth-lead-form.<your-subdomain>.workers.dev
```

### 6. Deploy the form and The Switch

```sh
npm run build
npx wrangler pages deploy dist --project-name jacob-orth-form --branch main
```

The first run asks to create the Pages project. Say yes. If `jacob-orth-form` is already taken on Cloudflare, pick another name. That changes the form's address, so add the new `https://<name>.pages.dev` to `ALLOWED_ORIGINS` (see above) and redeploy the Worker.

The form is then at `https://<project-name>.pages.dev` and The Switch at `https://<project-name>.pages.dev/switch`.

### 7. Point the GHL pages at the new form

Skip this step if the Pages address stayed `https://jacob-orth-form.pages.dev`.

Otherwise, the landing page code in `funnel/FILE 1 - Conversion Landing Page.html` mentions `https://jacob-orth-form.pages.dev` in five places. Replace all five with your new Pages address (find and replace works):

- the iframe `src` (the form itself)
- the "Trouble loading? Open the form in a new tab" link
- the `e.origin` check that resizes the iframe to fit the form. If this one is missed, the form gets cut off.
- two image links used for link previews (`jacob-orth.png`)

Then in GoHighLevel, open the landing page, replace the custom HTML element's code with the updated file, and save and publish.

Either way, finish by sending one test lead through the live form and checking it shows up in the `Leads` pipeline with the right tags. This test creates a real contact, so delete it afterwards.

## Local development

```sh
cp .env.example .env    # uses a mock backend, no real API calls
npm run dev
```

To run the Worker locally, create `worker/.dev.vars` with your own values:

```
GHL_API_TOKEN=pit-...
GEOAPIFY_API_KEY=...
ALLOWED_ORIGINS=http://localhost:3000
```

Then run `npx wrangler dev` from `worker/`. `.dev.vars` is gitignored so it never gets committed. Local runs use the real GHL sub-account, so any test lead you submit creates a real contact.

## Hardcoded GoHighLevel IDs

The location, pipeline, stage, calendar, user, custom field and custom value IDs live at the top of `worker/proxy.js`. They match Jacob's current GHL sub-account. If any of those objects are deleted and recreated in GHL, update the IDs there and redeploy the Worker.
