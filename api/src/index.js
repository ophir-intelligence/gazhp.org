/* =============================================================================
   GAZHP payments API — Cloudflare Worker
   -----------------------------------------------------------------------------
   Public:
     GET  /config                     tiers + which gateways are switched on
     POST /checkout                   start a Stripe / PayPal / DPO Pay payment
     POST /notify                     donor reports an offline payment (Zelle, bank…)
     POST /contact                    contact form { name, email, subject, message, website }
     GET  /paypal/return | /paypal/cancel
     GET  /dpo/return
   Webhooks (gateways → us):
     POST /webhooks/stripe | /webhooks/paypal | /webhooks/dpo
   Scheduled (cron, every 15 minutes):
     - re-checks unsettled DPO Pay payments, e.g. mobile money approved on the
       donor's phone after they left the page;
     - captures PayPal orders the donor approved but never returned from;
     - deletes expired rate-limit counters.
   Admin (Bearer token from /admin/login):
     POST   /admin/login
     GET    /admin/payments
     POST   /admin/payments           { records: [...] }  manual entry / CSV import
     PATCH  /admin/payments/:id       { status, type, tier, notes, … }
     DELETE /admin/payments/:id
     GET    /admin/messages           contact-form messages
     PATCH  /admin/messages/:id       { status: new | read | archived }
     DELETE /admin/messages/:id
   Abuse protection: per-IP rate limits on the public POST routes (RATE_LIMITS
   below), counted in the D1 table rate_limits. No paid Cloudflare feature needed.
   ============================================================================= */
import { TIERS, DONATION, OFFLINE_METHODS } from './config.js';

const enc = new TextEncoder();
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
const isoAgo = ms => new Date(Date.now() - ms).toISOString();

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledJobs(env, ctx));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx, url);
      if (!Object.keys(cors).length) return res;
      // Some responses (e.g. Response.redirect) have immutable headers — copy before adding CORS.
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, { ...cors, ...err.headers });
      console.error(err && err.stack || err);
      return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
    }
  },
};

/* Per-IP limits for the public POST routes: [max requests, per window in seconds].
   Carrier-grade NAT puts many Zambian mobile users behind one IP, so the payment
   limits stay generous; the login and contact limits are tighter. */
const RATE_LIMITS = {
  '/checkout': [20, 60],
  '/notify': [10, 600],
  '/contact': [5, 600],
  '/admin/login': [10, 900],
};

async function route(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (m === 'GET' && (p === '/' || p === '/health')) return json({ ok: true });
  if (m === 'GET' && p === '/config') return json(publicConfig(env));
  if (m === 'POST' && RATE_LIMITS[p]) await rateLimit(request, env, p);
  if (m === 'POST' && p === '/checkout') return checkout(request, env, url);
  if (m === 'POST' && p === '/notify') return notify(request, env, ctx);
  if (m === 'POST' && p === '/contact') return contact(request, env, ctx);

  if (m === 'GET' && p === '/paypal/return') return paypalReturn(env, ctx, url);
  if (m === 'GET' && p === '/paypal/cancel') return Response.redirect(cancelUrl(env, url.searchParams.get('purpose')), 302);
  if (m === 'GET' && p === '/dpo/return') return dpoReturn(env, ctx, url);

  if (m === 'POST' && p === '/webhooks/stripe') return stripeWebhook(request, env, ctx);
  if (m === 'POST' && p === '/webhooks/paypal') return paypalWebhook(request, env, ctx);
  if (m === 'POST' && p === '/webhooks/dpo') return dpoWebhook(request, env, ctx);

  if (m === 'POST' && p === '/admin/login') return adminLogin(request, env);
  if (p.startsWith('/admin/')) {
    await requireAdmin(request, env);
    if (m === 'GET' && p === '/admin/payments') return adminList(env);
    if (m === 'POST' && p === '/admin/payments') return adminAdd(request, env);
    const idMatch = p.match(/^\/admin\/payments\/([\w-]+)$/);
    if (idMatch && m === 'PATCH') return adminUpdate(request, env, idMatch[1]);
    if (idMatch && m === 'DELETE') return adminDelete(env, idMatch[1]);
    if (m === 'GET' && p === '/admin/messages') return adminMessages(env);
    const msgMatch = p.match(/^\/admin\/messages\/([\w-]+)$/);
    if (msgMatch && m === 'PATCH') return adminMessageUpdate(request, env, msgMatch[1]);
    if (msgMatch && m === 'DELETE') return adminMessageDelete(env, msgMatch[1]);
  }
  throw new HttpError(404, 'Not found');
}

/* =============================================================================
   Helpers
   ============================================================================= */
