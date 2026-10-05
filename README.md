# Glance

Read-only display for one Google Calendar. Google Calendar stays the source of truth.

## Files
| File | What it is |
|---|---|
| `index.html` | The whole app (CSS + JS inline, no build step) |
| `api/events.js` | Vercel function. Checks the passcode, then reads Google Calendar with a read-only service account |
| `api/settings.js` | Vercel function. Checks the passcode, then reads/writes settings in Supabase |
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

**Env var changes need a manual Redeploy in Vercel.**

## How Google access works
A service account is a robot Google account with its own email address. The calendar is
shared with that address as "See all event details", so it can read and nothing else.
There's no sign-in screen and nothing expires.
