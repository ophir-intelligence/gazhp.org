/* =============================================
   GAZHP — Admin dashboard (/dashboard/)
   Static, no server: data comes from CSV exports (Donorbox, Stripe,
   PayPal, DPO Pay…), manually recorded payments and an optional
   published Google Sheet. Records are kept in this browser's
   localStorage only — never uploaded anywhere.
   ============================================= */
(function () {
  'use strict';

  const CFG = window.GAZHP_CONFIG || {};
  const DC = CFG.dashboard || {};
  const TIERS = CFG.membershipTiers || [];
  const REPORT_CUR = DC.reportingCurrency || 'USD';
  const FX = DC.fxRates || { USD: 1 };
  const TERM = CFG.membershipTermMonths || 12;
  const REMIND_DAYS = CFG.renewalReminderDays || 30;
  const STORE_KEY = 'gazhp-dashboard-records-v1';
  const SAMPLE_KEY = 'gazhp-dashboard-sample-v1';
  const SESSION_KEY = 'gazhp-dashboard-unlocked';
  const TOKEN_KEY = 'gazhp-dashboard-token';
  // Automated mode: payments come from the GAZHP API (Stripe/PayPal/DPO Pay notifications).
  const API = typeof (CFG.api || {}).baseUrl === 'string' && CFG.api.baseUrl.trim() ? CFG.api.baseUrl.trim().replace(/\/+$/, '') : '';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const has = v => typeof v === 'string' && v.trim() !== '';
  const today = () => new Date().toISOString().slice(0, 10);

  const fmt = (n, cur = REPORT_CUR, digits = 0) => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n || 0); }
    catch { return esc(cur) + ' ' + (Number(n) || 0).toFixed(digits); } // unknown code (e.g. from a bad backup) — never raw HTML
  };
  const fmtCompact = n => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  };
  const toReport = r => {
    const rate = FX[(r.currency || REPORT_CUR).toUpperCase()];
    return rate == null ? null : r.amount * rate;
  };
  const fmtDate = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const addMonths = (iso, months) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + months, d));
    return dt.toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  /* =====================================================================
     LOCK SCREEN
     ===================================================================== */
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let started = false;
  function unlock() {
    if (started) return;
    started = true;
    $('#dash-lock').hidden = true;
    $('#dash-app').hidden = false;
    init();
  }

  const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  let signingOut = false;
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: 'Bearer ' + getToken(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      if (!signingOut) { // payments and messages load together: tell the admin only once
        signingOut = true;
        try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
        alert(data.error || 'Please sign in again.');
        location.reload();
      }
      throw new Error('signed out');
    }
    if (!res.ok) throw new Error(data.error || 'The payments server returned an error.');
    return data;
  }

  $('#lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#lock-err');
    if (API) {
      err.textContent = '';
      try {
        const res = await fetch(API + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#lock-pass').value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = data.error || 'Could not sign in.'; $('#lock-pass').select(); return; }
        try { sessionStorage.setItem(TOKEN_KEY, data.token); } catch {}
        unlock();
      } catch { err.textContent = 'Cannot reach the payments server. Check your connection.'; }
      return;
    }
    if (!window.crypto || !crypto.subtle) { err.textContent = 'Open this page over https:// (or localhost) to unlock.'; return; }
    const h = await sha256($('#lock-pass').value);
    if (h === DC.passcodeHash) {
      try { sessionStorage.setItem(SESSION_KEY, h); } catch {}
      unlock();
    } else {
      err.textContent = 'Incorrect passcode.';
      $('#lock-pass').select();
    }
  });
  $('#lock-btn').addEventListener('click', () => {
    try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch {}
    location.reload();
  });

  /* =====================================================================
     DATA STORE
     Record shape:
     { id, date:'YYYY-MM-DD', name, email, phone, country, amount, currency,
       type:'donation'|'membership', tier, method, ref, notes, source,
       designation?, receipt_sent_at? }
     status (API mode): 'paid' | 'pending' | 'failed' | 'refunded'
     source: 'stripe' | 'paypal' | 'dpo' | 'notify' | 'import' | 'manual' | 'sheet' | 'sample'
     designation: id of the programme a gift is for ('general', 'mental-health', …)
     receipt_sent_at (API mode): ISO time the receipt email went out, or null
     ===================================================================== */
  let local = [];      // API mode: server payments. Local mode: saved in this browser.
  let sheet = [];      // loaded from Google Sheet each visit
  let samples = [];    // demo data — kept in this browser only, never sent to the server
  let lastSync = null;
  let apiConfig = null; // API mode: GET /config (gateways, designations, momoDirect)
  const all = () => local.concat(sheet, samples);
  // Only settled money counts in totals and membership.
  const paid = () => all().filter(r => !r.status || r.status === 'paid');

  /* ---------- Gift designations ("Where should your gift go?") ----------
     The API's GET /config is the source of truth; this copy keeps labels
     readable before it loads and in local (no-API) mode. */
  const DESIGNATIONS_FALLBACK = [
    { id: 'general', label: 'Where it is needed most' },
    { id: 'mental-health', label: 'Addiction & Mental Health' },
    { id: 'cardiovascular', label: 'Cardiovascular Care' },
    { id: 'primary-care', label: 'Family Medicine & Primary Care' },
  ];
  const DESIG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const DESIG_NONE = '__none'; // filter value for gifts with no designation
  const cleanDesignations = list => Array.isArray(list)
    ? list.filter(d => d && DESIG_ID.test(String(d.id || ''))).map(d => ({ id: String(d.id), label: has(d.label) ? String(d.label) : String(d.id) }))
    : [];
  function designations() {
    const fromApi = cleanDesignations(apiConfig && apiConfig.designations);
    if (fromApi.length) return fromApi;
    const fromCfg = cleanDesignations(CFG.designations);
    return fromCfg.length ? fromCfg : DESIGNATIONS_FALLBACK;
  }
  const desigLabel = id => !id ? 'Not specified' : ((designations().find(d => d.id === id) || {}).label || id);
  // Designation UI appears once payments carry one: always in data from an API that
  // stores it, and in local mode only after a backup with designations is restored.
  const showDesignations = () => all().some(r => r.designation) || (!!API && local.some(r => 'designation' in r));
  // Receipt status is shown only when the API reports it (an older Worker doesn't).
  const receiptsTracked = () => !!API && local.some(r => 'receipt_sent_at' in r);
  // Rows that live in the payments database (not demo rows or Google Sheet rows).
  const isServerRecord = r => !!API && r.source !== 'sample' && r.source !== 'sheet';
  const fmtStamp = (iso, long) => {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    return new Date(t).toLocaleString('en-US', long
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
  };

  async function load() {
    try { samples = JSON.parse(localStorage.getItem(SAMPLE_KEY) || '[]'); } catch { samples = []; }
    if (API) {
      const data = await api('/admin/payments');
      local = (data.payments || []).map(r => ({ ...r, amount: Number(r.amount) }));
      lastSync = new Date();
      return;
    }
    try { local = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { local = []; }
  }
  function save() {
    try {
      localStorage.setItem(SAMPLE_KEY, JSON.stringify(samples));
      if (!API) localStorage.setItem(STORE_KEY, JSON.stringify(local));
      return true;
    } catch { banner('warn', 'Could not save in this browser (storage is blocked or full). Download a backup so nothing is lost.'); return false; }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dedupeKey = r => r.ref ? (r.method + '|' + r.ref).toLowerCase()
    : [r.date, (r.email || r.name || '').toLowerCase(), r.amount, r.currency].join('|');

  async function addRecords(recs, source) {
    if (source === 'sample') {
      samples = recs.map(r => ({ ...r, id: uid(), source }));
      save();
      return { added: samples.length, dup: 0 };
    }
    if (API) {
      const res = await api('/admin/payments', { method: 'POST', body: { source, records: recs } });
      await load();
      return { added: res.added, dup: res.duplicates };
    }
    const seen = new Set(all().map(dedupeKey));
    let added = 0, dup = 0;
    recs.forEach(r => {
      const k = dedupeKey(r);
      if (seen.has(k)) { dup++; return; }
      seen.add(k);
      local.push({ ...r, id: uid(), source });
      added++;
    });
    save();
    return { added, dup };
  }
  async function deleteRecord(id) {
    if (samples.some(r => r.id === id)) { samples = samples.filter(r => r.id !== id); save(); return; }
    if (API) { await api('/admin/payments/' + encodeURIComponent(id), { method: 'DELETE' }); local = local.filter(r => r.id !== id); return; }
    local = local.filter(r => r.id !== id); save();
  }
  async function setStatus(id, status) {
    if (API) await api('/admin/payments/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
    const r = local.find(x => x.id === id);
    if (r) r.status = status;
    save();
  }

  /* =====================================================================
     CSV
     ===================================================================== */
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }
  function toCSV(rows) {
    return rows.map(r => r.map(v => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s; // guard against spreadsheet formula injection
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }
  function download(filename, text) {
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Column mapping for exports from different gateways ---------- */
  const ALIASES = {
    date: ['date', 'donated at', 'donation date', 'created (utc)', 'created date (utc)', 'created', 'created at', 'transaction date', 'payment date', 'paid at', 'date paid', 'date received', 'timestamp'],
    name: ['name', 'full name', 'donor name', 'customer name', 'customer', 'payer name', 'member name', 'from'],
    first: ['first name', 'donor first name', 'customer first name', 'first'],
    last: ['last name', 'donor last name', 'customer last name', 'last'],
    email: ['email', 'donor email', 'customer email', 'from email address', 'email address', 'payer email', 'customer email address'],
    phone: ['phone', 'phone number', 'donor phone', 'customer phone', 'mobile', 'contact phone number'],
    country: ['country', 'donor country', 'address country', 'billing country', 'card issue country', 'country code'],
    amount: ['amount', 'gross', 'amount paid', 'donation amount', 'amount charged', 'total', 'charged amount', 'amount (usd)'],
    currency: ['currency', 'donation currency', 'charged currency'],
    status: ['status', 'payment status', 'transaction status'],
    ref: ['reference', 'transaction id', 'tx_ref', 'transaction reference', 'donation id', 'payment intent id', 'paymentintent id', 'id', 'payment id', 'transaction token', 'transtoken', 'company ref', 'receipt id', 'receipt number', 'ref'],
    method: ['method', 'gateway', 'payment method', 'payment type', 'payment processor', 'processor'],
    type: ['type', 'kind', 'category'],
    tier: ['tier', 'membership tier', 'membership', 'level', 'plan'],
    campaign: ['campaign', 'campaign name', 'description', 'item title', 'designation', 'form', 'purpose', 'product', 'product name', 'narration'],
    notes: ['notes', 'note', 'comment', 'donor comment', 'message'],
  };
  function mapHeaders(headers) {
    const norm = headers.map(h => h.trim().toLowerCase());
    const map = {};
    for (const [key, list] of Object.entries(ALIASES)) {
      for (const alias of list) {
        const i = norm.indexOf(alias);
        if (i !== -1 && !Object.values(map).includes(i)) { map[key] = i; break; }
      }
    }
    // "Amount (USD)" style headers
    if (map.amount == null) { const i = norm.findIndex(h => h.startsWith('amount')); if (i !== -1) map.amount = i; }
    return map;
  }
  function detectSource(headers) {
    const h = headers.map(x => x.trim().toLowerCase()).join('|');
    if (h.includes('donor email') || h.includes('donorbox') || h.includes('donated at')) return 'Donorbox';
    if (h.includes('from email address') || (h.includes('gross') && h.includes('balance'))) return 'PayPal';
    if (h.includes('created date (utc)') || h.includes('created (utc)') || h.includes('payment intent')) return 'Stripe';
    if (h.includes('transaction token') || h.includes('transtoken') || h.includes('company ref') || h.includes('dpo')) return 'DPO Pay';
    return null;
  }

  function parseDate(s) {
    s = String(s || '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) {
      let [, a, b, y] = m;
      if (y.length === 2) y = '20' + y;
      // US exports are month/day; if first number > 12 it must be day/month.
      let mo = +a, d = +b;
      if (mo > 12) [mo, d] = [d, mo];
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  }
  function parseAmount(s) {
    s = String(s || '').trim();
    const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d.,\-()]/g, ''));
    const cleaned = s.replace(/[^\d.,]/g, '');
    // "1.234,56" (EU) vs "1,234.56" (US)
    let num = /,\d{2}$/.test(cleaned) && !/\.\d{2}$/.test(cleaned)
      ? parseFloat(cleaned.replace(/\./g, '').replace(',', '.'))
      : parseFloat(cleaned.replace(/,/g, ''));
    if (isNaN(num)) return null;
    return neg ? -num : num;
  }
  function currencyFrom(s, fallback) {
    const m = String(s || '').toUpperCase().match(/\b(USD|ZMW|ZMK|GBP|EUR|CAD|AUD|ZAR|KES|NGN|BWP)\b/);
    if (m) return m[1] === 'ZMK' ? 'ZMW' : m[1];
    if (/£/.test(s)) return 'GBP';
    if (/€/.test(s)) return 'EUR';
    if (/\bK\s?\d/.test(s)) return 'ZMW';
    return fallback;
  }
  const BAD_STATUS = /fail|refund|cancel|declin|denied|pending|incomplete|void|revers|dispute|unpaid|abandon|error/i;

  function matchTier(text, amount, currency) {
    const t = String(text || '').toLowerCase();
    if (t) {
      const byId = TIERS.find(x => t === x.id);
      if (byId) return byId.id;
      const developing = /develop(ing)?\b|zambia|africa|low/.test(t) && !/developed/.test(t);
      const kind = /corporat/.test(t) ? 'corporate' : /student/.test(t) ? 'student' : /professional|pro\b/.test(t) ? 'professional' : null;
      if (kind === 'corporate') return (TIERS.find(x => x.id.startsWith('corporate')) || {}).id || '';
      if (kind) {
        const cands = TIERS.filter(x => x.id.startsWith(kind));
        const pick = cands.find(x => amount != null && Math.abs(x.amount * (FX[x.currency] ?? 1) - amount * (FX[(currency || 'USD').toUpperCase()] ?? 1)) < 1)
          || cands.find(x => developing ? x.id.endsWith('developing') : x.id.endsWith('developed')) || cands[0];
        if (pick) return pick.id;
      }
    }
    if (amount != null) {
      const usd = amount * (FX[(currency || 'USD').toUpperCase()] ?? 1) / (FX.USD ?? 1);
      const hit = TIERS.find(x => Math.abs(x.amount * (FX[x.currency] ?? 1) / (FX.USD ?? 1) - usd) < 1);
      if (hit) return hit.id;
    }
    return '';
  }
  function classify(rec, rawType, campaign, tierText) {
    const memCampaign = ((CFG.gateways || {}).donorbox || {}).membershipCampaign || '';
    const hay = [rawType, campaign, tierText, rec.ref, rec.notes].join(' ').toLowerCase();
    const isMember = has(tierText) || /member|dues|\bjoin/.test(hay) || /gazhp-m-/.test(hay)
      || (memCampaign && hay.includes(memCampaign.toLowerCase().replace(/-/g, ' '))) || (memCampaign && hay.includes(memCampaign.toLowerCase()));
    if (isMember) {
      rec.type = 'membership';
      rec.tier = matchTier(tierText || campaign || rawType, rec.amount, rec.currency);
    } else {
      rec.type = 'donation';
      rec.tier = '';
    }
    return rec;
  }

  function rowsToRecords(rows, sourceHint) {
    if (rows.length < 2) return { records: [], skipped: 0, source: sourceHint || 'Other', error: 'The file has no data rows.' };
    const headers = rows[0];
    const map = mapHeaders(headers);
    const source = (sourceHint && sourceHint !== 'auto') ? sourceHint : (detectSource(headers) || 'Other');
    if (map.amount == null || map.date == null) {
      return { records: [], skipped: rows.length - 1, source, error: 'Could not find a date and an amount column. Rename them to "Date" and "Amount" and try again.' };
    }
    const get = (row, k) => map[k] != null ? (row[map[k]] ?? '').trim() : '';
    const records = [];
    let skipped = 0;
    rows.slice(1).forEach(row => {
      const status = get(row, 'status');
      const rawAmount = get(row, 'amount');
      const amount = parseAmount(rawAmount);
      const date = parseDate(get(row, 'date'));
      if (!date || amount == null || amount <= 0 || (status && BAD_STATUS.test(status))) { skipped++; return; }
      // PayPal activity exports include transfers/fees — keep only incoming payments.
      const rawType = get(row, 'type');
      if (source === 'PayPal' && rawType && /withdraw|transfer|fee|hold|conversion|reserve/i.test(rawType)) { skipped++; return; }
      const name = get(row, 'name') || [get(row, 'first'), get(row, 'last')].filter(Boolean).join(' ');
      const rec = {
        date, amount: Math.round(amount * 100) / 100,
        currency: (currencyFrom(get(row, 'currency'), '') || currencyFrom(rawAmount, '') || REPORT_CUR),
        name, email: get(row, 'email').toLowerCase(), phone: get(row, 'phone'), country: get(row, 'country'),
        method: normalizeMethod(get(row, 'method'), source),
        ref: get(row, 'ref'), notes: get(row, 'notes'),
      };
      records.push(classify(rec, rawType, get(row, 'campaign'), get(row, 'tier')));
    });
    return { records, skipped, source };
  }
  function normalizeMethod(m, source) {
    // An export from a known gateway is attributed to that gateway, whatever card/wallet the payer used.
    if (source && !['Other', 'Mobile Money', 'Bank transfer'].includes(source)) return source;
    const s = String(m || '').toLowerCase();
    if (!s) return source || 'Other';
    if (/mtn/.test(s)) return 'Mobile Money — MTN';
    if (/airtel/.test(s)) return 'Mobile Money — Airtel';
    if (/zamtel/.test(s)) return 'Mobile Money — Zamtel';
    if (/mobile|momo|mpesa/.test(s)) return 'Mobile Money';
    if (/paypal/.test(s)) return 'PayPal';
    if (/stripe/.test(s)) return 'Stripe';
    if (/dpo|directpay|3g ?direct/.test(s)) return 'DPO Pay';
    if (/donorbox/.test(s)) return 'Donorbox';
    if (/zelle/.test(s)) return 'Zelle';
    if (/venmo/.test(s)) return 'Venmo';
    if (/cash ?app/.test(s)) return 'Cash App';
    if (/bank|wire|ach|transfer|eft/.test(s)) return 'Bank transfer';
    if (/cheque|check/.test(s)) return 'Check';
    return m.trim().replace(/\b\w/g, c => c.toUpperCase());
  }

  /* =====================================================================
     DERIVED DATA
     ===================================================================== */
  function membersFrom(records) {
    const byKey = new Map();
    records.filter(r => r.type === 'membership').forEach(r => {
      const key = (r.email || r.name || r.ref || r.id).toLowerCase();
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { ...r, first: r.date, payments: 1, total: toReport(r) || 0 });
      else {
        cur.payments++;
        cur.total += toReport(r) || 0;
        if (r.date < cur.first) cur.first = r.date;
        if (r.date >= cur.date) Object.assign(cur, { date: r.date, tier: r.tier || cur.tier, name: r.name || cur.name, phone: r.phone || cur.phone, country: r.country || cur.country, method: r.method });
      }
    });
    const t = today();
    return [...byKey.values()].map(m => {
      const expires = addMonths(m.date, TERM);
      const left = daysBetween(t, expires);
      const status = left < 0 ? 'expired' : left <= REMIND_DAYS ? 'expiring' : 'active';
      return { ...m, lastPaid: m.date, expires, daysLeft: left, status };
    }).sort((a, b) => a.expires.localeCompare(b.expires));
  }
  const tierLabel = id => { const t = TIERS.find(x => x.id === id); return t ? `${t.name} — ${t.region}` : (id || 'Unassigned'); };
  const tierShort = id => { const t = TIERS.find(x => x.id === id); return t ? `${t.name.replace(/ Member$/, '')} · ${t.region}` : 'Unassigned'; };
  const inYear = (r, y) => y === 'all' ? true : y === '12m' ? r.date >= addMonths(today(), -12) : r.date.startsWith(y);
  const sum = recs => recs.reduce((s, r) => s + (toReport(r) || 0), 0);

  /* =====================================================================
     UI: tabs & banner
     ===================================================================== */
  let tab = 'overview';
  function showTab(name) {
    tab = name;
    $$('.dash-tabs button').forEach(b => { b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name); });
    $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
    render();
    try { history.replaceState(null, '', '#' + name); } catch {}
  }
  function banner(kind, html) {
    const icon = kind === 'warn' ? '#i-alert' : '#i-check';
    $('#dash-banner').innerHTML = html ? `<div class="dash-banner ${kind}"><svg class="icon" aria-hidden="true"><use href="${icon}"/></svg><div>${html}</div></div>` : '';
  }
  // Short-lived status message (role="status", so screen readers announce it).
  let toastTimer;
  function toast(text, kind = 'ok') {
    const el = $('#dash-toast');
    if (!el) { if (kind === 'bad') alert(text); return; }
    clearTimeout(toastTimer);
    el.className = 'dash-toast show ' + (kind === 'bad' ? 'bad' : 'ok');
    el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${kind === 'bad' ? '#i-alert' : '#i-check'}"/></svg><span>${esc(text)}</span>`;
    toastTimer = setTimeout(() => { el.className = 'dash-toast'; el.innerHTML = ''; }, kind === 'bad' ? 9000 : 5000);
  }
  function statusBanner() {
    const missingFx = [...new Set(all().map(r => (r.currency || '').toUpperCase()).filter(c => c && FX[c] == null))];
    const msgs = [];
    if (!API && DC.passcodeHash === '0a8b1e2c3e5690de87df39b4e36e01f91f44327ba59483b68424e7f13ec63e8c')
      msgs.push('You are using the default passcode. Change it in <a href="#setup" data-goto="setup">Setup</a>.');
    if (missingFx.length) msgs.push(`No exchange rate for ${missingFx.map(esc).join(', ')} — add it to <code>dashboard.fxRates</code> so these payments are counted in totals.`);
    if (samples.length) msgs.push('Sample data is loaded. Remove it in <a href="#setup" data-goto="setup">Setup</a> before using real figures.');
    banner(msgs.length ? 'warn' : '', msgs.join('<br>'));
  }

  /* =====================================================================
     CHARTS (inline SVG — no libraries)
     ===================================================================== */
  const tip = $('#chart-tip');
  function showTip(e, html) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  // Round step (1, 2, 5 × 10^n) giving about 4 gridlines.
  function niceScale(v) {
    if (v <= 0) return { max: 1, step: 1 };
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    return { max: Math.ceil(v / step) * step, step };
  }
  // Bar with 4px rounded top, square at the baseline.
  function topRoundedBar(x, y, w, h, r = 4) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function rightRoundedBar(x, y, w, h, r = 4) {
    r = Math.min(r, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  const SERIES = [
    { key: 'donation', label: 'Donations', color: 'var(--series-1)' },
    { key: 'membership', label: 'Membership', color: 'var(--series-2)' },
  ];

  function monthBuckets(records, period) {
    let months = [];
    if (period === 'all' || period === '12m') {
      const end = today().slice(0, 7);
      let start = period === '12m' ? addMonths(today(), -11).slice(0, 7) : (records.map(r => r.date).sort()[0] || today()).slice(0, 7);
      if (period === 'all') { // cap the all-time view at 24 months
        const min = addMonths(today(), -23).slice(0, 7);
        if (start < min) start = min;
      }
      for (let m = start; m <= end; m = addMonths(m + '-01', 1).slice(0, 7)) months.push(m);
    } else {
      for (let i = 1; i <= 12; i++) months.push(`${period}-${String(i).padStart(2, '0')}`);
    }
    return months.map(m => {
      const rs = records.filter(r => r.date.startsWith(m));
      return { month: m, donation: sum(rs.filter(r => r.type === 'donation')), membership: sum(rs.filter(r => r.type === 'membership')) };
    });
  }
  const monthLabel = (m, long) => new Date(+m.slice(0, 4), +m.slice(5) - 1, 1).toLocaleDateString('en-US', long ? { month: 'long', year: 'numeric' } : { month: 'short' });

  function drawMonthChart(el, buckets) {
    $('#month-legend').innerHTML = SERIES.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    const total = buckets.reduce((s, b) => s + b.donation + b.membership, 0);
    if (!total) { el.innerHTML = '<p class="chart-empty">No payments in this period yet.</p>'; $('#month-table').innerHTML = ''; return; }
    const W = 640, H = 260, L = 48, R = 8, T = 12, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const { max, step } = niceScale(Math.max(...buckets.map(b => b.donation + b.membership)));
    const n = buckets.length, slot = iw / n, bw = Math.max(4, Math.min(28, slot * 0.6));
    const y = v => T + ih - (v / max) * ih;
    const ticks = [];
    for (let t = 0; t <= max + step / 2; t += step) ticks.push(t);
    const every = Math.ceil(n / 12);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money received by month, donations and membership stacked">`;
    ticks.forEach(t => {
      svg += `<line class="${t ? 'grid-line' : 'base-line'}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`;
      svg += `<text class="axis-text" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmtCompact(t)}</text>`;
    });
    buckets.forEach((b, i) => {
      const cx = L + slot * i + slot / 2, x = cx - bw / 2;
      const hD = (b.donation / max) * ih, hM = (b.membership / max) * ih;
      const gap = hD > 0 && hM > 0 ? 2 : 0;
      svg += `<g class="bar" data-i="${i}">`;
      svg += `<rect class="hit" x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}"/>`;
      if (hD > 0) svg += hM > 0
        ? `<rect class="mark" x="${x}" y="${T + ih - hD}" width="${bw}" height="${hD}" fill="${SERIES[0].color}"/>`
        : `<path class="mark" d="${topRoundedBar(x, T + ih - hD, bw, hD)}" fill="${SERIES[0].color}"/>`;
      if (hM > 0) svg += `<path class="mark" d="${topRoundedBar(x, T + ih - hD - gap - hM, bw, Math.max(hM - 0, 1))}" fill="${SERIES[1].color}"/>`;
      if (i % every === 0) svg += `<text class="axis-text" x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(b.month)}</text>`;
      svg += `</g>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
    $$('.bar', el).forEach(g => {
      const b = buckets[+g.dataset.i];
      g.addEventListener('mousemove', e => showTip(e, `<strong>${monthLabel(b.month, true)}</strong>` +
        SERIES.map(s => `<div class="tip-row"><span><i style="background:${s.color}"></i>${s.label}</span><span>${fmt(b[s.key])}</span></div>`).join('') +
        `<div class="tip-row"><span>Total</span><span><b>${fmt(b.donation + b.membership)}</b></span></div>`));
      g.addEventListener('mouseleave', hideTip);
    });
    $('#month-table').innerHTML = `<table class="dtable"><thead><tr><th>Month</th><th class="num">Donations</th><th class="num">Membership</th><th class="num">Total</th></tr></thead><tbody>${
      buckets.map(b => `<tr><td>${monthLabel(b.month, true)}</td><td class="num">${fmt(b.donation)}</td><td class="num">${fmt(b.membership)}</td><td class="num">${fmt(b.donation + b.membership)}</td></tr>`).join('')}</tbody></table>`;
  }

  // Single-series horizontal bars with direct value labels.
  function drawHBars(el, items, { valueFmt = v => fmt(v), label = 'value', color = 'var(--series-1)', tipFmt } = {}) {
    items = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
    if (!items.length) { el.innerHTML = '<p class="chart-empty">Nothing to show yet.</p>'; return; }
    if (items.length > 8) {
      const rest = items.slice(7);
      items = items.slice(0, 7).concat([{ name: 'Other', value: rest.reduce((s, i) => s + i.value, 0), count: rest.reduce((s, i) => s + (i.count || 0), 0) }]);
    }
    // Render at the container's real width so text stays at its true size.
    // Label sits above each bar, so long names never get truncated.
    const W = Math.max(260, Math.round(el.clientWidth || 420)), rowH = 42, valW = 70, T = 2, bh = 14;
    const H = T + items.length * rowH;
    const max = Math.max(...items.map(i => i.value));
    const iw = W - valW;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
    items.forEach((it, i) => {
      const yy = T + i * rowH, by = yy + 20;
      const w = Math.max(2, (it.value / max) * iw);
      svg += `<g class="hb" data-i="${i}"><rect class="hit" x="0" y="${yy}" width="${W}" height="${rowH}"/>`;
      svg += `<text class="axis-text" x="0" y="${yy + 13}">${esc(it.name)}</text>`;
      svg += `<path class="mark" d="${rightRoundedBar(0, by, w, bh)}" fill="${color}"/>`;
      svg += `<text class="val-text" x="${w + 8}" y="${by + bh - 2}">${esc(valueFmt(it.value))}</text></g>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
    $$('.hb', el).forEach(g => {
      const it = items[+g.dataset.i];
      g.addEventListener('mousemove', e => showTip(e, `<strong>${esc(it.name)}</strong>${tipFmt ? tipFmt(it) : esc(valueFmt(it.value))}`));
      g.addEventListener('mouseleave', hideTip);
    });
  }

  /* =====================================================================
     RENDER: OVERVIEW
     ===================================================================== */
  function yearOptions(sel, includeAll = true) {
    const years = [...new Set(all().map(r => r.date.slice(0, 4)))].sort().reverse();
    const cy = today().slice(0, 4);
    if (!years.includes(cy)) years.unshift(cy);
    const cur = sel.value;
    sel.innerHTML = `<option value="12m">Last 12 months</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('') + (includeAll ? '<option value="all">All time</option>' : '');
    sel.value = cur && [...sel.options].some(o => o.value === cur) ? cur : '12m';
  }

  function renderOverview() {
    const sel = $('#ov-year');
    yearOptions(sel);
    const period = sel.value;
    const recs = paid().filter(r => inYear(r, period));
    const dons = recs.filter(r => r.type === 'donation');
    const mems = recs.filter(r => r.type === 'membership');
    const members = membersFrom(paid());
    const active = members.filter(m => m.status !== 'expired');
    const expiring = members.filter(m => m.status === 'expiring');
    const donors = new Set(dons.map(r => (r.email || r.name).toLowerCase())).size;
    const periodName = period === '12m' ? 'last 12 months' : period === 'all' ? 'all time' : period;

    renderPending();
    if (!all().length) {
      $('#kpis').innerHTML = '';
      $('#goal').innerHTML = '';
      $('#month-chart').innerHTML = `<div class="empty-state">No payments yet.<br>Import CSV exports from your payment providers, record a payment, or try sample data.<br>
        <button class="btn btn-teal btn-sm" data-goto="import">Import data</button> <button class="btn btn-outline-dark btn-sm" data-goto="setup">Try sample data</button></div>`;
      $('#month-legend').innerHTML = ''; $('#month-table').innerHTML = '';
      ['#method-chart', '#tier-chart', '#desig-chart', '#recent'].forEach(s => { $(s).innerHTML = '<p class="chart-empty">Nothing to show yet.</p>'; });
      $('#desig-card').hidden = true;
      return;
    }

    const kpi = (label, value, sub) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
    $('#kpis').innerHTML =
      kpi('Total received', fmt(sum(recs)), `${recs.length} payments · ${esc(periodName)}`) +
      kpi('Donations', fmt(sum(dons)), `${dons.length} gifts from ${donors} donor${donors === 1 ? '' : 's'}`) +
      kpi('Membership dues', fmt(sum(mems)), `${mems.length} payment${mems.length === 1 ? '' : 's'}`) +
      kpi('Active members', active.length, `${members.length} on record`) +
      kpi('Renewals due', expiring.length, `expiring within ${REMIND_DAYS} days`) +
      kpi('Average gift', fmt(dons.length ? sum(dons) / dons.length : 0), 'donations only');

    const goal = +DC.annualFundraisingGoal || 0;
    if (goal > 0) {
      const y = today().slice(0, 4);
      const raised = sum(paid().filter(r => r.date.startsWith(y)));
      const pct = Math.min(100, (raised / goal) * 100);
      $('#goal').innerHTML = `<div class="goal"><div class="goal-top"><span><strong>${y} fundraising goal</strong> · ${fmt(raised)} of ${fmt(goal)}</span><span><strong>${pct.toFixed(0)}%</strong></span></div>
        <div class="goal-bar" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div></div>`;
    } else $('#goal').innerHTML = '';

    drawMonthChart($('#month-chart'), monthBuckets(paid(), period));

    const byMethod = {};
    recs.forEach(r => { const k = r.method || 'Other'; byMethod[k] = byMethod[k] || { name: k, value: 0, count: 0 }; byMethod[k].value += toReport(r) || 0; byMethod[k].count++; });
    drawHBars($('#method-chart'), Object.values(byMethod), { label: 'Money received by payment method', tipFmt: it => `${fmt(it.value)} · ${it.count} payment${it.count === 1 ? '' : 's'}` });

    const byTier = {};
    active.forEach(m => { const k = tierShort(m.tier); byTier[k] = byTier[k] || { name: k, value: 0 }; byTier[k].value++; });
    drawHBars($('#tier-chart'), Object.values(byTier), { label: 'Active members by tier', valueFmt: v => String(v), color: 'var(--series-2)', tipFmt: it => `${it.value} active member${it.value === 1 ? '' : 's'}` });

    // Donations only: membership dues aren't designated gifts.
    const desigCard = $('#desig-card');
    desigCard.hidden = !showDesignations();
    if (!desigCard.hidden) {
      const byDesig = {};
      dons.forEach(r => {
        const k = r.designation || '';
        byDesig[k] = byDesig[k] || { name: desigLabel(k), value: 0, count: 0 };
        byDesig[k].value += toReport(r) || 0; byDesig[k].count++;
      });
      drawHBars($('#desig-chart'), Object.values(byDesig), { label: 'Donations by designation', tipFmt: it => `${fmt(it.value)} · ${it.count} gift${it.count === 1 ? '' : 's'}` });
    }

    const recent = all().slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    $('#recent').innerHTML = `<div class="table-wrap"><table class="dtable"><tbody>${recent.map(r => `<tr>
      <td><strong>${esc(r.name || r.email || '—')}</strong><div class="muted">${fmtDate(r.date)} · ${esc(r.method)}</div></td>
      <td>${typePill(r)}${payStatus(r)}</td>
      <td class="num">${fmt(r.amount, r.currency, r.amount % 1 ? 2 : 0)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Offline payments donors reported ("I've paid") — confirm when the money arrives.
  function renderPending() {
    const list = all().filter(r => r.status === 'pending').sort((a, b) => b.date.localeCompare(a.date));
    $('#pending').innerHTML = !list.length ? '' : `<div class="dash-card pending-card">
      <div class="dash-card-head"><h3>Awaiting confirmation (${list.length})</h3><span class="dash-muted" style="margin:0;">Check your bank / mobile money / Zelle, then confirm.</span></div>
      <div class="table-wrap"><table class="dtable"><tbody>${list.slice(0, 20).map(r => `<tr>
        <td><strong>${esc(r.name || '—')}</strong><div class="muted">${esc(r.email || '')}${r.phone ? ' · ' + esc(r.phone) : ''}</div></td>
        <td class="nowrap">${esc(r.method)}<div class="muted">sent ${fmtDate(r.date)}</div></td>
        <td>${typePill(r)}${r.tier ? `<div class="muted">${esc(tierShort(r.tier))}</div>` : ''}${desigLine(r)}</td>
        <td class="muted">${esc(r.ref || '')}</td>
        <td class="num">${fmt(r.amount, r.currency, r.amount % 1 ? 2 : 0)}</td>
        <td class="nowrap"><button class="btn btn-green btn-xs" data-status="paid" data-id="${esc(r.id)}">Confirm</button> <button class="row-del" data-status="failed" data-id="${esc(r.id)}">Not received</button></td>
      </tr>`).join('')}</tbody></table></div></div>`;
  }
  const payStatus = r => !r.status || r.status === 'paid' ? '' : `<div><span class="pill st-${esc(r.status)}">${esc(r.status[0].toUpperCase() + r.status.slice(1))}</span></div>`;
  const typePill = r => r.type === 'membership' ? '<span class="pill m">Membership</span>' : '<span class="pill d">Donation</span>';
  // Where a gift goes. Dues default to 'general', which says nothing useful on a membership row.
  const desigLine = r => r.designation && (r.type !== 'membership' || r.designation !== 'general')
    ? `<div class="muted desig">For: ${esc(desigLabel(r.designation))}</div>` : '';
  // Receipt status + send/resend action (API mode, settled payments in the database only).
  function receiptCell(r) {
    if (!isServerRecord(r) || (r.status && r.status !== 'paid')) return '<span class="muted" title="Receipts go out once a payment is received">—</span>';
    const sent = r.receipt_sent_at;
    const state = sent
      ? `<span class="rcpt sent" title="${esc(fmtStamp(sent, true))}"><svg class="icon" aria-hidden="true"><use href="#i-mail"/></svg>Receipt sent ${esc(fmtStamp(sent))}</span>`
      : '<span class="rcpt none">No receipt</span>';
    const canSend = has(r.email) && r.email.includes('@');
    const action = canSend
      ? `<button class="link-btn" type="button" data-receipt="${esc(r.id)}">${sent ? 'Resend receipt' : 'Send receipt'}</button>`
      : '<span class="muted">No email on file</span>';
    return `${state}<div>${action}</div>`;
  }
  const statusCell = s => ({
    active: '<span class="status active"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Active</span>',
    expiring: '<span class="status expiring"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>Expiring soon</span>',
    expired: '<span class="status expired"><svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>Expired</span>',
  }[s]);

  /* =====================================================================
     RENDER: MEMBERS
     ===================================================================== */
  function filteredMembers() {
    const q = $('#mem-search').value.trim().toLowerCase();
    const st = $('#mem-status').value, tier = $('#mem-tier').value;
    return membersFrom(paid()).filter(m =>
      (!st || m.status === st) && (!tier || m.tier === tier) &&
      (!q || [m.name, m.email, m.country, m.phone, tierLabel(m.tier)].join(' ').toLowerCase().includes(q)));
  }
  function renderMembers() {
    const tierSel = $('#mem-tier');
    if (tierSel.options.length <= 1) tierSel.innerHTML += TIERS.map(t => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.region)}</option>`).join('');
    const list = filteredMembers();
    if (!list.length) {
      $('#mem-table').innerHTML = `<div class="empty-state">${membersFrom(paid()).length ? 'No members match these filters.' : 'No membership payments yet. Import exports or record a membership payment.'}</div>`;
      return;
    }
    $('#mem-table').innerHTML = `<table class="dtable"><thead><tr>
      <th>Name</th><th>Tier</th><th>Country</th><th>Member since</th><th>Last paid</th><th>Expires</th><th>Status</th><th class="num">Total paid</th></tr></thead><tbody>
      ${list.map(m => `<tr>
        <td><strong>${esc(m.name || '—')}</strong><div class="muted">${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''}${m.phone ? ' · ' + esc(m.phone) : ''}</div></td>
        <td>${esc(tierLabel(m.tier))}</td>
        <td>${esc(m.country || '')}</td>
        <td class="nowrap">${fmtDate(m.first)}</td>
        <td class="nowrap">${fmtDate(m.lastPaid)}<div class="muted">${esc(m.method)}</div></td>
        <td class="nowrap">${fmtDate(m.expires)}<div class="muted">${m.daysLeft >= 0 ? m.daysLeft + ' days left' : -m.daysLeft + ' days ago'}</div></td>
        <td>${statusCell(m.status)}</td>
        <td class="num">${fmt(m.total)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  /* =====================================================================
     RENDER: ALL PAYMENTS
     ===================================================================== */
  function filteredTx() {
    const q = $('#tx-search').value.trim().toLowerCase();
    const type = $('#tx-type').value, method = $('#tx-method').value, year = $('#tx-year').value, status = $('#tx-status').value;
    const desig = $('#tx-designation').hidden ? '' : $('#tx-designation').value;
    return all().filter(r => (!type || r.type === type) && (!method || r.method === method) && inYear(r, year) &&
      (!status || (r.status || 'paid') === status) &&
      (!desig || (desig === DESIG_NONE ? !r.designation : r.designation === desig)) &&
      (!q || [r.name, r.email, r.ref, r.country, r.notes, r.phone, r.designation ? desigLabel(r.designation) : ''].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const RECURRING_LABEL = { month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' };
  function designationOptions(sel) {
    const show = showDesignations();
    sel.hidden = !show;
    if (!show) { sel.value = ''; return; }
    const cur = sel.value;
    const ids = designations().map(d => d.id);
    const extra = [...new Set(all().map(r => r.designation).filter(id => id && !ids.includes(id)))].sort();
    sel.innerHTML = '<option value="">All designations</option>' +
      ids.concat(extra).map(id => `<option value="${esc(id)}">${esc(desigLabel(id))}</option>`).join('') +
      `<option value="${DESIG_NONE}">Not specified</option>`;
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }
  function renderTx() {
    yearOptions($('#tx-year'));
    const mSel = $('#tx-method'), cur = mSel.value;
    const methods = [...new Set(all().map(r => r.method))].sort();
    mSel.innerHTML = '<option value="">All methods</option>' + methods.map(m => `<option>${esc(m)}</option>`).join('');
    mSel.value = methods.includes(cur) ? cur : '';
    designationOptions($('#tx-designation'));
    const rcpt = receiptsTracked();
    const list = filteredTx();
    const settled = list.filter(r => !r.status || r.status === 'paid');
    $('#tx-summary').textContent = list.length ? `${list.length} payment${list.length === 1 ? '' : 's'} · ${fmt(sum(settled))} received (in ${REPORT_CUR})${settled.length < list.length ? ` · ${list.length - settled.length} pending, failed or refunded (not counted)` : ''}` : '';
    if (!list.length) { $('#tx-table').innerHTML = `<div class="empty-state">${all().length ? 'No payments match these filters.' : 'No payments yet.'}</div>`; return; }
    const shown = list.slice(0, 500);
    $('#tx-table').innerHTML = `<table class="dtable"><thead><tr><th>Date</th><th>Name</th><th>Type</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th class="num">${esc(REPORT_CUR)}</th>${rcpt ? '<th>Receipt</th>' : ''}<th></th></tr></thead><tbody>
      ${shown.map(r => {
        const conv = toReport(r);
        return `<tr>
        <td class="nowrap">${fmtDate(r.date)}</td>
        <td>${esc(r.name || '—')}<div class="muted">${esc(r.email)}${r.country ? ' · ' + esc(r.country) : ''}</div></td>
        <td>${typePill(r)}${r.tier ? `<div class="muted">${esc(tierShort(r.tier))}</div>` : ''}${desigLine(r)}${payStatus(r)}</td>
        <td>${esc(r.method)}${r.recurring && r.recurring !== 'once' ? `<div class="muted">${esc(RECURRING_LABEL[r.recurring] || r.recurring)}</div>` : ''}</td>
        <td class="muted">${esc(r.ref)}</td>
        <td class="num">${fmt(r.amount, r.currency, r.amount % 1 ? 2 : 0)}</td>
        <td class="num">${conv == null ? '<span class="muted">no rate</span>' : fmt(conv)}</td>
        ${rcpt ? `<td class="rcpt-cell">${receiptCell(r)}</td>` : ''}
        <td class="nowrap">${r.status === 'pending' ? `<button class="btn btn-green btn-xs" data-status="paid" data-id="${esc(r.id)}">Confirm</button> ` : ''}${r.source === 'sheet' ? '<span class="muted" title="From Google Sheet — edit it there">sheet</span>' : `<button class="row-del" data-del="${esc(r.id)}" title="Delete this payment">Delete</button>`}</td></tr>`;
      }).join('')}
      </tbody></table>${list.length > shown.length ? `<p class="dash-muted" style="margin-top:12px;">Showing the latest 500. Use filters or export CSV to see all.</p>` : ''}`;
  }

  /* =====================================================================
     RENDER: SETUP CHECKLIST
     ===================================================================== */
  // Based on what the database shows, since /config doesn't report email settings.
  function receiptSetupCell() {
    if (!receiptsTracked()) return '<span class="check-off">Not reported by the server</span>';
    const last = local.map(r => r.receipt_sent_at).filter(Boolean).sort().pop();
    return last
      ? `<span class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Working — last sent ${esc(fmtStamp(last))}</span>`
      : '<span class="check-off">None sent yet</span>';
  }
  function renderSetup() {
    const g = CFG.gateways || {};
    const filled = obj => obj && Object.values(obj).some(v => has(v));
    const tierLinks = links => links ? TIERS.filter(t => has(links[t.id])).length : 0;
    const rows = [
      ['Donorbox', 'Cards, Apple/Google Pay, PayPal, ACH', g.donorbox, [has(g.donorbox?.donationCampaign) && 'donation form', has(g.donorbox?.membershipCampaign) && 'membership form']],
      ['Stripe', 'Card payment links', g.stripe, [has(g.stripe?.donationLink) && 'donation link', has(g.stripe?.monthlyDonationLink) && 'monthly link', tierLinks(g.stripe?.membershipLinks) && `${tierLinks(g.stripe?.membershipLinks)}/${TIERS.length} tier links`]],
      ['PayPal', 'PayPal & cards', g.paypal, [has(g.paypal?.hostedButtonId) && 'donate button', has(g.paypal?.paypalMeUsername) && 'paypal.me', tierLinks(g.paypal?.membershipLinks) && `${tierLinks(g.paypal?.membershipLinks)}/${TIERS.length} tier links`]],
      ['DPO Pay', 'Zambia: mobile money & cards', g.dpo, [has(g.dpo?.donationLink) && 'donation link', tierLinks(g.dpo?.membershipLinks) && `${tierLinks(g.dpo?.membershipLinks)}/${TIERS.length} tier links`]],
      ['Mobile Money', 'MTN, Airtel, Zamtel direct', g.mobileMoney, [filled(g.mobileMoney?.mtn) && 'MTN', filled(g.mobileMoney?.airtel) && 'Airtel', filled(g.mobileMoney?.zamtel) && 'Zamtel']],
      ['Bank transfer', 'US and/or Zambian account', g.bankTransfer, [has(g.bankTransfer?.us?.accountNumber) && 'US account', has(g.bankTransfer?.zambia?.accountNumber) && 'Zambian account']],
      ['Zelle', 'US bank apps', g.zelle, [has(g.zelle?.emailOrPhone) && 'recipient']],
      ['Cash App', 'US', g.cashApp, [has(g.cashApp?.cashtag) && 'cashtag']],
      ['Venmo', 'US', g.venmo, [has(g.venmo?.username) && 'username']],
      ['Check by mail', 'US checks', g.check, [has(CFG.org?.mailingAddress) && 'mailing address']],
      ...((g.custom || []).map(c => [c.name || 'Custom gateway', c.description || 'Custom link', c, [has(c.url) && 'link']])),
    ];
    const cell = (gw, parts) => {
      const ok = parts.filter(Boolean);
      if (API && apiConfig && Object.values(apiConfig.gateways || {}).some(Boolean) && gw === g.donorbox && gw && gw.enabled) return `<span class="check-off">Replaced by own API (hidden)</span>`;
      if (gw && gw.enabled && ok.length) return `<span class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Live on site</span>`;
      if (gw && gw.enabled) return `<span class="check-miss"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>Enabled, but details missing — hidden</span>`;
      if (ok.length) return `<span class="check-miss"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>Filled in — set enabled: true</span>`;
      return `<span class="check-off">Off</span>`;
    };
    const extra = [
      ['Organization EIN', has(CFG.org?.ein)], ['Mailing address', has(CFG.org?.mailingAddress)],
      ['Passcode changed', !!API || DC.passcodeHash !== '0a8b1e2c3e5690de87df39b4e36e01f91f44327ba59483b68424e7f13ec63e8c'],
      ['Fundraising goal', +DC.annualFundraisingGoal > 0], ['Google Sheet (optional)', has(DC.googleSheetCsvUrl)],
    ];
    const gw = apiConfig && apiConfig.gateways;
    const on = v => v ? '<span class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Live — automatic</span>' : '<span class="check-off">Key not set on server</span>';
    const apiHtml = API ? `<table class="dtable" style="margin-bottom:18px;"><thead><tr><th>Automated payments (own API)</th><th>What it covers</th><th>Status</th></tr></thead><tbody>
      <tr><td><strong>Payments API</strong></td><td class="muted">${esc(API)}</td><td>${gw ? '<span class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Connected</span>' : '<span class="check-miss"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>Checking… / unreachable</span>'}</td></tr>
      <tr><td><strong>Stripe</strong></td><td class="muted">Cards, Apple Pay, Google Pay, US bank · monthly & yearly</td><td>${gw ? on(gw.stripe) : '—'}</td></tr>
      <tr><td><strong>PayPal</strong></td><td class="muted">PayPal balance & cards (one-time)</td><td>${gw ? on(gw.paypal) : '—'}</td></tr>
      <tr><td><strong>DPO Pay</strong></td><td class="muted">Zambia: MTN & Airtel mobile money and cards</td><td>${gw ? on(gw.dpo) : '—'}</td></tr>
      <tr><td><strong>Mobile money prompt</strong></td><td class="muted">Zambia: approve with a PIN prompt on the payer's phone (needs DPO Pay and DPO_DIRECT_MOMO on the server). When off, mobile money payers use the DPO payment page.</td><td>${gw ? (apiConfig.momoDirect === true ? on(true) : '<span class="check-off">Off — DPO payment page</span>') : '—'}</td></tr>
      <tr><td><strong>Email receipts</strong></td><td class="muted">Sent automatically when a payment is received or confirmed (needs RESEND_API_KEY and FROM_EMAIL on the server; the EIN line appears when ORG_EIN is set). Resend from the Payments tab.</td><td>${receiptSetupCell()}</td></tr>
      </tbody></table>
      <p class="dash-muted">With the API connected, Donorbox and the payment-link rows below are hidden on the site automatically. Bank, Zelle and mobile money sent to your own numbers still show as "Other ways to pay" and arrive here as <em>Awaiting confirmation</em>.</p>` : '';
    $('#setup-table').innerHTML = apiHtml + `<table class="dtable"><thead><tr><th>Payment method</th><th>What it covers</th><th>Filled in</th><th>Status</th></tr></thead><tbody>
      ${rows.map(([name, what, gw, parts]) => `<tr><td><strong>${esc(name)}</strong></td><td class="muted">${esc(what)}</td><td class="muted">${esc(parts.filter(Boolean).join(', ') || '—')}</td><td>${cell(gw, parts)}</td></tr>`).join('')}
      </tbody></table>
      <table class="dtable" style="margin-top:18px;"><thead><tr><th>Other settings</th><th>Status</th></tr></thead><tbody>
      ${extra.map(([n, ok]) => `<tr><td>${esc(n)}</td><td>${ok ? '<span class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Done</span>' : '<span class="check-off">Not set</span>'}</td></tr>`).join('')}
      </tbody></table>`;
  }

  /* =====================================================================
     MESSAGES (Contact page form — automated/API mode only)
     { id, created_at, name, email, subject, message, profession?, status:'new'|'read'|'archived' }
     ===================================================================== */
  let messages = [];
  let msgLoaded = false;
  let msgError = '';
  let msgRenderKey = '';
  let msgAlertN = -1;
  const MSG_STATUSES = ['new', 'read', 'archived'];
  const MSG_LABEL = { new: 'New', read: 'Read', archived: 'Archived' };
  const msgStatus = m => MSG_STATUSES.includes(m.status) ? m.status : 'new';
  const msgById = id => messages.find(m => String(m.id) === String(id));
  const unreadCount = () => messages.filter(m => msgStatus(m) === 'new').length;
  const fmtDateTime = s => {
    const t = Date.parse(s);
    return isNaN(t) ? String(s || '') : new Date(t).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  async function loadMessages() {
    if (!API) return;
    try {
      const data = await api('/admin/messages');
      messages = Array.isArray(data.messages) ? data.messages : [];
      msgLoaded = true;
      msgError = '';
    } catch (err) {
      if (err.message === 'signed out') throw err;
      msgError = err.message || 'Could not load messages.';
    }
    updateMsgBadge();
  }
  async function setMsgStatus(id, status) {
    await api('/admin/messages/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
    const m = msgById(id);
    if (m) m.status = status;
    updateMsgBadge();
  }
  async function deleteMessage(id) {
    await api('/admin/messages/' + encodeURIComponent(id), { method: 'DELETE' });
    messages = messages.filter(m => String(m.id) !== String(id));
    updateMsgBadge();
  }

  function updateMsgBadge() {
    const n = API ? unreadCount() : 0;
    const badge = $('#msg-badge');
    if (badge) { badge.hidden = !n; badge.innerHTML = n ? `${n}<span class="sr-only"> new</span>` : ''; }
    const alertEl = $('#msg-alert');
    if (alertEl && n !== msgAlertN) alertEl.innerHTML = n ?`<div class="dash-banner info"><svg class="icon" aria-hidden="true"><use href="#i-mail"/></svg><div>You have <strong>${n} new message${n === 1 ? '' : 's'}</strong> from the Contact page. <a href="#messages" data-goto="messages">Read ${n === 1 ? 'it' : 'them'} ›</a></div></div>` : '';
    msgAlertN = n; // only rebuilt when the count changes, so the 60 s refresh never steals focus from the link
  }

  // Basic shape check before putting an address in a mailto: link.
  const SAFE_EMAIL = /^[^\s@<>()"',;:?&\\]+@[^\s@<>()"',;:?&\\]+\.[^\s@<>()"',;:?&\\]+$/;
  function replyHref(m) {
    const to = String(m.email || '').trim();
    if (!SAFE_EMAIL.test(to)) return '';
    const subj = String(m.subject || '').trim() || 'Your message to GAZHP';
    const text = String(m.message || '');
    const quoted = text.slice(0, 600).split(/\r?\n/).map(l => '> ' + l).join('\n') + (text.length > 600 ? '\n> …' : '');
    const body = `\n\n\nOn ${fmtDateTime(m.created_at)}, ${m.name || to} wrote:\n${quoted}`;
    return `mailto:${to}?subject=${encodeURIComponent(/^re:/i.test(subj) ? subj : 'Re: ' + subj)}&body=${encodeURIComponent(body)}`;
  }

  function filteredMessages() {
    const q = $('#msg-search').value.trim().toLowerCase();
    const show = $('#msg-status').value;
    return messages.filter(m => {
      const s = msgStatus(m);
      if (show === 'inbox' ? s === 'archived' : show !== 'all' && s !== show) return false;
      return !q || [m.name, m.email, m.subject, m.message, m.profession].join(' ').toLowerCase().includes(q);
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  function renderMessages(force) {
    const list = $('#msg-list');
    if (!API) { list.innerHTML = ''; return; }
    const counts = { new: 0, read: 0, archived: 0 };
    messages.forEach(m => { counts[msgStatus(m)]++; });
    const shown = msgLoaded ? filteredMessages() : [];
    // Skip identical re-renders (auto-refresh) so keyboard focus isn't lost while reading.
    const key = JSON.stringify([msgLoaded, msgError, $('#msg-status').value, $('#msg-search').value, shown]);
    if (!force && key === msgRenderKey) return;
    msgRenderKey = key;
    $('#msg-summary').textContent = messages.length ? `${counts.new} new · ${counts.read} read · ${counts.archived} archived` : '';
    if (!msgLoaded) {
      list.innerHTML = msgError
        ? `<div class="dash-card"><div class="empty-state">Could not load messages: ${esc(msgError)}<br><button class="btn btn-teal btn-sm" type="button" data-msg-retry>Try again</button></div></div>`
        : '<div class="dash-card"><p class="chart-empty">Loading messages…</p></div>';
      return;
    }
    const stale = msgError ? `<div class="dash-banner warn"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg><div>Could not refresh messages (${esc(msgError)}). Showing the last ones loaded.</div></div>` : '';
    if (!shown.length) {
      list.innerHTML = stale + `<div class="dash-card"><div class="empty-state">${messages.length ? 'No messages match these filters.' : 'No messages yet. Messages people send from the Contact page appear here.'}</div></div>`;
      return;
    }
    const btn = (m, status, label) => `<button class="link-btn" type="button" data-msg-id="${esc(m.id)}" data-msg-status="${status}">${label}</button>`;
    list.innerHTML = stale + shown.map((m, i) => {
      const s = msgStatus(m);
      const reply = replyHref(m);
      const email = String(m.email || '');
      return `<article class="dash-card msg msg-${s}" tabindex="-1" data-msg-card="${esc(m.id)}" aria-labelledby="msg-subj-${i}">
        <div class="msg-head">
          <div class="msg-from"><strong>${esc(m.name || '—')}</strong>${email ? ` <span class="msg-email">${reply ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : esc(email)}</span>` : ''}</div>
          <div class="msg-meta"><span class="pill msg-st-${s}">${MSG_LABEL[s]}</span><time datetime="${esc(m.created_at || '')}">${esc(fmtDateTime(m.created_at))}</time></div>
        </div>
        <h3 class="msg-subject" id="msg-subj-${i}">${esc(m.subject || '(no subject)')}</h3>
        ${m.profession ? `<p class="msg-prof">Profession / role: ${esc(m.profession)}</p>` : ''}
        <p class="msg-text">${esc(m.message || '')}</p>
        <div class="msg-actions">
          ${reply ? `<a class="btn btn-green btn-xs" href="${esc(reply)}" data-msg-reply="${esc(m.id)}">Reply by email</a>` : ''}
          ${s === 'new' ? btn(m, 'read', 'Mark as read') : s === 'read' ? btn(m, 'new', 'Mark as unread') : ''}
          ${s === 'archived' ? btn(m, 'read', 'Move back to inbox') : btn(m, 'archived', 'Archive')}
          <button class="row-del" type="button" data-msg-del="${esc(m.id)}">Delete</button>
        </div>
      </article>`;
    }).join('');
  }
  // After an action re-renders the list, put focus back on the same message (or its neighbour).
  function refocusMessage(id, index, within) {
    const cards = $$('[data-msg-card]');
    const card = cards.find(c => c.dataset.msgCard === String(id)) || cards[Math.min(Math.max(index, 0), cards.length - 1)];
    if (!card) { $('#msg-search').focus(); return; }
    const target = (within && card.dataset.msgCard === String(id) && $(within, card)) || card;
    target.focus();
  }
  function msgSay(text) { const el = $('#msg-live'); el.textContent = ''; setTimeout(() => { el.textContent = text; }, 50); }

  function renderStoreInfo() {
    const n = local.length, s = sheet.length;
    $('#store-info').textContent = API
      ? `${n} payment${n === 1 ? '' : 's'} in the payments database${s ? ` · ${s} from Google Sheet` : ''}.`
      : `${n} payment${n === 1 ? '' : 's'} saved in this browser${s ? ` · ${s} from Google Sheet` : ''}.`;
  }

  function render() {
    statusBanner();
    hideTip();
    if (tab === 'overview') renderOverview();
    else if (tab === 'members') renderMembers();
    else if (tab === 'donations') renderTx();
    else if (tab === 'messages') renderMessages();
    else if (tab === 'setup') renderSetup();
    else if (tab === 'import') renderStoreInfo();
  }

  /* =====================================================================
     ACTIONS
     ===================================================================== */
  // status is exported so failed / refunded / pending rows never come back as money received.
  const EXPORT_COLS = ['date', 'status', 'type', 'tier', 'designation', 'name', 'email', 'phone', 'country', 'profession', 'amount', 'currency', 'method', 'ref', 'recurring', 'notes', 'source'];
  // Backups made before status/profession/recurring/designation were added still restore.
  const BACKUP_REQUIRED = ['date', 'type', 'tier', 'name', 'email', 'phone', 'country', 'amount', 'currency', 'method', 'ref', 'notes', 'source'];
  const STATUSES = ['paid', 'pending', 'failed', 'refunded'];
  function exportRecords(recs, filename) {
    // receipt_sent_at is for reference only: the server sets it, so a restore ignores it.
    const cols = receiptsTracked() ? EXPORT_COLS.concat('receipt_sent_at') : EXPORT_COLS;
    download(filename, toCSV([cols, ...recs.map(r => cols.map(c => c === 'status' ? (r.status || 'paid') : r[c]))]));
  }
  // Turn one backup row into a clean record, or null if it can't be trusted.
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  function restoredRecord(r) {
    const date = clip(r.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return null;
    const amount = Math.round(parseFloat(r.amount) * 100) / 100;
    if (!(amount > 0) || !isFinite(amount)) return null;
    const cur = clip(r.currency, 3).toUpperCase();
    const type = r.type === 'membership' ? 'membership' : 'donation';
    const status = clip(r.status, 10).toLowerCase();
    const recurring = clip(r.recurring, 10).toLowerCase();
    const rec = {
      date, amount, type,
      currency: /^[A-Z]{3}$/.test(cur) ? cur : REPORT_CUR,
      tier: type === 'membership' ? clip(r.tier, 60) : '',
      status: STATUSES.includes(status) ? status : 'paid',
      name: clip(r.name, 120), email: clip(r.email, 160).toLowerCase(), phone: clip(r.phone, 40),
      country: clip(r.country, 80), profession: clip(r.profession, 160),
      method: clip(r.method, 60) || 'Other', ref: clip(r.ref, 120), notes: clip(r.notes, 1000),
    };
    if (['once', 'month', 'year'].includes(recurring)) rec.recurring = recurring;
    const designation = clip(r.designation, 40).toLowerCase();
    if (DESIG_ID.test(designation)) rec.designation = designation;
    return rec;
  }

  // POST /admin/payments/:id/receipt — emails the receipt (or membership confirmation) again.
  async function sendReceipt(btn) {
    const id = btn.dataset.receipt;
    const r = local.find(x => String(x.id) === String(id));
    if (!API || !r || btn.disabled) return;
    const again = !!r.receipt_sent_at;
    const what = r.type === 'membership' ? 'membership confirmation' : 'donation receipt';
    const summary = [r.name, fmt(r.amount, r.currency, r.amount % 1 ? 2 : 0), fmtDate(r.date), r.ref].filter(Boolean).join(' · ');
    const prompt = again
      ? `Send the ${what} again to ${r.email}?\n\n${summary}\n\nA receipt was already sent ${fmtStamp(r.receipt_sent_at, true)}.`
      : `Email the ${what} to ${r.email}?\n\n${summary}`;
    if (!confirm(prompt)) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const data = await api('/admin/payments/' + encodeURIComponent(id) + '/receipt', { method: 'POST' });
      r.receipt_sent_at = (data && data.receipt_sent_at) || new Date().toISOString();
      if (tab === 'donations') {
        renderTx();
        const next = $$('[data-receipt]').find(b => b.dataset.receipt === String(id));
        if (next) next.focus(); // keep keyboard users on the same row after the re-render
      }
      toast(`${again ? 'Receipt sent again' : 'Receipt sent'} to ${r.email}.`);
    } catch (err) {
      if (err.message === 'signed out') return;
      btn.disabled = false; btn.textContent = label;
      toast(`Receipt not sent: ${err.message}`, 'bad');
    }
  }

  // Designation choices on the Record payment form ("Not specified" + the list).
  function fillRecordDesignations() {
    const sel = $('#rec-designation');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Not specified</option>' + designations().map(d => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }

  function bindActions() {
    $$('.dash-tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    document.addEventListener('click', e => {
      const go = e.target.closest('[data-goto]');
      if (go) { e.preventDefault(); showTab(go.dataset.goto); }
      const del = e.target.closest('[data-del]');
      if (del && confirm(API ? 'Delete this payment from the database? This cannot be undone.' : 'Delete this payment from this browser?')) {
        deleteRecord(del.dataset.del).then(render, err => alert(err.message));
      }
      const stBtn = e.target.closest('[data-status]');
      if (stBtn) {
        const id = stBtn.dataset.id, to = stBtn.dataset.status;
        stBtn.disabled = true;
        setStatus(id, to).then(() => {
          render();
          if (!API || to !== 'paid') return;
          // The server emails the receipt when a payment is confirmed; reload to show it.
          const r = local.find(x => x.id === id);
          toast(r && has(r.email) && receiptsTracked() ? `Payment confirmed. A receipt goes to ${r.email} if email sending is set up.` : 'Payment confirmed.');
          refresh();
        }, err => { alert(err.message); stBtn.disabled = false; });
      }
      const rcBtn = e.target.closest('[data-receipt]');
      if (rcBtn) sendReceipt(rcBtn);
      // Messages tab
      const cardIndex = el => $$('[data-msg-card]').indexOf(el.closest('[data-msg-card]'));
      const msBtn = e.target.closest('[data-msg-status]');
      if (msBtn) {
        const id = msBtn.dataset.msgId, to = msBtn.dataset.msgStatus, idx = cardIndex(msBtn);
        msBtn.disabled = true;
        setMsgStatus(id, to).then(() => {
          renderMessages(true); refocusMessage(id, idx);
          msgSay(to === 'archived' ? 'Message archived.' : to === 'read' ? 'Marked as read.' : 'Marked as unread.');
        }, err => { alert(err.message); msBtn.disabled = false; });
      }
      const mdBtn = e.target.closest('[data-msg-del]');
      if (mdBtn && confirm('Delete this message permanently? This cannot be undone. (Archive keeps it out of the inbox instead.)')) {
        const id = mdBtn.dataset.msgDel, idx = cardIndex(mdBtn);
        mdBtn.disabled = true;
        deleteMessage(id).then(() => { renderMessages(true); refocusMessage(id, idx); msgSay('Message deleted.'); },
          err => { alert(err.message); mdBtn.disabled = false; });
      }
      const mrLink = e.target.closest('[data-msg-reply]');
      if (mrLink) { // the mailto: link opens as normal; a new message also counts as read
        const m = msgById(mrLink.dataset.msgReply);
        const idx = cardIndex(mrLink);
        if (m && msgStatus(m) === 'new') setMsgStatus(m.id, 'read').then(() => { renderMessages(true); refocusMessage(m.id, idx, '[data-msg-reply]'); }, () => {});
      }
      if (e.target.closest('[data-msg-retry]')) loadMessages().then(() => renderMessages(true), () => {});
    });
    ['#msg-search', '#msg-status'].forEach(s => $(s).addEventListener('input', () => renderMessages()));
    $('#ov-year').addEventListener('change', render);
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (tab === 'overview') renderOverview(); }, 150); });
    ['#mem-search', '#mem-status', '#mem-tier'].forEach(s => $(s).addEventListener('input', renderMembers));
    ['#tx-search', '#tx-type', '#tx-method', '#tx-status', '#tx-designation', '#tx-year'].forEach(s => $(s).addEventListener('input', renderTx));

    $('#mem-export').addEventListener('click', () => {
      const cols = ['name', 'email', 'phone', 'country', 'tier', 'first', 'lastPaid', 'expires', 'status', 'payments', 'total'];
      const list = filteredMembers();
      download(`gazhp-members-${today()}.csv`, toCSV([['Name', 'Email', 'Phone', 'Country', 'Tier', 'Member since', 'Last paid', 'Expires', 'Status', 'Payments', `Total paid (${REPORT_CUR})`],
        ...list.map(m => cols.map(c => c === 'tier' ? tierLabel(m.tier) : c === 'total' ? m.total.toFixed(2) : m[c]))]));
    });
    $('#mem-remind').addEventListener('click', () => {
      const list = membersFrom(paid()).filter(m => m.email && (m.status === 'expiring' || m.status === 'expired'));
      if (!list.length) { alert('No expiring or expired members with an email address.'); return; }
      const subject = 'Time to renew your GAZHP membership';
      const body = `Dear member,\n\nThank you for being part of the Global Alliance of Zambian Healthcare Professionals. Your membership is due for renewal.\n\nRenew online: ${location.origin}/join/\n\nWith gratitude,\nGAZHP`;
      const href = `mailto:${encodeURIComponent(CFG.org?.email || '')}?bcc=${encodeURIComponent(list.map(m => m.email).join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      if (href.length > 1900 && navigator.clipboard) {
        navigator.clipboard.writeText(list.map(m => m.email).join(', '));
        alert(`${list.length} email addresses copied to your clipboard — paste them into the BCC field of a new email.`);
      } else location.href = href;
    });
    $('#tx-export').addEventListener('click', () => exportRecords(filteredTx(), `gazhp-payments-${today()}.csv`));
    $('#backup-btn').addEventListener('click', () => exportRecords(local, `gazhp-dashboard-backup-${today()}.csv`));

    // Record payment form
    const form = $('#rec-form');
    $('#rec-tier').innerHTML = TIERS.map(t => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.region)} (${fmt(t.amount, t.currency)})</option>`).join('');
    $('#rec-currency').innerHTML = Object.keys(FX).map(c => `<option${c === REPORT_CUR ? ' selected' : ''}>${esc(c)}</option>`).join('');
    fillRecordDesignations();
    form.date.value = today();
    const syncType = () => {
      const isM = form.type.value === 'membership';
      $$('[data-show="membership"]', form).forEach(el => { el.hidden = !isM; });
      $$('[data-show="donation"]', form).forEach(el => { el.hidden = isM; });
      if (isM && !form.amount.value) {
        const t = TIERS.find(x => x.id === form.tier.value);
        if (t) { form.amount.value = t.amount; form.currency.value = t.currency; }
      }
    };
    form.type.addEventListener('change', syncType);
    form.tier.addEventListener('change', () => {
      const t = TIERS.find(x => x.id === form.tier.value);
      if (t) { form.amount.value = t.amount; form.currency.value = t.currency; }
    });
    syncType();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const rec = {
        date: f.date, amount: Math.round(parseFloat(f.amount) * 100) / 100, currency: f.currency,
        type: f.type, tier: f.type === 'membership' ? f.tier : '', method: f.method,
        name: f.name.trim(), email: f.email.trim().toLowerCase(), phone: f.phone.trim(), country: f.country.trim(),
        ref: f.ref.trim(), notes: f.notes.trim(),
      };
      if (f.type === 'donation' && DESIG_ID.test(f.designation || '')) rec.designation = f.designation;
      let added = 0;
      try { ({ added } = await addRecords([rec], 'manual')); } catch (err) { $('#rec-msg').textContent = err.message; return; }
      $('#rec-msg').textContent = added ? `Saved: ${rec.name}, ${fmt(rec.amount, rec.currency, 2)}.` : 'This payment is already recorded (same reference or same person, date and amount).';
      if (added) { const keep = { type: form.type.value, method: form.method.value, currency: form.currency.value }; form.reset(); form.type.value = keep.type; form.method.value = keep.method; form.currency.value = keep.currency; form.date.value = today(); syncType(); }
    });

    // Import
    const dz = $('#dropzone');
    const handleFiles = async files => {
      const out = [];
      for (const file of files) {
        const text = await file.text();
        const res = rowsToRecords(parseCSV(text), $('#imp-source').value);
        if (res.error) { out.push(`<p><strong>${esc(file.name)}:</strong> ${esc(res.error)}</p>`); continue; }
        let added, dup;
        try { ({ added, dup } = await addRecords(res.records, 'import')); } catch (err) { out.push(`<p><strong>${esc(file.name)}:</strong> ${esc(err.message)}</p>`); continue; }
        const m = res.records.filter(r => r.type === 'membership').length;
        out.push(`<p class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg><span><strong>${esc(file.name)}</strong> (${esc(res.source)}): ${added} added (${m} membership, ${res.records.length - m} donation)${dup ? `, ${dup} duplicates skipped` : ''}${res.skipped ? `, ${res.skipped} rows ignored (failed, refunded or not a payment)` : ''}.</span></p>`);
      }
      $('#imp-result').innerHTML = out.join('');
      renderStoreInfo(); statusBanner();
    };
    $('#imp-file').addEventListener('change', e => { handleFiles([...e.target.files]); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('drag')));
    dz.addEventListener('drop', e => { e.preventDefault(); handleFiles([...e.dataTransfer.files].filter(f => /\.csv$/i.test(f.name) || f.type === 'text/csv')); });

    $('#restore-file').addEventListener('change', async e => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      const rows = parseCSV(await file.text());
      const [h, ...body] = rows;
      const cols = (h || []).map(c => c.trim());
      if (!h || !BACKUP_REQUIRED.every(c => cols.includes(c))) { alert('This does not look like a dashboard backup file.'); return; }
      const raw = body.map(r => Object.fromEntries(cols.filter(c => EXPORT_COLS.includes(c)).map(c => [c, (r[cols.indexOf(c)] || '').replace(/^'(?=[=+\-@])/, '')])));
      const recs = raw.map(restoredRecord).filter(Boolean);
      const bad = raw.length - recs.length;
      let added, dup;
      try { ({ added, dup } = await addRecords(recs, 'import')); } catch (err) { alert(err.message); return; }
      $('#imp-result').innerHTML = `<p class="check-ok"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Restored ${added} payments${dup ? ` (${dup} already present)` : ''}${bad ? `; ${bad} row${bad === 1 ? '' : 's'} skipped (missing or invalid date or amount)` : ''}.</p>`;
      renderStoreInfo(); statusBanner();
    });
    $('#clear-btn').addEventListener('click', () => {
      if (!confirm('Delete ALL payments saved in this browser? Download a backup first if you need them. This cannot be undone.')) return;
      if (API) return;
      local = []; save(); render(); $('#imp-result').innerHTML = '';
    });
    $('#sheet-reload').addEventListener('click', () => loadSheet(true));

    // Setup
    $('#hash-btn').addEventListener('click', async () => {
      const v = $('#hash-in').value;
      if (v.length < 8) { $('#hash-out').textContent = 'Use at least 8 characters.'; return; }
      $('#hash-out').textContent = await sha256(v);
    });
    $('#sample-load').addEventListener('click', async () => {
      const { added } = await addRecords(sampleData(), 'sample');
      alert(`${added} sample payments loaded.`); showTab('overview');
    });
    $('#sample-clear').addEventListener('click', () => { samples = []; save(); render(); });
  }

  /* =====================================================================
     GOOGLE SHEET
     ===================================================================== */
  async function loadSheet(manual) {
    if (!has(DC.googleSheetCsvUrl)) { if (manual) alert('No Google Sheet URL is set in js/payments-config.js (dashboard.googleSheetCsvUrl).'); return; }
    try {
      const res = await fetch(DC.googleSheetCsvUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = rowsToRecords(parseCSV(await res.text()), 'auto');
      if (out.error) throw new Error(out.error);
      sheet = out.records.map((r, i) => ({ ...r, id: 'sheet-' + i, source: 'sheet' }));
      // Avoid double counting payments that were also imported locally.
      const localKeys = new Set(local.map(dedupeKey));
      sheet = sheet.filter(r => !localKeys.has(dedupeKey(r)));
      if (manual) alert(`Loaded ${sheet.length} payments from the Google Sheet.`);
    } catch (err) {
      banner('warn', `Could not load the Google Sheet: ${esc(err.message)}. Check that it is published to the web as CSV.`);
    }
    render();
  }

  /* =====================================================================
     SAMPLE DATA
     ===================================================================== */
  function sampleData() {
    const first = ['Mwila', 'Chanda', 'Bwalya', 'Mutale', 'Natasha', 'Kondwani', 'Lubasi', 'Chileshe', 'Mulenga', 'Thandiwe', 'Kabwe', 'Nchimunya', 'Musonda', 'Sepo', 'Namukolo', 'Kalaba'];
    const last = ['Banda', 'Phiri', 'Mwale', 'Tembo', 'Zulu', 'Mumba', 'Sakala', 'Lungu', 'Chisenga', 'Ngoma', 'Kapata', 'Mwansa'];
    const countries = ['Zambia', 'United States', 'United Kingdom', 'Canada', 'Australia', 'South Africa', 'Zambia', 'Zambia'];
    const donMethods = ['Donorbox', 'Donorbox', 'Donorbox', 'PayPal', 'Stripe', 'DPO Pay', 'Mobile Money — MTN', 'Mobile Money — Airtel', 'Bank transfer', 'Zelle'];
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const out = [];
    const start = addMonths(today(), -15);
    const dateAt = f => { const d = new Date(Date.parse(start) + f * (Date.parse(today()) - Date.parse(start))); return d.toISOString().slice(0, 10); };
    for (let i = 0; i < 36; i++) {
      const n = `${pick(first)} ${pick(last)}`;
      const method = pick(donMethods);
      const zmw = /Mobile|DPO/.test(method) && rnd() > .3;
      out.push({ date: dateAt(rnd()), type: 'donation', tier: '', name: n, email: n.toLowerCase().replace(' ', '.') + '@example.com', phone: '', country: zmw ? 'Zambia' : pick(countries),
        amount: zmw ? pick([250, 500, 1000, 2000]) : pick([25, 50, 50, 100, 100, 250, 500]), currency: zmw ? 'ZMW' : 'USD', method, ref: 'SAMPLE-D' + i, notes: '',
        designation: pick(['general', 'general', 'general', ...DESIGNATIONS_FALLBACK.slice(1).map(d => d.id)]) });
    }
    for (let i = 0; i < 24; i++) {
      const n = `${pick(first)} ${pick(last)}`;
      const t = pick(TIERS.length ? TIERS : [{ id: '', amount: 100, currency: 'USD' }]);
      out.push({ date: dateAt(rnd()), type: 'membership', tier: t.id, name: n, email: n.toLowerCase().replace(' ', '.') + '@example.com', phone: '', country: /developing/.test(t.id) ? 'Zambia' : pick(countries.slice(1, 5)),
        amount: t.amount, currency: t.currency, method: pick(['Donorbox', 'Stripe', 'PayPal', 'DPO Pay', 'Mobile Money — MTN', 'Bank transfer']), ref: 'SAMPLE-M' + i, notes: '' });
    }
    return out;
  }

  /* =====================================================================
     INIT
     ===================================================================== */
  async function init() {
    bindActions();
    document.body.classList.toggle('api-mode', !!API);
    try { await Promise.all([load(), loadMessages()]); } catch (err) { if (err.message !== 'signed out') banner('warn', `Could not load payments: ${esc(err.message)}`); }
    const start = location.hash.slice(1);
    const tabs = ['overview', 'members', 'donations', 'record', 'import', 'setup'].concat(API ? ['messages'] : []);
    showTab(tabs.includes(start) ? start : 'overview');
    syncLabel();
    loadSheet(false);
    if (API) {
      // New online payments arrive via webhooks — pull them in automatically.
      setInterval(() => { if (!document.hidden) refresh(); }, 60000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (lastSync || 0) > 30000) refresh(); });
      $('#refresh-btn').addEventListener('click', refresh);
      api('/config').then(c => {
        apiConfig = c;
        fillRecordDesignations(); // designation labels may differ from the built-in copy
        if (['overview', 'donations', 'setup'].includes(tab)) render();
      }).catch(() => {});
    }
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { await Promise.all([load(), loadMessages()]); render(); } catch (err) { if (err.message !== 'signed out') banner('warn', `Could not refresh: ${esc(err.message)}`); }
    refreshing = false;
    syncLabel();
  }
  function syncLabel() {
    const el = $('#sync-label');
    if (!API || !el) return;
    el.textContent = lastSync ? 'Updated ' + lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not synced';
  }

  let remembered = null;
  try { remembered = API ? sessionStorage.getItem(TOKEN_KEY) : sessionStorage.getItem(SESSION_KEY); } catch {}
  if (remembered && (API || remembered === DC.passcodeHash)) unlock();
  else setTimeout(() => $('#lock-pass').focus(), 50);
})();