class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
async function readJson(request, maxBytes = 20000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large');
  let data;
  try { data = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; // null / arrays / numbers → {}
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const oneLine = (v, max = 200) => str(String(v ?? '').replace(/\s+/g, ' '), max);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const today = () => new Date().toISOString().slice(0, 10);
const isoDate = v => {
  if (v == null || v === '') return today();
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  return isNaN(d) ? today() : d.toISOString().slice(0, 10);
};
const siteUrl = env => (env.SITE_URL || '').replace(/\/+$/, '');
const cancelUrl = (env, purpose) => `${siteUrl(env)}/${purpose === 'membership' ? 'join' : 'donate'}/?cancelled=1`;
const thanksUrl = (env, gw, purpose, status = 'paid') => `${siteUrl(env)}/thank-you/?gw=${gw}&purpose=${purpose === 'membership' ? 'membership' : 'donation'}&status=${status}`;
const tierById = id => TIERS.find(t => t.id === id);
const tierName = t => t ? `${t.name} — ${t.region}` : '';
const GATEWAYS = ['stripe', 'paypal', 'dpo'];
const gatewaysOn = env => ({
  stripe: !!env.STRIPE_SECRET_KEY,
  paypal: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
  dpo: !!(env.DPO_COMPANY_TOKEN && env.DPO_SERVICE_TYPE),
});
const zmwPerUsd = env => parseFloat(env.ZMW_PER_USD) || 0;

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

/* Fixed-window rate limit kept in D1 (table rate_limits, see schema.sql).
   One atomic upsert per request. Only a keyed hash of the IP is stored, never
   the IP itself, and the cron job deletes counters once their window is over.
   If the table is missing or D1 hiccups, the request is let through (logged):
   a donation should never fail because of the limiter. */
async function rateLimit(request, env, path) {
  const [max, seconds] = RATE_LIMITS[path];
  const windowMs = seconds * 1000;
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  let hits = 0;
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const who = (await hmacHex(env.ADMIN_PASSWORD || 'gazhp-rate-limit', `rate-limit|${ip}`)).slice(0, 32);
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET hits = hits + 1
       RETURNING hits`).bind(`${path}|${who}|${start}`, start + windowMs).first();
    hits = (row && row.hits) || 0;
  } catch (err) {
    console.error('rate limit unavailable', err);
    return;
  }
  if (hits > max) {
    const wait = Math.max(1, Math.ceil((start + windowMs - Date.now()) / 1000));
    throw new HttpError(429, `Too many attempts. Please wait ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : 'a minute'} and try again.`, { 'retry-after': String(wait) });
  }
}
async function cleanupRateLimits(env, ctx, budget) {
  budget.left -= 1;
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Date.now()).run();
}
async function recentCount(env, sql, ms) {
  const row = await env.DB.prepare(sql).bind(isoAgo(ms)).first();
  return (row && row.n) || 0;
}

/* =============================================================================
   Database
   ============================================================================= */
const PAY_COLS = ['id', 'dedupe_key', 'created_at', 'date', 'status', 'type', 'tier', 'amount', 'currency', 'method', 'ref', 'recurring', 'name', 'email', 'phone', 'country', 'profession', 'notes', 'source'];

function paymentRow(p) {
  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    date: p.date || today(),
    status: p.status || 'paid',
    type: p.type === 'membership' ? 'membership' : 'donation',
    tier: p.type === 'membership' ? (p.tier || '') : '',
    amount: Math.round(Number(p.amount) * 100) / 100,
    currency: str(p.currency || 'USD', 3).toUpperCase(),
    method: str(p.method || 'Other', 60),
    ref: str(p.ref, 120),
    recurring: str(p.recurring || 'once', 10),
    name: str(p.name, 120), email: str(p.email, 160).toLowerCase(), phone: str(p.phone, 40),
    country: str(p.country, 80), profession: str(p.profession, 160), notes: str(p.notes, 1000),
    source: p.source,
  };
  row.dedupe_key = p.dedupe_key || (row.ref ? `${row.source}|${row.ref}`.toLowerCase() : crypto.randomUUID());
  return row;
}

/* Saves a payment in one atomic batch: insert it if it's new, otherwise update
   only its status. Webhooks are retried and can arrive out of order, so:
   a refund is final, and a late or repeated 'pending'/'failed' event never
   undoes a confirmed payment. (Admins can still change any status in the
   dashboard.) Returns isNew so callers alert exactly once per payment. */
async function savePayment(env, p) {
  const row = paymentRow(p);
  const [ins] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO payments (${PAY_COLS.join(',')}) VALUES (${PAY_COLS.map(() => '?').join(',')})`)
      .bind(...PAY_COLS.map(c => row[c])),
    env.DB.prepare(
      `UPDATE payments SET status = CASE
         WHEN status = 'refunded' THEN 'refunded'
         WHEN status = 'paid' AND ? IN ('pending', 'failed') THEN 'paid'
         ELSE ? END
       WHERE dedupe_key = ?`).bind(row.status, row.status, row.dedupe_key),
  ]);
  return { row, isNew: !!(ins && ins.meta && ins.meta.changes) };
}
async function recordPayment(env, ctx, p) {
  // Alert once, when a payment first becomes paid — new and paid, or pending (e.g. US bank) → paid.
  const key = paymentRow(p).dedupe_key;
  const prev = p.ref ? await env.DB.prepare('SELECT status FROM payments WHERE dedupe_key = ?').bind(key).first() : null;
  const { isNew } = await savePayment(env, p);
  if (p.status === 'paid' && (isNew || (prev && prev.status !== 'paid' && prev.status !== 'refunded'))) {
    const t = tierById(p.tier);
    alertAdmin(env, ctx, `New ${p.type === 'membership' ? 'membership' : 'donation'}: ${p.currency} ${Number(p.amount).toFixed(2)} via ${p.method}`,
      [`Name: ${p.name || '—'}`, `Email: ${p.email || '—'}`, t ? `Tier: ${tierName(t)}` : '', `Reference: ${p.ref || '—'}`].filter(Boolean).join('\n'));
  }
}
async function setStatusByRef(env, source, refs, status) {
  refs = refs.filter(Boolean);
  if (!refs.length) return;
  await env.DB.prepare(`UPDATE payments SET status = ? WHERE source = ? AND ref IN (${refs.map(() => '?').join(',')})`)
    .bind(status, source, ...refs).run();
}
async function getCheckout(env, id) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM checkouts WHERE id = ?').bind(id).first();
}
async function checkoutByRef(env, gateway, ref) {
  ref = str(ref, 100);
  if (!/^[\w-]+$/.test(ref)) return null;
  return env.DB.prepare('SELECT * FROM checkouts WHERE gateway = ? AND gateway_ref = ?').bind(gateway, ref).first();
}
/* Bookkeeping for the cron sweeps: checked_at on every look at the gateway,
   settled_at once the outcome is final so the checkout is never polled again.
   Never lets a bookkeeping error break a donor's redirect. */
async function markCheckout(env, id, settled) {
  if (!id) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare('UPDATE checkouts SET checked_at = ?, settled_at = COALESCE(settled_at, ?) WHERE id = ?')
      .bind(now, settled ? now : null, id).run();
  } catch (err) { console.error('mark checkout', err); }
}

