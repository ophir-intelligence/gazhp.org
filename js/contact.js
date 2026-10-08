/* =============================================
   GAZHP — Contact form (/contact/)
   • API mode (js/payments-config.js → api.baseUrl is set):
       POST {api}/contact  {name, email, subject, message, website}
       "Sent" is shown only after the server answers {ok:true}.
   • No API yet (api.baseUrl is ''): nothing is sent from the page.
       The visitor's email app opens with the message already written
       to info@gazhphealth.org, and the page says so plainly.
   Results stay visible in the #contact-status live region (role="status").
   ============================================= */
(function () {
  'use strict';

  const form = document.getElementById('contact-form');
  if (!form) return;

  const TO = 'info@gazhphealth.org';
  const CFG = window.GAZHP_CONFIG || {};
  const API = typeof (CFG.api || {}).baseUrl === 'string' && CFG.api.baseUrl.trim()
    ? CFG.api.baseUrl.trim().replace(/\/+$/, '') : '';
  const MAILTO_MAX = 1500; // some email apps cut off long mailto: links

  const status = document.getElementById('contact-status');
  const button = form.querySelector('[type="submit"]');
  const buttonLabel = form.querySelector('.contact-submit-label');
  const field = name => form.elements.namedItem(name);
  const val = name => { const el = field(name); return el ? String(el.value || '').trim() : ''; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // We show our own inline messages; without JavaScript the browser's built-in checks still apply.
  form.noValidate = true;

  /* ---------- Mode: tell people up front what the button does ---------- */
  if (!API) {
    if (buttonLabel) buttonLabel.textContent = 'Write it in my email app';
    const note = document.createElement('p');
    note.className = 'callout';
    note.id = 'contact-mode-note';
    note.style.marginBottom = '18px';
    note.innerHTML = `Online sending isn't switched on yet. When you press the button below, your email app opens with your message already written and addressed to <strong>${esc(TO)}</strong> — then press <strong>Send</strong> in your email app.`;
    button.parentNode.insertBefore(note, button);
    button.setAttribute('aria-describedby', note.id);
  }

  /* ---------- Inline field errors ---------- */
  const RULES = [
    ['fname', v => v ? '' : 'Please enter your first name.'],
    ['lname', v => v ? '' : 'Please enter your last name.'],
    ['email', (v, el) => !v ? 'Please enter your email address so we can reply.'
      : (el.validity && el.validity.typeMismatch) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'Please enter a valid email address, like name@example.com.' : ''],
    ['subject', v => v ? '' : 'Please choose what your message is about.'],
    ['message', v => v ? '' : 'Please write your message.'],
  ];
  function errorEl(el) {
    const id = el.id + '-error';
    let p = document.getElementById(id);
    if (!p) {
      p = document.createElement('p');
      p.id = id;
      p.className = 'field-error';
      p.style.cssText = 'color:var(--red-cta);font-size:.8rem;font-weight:600;margin-top:5px;';
      p.hidden = true;
      el.insertAdjacentElement('afterend', p);
      const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!ids.includes(id)) el.setAttribute('aria-describedby', ids.concat(id).join(' '));
    }
    return p;
  }
  function setError(el, msg) {
    const p = errorEl(el);
    p.textContent = msg;
    p.hidden = !msg;
    if (msg) { el.setAttribute('aria-invalid', 'true'); el.style.borderColor = 'var(--red-cta)'; }
    else { el.removeAttribute('aria-invalid'); el.style.borderColor = ''; }
  }
  function check(name) {
    const el = field(name);
    const rule = RULES.find(r => r[0] === name);
    if (!el || !rule) return '';
    const msg = rule[1](String(el.value || '').trim(), el);
    setError(el, msg);
    return msg;
  }
  let tried = false;
  // Once every field is fixed, drop the "Please fix the fields" summary so it doesn't linger.
  const recheck = name => {
    check(name);
    if (statusKind === 'invalid' && !form.querySelector('[aria-invalid="true"]')) say('', '');
  };
  RULES.forEach(([name]) => {
    const el = field(name);
    if (!el) return;
    // After the first attempt, re-check as people fix things so errors clear right away.
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { if (tried && el.getAttribute('aria-invalid')) recheck(name); });
    el.addEventListener('blur', () => { if (tried) recheck(name); });
  });

  /* ---------- Status region ---------- */
  // Clear first, then write a moment later, so screen readers announce repeats too.
  let sayTimer = 0;
  let statusKind = '';
  function say(kind, html, reveal = true) {
    status.innerHTML = '';
    statusKind = kind;
    clearTimeout(sayTimer);
    if (!html) return;
    sayTimer = setTimeout(() => {
      const box = document.createElement('div');
      box.className = 'callout prose-links'; // underline the links inside (Try again, email address)
      box.style.margin = '0'; // #contact-status already sits 16px below the button
      if (kind === 'error' || kind === 'invalid') box.style.borderLeftColor = 'var(--red-cta)';
      box.innerHTML = html;
      status.replaceChildren(box);
      if (reveal && status.getBoundingClientRect().bottom > innerHeight) {
        const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
        status.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
      }
    }, 60);
  }

  /* ---------- Email fallback ---------- */
  function details() {
    return {
      fname: val('fname'), lname: val('lname'), email: val('email'),
      profession: val('profession'), subject: val('subject'), message: val('message'),
      website: val('website'),
    };
  }
  function mailtoFor(d) {
    const long = d.message.length > MAILTO_MAX;
    const lines = [
      long ? d.message.slice(0, MAILTO_MAX) + '…\n[Message shortened — please paste the rest here before sending.]' : d.message,
      '', '—',
      `Name: ${d.fname} ${d.lname}`.trim(),
      `Email: ${d.email}`,
    ];
    if (d.profession) lines.push(`Profession / role: ${d.profession}`);
    lines.push('Sent from the contact form at gazhphealth.org/contact/');
    const subject = `[Website] ${d.subject} — ${d.fname} ${d.lname}`.trim();
    return { href: `mailto:${TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`, long };
  }
  function plainText(d) {
    const lines = [`To: ${TO}`, `Subject: ${d.subject}`, '', d.message, '', `${d.fname} ${d.lname}`.trim(), d.email];
    if (d.profession) lines.push(d.profession);
    return lines.join('\n');
  }
  const copyButton = 'type="button" data-contact-copy style="background:none;padding:0;color:var(--green-mid);font-weight:600;text-decoration:underline;font-size:inherit;font-family:inherit;cursor:pointer;"';

  status.addEventListener('click', async e => {
    const btn = e.target.closest('[data-contact-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(plainText(details()));
      btn.textContent = 'Copied — paste it into an email';
    } catch {
      btn.textContent = 'Copy didn\'t work — select the text in the form instead';
    }
  });

  function openEmailApp(d) {
    const { href, long } = mailtoFor(d);
    say('info', `<p><strong>Your email app should now open</strong> with your message to ${esc(TO)}. <strong>It has not been sent yet</strong> — press Send in your email app to deliver it.</p>
      ${long ? '<p style="margin-top:8px;">Your message is long, so the email holds the first part only. Use “copy your message” below and paste the rest before sending.</p>' : ''}
      <p style="margin-top:8px;">Nothing opened? <a href="${esc(href)}">Try again</a>, or <button ${copyButton}>copy your message</button> and email it to <a href="mailto:${TO}">${TO}</a>.</p>`);
    window.location.href = href;
  }

  /* ---------- Submit ---------- */
  let sending = false;
  function setSending(on) {
    sending = on;
    button.disabled = on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    if (buttonLabel) {
      if (on) { buttonLabel.dataset.label = buttonLabel.textContent; buttonLabel.textContent = 'Sending…'; }
      else if (buttonLabel.dataset.label) buttonLabel.textContent = buttonLabel.dataset.label;
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (sending) return;
    tried = true;
    const bad = RULES.map(([name]) => check(name) ? field(name) : null).filter(Boolean);
    if (bad.length) {
      say('invalid', `<p><strong>Please fix ${bad.length === 1 ? 'the field' : 'the ' + bad.length + ' fields'} marked above</strong> — nothing has been sent yet.</p>`, false);
      bad[0].focus();
      return;
    }

    const d = details();
    if (!API) { openEmailApp(d); return; }

    // Contract fields, plus the optional profession the API also stores.
    const payload = { name: `${d.fname} ${d.lname}`.trim(), email: d.email, subject: d.subject, message: d.message, website: d.website, profession: d.profession };
    const hadFocus = document.activeElement === button;
    setSending(true);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res = null, data = {};
    try {
      res = await fetch(API + '/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });
      data = await res.json().catch(() => ({}));
    } catch { res = null; }
    clearTimeout(timer);
    setSending(false);
    // Disabling the button drops keyboard focus to the page; put it back where the person was.
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) button.focus();

    if (res && res.ok && data && data.ok === true) { // only a real {ok:true} from the API counts as sent
      say('ok', `<p><strong>Thank you, ${esc(d.fname)} — your message has been sent.</strong> We typically respond within 2–3 business days, by email to ${esc(d.email)}.</p>`);
      form.reset();
      RULES.forEach(([name]) => { const el = field(name); if (el) setError(el, ''); });
      tried = false;
      return;
    }
    const reason = res && data && typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : res ? 'Our server could not accept it just now.' : 'We could not reach our server — please check your connection.';
    const { href } = mailtoFor(d);
    say('error', `<p><strong>Your message was not sent.</strong> ${esc(reason)}</p>
      <p style="margin-top:8px;">Your text is still in the form. Please try again, or <a href="${esc(href)}">send it from your email app</a> to ${esc(TO)} instead.</p>`);
  });
})();
