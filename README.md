# Sovereign Relay Atlas

Single-page HTML app for Sovereign Engineering's coding exercise.

## What it does

- Queries multiple Nostr relays directly over WebSocket
- Fetches `kind:30023` long-form events
- Dedupe + sorts the combined feed and keeps the latest 21 articles
- Extracts hashtags from `t` tags and shows counts
- Filters the feed with `AND` / `OR` logic
- Fetches author metadata from `kind:0` events to display name and picture
- Opens the full article reader when you click a note card
- Makes in-app text affordances clickable, including relay/hashtag jump links and article tag filters
- Lets you add, edit, remove, and persist the relay set locally

## Local run

From this directory:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Tests

Install dependencies once:

```bash
npm install
```

Run the Playwright suite:

```bash
npm test
```

## Publish

Because this is a static app, it can be published directly to:

- GitHub Pages
- Netlify
- Vercel static hosting

No build step is required.