function alertAdmin(env, ctx, subject, text, replyTo) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.FROM_EMAIL) return;
  const msg = { from: env.FROM_EMAIL, to: env.NOTIFY_EMAIL.split(',').map(s => s.trim()), subject: `[GAZHP] ${subject}`, text };
  if (replyTo && isEmail(replyTo)) msg.reply_to = replyTo;
  const send = fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(msg),
  }).catch(err => console.error('email alert failed', err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

/* =============================================================================
   Public config
   ============================================================================= */
function publicConfig(env) {
  return {
    gateways: gatewaysOn(env),
    tiers: TIERS,
    donation: DONATION,
    zmwPerUsd: zmwPerUsd(env),
    offlineMethods: OFFLINE_METHODS,
  };
}

/* =============================================================================
   Checkout — validates the request, prices it on the server, then hands off
   to the gateway's hosted payment page. Card details never touch GAZHP.
   ============================================================================= */
async function checkout(request, env, url) {
  const b = await readJson(request);
  const gateway = str(b.gateway, 20);
  const on = gatewaysOn(env);
  // Explicit allow-list: on['constructor'] etc. are truthy object properties.
  if (!GATEWAYS.includes(gateway) || !on[gateway]) throw new HttpError(400, 'That payment method is not available.');

  const purpose = b.purpose === 'membership' ? 'membership' : 'donation';
  const name = str(b.name, 120), email = str(b.email, 160).toLowerCase();
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');

  let amount, currency, tier = '', recurring = 'once', label;
  if (purpose === 'membership') {
    const t = tierById(b.tier);
    if (!t) throw new HttpError(400, 'Please choose a membership tier.');
    tier = t.id; amount = t.amount; currency = t.currency;
    label = `GAZHP membership — ${tierName(t)}`;
    if (b.recurring === 'year') {
      if (gateway !== 'stripe') throw new HttpError(400, 'Automatic renewal is available with card payments only.');
      recurring = 'year';
    }
    // Mobile money in Zambia is charged in Kwacha.
    if (gateway === 'dpo' && currency === 'USD' && zmwPerUsd(env) > 0 && b.currency === 'ZMW') {
      amount = Math.ceil(amount * zmwPerUsd(env)); currency = 'ZMW';
    }
  } else {
    currency = str(b.currency || 'USD', 3).toUpperCase();
    if (!['USD', 'ZMW'].includes(currency)) throw new HttpError(400, 'Unsupported currency.');
    if (currency === 'ZMW' && gateway !== 'dpo') throw new HttpError(400, 'Kwacha payments are available through Mobile Money / DPO Pay.');
    amount = Math.round(parseFloat(b.amount) * 100) / 100;
    if (!(amount >= DONATION.min[currency]) || amount > DONATION.max[currency]) {
      throw new HttpError(400, `Please enter an amount between ${DONATION.min[currency]} and ${DONATION.max[currency].toLocaleString('en-US')} ${currency}.`);
    }
    if (b.recurring === 'month') {
      if (gateway !== 'stripe') throw new HttpError(400, 'Monthly giving is available with card payments only.');
      recurring = 'month';
    }
    label = recurring === 'month' ? 'Monthly donation to GAZHP' : 'Donation to GAZHP';
  }

  const co = {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), gateway, purpose, tier, amount, currency, recurring,
    name, email, phone: str(b.phone, 40), country: str(b.country, 80), profession: str(b.profession, 160),
  };
  await env.DB.prepare(`INSERT INTO checkouts (id, created_at, gateway, purpose, tier, amount, currency, recurring, name, email, phone, country, profession)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(co.id, co.created_at, gateway, purpose, tier, amount, currency, recurring, co.name, co.email, co.phone, co.country, co.profession).run();

  const apiBase = url.origin;
  let redirect, gatewayRef;
  if (gateway === 'stripe') ({ redirect, gatewayRef } = await stripeCreate(env, co, label));
  else if (gateway === 'paypal') ({ redirect, gatewayRef } = await paypalCreate(env, co, label, apiBase));
  else if (gateway === 'dpo') ({ redirect, gatewayRef } = await dpoCreate(env, co, label, apiBase));
  else throw new HttpError(400, 'That payment method is not available.');

  await env.DB.prepare('UPDATE checkouts SET gateway_ref = ? WHERE id = ?').bind(gatewayRef || '', co.id).run();
  return json({ url: redirect });
}

/* ------------------------------ Stripe ------------------------------------ */
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}
/* Pinned so request/response shapes don't change with the account's default
   version. (Webhook payloads follow the version chosen on the webhook endpoint;
   the handlers below accept both the older and the basil shapes.) */
const STRIPE_API_VERSION = '2025-03-31.basil';
async function stripeApi(env, path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': STRIPE_API_VERSION },
    body: method === 'POST' ? formEncode(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) { console.error('stripe error', JSON.stringify(data)); throw new HttpError(502, 'The card payment service is unavailable. Please try another method.'); }
  return data;
}
async function stripeCreate(env, co, label) {
  const meta = { checkout_id: co.id, purpose: co.purpose, tier: co.tier };
  const recurringMode = co.recurring !== 'once';
  const params = {
    mode: recurringMode ? 'subscription' : 'payment',
    customer_email: co.email,
    client_reference_id: co.id,
    // Card payments settle at once, US bank (ACH) payments days later — the thank-you page words it neutrally.
    success_url: thanksUrl(env, 'stripe', co.purpose, 'submitted'),
    cancel_url: cancelUrl(env, co.purpose),
    metadata: meta,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: co.currency.toLowerCase(),
        unit_amount: Math.round(co.amount * 100),
        product_data: { name: label },
        recurring: recurringMode ? { interval: co.recurring } : undefined,
      },
    }],
  };
  if (recurringMode) params.subscription_data = { metadata: meta, description: label };
  else { params.submit_type = 'donate'; params.payment_intent_data = { description: label, metadata: meta }; }
  const s = await stripeApi(env, 'checkout/sessions', params);
  return { redirect: s.url, gatewayRef: s.id };
}

async function verifyStripeSignature(body, header, secret) {
  if (!header || !secret) return false;
  let t = null; const v1 = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  }
  if (!t || !v1.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return v1.some(v => safeEqual(v, expected));
}

async function stripeWebhook(request, env, ctx) {
  const body = await request.text();
  if (!(await verifyStripeSignature(body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    throw new HttpError(400, 'Invalid signature');
  }
  const event = JSON.parse(body);
  const o = event.data && event.data.object || {};

  switch (event.type) {
    // One-time payments (cards settle immediately; US bank/ACH settles days later).
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      if (o.mode !== 'payment') break; // subscriptions are recorded from invoice.paid
      const co = await getCheckout(env, (o.metadata && o.metadata.checkout_id) || o.client_reference_id);
      if (!co && !(o.metadata && o.metadata.purpose)) break; // not one of ours
      const status = event.type.endsWith('failed') ? 'failed' : o.payment_status === 'paid' ? 'paid' : 'pending';
      await recordPayment(env, ctx, {
        source: 'stripe', method: 'Stripe', ref: o.payment_intent || o.id, status, date: isoDate(o.created),
        amount: (o.amount_total || 0) / 100, currency: (o.currency || 'usd').toUpperCase(), recurring: 'once',
        type: (co && co.purpose) || o.metadata.purpose, tier: (co && co.tier) || (o.metadata && o.metadata.tier),
        name: (o.customer_details && o.customer_details.name) || (co && co.name),
        email: (o.customer_details && o.customer_details.email) || (co && co.email),
        phone: co && co.phone, country: (co && co.country) || (o.customer_details && o.customer_details.address && o.customer_details.address.country),
        profession: co && co.profession,
      });
      break;
    }
    // Monthly donations & auto-renewing memberships: every successful charge.
    case 'invoice.paid': {
      const meta = (o.subscription_details && o.subscription_details.metadata)
        || (o.parent && o.parent.subscription_details && o.parent.subscription_details.metadata)
        || (o.lines && o.lines.data && o.lines.data[0] && o.lines.data[0].metadata) || {};
      if (!meta.checkout_id && !meta.purpose) break; // not created by this site
      if (!o.amount_paid) break;
      const co = await getCheckout(env, meta.checkout_id);
      const line = o.lines && o.lines.data && o.lines.data[0] || {};
      const interval = (line.price && line.price.recurring && line.price.recurring.interval) || (co && co.recurring) || 'month';
      const paidAt = o.status_transitions && o.status_transitions.paid_at;
      await recordPayment(env, ctx, {
        source: 'stripe', method: 'Stripe', ref: o.id, status: 'paid', date: isoDate(paidAt || o.created),
        amount: o.amount_paid / 100, currency: (o.currency || 'usd').toUpperCase(), recurring: interval,
        type: (co && co.purpose) || meta.purpose, tier: (co && co.tier) || meta.tier,
        name: o.customer_name || (co && co.name), email: o.customer_email || (co && co.email),
        phone: co && co.phone, country: co && co.country, profession: co && co.profession,
      });
      break;
    }
    case 'charge.refunded': {
      if (!(o.amount_refunded > 0)) break;
      // One-time gifts are stored by payment intent, monthly/renewal charges by
      // invoice id. Since API 2025-03-31.basil a Charge has no `invoice` field,
      // so look the invoice up through the Invoice Payments API.
      const refs = [o.payment_intent, o.invoice];
      if (o.payment_intent && !o.invoice) {
        try {
          const ip = await stripeApi(env, `invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(o.payment_intent)}&limit=1`, null, 'GET');
          if (ip.data && ip.data[0] && ip.data[0].invoice) refs.push(ip.data[0].invoice);
        } catch (err) { console.error('stripe invoice lookup', err); }
      }
      const ids = refs.filter(Boolean);
      if (!ids.length) break;
      if (o.amount_refunded >= o.amount) {
        await setStatusByRef(env, 'stripe', ids, 'refunded');
      } else {
        // Partial refund: keep it as paid, but note it so totals can be corrected.
        const note = `Partially refunded ${(o.currency || 'usd').toUpperCase()} ${(o.amount_refunded / 100).toFixed(2)}`;
        await env.DB.prepare(
          `UPDATE payments SET notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || ' · ' || ? END
           WHERE source = 'stripe' AND ref IN (${ids.map(() => '?').join(',')}) AND instr(COALESCE(notes, ''), ?) = 0`)
          .bind(note, note, ...ids, note).run();
      }
      break;
    }
  }
  return json({ received: true });
}

/* ------------------------------ PayPal ------------------------------------ */
const paypalBase = env => env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
/* PayPal asks integrations to reuse access tokens until they expire (about 9h).
   Cached per Worker isolate, keyed so sandbox and live never share a token. */
let paypalTokenCache = null;
async function paypalToken(env) {
  const key = `${env.PAYPAL_ENV}|${env.PAYPAL_CLIENT_ID}`;
  const c = paypalTokenCache;
  if (c && c.key === key && c.exp > Date.now() + MINUTE) return c.token;
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) { console.error('paypal auth', JSON.stringify(data)); throw new HttpError(502, 'PayPal is unavailable. Please try another method.'); }
  paypalTokenCache = { key, token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 300) * 1000 };
  return data.access_token;
}
async function paypalApi(env, path, { method = 'POST', body, headers = {} } = {}) {
  const send = async token => fetch(`${paypalBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await send(await paypalToken(env));
  if (res.status === 401) { paypalTokenCache = null; res = await send(await paypalToken(env)); } // token revoked early
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
async function paypalCreate(env, co, label, apiBase) {
  if (co.currency !== 'USD') throw new HttpError(400, 'PayPal payments are in US dollars.');
  const r = await paypalApi(env, '/v2/checkout/orders', {
    headers: { 'PayPal-Request-Id': co.id },
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: co.id, description: label.slice(0, 127), amount: { currency_code: co.currency, value: co.amount.toFixed(2) } }],
      payment_source: { paypal: { experience_context: {
        brand_name: 'GAZHP', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
        return_url: `${apiBase}/paypal/return`, cancel_url: `${apiBase}/paypal/cancel?purpose=${co.purpose}`,
      } } },
    },
  });
  if (!r.ok) { console.error('paypal create', JSON.stringify(r.data)); throw new HttpError(502, 'PayPal is unavailable. Please try another method.'); }
  const link = (r.data.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new HttpError(502, 'PayPal is unavailable. Please try another method.');
  return { redirect: link.href, gatewayRef: r.data.id };
}
function paypalCaptureFromOrder(order) {
  const pu = (order.purchase_units || [])[0] || {};
  const cap = (pu.payments && pu.payments.captures || [])[0];
  return { pu, cap };
}
async function recordPaypalCapture(env, ctx, cap, customId, payer, co = null) {
  co = co || await getCheckout(env, customId);
  if (!co) return null;
  const status = cap.status === 'COMPLETED' ? 'paid' : ['DECLINED', 'FAILED'].includes(cap.status) ? 'failed' : cap.status === 'REFUNDED' ? 'refunded' : 'pending';
  const payerName = payer && payer.name ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ') : '';
  await recordPayment(env, ctx, {
    source: 'paypal', method: 'PayPal', ref: cap.id, status, date: isoDate(cap.create_time),
    amount: parseFloat(cap.amount.value), currency: cap.amount.currency_code, recurring: 'once',
    type: co.purpose, tier: co.tier, name: co.name || payerName, email: co.email || (payer && payer.email_address),
    phone: co.phone, country: co.country, profession: co.profession,
  });
  // A pending capture (e.g. under review) is still re-checked by the sweep.
  await markCheckout(env, co.id, status !== 'pending');
  return { co, status };
}
/* Records the capture inside an order returned by the capture call or a GET. */
async function paypalRecordOrder(env, ctx, order, co) {
  const { pu, cap } = paypalCaptureFromOrder(order || {});
  if (!cap) return null;
  return recordPaypalCapture(env, ctx, cap, cap.custom_id || pu.custom_id, order.payer, co);
}
/* Captures an approved order. Deliberately sent without a PayPal-Request-Id:
   a fixed id would make PayPal replay a stored INSTRUMENT_DECLINED after the
   donor picks another funding source. Capture is still safe to repeat (return
   page, webhook, cron sweep): PayPal moves money once per order and answers a
   second capture with ORDER_ALREADY_CAPTURED, which the callers resolve by
   reading the order (return page GET, sweep on its next run, or the
   PAYMENT.CAPTURE.COMPLETED webhook), and savePayment's dedupe key
   (paypal|<capture id>) records the capture only once. */
async function paypalCapture(env, ctx, co) {
  const orderId = co.gateway_ref;
  const r = await paypalApi(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
  if (r.ok) return { rec: await paypalRecordOrder(env, ctx, r.data, co) };
  const issues = ((r.data && r.data.details) || []).map(d => d && d.issue);
  return { rec: null, declined: issues.includes('INSTRUMENT_DECLINED'), error: r.data || {} };
}
/* Where to send a donor whose funding source was declined, so they can pick
   another one on PayPal (PayPal's recommended handling of INSTRUMENT_DECLINED). */
function paypalRetryLink(data) {
  const link = ((data && data.links) || []).find(l => ['redirect', 'payer-action', 'approve'].includes(l.rel));
  return link && /^https:\/\/([\w-]+\.)*paypal\.com\//.test(link.href) ? link.href : '';
}
async function paypalReturn(env, ctx, url) {
  // The order id is saved before the donor is ever sent to PayPal, so an
  // unknown id is not one of ours: don't call PayPal for it.
  const co = await checkoutByRef(env, 'paypal', url.searchParams.get('token'));
  if (!co) return Response.redirect(cancelUrl(env, 'donation'), 302);
  const orderPath = `/v2/checkout/orders/${encodeURIComponent(co.gateway_ref)}`;
  const out = await paypalCapture(env, ctx, co);
  let rec = out.rec;
  if (!rec && out.declined) {
    const retry = paypalRetryLink(out.error) || paypalRetryLink((await paypalApi(env, orderPath, { method: 'GET' })).data);
    if (retry) return Response.redirect(retry, 302);
  }
  if (!rec) { // e.g. already captured by the webhook or the sweep
    const r = await paypalApi(env, orderPath, { method: 'GET' });
    if (r.ok) rec = await paypalRecordOrder(env, ctx, r.data, co);
  }
  if (!rec || rec.status === 'failed' || rec.status === 'refunded') return Response.redirect(cancelUrl(env, co.purpose), 302);
  return Response.redirect(thanksUrl(env, 'paypal', co.purpose, rec.status === 'paid' ? 'paid' : 'pending'), 302);
}
async function paypalWebhook(request, env, ctx) {
  const body = await request.text();
  if (!env.PAYPAL_WEBHOOK_ID) throw new HttpError(400, 'PayPal webhook not configured');
  let event;
  try { event = JSON.parse(body || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  const h = k => request.headers.get(k);
  const v = await paypalApi(env, '/v1/notifications/verify-webhook-signature', { body: {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: event,
  } });
  if (!v.ok || v.data.verification_status !== 'SUCCESS') throw new HttpError(400, 'Invalid signature');
  const res = event.resource || {};
  if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
    // Donor approved on PayPal: capture now, even if they never come back to the site.
    const co = await checkoutByRef(env, 'paypal', res.id);
    if (co && !co.settled_at) await paypalCapture(env, ctx, co);
  } else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
    await recordPaypalCapture(env, ctx, res, res.custom_id, null);
  } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    const up = (res.links || []).find(l => l.rel === 'up');
    const capId = up && up.href.split('/').pop();
    await setStatusByRef(env, 'paypal', [capId], 'refunded');
  }
  return json({ received: true });
}
/* Cron: capture PayPal orders that were approved but never captured because
   the donor closed the tab before returning (PayPal moves no money until we
   capture, and approved orders expire). Oldest-checked first, so a few
   abandoned orders can't starve the others; small LIMIT for the subrequest budget. */
async function paypalSweep(env, ctx, budget) {
  if (!gatewaysOn(env).paypal) return;
  budget.left -= 1;
  const { results } = await env.DB.prepare(
    `SELECT * FROM checkouts
     WHERE gateway = 'paypal' AND gateway_ref <> '' AND settled_at IS NULL AND created_at > ? AND created_at < ?
     ORDER BY checked_at IS NOT NULL, checked_at ASC LIMIT 4`).bind(isoAgo(3 * HOUR), isoAgo(5 * MINUTE)).all();
  for (const co of results) {
    if (budget.left < 6) break; // token + GET + capture + save + email + mark
    budget.left -= 6;
    try {
      const r = await paypalApi(env, `/v2/checkout/orders/${encodeURIComponent(co.gateway_ref)}`, { method: 'GET' });
      const status = r.ok ? r.data.status : '';
      let rec = null;
      if (status === 'APPROVED') rec = (await paypalCapture(env, ctx, co)).rec;
      else if (status === 'COMPLETED') rec = await paypalRecordOrder(env, ctx, r.data, co);
      if (!rec) await markCheckout(env, co.id, status === 'VOIDED'); // CREATED / PAYER_ACTION_REQUIRED: donor hasn't approved yet
    } catch (err) { console.error('paypal sweep', err); }
  }
}

/* ------------------------------ DPO Pay ------------------------------------
   Zambia: MTN / Airtel / Zamtel mobile money and local & international cards.
   Flow: createToken → donor pays on DPO's page → verifyToken (always).
   Docs: DPO Pay API v6 (XML).
   -------------------------------------------------------------------------- */
const dpoBase = env => (env.DPO_API_URL || 'https://secure.3gdirectpay.com').replace(/\/+$/, '');
const xmlEsc = v => String(v ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlTag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
};
async function dpoApi(env, inner) {
  const body = `<?xml version="1.0" encoding="utf-8"?><API3G><CompanyToken>${xmlEsc(env.DPO_COMPANY_TOKEN)}</CompanyToken>${inner}</API3G>`;
  const res = await fetch(`${dpoBase(env)}/API/v6/`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body });
  return res.text();
}
async function dpoCreate(env, co, label, apiBase) {
  const [first, ...rest] = co.name.split(/\s+/);
  const phone = (co.phone || '').replace(/\D/g, '');
  const d = new Date();
  const serviceDate = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const xml = await dpoApi(env, `<Request>createToken</Request>
    <Transaction>
      <PaymentAmount>${co.amount.toFixed(2)}</PaymentAmount>
      <PaymentCurrency>${xmlEsc(co.currency)}</PaymentCurrency>
      <CompanyRef>${xmlEsc(co.id)}</CompanyRef>
      <RedirectURL>${xmlEsc(`${apiBase}/dpo/return`)}</RedirectURL>
      <BackURL>${xmlEsc(cancelUrl(env, co.purpose))}</BackURL>
      <CompanyRefUnique>1</CompanyRefUnique>
      <PTL>24</PTL>
      <PTLtype>hours</PTLtype>
      <customerEmail>${xmlEsc(co.email)}</customerEmail>
      <customerFirstName>${xmlEsc(first)}</customerFirstName>
      <customerLastName>${xmlEsc(rest.join(' ') || first)}</customerLastName>
      ${phone ? `<customerPhone>${phone}</customerPhone>` : ''}
    </Transaction>
    <Services><Service>
      <ServiceType>${xmlEsc(env.DPO_SERVICE_TYPE)}</ServiceType>
      <ServiceDescription>${xmlEsc(label)}</ServiceDescription>
      <ServiceDate>${serviceDate}</ServiceDate>
    </Service></Services>`);
  const token = xmlTag(xml, 'TransToken');
  if (xmlTag(xml, 'Result') !== '000' || !token) {
    console.error('dpo createToken', xml);
    throw new HttpError(502, 'Mobile money payments are unavailable right now. Please try another method.');
  }
  return { redirect: `${dpoBase(env)}/payv2.php?ID=${encodeURIComponent(token)}`, gatewayRef: token };
}
/* Asks DPO for the real status — the redirect and push alone are never trusted.
   The cron sweep passes the checkout row it already has, saving a query. */
