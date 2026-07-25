// api/upload.js — Marvelous 3D Printing file uplink
// Receives a customer's model file and stores it in Vercel Blob storage,
// returning a public download URL that gets embedded in the dispatch email.
// Zero npm dependencies (talks to the Blob REST API directly).
//
// Setup (one time):
//   1. Vercel dashboard → your project → Storage tab → Create → Blob →
//      connect it to this project. Vercel automatically adds the
//      BLOB_READ_WRITE_TOKEN environment variable.
//   2. Redeploy. Test by opening https://marvelous3d.biz/api/upload —
//      you should see { ok:true, blob_configured:true }.
//
// Notes:
//   • Per-request body limit on Vercel functions is ~4.5 MB. The site
//     compresses files client-side and routes anything bigger to the
//     "paste a Drive/Dropbox link" field instead.
//   • Uploaded blobs are public-by-URL with a random suffix (unguessable).
//     Clean old files occasionally in the Vercel Blob dashboard.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'marvelous3d-upload',
      blob_configured: !!process.env.BLOB_READ_WRITE_TOKEN
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured — create a Blob store in Vercel Storage and connect it to this project' });
  }

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
    if (buf.length > 4.6 * 1024 * 1024) return res.status(413).json({ error: 'file too large for this channel (4.5 MB cap) — use a share link' });

    const rawName = (req.query && req.query.name) ? String(req.query.name) : 'upload.bin';
    const safe = rawName.replace(/[^\w.\-]+/g, '_').slice(0, 90) || 'upload.bin';
    const pathname = 'marvelous-uploads/' + Date.now().toString(36) + '-' + safe;

    const r = await fetch('https://blob.vercel-storage.com/' + pathname, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'x-content-type': req.headers['content-type'] || 'application/octet-stream',
        'x-add-random-suffix': '1'
      },
      body: buf
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: (d && (d.error && d.error.message || d.message)) || ('blob store error ' + r.status) });
    }
    return res.status(200).json({ url: d.downloadUrl || d.url, pathname: d.pathname || pathname });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};

// Ensure the raw stream is available for binary bodies.
module.exports.config = { api: { bodyParser: false } };
