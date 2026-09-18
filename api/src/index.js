/* =============================================================================
   GAZHP payments API — Cloudflare Worker
   -----------------------------------------------------------------------------
   Public:
     GET  /config                     tiers + which gateways are switched on
     POST /checkout                   start a Stripe / PayPal / Flutterwave payment
     POST /notify                     donor reports an offline payment (Zelle, bank…)
     GET  /paypal/return | /paypal/cancel
     GET  /flutterwave/return
   Webhooks (gateways → us):
     POST /webhooks/stripe | /webhooks/paypal | /webhooks/flutterwave
   Admin (Bearer token from /admin/login):
     POST   /admin/login
     GET    /admin/payments
     POST   /admin/payments           { records: [...] }  manual entry / CSV import
     PATCH  /admin/payments/:id       { status, type, tier, notes, … }
     DELETE /admin/payments/:id
   ============================================================================= */
import { TIERS, DONATION, OFFLINE_METHODS } from './config.js';

const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err && err.stack || err);
      return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
    }
  },
};

async function route(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (m === 'GET' && (p === '/' || p === '/health')) return json({ ok: true });
  if (m === 'GET' && p === '/config') return json(publicConfig(env));
  if (m === 'POST' && p === '/checkout') return checkout(request, env, url);
  if (m === 'POST' && p === '/notify') return notify(request, env, ctx);

  if (m === 'GET' && p === '/paypal/return') return paypalReturn(env, ctx, url);
  if (m === 'GET' && p === '/paypal/cancel') return Response.redirect(cancelUrl(env, url.searchParams.get('purpose')), 302);
  if (m === 'GET' && p === '/flutterwave/return') return flutterwaveReturn(env, ctx, url);

  if (m === 'POST' && p === '/webhooks/stripe') return stripeWebhook(request, env, ctx);
  if (m === 'POST' && p === '/webhooks/paypal') return paypalWebhook(request, env, ctx);
  if (m === 'POST' && p === '/webhooks/flutterwave') return flutterwaveWebhook(request, env, ctx);

  if (m === 'POST' && p === '/admin/login') return adminLogin(request, env);
  if (p.startsWith('/admin/')) {
    await requireAdmin(request, env);
    if (m === 'GET' && p === '/admin/payments') return adminList(env);
    if (m === 'POST' && p === '/admin/payments') return adminAdd(request, env);
    const idMatch = p.match(/^\/admin\/payments\/([\w-]+)$/);
    if (idMatch && m === 'PATCH') return adminUpdate(request, env, idMatch[1]);
    if (idMatch && m === 'DELETE') return adminDelete(env, idMatch[1]);
  }
  throw new HttpError(404, 'Not found');
}

/* =============================================================================
   Helpers
   ============================================================================= */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
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
const gatewaysOn = env => ({
  stripe: !!env.STRIPE_SECRET_KEY,
  paypal: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
  flutterwave: !!env.FLW_SECRET_KEY,
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

/* Insert, or — for a payment we already know — update its status.
   Never downgrades a paid payment back to pending. */
function upsertStmt(env, p) {
  const row = paymentRow(p);
  return env.DB.prepare(
    `INSERT INTO payments (${PAY_COLS.join(',')}) VALUES (${PAY_COLS.map(() => '?').join(',')})
     ON CONFLICT(dedupe_key) DO UPDATE SET status =
       CASE WHEN payments.status = 'paid' AND excluded.status = 'pending' THEN payments.status ELSE excluded.status END`
  ).bind(...PAY_COLS.map(c => row[c]));
}
async function recordPayment(env, ctx, p) {
  const before = await env.DB.prepare('SELECT status FROM payments WHERE dedupe_key = ?')
    .bind(paymentRow(p).dedupe_key).first();
  await upsertStmt(env, p).run();
  if (!before && p.status === 'paid') {
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

function alertAdmin(env, ctx, subject, text) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.FROM_EMAIL) return;
  const send = fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: env.NOTIFY_EMAIL.split(',').map(s => s.trim()), subject: `[GAZHP] ${subject}`, text }),
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
  if (!on[gateway]) throw new HttpError(400, 'That payment method is not available.');

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
    if (gateway === 'flutterwave' && currency === 'USD' && zmwPerUsd(env) > 0 && b.currency === 'ZMW') {
      amount = Math.ceil(amount * zmwPerUsd(env)); currency = 'ZMW';
    }
  } else {
    currency = str(b.currency || 'USD', 3).toUpperCase();
    if (!['USD', 'ZMW'].includes(currency)) throw new HttpError(400, 'Unsupported currency.');
    if (currency === 'ZMW' && gateway !== 'flutterwave') throw new HttpError(400, 'Kwacha payments are available through Mobile Money / Flutterwave.');
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
  else ({ redirect, gatewayRef } = await flutterwaveCreate(env, co, label, apiBase));

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
async function stripeApi(env, path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
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
    success_url: thanksUrl(env, 'stripe', co.purpose),
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
      if (o.amount_refunded >= o.amount) await setStatusByRef(env, 'stripe', [o.payment_intent, o.invoice], 'refunded');
      break;
    }
  }
  return json({ received: true });
}