async function verifyDpo(env, ctx, token, co = null) {
  co = co || await checkoutByRef(env, 'dpo', token);
  if (!co) return null;
  token = co.gateway_ref;
  const xml = await dpoApi(env, `<Request>verifyToken</Request><TransactionToken>${xmlEsc(token)}</TransactionToken>`);
  const result = xmlTag(xml, 'Result');
  if (result === '000') {
    // Guard against a mismatched amount/currency if DPO reports them.
    const amt = parseFloat(xmlTag(xml, 'TransactionAmount'));
    const cur = xmlTag(xml, 'TransactionCurrency');
    const ok = (!cur || cur.toUpperCase() === co.currency) && (isNaN(amt) || amt >= Number(co.amount) - 0.01);
    const method = xmlTag(xml, 'CustomerCreditType');
    await recordPayment(env, ctx, {
      source: 'dpo', method: 'DPO Pay', ref: token, status: ok ? 'paid' : 'pending',
      date: isoDate(xmlTag(xml, 'TransactionSettlementDate') || xmlTag(xml, 'TransactionCreatedDate') || undefined),
      amount: isNaN(amt) ? co.amount : amt, currency: (cur || co.currency).toUpperCase(), recurring: 'once',
      type: co.purpose, tier: co.tier, name: co.name || xmlTag(xml, 'CustomerName'), email: co.email,
      phone: co.phone || xmlTag(xml, 'CustomerPhone'), country: co.country || xmlTag(xml, 'CustomerCountry'),
      profession: co.profession,
      notes: [method, ok ? '' : 'Amount/currency did not match — check in DPO before confirming.'].filter(Boolean).join(' · '),
    });
    await markCheckout(env, co.id, true);
    return { co, status: ok ? 'paid' : 'pending' };
  }
  // No payments row exists for an unpaid token (one is only written on 000),
  // so the outcome is kept on the checkout instead.
  // 900 = not paid yet (e.g. waiting for mobile-money approval on the phone).
  // 901 = declined, but not final: the donor can retry on DPO's page until the
  //       24-hour payment time limit passes.
  if (result === '900' || result === '901') {
    await markCheckout(env, co.id, false);
    return { co, status: result === '901' ? 'failed' : 'waiting' };
  }
  // 902 data mismatch, 903 payment time limit passed, 904 cancelled → final.
  if (['902', '903', '904'].includes(result)) {
    await markCheckout(env, co.id, true);
    return { co, status: 'failed' };
  }
  console.error('dpo verifyToken', xml);
  await markCheckout(env, co.id, false);
  return { co, status: 'waiting' };
}
async function dpoReturn(env, ctx, url) {
  const token = url.searchParams.get('TransactionToken') || url.searchParams.get('ID');
  const rec = await verifyDpo(env, ctx, token);
  if (!rec) return Response.redirect(cancelUrl(env, 'donation'), 302);
  if (rec.status === 'failed') return Response.redirect(cancelUrl(env, rec.co.purpose), 302);
  return Response.redirect(thanksUrl(env, 'dpo', rec.co.purpose, rec.status === 'paid' ? 'paid' : 'pending'), 302);
}
/* DPO "push" notification: we only read the token from it, then verify with DPO. */
async function dpoWebhook(request, env, ctx) {
  const body = await request.text();
  if (body.length > 50000) throw new HttpError(413, 'Request too large');
  const token = xmlTag(body, 'TransactionToken') || new URLSearchParams(body).get('TransactionToken');
  if (token) await verifyDpo(env, ctx, token);
  return new Response('<?xml version="1.0" encoding="utf-8"?><API3G><Response>OK</Response></API3G>', { headers: { 'content-type': 'application/xml' } });
}
/* Cron: re-check DPO checkouts that aren't settled yet. Tokens expire after the
   24-hour payment time limit (PTL in dpoCreate), so only the last 26 hours are
   checked. Least-recently-checked first (round robin), so newer abandoned or
   bot-created checkouts can't push a real pending mobile-money payment out. */
