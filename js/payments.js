/* =============================================
   GAZHP — Payment options (/donate/ and /join/)
   Renders every gateway that is enabled AND filled in inside
   js/payments-config.js. Mount point:
     <div id="payment-options" data-purpose="donation|membership"></div>
   ============================================= */
(function () {
  const root = document.getElementById('payment-options');
  const CFG = window.GAZHP_CONFIG;
  if (!root || !CFG) return;

  const purpose = root.dataset.purpose === 'membership' ? 'membership' : 'donation';
  const G = CFG.gateways || {};
  const tiers = CFG.membershipTiers || [];
  const has = v => typeof v === 'string' && v.trim() !== '';
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
    function flutterwave() {
      const g = G.flutterwave || {};
      if (!g.enabled) return null;
      const url = purpose === 'membership' ? tierLink(g) : g.donationLink;
      if (!has(url)) return null;
      return { id: 'flutterwave', title: 'Zambia & Africa: Card or Mobile Money', sub: 'Flutterwave · MTN MoMo, Airtel Money, Zamtel, local cards — ZMW or USD', body: amountHint() + linkBtn(url, 'Pay with Flutterwave') };
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
      return { id: 'bank', title: 'Bank Transfer', sub: [usOk && 'US account', zmOk && 'Zambian account'].filter(Boolean).join(' · '), body: amountHint(zmOk) + `<div class="pay-subgrid">${usBlock}${zmBlock}</div>` + referenceRow() + notifyBlock('bank transfer') };
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
      return { id: 'check', title: 'Check by Mail', sub: 'US checks', body: amountHint() + row('Payable to', g.payableTo) + row('Mail to', CFG.org.mailingAddress) + row('Memo line', refCode) + notifyBlock('check') };
    },
    ...((G.custom || []).map((c, i) => function custom() {
      if (!c || !c.enabled || !has(c.url) || !has(c.name)) return null;
      if (c.purpose && c.purpose !== 'both' && c.purpose !== purpose) return null;
      return { id: 'custom-' + i, title: c.name, sub: c.description || '', body: amountHint() + linkBtn(c.url, 'Continue to ' + c.name) };
    })),
  ];

  /* ---------- Render ---------- */
  let activeId = null;

  function render() {
    const list = methods.map(fn => fn()).filter(Boolean);
    if (!list.length) {
      root.innerHTML = `<p class="pay-empty">Online payment is being set up. Please email <a href="mailto:${esc(CFG.org.email)}">${esc(CFG.org.email)}</a> and we'll help you ${purpose === 'membership' ? 'join' : 'give'}.</p>`;
      return;
    }
    if (!list.some(m => m.id === activeId)) activeId = list[0].id;

    const single = list.length === 1;
    // Donorbox asks for the tier inside its own form — don't ask twice when it's the only option.
    const donorboxOnly = single && list[0].id === 'donorbox';
    const tierPicker = purpose === 'membership' && tiers.length && !donorboxOnly ? `
      <fieldset class="pay-tiers">
        <legend>1. Choose your membership</legend>
        <div class="pay-tier-grid">
          ${tiers.map(t => `<label class="pay-tier${selectedTier && t.id === selectedTier.id ? ' selected' : ''}">
            <input type="radio" name="pay-tier" value="${esc(t.id)}"${selectedTier && t.id === selectedTier.id ? ' checked' : ''} />
            <span class="pay-tier-name">${esc(t.name)}</span>
            <span class="pay-tier-region">${esc(t.region)}</span>
            <span class="pay-tier-amount">${money(t.amount, t.currency)}<small>/ year</small></span>
          </label>`).join('')}
        </div>
      </fieldset>` : '';

    const headingMulti = purpose === 'membership' ? '<h3 class="pay-step">2. Choose how to pay</h3>' : '<h3 class="pay-step">Choose how to give</h3>';

    const heading = single ? (purpose === 'membership' && !donorboxOnly ? '<h3 class="pay-step">2. Pay securely</h3>' : '') : headingMulti;
    root.innerHTML = tierPicker + heading + `<div class="pay-methods" role="tablist" aria-label="Payment methods"${single ? ' hidden' : ''}>
        ${list.map(m => `<button type="button" role="tab" class="pay-method${m.id === activeId ? ' active' : ''}" aria-selected="${m.id === activeId}" aria-controls="pay-panel" data-id="${esc(m.id)}">
          <span class="pay-method-title">${esc(m.title)}</span><span class="pay-method-sub">${esc(m.sub)}</span></button>`).join('')}
      </div>
      <div class="pay-panel${single ? ' pay-panel-single' : ''}" id="pay-panel" role="tabpanel">${list.find(m => m.id === activeId).body}</div>
      <p class="pay-secure"><svg class="icon" style="width:13px;height:13px;"><use href="#i-lock"/></svg>Card payments are processed on the provider's secure page — GAZHP never sees your card details.${has(CFG.org.ein) ? ` EIN ${esc(CFG.org.ein)}.` : ''}</p>`;

    const active = list.find(m => m.id === activeId);
    if (active.onShow) active.onShow();
  }

  root.addEventListener('click', e => {
    const tab = e.target.closest('.pay-method');
    if (tab) {
      activeId = tab.dataset.id; render();
      if (window.innerWidth < 700) document.getElementById('pay-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const copy = e.target.closest('.pay-copy');
    if (copy) {
      const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy).then(done, done); else done();
    }
  });
  root.addEventListener('change', e => {
    if (e.target.name === 'pay-tier') {
      selectedTier = tiers.find(t => t.id === e.target.value) || selectedTier;
      render();
    }
  });

  // Preselect tier from URL, e.g. /join/?tier=student-developing
  const qTier = new URLSearchParams(location.search).get('tier');
  if (qTier) selectedTier = tiers.find(t => t.id === qTier) || selectedTier;

  render();
})();
