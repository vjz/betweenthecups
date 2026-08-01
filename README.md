# BetweenTheCups

The best football to watch until the next World Cup.

BetweenTheCups is a fast, static daily watch guide for casual football fans who
miss the World Cup. It highlights matches worth watching because they feature
high-profile World Cup stars, rising 2026 names, or true marquee club matchups.

The product is intentionally CLI-first: curated player data goes in, public
fixture data is fetched offline, ranked JSON is generated, and Astro renders a
static one-page site.

## Current MVP

- Astro 7, Tailwind CSS, TypeScript
- Static JSON, no database
- Public ESPN soccer scoreboard fixtures, no API key
- Curated top-25 player list
- Team alias matching with strict normalized equality
- Light, mobile-first UI
- Tabs for:
  - Today
  - This Week
  - This Month
  - Next 6 Months, top 10

## Local Setup

```bash
npm install
npm run btc -- validate
npm run btc -- build-day --date today
npm run dev
```

Open:

```text
http://localhost:4321/
```

For LAN testing:

```bash
npm run dev -- --host 0.0.0.0 --port 4321
```

## CLI

```bash
npm run btc -- validate
npm run btc -- teams
npm run btc -- fixtures --date today
npm run btc -- range --date today --days 30
npm run btc -- build-day --date today
```

`build-day` currently fetches a 180-day fixture range and writes:

```text
data/generated/latest.json
```

It contains precomputed sections for today, week, month, and the next six
months. The browser does not fetch live fixture data.

## Data Flow

```text
data/curated/stars.json
  -> data/curated/teams.json
  -> data/curated/fixture-sources.json
  -> scripts/btc.ts
  -> data/generated/latest.json
  -> src/pages/index.astro
```

Fixture cache files are written under:

```text
data/cache/fixtures/
```

That folder is ignored by git.

## Ranking Notes

The score favors:

- elite tracked player tier
- multiple tracked stars
- competition quality
- matches with tracked stars on both sides

One-sided matches are capped so ordinary fixtures cannot become 5-star watches
just because Real Madrid, Barcelona, or another star-heavy team is involved.

## Deployment

Cloudflare Pages settings:

```text
Framework preset: Astro
Build command: npm run build
Build output directory: dist
Node version: 24
```

Daily refresh should run before the US morning viewing window:

```bash
npm ci
npm run btc -- build-day --date today
npm run build
```

Then deploy the static `dist/` output.

## Before Public Launch

- Add a footer data note: fixture/broadcast data comes from public sources; check listings.
- Verify `status: verify` players and teams in curated JSON.
- Add 10-25 more players after the MVP proves useful.
- Add a GitHub Action for daily generation.
- Connect the GitHub repo to Cloudflare Pages.