async function dpoSweep(env, ctx, budget) {
  if (!gatewaysOn(env).dpo) return;
  budget.left -= 1;
  const { results } = await env.DB.prepare(
    `SELECT * FROM checkouts
     WHERE gateway = 'dpo' AND gateway_ref <> '' AND settled_at IS NULL AND created_at > ? AND created_at < ?
     ORDER BY checked_at IS NOT NULL, checked_at ASC LIMIT 10`).bind(isoAgo(26 * HOUR), isoAgo(5 * MINUTE)).all();
  for (const co of results) {
    if (budget.left < 4) break; // DPO call + save + email + mark
    budget.left -= 4;
    try { await verifyDpo(env, ctx, co.gateway_ref, co); } catch (err) { console.error('dpo sweep', err); }
  }
}
/* Every 15 minutes. A free-plan Worker run may make about 50 subrequests
   (gateway calls, emails and D1 queries count), so the jobs share a budget and
   each sweep uses a small LIMIT; whatever is left over is picked up next run. */
async function scheduledJobs(env, ctx) {
  const budget = { left: 45 };
  for (const [name, job] of [['rate-limit cleanup', cleanupRateLimits], ['paypal sweep', paypalSweep], ['dpo sweep', dpoSweep]]) {
    try { await job(env, ctx, budget); } catch (err) { console.error(name, err); }
  }
}

