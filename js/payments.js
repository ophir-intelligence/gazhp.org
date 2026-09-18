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
  const st = { amount: '', currency: 'USD', freq: 'once', autoRenew: false, name: '', email: '', phone: '', country: '', profession: '' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  /* ---------- Row helpers ---------- */
  const row = (label, value) => has(value)
    ? `<div class="pay-detail"><span class="pay-detail-label">${esc(label)}</span><span class="pay-detail-value">${esc(value)}</span><button type="button" class="pay-copy" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}">Copy</button></div>`
    : '';
  const referenceRow = () => row('Reference / note', refCode);
  const linkBtn = (url, label, cls = 'btn-teal') =>
    `<a class="btn ${cls} pay-link-btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} <span aria-hidden="true">↗</span></a>`;
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
        <label>Date sent<input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
        <label>Phone<input name="phone" autocomplete="tel" value="${esc(st.phone)}" /></label>
      </div>
      <input type="text" name="website" class="pay-hp" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <button type="submit" class="btn btn-green pay-link-btn">I've paid — notify GAZHP</button>
      <p class="pay-form-msg" role="status"></p>
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
        id: 'donorbox', title: 'Card, Apple Pay, Google Pay, PayPal', sub: 'Secure checkout by Donorbox · US & international cards',
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
        return { id: 'stripe', title: 'Card via Stripe', sub: 'Visa, Mastercard, Amex, Apple Pay, Google Pay', body: amountHint() + linkBtn(url, 'Pay membership with Stripe') };
      }
      if (!has(g.donationLink) && !has(g.monthlyDonationLink)) return null;
      return {
        id: 'stripe', title: 'Card via Stripe', sub: 'Visa, Mastercard, Amex, Apple Pay, Google Pay',
        body: `<div class="pay-btn-row">${has(g.donationLink) ? linkBtn(g.donationLink, 'Give once') : ''}${has(g.monthlyDonationLink) ? linkBtn(g.monthlyDonationLink, 'Give monthly', 'btn-green') : ''}</div>`,
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
      return { id: 'dpo', title: 'Zambia: Mobile Money or Card', sub: 'DPO Pay · MTN, Airtel, Zamtel, Visa/Mastercard — ZMW or USD', body: amountHint(true) + linkBtn(url, 'Pay with DPO Pay') };
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
      return { id: 'zelle', title: 'Zelle', sub: 'From most US bank apps, no fees', body: amountHint() + row('Send to', g.emailOrPhone) + row('Recipient name', g.recipientName) + referenceRow() + notifyBlock('Zelle') };
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

  // Tabs + panel for a list of methods.
  function methodsHtml(list, single) {
    if (!list.some(m => m.id === activeId)) activeId = list[0].id;
    return `<div class="pay-methods" role="tablist" aria-label="Payment methods"${single ? ' hidden' : ''}>
        ${list.map(m => `<button type="button" role="tab" class="pay-method${m.id === activeId ? ' active' : ''}" aria-selected="${m.id === activeId}" aria-controls="pay-panel" data-id="${esc(m.id)}">
          <span class="pay-method-title">${esc(m.title)}</span><span class="pay-method-sub">${esc(m.sub)}</span></button>`).join('')}
      </div>
      <div class="pay-panel${single ? ' pay-panel-single' : ''}" id="pay-panel" role="tabpanel">${list.find(m => m.id === activeId).body}</div>`;
  }
  const secureNote = () => `<p class="pay-secure"><svg class="icon" style="width:13px;height:13px;"><use href="#i-lock"/></svg>Card and mobile-money payments are completed on Stripe, PayPal or DPO Pay's secure pages — GAZHP never sees your card details.${has(CFG.org.ein) ? ` EIN ${esc(CFG.org.ein)}.` : ''}</p>`;
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
        <div class="pay-amounts">${presets.map(a => `<button type="button" class="pay-amt${Number(st.amount) === a ? ' selected' : ''}" data-amt="${a}">${money(a, st.currency)}</button>`).join('')}</div>
        <div class="pay-grid">
          <label>Amount (${esc(st.currency)})<input type="number" name="amount" min="${(d.min && d.min[st.currency]) || 1}" step="1" inputmode="decimal" placeholder="Other amount" value="${esc(st.amount)}" /></label>
          ${g.dpo ? `<label>Currency<select name="currency"><option value="USD"${!zmw ? ' selected' : ''}>US dollars (USD)</option><option value="ZMW"${zmw ? ' selected' : ''}>Zambian kwacha (ZMW)</option></select></label>` : ''}
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
    html += `<fieldset class="pay-fs"><legend>3. Pay</legend>
      ${isM && g.stripe ? `<label class="pay-check"><input type="checkbox" name="autoRenew"${st.autoRenew ? ' checked' : ''} />Renew my membership automatically every year (card only)</label>` : ''}
      <div class="pay-gws">
        ${g.stripe ? btn('stripe', 'Card, Apple Pay or Google Pay', 'Visa · Mastercard · Amex · US bank account', zmw, 'Choose USD to pay by card') : ''}
        ${g.paypal ? btn('paypal', 'PayPal', 'PayPal balance or card', zmw || recurring, zmw ? 'Choose USD to use PayPal' : 'Recurring payments use card') : ''}
        ${g.dpo ? btn('dpo', 'Mobile Money (Zambia)', 'MTN · Airtel · Zamtel · Zambian cards — via DPO Pay' + momoAmt, recurring, 'Recurring payments use card') : ''}
      </div>
      <p class="pay-form-err" role="alert"></p>
    </fieldset></form>`;
    return html;
  }

  function render() {
    const list = methods.map(fn => fn()).filter(Boolean);

    if (online()) {
      let html = onlineHtml();
      if (list.length) {
        html += `<div class="pay-other"><h3 class="pay-step">Other ways to pay</h3>
          <p class="pay-other-sub">Prefer a bank transfer${G.zelle && G.zelle.enabled ? ', Zelle' : ''} or direct mobile money? Send it, then tell us below — we'll confirm it and send your ${purpose === 'membership' ? 'membership confirmation' : 'receipt'}.</p>
          ${methodsHtml(list, false)}</div>`;
      }
      root.innerHTML = html + secureNote();
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
    root.innerHTML = cancelledNote() + tierPicker + heading + methodsHtml(list, single) + secureNote();
    const active = list.find(m => m.id === activeId);
    if (active.onShow) active.onShow();
  }

  /* ---------- Events ---------- */
  async function post(path, body) {
    const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  async function startCheckout(gw, button) {
    const form = document.getElementById('pay-form');
    const err = form.querySelector('.pay-form-err');
    err.textContent = '';
    const isM = purpose === 'membership';
    if (!isM && !(Number(st.amount) > 0)) { err.textContent = 'Please choose or enter an amount.'; form.elements.amount.focus(); return; }
    if (!st.name.trim()) { err.textContent = 'Please enter your name.'; form.elements.name.focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.email.trim())) { err.textContent = 'Please enter a valid email address.'; form.elements.email.focus(); return; }
    const label = button.querySelector('.pay-gw-title').textContent;
    form.querySelectorAll('.pay-gw').forEach(b => { b.disabled = true; });
    button.querySelector('.pay-gw-title').textContent = 'Opening secure checkout…';
    try {
      const { url } = await post('/checkout', {
        gateway: gw, purpose, tier: isM && selectedTier ? selectedTier.id : '',
        amount: isM ? undefined : Number(st.amount),
        // Mobile money in Zambia is charged in kwacha.
        currency: isM ? (gw === 'dpo' && apiCfg.zmwPerUsd ? 'ZMW' : 'USD') : st.currency,
        recurring: isM ? (st.autoRenew ? 'year' : 'once') : st.freq,
        name: st.name, email: st.email, phone: st.phone, country: st.country, profession: st.profession,
      });
      location.href = url;
    } catch (e) {
      err.textContent = e.message;
      button.querySelector('.pay-gw-title').textContent = label;
      render();
      document.querySelector('#pay-form .pay-form-err').textContent = e.message;
    }
  }

  root.addEventListener('click', e => {
    const tab = e.target.closest('.pay-method');
    if (tab) {
      activeId = tab.dataset.id; render();
      if (window.innerWidth < 700) document.getElementById('pay-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const amt = e.target.closest('.pay-amt');
    if (amt) { st.amount = amt.dataset.amt; render(); return; }
    const gw = e.target.closest('.pay-gw');
    if (gw && !gw.disabled) { startCheckout(gw.dataset.gw, gw); return; }
    const copy = e.target.closest('.pay-copy');
    if (copy) {
      const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy).then(done, done); else done();
    }
  });

  root.addEventListener('input', e => {
    const f = e.target;
    if (!f.closest('#pay-form')) return;
    if (['name', 'email', 'phone', 'country', 'profession'].includes(f.name)) st[f.name] = f.value;
    if (f.name === 'amount') {
      st.amount = f.value;
      root.querySelectorAll('.pay-amt').forEach(b => b.classList.toggle('selected', Number(b.dataset.amt) === Number(f.value)));
    }
  });

  root.addEventListener('change', e => {
    const f = e.target;
    if (f.name === 'pay-tier') { selectedTier = tiers.find(t => t.id === f.value) || selectedTier; render(); return; }
    if (f.name === 'freq') { st.freq = f.value; render(); return; }
    if (f.name === 'currency' && f.closest('#pay-form')) { st.currency = f.value; st.amount = ''; render(); return; }
    if (f.name === 'autoRenew') { st.autoRenew = f.checked; render(); }
  });

  root.addEventListener('submit', async e => {
    const form = e.target.closest('.pay-notify-form');
    if (!form) return;
    e.preventDefault();
    const msg = form.querySelector('.pay-form-msg');
    const v = n => (form.elements[n] ? form.elements[n].value.trim() : '');
    if (!v('name') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email')) || !(Number(v('amount')) > 0)) {
      msg.textContent = 'Please fill in your name, email and the amount you sent.'; return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; msg.textContent = 'Sending…';
    try {
      await post('/notify', {
        method: v('network') || form.dataset.method, purpose, tier: purpose === 'membership' && selectedTier ? selectedTier.id : '',
        name: v('name'), email: v('email'), phone: v('phone'), amount: Number(v('amount')), currency: v('currency'),
        date: v('date'), ref: refCode, country: st.country, website: v('website'),
      });
      form.innerHTML = `<p class="pay-done"><strong>Thank you!</strong> We've received your notice (reference <code>${esc(refCode)}</code>). We'll confirm by email once the payment arrives.</p>`;
    } catch (err) {
      msg.textContent = err.message; btn.disabled = false;
    }
  });

  // Preselect tier from URL, e.g. /join/?tier=student-developing
  const qTier = new URLSearchParams(location.search).get('tier');
  const pickTier = () => { if (qTier) selectedTier = tiers.find(t => t.id === qTier) || selectedTier; };
  pickTier();

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
    render();
  })();
})();
