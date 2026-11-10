// ili studio plans. Prices and allowances mirror ilidweb.uk (src/data/studio.json there).
// Paid plans are billed once a year through Blesta (src/billing.js); `price` is the monthly equivalent shown to clients,
// `yearly` what is invoiced. The Blesta packages must have the same yearly prices.
export const FREE_DOMAIN = (process.env.FREE_DOMAIN || 'yela.uk').toLowerCase();

export const PLANS = [
  {
    id: 'free', name: 'Free', price: 0, pages: 1, credits: 30, creditsOnce: true, customDomain: false, sites: 1, drafts: 3, versions: 1, statsDays: 30,
    summary: 'Try ili studio and publish a one-page site, free for good.',
    features: ['1 site, 1 published page', `Free address: yourname.${FREE_DOMAIN}`, '30 AI credits at sign-up (one-time)', 'Every theme', 'Unlimited manual editing', 'Small “Website made with Ilidweb” bar at the bottom'],
  },
  {
    id: 'essential', name: 'Essential', price: 3.25, yearly: 39, pages: 5, credits: 200, customDomain: true, sites: 1, drafts: 3, versions: 5, statsDays: 180,
    summary: 'A small site for a local business, on your own domain.',
    features: ['1 site, up to 5 pages', 'Free .co.uk, .uk or .org.uk domain, or connect yours', '200 AI credits / month', 'No Ilidweb bar on your site', 'Contact form, WhatsApp, call and email buttons', '6 months of statistics, 5 saved versions'],
  },
  {
    id: 'plus', name: 'Plus', price: 5.75, yearly: 69, pages: null, credits: 500, customDomain: true, sites: 3, drafts: 6, versions: 15, statsDays: 730, featured: true,
    summary: 'Up to 3 sites, as many pages as you need.',
    features: ['Up to 3 sites, unlimited pages', 'Free domain, and connect your own on every site', '500 AI credits / month', '2 years of statistics, 15 saved versions', 'Import a ZIP or HTML site', 'Booking and online payments (soon)'],
  },
  {
    id: 'pro', name: 'Pro', price: 9.92, yearly: 119, pages: null, credits: 1000, customDomain: true, sites: 10, drafts: 20, versions: 30, statsDays: 730,
    summary: 'For growing businesses and freelancers with several sites.',
    features: ['Up to 10 sites', 'Everything in Plus', '1,000 AI credits / month', '30 saved versions of each site', 'Mini shop (soon)', 'Priority support'],
  },
];

export const planOf = (user) => PLANS.find((p) => p.id === (user?.plan || 'free')) || PLANS[0];

// AI credit costs (first AI creation of a site and photo search are free)
export const COSTS = { wrenText: 1, wrenBlock: 2 };

// Sub-domains a client can never take
export const RESERVED = new Set(['www', 'mail', 'email', 'smtp', 'imap', 'pop', 'webmail', 'admin', 'app', 'api', 'studio', 'ili', 'ilidweb', 'yela',
  'help', 'support', 'status', 'blog', 'shop', 'billing', 'my', 'account', 'login', 'dashboard', 'ns1', 'ns2', 'cdn', 'static', 'assets', 'test', 'dev']);
