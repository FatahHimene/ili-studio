// ili studio plans. Prices and allowances mirror ilidweb.uk (src/data/studio.json there).
// Paid plans are switched on by billing (Blesta) later; until then a client can only record a choice.
export const FREE_DOMAIN = (process.env.FREE_DOMAIN || 'yela.uk').toLowerCase();

export const PLANS = [
  {
    id: 'free', name: 'Free', price: 0, pages: 1, credits: 30, creditsOnce: true, customDomain: false, sites: 3,
    summary: 'Try ili studio and publish a one-page site, free for good.',
    features: ['1 published page', `Free address: yourname.${FREE_DOMAIN}`, '30 AI credits at sign-up (one-time)', 'Every theme', 'Unlimited manual editing', 'Small “Made with ili studio” link at the bottom'],
  },
  {
    id: 'essential', name: 'Essential', price: 4.99, pages: 5, credits: 200, customDomain: false, sites: 3,
    summary: 'A small site for a local business.',
    features: ['Up to 5 pages', '200 AI credits / month', `Free address: yourname.${FREE_DOMAIN}`, 'No ili studio link on your site', 'Import a ZIP or HTML site'],
  },
  {
    id: 'plus', name: 'Plus', price: 8.99, pages: null, credits: 500, customDomain: true, sites: 3, featured: true,
    summary: 'Your own domain and as many pages as you need.',
    features: ['Unlimited pages', '500 AI credits / month', 'Your own domain', '2 custom AI illustrations / month', 'Import a ZIP or HTML site'],
  },
  {
    id: 'pro', name: 'Pro', price: 14.99, pages: null, credits: 1000, customDomain: true, sites: 5,
    summary: 'For growing businesses that edit often.',
    features: ['Everything in Plus', '1,000 AI credits / month', '5 custom AI illustrations / month', 'Version history', 'Priority support'],
  },
];

export const planOf = (user) => PLANS.find((p) => p.id === (user?.plan || 'free')) || PLANS[0];

// AI credit costs (first AI creation of a site and photo search are free)
export const COSTS = { wrenText: 1, wrenBlock: 2 };

// Sub-domains a client can never take
export const RESERVED = new Set(['www', 'mail', 'email', 'smtp', 'imap', 'pop', 'webmail', 'admin', 'app', 'api', 'studio', 'ili', 'ilidweb', 'yela',
  'help', 'support', 'status', 'blog', 'shop', 'billing', 'my', 'account', 'login', 'dashboard', 'ns1', 'ns2', 'cdn', 'static', 'assets', 'test', 'dev']);
