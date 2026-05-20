# GAZHP — Global Alliance of Zambian Healthcare Professionals

Official website for the Global Alliance of Zambian Healthcare Professionals (GAZHP), a 501(c)(3) nonprofit registered in Delaware, USA.

**Live site:** https://gazhphealth.org

## Project structure

```
.
├── index.html         # Home page
├── about.html         # About / mission / programs
├── teams.html         # Team members
├── membership.html    # Membership info
├── contact.html       # Contact + donate
├── css/style.css      # All styles
├── js/main.js         # Client-side interactions
├── images/            # Photos, logos, program imagery
└── CNAME              # Custom domain for GitHub Pages
```

## Local development

Any static file server works. The repo includes a `.claude/launch.json` config that uses `npx serve`:

```bash
npx serve .
```

Then open http://localhost:3000.

## Hosting

The site is deployed via **GitHub Pages** from the `main` branch root of [`ophir-intelligence/gazhp.org`](https://github.com/ophir-intelligence/gazhp.org), with the custom domain `gazhphealth.org` set via the `CNAME` file.

The repo is owned by the **Ophir Intelligence** GitHub organization.
