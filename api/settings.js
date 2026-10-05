// Glance — settings sync. Checks the passcode, then reads/writes one row in
// Supabase (glance_settings). The Supabase secret key never reaches the browser.
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pass = process.env.GLANCE_PASSCODE;
  if (!pass) return res.status(503).json({ error: 'not_configured' });
  if (!safeEqual(req.headers['x-glance-key'], pass)) return res.status(401).json({ error: 'bad_passcode' });

  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  // No Supabase yet: the app still works, settings just stay on each device.
  if (!url || !key) return res.status(200).json({ synced: false, settings: null });

  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key; // legacy service_role key
  const base = url + '/rest/v1/glance_settings';

  try {
    if (req.method === 'GET') {
      const r = await fetch(base + '?key=eq.main&select=value', { headers });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || ('Supabase error ' + r.status));
      return res.status(200).json({ synced: true, settings: j[0] ? j[0].value : null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!value || typeof value !== 'object') return res.status(400).json({ error: 'bad_body' });
      const r = await fetch(base + '?on_conflict=key', {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'main', value, updated_at: new Date().toISOString() })
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || ('Supabase error ' + r.status)); }
      return res.status(200).json({ synced: true });
    }
    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(502).json({ error: 'supabase', message: e.message });
  }
};
