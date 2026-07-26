// api/checkout.js — Marvelous 3D Printing checkout
// Creates a Stripe Checkout Session for the DROPS cart.
// Zero npm dependencies (uses fetch to the Stripe API directly).
//
// Setup (one time):
//   1. Commit this file at /api/checkout.js in the repo root — Vercel auto-deploys it.
//   2. In Vercel → Project → Settings → Environment Variables, add:
//        STRIPE_SECRET_KEY = sk_live_...  (or sk_test_... while testing)
//   3. Redeploy. The site's "Pay with card — Stripe" button starts working;
//      until then it gracefully falls back to the order-request flow.
//
// Security note: prices are computed HERE from the catalog below, never trusted
// from the client. Keep this catalog in sync with SHOP_ITEMS in index.html.
//
// Heads up: this file is CommonJS. If your repo has a package.json with
// "type": "module", either remove that line or change the export at the
// bottom to:  export default async function handler(req, res) { ... }

// DROPS shop items
const CATALOG = { dragon:16, axolotl:14, keytag:8, planter:12, dock:15, throne:18 };
const SIZES   = { S:0.75, M:1, L:1.4 };
const SILK_UPCHARGE = 2; // dollars

// MARKETPLACE items — generated from MP_CATS in index.html; keep the two in sync.
// (Prices are authoritative HERE; the client's numbers are only for display.)
const MP_CATALOG = {
  'art-01':45,
  'art-02':38,
  'art-03':55,
  'art-04':15,
  'art-05':24,
  'art-06':65,
  'auto-01':25,
  'auto-02':32,
  'auto-03':18,
  'auto-04':14,
  'auto-05':28,
  'auto-06':34,
  'auto-07':22,
  'auto-08':27,
  'auto-09':36,
  'biz-01':12,
  'biz-02':28,
  'biz-03':20,
  'biz-04':24,
  'biz-05':21,
  'biz-06':35,
  'cos-01':85,
  'cos-02':95,
  'cos-03':28,
  'cos-04':45,
  'cos-05':55,
  'elec-01':14,
  'elec-02':29,
  'elec-03':17,
  'elec-04':15,
  'elec-05':13,
  'elec-06':31,
  'elec-07':18,
  'elec-08':22,
  'game-01':16,
  'game-02':24,
  'game-03':27,
  'game-04':13,
  'game-05':19,
  'game-06':26,
  'home-01':16,
  'home-02':12,
  'home-03':19,
  'home-04':24,
  'home-05':21,
  'home-06':23,
  'home-07':20,
  'home-08':15,
  'marine-01':26,
  'marine-02':23,
  'marine-03':19,
  'marine-04':22,
  'marine-05':29,
  'out-01':20,
  'out-02':17,
  'out-03':24,
  'out-04':18,
  'robot-01':25,
  'robot-02':14,
  'robot-03':19,
  'robot-04':22,
  'robot-05':28,
  'shop-01':18,
  'shop-02':22,
  'shop-03':15,
  'shop-04':26,
  'shop-05':32,
  'shop-06':30
};
const MP_SIZES  = { S:0.8, M:1, L:1.35 };
const MP_MAT_UP = { 'PLA':0, 'PETG':2, 'TPU':3, 'Resin':4, 'PA-CF':6 };
const SHIP = {
  pickup:  { label: 'Pickup at deployment', amount: 0 },
  dropoff: { label: 'Local LA drop-off',    amount: 800 },
  ship:    { label: 'Shipping',             amount: 600 }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    // Health check: open https://marvelous3d.biz/api/checkout in a browser.
    // { ok:true, stripe_key_configured:true } means everything is wired.
    return res.status(200).json({
      ok: true,
      service: 'marvelous3d-checkout',
      stripe_key_configured: !!process.env.STRIPE_SECRET_KEY
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

  try {
    const {
      order_code = 'MRV', items = [], delivery = 'pickup',
      location = '', promo = '', name = '', email = ''
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'empty cart' });
    }

    const origin = (req.headers.origin && /^https?:\/\//.test(req.headers.origin))
      ? req.headers.origin
      : 'https://marvelous3d.biz';

    const p = new URLSearchParams();
    p.append('mode', 'payment');
    p.append('allow_promotion_codes', 'true'); // create a FULLSYNC promo code in Stripe to honor the 5%
    if (email) p.append('customer_email', String(email).slice(0, 120));

    const lineSummaries = [];
    let itemsTotal = 0;

    items.slice(0, 20).forEach((it, i) => {
      const isMp = it.kind === 'mp';
      const base = isMp ? MP_CATALOG[it.id] : CATALOG[it.id];
      if (base == null) throw new Error('unknown item: ' + it.id);
      const sizes = isMp ? MP_SIZES : SIZES;
      const mult = sizes[it.size] != null ? sizes[it.size] : 1;
      const extra = isMp
        ? (MP_MAT_UP[it.finish] || 0)
        : (it.finish === 'silk' ? SILK_UPCHARGE : 0);
      const unit = Math.round((base * mult + extra) * 100);
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 50);
      const label = String(it.name || it.id).slice(0, 80) +
        ' (' + (it.size || 'M') + ' · ' + (it.finish || 'matte') + ')';
      const desc = 'color ' + String(it.color || '—').slice(0, 20) +
        (it.text ? ' · text: ' + String(it.text).slice(0, 20) : '');
      itemsTotal += unit * qty;
      lineSummaries.push(qty + '× ' + label + ' — ' + desc + ' — $' + (unit * qty / 100).toFixed(2));
      p.append(`line_items[${i}][quantity]`, String(qty));
      p.append(`line_items[${i}][price_data][currency]`, 'usd');
      p.append(`line_items[${i}][price_data][unit_amount]`, String(unit));
      p.append(`line_items[${i}][price_data][product_data][name]`, label);
      p.append(`line_items[${i}][price_data][product_data][description]`, desc);
    });

    const sh = SHIP[delivery] || SHIP.pickup;
    p.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    p.append('shipping_options[0][shipping_rate_data][display_name]', sh.label);
    p.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(sh.amount));
    p.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    if (delivery === 'ship') {
      p.append('shipping_address_collection[allowed_countries][0]', 'US');
    }

    // Pack the print specs into the success URL. When the customer lands back
    // on the site after paying, it emails these to dispatch marked PAID.
    const totalCents = itemsTotal + sh.amount;
    let dParam = '';
    try {
      const packed = Buffer.from(JSON.stringify({
        c: String(order_code).slice(0, 40),
        dl: sh.label + (location ? ' — ' + String(location).slice(0, 180) : ''),
        n: String(name || '').slice(0, 60),
        e: String(email || '').slice(0, 80),
        i: lineSummaries,
        t: totalCents
      })).toString('base64url');
      if (packed.length < 1800) dParam = '&d=' + packed;
    } catch (e) { /* summary too big — dashboard still has everything */ }
    p.append('success_url', origin + '/?checkout=success&order=' +
      encodeURIComponent(order_code) + dParam);
    p.append('cancel_url', origin + '/?checkout=cancelled');

    p.append('metadata[order_code]', String(order_code).slice(0, 40));
    p.append('metadata[delivery]', String(delivery).slice(0, 20));
    if (location) p.append('metadata[location]', String(location).slice(0, 450));
    if (promo) p.append('metadata[promo_claim]', String(promo).slice(0, 40));
    if (name) p.append('metadata[name]', String(name).slice(0, 80));

    const sr = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: p.toString()
    });
    const data = await sr.json();
    if (!sr.ok) {
      return res.status(502).json({ error: (data.error && data.error.message) || 'stripe error' });
    }
    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
