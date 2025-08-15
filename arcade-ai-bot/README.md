# Arcade AI Customer Service Bot (Zendesk-ready)

This service answers customer questions using OpenAI, with optional retrieval from your public website content. It exposes an HTTP endpoint you can connect to Zendesk Messaging (Flow Builder "Call an API" step) to reply instantly in the web chat.

## Features
- RAG: One-command ingestion from `https://www.arcade.ai/` (or any site) to build a local vector index
- Answer endpoint: `POST /bot/answer { question } -> { reply, sources }`
- Health endpoint: `GET /health`
- Simple test endpoint: `GET /test?q=...`

## Setup
1. Requirements: Node.js 18+
2. Install deps:
```
npm install
```
3. Configure env:
```
cp .env.example .env
# edit .env and set OPENAI_API_KEY
```
4. (Optional) Ingest content from your website to improve answer accuracy:
```
# Default: https://www.arcade.ai, limit 40 URLs
npm run ingest

# Custom site or limits
npm run ingest -- --site=https://www.arcade.ai --limit=60
```
5. Start the server:
```
npm start
```
Server listens on `http://localhost:8787`.

## API
- POST `/bot/answer`
  - Request: `{ "question": "string" }`
  - Response: `{ "reply": "string", "sources": [{ "title": string, "url": string }] }`

- GET `/test?q=...` quick manual test in a browser

## Connect to Zendesk Messaging (Flow Builder)
If your site uses Zendesk Messaging (the modern web widget):

1. In Admin Center > Channels > Messaging > Bots, open your bot in Flow Builder.
2. Add a step "Call an API" (or "Make API call").
3. Method: POST. URL: `https://YOUR_PUBLIC_URL/bot/answer`
4. Headers: `Content-Type: application/json`
5. Body: `{ "question": "{{last_user_message}}" }`
6. Map response: Set bot message to the JSON field `reply`.
7. Publish the bot.

Notes:
- Host this service publicly (e.g., Fly.io, Render, Heroku, Vercel [Node server], AWS) and use HTTPS.
- Add guardrails in Flow Builder to transfer to an agent when the bot cannot answer.

## Alternative: Sunshine Conversations webhook (advanced)
If you need full control over conversations, connect via Sunshine Conversations webhooks and send messages via their API. This codebase includes only the `/bot/answer` API for simplicity. Add a webhook handler that:
- Receives `message:appUser`
- Calls `POST /bot/answer`
- Replies using `messages` API as `appMaker`

Refer to Sunshine Conversations docs for authentication and message format.

## Quality & Safety Tips
- Keep ingestion limited to official product pages and docs to avoid the model using stale or unofficial info.
- Set a low temperature for accuracy.
- Include source links in answers (already done) so users can verify.
- Always provide a transfer-to-human fallback in the flow.

## Local testing
```
# After starting the server
curl -s -X POST http://localhost:8787/bot/answer \
  -H 'Content-Type: application/json' \
  -d '{"question":"What does Arcade do?"}' | jq
```