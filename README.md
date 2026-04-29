# Solis Prints Wikidata P973 batch bot

A small Node.js script that adds [Property:P973](https://www.wikidata.org/wiki/Property:P973) ("described at URL") statements to Wikidata art-historical entities, linking them to corresponding sourced editorial pages on [solisprints.co.uk](https://www.solisprints.co.uk).

## What it does (and what it deliberately does NOT do)

For each candidate Wikidata Q-ID provided in `candidates.json`, the bot:

1. **Probes** the entity (batched `wbgetentities`) to check whether a P973 statement already points to `solisprints.co.uk`. If so, the entity is **skipped**.
2. If no existing P973 → solisprints.co.uk: submits a single `wbcreateclaim` with `property=P973` and the target editorial URL.

**Nothing else is touched.** No descriptions, labels, sitelinks, qualifiers, references, or other claims are changed. The bot is single-purpose and idempotent.

## Why P973, why solisprints.co.uk

Wikidata's P973 ("described at URL") is the standard property for cross-referencing an entity to an external descriptive resource that adds value beyond the existing Wikipedia article ([property documentation](https://www.wikidata.org/wiki/Property:P973)).

The target pages are reference-quality editorial: each `/pages/artist-{slug}` carries:

- A sourced biographical summary with [Schema.org/Citation](https://schema.org/Citation) JSON-LD
- A list of museum holdings cross-referenced to Wikidata Q-IDs
- A numbered footer with verifiable book + Wikipedia + Wikidata + museum-website citations
- [Schema.org/Claim](https://schema.org/Claim) blocks pairing each structured fact with its source
- `Author` + `Publisher` Organization markup

These are editorial reference pages, not commercial product pages. The product / cart pages live at a separate URL space (`/products/*`, `/cart`) and are explicitly NOT what this bot links to.

## Authentication

The bot supports two paths:

### OAuth 1.0a (recommended)

Required grants on the consumer registration:
- **Edit existing pages** (`editpage`) — required for `wbcreateclaim`
- **High-volume editing** (`highvolume`) — recommended for batches of 50+

Set env vars:
```
WIKIMEDIA_CONSUMER_TOKEN=...
WIKIMEDIA_CONSUMER_SECRET=...
WIKIMEDIA_ACCESS_TOKEN=...
WIKIMEDIA_ACCESS_SECRET=...
```

### Bot password (faster setup)

Create at [Special:BotPasswords](https://www.wikidata.org/wiki/Special:BotPasswords) on a logged-in Wikidata account that's already autoconfirmed (4 days old + 50 edits). Grant the same two scopes.

```
WIKIDATA_BOT_USERNAME=YourMainAccount@your-bot-name
WIKIDATA_BOT_PASSWORD=...
```

## Usage

```bash
# 1. Install
npm install

# 2. Set credentials
cp .env.example .env
# … edit .env …

# 3. Prepare candidates
cp candidates.example.json candidates.json
# … edit candidates.json with real Q-IDs and target URLs …

# 4. Dry-run (default — no writes)
node wikidata-p973-batch.mjs
# Outputs plan.json with the entities that would be edited

# 5. Apply
node wikidata-p973-batch.mjs --apply

# Optional flags:
node wikidata-p973-batch.mjs --apply --limit 5     # safety cap
node wikidata-p973-batch.mjs --candidates other.json
```

## Rate limits + etiquette

- **4 seconds between edits** (Wikidata bot-policy floor for non-flagged accounts)
- **Probe reads are batched** at 50 Q-IDs per request, 1.1s sleep between batches
- For 50 candidates: ~3.5 minutes total
- We do NOT request a [bot flag](https://www.wikidata.org/wiki/Wikidata:Requests_for_permissions/Bot) because volume is well under the 50-edits/day threshold (typical batch is <300 edits/year)
- Edit summary explicitly references P973 + the target URL so patrollers can verify in one click
- `bot=1` parameter set on every edit so MediaWiki tags the edit appropriately
- We monitor for reverts and **halt + escalate to Project Chat** rather than re-attempting

## Recommended cautious rollout

For first deployment with a fresh consumer/account:

1. Run with `--apply --limit 4` first (4 high-quality featured entities)
2. Wait 24–48 hours
3. Spot-check the edits at the entity history pages — if any were reverted, read the talk page and respond there before continuing
4. If clean, run remaining `--apply` for the rest of the batch

## File structure

```
.
├── wikidata-p973-batch.mjs   # the script — fully auditable single file
├── candidates.example.json    # example input format
├── package.json
├── .env.example
├── README.md (this file)
└── LICENSE (MIT)
```

## Operator

- **Site**: https://www.solisprints.co.uk
- **Contact**: sysop@solisprints.co.uk
- **Source code**: this repository
- **Licence**: MIT (see LICENSE)

## What gets written — example edit

For Q5593 (Pablo Picasso), the bot would submit:

```
action=wbcreateclaim
entity=Q5593
snaktype=value
property=P973
value="https://www.solisprints.co.uk/pages/artist-pablo-picasso"
summary=Adding [[Property:P973|described at URL]] → https://www.solisprints.co.uk/pages/artist-pablo-picasso (sourced editorial: bio, museum holdings, citations)
bot=1
```

Resulting in a single new statement on Q5593:

> described at URL: https://www.solisprints.co.uk/pages/artist-pablo-picasso

…and the entity history records the edit with the summary above.

That's the entire scope.
