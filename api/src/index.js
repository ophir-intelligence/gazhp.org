/* =============================================================================
   GAZHP payments API — Cloudflare Worker
   -----------------------------------------------------------------------------
   Public:
     GET  /config                     tiers, designations + which gateways are switched on
     POST /checkout                   start a Stripe / PayPal / DPO Pay payment
     POST /momo/start                 mobile money: send a PIN prompt to the donor's phone
                                      (DPO Pay ChargeTokenMobile; only when DPO_DIRECT_MOMO=true)
     GET  /momo/status?reference=…    poll that payment: pending | paid | failed
     POST /notify                     donor reports an offline payment (Zelle, bank…)
     POST /manage-giving              { email } → emails a Stripe billing-portal link (always { ok: true })
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
   Receipts: when a payment first becomes 'paid' (gateway, sweep, /momo/status
   or an admin confirming it) the donor is emailed a receipt once — see
   receiptOnce(). Needs RESEND_API_KEY + FROM_EMAIL; ORG_EIN is optional.
   Admin (Bearer token from /admin/login):
     POST   /admin/login
     GET    /admin/payments
     POST   /admin/payments           { records: [...] }  manual entry / CSV import (never emails receipts)
     PATCH  /admin/payments/:id       { status, type, tier, designation, notes, … }
     POST   /admin/payments/:id/receipt  (re)send the donor's receipt
     DELETE /admin/payments/:id
     GET    /admin/messages           contact-form messages
     PATCH  /admin/messages/:id       { status: new | read | archived }
     DELETE /admin/messages/:id
   Abuse protection: per-IP rate limits on the public routes (RATE_LIMITS
   below), counted in the D1 table rate_limits. No paid Cloudflare feature needed.
   ============================================================================= */
import { TIERS, DONATION, OFFLINE_METHODS, DESIGNATIONS, ORG, MOMO_LIMITS } from './config.js';

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
  '/momo/start': [20, 600],     // each one rings a phone; momoStart also limits prompts per number
  '/momo/status': [120, 60],    // GET, polled every ~5 s by the payment page (checked in momoStatus)
  '/notify': [10, 600],
  '/manage-giving': [5, 600],
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
  if (m === 'POST' && p === '/momo/start') return momoStart(request, env, ctx, url);
  if (m === 'GET' && p === '/momo/status') return momoStatus(request, env, ctx, url);
  if (m === 'POST' && p === '/notify') return notify(request, env, ctx);
  if (m === 'POST' && p === '/manage-giving') return manageGiving(request, env, ctx);
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
    if (idMatch && m === 'PATCH') return adminUpdate(request, env, ctx, idMatch[1]);
    if (idMatch && m === 'DELETE') return adminDelete(env, idMatch[1]);
    const receiptMatch = p.match(/^\/admin\/payments\/([\w-]+)\/receipt$/);
    if (receiptMatch && m === 'POST') return adminReceipt(env, receiptMatch[1]);
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
const designationById = id => DESIGNATIONS.find(d => d.id === id);
/* Donations: a known programme id, else 'general'. Memberships carry none. */
const designationFor = (purpose, v) => purpose === 'membership' ? '' : designationById(v) ? v : 'general';
const emailReady = env => !!(env.RESEND_API_KEY && env.FROM_EMAIL);
const htmlEsc = v => String(v ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (amount, currency) => `${currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { hits, wait } = await bumpCounter(env, `${path}|${await keyedHash(env, `rate-limit|${ip}`)}`, seconds * 1000);
  if (hits > max) {
    throw new HttpError(429, `Too many attempts. Please wait ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : 'a minute'} and try again.`, { 'retry-after': String(wait) });
  }
}
/* Keyed hash, so counters never hold a raw IP address, phone number or email. */
async function keyedHash(env, s) {
  return (await hmacHex(env.ADMIN_PASSWORD || 'gazhp-rate-limit', s)).slice(0, 32);
}
/* One fixed-window counter in rate_limits: returns the hits so far in this
   window (0 if D1 is unavailable — callers then let the request through) and
   the seconds until the window ends. */
async function bumpCounter(env, key, windowMs) {
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  const wait = Math.max(1, Math.ceil((start + windowMs - Date.now()) / 1000));
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET hits = hits + 1
       RETURNING hits`).bind(`${key}|${start}`, start + windowMs).first();
    return { hits: (row && row.hits) || 0, wait };
  } catch (err) {
    console.error('rate limit unavailable', err);
    return { hits: 0, wait };
  }
}
/* True for the first event of its kind in the window, so a recurring
   configuration problem emails the admin once, not on every donor's attempt. */
