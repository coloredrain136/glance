// Glance — shares Joe's schedule with Nova (Irina's app) for the Together tab.
// Nova's server calls this with the shared key; a browser never does.
//
//   GET /api/share?from=YYYY-MM-DD&to=YYYY-MM-DD      (to is not included, 120 days max)
//   Header: x-share-key: <SHARE_KEY>                  (same value set in both apps)
//
//   200 { v:1, app:'glance', name, tz, known_through, items:[{ title, start, end, all_day, kind }] }
//     start/end: local wall time "YYYY-MM-DDTHH:MM" in tz, or "YYYY-MM-DD" for all-day (end not included)
//     kind: work / plan = busy (anything on the calendar is fixed; work also means a job shift)
//           note = a day note like payday, never busy
//     known_through: last date the schedule is filled in, or null if the whole range is
//   401 wrong key · 403 sharing turned off · 503 not set up
const G = require('./_lib/glance');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const shareKey = process.env.SHARE_KEY;
  if (!shareKey) return res.status(503).json({ error: 'not_configured', message: 'SHARE_KEY is not set in Glance.' });
  if (!G.safeEqual(req.headers['x-share-key'], shareKey)) return res.status(401).json({ error: 'bad_key' });

  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!DATE.test(from) || !DATE.test(to) || to <= from || to > addDays(from, 120)) return res.status(400).json({ error: 'bad_range' });

  const acct = G.loadAccount(), cals = G.calendarIds();
  if (!acct || !cals.length) return res.status(503).json({ error: 'not_configured', message: 'Glance can\'t read Google Calendar yet.' });

  try {
    let S = null;
    try { S = await G.readSettings(); } catch (e) { S = null; }
    S = S || {};
    if (S.share === false) return res.status(403).json({ error: 'sharing_off' });
    const types = Array.isArray(S.types) && S.types.length ? S.types : G.DEFAULT_TYPES;

    const token = await G.getToken(acct);
    const a = G.dayStartUTC(from).toISOString(), b = G.dayStartUTC(to).toISOString();
    const lists = await Promise.all(cals.map((c) => G.listEvents(token, c, a, b)));

    const items = [];
    let lastOneOff = '';
    for (const ev of lists.flat()) {
      const ty = G.typeOf(types, ev.title);
      // Everything on the calendar blocks its time. Day notes (paydays) don't.
      // Hidden colors still block, but go out as "Busy" so their titles stay private.
      const kind = ty && ty.show === 'note' ? 'note' : (G.tgOf(ty) === 'work' ? 'work' : 'plan');
      const start = ev.allDay ? ev.start : G.wall(ev.start);
      const end = ev.allDay ? ev.end : G.wall(ev.end);
      items.push({ title: ty && ty.show === 'hide' ? 'Busy' : ev.title, start, end, all_day: ev.allDay, kind });
      if (kind === 'work' && !ev.repeats) {
        const lastDay = ev.allDay ? addDays(end, -1) : (end.slice(11) === '00:00' ? addDays(end.slice(0, 10), -1) : end.slice(0, 10));
        if (lastDay > lastOneOff) lastOneOff = lastDay;
      }
    }
    items.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));

    // How far ahead the schedule is filled in. Repeating events (a weekly 8:30–5) go on forever,
    // so "Auto" uses the last one-off work shift (Home Depot shifts get posted a few weeks out).
    const known = S.tgKnown === 'all' || !lastOneOff ? null : (lastOneOff < addDays(to, -1) ? lastOneOff : null);

    res.status(200).json({ v: 1, app: 'glance', name: (S.myName || 'Joe').slice(0, 30), tz: G.TZ, known_through: known, items });
  } catch (e) {
    res.status(502).json({ error: 'google', message: G.googleError(e, acct) });
  }
};
