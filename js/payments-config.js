/* =============================================================================
   GAZHP — PAYMENTS & DASHBOARD CONFIGURATION
   -----------------------------------------------------------------------------
   THIS IS THE ONLY FILE YOU NEED TO EDIT to switch payment methods on or off.

   How it works:
     • Every payment method has an `enabled` flag and a few blanks ("").
     • A method only appears on /donate/ and /join/ when it is enabled AND its
       required fields are filled in. Leave anything blank and it stays hidden,
       so a half-filled method never shows up to donors.
     • /dashboard/ → "Setup" tab shows a checklist of what is still missing.

   SECURITY — read before filling in:
     • This file is PUBLIC (anyone can view it in the browser). Only put things
       here that you would print on a flyer: public payment links, account
       numbers meant for receiving money, handles, mobile-money numbers.
     • NEVER put secret API keys, passwords, bank logins or card numbers here.
       Every gateway below uses a hosted checkout link, so none are needed.

   Full step-by-step guide: see PAYMENTS-SETUP.md in the repository root.
   ============================================================================= */

window.GAZHP_CONFIG = {

  /* ---------------------------------------------------------------------------
     ORGANIZATION
     ------------------------------------------------------------------------- */
  org: {
    name: 'Global Alliance of Zambian Healthcare Professionals',
    shortName: 'GAZHP',
    email: 'info@gazhphealth.org',        // Where "I've paid" notifications go
    ein: '',                              // US EIN, e.g. '12-3456789' — shown on receipts/tax note
    mailingAddress: '',                   // For checks, e.g. 'GAZHP, PO Box 123, Wilmington, DE 19801, USA'
  },

  /* ---------------------------------------------------------------------------
     MEMBERSHIP TIERS  (prices shown on /join/ and used by the dashboard)
     Each tier can have its own link per gateway — see `membershipLinks` below.
     ------------------------------------------------------------------------- */
  membershipTiers: [
    { id: 'professional-developed',  name: 'Professional Member', region: 'Developed countries',            amount: 200,  currency: 'USD' },
    { id: 'professional-developing', name: 'Professional Member', region: 'Zambia & developing countries',  amount: 100,  currency: 'USD' },
    { id: 'student-developed',       name: 'Student Member',      region: 'Developed countries',            amount: 75,   currency: 'USD' },
    { id: 'student-developing',      name: 'Student Member',      region: 'Zambia & developing countries',  amount: 40,   currency: 'USD' },
    { id: 'corporate',               name: 'Corporate Member',    region: 'All corporations',               amount: 1000, currency: 'USD' },
  ],
  membershipTermMonths: 12,               // Membership length — used to calculate expiry dates
  renewalReminderDays: 30,                // Dashboard flags members expiring within this many days

  /* Suggested donation amounts shown on /donate/ (USD) */
  donationAmounts: [25, 50, 100, 250, 500],

  /* ---------------------------------------------------------------------------
     PAYMENT GATEWAYS
     ------------------------------------------------------------------------- */
  gateways: {

    /* 1. DONORBOX — cards, Apple Pay, Google Pay, ACH, PayPal, recurring.
          Already live. Campaign slug = the part after donorbox.org/ in your
          campaign URL. */
    donorbox: {
      enabled: true,
      donationCampaign: 'donate-to-gazhp',
      membershipCampaign: 'join-as-a-member',
    },

    /* 2. STRIPE PAYMENT LINKS — cards, Apple Pay, Google Pay, Link.
          Stripe Dashboard → Payment Links → New. For donations choose
          "Customers choose what to pay". Paste the https://buy.stripe.com/… URLs. */
    stripe: {
      enabled: false,
      donationLink: '',                    // e.g. 'https://buy.stripe.com/abc123'
      monthlyDonationLink: '',             // optional recurring link
      membershipLinks: {                   // one link per tier id (optional per tier)
        'professional-developed': '',
        'professional-developing': '',
        'student-developed': '',
        'student-developing': '',
        'corporate': '',
      },
    },

    /* 3. PAYPAL — PayPal balance, cards, Venmo (US).
          Easiest: PayPal Business → Pay & Get Paid → Donate button → copy the
          hosted_button_id. Or use a paypal.me link. Either one is enough. */
    paypal: {
      enabled: false,
      hostedButtonId: '',                  // e.g. 'ABCDEF12345'
      paypalMeUsername: '',                // e.g. 'gazhp'  → paypal.me/gazhp
      membershipLinks: {
        'professional-developed': '',
        'professional-developing': '',
        'student-developed': '',
        'student-developing': '',
        'corporate': '',
      },
    },

    /* 4. FLUTTERWAVE — best for Zambia & Africa: local Visa/Mastercard,
          MTN MoMo, Airtel Money, Zamtel, bank transfer — in ZMW or USD.
          Flutterwave Dashboard → Payment Links → Create. Paste the
          https://flutterwave.com/pay/… URLs. */
    flutterwave: {
      enabled: false,
      donationLink: '',
      membershipLinks: {
        'professional-developed': '',
        'professional-developing': '',
        'student-developed': '',
        'student-developing': '',
        'corporate': '',
      },
    },

    /* 5. MOBILE MONEY (direct, Zambia) — donors send to your number and use
          the reference code shown on screen. Fill in only the networks you use. */
    mobileMoney: {
      enabled: false,
      accountName: '',                     // Name that appears on the donor's phone, e.g. 'GAZHP ZAMBIA'
      mtn:    { number: '', merchantCode: '' },   // e.g. number '+260 96 1234567'
      airtel: { number: '', merchantCode: '' },
      zamtel: { number: '', merchantCode: '' },
    },

    /* 6. BANK TRANSFER — fill in whichever accounts you have. */
    bankTransfer: {
      enabled: false,
      us: {                                // US account (ACH / domestic wire)
        bankName: '',
        accountName: '',
        accountNumber: '',
        routingNumber: '',                 // ACH routing
        wireRoutingNumber: '',             // if different
        swift: '',                         // for international wires into the US account
        bankAddress: '',
      },
      zambia: {                            // Zambian account (ZMW or USD)
        bankName: '',
        accountName: '',
        accountNumber: '',
        branch: '',
        branchCode: '',
        swift: '',
        currency: 'ZMW',
      },
    },

    /* 7. US PEER-TO-PEER APPS */
    zelle:   { enabled: false, emailOrPhone: '', recipientName: '' },
    cashApp: { enabled: false, cashtag: '' },            // e.g. '$GAZHP'
    venmo:   { enabled: false, username: '' },           // e.g. 'GAZHP' (no @)

    /* 8. CHECK BY MAIL — uses org.mailingAddress above */
    check: { enabled: false, payableTo: 'Global Alliance of Zambian Healthcare Professionals' },

    /* 9. ANY OTHER GATEWAY (DPO Pay, Pesapal, Paystack, Givebutter, GoFundMe…)
          Add as many as you like. `purpose`: 'donation', 'membership' or 'both'. */
    custom: [
      // { enabled: true, name: 'DPO Pay', description: 'Cards & mobile money across Africa', url: 'https://…', purpose: 'both' },
    ],
  },

  /* ---------------------------------------------------------------------------
     ADMIN DASHBOARD  (/dashboard/)
     ------------------------------------------------------------------------- */
  dashboard: {
    /* SHA-256 hash of the dashboard passcode. Default passcode is  gazhp-admin
       CHANGE IT: open /dashboard/, go to Setup → "Generate passcode hash",
       and paste the result here. The passcode only hides the screen — your
       data is never stored on the website itself (see PAYMENTS-SETUP.md). */
    passcodeHash: '0a8b1e2c3e5690de87df39b4e36e01f91f44327ba59483b68424e7f13ec63e8c',

    reportingCurrency: 'USD',
    /* Exchange rates INTO the reporting currency, used to total mixed-currency
       payments. Example: 1 ZMW = 0.037 USD. Update occasionally. */
    fxRates: { USD: 1, ZMW: 0.037, GBP: 1.27, EUR: 1.08, CAD: 0.73, AUD: 0.66, ZAR: 0.055 },

    annualFundraisingGoal: 0,              // e.g. 50000 — shows a progress bar; 0 hides it

    /* Optional live data: a Google Sheet published as CSV.
       Sheet → File → Share → Publish to web → choose the tab → CSV → copy link.
       Column headers: see PAYMENTS-SETUP.md. Leave blank to use CSV uploads only.
       NOTE: a published sheet is readable by anyone who has the link. */
    googleSheetCsvUrl: '',
  },
};
