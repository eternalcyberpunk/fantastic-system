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

const CATALOG = { dragon:16, axolotl:14, keytag:8, planter:12, dock:15, throne:18 };
const SIZES   = { S:0.75, M:1, L:1.4 };
const SILK_UPCHARGE = 2; // dollars
const SHIP = {
  pickup:  { label: 'Pickup at deployment', amount: 0 },
  dropoff: { label: 'Local LA drop-off',    amount: 800 },
  ship:    { label: 'Shipping',             amount: 600 }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
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
    p.append('success_url', origin + '/?checkout=success&order=' + encodeURIComponent(order_code));
    p.append('cancel_url', origin + '/?checkout=cancelled');
    p.append('allow_promotion_codes', 'true'); // create a FULLSYNC promo code in Stripe to honor the 5%
    if (email) p.append('customer_email', String(email).slice(0, 120));

    items.slice(0, 20).forEach((it, i) => {
      const base = CATALOG[it.id];
      if (base == null) throw new Error('unknown item: ' + it.id);
      const mult = SIZES[it.size] != null ? SIZES[it.size] : 1;
      const unit = Math.round((base * mult + (it.finish === 'silk' ? SILK_UPCHARGE : 0)) * 100);
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 50);
      const label = String(it.name || it.id).slice(0, 80) +
        ' (' + (it.size || 'M') + ' · ' + (it.finish || 'matte') + ')';
      const desc = 'color ' + String(it.color || '—').slice(0, 20) +
        (it.text ? ' · text: ' + String(it.text).slice(0, 20) : '');
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
