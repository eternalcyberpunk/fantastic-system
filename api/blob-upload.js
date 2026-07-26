// api/blob-upload.js — large-file uplink for Marvelous 3D Printing
//
// Issues short-lived client tokens so the BROWSER uploads straight to Vercel
// Blob. This bypasses the ~4.5 MB request body limit that applies to Vercel
// Functions, and with multipart enabled the SDK chunks the file, uploads parts
// in parallel, and retries failed parts — good for files up to 1 GB and beyond.
//
// The old /api/upload route still exists and still works; it stays as the
// fallback path for small files if this route or the CDN-loaded SDK is
// unavailable. Nothing that worked before stops working.
//
// Setup:
//   1. Commit this file at /api/blob-upload.js (package.json already declares
//      the @vercel/blob dependency).
//   2. Your Blob store must be connected to the project. Client tokens are
//      generated from BLOB_READ_WRITE_TOKEN specifically — OIDC alone is not
//      enough here. If Storage shows only OIDC vars, add the store's
//      BLOB_READ_WRITE_TOKEN under Settings → Environment Variables.
//   3. Redeploy, then open /api/blob-upload in a browser: you want
//      { ok:true, client_uploads_ready:true }.
//
// Cost note: uploads via client uploads don't incur data transfer charges, but
// stored bytes and downloads do, and blobs over 512 MB miss the CDN cache on
// every read. Sweep old customer files periodically in the Blob dashboard.

const { handleUpload } = require('@vercel/blob/client');

// Keep in sync with MAX_UPLOAD in index.html.
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const ALLOWED = [
  'model/stl', 'application/sla', 'application/vnd.ms-pki.stl',
  'model/obj', 'model/3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  'application/step', 'application/STEP', 'model/step',
  'application/zip', 'application/x-zip-compressed', 'application/gzip',
  'application/octet-stream',
  'image/png', 'image/jpeg', 'image/webp', 'application/pdf'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'marvelous3d-blob-upload',
      client_uploads_ready: !!process.env.BLOB_READ_WRITE_TOKEN,
      max_bytes: MAX_BYTES,
      max_label: '1 GB'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN missing — client uploads need the static store token, not just OIDC'
    });
  }

  try {
    // Vercel Functions may hand us the body already parsed, or as a raw stream.
    let body = req.body;
    if (!body || typeof body === 'string') {
      if (typeof body === 'string' && body.length) {
        body = JSON.parse(body);
      } else {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
    }

    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname) => {
        // Confine every upload to one prefix and cap the size. This is the
        // authorization gate — without it, anyone could write to the store.
        const safe = String(pathname || '').replace(/[^\w.\-\/]+/g, '_');
        if (!safe.startsWith('marvelous-uploads/')) {
          throw new Error('pathname outside the uploads prefix');
        }
        return {
          allowedContentTypes: ALLOWED,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ at: Date.now() })
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Fires server-to-server once the browser finishes. Handy hook if you
        // later want to log uploads or notify dispatch independently.
        console.log('blob stored:', blob.pathname, blob.url);
      }
    });

    return res.status(200).json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'client token error' });
  }
};

// Let the raw body through; handleUpload needs the original JSON.
module.exports.config = { api: { bodyParser: false } };
