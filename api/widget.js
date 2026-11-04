// Glance — widget feed (glance-8). Read-only. Pocket's Scriptable widgets call this.
//
//   GET /api/widget                       header x-glance-widget-key: <GLANCE_WIDGET_KEY>  (or ?key=)
//
//   200 { v:1, app:'glance', version, tz, generated_at, today,
//         appearance:{ mode:'auto'|'dark'|'light', accent, h24 }, window:{ start, end },
//         days:[ 7 days starting today: { date, weekday, day, month, is_today,
//                free_ms, free_text, none_text,
//                events:[{ title, color, when, start_label, s, e, next, past }],   timed, in time order
//                all_day:[{ title, color }], notes:[{ title, color }],              notes = day notes (Payday)
//                timeline:[ {kind:'event', ...event} | {kind:'free', text, a, b, live, past} ] } ],
//         next_payday:{ date, title, in_days } | null }
//   401 wrong key · 503 not set up · 502 Google problem
//
// Same rules as the app: colors from Event Colors (first match from the top), Hidden left out,
// Day Notes don't count as events, free time = gaps of 30m+ inside the Free Time window, and
// only counted on days that have something timed (same as the Week screen's rail).
const G = require('./_lib/glance');

const VERSION = 'glance-8';
const MIN = 60000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hm(ms) { const w = G.wall(new Date(ms).toISOString()); return [+w.slice(11, 13), +w.slice(14, 16)]; }
function fS(ms, ap, h24) { // "5p", "8:30a", or "17:00"
  const [h, m] = hm(ms);
  if (h24) return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (ap ? (h < 12 ? 'a' : 'p') : '');
}
function fSRange(a, b, h24) {
  const sameAp = h24 || ((hm(a)[0] < 12) === (hm(b)[0] < 12));
  return fS(a, !sameAp, h24) + ' – ' + fS(b, true, h24);
}
function fDur(ms) { let m = Math.round(ms / MIN); const h = Math.floor(m / 60); m %= 60; return h ? (h + 'h' + (m ? ' ' + m + 'm' : '')) : (m + 'm'); }

