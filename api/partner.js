// Glance — reads Irina's schedule from Nova for the Together tab.
// The browser asks here with the Glance passcode; this function asks Nova with the shared key,
// so the key never reaches a phone.
//
//   GET /api/partner?from=YYYY-MM-DD&to=YYYY-MM-DD
//   200 { ok:true, data:<Nova's /api/share answer>, fetchedAt }
//   200 { ok:false, state, message }   state: not_setup | key_mismatch | sharing_off | not_ready | unreachable | bad_answer
const G = require('./_lib/glance');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const no = (res, state, message) => res.status(200).json({ ok: false, state, message });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pass = process.env.GLANCE_PASSCODE;
  if (!pass) return res.status(503).json({ error: 'not_configured' });
  if (!G.safeEqual(req.headers['x-glance-key'], pass)) return res.status(401).json({ error: 'bad_passcode' });

  const base = (process.env.PARTNER_URL || '').trim().replace(/\/+$/, '');
  const key = process.env.SHARE_KEY;
  if (!base || !key) return no(res, 'not_setup', 'Add PARTNER_URL and SHARE_KEY in Vercel, then Redeploy.');
  if (!/^https:\/\//.test(base)) return no(res, 'not_setup', 'PARTNER_URL has to start with https://');

  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!DATE.test(from) || !DATE.test(to) || to <= from) return res.status(400).json({ error: 'bad_range' });

  let r;
  try {
    r = await fetch(base + '/api/share?from=' + from + '&to=' + to, {
      headers: { 'x-share-key': key },
      signal: AbortSignal.timeout(9000)
    });
  } catch (e) {
    return no(res, 'unreachable', 'Couldn\'t reach Nova at ' + base + '.');
  }
  if (r.status === 401) return no(res, 'key_mismatch', 'Nova turned down the shared key. SHARE_KEY has to be exactly the same in both apps.');
  if (r.status === 403) return no(res, 'sharing_off', 'Sharing is turned off in Nova.');
  if (r.status === 404 || r.status === 405) return no(res, 'not_ready', 'Nova doesn\'t have the Together update yet.');
  if (r.status === 503) return no(res, 'not_ready', 'Nova\'s SHARE_KEY isn\'t set yet.');
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !Array.isArray(j.items)) return no(res, r.ok ? 'bad_answer' : 'unreachable', 'Nova answered with an error (' + r.status + ').');

  res.status(200).json({ ok: true, data: j, fetchedAt: new Date().toISOString() });
};
