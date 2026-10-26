// Glance — shared server helpers. Files under api/_lib are not routes; Vercel bundles them
// into the functions that require them.
const crypto = require('crypto');

const TZ = process.env.TIMEZONE || 'America/Detroit';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- Google (read-only service account) ---------- */
let tokenCache = { token: null, exp: 0 };

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

function calendarIds() {
  return (process.env.GOOGLE_CALENDAR_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
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
      fields: 'nextPageToken,summary,items(id,status,summary,description,location,colorId,start,end,htmlLink,recurringEventId)'
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
        calendar: j.summary || '',
        repeats: !!ev.recurringEventId
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function googleError(e, acct) {
  return e.status === 404
    ? 'Google can\'t find that calendar. Share it with ' + acct.client_email + ' ("See all event details") and check GOOGLE_CALENDAR_ID.'
    : e.status === 403
      ? 'Google refused access. Check that the Google Calendar API is enabled in the Google Cloud project. (' + e.message + ')'
      : e.message;
}

/* ---------- Supabase settings ---------- */
function supabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key; // legacy service_role key
  return { base: url + '/rest/v1/glance_settings', headers };
}

async function readSettings() {
  const sb = supabase();
  if (!sb) return null;
  const r = await fetch(sb.base + '?key=eq.main&select=value', { headers: sb.headers });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || ('Supabase error ' + r.status));
  return j[0] ? j[0].value : null;
}

/* ---------- Event colors → what an event means for planning together ----------
   Same matching as the app (index.html typeOf): first color from the top whose words fit. */
const DEFAULT_TYPES = [
  { name: 'Payday', words: ['Paycheck', 'Payday'], show: 'note' },
  { name: 'INC work', words: ['Working', 'INC'], tg: 'work' },
  { name: 'Home Depot', words: ['Home Depot', 'HD'], tg: 'work' },
  { name: 'Workout', words: ['Gym', 'Workout', 'Bike', 'Planet Fitness'], tg: 'plan' },
  { name: 'Pickleball', words: ['Pickleball'], tg: 'plan' }
];

function typeOf(types, title) {
  const t = String(title || '').toLowerCase();
  for (const ty of types) {
    for (const raw of ty.words || []) {
      const w = String(raw).trim().toLowerCase();
      if (!w) continue;
      if (w.length <= 3) {
        if (new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t)) return ty;
      } else if (t.indexOf(w) > -1) return ty;
    }
  }
  return null;
}

// Is this color a job? Used to label shifts "work" (for the night-shift rule and the
// schedule-is-known check). Older saved colors have no "tg": guess from the name.
function tgOf(ty) {
  if (!ty) return 'plan';
  if (ty.show === 'note') return 'note';
  if (ty.tg === 'work') return 'work';
  if (ty.tg) return 'plan';
  return /work|depot|shift|job/i.test(ty.name || '') ? 'work' : 'plan';
}

/* ---------- Local wall time in TZ ("2026-10-22T08:30") ---------- */
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function wall(iso) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(iso))) p[x.type] = x.value;
  return p.year + '-' + p.month + '-' + p.day + 'T' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
}

// Start of a local calendar day in TZ, as an instant. Tries both possible offsets around DST.
function dayStartUTC(dateStr) {
  for (const off of [4, 5, 6, 7, 8, 3, 2, 1, 0, 9, 10]) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCHours(d.getUTCHours() + off);
    if (wall(d.toISOString()) === dateStr + 'T00:00') return d;
  }
  return new Date(dateStr + 'T05:00:00Z');
}

module.exports = {
  TZ, safeEqual, loadAccount, calendarIds, getToken, listEvents, googleError,
  supabase, readSettings, DEFAULT_TYPES, typeOf, tgOf, wall, dayStartUTC
};
