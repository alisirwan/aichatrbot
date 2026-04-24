---
name: GORE Chatbot — Deployment Guide
description: 5-minute Vercel deploy guide for the Gore Gemini chatbot
type: deployment-guide
updated: 2026-04-24
owner: Ali
---

# GORE Chatbot — Deploy to Vercel

> **Total time: ~5 minutes.** Two minutes of prep, two minutes to deploy, thirty seconds to verify.
>
> After you finish, reply to Jarvis with your Vercel URL. Coda will embed the widget on the Gore theme. You do not touch the theme.

---

## Section A — Prerequisites (2 min)

You need three things before deploying. Collect them first, then deploy in one pass.

### A1. Shopify Storefront access token

This is a **public, read-only** token. It lets the chatbot read the product catalog. It cannot edit orders, customers, or anything else.

Exact click path in Shopify admin:

1. Open the Gore Shopify admin → **Settings** (bottom-left gear icon)
2. Click **Apps and sales channels**
3. Click **Develop apps** (top-right). If prompted, click **Allow custom app development**
4. Click **Create an app**
   - App name: `Gore Chatbot`
   - App developer: your email
5. On the new app screen → **Configuration** tab
6. Under **Storefront API integration** click **Configure**
7. Check these scopes (ONLY these two — nothing else):
   - `unauthenticated_read_product_listings`
   - `unauthenticated_read_product_inventory`
8. Click **Save**
9. Go to the **API credentials** tab
10. Click **Install app** (top-right)
11. Under **Storefront API access token** click **Reveal token once** and copy it

The token starts with `shpss_...` or `shpat_...`. Paste it somewhere safe — you cannot see it again after leaving this page.

### A2. Google Gemini API key

You already have this. If you need to check:
- https://aistudio.google.com/app/apikey
- Copy the key (long string, no obvious prefix)

### A3. Vercel account

Free tier is fine. Gore will not come close to the free-tier limits in year one.
- Sign up: https://vercel.com/signup
- Sign in with GitHub, GitLab, or email — any is fine

---

## Section B — Deploy to Vercel (2 min)

Pick **one** of the two options below. Dashboard is easier if you have never used Vercel. CLI is faster if you already have it installed.

### Option 1 — Dashboard deploy (no terminal needed)

1. Go to **https://vercel.com/new**
2. Scroll down to **Clone Template** / **Import Git Repository**. We are not cloning a repo — instead, click **Browse** or drag the folder.
   - **Easiest path:** zip the `2026-04-23-gore-gemini-chatbot/` folder on your computer, then drag the zip onto the Vercel import page. Vercel accepts a zipped folder via the "Import" tile.
   - **Alt path:** push the folder to a fresh GitHub repo (private is fine), then click "Import Git Repository" and point Vercel at it.
3. On the configure screen:
   - **Project Name:** `gore-chatbot`
   - **Framework Preset:** `Other`
   - **Root Directory:** leave as `./`
   - **Build & Output Settings:** leave all defaults (no build command, no output dir)
4. Expand **Environment Variables** and add all four from `.env.example`:

   | Name                       | Value                                           |
   |----------------------------|-------------------------------------------------|
   | `GEMINI_API_KEY`           | (paste your Gemini key from A2)                 |
   | `SHOPIFY_STORE_DOMAIN`     | `goreattachments.myshopify.com`                 |
   | `SHOPIFY_STOREFRONT_TOKEN` | (paste the `shpss_...` token from A1)           |
   | `CORS_ORIGIN`              | `https://goreengineering.com`                   |

   Leave all four scoped to **Production, Preview, Development** (default).

5. Click **Deploy**. Wait ~60 seconds.
6. When the confetti fires, copy the production URL at the top. It looks like:
   `https://gore-chatbot-abc123.vercel.app`

### Option 2 — CLI deploy (faster if you have the Vercel CLI already)

```bash
# First time only — install the CLI globally
npm install -g vercel

# Change into the project folder
cd "/c/Users/alisi/OneDrive/Desktop/PKM/deliverables/shopify/2026-04-23-gore-gemini-chatbot"

# Link & deploy (answers: Set up and deploy → Y, scope → your account, link to existing → N,
# project name → gore-chatbot, directory → ./, override settings → N)
vercel

# Add the four environment variables (CLI will prompt for the value each time; paste and Enter)
vercel env add GEMINI_API_KEY production
vercel env add SHOPIFY_STORE_DOMAIN production
vercel env add SHOPIFY_STOREFRONT_TOKEN production
vercel env add CORS_ORIGIN production

# Promote to production with the new env vars
vercel --prod
```

Copy the final `https://gore-chatbot-...vercel.app` URL printed at the end.

---

## Section C — Verify the endpoint (30 seconds)

Run this `curl` in any terminal (Git Bash, Windows Terminal, macOS Terminal — all work). Replace `YOUR-VERCEL-URL` with the URL from Section B.

```bash
curl -N -X POST https://YOUR-VERCEL-URL/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hej, har ni jordborrar på lager?","history":[]}'
```

**Expected output — a stream of Server-Sent Events like this:**

```
event: token
data: {"text":"Ja"}

event: token
data: {"text":", vi har"}

event: token
data: {"text":" jordborrar..."}

event: done
data: {"ok":true}
```

The `-N` flag disables curl's output buffering so you see tokens appear live. If it streams Swedish text and ends with `event: done`, the endpoint is healthy. Ship it.

### If something goes wrong