/* =============================================================================
   Offline payments reported by donors → pending until an admin confirms.
   ============================================================================= */
async function notify(request, env, ctx) {
  const b = await readJson(request, 8000);
  if (b.website) return json({ ok: true }); // honeypot field filled → bot
  const name = str(b.name, 120), email = str(b.email, 160).toLowerCase();
  const method = OFFLINE_METHODS.includes(b.method) ? b.method : 'Other';
  const amount = Math.round(parseFloat(b.amount) * 100) / 100;
  const currency = ['USD', 'ZMW', 'GBP', 'EUR', 'CAD', 'AUD', 'ZAR'].includes(String(b.currency).toUpperCase()) ? String(b.currency).toUpperCase() : 'USD';
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!(amount > 0) || amount > 10000000) throw new HttpError(400, 'Please enter the amount you sent.');
  const purpose = b.purpose === 'membership' ? 'membership' : 'donation';
  const tier = purpose === 'membership' && tierById(b.tier) ? b.tier : '';
  const ref = str(b.ref, 60);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
  // Resubmitting the same reference puts a 'failed' report back to pending for
  // review; a confirmed (paid) or refunded one is left as it is.
  await savePayment(env, {
    source: 'notify', status: 'pending', method, ref, date, amount, currency, type: purpose, tier,
    name, email, phone: b.phone, country: b.country, profession: b.profession, notes: b.notes,
    dedupe_key: ref ? `notify|${ref}|${email}`.toLowerCase() : undefined,
  });
  // Flood guard: past 20 reports in an hour, stop emailing (they still appear
  // in the dashboard) so a script can't fill the inbox or use up the email quota.
  if (await recentCount(env, `SELECT COUNT(*) AS n FROM payments WHERE source = 'notify' AND created_at > ?`, HOUR) <= 20) {
    alertAdmin(env, ctx, `Payment reported — please confirm: ${currency} ${amount.toFixed(2)} via ${method}`,
      `Name: ${name}\nEmail: ${email}\nReference: ${ref || '—'}\nDate sent: ${date}\n\nConfirm it in the dashboard once the money arrives.`);
  }
  return json({ ok: true });
}

