/* Prices the server charges. The website reads these from GET /config,
   so this is the single source of truth for membership prices once the
   API is live. (js/payments-config.js tiers are only used without the API.) */
export const TIERS = [
  { id: 'professional-developed',  name: 'Professional Member', region: 'Developed countries',           amount: 200,  currency: 'USD' },
  { id: 'professional-developing', name: 'Professional Member', region: 'Zambia & developing countries', amount: 100,  currency: 'USD' },
  { id: 'student-developed',       name: 'Student Member',      region: 'Developed countries',           amount: 75,   currency: 'USD' },
  { id: 'student-developing',      name: 'Student Member',      region: 'Zambia & developing countries', amount: 40,   currency: 'USD' },
  { id: 'corporate',               name: 'Corporate Member',    region: 'All corporations',              amount: 1000, currency: 'USD' },
];

export const DONATION = {
  presets: { USD: [25, 50, 100, 250, 500], ZMW: [250, 500, 1000, 2500, 5000] },
  min: { USD: 1, ZMW: 20 },
  max: { USD: 100000, ZMW: 2500000 },
};

// Methods donors can report through the "I've paid" form.
export const OFFLINE_METHODS = [
  'Bank transfer', 'Zelle', 'Cash App', 'Venmo', 'Check',
  'Mobile Money — MTN', 'Mobile Money — Airtel', 'Mobile Money — Zamtel', 'Mobile Money', 'Other',
];
