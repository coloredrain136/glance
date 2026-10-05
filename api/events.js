// Glance — calendar proxy. Checks the passcode, then reads Google Calendar
// with a read-only service account. Google credentials never reach the browser.
const crypto = require('crypto');

let tokenCache = { token: null, exp: 0 };

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function loadAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.trim());
    if (!j.client_email || !j.private_key) return null;
    j.private_key = j.private_key.replace(/\\n/g, '\n');
    return j;
  } catch (e) { return null; }
}

const b64url = (v) => Buffer.from(v).toString('base64url');

async function getToken(acct) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: acct.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(acct.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: head + '.' + body + '.' + sig
    })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Google sign-in failed: ' + (j.error_description || j.error || r.status));
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

async function listEvents(token, calId, from, to) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({
      singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
      timeMin: from, timeMax: to,
      fields: 'nextPageToken,summary,items(id,status,summary,description,location,colorId,start,end,htmlLink)'
    });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) + '/events?' + q,
      { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (!r.ok) {
      const e = new Error((j.error && j.error.message) || ('Google error ' + r.status));
      e.status = r.status; throw e;
    }
    for (const ev of j.items || []) {
      if (ev.status === 'cancelled' || !ev.start) continue;
      const allDay = !!ev.start.date;
      out.push({
        id: calId + ':' + ev.id,
        title: ev.summary || '(No title)',
        start: allDay ? ev.start.date : ev.start.dateTime,
        end: allDay ? ev.end.date : ev.end.dateTime,
        allDay,
        location: ev.location || '',
        notes: ev.description || '',
        colorId: ev.colorId || '',
        calendar: j.summary || ''
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const pass = process.env.GLANCE_PASSCODE;
  const acct = loadAccount();
  const cals = (process.env.GOOGLE_CALENDAR_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!pass) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GLANCE_PASSCODE is missing. Add it in Vercel, then Redeploy.' });
  if (!safeEqual(req.headers['x-glance-key'], pass)) return res.status(401).json({ error: 'bad_passcode' });
  if (!acct) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GOOGLE_SERVICE_ACCOUNT_JSON is missing or is not the full JSON key file. Fix it in Vercel, then Redeploy.' });
  if (!cals.length) return res.status(503).json({ error: 'not_configured', message: 'Server not configured: GOOGLE_CALENDAR_ID is missing. Add it in Vercel, then Redeploy.' });

  const from = new Date(req.query.from || ''), to = new Date(req.query.to || '');
  if (isNaN(from) || isNaN(to) || to <= from || to - from > 200 * 864e5) {
    return res.status(400).json({ error: 'bad_range' });
  }

  try {
    const token = await getToken(acct);
    const lists = await Promise.all(cals.map((c) => listEvents(token, c, from.toISOString(), to.toISOString())));
    res.status(200).json({ events: lists.flat(), fetchedAt: new Date().toISOString() });
  } catch (e) {
    const msg = e.status === 404
      ? 'Google can\'t find that calendar. Share it with ' + acct.client_email + ' ("See all event details") and check GOOGLE_CALENDAR_ID.'
      : e.status === 403
        ? 'Google refused access. Check that the Google Calendar API is enabled in the Google Cloud project. (' + e.message + ')'
        : e.message;
    res.status(502).json({ error: 'google', message: msg });
  }
};
