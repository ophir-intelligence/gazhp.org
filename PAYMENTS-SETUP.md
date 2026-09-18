# Payments & Dashboard — Setup Guide

There are two ways to run payments. Both are built and ready:

| | **A. Automated (own API)** (recommended) | **B. Links only** (what's live today) |
|---|---|---|
| How donors pay | GAZHP's own form, then Stripe / PayPal / Flutterwave secure checkout | Donorbox form, payment links, account details |
| Platform fee | **None.** You pay only the processors' own fees | Donorbox charges its fee on top of processing |
| Dashboard | **Updates itself** from payment webhooks, shared by all admins | Import CSV exports by hand, kept in one browser |
| Needs | Free Cloudflare account and one-time setup (below) | Nothing extra |

Bank transfer, Zelle, Cash App, Venmo, checks and direct mobile money work in both modes. They have no public API, so donors tell you with an "I've paid" form. In automated mode, those reports land in the dashboard under **Awaiting confirmation**, where you confirm with one click once the money arrives.

---

## A. Automated payments (own API)

The API lives in [`api/`](api/). It's a Cloudflare Worker (free tier: 100k requests per day) plus a D1 database. Secret keys stay on Cloudflare and never go in the website code.

**What it does**
- Creates checkouts server-side with prices from [`api/src/config.js`](api/src/config.js), so nobody can change the price in their browser.
- **Stripe:** cards, Apple Pay, Google Pay and US bank (ACH), plus **monthly donations** and **auto-renewing yearly memberships**.
- **PayPal:** one-time payments in USD.
- **Flutterwave:** MTN / Airtel / Zamtel mobile money and Zambian cards in **ZMW**. Memberships are converted with `ZMW_PER_USD` in `wrangler.toml`.
- Receives webhooks, verifies their signatures, and records each payment once. Renewals, refunds and failed bank debits update automatically.
- Optional email alert for every new payment or "I've paid" report (via resend.com).
- If the API is ever unreachable, /donate/ and /join/ fall back to Donorbox and the offline options automatically.

### Step 1. Deploy the API (about 15 minutes, one time)

You need Node.js and a free Cloudflare account.

```bash
cd api
npm install
npx wrangler login
npx wrangler d1 create gazhp-payments
```
Copy the `database_id` it prints into `api/wrangler.toml`, then:
```bash
npm run db:init
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```
`ADMIN_PASSWORD` is the dashboard password in automated mode. Use 16 or more characters. `deploy` prints your API address, e.g. `https://gazhp-payments.<account>.workers.dev`.

Paste that address into **`js/payments-config.js` → `api.baseUrl`**, commit and push.

### Step 2. Connect each gateway

Each gateway switches on as soon as its key is set, with no redeploy needed. Set each key with `npx wrangler secret put NAME`.

**Stripe**
1. In Stripe, go to **Developers → API keys** and copy the secret key into `STRIPE_SECRET_KEY`.
2. Go to **Developers → Webhooks → Add endpoint**:
   - URL: `<API>/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `charge.refunded`
   - Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
3. **Settings → Payment methods:** turn on Apple Pay, Google Pay and ACH Direct Debit (US bank account).
4. Apply for Stripe's discounted nonprofit rate by emailing Stripe support with your 501(c)(3) letter.

**PayPal**
1. At developer.paypal.com, go to **Apps & Credentials → Live → Create App**. Copy the client ID and secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. Optional, for refund tracking: in the same app, add a webhook with URL `<API>/webhooks/paypal` and events `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED` and `PAYMENT.CAPTURE.REFUNDED`. Copy its ID into `PAYPAL_WEBHOOK_ID`.
3. Apply for PayPal's confirmed-nonprofit rate.

**Flutterwave**
1. Go to **Settings → API Keys** and copy the secret key into `FLW_SECRET_KEY`.
2. Go to **Settings → Webhooks**:
   - URL: `<API>/webhooks/flutterwave`
   - Secret hash: any long random string. Put the same string in `FLW_WEBHOOK_HASH`.
3. Make sure Zambian mobile money is enabled on your account.

**Email alerts (optional):** set `RESEND_API_KEY`, `NOTIFY_EMAIL` (e.g. info@gazhphealth.org) and `FROM_EMAIL` (an address on a domain you've verified in Resend).

### Step 3. Test before going live
Use test keys first:
- Stripe: `sk_test_…`, test card `4242 4242 4242 4242`.
- PayPal: sandbox app, and set `PAYPAL_ENV = "sandbox"` in `wrangler.toml`, then run `npx wrangler deploy`.
- Flutterwave: test secret key.

Make a donation and a membership payment, check that they appear in /dashboard/ within a minute, then swap in the live keys.

### Step 4. Retire Donorbox
The Donorbox form is hidden automatically once the API is live. Import your Donorbox history in **Dashboard → Import data** (Donations → Export CSV in Donorbox) so past members and donors carry over, then cancel the Donorbox plan.

### Changing prices
Edit [`api/src/config.js`](api/src/config.js) and run `npx wrangler deploy`. The website reads prices from the API.

### Local development
```bash
cd api
cp .dev.vars.example .dev.vars
npm run db:init:local
npx wrangler dev
```
Then set `api.baseUrl` to `http://localhost:8787` while testing locally.

---

## B. Links-only mode (no API)

Fill in **your details** in one file:

```
js/payments-config.js
```

Each payment method has `enabled: false` and some blanks (`''`). Fill in the blanks, change `enabled` to `true`, commit, and the method appears on **/donate/** and **/join/** automatically. If a method is enabled but still missing details, it stays hidden, so donors never see a half-set-up option.

To see what's still missing, open **/dashboard/ → Setup**.

> **Security:** `payments-config.js` is public. Only put in things you'd print on a flyer: payment links, receiving account numbers, handles and phone numbers. **Never** put secret API keys, passwords or logins in it. None of the gateways below need one.

---

## 1. Organization details

| Field | What to put |
|---|---|
| `org.email` | Inbox that receives "I've paid" notifications (default `info@gazhphealth.org`) |
| `org.ein` | Your US EIN, e.g. `12-3456789`. Shown on the payment pages for tax receipts |
| `org.mailingAddress` | Needed only if you accept checks |

## 2. Payment methods

### Donorbox (already live)
Cards, Apple Pay, Google Pay, PayPal, ACH and recurring gifts. Already set to your campaigns `donate-to-gazhp` and `join-as-a-member`. Nothing to do.

### Stripe Payment Links
1. Create or log in to a Stripe account (as a nonprofit you can apply for discounted fees).
2. Go to **Payment Links → New**.
   - **Donation:** product "Donation to GAZHP", pricing **"Customers choose what to pay"**.
   - **Monthly donation (optional):** recurring price, monthly.
   - **Membership:** one link per tier, with a fixed price and **recurring yearly**, or one-time.
3. Paste each `https://buy.stripe.com/...` URL into `stripe.donationLink`, `stripe.monthlyDonationLink` and `stripe.membershipLinks['<tier-id>']`.

### PayPal
Pick **either** option:
- **Donate button (recommended for donations):** PayPal Business → *Pay & Get Paid → Accept Donations → Donate button*. When it's created, copy the `hosted_button_id` value into `paypal.hostedButtonId`.
- **PayPal.me:** create a paypal.me link and put the username (the part after `paypal.me/`) in `paypal.paypalMeUsername`. On /join/ it prefills the tier amount.

For membership you can also paste per-tier PayPal payment links into `paypal.membershipLinks`.

### Flutterwave (best for Zambia)
Takes Zambian Visa/Mastercard, **MTN MoMo, Airtel Money, Zamtel** and bank transfers, in ZMW or USD.
1. Register a business at flutterwave.com (select Zambia) and complete KYC.
2. **Payment Links → Create payment link**, one for donations (let the customer enter the amount) and optionally one per membership tier.
3. Paste the `https://flutterwave.com/pay/...` URLs into `flutterwave.donationLink` / `flutterwave.membershipLinks`.

### Mobile Money (direct)
If you have MTN/Airtel/Zamtel merchant or business numbers, fill in `mobileMoney.accountName` plus `number` and/or `merchantCode` for each network you use. Donors see the numbers with copy buttons, a unique reference code (e.g. `GAZHP-D-7KQ2M`), and an "I've paid" button that emails you the details. Membership amounts also show an approximate Kwacha figure based on `dashboard.fxRates.ZMW`.

### Bank transfer
Fill in `bankTransfer.us` and/or `bankTransfer.zambia`. Only accounts that have an `accountNumber` are shown.

### Zelle, Cash App, Venmo
Fill in `zelle.emailOrPhone` (plus `recipientName`), `cashApp.cashtag`, and `venmo.username`.

### Check by mail
Set `org.mailingAddress` and `check.enabled: true`.

### Any other gateway
Add entries to `gateways.custom`. This works for DPO Pay, Pesapal, Paystack, Givebutter, GoFundMe or anything else with a payment link:
```js
custom: [
  { enabled: true, name: 'DPO Pay', description: 'Cards & mobile money across Africa', url: 'https://…', purpose: 'both' },
],
```

### Membership tiers
`membershipTiers` holds the prices shown on /join/. If you change a price, change it here. The tier `id` values are used as keys in each gateway's `membershipLinks`. You can link directly to a preselected tier: `/join/?tier=student-developing`.

---

## 3. Admin dashboard: `/dashboard/`

In automated mode, sign in with `ADMIN_PASSWORD` (set on Cloudflare). Payments arrive automatically, refresh every minute, and are shared by every admin. Everything below about CSV import, manual entry and the Google Sheet still works. Imports and manual entries are saved to the database instead of the browser.

Without the API: the passcode was given to the site admin privately (it is not written anywhere in this repo). To change it, open /dashboard/ → Setup → *Generate hash*, then paste the result into `dashboard.passcodeHash`.

The dashboard isn't linked from the site and is hidden from search engines (`robots.txt` plus a `noindex` tag). The passcode is a screen lock, not real security. That's fine because **no payment data is ever stored on the website**:

- **Import data:** upload the CSV exports you download from Donorbox, Stripe, PayPal and Flutterwave. Columns are detected automatically. Duplicates, refunds, failed payments and PayPal transfers/fees are skipped. Payments are classified as membership or donation from the campaign or description, and matched to a tier by name or amount.
- **Record payment:** enter mobile money, bank, Zelle, cash and check payments by hand. Use the reference code from the donor's "I've paid" email.
- Data is kept **only in the browser you use**. Use **Download full backup** regularly, and **Restore from backup** to move it to another computer.

What you get:
- **Overview:** total received, donations, dues, active members, renewals due, average gift, monthly chart, breakdown by payment method, members by tier, recent payments, and an optional annual goal bar (`dashboard.annualFundraisingGoal`).
- **Members:** everyone who paid dues, with member-since, last paid, expiry (`membershipTermMonths` after the last payment) and Active / Expiring soon / Expired status. You can search and filter, export CSV, and send one-click renewal reminder emails (BCC).
- **Payments:** every payment, with search and filters, CSV export and delete.

### Mixed currencies
Totals are reported in `dashboard.reportingCurrency` (USD). Keep `dashboard.fxRates` roughly current, e.g. `ZMW: 0.037` means 1 ZMW = 0.037 USD. If a payment's currency has no rate, the dashboard warns you.

### Optional: live Google Sheet
If you'd rather keep a shared spreadsheet, for example one updated by Zapier from Donorbox, publish it via *File → Share → Publish to web → CSV* and paste the link into `dashboard.googleSheetCsvUrl`. Use these column headers:

```
Date, Name, Email, Phone, Country, Amount, Currency, Type, Tier, Method, Reference, Notes
```

`Type` is `donation` or `membership`. `Tier` is a tier id or name. Note that a published sheet can be read by anyone who has the link.

### Try it first
Go to /dashboard/ → Setup → **Load sample data** to see the dashboard with 60 made-up payments. Remove them with **Remove sample data**.