/* =============================================================================
   Contact form → saved for the dashboard (Messages), plus an optional email
   alert whose Reply-To is the sender, so admins can answer straight from it.
   ============================================================================= */
const MESSAGE_STATUSES = ['new', 'read', 'archived'];
const MESSAGE_MAX = 5000;
async function contact(request, env, ctx) {
  const b = await readJson(request, 16000);
  if (b.website) return json({ ok: true }); // honeypot field filled → bot (pretend it worked)
  const name = oneLine(b.name || [b.fname, b.lname].filter(Boolean).join(' '), 120);
  const email = str(b.email, 160).toLowerCase();
  const subject = oneLine(b.subject, 150);
  const profession = oneLine(b.profession, 160);
  const message = String(b.message ?? '').replace(/\r\n?/g, '\n').trim();
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!subject) throw new HttpError(400, 'Please choose a subject.');
  if (!message) throw new HttpError(400, 'Please write your message.');
  if (message.length > MESSAGE_MAX) throw new HttpError(400, `Please keep your message under ${MESSAGE_MAX.toLocaleString('en-US')} characters.`);

  const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), name, email, subject, message, profession, status: 'new' };
  await env.DB.prepare('INSERT INTO messages (id, created_at, name, email, subject, message, profession, status) VALUES (?,?,?,?,?,?,?,?)')
    .bind(row.id, row.created_at, name, email, subject, message, profession, row.status).run();

  // Flood guard, as for payment reports: messages are always saved, emails stop past 30 an hour.
  if (await recentCount(env, 'SELECT COUNT(*) AS n FROM messages WHERE created_at > ?', HOUR) <= 30) {
    const head = [`From: ${name} <${email}>`, ...(profession ? [`Profession / role: ${profession}`] : []), `Subject: ${subject}`];
    alertAdmin(env, ctx, `Contact form: ${subject} — ${name}`,
      `${head.join('\n')}\n\n${message}\n\n—\nSent from the website contact form. Reply to this email to answer the sender directly.`,
      email);
  }
  return json({ ok: true });
}

