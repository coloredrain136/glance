# Glance

Read-only display for one Google Calendar. Google Calendar stays the source of truth.

## Files
| File | What it is |
|---|---|
| `index.html` | The whole app (CSS + JS inline, no build step) |
| `api/events.js` | Vercel function. Checks the passcode, then reads Google Calendar with a read-only service account |
| `api/settings.js` | Vercel function. Checks the passcode, then reads/writes settings in Supabase |
| `api/share.js` | Vercel function. Gives Nova Joe's schedule for the Together tab (needs the shared key) |
| `api/partner.js` | Vercel function. Reads Irina's schedule from Nova for the Together tab |
| `api/_lib/glance.js` | Shared helpers for the functions (not a route) |
| `supabase/schema.sql` | Run once in the Supabase SQL editor (Loop's project). Creates `glance_settings` |
| `manifest.webmanifest`, icons | Home-screen app setup |
| `vercel.json` | Cache headers so updates show up right away |

## Env vars (Vercel → Settings → Environment Variables)
| Name | Value |
|---|---|
| `GLANCE_PASSCODE` | Anything you want. Typed once per device |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The entire contents of the service account's JSON key file |
| `GOOGLE_CALENDAR_ID` | The calendar's ID (Google Calendar → calendar settings → Integrate calendar). Several IDs can be separated by commas |
| `SUPABASE_URL` | Optional. Loop's project URL. Without it, settings stay on each device |
| `SUPABASE_SECRET_KEY` | Optional. Loop's secret key (`sb_secret_…`, or the legacy `service_role` key) |
| `SHARE_KEY` | Together tab. A long random secret, exactly the same in Glance and Nova |
| `PARTNER_URL` | Together tab. Nova's web address, e.g. `https://nova-xxxx.vercel.app` |
| `TIMEZONE` | Optional. Defaults to `America/Detroit` |

**Env var changes need a manual Redeploy in Vercel.**

## How Google access works
A service account is a robot Google account with its own email address. The calendar is
shared with that address as "See all event details", so it can read and nothing else.
There's no sign-in screen and nothing expires.

## Together tab
Glance and Nova each expose `GET /api/share?from=YYYY-MM-DD&to=YYYY-MM-DD` (header `x-share-key`), and each
reads the other through its own `/api/partner`. The free-time math lives between `TOGETHER-CORE-START` and
`TOGETHER-CORE-END` in `index.html`, and Nova uses the same block word for word.
