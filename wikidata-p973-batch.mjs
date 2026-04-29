#!/usr/bin/env node
// Solis Prints Wikidata P973 batch enrichment bot.
//
// For each art-historical Wikidata entity in `candidates.json`, this script
// adds a single Property:P973 ("described at URL") statement pointing to the
// corresponding editorial page on https://www.solisprints.co.uk. P973 is the
// standard Wikidata property for "this entity is also described at the
// following URL" and is the appropriate way to cross-reference a Wikidata
// item to an external descriptive resource that adds value beyond the
// existing Wikipedia article (Wikidata:Property_proposal/described_at_URL).
//
// What gets edited: ONLY the P973 statement is added. No other claims are
// changed. No descriptions, labels, sitelinks, or qualifiers are touched.
// Idempotent — entities already carrying a P973 statement to solisprints.co.uk
// are skipped.
//
// Why each target page warrants a P973 statement:
//   Each /pages/artist-{slug} target carries:
//     • A sourced biographical summary with Schema.org/Citation JSON-LD
//     • A list of museum holdings cross-referenced to Wikidata Q-IDs
//     • Numbered footer citations (Wikipedia, Wikidata, museums, books)
//     • Schema.org/Claim blocks pairing each structured fact with its source
//     • Author + Publisher Organization markup
//   These are reference-quality editorial pages, not commercial product pages.
//   Product / cart pages are at a different URL space (/products/*, /cart) and
//   are explicitly NOT what this script links to.
//
// Authentication options:
//   1. OAuth 1.0a with HMAC-SHA1 signature (preferred, supports propose-only
//      consumers with "Edit existing pages" + "High-volume editing" grants):
//        WIKIMEDIA_CONSUMER_TOKEN, WIKIMEDIA_CONSUMER_SECRET,
//        WIKIMEDIA_ACCESS_TOKEN, WIKIMEDIA_ACCESS_SECRET
//
//   2. Bot password (faster setup; same grants):
//        WIKIDATA_BOT_USERNAME, WIKIDATA_BOT_PASSWORD
//        Create at https://www.wikidata.org/wiki/Special:BotPasswords
//
//   The script auto-detects which is available and prefers OAuth1.
//
// Rate limiting:
//   • 4 seconds between submitEdit calls (Wikidata bot-policy floor for
//     non-flagged accounts)
//   • Read-side probe uses batched wbgetentities (50 IDs per call) so 50
//     candidates = 1 read + N writes.
//
// Operator: Solis Prints (wikidata@solisprints.co.uk)
// Source code: https://github.com/mikeonabike25/solisprints-wikidata-bot
// Licence: MIT

import 'dotenv/config';
import dns from 'dns';
import fs from 'node:fs';
import crypto from 'node:crypto';

// DNS workaround for sinkholed VPN environments
const _origLookup = dns.lookup.bind(dns);
const overrides = new Map();
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (overrides.has(host)) {
    const ip = overrides.get(host);
    if (opts?.all) return process.nextTick(() => cb(null, [{ address: ip, family: 4 }]));
    return process.nextTick(() => cb(null, ip, 4));
  }
  return _origLookup(host, opts, cb);
};

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1] || '50', 10) : 50;
const candidatesIdx = args.indexOf('--candidates');
const CANDIDATES_FILE = candidatesIdx >= 0 ? args[candidatesIdx + 1] : 'candidates.json';
const SOLIS_DOMAIN = 'solisprints.co.uk';
const USER_AGENT = `SolisPrintsWikidataBot/1.0 (https://www.${SOLIS_DOMAIN}; wikidata@${SOLIS_DOMAIN})`;
const SLEEP_BETWEEN_EDITS_MS = 4000; // bot policy floor

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- candidates