// One day, the same way the app's plan() + evCards() do it.
function planDay(date, today, events, S, now) {
  const a = G.dayStartUTC(date).getTime(), b = G.dayStartUTC(G.addDays(date, 1)).getTime();
  const next = G.addDays(date, 1);
  const timed = [], all = [], notes = [];
  for (const e of events) {
    const hit = e.allDay ? (e.start < next && e.end > date) : (e.s < b && (e.e > a || (e.s === e.e && e.s >= a)));
    if (!hit) continue;
    if (e.show === 'hide') continue;
    if (e.show === 'note') { notes.push({ title: e.title, color: e.color }); continue; }
    if (e.allDay || (e.s <= a && e.e >= b)) all.push({ title: e.title, color: e.color }); else timed.push(e);
  }
  timed.sort((x, y) => x.s - y.s || x.e - y.e);

  const isToday = date === today;
  const w0 = G.localInstant(date, S.winStart).getTime();
  const w1 = S.winEnd >= 24 ? b : G.localInstant(date, S.winEnd).getTime();
  const timeline = [];
  let cur = w0, freeMs = 0;
  function gap(x, y) {
    if (y - x < 30 * MIN) return;
    const past = isToday && y <= now, live = isToday && x <= now && y > now;
    if (live) x = Math.max(x, Math.floor(now / (5 * MIN)) * 5 * MIN);
    if (!past) freeMs += y - x;
    timeline.push({ kind: 'free', text: live ? 'Free Now, Until ' + fS(y, true, S.h24) : 'Free ' + fSRange(x, y, S.h24), a: x, b: y, live, past });
  }
  let nextDone = false;
  const out = [];
  for (const e of timed) {
    const x = Math.max(e.s, w0), y = Math.min(e.e, w1);
    if (x > cur && x <= w1) gap(cur, x);
    const when = e.s < a ? 'until ' + fS(e.e, true, S.h24)
      : e.e > b ? 'from ' + fS(e.s, true, S.h24)
        : e.s === e.e ? fS(e.s, true, S.h24) : fSRange(e.s, e.e, S.h24);
    const ev = {
      title: e.title, color: e.color, when,
      start_label: e.s < a ? 'Until ' + fS(e.e, true, S.h24) : fS(e.s, true, S.h24),
      s: e.s, e: e.e, past: isToday && e.e <= now, next: false
    };
    if (isToday && !nextDone && e.e > now) { ev.next = true; nextDone = true; }
    out.push(ev);
    timeline.push(Object.assign({ kind: 'event' }, ev));
    if (y > cur) cur = y;
  }
  if (timed.length) gap(Math.max(cur, w0), w1);

  const d = new Date(date + 'T12:00:00Z');
  return {
    date, weekday: WD[d.getUTCDay()], day: d.getUTCDate(), month: MO[d.getUTCMonth()], is_today: isToday,
    free_ms: freeMs,
    free_text: timed.length ? (freeMs ? fDur(freeMs) + ' Free' : 'Full') : '',
    none_text: timed.length ? '' : (all.length ? 'Nothing Timed' : 'Free All Day'),
    events: out, all_day: all, notes, timeline
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const wkey = process.env.GLANCE_WIDGET_KEY;
  if (!wkey) return res.status(503).json({ error: 'not_configured', message: 'GLANCE_WIDGET_KEY is not set in Glance. Add it in Vercel, then Redeploy.' });
  if (!G.safeEqual(req.headers['x-glance-widget-key'] || req.query.key, wkey)) return res.status(401).json({ error: 'bad_key' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const acct = G.loadAccount(), cals = G.calendarIds();
  if (!acct || !cals.length) return res.status(503).json({ error: 'not_configured', message: 'Glance can\'t read Google Calendar yet.' });

  try {
    let saved = null;
    try { saved = await G.readSettings(); } catch (e) { saved = null; }
    saved = saved || {};
    const S = {
      mode: ['auto', 'dark', 'light'].includes(saved.mode) ? saved.mode : 'auto',
      accent: saved.accent || '#5b8cff',
      h24: !!saved.h24,
      winStart: Number.isFinite(saved.winStart) ? saved.winStart : 7,
      winEnd: Number.isFinite(saved.winEnd) ? saved.winEnd : 23
    };
    const types = Array.isArray(saved.types) && saved.types.length ? saved.types : G.DEFAULT_TYPES;

    const now = Date.now();
    const today = G.wall(new Date(now).toISOString()).slice(0, 10);
    const ahead = 35; // 7 days shown, plus a month to find the next payday
    const token = await G.getToken(acct);
    const from = G.dayStartUTC(today).toISOString(), to = G.dayStartUTC(G.addDays(today, ahead)).toISOString();
    const lists = await Promise.all(cals.map((c) => G.listEvents(token, c, from, to)));

    const events = lists.flat().map((ev) => {
      const ty = G.typeOf(types, ev.title);
      return {
        title: ev.title, allDay: ev.allDay, start: ev.start, end: ev.end,
        s: ev.allDay ? G.dayStartUTC(ev.start).getTime() : Date.parse(ev.start),
        e: ev.allDay ? G.dayStartUTC(ev.end).getTime() : Date.parse(ev.end),
        show: ty ? (ty.show === 'note' ? 'note' : ty.show === 'hide' ? 'hide' : 'card') : 'card',
        color: (ty && ty.color) || G.GCOL[ev.colorId] || S.accent,
        payday: !!(ty && ty.show === 'note' && /pay/i.test((ty.name || '') + ' ' + (ty.words || []).join(' ')))
      };
    }).map((e) => { if (!(e.e >= e.s)) e.e = e.s; return e; });

    const days = [];
    for (let i = 0; i < 7; i++) days.push(planDay(G.addDays(today, i), today, events, S, now));

    // Next payday: the first Payday day note from today on.
    let nextPay = null;
    for (const e of events.filter((x) => x.payday).sort((x, y) => x.s - y.s)) {
      const d = e.allDay ? e.start : G.wall(new Date(e.s).toISOString()).slice(0, 10);
      const last = e.allDay ? G.addDays(e.end, -1) : d;
      if (last < today) continue;
      const date = d < today ? today : d;
      const inDays = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
      nextPay = { date, title: e.title, in_days: inDays };
      break;
    }

    res.status(200).json({
      v: 1, app: 'glance', version: VERSION, tz: G.TZ, generated_at: new Date(now).toISOString(), today,
      appearance: { mode: S.mode, accent: S.accent, h24: S.h24 },
      window: { start: S.winStart, end: S.winEnd },
      days, next_payday: nextPay
    });
  } catch (e) {
    res.status(502).json({ error: 'google', message: G.googleError(e, acct) });
  }
};
