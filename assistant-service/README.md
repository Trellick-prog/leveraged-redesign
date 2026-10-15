# Leveraged assistant – AI service

The chat button on every page works without this service: it answers from the
site's knowledge base (`assistant/kb.json`) in the visitor's browser. Deploying
this service adds two things:

1. **Natural-language answers from Claude**, limited strictly to the knowledge
   base. The model is told to answer only from it, never to give personal advice,
   and to report when it can't answer (`answered: false`).
2. **A central question log** for every visitor, which you review at
   `<service URL>/review`. Your browser asks for a login: leave the username
   blank (or type anything) and enter the `REVIEW_TOKEN` as the password.

The Anthropic API key lives only in this service. It is never sent to the browser.

## Deploy (Cloudflare Workers, about 10 minutes)

You need a Cloudflare account and an Anthropic API key (console.anthropic.com).

```bash
cd assistant-service
npm install
npx wrangler login
npx wrangler kv namespace create LOGS        # copy the id into wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY    # paste your key
npx wrangler secret put REVIEW_TOKEN         # any long random string, for the review page
npx wrangler deploy                          # prints the service URL
```

Then switch the site over by putting the service URL in `assistant/config.json`:

```json
{ "endpoint": "https://leveraged-assistant.<your-subdomain>.workers.dev" }
```

Push to `main`. If the service is ever unavailable, the widget falls back to
the local knowledge base automatically.

## Settings

| Setting | Where | Notes |
|---|---|---|
| `ALLOWED_ORIGIN` | `wrangler.toml` | Only this site can call the service. |
| `KB_URL` | `wrangler.toml` | Where the knowledge base is read from (cached 10 minutes). |
| Model | `src/index.js` (`MODEL`) | `claude-opus-5-5`, effort `low` for short chat answers, with server-side refusal fallback enabled. |
| Log retention | `src/index.js` (`saveLog`) | 12 months. Questions are redacted (numbers and emails removed) before storage. |

## Keeping the knowledge correct

1. Review gaps at `<service URL>/review` and download them as a Markdown table.
2. Confirm the right answer against the PDS, form or policy it comes from.
3. Add or update entries in `tools/kb-curated.json` (or the FAQ or forms pages).
4. Run `python3 tools/build_kb.py` and push. The service picks up the change within 10 minutes.

## Before going live

- Have compliance review the assistant's rules (`RULES` in `src/index.js`) and the
  disclaimer shown under the chat box.
- Add a Cloudflare rate-limiting rule on `/chat` to control cost and abuse.
- Update the privacy policy to mention that questions asked in the assistant are stored for up to 12 months.
