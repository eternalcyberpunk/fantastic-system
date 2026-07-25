// api/upload.js — Marvelous 3D Printing file uplink
// Stores a customer's model file in Vercel Blob and returns a download URL
// that gets embedded in the dispatch email.
//
// Uses the official @vercel/blob SDK so auth works with BOTH credential styles:
// classic BLOB_READ_WRITE_TOKEN env vars AND the newer OIDC-based auth that
// connected stores use by default.
//
// Setup (one time):
//   1. Commit this file at /api/upload.js AND package.json at the repo root
//      (it declares the @vercel/blob dependency — Vercel installs it on deploy).
//   2. Vercel dashboard → your project → Storage tab → Create → Blob →
//      Connect to project. Credentials are added automatically.
//   3. Push / redeploy. Test: open https://marvelous3d.biz/api/upload —
//      you want { ok:true, blob_configured:true }.
//
// Per-request body limit on Vercel functions is ~4.5 MB; the site compresses
// client-side and routes bigger files to the share-link field.
// Blobs accumulate — sweep old customer files in the Blob dashboard now and then.

const { put } = require('@vercel/blob');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const hasToken = !!process.env.BLOB_READ_WRITE_TOKEN;
  const hasOidc = !!process.env.VERCEL_OIDC_TOKEN;

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'marvelous3d-upload',
      auth_token: hasToken,
      auth_oidc: hasOidc,
      blob_configured: hasToken || hasOidc
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Raw body: cover both parsed-Buffer and unparsed-stream cases.
    let buf;
    if (req.body && Buffer.isBuffer(req.body)) {
      buf = req.body;
    } else if (req.body && typeof req.body === 'string') {
      buf = Buffer.from(req.body, 'binary');
    } else {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      buf = Buffer.concat(chunks);
    }
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty body' });
    if (buf.length > 4.6 * 1024 * 1024) {
      return res.status(413).json({ error: 'file too large for this channel (4.5 MB cap) — use a share link' });
    }

    const rawName = (req.query && req.query.name) ? String(req.query.name) : 'upload.bin';
    const safe = rawName.replace(/[^\w.\-]+/g, '_').slice(0, 90) || 'upload.bin';
    const pathname = 'marvelous-uploads/' + Date.now().toString(36) + '-' + safe;

    const blob = await put(pathname, buf, {
      access: 'public',
      addRandomSuffix: true,
      contentType: req.headers['content-type'] || 'application/octet-stream'
    });

    return res.status(200).json({
      url: blob.downloadUrl || blob.url,
      pathname: blob.pathname || pathname
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'blob store error' });
  }
};

// Keep the raw stream available for binary bodies.
module.exports.config = { api: { bodyParser: false } };