function loadCandidates() {
  if (!fs.existsSync(CANDIDATES_FILE)) {
    throw new Error(
      `Candidates file not found: ${CANDIDATES_FILE}\n` +
      `Expected JSON array of { qid, name, pageUrl } objects.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${CANDIDATES_FILE} must be a JSON array`);
  const parsed = raw
    .filter((c) => /^Q\d+$/.test(c?.qid || ''))
    .filter((c) => typeof c?.pageUrl === 'string' && c.pageUrl.includes(SOLIS_DOMAIN))
    .map((c) => ({ qid: c.qid, name: c.name || c.qid, pageUrl: c.pageUrl }));
  return parsed.slice(0, LIMIT);
}

// ---------------------------------------------------------------- existing-claim probe (batched)

async function probeExistingP973Batch(qids) {
  // Batched wbgetentities — up to 50 entities per call. Returns a Map
  // qid → boolean (true if entity already has a P973 to solisprints.co.uk).
  const result = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}&props=claims&format=json&languages=en`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`probe batch: ${res.status}`);
    const j = await res.json();
    for (const qid of batch) {
      const entity = j.entities?.[qid];
      const claims = entity?.claims?.P973 || [];
      const hasOurUrl = claims.some((c) => {
        const v = c?.mainsnak?.datavalue?.value || '';
        return typeof v === 'string' && v.includes(SOLIS_DOMAIN);
      });
      result.set(qid, hasOurUrl);
    }
    await sleep(1100); // throttle reads
  }
  return result;
}

// ---------------------------------------------------------------- OAuth1 signing

function rfc3986(s) {
  return encodeURIComponent(s)
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function oauth1Sign({ method, url, params, consumerSecret, tokenSecret }) {
  const pairs = Object.entries(params)
    .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&');
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret || '')}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildOAuth1Header({ method, url, formParams, consumerKey, consumerSecret, accessToken, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams, ...formParams };
  oauthParams.oauth_signature = oauth1Sign({ method, url, params: allParams, consumerSecret, tokenSecret });
  return 'OAuth ' + Object.entries(oauthParams)
    .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
    .join(', ');
}

function getOAuth1Creds() {
  const ck = process.env.WIKIMEDIA_CONSUMER_TOKEN;
  const cs = process.env.WIKIMEDIA_CONSUMER_SECRET;
  const at = process.env.WIKIMEDIA_ACCESS_TOKEN;
  const ts = process.env.WIKIMEDIA_ACCESS_SECRET;
  if (ck && cs && at && ts) {
    return { mode: 'oauth1', consumerKey: ck, consumerSecret: cs, accessToken: at, tokenSecret: ts };
  }
  return null;
}

// ---------------------------------------------------------------- Bot password fallback

async function botPasswordLogin() {
  if (!process.env.WIKIDATA_BOT_USERNAME || !process.env.WIKIDATA_BOT_PASSWORD) return null;
  const cookieJar = [];
  const merge = (res) => {
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) cookieJar.push(c.split(';')[0]);
  };
  const cookieHeader = () => cookieJar.join('; ');

  const tk = await fetch(
    'https://www.wikidata.org/w/api.php?action=query&meta=tokens&type=login&format=json',
    { headers: { 'User-Agent': USER_AGENT } },
  );
  merge(tk);
  const loginToken = (await tk.json()).query.tokens.logintoken;

  const lg = await fetch('https://www.wikidata.org/w/api.php', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader() },
    body: new URLSearchParams({
      action: 'login',
      lgname: process.env.WIKIDATA_BOT_USERNAME,
      lgpassword: process.env.WIKIDATA_BOT_PASSWORD,
      lgtoken: loginToken,
      format: 'json',
    }),
  });
  merge(lg);
  const lgJson = await lg.json();
  if (lgJson.login?.result !== 'Success') {
    throw new Error(`Bot-password login failed: ${JSON.stringify(lgJson)}`);
  }
  return { mode: 'bot_password', cookieHeader };
}

// ---------------------------------------------------------------- CSRF + edit

async function fetchCsrfToken(authCtx) {
  const url = 'https://www.wikidata.org/w/api.php';
  const formParams = { action: 'query', meta: 'tokens', format: 'json' };
  let headers;
  if (authCtx.mode === 'oauth1') {
    headers = {
      'User-Agent': USER_AGENT,
      'Authorization': buildOAuth1Header({ method: 'GET', url, formParams, ...authCtx }),
    };
  } else {
    headers = {
      'User-Agent': USER_AGENT,
      'Cookie': authCtx.cookieHeader(),
    };
  }
  const qs = new URLSearchParams(formParams).toString();
  const res = await fetch(`${url}?${qs}`, { headers });
  if (!res.ok) throw new Error(`csrf token fetch: ${res.status}`);
  const j = await res.json();
  const tok = j?.query?.tokens?.csrftoken;
  if (!tok || tok === '+\\') throw new Error(`csrf token missing — auth likely failed: ${JSON.stringify(j)}`);
  return tok;
}

async function submitEdit({ qid, pageUrl, csrfToken, authCtx }) {
  const url = 'https://www.wikidata.org/w/api.php';
  const formParams = {
    action: 'wbcreateclaim',
    entity: qid,
    snaktype: 'value',
    property: 'P973',
    value: JSON.stringify(pageUrl),
    summary: `Adding [[Property:P973|described at URL]] → ${pageUrl} (sourced editorial: bio, museum holdings, citations)`,
    format: 'json',
    bot: '1',
    token: csrfToken,
  };
  let headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (authCtx.mode === 'oauth1') {
    headers['Authorization'] = buildOAuth1Header({ method: 'POST', url, formParams, ...authCtx });
  } else {
    headers['Cookie'] = authCtx.cookieHeader();
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(formParams),
  });
  if (!res.ok) throw new Error(`edit ${qid}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------- main

(async () => {
  const candidates = loadCandidates();
  console.log(`${candidates.length} candidates loaded from ${CANDIDATES_FILE}`);

  console.log('\n[1/3] Probing existing P973 claims (batched)...');
  const qids = candidates.map((c) => c.qid);
  const existingMap = await probeExistingP973Batch(qids);
  const todo = candidates.filter((c) => !existingMap.get(c.qid));
  const skipped = candidates.length - todo.length;
  console.log(`  ${todo.length} need P973; ${skipped} already cite ${SOLIS_DOMAIN}`);

  if (!APPLY) {
    fs.writeFileSync('plan.json', JSON.stringify({ todo, skipped, generated_at: new Date().toISOString() }, null, 2));
    console.log('\n[dry-run] Plan saved to plan.json. Set --apply to submit edits.');
    return;
  }

  // Auth
  console.log('\n[2/3] Authenticating...');
  let authCtx = getOAuth1Creds();
  if (authCtx) {
    console.log('  Using OAuth 1.0a (HMAC-SHA1)');
  } else {
    authCtx = await botPasswordLogin();
    if (!authCtx) {
      throw new Error(
        'No credentials found. Set either:\n' +
        '  WIKIMEDIA_CONSUMER_TOKEN/SECRET + WIKIMEDIA_ACCESS_TOKEN/SECRET (OAuth1), OR\n' +
        '  WIKIDATA_BOT_USERNAME + WIKIDATA_BOT_PASSWORD (bot password)',
      );
    }
    console.log('  Using bot password');
  }
  const csrfToken = await fetchCsrfToken(authCtx);
  console.log(`  CSRF token acquired (length=${csrfToken.length}).`);

  // Submit
  console.log(`\n[3/3] Submitting ${todo.length} edits at ${SLEEP_BETWEEN_EDITS_MS/1000}s/edit...`);
  let submitted = 0; let failed = 0;
  const log = [];
  for (const c of todo) {
    try {
      const result = await submitEdit({ qid: c.qid, pageUrl: c.pageUrl, csrfToken, authCtx });
      if (result.error) {
        console.log(`  ✗ ${c.qid} (${c.name}): ${result.error.code} — ${result.error.info}`);
        log.push({ qid: c.qid, name: c.name, status: 'error', error: result.error });
        failed++;
      } else {
        console.log(`  ✓ ${c.qid} ${c.name} → P973 ${c.pageUrl}`);
        log.push({ qid: c.qid, name: c.name, status: 'submitted', revision: result.pageinfo?.lastrevid });
        submitted++;
      }
    } catch (e) {
      console.log(`  ✗ ${c.qid}: ${e.message}`);
      log.push({ qid: c.qid, name: c.name, status: 'error', error: e.message });
      failed++;
    }
    await sleep(SLEEP_BETWEEN_EDITS_MS);
  }

  fs.writeFileSync(`run-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`,
    JSON.stringify({ submitted, failed, log }, null, 2));
  console.log(`\nDone. ${submitted} submitted, ${failed} failed.`);
})().catch((e) => { console.error(e); process.exit(1); });
