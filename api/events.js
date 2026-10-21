// Glance — calendar proxy. Checks the passcode, then reads Google Calendar
// with a read-only service account. Google credentials never reach the browser.
const G = require('./_lib/glance');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pass = process.env.GLANCE_PASSCODE;
  const acct = G.loadAccount();
  const cals = G.calendarIds();

  if (!pass) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GLANCE_PASSCODE is missing. Add it in Vercel, then Redeploy.' });
  if (!G.safeEqual(req.headers['x-glance-key'], pass)) return res.status(401).json({ error: 'bad_passcode' });
  if (!acct) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GOOGLE_SERVICE_ACCOUNT_JSON is missing or is not the full JSON key file. Fix it in Vercel, then Redeploy.' });
  if (!cals.length) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GOOGLE_CALENDAR_ID is missing. Add it in Vercel, then Redeploy.' });

  const from = new Date(req.query.from || ''), to = new Date(req.query.to || '');
  if (isNaN(from) || isNaN(to) || to <= from || to - from > 200 * 864e5) {
    return res.status(400).json({ error: 'bad_range' });
  }

  try {
    const token = await G.getToken(acct);
    const lists = await Promise.all(cals.map((c) => G.listEvents(token, c, from.toISOString(), to.toISOString())));
    res.status(200).json({ events: lists.flat(), fetchedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: 'google', message: G.googleError(e, acct) });
  }
};
