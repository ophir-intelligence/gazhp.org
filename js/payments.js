/* =============================================
   GAZHP — Payment options (/donate/ and /join/)
   Mount point:
     <div id="payment-options" data-purpose="donation|membership"></div>

   Two modes:
   • Automated — `api.baseUrl` is set and the API answers: our own form sends
     donors to Stripe / PayPal / DPO Pay checkout via the GAZHP API, and
     payments record themselves in the dashboard. Offline methods (bank,
     Zelle…) report through the API as "pending" for an admin to confirm.
   • Links — no API: every gateway enabled AND filled in inside
     js/payments-config.js (Donorbox, payment links, account details).

   Automated mode extras (read from GET /config):
   • designations — donations get a "Where should your gift go?" select;
     the chosen id is sent to /checkout, /momo/start and /notify.
   • momoDirect: true — "Mobile Money (Zambia)" opens an inline form instead
     of DPO Pay's page: POST /momo/start sends a payment prompt to the donor's
     phone, then GET /momo/status is polled every 5 s for up to 2 minutes.
     When momoDirect is false or missing, the button goes to DPO's page as before.
   ============================================= */
(function () {
  const root = document.getElementById('payment-options');
  const CFG = window.GAZHP_CONFIG;
  if (!root || !CFG) return;

  const has = v => typeof v === 'string' && v.trim() !== '';
  const purpose = root.dataset.purpose === 'membership' ? 'membership' : 'donation';
  const G = CFG.gateways || {};
  let tiers = CFG.membershipTiers || [];
  const API = has((CFG.api || {}).baseUrl) ? CFG.api.baseUrl.trim().replace(/\/+$/, '') : '';
  let apiCfg = null;   // GET /config response once loaded
  const online = () => !!(apiCfg && Object.values(apiCfg.gateways || {}).some(Boolean));
  // Form state for automated mode (survives re-renders).
  const st = { amount: '', currency: 'USD', freq: 'once', autoRenew: false, name: '', email: '', phone: '', country: '', profession: '', designation: '' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
  const joinOr = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // One polite live region, outside the re-rendered widget, for short announcements (e.g. "Account number copied").
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  root.insertAdjacentElement('afterend', live);
  const announce = text => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); };
  const money = (n, cur = 'USD') => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
    catch { return cur + ' ' + n; }
  };

  // Reference code so offline payments (mobile money, bank, Zelle…) can be matched in the dashboard.
  const refCode = (() => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return 'GAZHP-' + (purpose === 'membership' ? 'M' : 'D') + '-' + s;
  })();

  let selectedTier = tiers[0] || null;

  /* ---------- Gift designations (automated mode, donations only) ---------- */
  const designations = () => (online() && purpose === 'donation' && Array.isArray(apiCfg.designations))
    ? apiCfg.designations.filter(d => d && has(d.id)) : [];
  const designationLabel = id => { const d = designations().find(x => x.id === id); return d ? (d.label || d.id) : ''; };
  const designationSelect = (cls = 'full') => {
    const list = designations();
    if (!list.length) return '';
    return `<label${cls ? ` class="${cls}"` : ''}>Where should your gift go?<select name="designation">${list.map(d =>
      `<option value="${esc(d.id)}"${d.id === st.designation ? ' selected' : ''}>${esc(d.label || d.id)}</option>`).join('')}</select></label>`;
  };

  /* ---------- Direct mobile money (Zambia) ---------- */
  const MOMO_OPS = [['mtn', 'MTN MoMo', 'MTN'], ['airtel', 'Airtel Money', 'Airtel'], ['zamtel', 'Zamtel Kwacha', 'Zamtel']];
  const opName = id => (MOMO_OPS.find(o => o[0] === id) || [])[1] || '';
  // Zambian mobile ranges (ZICTA numbering plan). National numbers are 9 digits after +260 / 260 / 0.
  const ZM_PREFIX = { 96: 'mtn', 76: 'mtn', 97: 'airtel', 77: 'airtel', 57: 'airtel', 95: 'zamtel', 75: 'zamtel' };
  const zmPhone = v => {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('00260')) d = d.slice(5); else if (d.startsWith('260')) d = d.slice(3); else if (d.startsWith('0')) d = d.slice(1);
    return { nsn: d, valid: /^[579]\d{8}$/.test(d), operator: ZM_PREFIX[d.slice(0, 2)] || '' };
  };
  const fmtZm = nsn => `0${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`;
  const momoOn = () => online() && apiCfg.momoDirect === true && !!apiCfg.gateways.dpo;
  // Networks the API can prompt: all three unless /config lists fewer in `momoOperators`.
  const momoOps = () => (apiCfg && Array.isArray(apiCfg.momoOperators)) ? apiCfg.momoOperators : MOMO_OPS.map(o => o[0]);
  const MOMO_WAIT = 2 * 60000, MOMO_POLL = 5000;
  // True while a /checkout or /momo/start request is in flight: further pay clicks are ignored,
  // even after a re-render (e.g. a tier change) has rebuilt the buttons.
  let busy = false;
  // view: 'form' (inline form in step 3, shown while `open`) | 'processing' | 'success' | 'failed' | 'timeout'
  // auto: mm.operator was picked from the number's prefix (not by the donor), so it may be dropped again.
  const mm = { open: false, view: 'form', phone: '', operator: '', auto: false, detected: '', reference: '', message: '', instructions: '', note: '', fallback: '', prev: null, stopped: false, resumed: false, deadline: 0, window: MOMO_WAIT, snap: {} };
  const httpsUrl = v => typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v);
  // The kwacha amount the donor approves: the gift itself, or the membership price at the API's rate.
  const momoAmountText = () => {
    if (purpose === 'membership') {
      const t = selectedTier, rate = (apiCfg && apiCfg.zmwPerUsd) || 0;
      if (!t) return '';
      if (t.currency === 'ZMW') return money(t.amount, 'ZMW');
      return rate ? '≈ ' + money(Math.ceil(t.amount * rate), 'ZMW') : '';
    }
    return st.currency === 'ZMW' && Number(st.amount) > 0 ? money(Number(st.amount), 'ZMW') : '';
  };
  const momoHint = ph => {
    if (!ph.nsn) return 'A Zambian number, e.g. 097 123 4567. The payment request goes to this phone.';
    if (ph.nsn.length >= 9 && !ph.valid) return "That doesn't look like a Zambian mobile number. Try the format 097 123 4567.";
    if (ph.operator) {
      return momoOps().includes(ph.operator)
        ? `${opName(ph.operator)} number. Not right? Choose your network below.`
        : `${opName(ph.operator)} number: payment prompts aren't available for this network yet. Please use another number or payment method.`;
    }
    return ph.valid ? 'Please choose your network below.' : 'A Zambian number, e.g. 097 123 4567.';
  };
  // Remembers a started request for this tab, so a reload (e.g. after switching to the phone's
  // payment prompt) picks up the waiting screen instead of losing the payment.
  const MOMO_KEY = 'gazhp-momo-' + purpose;
  const saveMomo = () => { try { sessionStorage.setItem(MOMO_KEY, JSON.stringify({ ref: mm.reference, at: Date.now(), snap: mm.snap })); } catch { /* storage blocked */ } };
  const forgetMomo = () => { try { sessionStorage.removeItem(MOMO_KEY); } catch { /* storage blocked */ } };
  const loadMomo = () => {
    try {
      const s = JSON.parse(sessionStorage.getItem(MOMO_KEY) || 'null');
      return s && typeof s.ref === 'string' && s.ref && Date.now() - Number(s.at) < 15 * 60000 ? s : null;
    } catch { return null; }
  };

  /* ---------- Row helpers ---------- */
  const row = (label, value) => has(value)
    ? `<div class="pay-detail"><span class="pay-detail-label">${esc(label)}</span><span class="pay-detail-value">${esc(value)}</span><button type="button" class="pay-copy" data-copy="${esc(value)}" data-label="${esc(label)}" aria-label="Copy ${esc(label)}">Copy</button></div>`
    : '';
  const referenceRow = () => row('Reference / note', refCode);
  // Checkout links (Stripe / PayPal payment links) open in the same tab: the provider sends the
  // donor back to /thank-you/ afterwards, which only makes sense in the original tab.
  const payBtn = (url, label, cls = 'btn-teal') =>
    `<a class="btn ${cls} pay-link-btn" href="${esc(url)}">${esc(label)} <span aria-hidden="true">→</span></a>`;
  const linkBtn = (url, label, cls = 'btn-teal') =>
    `<a class="btn ${cls} pay-link-btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}<span class="sr-only"> (opens in a new tab)</span> <span aria-hidden="true">↗</span></a>`;
  // Smooth scrolling only when the visitor hasn't asked for reduced motion.
  const scrollBehavior = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth';
  const notifyBlock = (method) => {
    if (online()) return notifyForm(method);
    const subject = `${purpose === 'membership' ? 'Membership payment' : 'Donation'} sent — ${refCode}`;
    const amountLine = purpose === 'membership' && selectedTier
      ? `Membership: ${selectedTier.name} (${selectedTier.region}) — ${money(selectedTier.amount, selectedTier.currency)}`
      : 'Amount: ';
    const body = [
      `Hello GAZHP,`, ``,
      `I have sent a payment by ${method}.`, ``,
      `Reference: ${refCode}`, amountLine,
      `Date sent: `, `Full name: `, `Email: `, `Phone: `, `Country: `,
      purpose === 'membership' ? `Profession / institution: ` : `Please send my receipt to the email above.`,
    ].join('\n');
    const href = `mailto:${CFG.org.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return `<div class="pay-notify">
      <p><strong>Important:</strong> include the reference <code>${esc(refCode)}</code> with your payment, then tell us you've paid so we can issue your ${purpose === 'membership' ? 'membership confirmation' : 'receipt'}.</p>
      <a class="btn btn-green pay-link-btn" href="${esc(href)}">I've paid — notify GAZHP</a>
    </div>`;
  };
  // Automated mode: donor reports the payment → saved as "pending" in the dashboard.
  const notifyForm = method => {
    const isMomo = method === 'Mobile Money';
    const t = purpose === 'membership' ? selectedTier : null;
    const nets = ['MTN', 'Airtel', 'Zamtel'].filter(n => { const g = (G.mobileMoney || {})[n.toLowerCase()]; return g && (has(g.number) || has(g.merchantCode)); });
    return `<form class="pay-notify pay-notify-form" data-method="${esc(method)}" novalidate>
      <p><strong>After you've sent the money</strong>, include the reference <code>${esc(refCode)}</code> and tell us here so we can match it and send your ${purpose === 'membership' ? 'membership confirmation' : 'receipt'}.</p>
      <div class="pay-grid">
        ${isMomo ? `<label>Network<select name="network">${(nets.length ? nets : ['MTN', 'Airtel', 'Zamtel']).map(n => `<option value="Mobile Money — ${n}">${n}</option>`).join('')}</select></label>` : ''}
        <label>Full name*<input name="name" autocomplete="name" required value="${esc(st.name)}" /></label>
        <label>Email*<input type="email" name="email" autocomplete="email" required value="${esc(st.email)}" /></label>
        <label>Amount sent*<input type="number" name="amount" min="1" step="0.01" inputmode="decimal" required value="${t && !isMomo ? t.amount : ''}" /></label>
        <label>Currency<select name="currency">${['USD', 'ZMW', 'GBP', 'EUR', 'CAD', 'AUD', 'ZAR'].map(c => `<option${c === (isMomo ? 'ZMW' : 'USD') ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>Date sent<input type="date" name="date" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}" /></label>
        <label>Phone<input name="phone" autocomplete="tel" value="${esc(st.phone)}" /></label>
        ${purpose === 'donation' ? designationSelect() : ''}
      </div>
      <input type="text" name="website" class="pay-hp" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <button type="submit" class="btn btn-green pay-link-btn">I've paid — notify GAZHP</button>
      <p class="pay-form-msg" id="pay-notify-msg" role="status"></p>
    </form>`;
  };
  const tierLink = gw => (selectedTier && gw.membershipLinks && has(gw.membershipLinks[selectedTier.id])) ? gw.membershipLinks[selectedTier.id] : '';
  // Approximate Kwacha equivalent, from dashboard.fxRates (1 ZMW = x USD).
  const fx = (CFG.dashboard || {}).fxRates || {};
  const inZmw = t => (t.currency !== 'ZMW' && fx.ZMW && fx[t.currency])
    ? ` <span>(≈ ${money(Math.round(t.amount * fx[t.currency] / fx.ZMW / 10) * 10, 'ZMW')})</span>` : '';
  const amountHint = (showZmw = false) => purpose === 'membership' && selectedTier
    ? `<p class="pay-amount">Amount due: <strong>${money(selectedTier.amount, selectedTier.currency)}</strong>${showZmw ? inZmw(selectedTier) : ''} <span>— ${esc(selectedTier.name)}, ${esc(selectedTier.region)}</span></p>`
    : '';

  /* ---------- Gateway definitions ---------- */
  // Each returns null when not configured for this purpose, else { id, title, sub, body }.
  const methods = [
    function donorbox() {
      if (online()) return null; // replaced by our own checkout
      const g = G.donorbox || {};
      const campaign = purpose === 'membership' ? g.membershipCampaign : g.donationCampaign;
      if (!g.enabled || !has(campaign)) return null;
      return {
        id: 'donorbox', title: 'Card, Apple Pay, Google Pay, PayPal', sub: 'Secure checkout by Donorbox',
        body: `<div class="donorbox-wrap" style="margin-top:0;">
          <dbox-widget campaign="${esc(campaign)}" type="donation_form" enable-auto-scroll="true"></dbox-widget></div>`,
        onShow() {
          if (!document.querySelector('script[src="https://donorbox.org/widgets.js"]')) {
            const s = document.createElement('script');
            s.type = 'module'; s.src = 'https://donorbox.org/widgets.js'; s.async = true;
            document.head.appendChild(s);
          }
        },
      };
    },
    function stripe() {
      if (online()) return null;
      const g = G.stripe || {};
      if (!g.enabled) return null;
      if (purpose === 'membership') {
        const url = tierLink(g);
        if (!url) return null;
        return { id: 'stripe', title: 'Card via Stripe', sub: 'Visa, Mastercard, Amex, Apple Pay, Google Pay', body: amountHint() + payBtn(url, 'Pay membership securely') };
      }
      if (!has(g.donationLink) && !has(g.monthlyDonationLink)) return null;
      // A monthly link priced per US$1 with adjustable quantity lets donors pick any monthly amount.
      const perUnit = Number(g.monthlyPerUnit) > 0;
      const monthlyHow = has(g.monthlyDonationLink) && perUnit
        ? `<p class="pay-amount" style="margin-top:12px;"><strong>Giving monthly?</strong> <span>On the next page, set the quantity to the number of US dollars you'd like to give each month: 25 = US$25 a month. You can change or cancel it anytime on our <a href="/manage-giving/">Manage your gift</a> page.</span></p>`
        : '';
      return {
        id: 'stripe', title: 'Card via Stripe', sub: 'Visa, Mastercard, Amex, Apple Pay, Google Pay',
        body: `<div class="pay-btn-row">${has(g.donationLink) ? payBtn(g.donationLink, 'Give once') : ''}${has(g.monthlyDonationLink) ? payBtn(g.monthlyDonationLink, 'Give monthly', 'btn-green') : ''}</div>${monthlyHow}`,
      };
    },
    function paypal() {
      if (online()) return null;
      const g = G.paypal || {};
      if (!g.enabled) return null;
      let url = '';
      if (purpose === 'membership') {
        url = tierLink(g) || (has(g.paypalMeUsername) && selectedTier ? `https://paypal.me/${encodeURIComponent(g.paypalMeUsername)}/${selectedTier.amount}${selectedTier.currency}` : '');
      } else {
        url = has(g.hostedButtonId) ? `https://www.paypal.com/donate/?hosted_button_id=${encodeURIComponent(g.hostedButtonId)}`
          : has(g.paypalMeUsername) ? `https://paypal.me/${encodeURIComponent(g.paypalMeUsername)}` : '';
      }
      if (!url) return null;
      return { id: 'paypal', title: 'PayPal', sub: 'PayPal balance, cards, Venmo (US)', body: amountHint() + linkBtn(url, purpose === 'membership' ? 'Pay membership with PayPal' : 'Donate with PayPal') };
    },
    function dpo() {
      if (online()) return null;
      const g = G.dpo || {};
      if (!g.enabled) return null;
      const url = purpose === 'membership' ? tierLink(g) : g.donationLink;
      if (!has(url)) return null;
      return { id: 'dpo', title: 'Zambia: Mobile Money or Card', sub: 'DPO Pay · MTN, Airtel, Visa/Mastercard — ZMW or USD', body: amountHint(true) + linkBtn(url, 'Pay with DPO Pay') };
    },
    function mobileMoney() {
      const g = G.mobileMoney || {};
      if (!g.enabled) return null;
      const nets = [['MTN MoMo', g.mtn], ['Airtel Money', g.airtel], ['Zamtel Kwacha', g.zamtel]]
        .filter(([, n]) => n && (has(n.number) || has(n.merchantCode)));
      if (!nets.length) return null;
      const blocks = nets.map(([name, n]) => `<div class="pay-subblock"><h5>${esc(name)}</h5>${row('Send to number', n.number)}${row('Merchant / till code', n.merchantCode)}</div>`).join('');
      return {
        id: 'mobile', title: 'Mobile Money (Zambia)', sub: nets.map(n => n[0]).join(' · '),
        body: amountHint(true) + row('Account name', g.accountName) + `<div class="pay-subgrid">${blocks}</div>` + referenceRow() + notifyBlock('Mobile Money'),
      };
    },
    function bank() {
      const g = G.bankTransfer || {};
      if (!g.enabled) return null;
      const us = g.us || {}, zm = g.zambia || {};
      const usOk = has(us.accountNumber), zmOk = has(zm.accountNumber);
      if (!usOk && !zmOk) return null;
      const usBlock = usOk ? `<div class="pay-subblock"><h5>United States (ACH / wire)</h5>${row('Bank', us.bankName)}${row('Account name', us.accountName)}${row('Account number', us.accountNumber)}${row('ACH routing', us.routingNumber)}${row('Wire routing', us.wireRoutingNumber)}${row('SWIFT (international)', us.swift)}${row('Bank address', us.bankAddress)}</div>` : '';
      const zmBlock = zmOk ? `<div class="pay-subblock"><h5>Zambia (${esc(zm.currency || 'ZMW')})</h5>${row('Bank', zm.bankName)}${row('Account name', zm.accountName)}${row('Account number', zm.accountNumber)}${row('Branch', zm.branch)}${row('Branch code', zm.branchCode)}${row('SWIFT', zm.swift)}</div>` : '';
      return { id: 'bank', title: 'Bank Transfer', sub: [usOk && 'US account', zmOk && 'Zambian account'].filter(Boolean).join(' · '), body: amountHint(zmOk) + `<div class="pay-subgrid">${usBlock}${zmBlock}</div>` + referenceRow() + notifyBlock('Bank transfer') };
    },
    function zelle() {
      const g = G.zelle || {};
      if (!g.enabled || !has(g.emailOrPhone)) return null;
      return { id: 'zelle', title: 'Zelle', sub: 'From most US bank apps', body: amountHint() + row('Send to', g.emailOrPhone) + row('Recipient name', g.recipientName) + referenceRow() + notifyBlock('Zelle') };
    },
    function cashApp() {
      const g = G.cashApp || {};
      if (!g.enabled || !has(g.cashtag)) return null;
      const tag = g.cashtag.replace(/^\$/, '');
      const amt = purpose === 'membership' && selectedTier ? '/' + selectedTier.amount : '';
      return { id: 'cashapp', title: 'Cash App', sub: '$' + tag, body: amountHint() + linkBtn(`https://cash.app/$${encodeURIComponent(tag)}${amt}`, 'Open Cash App') + referenceRow() + notifyBlock('Cash App') };
    },
    function venmo() {
      const g = G.venmo || {};
      if (!g.enabled || !has(g.username)) return null;
      const u = g.username.replace(/^@/, '');
      return { id: 'venmo', title: 'Venmo', sub: '@' + u, body: amountHint() + linkBtn(`https://venmo.com/${encodeURIComponent(u)}`, 'Open Venmo') + referenceRow() + notifyBlock('Venmo') };
    },
    function check() {
      const g = G.check || {};
      if (!g.enabled || !has(CFG.org.mailingAddress)) return null;
      return { id: 'check', title: 'Check by Mail', sub: 'US checks', body: amountHint() + row('Payable to', g.payableTo) + row('Mail to', CFG.org.mailingAddress) + row('Memo line', refCode) + notifyBlock('Check') };
    },
    ...((G.custom || []).map((c, i) => function custom() {
      if (!c || !c.enabled || !has(c.url) || !has(c.name)) return null;
      if (c.purpose && c.purpose !== 'both' && c.purpose !== purpose) return null;
      return { id: 'custom-' + i, title: c.name, sub: c.description || '', body: amountHint() + linkBtn(c.url, 'Continue to ' + c.name) };
    })),
  ];

  /* ---------- Render ---------- */
  let activeId = null;

  const tierPickerHtml = legend => `
    <fieldset class="pay-tiers">
      <legend>${legend}</legend>
      <div class="pay-tier-grid">
        ${tiers.map(t => `<label class="pay-tier${selectedTier && t.id === selectedTier.id ? ' selected' : ''}">
          <input type="radio" name="pay-tier" value="${esc(t.id)}"${selectedTier && t.id === selectedTier.id ? ' checked' : ''} />
          <span class="pay-tier-name">${esc(t.name)}</span>
          <span class="pay-tier-region">${esc(t.region)}</span>
          <span class="pay-tier-amount">${money(t.amount, t.currency)}<small>/ year</small></span>
        </label>`).join('')}
      </div>
    </fieldset>`;

  // Method picker (toggle buttons) + the panel for the chosen method.
  function methodsHtml(list, single) {
    if (!list.some(m => m.id === activeId)) activeId = list[0].id;
    const active = list.find(m => m.id === activeId);
    return `<div class="pay-methods" role="group" aria-label="Payment methods"${single ? ' hidden' : ''}>
        ${list.map(m => `<button type="button" class="pay-method${m.id === activeId ? ' active' : ''}" aria-pressed="${m.id === activeId}" aria-controls="pay-panel" data-id="${esc(m.id)}">
          <span class="pay-method-title">${esc(m.title)}</span><span class="pay-method-sub">${esc(m.sub)}</span></button>`).join('')}
      </div>
      <div class="pay-panel${single ? ' pay-panel-single' : ''}" id="pay-panel" role="region" aria-label="${esc(active.title)} details">${active.body}</div>`;
  }
  // Names only the processors actually offered right now (API gateways, or the configured link/Donorbox methods).
  const PROCESSORS = { donorbox: 'Donorbox', stripe: 'Stripe', paypal: 'PayPal', dpo: 'DPO Pay' };
  const processorNames = list => online()
    ? ['stripe', 'paypal', 'dpo'].filter(k => apiCfg.gateways[k]).map(k => PROCESSORS[k])
    : list.map(m => PROCESSORS[m.id]).filter(Boolean);
  const legalLine = (style = '') => `<p class="pay-secure pay-legal prose-links"${style ? ` style="${style}"` : ''}><span>By continuing you agree to our <a href="/terms/">Terms &amp; Refund Policy</a> and <a href="/privacy/">Privacy Policy</a>.</span></p>`;
  // The 501(c)(3) / tax-deductibility sentence lives in the /donate/ and /join/ page copy right above
  // this widget, so it isn't repeated here; the EIN is added automatically once org.ein is filled in.
  const secureNote = (list, withLegal) => {
    const names = processorNames(list);
    const text = [
      names.length ? `Card payments are processed securely by ${joinOr(names)} — GAZHP never sees your card details.` : '',
      momoOn() ? 'Mobile money is approved with your PIN on your own phone, so GAZHP never sees it.' : '',
      has(CFG.org.ein) ? `GAZHP's US EIN: ${esc(CFG.org.ein)}.` : '',
    ].filter(Boolean).join(' ');
    return (text ? `<p class="pay-secure"><svg class="icon" style="width:13px;height:13px;" aria-hidden="true" focusable="false"><use href="#i-lock"/></svg><span>${text}</span></p>` : '')
      + (withLegal ? legalLine(text ? 'margin-top:6px;' : '') : '');
  };
  const cancelledNote = () => new URLSearchParams(location.search).get('cancelled')
    ? '<p class="pay-cancelled" role="status">Payment cancelled — no money was taken. You can try again below.</p>' : '';

  /* ----- Automated mode: our own form → gateway checkout ----- */
  function onlineHtml() {
    const g = apiCfg.gateways, d = apiCfg.donation || {};
    const isM = purpose === 'membership';
    const recurring = isM ? st.autoRenew : st.freq === 'month';
    const zmw = st.currency === 'ZMW';
    const rate = apiCfg.zmwPerUsd || 0;
    let html = cancelledNote() + '<form class="pay-form" id="pay-form" novalidate>';

    if (isM) {
      html += tierPickerHtml('1. Choose your membership');
    } else {
      const presets = (d.presets && d.presets[st.currency]) || [];
      html += `<fieldset class="pay-fs"><legend>1. Choose an amount</legend>
        ${g.stripe ? `<div class="pay-toggle" role="radiogroup" aria-label="Frequency">
          <label class="${st.freq === 'once' ? 'on' : ''}"><input type="radio" name="freq" value="once"${st.freq === 'once' ? ' checked' : ''} />Give once</label>
          <label class="${st.freq === 'month' ? 'on' : ''}"><input type="radio" name="freq" value="month"${st.freq === 'month' ? ' checked' : ''} />Give monthly</label>
        </div>` : ''}
        <div class="pay-amounts" role="group" aria-label="Suggested amounts">${presets.map(a => `<button type="button" class="pay-amt${Number(st.amount) === a ? ' selected' : ''}" aria-pressed="${Number(st.amount) === a}" data-amt="${a}">${money(a, st.currency)}</button>`).join('')}</div>
        <div class="pay-grid">
          <label>Amount (${esc(st.currency)})<input type="number" name="amount" min="${(d.min && d.min[st.currency]) || 1}" step="1" inputmode="decimal" placeholder="Other amount" value="${esc(st.amount)}" /></label>
          ${g.dpo ? `<label>Currency<select name="currency"><option value="USD"${!zmw ? ' selected' : ''}>US dollars (USD)</option><option value="ZMW"${zmw ? ' selected' : ''}>Zambian kwacha (ZMW)</option></select></label>` : ''}
          ${designationSelect()}
        </div>
      </fieldset>`;
    }

    html += `<fieldset class="pay-fs"><legend>2. Your details</legend>
      <div class="pay-grid">
        <label>Full name*<input name="name" autocomplete="name" required value="${esc(st.name)}" /></label>
        <label>Email*<input type="email" name="email" autocomplete="email" required value="${esc(st.email)}" /></label>
        <label>Phone<input name="phone" autocomplete="tel" value="${esc(st.phone)}" /></label>
        <label>Country<input name="country" autocomplete="country-name" value="${esc(st.country)}" /></label>
        ${isM ? `<label class="full">Profession / institution<input name="profession" value="${esc(st.profession)}" /></label>` : ''}
      </div>
    </fieldset>`;

    const t = selectedTier;
    const momoAmt = isM && t && t.currency === 'USD' && rate ? ` (≈ ${money(Math.ceil(t.amount * rate), 'ZMW')})` : '';
    const btn = (gw, title, sub, off, why) => `<button type="button" class="pay-gw" data-gw="${gw}"${off ? ` disabled title="${esc(why)}"` : ''}>
        <span class="pay-gw-title">${title}</span><span class="pay-gw-sub">${off ? esc(why) : sub}</span></button>`;
    // Direct mobile money: the button opens the inline form (step 3) instead of DPO's page.
    const direct = g.dpo && momoOn();
    const open = direct && mm.open && !recurring;
    const momoBtn = () => `<button type="button" class="pay-gw" data-gw="momo" aria-expanded="${open}"${open ? ' aria-controls="pay-momo"' : ''}${recurring ? ' disabled title="Recurring payments use card"' : ''}>
        <span class="pay-gw-title">Mobile Money (Zambia)</span><span class="pay-gw-sub">${recurring ? 'Recurring payments use card'
          : esc(MOMO_OPS.filter(o => momoOps().includes(o[0])).map(o => o[2]).join(' · ')) + ' — approve on your phone' + momoAmt}</span></button>`;
    const manage = g.stripe
      ? `<p class="pay-manage prose-links">${isM ? 'Membership renewing automatically? <a href="/manage-giving/">Manage your renewal</a>' : 'Already give monthly? <a href="/manage-giving/">Manage your monthly gift</a>'}</p>` : '';
    html += `<fieldset class="pay-fs"><legend>3. Pay</legend>
      ${isM && g.stripe ? `<label class="pay-check"><input type="checkbox" name="autoRenew"${st.autoRenew ? ' checked' : ''} />Renew my membership automatically every year (card only)</label>` : ''}
      ${mm.stopped ? `<p class="pay-cancelled" role="status">We've stopped waiting for your mobile money approval. If you still approve that request on your phone, the payment will go through and be recorded, so please don't pay twice.</p>` : ''}
      <div class="pay-gws">
        ${g.stripe ? btn('stripe', 'Card, Apple Pay or Google Pay', 'Visa · Mastercard · Amex', zmw, 'Choose USD to pay by card') : ''}
        ${g.paypal ? btn('paypal', 'PayPal', 'PayPal balance or card', zmw || recurring, zmw ? 'Choose USD to use PayPal' : 'Recurring payments use card') : ''}
        ${g.dpo ? (direct ? momoBtn() : btn('dpo', 'Mobile Money (Zambia)', 'MTN · Airtel · Zambian cards — via DPO Pay' + momoAmt, recurring, 'Recurring payments use card')) : ''}
      </div>
      ${open ? momoFormHtml() : ''}
      ${legalLine('text-align:left;justify-content:flex-start;margin-top:12px;')}
      ${manage}
      <p class="pay-form-err" id="pay-err" role="alert"></p>
    </fieldset></form>`;
    return html;
  }

  /* ----- Direct mobile money: inline form, then a waiting / result card ----- */
  const momoSumHtml = () => {
    const amt = momoAmountText();
    if (purpose === 'membership') {
      const t = selectedTier;
      return `Membership: <strong>${amt ? esc(amt) : 'charged in Zambian kwacha'}</strong>${t ? ` <span>— ${esc(t.name)}, ${esc(t.region)}</span>` : ''}`;
    }
    if (!amt) return 'Choose or enter an amount in kwacha above.';
    const where = designationLabel(st.designation);
    return `Your gift: <strong>${esc(amt)}</strong>${where ? ` <span>— ${esc(where)}</span>` : ''}`;
  };
  function momoFormHtml() {
    const avail = momoOps();
    return `<div class="pay-momo" id="pay-momo" role="region" aria-labelledby="pay-momo-title">
      <h3 class="pay-momo-title" id="pay-momo-title" tabindex="-1">Pay with mobile money</h3>
      <p class="pay-amount" id="pay-momo-sum">${momoSumHtml()}</p>
      ${mm.note ? `<p class="pay-momo-note" id="pay-momo-note">${esc(mm.note)}</p>` : ''}
      <label class="pay-momo-phone">Mobile money number*
        <input type="tel" name="momoPhone" inputmode="tel" autocomplete="tel" placeholder="e.g. 097 123 4567" required value="${esc(mm.phone)}" aria-describedby="pay-momo-hint" data-hint="pay-momo-hint" />
      </label>
      <p class="pay-momo-hint" id="pay-momo-hint">${esc(momoHint(zmPhone(mm.phone)))}</p>
      <fieldset class="pay-ops"><legend>Network*</legend>
        <div class="pay-op-grid">${MOMO_OPS.map(([id, name, short]) => {
          const on = avail.includes(id), sel = on && mm.operator === id;
          return `<label class="pay-op${sel ? ' selected' : ''}${on ? '' : ' off'}">
            <input type="radio" name="momoOp" value="${id}"${sel ? ' checked' : ''}${on ? '' : ' disabled'} />
            <span class="pay-op-badge" aria-hidden="true">${esc(short.charAt(0))}</span>
            <span class="pay-op-name">${esc(name)}</span>${on ? '' : '<span class="pay-op-sub">Not available</span>'}</label>`;
        }).join('')}</div>
      </fieldset>
      <button type="button" class="btn btn-green pay-momo-send" data-momo="send">Send payment prompt</button>
      ${httpsUrl(mm.fallback) ? `<a class="btn btn-teal pay-momo-send" id="pay-momo-fallback" href="${esc(mm.fallback)}">Continue on DPO Pay's page</a>` : ''}
      <p class="pay-momo-alt">You'll get a prompt on your phone to approve the payment with your PIN.${httpsUrl(mm.fallback) ? '' : ` No prompt, or paying with a Zambian card? <button type="button" class="pay-textbtn" data-momo="hosted">Pay on DPO Pay's secure page instead</button>`}</p>
    </div>`;
  }

  const SVG = {
    phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    ok: '<polyline points="20 6 9 17 4 12"/>',
    bad: '<path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="10"/>',
    wait: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };
  const svg = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SVG[name]}</svg>`;
  const momoLeft = () => {
    const secs = Math.ceil(Math.max(0, mm.deadline - Date.now()) / 1000);
    return { text: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, done: Math.min(100, Math.max(0, 100 - (secs * 1000 / mm.window) * 100)) };
  };
  function momoStatusHtml() {
    const s = mm.snap || {}, isM = purpose === 'membership';
    const card = (kind, icon, title, body, actions) => `<div class="pay-momo-status is-${kind}" id="pay-momo-status">
      ${icon}<h3 class="pay-momo-head" id="pay-momo-head" tabindex="-1">${title}</h3>${body}
      ${actions ? `<div class="pay-momo-actions">${actions}</div>` : ''}</div>`;
    const another = '<button type="button" class="btn btn-outline-dark" data-momo="stop">Use another method</button>';
    const to = `${s.amount ? ` for <strong>${esc(String(s.amount).replace(/^≈ /, 'about '))}</strong>` : ''}${s.phone ? ` to <strong>${esc(s.phone)}</strong>` : ''}${s.op ? ` (${esc(s.op)})` : ''}`;
    if (mm.view === 'processing') {
      const left = momoLeft();
      return card('wait', `<div class="pay-momo-visual" aria-hidden="true"><span class="pay-momo-ring"></span>${svg('phone')}</div>`,
        mm.resumed ? 'Checking your payment' : 'Check your phone',
        (mm.resumed
          ? `<p>We're checking the mobile money request${to}.</p><p class="pay-momo-msg">If your phone is still showing the prompt, enter your PIN to approve it.</p>`
          : `<p>We've sent a payment request${to}.</p><p class="pay-momo-msg">${esc(mm.message || 'Check your phone and enter your PIN to approve.')}</p>`
            // The network's own steps (plain text from the API), e.g. how to approve by hand if no prompt shows.
            // Skip the operator's instructions when they only repeat the message above.
            + (mm.instructions && !(mm.message || '').includes(mm.instructions.trim()) ? `<p class="pay-momo-small pay-momo-msg">${esc(mm.instructions)}</p>` : ''))
        + `<div class="pay-momo-bar" aria-hidden="true"><span id="pay-momo-bar" style="width:${left.done}%"></span></div>
          <p class="pay-momo-small pay-momo-count">Waiting for approval · <span id="pay-momo-timer">${left.text}</span> left<span class="sr-only">. This page updates by itself.</span></p>
          <p class="pay-momo-small">Keep this page open. No prompt after a minute? Check that your phone is on and has signal.</p>`,
        another);
    }
    if (mm.view === 'success') {
      const thanks = `/thank-you/?gw=dpo&purpose=${purpose}&status=paid`;
      return card('ok', `<div class="pay-momo-icon">${svg('ok')}</div>`,
        isM ? 'Payment received. Welcome to GAZHP!' : 'Payment received. Thank you!',
        `<p>Your ${isM ? 'membership payment' : (s.amount ? esc(s.amount) + ' gift' : 'gift')}${s.op ? ` by ${esc(s.op)}` : ''} was approved.${s.email ? ` We'll email your ${isM ? 'membership confirmation' : 'receipt'} to <strong>${esc(s.email)}</strong>.` : ''}</p>
         ${mm.message && !/^payment received/i.test(mm.message) ? `<p class="pay-momo-msg">${esc(mm.message)}</p>` : ''}
         ${mm.reference ?`<p class="pay-momo-small pay-momo-ref">Reference: <code>${esc(mm.reference)}</code></p>` : ''}`,
        `<a class="btn btn-green" href="${esc(thanks)}">Continue</a>`);
    }
    if (mm.view === 'failed') {
      return card('bad', `<div class="pay-momo-icon">${svg('bad')}</div>`, 'Payment not completed',
        `<p class="pay-momo-msg">${esc(mm.message || 'The request was declined, cancelled or timed out on your phone, so no money was taken.')}</p>
         <p>You can send a new prompt, or choose another way to pay.</p>`,
        `<button type="button" class="btn btn-green" data-momo="retry">Try again</button>${another}`);
    }
    // timeout: no answer yet. The API (and its 15-minute check) still records a late approval.
    return card('late', `<div class="pay-momo-icon">${svg('wait')}</div>`, "We haven't received confirmation yet",
      `<p>If you approved the request${s.phone ? ` on ${esc(s.phone)}` : ''}, it can take a little longer to reach us. It will still be recorded, so you don't need to pay again.</p>
       <p>If no prompt arrived, or you declined it, you can send a new one.</p>`,
      `<button type="button" class="btn btn-green" data-momo="check">Check again</button><button type="button" class="btn btn-outline-dark" data-momo="retry">Send a new prompt</button>${another}`);
  }

  // A selector for the focused control, so focus can go back to its replacement after a re-render.
  function focusSelector() {
    const a = document.activeElement;
    if (!a || a === root || !root.contains(a)) return null;
    const scope = a.closest('#pay-form') ? '#pay-form ' : a.closest('#pay-panel') ? '#pay-panel ' : '';
    const d = a.dataset;
    const key = d.id ? `[data-id="${cssEsc(d.id)}"]`
      : d.amt ? `[data-amt="${cssEsc(d.amt)}"]`
      : d.gw ? `[data-gw="${cssEsc(d.gw)}"]`
      : d.momo ? `[data-momo="${cssEsc(d.momo)}"]`
      : d.copy ? `.pay-copy[data-copy="${cssEsc(d.copy)}"]`
      : a.name ? `[name="${cssEsc(a.name)}"]${a.type === 'radio' ? `[value="${cssEsc(a.value)}"]` : ''}`
      : null;
    return key ? scope + key : null;
  }

  // Re-render the widget, keeping keyboard / screen-reader focus on the equivalent control.
  // With `show`, also scroll that control into view (used when the layout changes a lot).
  function render(focusSel, show = false) {
    const sel = focusSel || focusSelector();
    paint();
    if (busy) lockPay();
    if (!sel) return;
    const el = root.querySelector(sel);
    if (el && !el.disabled) {
      el.focus({ preventScroll: true });
      if (show) reveal(el);
    }
  }
  const reveal = el => {
    const r = el.getBoundingClientRect();
    if (r.top < 90 || r.bottom > window.innerHeight - 20) el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  };

  // Homepage hand-off, e.g. /donate/?amount=50 (whole USD; anything else is ignored).
  let qAmount = '';
  if (purpose === 'donation') {
    const q = (new URLSearchParams(location.search).get('amount') || '').trim();
    if (/^\d{1,6}$/.test(q) && Number(q) > 0) qAmount = String(Number(q));
    st.amount = qAmount; // used by the automated form; checked against the API's min/max once /config loads
  }

  function paint() {
    // Waiting for (or showing the result of) a mobile money approval: just that card, so
    // nothing can be changed mid-payment. "Use another method" brings the form back.
    if (online() && mm.view !== 'form') { root.innerHTML = momoStatusHtml(); return; }

    const list = methods.map(fn => fn()).filter(Boolean);

    if (online()) {
      let html = onlineHtml();
      if (list.length) {
        const ways = list.map(m => ({ mobile: momoOn() ? 'sending mobile money to our number yourself' : 'direct mobile money', bank: 'bank transfer', check: 'a check by mail' }[m.id] || m.title));
        const offline = list.some(m => ['mobile', 'bank', 'zelle', 'cashapp', 'venmo', 'check'].includes(m.id));
        html += `<div class="pay-other"><h3 class="pay-step">Other ways to pay</h3>
          <p class="pay-other-sub">Prefer ${esc(joinOr(ways))}?${offline ? ` Send it, then tell us below — we'll confirm it and send your ${purpose === 'membership' ? 'membership confirmation' : 'receipt'}.` : ' Choose it below.'}</p>
          ${methodsHtml(list, false)}</div>`;
      }
      root.innerHTML = html + secureNote(list, false);
      return;
    }

    if (!list.length) {
      root.innerHTML = `<p class="pay-empty">Online payment is being set up. Please email <a href="mailto:${esc(CFG.org.email)}">${esc(CFG.org.email)}</a> and we'll help you ${purpose === 'membership' ? 'join' : 'give'}.</p>`;
      return;
    }
    const single = list.length === 1;
    // Donorbox asks for the tier inside its own form — don't ask twice when it's the only option.
    const donorboxOnly = single && list[0].id === 'donorbox';
    const tierPicker = purpose === 'membership' && tiers.length && !donorboxOnly ? tierPickerHtml('1. Choose your membership') : '';
    const headingMulti = purpose === 'membership' ? '<h3 class="pay-step">2. Choose how to pay</h3>' : '<h3 class="pay-step">Choose how to give</h3>';
    const heading = single ? (purpose === 'membership' && !donorboxOnly ? '<h3 class="pay-step">2. Pay securely</h3>' : '') : headingMulti;
    // Links / Donorbox mode can't prefill the amount, so tell the donor what they picked on the homepage.
    const chosen = qAmount ? `<p class="pay-amount" style="margin-bottom:16px;${donorboxOnly ? 'text-align:center;' : ''}">Your chosen gift: <strong>${money(Number(qAmount), 'USD')}</strong>. Enter this amount when you complete your payment.</p>` : '';
    // Same for /join/?tier=<id>: the tier picker is hidden in Donorbox-only mode, so name the tier they chose.
    // The Donorbox form's own options aren't known here, so point to email if the tier isn't in it.
    const qt = purpose === 'membership' && donorboxOnly && qTier ? tiers.find(t => t.id === qTier) : null;
    const qtPrice = qt ? (qt.currency === 'USD' ? 'US' : '') + money(qt.amount, qt.currency) : '';
    const tierNote = qt ? `<p class="pay-amount" style="margin-bottom:16px;text-align:center;">You chose: <strong>${esc(qt.name)} — ${esc(qt.region)} (${qtPrice} / year)</strong>. Please select the same membership in the form below. If it isn't listed, email <a href="mailto:${esc(CFG.org.email)}">${esc(CFG.org.email)}</a>.</p>` : '';
    root.innerHTML = cancelledNote() + chosen + tierNote + tierPicker + heading + methodsHtml(list, single) + secureNote(list, true);
    const active = list.find(m => m.id === activeId);
    if (active.onShow) active.onShow();
  }

  /* ---------- Events ---------- */
  async function post(path, body) {
    let res;
    try {
      res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error("We couldn't reach the payment service. Please check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { data });
    return data;
  }

  // Field-level error state: aria-invalid + aria-describedby pointing at the form's message
  // (ahead of the field's own hint, kept in data-hint, which comes back once it's fixed).
  const markInvalid = (field, msgId) => {
    field.setAttribute('aria-invalid', 'true');
    field.dataset.errId = msgId;
    field.setAttribute('aria-describedby', [msgId, field.dataset.hint].filter(Boolean).join(' '));
  };
  const unmark = field => {
    field.removeAttribute('aria-invalid');
    delete field.dataset.errId;
    if (field.dataset.hint) field.setAttribute('aria-describedby', field.dataset.hint); else field.removeAttribute('aria-describedby');
  };
  const clearInvalid = field => {
    if (!field || field.getAttribute('aria-invalid') !== 'true') return;
    const msg = document.getElementById(field.dataset.errId);
    unmark(field);
    if (msg && !(field.form && field.form.querySelector('[aria-invalid="true"]'))) msg.textContent = '';
  };
  // Preset amount buttons: keep the visual state and aria-pressed in step with st.amount.
  const syncPresets = () => root.querySelectorAll('.pay-amt').forEach(b => {
    const on = st.amount !== '' && Number(b.dataset.amt) === Number(st.amount);
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });

  // Clears earlier errors on the automated form and returns a `fail(field, text)` that shows one.
  function formErrors() {
    const form = document.getElementById('pay-form');
    const err = form.querySelector('.pay-form-err');
    err.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach(unmark);
    return (name, text) => {
      err.textContent = text;
      const f = form.elements[name];
      if (f && f.focus) { markInvalid(f, 'pay-err'); f.focus(); }
      return false;
    };
  }
  // Amount, name and email: needed by every gateway.
  const checkDetails = fail => {
    if (purpose !== 'membership' && !(Number(st.amount) > 0)) return fail('amount', 'Please choose or enter an amount.');
    if (!st.name.trim()) return fail('name', 'Please enter your name.');
    if (!EMAIL_RE.test(st.email.trim())) return fail('email', 'Please enter a valid email address.');
    return true;
  };
  // Disables the pay buttons while a request runs; the next render() rebuilds them enabled.
  const lockPay = () => document.querySelectorAll('#pay-form .pay-gw, #pay-form [data-momo]').forEach(b => { b.disabled = true; });

  async function startCheckout(gw, button) {
    if (busy) return;
    const fail = formErrors();
    if (!checkDetails(fail)) return;
    const isM = purpose === 'membership';
    const labelEl = button.querySelector('.pay-gw-title') || button;
    const focusSel = '#pay-form ' + (button.dataset.momo ? `[data-momo="${cssEsc(button.dataset.momo)}"]` : `[data-gw="${cssEsc(gw)}"]`);
    const label = labelEl.textContent;
    busy = true;
    lockPay();
    labelEl.textContent = 'Opening secure checkout…';
    try {
      const { url } = await post('/checkout', {
        gateway: gw, purpose, tier: isM && selectedTier ? selectedTier.id : '',
        amount: isM ? undefined : Number(st.amount),
        // Mobile money in Zambia is charged in kwacha.
        currency: isM ? (gw === 'dpo' && apiCfg.zmwPerUsd ? 'ZMW' : 'USD') : st.currency,
        recurring: isM ? (st.autoRenew ? 'year' : 'once') : st.freq,
        designation: isM ? undefined : (st.designation || undefined),
        // From the mobile money form's "pay on DPO's page instead", pass on the number typed there.
        name: st.name, email: st.email, phone: st.phone || (gw === 'dpo' && zmPhone(mm.phone).valid ? '0' + zmPhone(mm.phone).nsn : ''),
        country: st.country, profession: st.profession,
      });
      location.href = url; // stays busy while the browser leaves (pageshow resets it on Back)
    } catch (e) {
      busy = false;
      labelEl.textContent = label;
      // Rebuild (re-enables the buttons) and keep focus on the button the donor pressed.
      render(focusSel);
      document.querySelector('#pay-form .pay-form-err').textContent = e.message;
    }
  }

  /* ----- Direct mobile money: open / send / poll ----- */
  function openMomo() {
    mm.open = true; mm.stopped = false; mm.note = ''; mm.prev = null; mm.fallback = '';
    // Mobile money is charged in kwacha: switch a USD gift over (and back again if the panel is closed untouched).
    if (purpose === 'donation' && st.currency !== 'ZMW') {
      const rate = apiCfg.zmwPerUsd || 0, usd = Number(st.amount);
      mm.prev = { currency: st.currency, amount: st.amount };
      st.currency = 'ZMW';
      st.amount = rate && usd > 0 ? String(Math.ceil(usd * rate)) : '';
      mm.prev.converted = st.amount;
      mm.note = st.amount
        ? `Mobile money is paid in Zambian kwacha, so your ${money(usd, 'USD')} gift is now ${money(Number(st.amount), 'ZMW')} at our current exchange rate. You can change the amount above.`
        : 'Mobile money is paid in Zambian kwacha. Please choose or enter a kwacha amount above.';
    }
    if (!has(mm.phone) && zmPhone(st.phone).valid) mm.phone = st.phone;
    const ph = zmPhone(mm.phone);
    mm.detected = ph.operator;
    if (!mm.operator && ph.operator && momoOps().includes(ph.operator)) { mm.operator = ph.operator; mm.auto = true; }
    render('#pay-momo-title', true);
  }
  function closeMomo() {
    mm.open = false; mm.note = '';
    if (mm.prev && st.currency === 'ZMW' && st.amount === mm.prev.converted) { st.currency = mm.prev.currency; st.amount = mm.prev.amount; }
    mm.prev = null;
  }
  // Keeps the network cards in step with mm.operator without a re-render (focus stays in the phone field).
  const syncOps = () => root.querySelectorAll('input[name="momoOp"]').forEach(r => {
    r.checked = r.value === mm.operator;
    r.closest('.pay-op').classList.toggle('selected', r.checked);
  });
  const syncMomoSum = () => { const el = document.getElementById('pay-momo-sum'); if (el) el.innerHTML = momoSumHtml(); };
  // Live operator detection from the number's prefix. The donor can still pick another network
  // (e.g. a ported number); a pick is only overridden when the number changes to another network.
  function onMomoPhone(input) {
    mm.phone = input.value;
    const ph = zmPhone(mm.phone);
    const hint = document.getElementById('pay-momo-hint');
    if (hint) hint.textContent = momoHint(ph);
    if (ph.operator === mm.detected) return;
    mm.detected = ph.operator;
    if (ph.operator && momoOps().includes(ph.operator)) {
      if (mm.operator !== ph.operator) {
        mm.operator = ph.operator; mm.auto = true;
        syncOps();
        announce(`${opName(ph.operator)} selected`);
      }
    } else if (ph.operator && mm.auto && mm.operator) {
      // Now a number on a network we can't prompt: drop the network picked for the previous
      // number, so the prompt can't go to that network by mistake. The hint explains why.
      mm.operator = ''; mm.auto = false;
      syncOps();
    }
  }
  // Shows the waiting / result card, moves focus to its heading and says what happened.
  function showMomo(view, message) {
    mm.view = view;
    if (message !== undefined) mm.message = has(message) ? String(message) : '';
    if (view !== 'processing') stopPolling();
    if (view === 'success' || view === 'failed') forgetMomo();
    render('#pay-momo-head', true);
    const s = mm.snap || {};
    announce({
      processing: mm.resumed ? 'Checking your mobile money payment.' : `Payment request sent${s.phone ? ' to ' + s.phone : ''}. ${mm.message || 'Check your phone and enter your PIN to approve.'}`,
      success: 'Your payment was approved.',
      failed: mm.message || 'The payment was not completed.',
      timeout: 'If you approved the request it will still be recorded. You can check again, send a new prompt or use another method.',
    }[view] || '');
  }

  async function startMomo(button) {
    if (busy) return;
    const fail = formErrors();
    if (!checkDetails(fail)) return;
    const ph = zmPhone(mm.phone);
    if (!ph.valid) return fail('momoPhone', 'Please enter your Zambian mobile money number, e.g. 097 123 4567.');
    if (!momoOps().includes(mm.operator)) {
      if (ph.operator && !momoOps().includes(ph.operator)) return fail('momoPhone', momoHint(ph));
      document.getElementById('pay-err').textContent = 'Please choose your mobile money network.';
      const r = root.querySelector('input[name="momoOp"]:not(:disabled)');
      if (r) r.focus();
      return;
    }
    const isM = purpose === 'membership';
    // Per-network limits from /config (the API enforces them too); bigger gifts go by card or bank.
    const lim = !isM && apiCfg.momoLimits && apiCfg.momoLimits[mm.operator];
    if (lim && Number(st.amount) > Number(lim.max)) {
      return fail('amount', `${opName(mm.operator)} payments are limited to ${money(Number(lim.max), 'ZMW')} each. For a larger gift, please pay by card or bank transfer.`);
    }
    mm.fallback = '';
    // What the donor is approving, captured now: the form can still change while the request runs.
    const snap = { amount: momoAmountText(), phone: fmtZm(ph.nsn), op: opName(mm.operator), email: st.email.trim() };
    busy = true;
    lockPay();
    button.textContent = 'Sending prompt…';
    try {
      const data = await post('/momo/start', {
        purpose, tier: isM && selectedTier ? selectedTier.id : '',
        amount: isM ? undefined : Number(st.amount),
        currency: 'ZMW', recurring: 'once',
        designation: isM ? undefined : (st.designation || undefined),
        name: st.name, email: st.email, phone: '0' + ph.nsn, country: st.country, profession: st.profession,
        operator: mm.operator,
      });
      if (!data.reference && httpsUrl(data.url)) { location.href = data.url; return; }
      if (!has(String(data.reference || ''))) throw new Error('Something went wrong. Please try again.');
      busy = false;
      mm.reference = String(data.reference);
      mm.instructions = has(data.instructions) ? data.instructions : '';
      mm.snap = snap;
      mm.resumed = false;
      if (data.status === 'paid') { showMomo('success', data.message); return; }
      saveMomo();
      const first = Number(data.pollAfterMs);
      startPolling(MOMO_WAIT, first >= 2000 && first <= 15000 ? first : MOMO_POLL);
      showMomo('processing', data.message);
    } catch (e) {
      busy = false;
      // The API couldn't send a prompt but opened DPO Pay's page for the same payment: offer it.
      const d = e.data || {};
      if (d.fallback && httpsUrl(d.url)) mm.fallback = d.url;
      render(mm.fallback ? '#pay-momo-fallback' : '#pay-form [data-momo="send"]');
      document.getElementById('pay-err').textContent = e.message;
    }
  }

  // GET /momo/status → {status, message}; null when it couldn't be reached (polling just carries on).
  async function momoStatus(ref) {
    try {
      const signal = (window.AbortSignal && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined;
      const res = await fetch(`${API}/momo/status?reference=${encodeURIComponent(ref)}`, { cache: 'no-store', signal });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) return { status: 'pending', wait: 15000 };
      if (res.status === 400 || res.status === 404) return { status: 'failed', message: data.error || "We couldn't find this payment request." };
      return res.ok ? data : null;
    } catch { return null; }
  }
  let pollTimer = 0, tickTimer = 0, pollRun = 0;
  function stopPolling() { clearTimeout(pollTimer); clearInterval(tickTimer); pollRun++; }
  function startPolling(windowMs, firstDelay) {
    stopPolling();
    const run = pollRun;
    mm.window = windowMs;
    mm.deadline = Date.now() + windowMs;
    // Countdown + progress bar, updated in place (not announced: the live region only gets real changes).
    tickTimer = setInterval(() => {
      const left = momoLeft(), t = document.getElementById('pay-momo-timer'), bar = document.getElementById('pay-momo-bar');
      if (t) t.textContent = left.text;
      if (bar) bar.style.width = left.done + '%';
    }, 1000);
    const check = async () => {
      if (run !== pollRun) return;
      const r = await momoStatus(mm.reference);
      if (run !== pollRun) return;
      if (r && r.status === 'paid') return showMomo('success', r.message);
      if (r && r.status === 'failed') return showMomo('failed', r.message);
      if (Date.now() >= mm.deadline) return showMomo('timeout', '');
      // One last look right after the deadline, so a just-in-time approval isn't missed.
      pollTimer = setTimeout(check, Math.min((r && r.wait) || MOMO_POLL, Math.max(1000, mm.deadline - Date.now() + 500)));
    };
    pollTimer = setTimeout(check, firstDelay);
  }

  function momoAction(what, button) {
    if (what === 'send') return startMomo(button);
    if (what === 'hosted') return startCheckout('dpo', button);
    if (what === 'check') {
      mm.resumed = true;
      startPolling(30000, 0);
      return showMomo('processing', '');
    }
    if (what === 'retry') {
      stopPolling(); forgetMomo();
      Object.assign(mm, { view: 'form', open: true, resumed: false, stopped: false, note: '', fallback: '', instructions: '' });
      return render('#pay-form [data-momo="send"]', true);
    }
    if (what === 'stop') {
      const waiting = mm.view === 'processing' || mm.view === 'timeout';
      stopPolling(); forgetMomo();
      Object.assign(mm, { view: 'form', resumed: false });
      closeMomo();
      mm.stopped = waiting;
      render('#pay-form .pay-gw:not([disabled])', true);
    }
  }

  root.addEventListener('click', e => {
    const tab = e.target.closest('.pay-method');
    if (tab) {
      activeId = tab.dataset.id; render(`[data-id="${cssEsc(activeId)}"]`);
      if (window.innerWidth < 700) document.getElementById('pay-panel').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return;
    }
    const amt = e.target.closest('.pay-amt');
    if (amt) {
      // Update in place — no re-render, so focus stays on the pressed button.
      st.amount = amt.dataset.amt;
      const input = document.querySelector('#pay-form input[name="amount"]');
      if (input) { input.value = st.amount; clearInvalid(input); }
      syncPresets();
      amountChanged();
      return;
    }
    const act = e.target.closest('[data-momo]');
    if (act && !act.disabled) { momoAction(act.dataset.momo, act); return; }
    const gw = e.target.closest('.pay-gw');
    if (gw && !gw.disabled) {
      if (gw.dataset.gw !== 'momo') { startCheckout(gw.dataset.gw, gw); return; }
      if (!mm.open) { openMomo(); return; }
      closeMomo(); render('#pay-form [data-gw="momo"]');
      return;
    }
    const copy = e.target.closest('.pay-copy');
    if (copy) {
      const what = copy.dataset.label || 'Detail';
      const done = () => {
        copy.textContent = 'Copied'; announce(`${what} copied`);
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      };
      // No clipboard access: select the value so it can be copied by hand, and say so visibly and to screen readers.
      const failed = () => {
        const val = copy.closest('.pay-detail') && copy.closest('.pay-detail').querySelector('.pay-detail-value');
        let ok = false;
        if (val && window.getSelection) {
          const range = document.createRange(); range.selectNodeContents(val);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          try { ok = document.execCommand('copy'); } catch { ok = false; }
        }
        if (ok) { done(); return; }
        copy.textContent = 'Selected'; announce(`${what}: couldn't copy automatically. The text is selected, so you can copy it yourself.`);
        setTimeout(() => { copy.textContent = 'Copy'; }, 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copy.dataset.copy).then(done, failed); else failed();
    }
  });

  // The donor changed the gift amount: refresh the mobile money summary; the
  // "we switched you to kwacha" note no longer applies.
  function amountChanged() {
    syncMomoSum();
    if (!mm.note) return;
    mm.note = '';
    const n = document.getElementById('pay-momo-note');
    if (n) n.remove();
  }

  root.addEventListener('input', e => {
    const f = e.target;
    clearInvalid(f);
    if (!f.closest('#pay-form')) return;
    if (['name', 'email', 'phone', 'country', 'profession'].includes(f.name)) st[f.name] = f.value;
    if (f.name === 'amount') { st.amount = f.value; syncPresets(); amountChanged(); }
    if (f.name === 'momoPhone') onMomoPhone(f);
  });

  root.addEventListener('change', e => {
    const f = e.target;
    if (f.name === 'pay-tier') { selectedTier = tiers.find(t => t.id === f.value) || selectedTier; render(); return; }
    // Mobile money is one-time only, so switching to a recurring payment closes its form.
    if (f.name === 'freq') { st.freq = f.value; if (st.freq !== 'once' && mm.open) closeMomo(); render(); return; }
    if (f.name === 'currency' && f.closest('#pay-form')) {
      st.currency = f.value; st.amount = '';
      mm.prev = null; mm.note = '';
      if (st.currency !== 'ZMW') mm.open = false; // mobile money is kwacha only
      render(); return;
    }
    if (f.name === 'autoRenew') { st.autoRenew = f.checked; if (st.autoRenew && mm.open) closeMomo(); render(); return; }
    if (f.name === 'designation' && f.closest('#pay-form')) { st.designation = f.value; syncMomoSum(); return; }
    if (f.name === 'momoOp') {
      mm.operator = f.value; mm.auto = false;
      syncOps();
      const err = document.getElementById('pay-err');
      if (err && !root.querySelector('#pay-form [aria-invalid="true"]')) err.textContent = '';
    }
  });

  root.addEventListener('submit', async e => {
    const form = e.target.closest('.pay-notify-form');
    if (!form) return;
    e.preventDefault();
    const msg = form.querySelector('.pay-form-msg');
    const v = n => (form.elements[n] ? form.elements[n].value.trim() : '');
    form.querySelectorAll('[aria-invalid]').forEach(unmark);
    const bad = [!v('name') && 'name', !EMAIL_RE.test(v('email')) && 'email', !(Number(v('amount')) > 0) && 'amount'].filter(Boolean);
    if (bad.length) {
      bad.forEach(n => markInvalid(form.elements[n], msg.id));
      msg.textContent = 'Please fill in your name, email and the amount you sent.';
      form.elements[bad[0]].focus();
      return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; msg.textContent = 'Sending…';
    try {
      await post('/notify', {
        method: v('network') || form.dataset.method, purpose, tier: purpose === 'membership' && selectedTier ? selectedTier.id : '',
        name: v('name'), email: v('email'), phone: v('phone'), amount: Number(v('amount')), currency: v('currency'),
        date: v('date'), ref: refCode, country: st.country, website: v('website'),
        designation: purpose === 'donation' ? (v('designation') || undefined) : undefined,
      });
      // The submit button and live region are replaced, so move focus to the confirmation (read out by screen readers).
      form.innerHTML = `<p class="pay-done" tabindex="-1"><strong>Thank you!</strong> We've received your notice (reference <code>${esc(refCode)}</code>). We'll confirm by email once the payment arrives.</p>`;
      form.querySelector('.pay-done').focus();
    } catch (err) {
      msg.textContent = err.message; btn.disabled = false;
    }
  });

  // Preselect tier from URL, e.g. /join/?tier=student-developing
  const qTier = new URLSearchParams(location.search).get('tier');
  const pickTier = () => { if (qTier) selectedTier = tiers.find(t => t.id === qTier) || selectedTier; };
  pickTier();

  // Back button from Stripe / PayPal / DPO restores this page from the back-forward cache with the
  // pay buttons still disabled ("Opening secure checkout…"). Rebuild them from the saved form state.
  window.addEventListener('pageshow', e => { if (!e.persisted) return; busy = false; if (online()) render(); });

  if (!API) { render(); return; }
  root.innerHTML = '<p class="pay-loading">Loading payment options…</p>';
  (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 7000);
      const res = await fetch(API + '/config', { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) apiCfg = await res.json();
    } catch { apiCfg = null; } // API down → fall back to link-based options
    if (online() && Array.isArray(apiCfg.tiers) && apiCfg.tiers.length) {
      tiers = apiCfg.tiers;
      selectedTier = tiers.find(t => selectedTier && t.id === selectedTier.id) || tiers[0];
      pickTier();
    }
    // Drop a ?amount= that is outside the server's donation limits (USD) rather than guess.
    if (online() && qAmount && st.amount === qAmount) {
      const d = apiCfg.donation || {}, n = Number(qAmount);
      const min = (d.min && d.min.USD) || 1, max = (d.max && d.max.USD) || Infinity;
      if (n < min || n > max) st.amount = '';
    }
    // Default designation: ?designation=<id> when it's a real one, else the first ("where it's needed most").
    const ds = designations();
    if (ds.length) {
      const q = new URLSearchParams(location.search).get('designation');
      st.designation = (ds.find(d => d.id === q) || ds[0]).id;
    }
    // A mobile money request started in this tab moments ago (e.g. before a reload): keep checking it.
    const saved = momoOn() ? loadMomo() : null;
    if (saved) {
      Object.assign(mm, { reference: saved.ref, snap: saved.snap || {}, resumed: true, view: 'processing' });
      startPolling(60000, 0);
    }
    render();
  })();
})();
