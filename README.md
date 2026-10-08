# GAZHP — Global Alliance of Zambian Healthcare Professionals

Official website for the Global Alliance of Zambian Healthcare Professionals (GAZHP), a 501(c)(3) nonprofit registered in Delaware, USA.

**Live site:** https://www.gazhphealth.org

## Project structure

Every page is a folder with its own `index.html`, so URLs are clean (`/about/`, `/donate/`…). All links and asset paths are root-absolute (`/css/style.css`, `/images/logo.png`).

```
.
├── index.html             # Home page
├── about/                 # About: mission, vision, history
├── team/                  # Board and team
├── news/                  # News index + one folder per article (news/<slug>/index.html)
├── membership/            # Membership tiers and benefits
├── join/                  # Membership application & dues payment
├── donate/                # Donation page (payment options)
├── contact/               # Contact details and contact form
├── thank-you/             # Post-payment confirmation (noindex)
├── privacy/               # Privacy Policy
├── terms/                 # Terms of use + donation, membership & refund policy
├── dashboard/             # Private admin dashboard (password-locked, noindex, not linked)
├── 404.html               # Branded "page not found"; redirects old .html URLs to their folders
├── css/
│   ├── style.css          # Site-wide styles (colors and fonts are CSS variables at the top)
│   └── dashboard.css      # Admin dashboard styles
├── js/
│   ├── main.js            # Navigation, animations and shared interactions (every page)
│   ├── payments-config.js # Payment methods, membership tiers, dashboard settings (PUBLIC, no secrets)
│   ├── payments.js        # Payment options on /donate/ and /join/
│   ├── contact.js         # Contact form on /contact/
│   └── dashboard.js       # Admin dashboard
├── api/                   # Optional payments API (Cloudflare Worker + D1 database)
├── fonts/                 # Self-hosted web fonts (Inter, Playfair Display), no Google Fonts
├── images/                # Optimized images used by the site (WebP), logo, social-share images
├── _source-images/        # Original full-size images, not published (GitHub Pages skips "_" folders)
├── sitemap.xml            # Page list for search engines
├── robots.txt
├── PAYMENTS-SETUP.md      # Step-by-step payments & dashboard setup
└── CNAME                  # Custom domain for GitHub Pages
```

There is no build step or template system. The header (skip link, navigation, mobile menu), the icon sprite, the `<!-- gazhp:head -->` block and the footer are copied into every page, including `404.html`, `privacy/` and `terms/`. If you change one of them, change it in all pages. The current page's nav link is marked with `class="active" aria-current="page"`.

When adding a page, also add it to `sitemap.xml` (unless it is `noindex`).

The Privacy Policy and Terms & Refund Policy describe how this site and its payment options actually work. Have them reviewed by the organization's counsel, and update them (and their "Last updated" date) whenever payment providers, the API, the contact form or the dashboard change. Open decisions are marked `TODO (board/counsel)` in HTML comments in those two files.

## Payments & admin dashboard

- `/donate/` and `/join/` show every payment method switched on in **`js/payments-config.js`**: Donorbox, Stripe, PayPal, DPO Pay (Zambian mobile money & cards), Mobile Money (MTN/Airtel/Zamtel), bank transfer, Zelle, Cash App, Venmo, checks, plus any custom link.
- `/dashboard/` is the password-locked admin dashboard for memberships and donations. It isn't linked from the site.
- `api/` holds the optional payments API (Cloudflare Worker + D1). It lets donors pay through Stripe (cards, Apple Pay, Google Pay), PayPal and DPO Pay (Zambia) directly with no Donorbox fee, and the dashboard fills itself from payment webhooks. It also receives contact-form messages for the dashboard. Without it, the contact form opens the visitor's email app addressed to info@gazhphealth.org.

See **[PAYMENTS-SETUP.md](PAYMENTS-SETUP.md)** for what to fill in.

## Local development

Any static file server works. The repo includes a `.claude/launch.json` config that uses `npx serve`:

```bash
npx serve .
```

Then open http://localhost:3000.

## Hosting

The site is deployed via **GitHub Pages** from the `main` branch root of [`ophir-intelligence/gazhp.org`](https://github.com/ophir-intelligence/gazhp.org), with the custom domain `gazhphealth.org` set via the `CNAME` file.

The repo is owned by the **Ophir Intelligence** GitHub organization.
