/* =============================================
   GAZHP — Main JavaScript
   Everything is wrapped in one function scope so these names can't clash with
   other scripts on the page. Only showToast() is shared, as window.showToast.
   ============================================= */
(function () {
  'use strict';

  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- Navbar scroll effect ----------
  const navbar = document.querySelector('.navbar');
  if (navbar) {
    const onScroll = () => {
      if (window.scrollY > 40) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---------- Mobile nav toggle ----------
  // The button carries aria-expanded / aria-controls; the X animation is CSS on [aria-expanded="true"].
  const hamburger = document.querySelector('.nav-hamburger');
  const mobileNav = document.querySelector('.mobile-nav');
  if (hamburger && mobileNav) {
    if (!mobileNav.id) mobileNav.id = 'mobile-nav';
    hamburger.setAttribute('aria-controls', mobileNav.id);
    hamburger.setAttribute('aria-expanded', 'false');

    const isOpen = () => mobileNav.classList.contains('open');

    // Everything the full-screen menu covers is made inert while it is open,
    // so Tab can't wander into content hidden underneath it.
    const setMenu = (open) => {
      mobileNav.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('nav-open', open);
      document.querySelectorAll('.skip-link, main, footer').forEach(el => el.toggleAttribute('inert', open));
    };

    hamburger.addEventListener('click', () => setMenu(!isOpen()));

    // Close on link click
    mobileNav.addEventListener('click', e => {
      if (e.target.closest('a')) setMenu(false);
    });

    // Close on Escape and hand focus back to the toggle
    document.addEventListener('keydown', e => {
      if ((e.key === 'Escape' || e.key === 'Esc') && isOpen()) {
        setMenu(false);
        hamburger.focus();
      }
    });

    // Close when the viewport grows past the mobile breakpoint (e.g. a tablet is rotated)
    if (window.matchMedia) {
      const desktop = window.matchMedia('(min-width: 769px)');
      const onBreakpoint = e => { if (e.matches && isOpen()) setMenu(false); };
      if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
      else if (desktop.addListener) desktop.addListener(onBreakpoint);
    }
  }

  // ---------- Scroll-reveal animations ----------
  // Content is visible by default. Only blocks that start below the fold are hidden
  // (.fade-pending) and faded in as soon as any part of them enters the viewport, so
  // above-the-fold content never waits for this script and very tall blocks still reveal.
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      let n = 0;
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        revealObserver.unobserve(el);
        setTimeout(() => el.classList.add('visible'), n++ * 60);
      });
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });

    // Once the fade has finished, drop the helper classes so the element's own
    // transitions (card hover effects etc.) apply again.
    const onRevealed = e => {
      const el = e.currentTarget;
      if (e.target !== el || e.propertyName !== 'opacity' || !el.classList.contains('visible')) return;
      el.removeEventListener('transitionend', onRevealed);
      el.classList.remove('fade-pending', 'visible');
    };

    const foldLine = window.innerHeight || document.documentElement.clientHeight;
    document.querySelectorAll('.fade-up').forEach(el => {
      if (el.getBoundingClientRect().top < foldLine) return; // already on screen: leave it alone
      el.classList.add('fade-pending');
      el.addEventListener('transitionend', onRevealed);
      revealObserver.observe(el);
    });
  }

  // ---------- Counter animation ----------
  const formatCounter = (el, value) =>
    (el.dataset.raw ? String(value) : value.toLocaleString()) + (el.dataset.suffix || '');

  function animateCounter(el) {
    const target = parseInt(el.dataset.target, 10);
    if (!Number.isFinite(target)) return;
    if (reduceMotion) {
      el.textContent = formatCounter(el, target); // no count-up: show the final figure
      return;
    }
    const duration = 1800;
    const start = performance.now();
    const update = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = formatCounter(el, Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  const statsBlocks = document.querySelectorAll('.stats-grid, .hero-stats');
  if (statsBlocks.length && 'IntersectionObserver' in window) {
    const statsObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.querySelectorAll('[data-target]').forEach(animateCounter);
          statsObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    statsBlocks.forEach(el => statsObserver.observe(el));
  }

  // Active nav state is written into each page's HTML (class="active" aria-current="page").
  // In-page anchor scrolling is handled by CSS (scroll-behavior + scroll-padding-top in style.css),
  // which also respects prefers-reduced-motion and moves keyboard focus correctly.

  // ---------- Toast notification ----------
  // showToast(iconId, message): iconId is an optional sprite reference such as '#i-check'.
  // The toast is a polite live region, so screen readers announce the message too.
  let toastTimer;
  let toastPending = null; // latest {icon, message} while a brand-new region is settling
  function renderToast(toast, icon, message) {
    toast.textContent = '';
    if (icon && document.getElementById(String(icon).replace(/^#/, ''))) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', icon);
      svg.appendChild(use);
      toast.appendChild(svg);
    }
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    // Longer messages (e.g. a URL to copy by hand, a server error) stay up longer.
    const ms = Math.min(10000, Math.max(4000, String(message).length * 70));
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }
  function showToast(icon, message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
      // A brand-new live region needs a moment in the DOM before its content changes are announced.
      toastPending = { icon, message };
      setTimeout(() => {
        const p = toastPending;
        toastPending = null;
        if (p) renderToast(toast, p.icon, p.message);
      }, 100);
      return;
    }
    if (toastPending) { toastPending = { icon, message }; return; } // still settling: show the latest one
    renderToast(toast, icon, message);
  }
  window.showToast = showToast;

  // ---------- Share bar ----------
  // <button data-share-copy="https://…">Copy link</button> copies the URL;
  // <button data-share-native> opens the device share sheet where supported (hidden otherwise).
  const canonicalUrl = () => {
    const link = document.querySelector('link[rel="canonical"]');
    return (link && link.href) || window.location.href;
  };

  const legacyCopy = text => new Promise((resolve, reject) => {
    const prevFocus = document.activeElement; // select() moves focus; hand it back afterwards
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
    if (ok) resolve(); else reject(new Error('copy failed'));
  });

  const copyText = text => (navigator.clipboard && navigator.clipboard.writeText)
    ? navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
    : legacyCopy(text);

  const copyLink = (btn, url) => {
    copyText(url).then(() => {
      btn.classList.add('is-copied');
      setTimeout(() => btn.classList.remove('is-copied'), 2000);
      showToast('#i-check', 'Link copied');
    }).catch(() => {
      showToast('', 'Could not copy automatically. The link is: ' + url);
    });
  };

  document.addEventListener('click', e => {
    const copyBtn = e.target.closest('[data-share-copy]');
    if (copyBtn) {
      e.preventDefault();
      copyLink(copyBtn, copyBtn.getAttribute('data-share-copy') || canonicalUrl());
      return;
    }
    const nativeBtn = e.target.closest('[data-share-native]');
    if (nativeBtn) {
      e.preventDefault();
      const url = nativeBtn.getAttribute('data-share-native') || canonicalUrl();
      if (navigator.share) {
        navigator.share({ title: document.title, url }).catch(() => { /* dismissed by the user */ });
      } else {
        copyLink(nativeBtn, url); // no share sheet on this device: copy the link instead
      }
    }
  });

  if (!navigator.share) {
    document.querySelectorAll('[data-share-native]').forEach(btn => { btn.hidden = true; });
  }
  // (.amount-btn elements are plain /donate/?amount=… links now, so they need no script.)
})();