async function firstInWindow(env, name, windowMs) {
  return (await bumpCounter(env, `once|${name}`, windowMs)).hits <= 1;
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
const PAY_COLS = ['id', 'dedupe_key', 'created_at', 'date', 'status', 'type', 'tier', 'amount', 'currency', 'method', 'ref', 'recurring', 'name', 'email', 'phone', 'country', 'profession', 'notes', 'source', 'designation'];

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
    // Only a known programme id; '' when not recorded (e.g. older imports) and for memberships.
    designation: p.type !== 'membership' && designationById(p.designation) ? p.designation : '',
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
  const { isNew } = await savePayment(env, { ...p, dedupe_key: key });
  if (p.status === 'paid' && (isNew || (prev && prev.status !== 'paid' && prev.status !== 'refunded'))) {
    const t = tierById(p.tier);
    const d = p.type !== 'membership' && designationById(p.designation);
    alertAdmin(env, ctx, `New ${p.type === 'membership' ? 'membership' : 'donation'}: ${p.currency} ${Number(p.amount).toFixed(2)} via ${p.method}`,
      [`Name: ${p.name || '—'}`, `Email: ${p.email || '—'}`, t ? `Tier: ${tierName(t)}` : '', d ? `For: ${d.label}` : '', `Reference: ${p.ref || '—'}`].filter(Boolean).join('\n'));
    await receiptOnce(env, ctx, 'dedupe_key', key);
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

const CHECKOUT_COLS = ['id', 'created_at', 'gateway', 'purpose', 'tier', 'amount', 'currency', 'recurring', 'name', 'email', 'phone', 'country', 'profession', 'designation', 'operator'];
async function insertCheckout(env, co) {
  await env.DB.prepare(`INSERT INTO checkouts (${CHECKOUT_COLS.join(', ')}) VALUES (${CHECKOUT_COLS.map(() => '?').join(',')})`)
    .bind(...CHECKOUT_COLS.map(c => co[c] ?? '')).run();
}

/* Sends one email through Resend. Resolves true once Resend accepted it. */
async function sendEmail(env, msg) {
  if (!emailReady(env)) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.FROM_EMAIL, ...msg }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return true;
    console.error('email failed', res.status, (await res.text().catch(() => '')).slice(0, 500));
  } catch (err) { console.error('email failed', err); }
  return false;
}
const adminEmails = env => (env.NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(isEmail);
function alertAdmin(env, ctx, subject, text, replyTo) {
  if (!emailReady(env) || !adminEmails(env).length) return;
  const msg = { to: adminEmails(env), subject: `[GAZHP] ${subject}`, text };
  if (replyTo && isEmail(replyTo)) msg.reply_to = replyTo;
  const send = sendEmail(env, msg);
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

/* =============================================================================
   Receipts — emailed to the donor / member when a payment first becomes paid.
   Donations get the 501(c)(3) acknowledgement; memberships a confirmation
   with tier and term and no tax-deductibility statement.
   ============================================================================= */
const RECURRING_NOTE = {
  month: 'Monthly gift — charged every month until you cancel.',
  year: 'Renews automatically every year until you cancel.',
};
function receiptEmail(env, p) {
  const isM = p.type === 'membership';
  const t = isM && tierById(p.tier);
  const d = !isM && designationById(p.designation);
  const site = siteUrl(env) || 'https://gazhphealth.org';
  const dateText = (() => {
    const dt = new Date(`${p.date}T12:00:00Z`);
    return isNaN(dt) ? p.date : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  })();
  const rows = isM
    ? [['Membership', t ? tierName(t) : 'GAZHP membership'],
       ['Term', p.recurring === 'year' ? `Annual — ${RECURRING_NOTE.year.toLowerCase()}` : 'Annual (one year of dues)'],
       ['Amount paid', money(p.amount, p.currency)]]
    : [['Amount', money(p.amount, p.currency)],
       ...(d ? [['Designation', d.label]] : []),
       ...(RECURRING_NOTE[p.recurring] ? [['Frequency', RECURRING_NOTE[p.recurring]]] : [])];
  rows.push(['Date', dateText], ['Method', p.method || '—'], ['Reference', p.ref || p.id]);

  const ein = str(env.ORG_EIN, 20);
  const legal = isM ? '' : `${ORG.short} is a registered US 501(c)(3) nonprofit${ein ? ` — EIN ${ein}` : ''}. No goods or services were provided in exchange for this contribution.`;
  const manage = p.recurring === 'month' || p.recurring === 'year'
    ? `To update your card, change or cancel ${isM ? 'automatic renewal' : 'your monthly gift'}, visit ${site}/manage-giving/.` : '';
  const hello = `Dear ${p.name || (isM ? 'member' : 'friend')},`;
  const intro = isM
    ? `Thank you for joining the ${ORG.name} (${ORG.short}). Your membership payment has been received.`
    : `Thank you for your gift to the ${ORG.name} (${ORG.short}).`;
  const heading = isM ? 'Membership confirmation' : 'Donation receipt';
  const footer = `Please keep this email for your records. Questions? ${site}/contact/`;

  const text = [hello, '', intro, '', heading, ...rows.map(([k, v]) => `${`${k}:`.padEnd(13)} ${v}`), '',
    ...(legal ? [legal, ''] : []), ...(manage ? [manage, ''] : []), footer, '', `— ${ORG.short}`, site].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e3df;border-radius:8px;padding:24px">
<p style="margin:0 0 12px">${htmlEsc(hello)}</p>
<p style="margin:0 0 20px">${htmlEsc(intro)}</p>
<h1 style="font-size:18px;margin:0 0 12px">${htmlEsc(heading)}</h1>
<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 20px">${rows.map(([k, v]) =>
  `<tr><td style="padding:6px 12px 6px 0;color:#5c5c57;white-space:nowrap;vertical-align:top">${htmlEsc(k)}</td><td style="padding:6px 0;font-weight:bold">${htmlEsc(v)}</td></tr>`).join('')}</table>
${legal ? `<p style="margin:0 0 16px">${htmlEsc(legal)}</p>` : ''}${manage ? `<p style="margin:0 0 16px">${htmlEsc(manage)}</p>` : ''}
<p style="margin:0 0 4px;color:#5c5c57;font-size:14px">${htmlEsc(footer)}</p>
<p style="margin:16px 0 0;font-size:14px">— ${htmlEsc(ORG.short)} · <a href="${htmlEsc(site)}">${htmlEsc(site.replace(/^https?:\/\//, ''))}</a></p>
</div></body></html>`;
  const subject = isM ? `Your ${ORG.short} membership is confirmed` : `Your ${ORG.short} donation receipt — ${money(p.amount, p.currency)}`;
  return { subject, text, html };
}
async function sendReceipt(env, p) {
  if (!isEmail(p.email || '')) return false;
  const msg = { to: [p.email], ...receiptEmail(env, p) };
  const replyTo = adminEmails(env)[0];
  if (replyTo) msg.reply_to = replyTo;
  return sendEmail(env, msg);
}
/* Sends the receipt at most once per payment. receipt_sent_at is claimed in one
   atomic UPDATE, so a webhook, the return page, the cron sweep, /momo/status and
   an admin confirming it at the same moment can't email the donor twice. If
   Resend refuses the email, the claim is released (an admin can resend). */
async function receiptOnce(env, ctx, col, value) {
  if (!emailReady(env) || !['id', 'dedupe_key'].includes(col)) return;
  const job = (async () => {
    const now = new Date().toISOString();
    const p = await env.DB.prepare(
      `UPDATE payments SET receipt_sent_at = ?
       WHERE ${col} = ? AND status = 'paid' AND receipt_sent_at IS NULL AND email LIKE '%_@_%'
       RETURNING *`).bind(now, value).first();
    if (!p || await sendReceipt(env, p)) return;
    await env.DB.prepare('UPDATE payments SET receipt_sent_at = NULL WHERE id = ? AND receipt_sent_at = ?').bind(p.id, now).run();
  })().catch(err => console.error('receipt', err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
}

/* =============================================================================
   Public config
   ============================================================================= */
function publicConfig(env) {
  const momoDirect = momoDirectOn(env);
  return {
    gateways: gatewaysOn(env),
    tiers: TIERS,
    donation: DONATION,
    zmwPerUsd: zmwPerUsd(env),
    offlineMethods: OFFLINE_METHODS,
    designations: DESIGNATIONS,
    // Phone-prompt mobile money (POST /momo/start). When false, the site keeps
    // sending mobile-money donors to DPO Pay's hosted page via /checkout.
    momoDirect,
    momoOperators: momoDirect ? momoOperators(env) : [],
    momoLimits: MOMO_LIMITS,
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
    designation: designationFor(purpose, b.designation), operator: '',
  };
  await insertCheckout(env, co);

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
  const meta = { checkout_id: co.id, purpose: co.purpose, tier: co.tier, designation: co.designation };
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
  // The description is printed on Stripe's own receipt emails, so for donations it carries the
  // IRS acknowledgement — Stripe's receipts then work as tax receipts even without Resend.
  const description = co.purpose === 'donation'
    ? `${label}. GAZHP is a registered US 501(c)(3) nonprofit${env.ORG_EIN ? ` (EIN ${env.ORG_EIN})` : ''}. No goods or services were provided in exchange for this contribution.`
    : label;
  if (recurringMode) params.subscription_data = { metadata: meta, description };
  else { params.submit_type = 'donate'; params.payment_intent_data = { description, metadata: meta }; }
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
        profession: co && co.profession, designation: (co && co.designation) || (o.metadata && o.metadata.designation),
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
        designation: (co && co.designation) || meta.designation,
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
    phone: co.phone, country: co.country, profession: co.profession, designation: co.designation,
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
    // token + GET + capture + (look up + save + alert + receipt claim + receipt email) + mark
    if (budget.left < 9) break;
    budget.left -= 9;
    try {
      const r = await paypalApi(env, `/v2/checkout/orders/${encodeURIComponent(co.gateway_ref)}`, { method: 'GET' });
      const status = r.ok ? r.data.status : '';
      let rec = null;
      if (status === 'APPROVED') rec = (await paypalCapture(env, ctx, co)).rec;
      else if (status === 'COMPLETED') rec = await paypalRecordOrder(env, ctx, r.data, co);
      if (!rec) {
        await markCheckout(env, co.id, status === 'VOIDED'); // CREATED / PAYER_ACTION_REQUIRED: donor hasn't approved yet
        budget.left += 6; // only token + GET + mark were used
      }
    } catch (err) { console.error('paypal sweep', err); }
  }
}

/* ------------------------------ DPO Pay ------------------------------------
   Zambia: MTN and Airtel mobile money (DPO lists no Zamtel for Zambia) and
   local & international cards. Docs: DPO Pay API v6 (XML),
   https://docs.dpopay.com/dpo-pay-by-network/
   Hosted flow (/checkout): createToken → donor pays on DPO's page → verifyToken (always).
   Phone-prompt flow (/momo/start, below): createToken → ChargeTokenMobile →
   the page polls /momo/status, which asks verifyToken.
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
  const res = await fetch(`${dpoBase(env)}/API/v6/`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8', accept: 'application/xml' },
    body,
    signal: AbortSignal.timeout(25000),
  });
  return res.text();
}
/* opts.mobile — a phone-prompt payment: a 30-minute payment time limit (so a
   stale prompt can't be approved much later; our choice, not a DPO rule), and
   DPO's page, if the donor ends up there, opens on mobile money. */
async function dpoCreate(env, co, label, apiBase, opts = {}) {
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
      <PTL>${opts.mobile ? 30 : 24}</PTL>
      <PTLtype>${opts.mobile ? 'minutes' : 'hours'}</PTLtype>
      <customerEmail>${xmlEsc(co.email)}</customerEmail>
      <customerFirstName>${xmlEsc(first)}</customerFirstName>
      <customerLastName>${xmlEsc(rest.join(' ') || first)}</customerLastName>
      ${phone ? `<customerPhone>${phone}</customerPhone>` : ''}
      ${opts.mobile ? '<customerCountry>ZM</customerCountry><DefaultPayment>MO</DefaultPayment>' : ''}
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
/* verifyToken result codes (DPO v6):
     000 paid · 002 over- or under-paid (money arrived, amount differs → admin review)
     001 authorized, 003 pending bank, 005 queued, 007 pending split, 900 not paid yet → keep waiting
     901 declined — not final: the donor can retry on DPO's page until the payment time limit
     902 data mismatch, 903 payment time limit passed, 904 cancelled → final */
const DPO_WAITING = ['001', '003', '005', '007', '900'];
/* Asks DPO for the real status — the redirect and push alone are never trusted.
   The cron sweep and /momo/status pass the checkout row they already have. */
async function verifyDpo(env, ctx, token, co = null) {
  co = co || await checkoutByRef(env, 'dpo', token);
  if (!co) return null;
  token = co.gateway_ref;
  const xml = await dpoApi(env, `<Request>verifyToken</Request><TransactionToken>${xmlEsc(token)}</TransactionToken>`);
  const result = xmlTag(xml, 'Result');
  if (result === '000' || result === '002') {
    // Guard against a mismatched amount/currency if DPO reports them.
    const amt = parseFloat(xmlTag(xml, 'TransactionAmount'));
    const cur = xmlTag(xml, 'TransactionCurrency');
    const ok = result === '000' && (!cur || cur.toUpperCase() === co.currency) && (isNaN(amt) || amt >= Number(co.amount) - 0.01);
    const method = xmlTag(xml, 'CustomerCreditType');
    await recordPayment(env, ctx, {
      source: 'dpo', method: 'DPO Pay', ref: token, status: ok ? 'paid' : 'pending',
      date: isoDate(xmlTag(xml, 'TransactionSettlementDate') || xmlTag(xml, 'TransactionCreatedDate') || undefined),
      amount: isNaN(amt) ? co.amount : amt, currency: (cur || co.currency).toUpperCase(), recurring: 'once',
      type: co.purpose, tier: co.tier, name: co.name || xmlTag(xml, 'CustomerName'), email: co.email,
      phone: co.phone || xmlTag(xml, 'CustomerPhone'), country: co.country || xmlTag(xml, 'CustomerCountry'),
      profession: co.profession, designation: co.designation,
      notes: [method, co.operator ? `${MOMO_NAMES[co.operator] || co.operator} phone prompt` : '',
        ok ? '' : result === '002' ? 'DPO reports an over- or under-payment (code 002) — check in DPO before confirming.'
          : 'Amount/currency did not match — check in DPO before confirming.'].filter(Boolean).join(' · '),
    });
    await markCheckout(env, co.id, true);
    return { co, status: ok ? 'paid' : 'pending', result };
  }
  // No payments row exists for an unpaid token (one is only written on 000/002),
  // so the outcome is kept on the checkout instead.
  if (DPO_WAITING.includes(result) || result === '901') {
    await markCheckout(env, co.id, false);
    return { co, status: result === '901' ? 'failed' : 'waiting', result };
  }
  if (['902', '903', '904'].includes(result)) {
    await markCheckout(env, co.id, true);
    return { co, status: 'failed', result };
  }
  console.error('dpo verifyToken', xml);
  await markCheckout(env, co.id, false);
  return { co, status: 'waiting', result };
}
async function dpoReturn(env, ctx, url) {
  const token = url.searchParams.get('TransactionToken') || url.searchParams.get('ID');
  const rec = await verifyDpo(env, ctx, token);
  if (!rec) return Response.redirect(cancelUrl(env, 'donation'), 302);
  if (rec.status === 'failed') return Response.redirect(cancelUrl(env, rec.co.purpose), 302);
  return Response.redirect(thanksUrl(env, 'dpo', rec.co.purpose, rec.status === 'paid' ? 'paid' : 'pending'), 302);
}
/* DPO "push" notification: we only read the token from it, then verify with DPO.
   DPO pushes successful payments only, to the URL registered on the merchant
   account, so failures and declines are picked up by polling and the sweep. */
async function dpoWebhook(request, env, ctx) {
  const body = await request.text();
  if (body.length > 50000) throw new HttpError(413, 'Request too large');
  const token = xmlTag(body, 'TransactionToken') || new URLSearchParams(body).get('TransactionToken');
  if (token) await verifyDpo(env, ctx, token);
  return new Response('<?xml version="1.0" encoding="utf-8"?><API3G><Response>OK</Response></API3G>', { headers: { 'content-type': 'application/xml' } });
}
/* Cron: re-check DPO checkouts that aren't settled yet. Tokens expire after the
   payment time limit (PTL in dpoCreate: 24 hours, 30 minutes for phone
   prompts), so only the last 26 hours are checked. Least-recently-checked first
   (round robin), so newer abandoned or bot-created checkouts can't push a real
   pending mobile-money payment out. */
async function dpoSweep(env, ctx, budget) {
  if (!gatewaysOn(env).dpo) return;
  budget.left -= 1;
  const { results } = await env.DB.prepare(
    `SELECT * FROM checkouts
     WHERE gateway = 'dpo' AND gateway_ref <> '' AND settled_at IS NULL AND created_at > ? AND created_at < ?
     ORDER BY checked_at IS NOT NULL, checked_at ASC LIMIT 10`).bind(isoAgo(26 * HOUR), isoAgo(5 * MINUTE)).all();
  for (const co of results) {
    // DPO call + (look up + save + alert + receipt claim + receipt email) + mark
    if (budget.left < 7) break;
    budget.left -= 7;
    try {
      const rec = await verifyDpo(env, ctx, co.gateway_ref, co);
      if (!rec || rec.status === 'waiting' || rec.status === 'failed') budget.left += 5; // only the DPO call + mark were used
    } catch (err) { console.error('dpo sweep', err); }
  }
}

/* ------------------- Mobile money: prompt on the donor's phone ----------------
   Prospero-style: the donor types their number on our page, DPO pushes a PIN
   prompt to the phone (ChargeTokenMobile), and the page polls /momo/status
   about every 5 seconds until verifyToken reports the outcome. On only when
   DPO_DIRECT_MOMO="true" and DPO is configured; GET /config reports momoDirect.

   From DPO's API reference: the ChargeTokenMobile fields (TransactionToken,
   PhoneNumber, MNO, MNOcountry); StatusCode 130 = request accepted / prompt
   sent, 955 = invalid phone number, 956 = terminal not found; and
   GetMobilePaymentOptions, which lists the MNO / country values valid for a token.
   NOT confirmed by DPO's docs — confirm with DPO before switching this on:
   - the MNO / MNOcountry strings for GAZHP's account. Pin them with
     DPO_MNO_MTN / DPO_MNO_AIRTEL / DPO_MNO_COUNTRY; otherwise they are read
     from GetMobilePaymentOptions for each payment;
   - the PhoneNumber format: '260' + 9 digits by default (DPO's example has the
     country code, no '+'); DPO_MSISDN_FORMAT=national sends the 9 digits only;
   - how an ignored or rejected prompt shows in verifyToken (901, or 900 until
     the time limit) — both are handled;
   - Zamtel: DPO lists only MTN and Airtel for Zambia, so Zamtel numbers are
     offered a prompt only if DPO_MNO_ZAMTEL is set.
   If DPO can't send the prompt for an account/configuration reason, the donor
   is offered DPO's hosted page for the same payment instead ({ fallback, url }).
   DPO has no mobile-money auto-debit, so these are one-time payments only.
   -------------------------------------------------------------------------- */
const MOMO_NAMES = { mtn: 'MTN MoMo', airtel: 'Airtel Money', zamtel: 'Zamtel Kwacha' };
const MOMO_OPERATORS = Object.keys(MOMO_NAMES);
// Zambian mobile ranges (ZICTA numbering plan): the first 2 of the 9 digits after +260 / 0.
const ZM_PREFIX = { 96: 'mtn', 76: 'mtn', 97: 'airtel', 77: 'airtel', 57: 'airtel', 95: 'zamtel', 75: 'zamtel' };
const MNO_ENV = { mtn: 'DPO_MNO_MTN', airtel: 'DPO_MNO_AIRTEL', zamtel: 'DPO_MNO_ZAMTEL' };
const momoDirectOn = env => String(env.DPO_DIRECT_MOMO || '').trim().toLowerCase() === 'true' && gatewaysOn(env).dpo;
const momoOperators = env => MOMO_OPERATORS.filter(op => op !== 'zamtel' || env.DPO_MNO_ZAMTEL);
const MOMO_MSG = {
  sent: 'Check your phone and enter your PIN to approve.',
  waiting: 'Waiting for you to approve the payment on your phone.',
  paid: 'Payment received. Thank you!',
  review: 'Your payment was received. Our team is confirming the amount.',
  declined: 'The payment was not approved. Check your balance and PIN, then try again.',
  closed: 'This payment request has expired or was cancelled. Please try again.',
};
/* 0971234567, 971234567, 260971234567, +260 97 123 4567, 00260… → { nsn, intl, operator } or null. */
function zmPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00260') && d.length === 14) d = d.slice(5);
  else if (d.startsWith('260') && d.length === 12) d = d.slice(3);
  else if (d.startsWith('0') && d.length === 10) d = d.slice(1);
  return /^[579]\d{8}$/.test(d) ? { nsn: d, intl: `260${d}`, operator: ZM_PREFIX[d.slice(0, 2)] || '' } : null;
}
/* The MNO / country strings this DPO account accepts for an operator. */
async function dpoMobileOption(env, token, op) {
  const fixed = env[MNO_ENV[op]];
  if (fixed) return { mno: fixed, country: env.DPO_MNO_COUNTRY || 'zambia' };
  const xml = await dpoApi(env, `<Request>GetMobilePaymentOptions</Request><TransactionToken>${xmlEsc(token)}</TransactionToken>`);
  const want = new RegExp(op, 'i');
  for (const m of String(xml).matchAll(/<mobileoption>([\s\S]*?)<\/mobileoption>/gi)) {
    // Sent back exactly as DPO returns them. (xmlTag 'country' doesn't match <countryCode>.)
    const name = xmlTag(m[1], 'paymentname'), country = xmlTag(m[1], 'country');
    if ((xmlTag(m[1], 'countryCode').toUpperCase() === 'ZM' || /zambia/i.test(country)) && want.test(name)) {
      return { mno: name, country: country || env.DPO_MNO_COUNTRY || 'zambia' };
    }
  }
  console.error('dpo GetMobilePaymentOptions: no option for', op, String(xml).slice(0, 1500));
  return null;
}
/* DPO's operator instructions as plain text. They may contain HTML (<br>);
   the page must show them with textContent, never as HTML. */
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function momoInstructions(xml) {
  return xmlTag(xml, 'instructions')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, '\n').replace(/<[^>]*>/g, '')
    // Entities left over from the HTML (e.g. "&amp;" or "&#39;"), decoded once tags are gone:
    // the page shows this with textContent, so decoded text can't become markup.
    .replace(/&(#\d{1,6}|#x[\da-f]{1,5}|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return HTML_ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 31 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 1500);
}
async function momoStart(request, env, ctx, url) {
  if (!momoDirectOn(env)) throw new HttpError(400, 'Phone payment prompts are not available right now. Please choose another payment method.');
  const b = await readJson(request, 8000);
  const purpose = b.purpose === 'membership' ? 'membership' : 'donation';
  const name = str(b.name, 120), email = str(b.email, 160).toLowerCase();
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const phone = zmPhone(b.phone);
  if (!phone) throw new HttpError(400, 'Please enter your Zambian mobile money number (10 digits, e.g. 09X XXX XXXX).');
  // The prefix only suggests the network; the donor's choice wins.
  const operator = MOMO_OPERATORS.includes(b.operator) ? b.operator : phone.operator;
  if (!operator) throw new HttpError(400, 'Please choose your mobile money network.');
  if (!momoOperators(env).includes(operator)) {
    throw new HttpError(400, `We can't send a payment prompt to ${MOMO_NAMES[operator]} yet. Please use an MTN or Airtel number, or pay by card or bank transfer.`);
  }
  if (b.recurring && b.recurring !== 'once') throw new HttpError(400, 'Recurring payments are available with card payments only.');
  if (b.currency && String(b.currency).toUpperCase() !== 'ZMW') throw new HttpError(400, 'Mobile money payments are in Kwacha (ZMW).');

  // Priced on the server, as in /checkout.
  let amount, tier = '', label;
  if (purpose === 'membership') {
    const t = tierById(b.tier);
    if (!t) throw new HttpError(400, 'Please choose a membership tier.');
    tier = t.id;
    if (t.currency === 'ZMW') amount = t.amount;
    else if (t.currency === 'USD' && zmwPerUsd(env) > 0) amount = Math.ceil(t.amount * zmwPerUsd(env));
    else throw new HttpError(400, 'Kwacha prices are not available right now. Please pay by card.');
    label = `GAZHP membership — ${tierName(t)}`;
  } else {
    amount = Math.round(parseFloat(b.amount) * 100) / 100;
    if (!(amount >= DONATION.min.ZMW) || amount > DONATION.max.ZMW) {
      throw new HttpError(400, `Please enter an amount between ${DONATION.min.ZMW} and ${DONATION.max.ZMW.toLocaleString('en-US')} ZMW.`);
    }
    label = 'Donation to GAZHP';
  }
  const lim = MOMO_LIMITS[operator];
  if (lim && amount > lim.max) {
    throw new HttpError(400, `${MOMO_NAMES[operator]} payments are limited to ZMW ${lim.max.toLocaleString('en-US')} each. For a larger amount please pay by card or bank transfer.`);
  }

  // Each request rings a phone: at most 5 prompts per number per 30 minutes.
  if ((await bumpCounter(env, `momo-phone|${await keyedHash(env, `phone|${phone.nsn}`)}`, 30 * MINUTE)).hits > 5) {
    throw new HttpError(429, 'Too many payment requests for this number. Please wait 30 minutes and try again.');
  }

  // "Try again" while an earlier prompt may still be approved: never ring a
  // second time blindly. If the earlier request (same number, purpose and amount,
  // last 15 minutes) has been paid meanwhile, or went out under 90 seconds ago
  // and is still waiting, the page keeps polling that one instead.
  const storedPhone = `+${phone.intl}`;
  const prior = await env.DB.prepare(
    `SELECT * FROM checkouts
     WHERE gateway = 'dpo' AND operator <> '' AND phone = ? AND purpose = ? AND amount = ?
       AND gateway_ref <> '' AND settled_at IS NULL AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`).bind(storedPhone, purpose, amount, isoAgo(15 * MINUTE)).first();
  if (prior) {
    let rec = null;
    try { rec = await verifyDpo(env, ctx, prior.gateway_ref, prior); } catch (err) { console.error('momo earlier attempt', err); }
    const recent = Date.now() - Date.parse(prior.created_at) < 90 * 1000;
    if (rec && (rec.status === 'paid' || rec.status === 'pending' || (rec.status === 'waiting' && recent))) {
      return json({
        reference: prior.id, status: 'pending', operator: prior.operator, instructions: '', pollAfterMs: 5000,
        message: rec.status === 'waiting' ? 'We already sent a request to your phone. Approve it there with your PIN.' : 'Your earlier payment came through. Confirming it now.',
      });
    }
  }

  const co = {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), gateway: 'dpo', purpose, tier, amount, currency: 'ZMW', recurring: 'once',
    name, email, phone: storedPhone, country: str(b.country, 80), profession: str(b.profession, 160),
    designation: designationFor(purpose, b.designation), operator,
  };
  await insertCheckout(env, co);
  const { redirect, gatewayRef: token } = await dpoCreate(env, co, label, url.origin, { mobile: true });
  await env.DB.prepare('UPDATE checkouts SET gateway_ref = ? WHERE id = ?').bind(token, co.id).run();
  const sent = (message, instructions = '') => json({ reference: co.id, status: 'pending', operator, message, instructions, pollAfterMs: 5000 });

  let opt;
  try { opt = await dpoMobileOption(env, token, operator); } catch (err) { console.error('dpo GetMobilePaymentOptions', err); }
  if (!opt) return momoFallback(env, ctx, co, redirect, `No ${MOMO_NAMES[operator]} option for Zambia in GetMobilePaymentOptions.`);

  let xml;
  try {
    xml = await dpoApi(env, `<Request>ChargeTokenMobile</Request><TransactionToken>${xmlEsc(token)}</TransactionToken>`
      + `<PhoneNumber>${env.DPO_MSISDN_FORMAT === 'national' ? phone.nsn : phone.intl}</PhoneNumber>`
      + `<MNO>${xmlEsc(opt.mno)}</MNO><MNOcountry>${xmlEsc(opt.country)}</MNOcountry>`);
  } catch (err) {
    // Timed out or dropped: DPO may still have sent the prompt, so let the page
    // poll; verifyToken (or the payment time limit) settles it either way.
    console.error('dpo ChargeTokenMobile', err);
    await markCheckout(env, co.id, false);
    return sent(`${MOMO_MSG.sent} If no prompt arrives within a minute, try again.`);
  }
  // v6 answers with StatusCode, v7 with Code; general API errors (8xx) may come as Result.
  const code = (xmlTag(xml, 'StatusCode') || xmlTag(xml, 'Code') || xmlTag(xml, 'Result')).replace(/^0+(?=\d{3}$)/, '');
  if (code === '130' && !/^(1|true)$/i.test(xmlTag(xml, 'RedirectOption'))) {
    await markCheckout(env, co.id, false); // also starts the 4-second throttle in /momo/status
    return sent(MOMO_MSG.sent, momoInstructions(xml));
  }
  if (code === '955') {
    await markCheckout(env, co.id, true); // no prompt went out: nothing to re-check
    throw new HttpError(400, `That number doesn't look like an active ${MOMO_NAMES[operator]} account. Check the number and the network, then try again.`);
  }
  // 952/953/956 (MNO, country or terminal not set up), 8xx, RedirectOption=1 (DPO
  // doesn't document where v6 returns that URL), anything unexpected.
  return momoFallback(env, ctx, co, redirect, `ChargeTokenMobile returned ${code || 'no status code'}: ${String(xml).slice(0, 800)}`);
}
/* DPO couldn't send the prompt: log it, email the admin at most once an hour,
   and offer DPO's hosted page for the same token. The checkout stays open, so
   the return page, push and sweep still record it if the donor pays there. */
async function momoFallback(env, ctx, co, url, detail) {
  console.error('momo fallback', detail);
  if (await firstInWindow(env, 'momo-fallback', HOUR)) {
    alertAdmin(env, ctx, 'Mobile money prompt failed — donors are offered the DPO Pay page instead',
      `DPO Pay could not send a payment prompt to a ${MOMO_NAMES[co.operator] || 'mobile money'} number.\n\n${detail}\n\n`
      + 'Check the DPO_MNO_* settings with DPO (see api/wrangler.toml), or set DPO_DIRECT_MOMO to "false" to send everyone to the DPO page.');
  }
  return json({ error: "We couldn't send a payment prompt to your phone. You can finish paying on DPO Pay's secure page instead.", fallback: true, url, reference: co.id }, 502);
}
/* Polled by the payment page. The reference (a random checkout id) is the only
   handle; no personal data is returned. Each look at DPO goes through
   verifyToken and recordPayment, so a payment is recorded and receipted once. */
async function momoStatus(request, env, ctx, url) {
  await rateLimit(request, env, '/momo/status');
  const id = str(url.searchParams.get('reference'), 64).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new HttpError(400, 'Missing or invalid payment reference.');
  const co = await getCheckout(env, id);
  if (!co || co.gateway !== 'dpo' || !co.operator) throw new HttpError(404, 'Payment not found.');
  const reply = (status, message) => json({ status, message }, 200, { 'cache-control': 'no-store' });
  if (!co.gateway_ref) return reply('failed', MOMO_MSG.closed);
  const pay = await env.DB.prepare('SELECT status FROM payments WHERE dedupe_key = ?').bind(`dpo|${co.gateway_ref}`.toLowerCase()).first();
  // A received payment under review still reads 'paid' to the donor, so they
  // aren't invited to pay a second time.
  if (pay) return pay.status === 'paid' ? reply('paid', MOMO_MSG.paid) : pay.status === 'pending' ? reply('paid', MOMO_MSG.review) : reply('failed', MOMO_MSG.closed);
  if (co.settled_at) return reply('failed', MOMO_MSG.closed);
  // At most one DPO call per checkout every 4 seconds, however often the page asks.
  if (co.checked_at && Date.now() - Date.parse(co.checked_at) < 4000) return reply('pending', MOMO_MSG.waiting);
  const rec = await verifyDpo(env, ctx, co.gateway_ref, co);
  if (!rec || rec.status === 'waiting') return reply('pending', MOMO_MSG.waiting);
  if (rec.status === 'paid') return reply('paid', MOMO_MSG.paid);
  if (rec.status === 'pending') return reply('paid', MOMO_MSG.review);
  return reply('failed', rec.result === '901' ? MOMO_MSG.declined : MOMO_MSG.closed);
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
    designation: designationFor(purpose, b.designation),
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
   Manage giving — a donor with a monthly gift or auto-renewing membership asks
   for a Stripe billing-portal link (update card, change or cancel). The link
   is only ever emailed to the address on the subscription, and the response
   is always { ok: true } and returned before any lookup, so it never reveals
   whether an address gives. Needs the customer portal saved once in Stripe
   (Settings → Billing → Customer portal).
   ============================================================================= */
async function manageGiving(request, env, ctx) {
  const b = await readJson(request, 2000);
  if (b.website) return json({ ok: true }); // honeypot field filled → bot
  const email = str(b.email, 160).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const job = sendGivingLinks(env, ctx, email).catch(err => console.error('manage giving', err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true });
}
async function sendGivingLinks(env, ctx, email) {
  if (!env.STRIPE_SECRET_KEY || !emailReady(env)) return;
  // Per address as well as per IP: at most 3 emails an hour to one inbox.
  if ((await bumpCounter(env, `manage-giving|${await keyedHash(env, `email|${email}`)}`, HOUR)).hits > 3) return;
  // Stripe's email filter is case-sensitive; Checkout sessions are created with
  // the lowercased address. Each subscription checkout makes its own customer.
  const customers = await stripeApi(env, `customers?email=${encodeURIComponent(email)}&limit=10`, null, 'GET');
  const returnUrl = `${siteUrl(env) || 'https://gazhphealth.org'}/donate/`;
  const links = [];
  for (const c of customers.data || []) {
    const subs = await stripeApi(env, `subscriptions?customer=${encodeURIComponent(c.id)}&status=all&limit=10`, null, 'GET');
    const list = (subs.data || []).filter(s => s.status !== 'incomplete_expired');
    if (!list.length) continue;
    let portal;
    try {
      portal = await stripeApi(env, 'billing_portal/sessions', { customer: c.id, return_url: returnUrl });
    } catch (err) {
      if (await firstInWindow(env, 'billing-portal', 24 * HOUR)) {
        alertAdmin(env, ctx, 'Manage-giving link failed',
          'A donor asked for a link to manage their recurring gift, but Stripe refused to create a customer-portal session.\n\n'
          + 'In Stripe, open Settings → Billing → Customer portal and save the settings (needed once in live mode). Details are in the Worker logs.');
      }
      return;
    }
    links.push({ url: portal.url, items: list.map(describeSubscription) });
    if (links.length >= 5) break;
  }
  if (!links.length) return;
  const site = siteUrl(env) || 'https://gazhphealth.org';
  const intro = `You asked to manage your recurring giving to ${ORG.short}. Use the secure Stripe link below to update your card, change or cancel. For your security the link expires soon; if it has, request a new one at ${site}/manage-giving/.`;
  const text = ['Hello,', '', intro, '',
    ...links.flatMap(l => [...l.items, l.url, '']),
    'If you did not ask for this, you can ignore this email; nothing changes.', '', `— ${ORG.short}`, site].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1b;padding:24px">
<p>Hello,</p><p>${htmlEsc(intro)}</p>
${links.map(l => `<p>${l.items.map(htmlEsc).join('<br>')}<br><a href="${htmlEsc(l.url)}" style="display:inline-block;margin-top:8px;padding:10px 16px;background:#1c5928;color:#ffffff;text-decoration:none;border-radius:6px">Manage this gift</a></p>`).join('')}
<p style="color:#5c5c57;font-size:14px">If you did not ask for this, you can ignore this email; nothing changes.</p>
<p style="font-size:14px">— ${htmlEsc(ORG.short)} · <a href="${htmlEsc(site)}">${htmlEsc(site.replace(/^https?:\/\//, ''))}</a></p></body></html>`;
  await sendEmail(env, { to: [email], subject: `Manage your recurring gift to ${ORG.short}`, text, html });
}
function describeSubscription(s) {
  const item = (s.items && s.items.data && s.items.data[0]) || {};
  const price = item.price || {};
  const what = s.metadata && s.metadata.purpose === 'membership' ? 'Membership' : 'Donation';
  const amount = price.unit_amount != null ? money(price.unit_amount / 100, String(price.currency || '').toUpperCase()) : '';
  const every = price.recurring && price.recurring.interval ? ` per ${price.recurring.interval}` : '';
  return `${what}${amount ? `: ${amount}${every}` : ''} (${String(s.status || '').replace(/_/g, ' ')})`;
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
    `SELECT id, date, status, type, tier, amount, currency, method, ref, recurring, name, email, phone, country, profession, notes, source, created_at,
            designation, receipt_sent_at
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
async function adminUpdate(request, env, ctx, id) {
  const b = await readJson(request, 10000);
  const fields = {};
  if (['paid', 'pending', 'failed', 'refunded'].includes(b.status)) fields.status = b.status;
  if (['donation', 'membership'].includes(b.type)) fields.type = b.type;
  if (b.tier !== undefined) fields.tier = tierById(b.tier) ? b.tier : '';
  if (b.designation !== undefined) fields.designation = designationById(b.designation) ? b.designation : '';
  for (const k of ['name', 'email', 'phone', 'country', 'profession', 'notes', 'method']) if (b[k] !== undefined) fields[k] = str(b[k], k === 'notes' ? 1000 : 160);
  if (fields.email) fields.email = fields.email.toLowerCase();
  if (b.amount !== undefined && parseFloat(b.amount) > 0) fields.amount = Math.round(parseFloat(b.amount) * 100) / 100;
  if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) fields.date = b.date;
  const keys = Object.keys(fields);
  if (!keys.length) throw new HttpError(400, 'Nothing to update.');
  // Confirming a payment (e.g. a reported bank transfer: pending → paid) emails
  // the donor's receipt; editing a payment that was already paid does not.
  const prev = fields.status === 'paid' ? await env.DB.prepare('SELECT status FROM payments WHERE id = ?').bind(id).first() : null;
  const r = await env.DB.prepare(`UPDATE payments SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => fields[k]), id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Payment not found.');
  const receiptQueued = !!(prev && prev.status !== 'paid' && emailReady(env)); // sent unless one already went out
  if (receiptQueued) await receiptOnce(env, ctx, 'id', id);
  return json({ ok: true, receiptQueued });
}
/* Sends (or re-sends) the donor's receipt for a paid payment. */
async function adminReceipt(env, id) {
  if (!emailReady(env)) throw new HttpError(503, 'Receipts need RESEND_API_KEY and FROM_EMAIL on the server.');
  const p = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first();
  if (!p) throw new HttpError(404, 'Payment not found.');
  if (p.status !== 'paid') throw new HttpError(400, 'Only paid payments get a receipt.');
  if (!isEmail(p.email || '')) throw new HttpError(400, 'This payment has no valid email address.');
  if (!(await sendReceipt(env, p))) throw new HttpError(502, 'The receipt email could not be sent. Please try again.');
  const sentAt = new Date().toISOString();
  await env.DB.prepare('UPDATE payments SET receipt_sent_at = ? WHERE id = ?').bind(sentAt, id).run();
  return json({ ok: true, receipt_sent_at: sentAt });
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