/* =============================================================================
   Admin
   ============================================================================= */
async function adminLogin(request, env) {
  const b = await readJson(request, 2000);
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_PASSWORD is not set on the server.');
  if (!safeEqual(str(b.password, 500), env.ADMIN_PASSWORD)) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    throw new HttpError(401, 'Incorrect password.');
  }
  const payload = b64url(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 }));
  const token = `${payload}.${await hmacHex(env.ADMIN_PASSWORD, payload)}`;
  return json({ token, expiresInHours: 12 });
}
async function requireAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !env.ADMIN_PASSWORD) throw new HttpError(401, 'Please sign in.');
  if (!safeEqual(sig, await hmacHex(env.ADMIN_PASSWORD, payload))) throw new HttpError(401, 'Please sign in.');
  let data; try { data = JSON.parse(unb64url(payload)); } catch { throw new HttpError(401, 'Please sign in.'); }
  if (!data.exp || data.exp < Date.now()) throw new HttpError(401, 'Your session expired. Please sign in again.');
}
async function adminList(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, date, status, type, tier, amount, currency, method, ref, recurring, name, email, phone, country, profession, notes, source, created_at
     FROM payments ORDER BY date DESC, created_at DESC LIMIT 50000`).all();
  return json({ payments: results });
}
async function adminAdd(request, env) {
  const b = await readJson(request, 5000000);
  const recs = Array.isArray(b.records) ? b.records.slice(0, 20000) : [];
  const source = b.source === 'import' ? 'import' : 'manual';
  const stmts = [];
  for (const r of recs) {
    const amount = Math.round(parseFloat(r.amount) * 100) / 100;
    if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const method = str(r.method || 'Other', 60);
    const ref = str(r.ref, 120);
    const key = ref ? `${method}|${ref}` : `${r.date}|${str(r.email || r.name, 160)}|${amount}|${str(r.currency || 'USD', 3)}`;
    const row = paymentRow({ ...r, amount, method, ref, source, status: ['paid', 'pending', 'failed', 'refunded'].includes(r.status) ? r.status : 'paid', dedupe_key: key.toLowerCase() });
    // Skip a row whose reference is already recorded from any source: gateway
    // webhooks key rows as 'dpo|<token>' / 'notify|<ref>|<email>', so imports
    // and backup restores would otherwise count those payments twice.
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO payments (${PAY_COLS.join(',')})
       SELECT ${PAY_COLS.map(() => '?').join(',')}
       WHERE NOT EXISTS (SELECT 1 FROM payments WHERE ? <> '' AND ref = ? COLLATE NOCASE)`)
      .bind(...PAY_COLS.map(c => row[c]), row.ref, row.ref));
  }
  let added = 0;
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch(stmts.slice(i, i + 100));
    added += res.reduce((s, x) => s + ((x.meta && x.meta.changes) || 0), 0);
  }
  return json({ added, duplicates: stmts.length - added, skipped: recs.length - stmts.length });
}
async function adminUpdate(request, env, id) {
  const b = await readJson(request, 10000);
  const fields = {};
  if (['paid', 'pending', 'failed', 'refunded'].includes(b.status)) fields.status = b.status;
  if (['donation', 'membership'].includes(b.type)) fields.type = b.type;
  if (b.tier !== undefined) fields.tier = tierById(b.tier) ? b.tier : '';
  for (const k of ['name', 'email', 'phone', 'country', 'profession', 'notes', 'method']) if (b[k] !== undefined) fields[k] = str(b[k], k === 'notes' ? 1000 : 160);
  if (b.amount !== undefined && parseFloat(b.amount) > 0) fields.amount = Math.round(parseFloat(b.amount) * 100) / 100;
  if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) fields.date = b.date;
  const keys = Object.keys(fields);
  if (!keys.length) throw new HttpError(400, 'Nothing to update.');
  const r = await env.DB.prepare(`UPDATE payments SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => fields[k]), id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Payment not found.');
  return json({ ok: true });
}
async function adminDelete(env, id) {
  const r = await env.DB.prepare('DELETE FROM payments WHERE id = ?').bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Payment not found.');
  return json({ ok: true });
}
async function adminMessages(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, email, subject, message, profession, status
     FROM messages ORDER BY created_at DESC LIMIT 5000`).all();
  return json({ messages: results });
}
async function adminMessageUpdate(request, env, id) {
  const b = await readJson(request, 2000);
  if (!MESSAGE_STATUSES.includes(b.status)) throw new HttpError(400, 'Status must be new, read or archived.');
  const r = await env.DB.prepare('UPDATE messages SET status = ? WHERE id = ?').bind(b.status, id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Message not found.');
  return json({ ok: true });
}
async function adminMessageDelete(env, id) {
  const r = await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Message not found.');
  return json({ ok: true });
}