/* ------------------------------ PayPal ------------------------------------ */
const paypalBase = env => env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
async function paypalToken(env) {
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) { console.error('paypal auth', JSON.stringify(data)); throw new HttpError(502, 'PayPal is unavailable. Please try another method.'); }
  return data.access_token;
}
async function paypalApi(env, path, { method = 'POST', body, headers = {} } = {}) {
  const token = await paypalToken(env);
  const res = await fetch(`${paypalBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
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
async function recordPaypalCapture(env, ctx, cap, customId, payer) {
  const co = await getCheckout(env, customId);
  if (!co) return null;
  const status = cap.status === 'COMPLETED' ? 'paid' : ['DECLINED', 'FAILED'].includes(cap.status) ? 'failed' : cap.status === 'REFUNDED' ? 'refunded' : 'pending';
  const payerName = payer && payer.name ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ') : '';
  await recordPayment(env, ctx, {
    source: 'paypal', method: 'PayPal', ref: cap.id, status, date: isoDate(cap.create_time),
    amount: parseFloat(cap.amount.value), currency: cap.amount.currency_code, recurring: 'once',
    type: co.purpose, tier: co.tier, name: co.name || payerName, email: co.email || (payer && payer.email_address),
    phone: co.phone, country: co.country, profession: co.profession,
  });
  return { co, status };
}
async function paypalReturn(env, ctx, url) {
  const orderId = url.searchParams.get('token');
  if (!orderId) return Response.redirect(cancelUrl(env, 'donation'), 302);
  let r = await paypalApi(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { headers: { 'PayPal-Request-Id': `cap-${orderId}` } });
  if (!r.ok) r = await paypalApi(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' }); // e.g. already captured
  const { pu, cap } = paypalCaptureFromOrder(r.data || {});
  if (!cap) return Response.redirect(cancelUrl(env, 'donation'), 302);
  const rec = await recordPaypalCapture(env, ctx, cap, cap.custom_id || pu.custom_id, r.data.payer);
  const purpose = rec ? rec.co.purpose : 'donation';
  return Response.redirect(thanksUrl(env, 'paypal', purpose, rec && rec.status === 'paid' ? 'paid' : 'pending'), 302);
}
async function paypalWebhook(request, env, ctx) {
  const body = await request.text();
  const event = JSON.parse(body || '{}');
  if (!env.PAYPAL_WEBHOOK_ID) throw new HttpError(400, 'PayPal webhook not configured');
  const h = k => request.headers.get(k);
  const v = await paypalApi(env, '/v1/notifications/verify-webhook-signature', { body: {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: event,
  } });
  if (!v.ok || v.data.verification_status !== 'SUCCESS') throw new HttpError(400, 'Invalid signature');
  const res = event.resource || {};
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
    await recordPaypalCapture(env, ctx, res, res.custom_id, null);
  } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    const up = (res.links || []).find(l => l.rel === 'up');
    const capId = up && up.href.split('/').pop();
    await setStatusByRef(env, 'paypal', [capId], 'refunded');
  }
  return json({ received: true });
}

/* ---------------------------- Flutterwave --------------------------------- */
async function flwApi(env, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.flutterwave.com/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${env.FLW_SECRET_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.status === 'success', data };
}
async function flutterwaveCreate(env, co, label, apiBase) {
  const r = await flwApi(env, '/payments', { method: 'POST', body: {
    tx_ref: co.id, amount: co.amount, currency: co.currency,
    redirect_url: `${apiBase}/flutterwave/return`,
    customer: { email: co.email, name: co.name, phonenumber: co.phone || undefined },
    customizations: { title: 'GAZHP', description: label, logo: `${siteUrl(env)}/images/logo.png` },
    meta: { purpose: co.purpose, tier: co.tier },
  } });
  if (!r.ok || !r.data.data || !r.data.data.link) {
    console.error('flutterwave create', JSON.stringify(r.data));
    throw new HttpError(502, 'Mobile money payments are unavailable right now. Please try another method.');
  }
  return { redirect: r.data.data.link, gatewayRef: co.id };
}
/* Always confirm with Flutterwave's API — never trust the redirect/webhook alone. */
async function verifyFlutterwave(env, ctx, transactionId) {
  if (!/^\d+$/.test(String(transactionId || ''))) return null;
  const r = await flwApi(env, `/transactions/${transactionId}/verify`);
  if (!r.ok) return null;
  const d = r.data.data;
  const co = await getCheckout(env, d.tx_ref);
  if (!co) return null;
  const valid = d.status === 'successful' && d.currency === co.currency && Number(d.amount) >= Number(co.amount) - 0.001;
  const status = valid ? 'paid' : d.status === 'failed' ? 'failed' : 'pending';
  const isMomo = /mobilemoney/i.test(d.payment_type || '');
  await recordPayment(env, ctx, {
    source: 'flutterwave', method: 'Flutterwave', ref: String(d.id), status, date: isoDate(d.created_at),
    amount: Number(d.amount), currency: d.currency, recurring: 'once', type: co.purpose, tier: co.tier,
    name: co.name || (d.customer && d.customer.name), email: co.email || (d.customer && d.customer.email),
    phone: co.phone || (d.customer && d.customer.phone_number), country: co.country, profession: co.profession,
    notes: isMomo ? 'Mobile money' : (d.payment_type || ''),
  });
  return { co, status };
}
async function flutterwaveReturn(env, ctx, url) {
  const q = url.searchParams;
  const co = await getCheckout(env, q.get('tx_ref'));
  const purpose = co ? co.purpose : 'donation';
  if (q.get('status') === 'cancelled') return Response.redirect(cancelUrl(env, purpose), 302);
  const rec = await verifyFlutterwave(env, ctx, q.get('transaction_id'));
  if (!rec) return Response.redirect(cancelUrl(env, purpose), 302);
  return Response.redirect(thanksUrl(env, 'flutterwave', purpose, rec.status === 'paid' ? 'paid' : 'pending'), 302);
}
async function flutterwaveWebhook(request, env, ctx) {
  if (!env.FLW_WEBHOOK_HASH || !safeEqual(request.headers.get('verif-hash') || '', env.FLW_WEBHOOK_HASH)) {
    throw new HttpError(401, 'Invalid signature');
  }
  const event = await readJson(request, 200000);
  const id = event.data && event.data.id;
  if (id) await verifyFlutterwave(env, ctx, id);
  return json({ received: true });
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
  await upsertStmt(env, {
    source: 'notify', status: 'pending', method, ref, date, amount, currency, type: purpose, tier,
    name, email, phone: b.phone, country: b.country, profession: b.profession, notes: b.notes,
    dedupe_key: ref ? `notify|${ref}|${email}`.toLowerCase() : undefined,
  }).run();
  alertAdmin(env, ctx, `Payment reported — please confirm: ${currency} ${amount.toFixed(2)} via ${method}`,
    `Name: ${name}\nEmail: ${email}\nReference: ${ref || '—'}\nDate sent: ${date}\n\nConfirm it in the dashboard once the money arrives.`);
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
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO payments (${PAY_COLS.join(',')}) VALUES (${PAY_COLS.map(() => '?').join(',')})`)
      .bind(...PAY_COLS.map(c => row[c])));
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
