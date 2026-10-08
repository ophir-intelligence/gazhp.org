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
├── _source-images/        # Original full-size images, not linked from any page (see Hosting: Vercel publishes "_" folders)
├── sitemap.xml            # Page list for search engines (www URLs, with <lastmod> dates)
├── robots.txt             # Points to the sitemap; blocks crawling of _print/ and _source-images/
├── PAYMENTS-SETUP.md      # Step-by-step payments & dashboard setup
└── CNAME                  # Custom domain for GitHub Pages only (not used by Vercel)
```

There is no build step or template system. The header (skip link, navigation, mobile menu), the icon sprite, the `<!-- gazhp:head -->` block and the footer are copied into every page, including `404.html`, `privacy/` and `terms/`. If you change one of them, change it in all pages. The current page's nav link is marked with `class="active" aria-current="page"`.

When adding a page, also add it to `sitemap.xml` (unless it is `noindex`).

### Search engines (SEO)

- **One address.** `https://www.gazhphealth.org/` (with `www` and a trailing slash) is the canonical address. Every page's `<link rel="canonical">`, `og:url`, structured data, `sitemap.xml` and `robots.txt` use it. Never use `https://gazhphealth.org/…` (no `www`) in new code.
- **Titles and descriptions.** Each page has its own `<title>` (aim for 60 characters or fewer) and meta description (about 120–160 characters). Keep `og:title` and `og:description` in step with them.
- **Structured data (JSON-LD)** lives inside the `<!-- gazhp:head -->` block. The full organization (`NGO`, `"@id": "https://www.gazhphealth.org/#organization"`) and website (`"@id": "https://www.gazhphealth.org/#website"`) entries live only on the home page. Other pages refer to them by `@id`, and each indexable inner page has a `BreadcrumbList` that matches its visible breadcrumb. Check changes with Google's Rich Results Test.
- **`sitemap.xml`:** when you change a page's content or `<head>`, set its `<lastmod>` to that day's date.
- **Don't invent facts.** Names, numbers, dates and profile links in page copy and structured data must come from the organization.

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

The live site is served by **Vercel** at **https://www.gazhphealth.org**, deployed from the `main` branch of [`ophir-intelligence/gazhp.org`](https://github.com/ophir-intelligence/gazhp.org). The bare domain `gazhphealth.org` redirects to `www`. In Vercel (Project → Settings → Domains → `gazhphealth.org`), set that redirect to **308 Permanent** rather than 307 Temporary, so search engines treat `www` as the only address.

Vercel publishes every file in the repository, including `_` folders such as `_print/` and `_source-images/`, Markdown files and `api/`. Anything that should not be public is excluded in the `.vercelignore` file at the repository root (currently `api/`, `_print/`, `_source-images/`, Markdown files and `.claude/`). Redirects for old WordPress URLs, the trailing-slash rule and cache headers live in `vercel.json`.

GitHub Pages is also still switched on for the repository. It builds from `main` and uses the `CNAME` file (`gazhphealth.org`), but it is not the production host. Its default address only redirects to the custom domain.

The repo is owned by the **Ophir Intelligence** GitHub organization.