| Error you see                                  | Likely cause                                  | Fix                                                                                         |
|------------------------------------------------|-----------------------------------------------|---------------------------------------------------------------------------------------------|
| `{"error":"Server not configured"}`            | `GEMINI_API_KEY` is missing or misspelled     | Vercel → Project → Settings → Environment Variables. Confirm the name is EXACTLY `GEMINI_API_KEY`. Redeploy after fixing. |
| `{"error":"Upstream error"}` or generic 502    | Gemini key invalid, or quota exhausted        | Test the key in https://aistudio.google.com first. Regenerate if needed.                    |
| Response works but says "Produktkatalog just nu ej tillgänglig" | Storefront token wrong or scopes missing      | Recheck A1 scopes. Must be `unauthenticated_read_product_listings` + `unauthenticated_read_product_inventory`. Regenerate token. |
| `CORS` error when the widget loads later       | `CORS_ORIGIN` does not match the live domain   | Set to exactly `https://goreengineering.com` (no trailing slash, no www unless your store uses www). Redeploy. |
| `{"error":"Too many requests..."}`             | You hit the 10-req/min rate limit during testing | Wait 60 seconds.                                                                            |

To redeploy after changing env vars: Vercel dashboard → Deployments → latest → three-dot menu → **Redeploy**. Or CLI: `vercel --prod`.

---

## Section D — What happens next

Once Section C passes, you are done with the deploy.

**Reply to Jarvis with your Vercel production URL.** Example:

> "Deployed. URL is https://gore-chatbot-abc123.vercel.app — curl test streamed Swedish tokens."

Jarvis will dispatch Coda in one shot. Coda will:

1. Upload `widget/chat-widget.js` and `widget/chat-widget.css` to the Gore theme `assets/` folder
2. Place `widget/chat-widget.liquid` in the theme `snippets/` folder
3. Add `{% render 'chat-widget' %}` before `</body>` in `layout/theme.liquid`
4. Set `window.GORE_CHAT_ENDPOINT = 'https://YOUR-VERCEL-URL/api/chat'` in the liquid snippet so the widget calls your Vercel function
5. Publish to the live theme after Sly screenshots a preview

You do nothing in the theme. That is Coda's dispatch.

---

## Section E — Expected costs

### Gemini 2.5 Flash (Google)

Current Gemini 2.5 Flash pricing (paid tier, as of April 2026):

- Input: ~$0.30 per 1M tokens
- Output: ~$2.50 per 1M tokens

Per average Gore conversation (full ~226-product catalog injected, v2):

| Component                         | Tokens (avg) | Cost          |
|-----------------------------------|--------------|---------------|
| System prompt + catalog (cached)  | ~12,000 in   | $0.0036       |
| User history + new message        | ~200 in      | $0.00006      |
| Bot response                      | ~300 out     | $0.00075      |
| **Per conversation**              |              | **~$0.0044**  |

Scaled:

| Volume             | Cost             |
|--------------------|------------------|
| 1,000 conversations | ~$1.40          |
| 10,000 conversations | ~$14           |
| 100,000 conversations | ~$140         |

Gore's realistic year-one volume is a few hundred to a few thousand conversations. Expect under **$5/month** in Gemini cost.

### Vercel Edge Functions

- **Free tier (Hobby plan):** 100,000 invocations/month + 100 GB-hours compute
- Each chat conversation = ~5–10 Edge invocations (one per message in the thread)
- Gore would need ~10,000 conversations/month to approach the free-tier ceiling

Expected Vercel cost for Gore year one: **$0**.

### Shopify Storefront API

- Free for the scopes used
- Rate-limited generously (we cache the product list for 15 minutes inside the Edge function, so effective call volume is ~4/hour regardless of chat traffic)

### Total operating cost estimate

| Monthly volume       | Gemini   | Vercel | Shopify | Total       |
|----------------------|----------|--------|---------|-------------|
| 500 conversations    | $2.20    | $0     | $0      | **~$2/mo**  |
| 2,000 conversations  | $8.80    | $0     | $0      | **~$9/mo**  |
| 10,000 conversations | $44      | $0     | $0      | **~$44/mo** |

If traffic explodes past 10k/month we will revisit — at that volume, the chatbot is driving real revenue and a $15/mo bill is noise.

---

## Files in this deployment

| File                       | Purpose                                                                |
|----------------------------|------------------------------------------------------------------------|
| `api/chat.js`              | Edge function — handles POST /api/chat, streams Gemini SSE             |
| `system-prompt.md`         | Reference copy of the system prompt baked into `chat.js`               |
| `widget/chat-widget.js`    | Client widget — deployed to Shopify theme by Coda                      |
| `widget/chat-widget.css`   | Widget styles — deployed to Shopify theme by Coda                      |
| `widget/chat-widget.liquid`| Theme snippet — deployed to Shopify theme by Coda                      |
| `package.json`             | Minimal Node manifest (ESM enabled for the Edge function)              |
| `vercel.json`              | Forces `api/chat.js` to the Edge runtime + rewrites `/api/chat`        |
| `.env.example`             | Template env file — copy to Vercel, do NOT commit real values          |
| `.gitignore`               | Standard Node + Vercel ignores                                         |
| `DEPLOY.md`                | This file                                                              |

---

## Security notes

- The only secret in this system is `GEMINI_API_KEY` and `SHOPIFY_STOREFRONT_TOKEN`. Both live ONLY in Vercel env vars — never in the repo, never in the widget code (the widget calls your Vercel URL, not Google/Shopify directly).
- The Storefront token is scoped to read-only product listings. If it leaked, an attacker could read the public Gore catalog — which is already public on goreengineering.com. No customer data, no orders, no write access.
- The Edge function rate-limits to 10 requests/minute per IP and caps message length at 2,000 chars — basic abuse defence.
- `CORS_ORIGIN` locks the function so only `goreengineering.com` can call it from a browser. Direct curl still works (no browser enforces CORS), but malicious sites embedding the widget cannot hit your function.
