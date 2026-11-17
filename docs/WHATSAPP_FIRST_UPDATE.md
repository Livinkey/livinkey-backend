# WhatsApp-first messaging update

**Delivery rule everywhere:** WhatsApp -> (SMS, only if BIGTOS_SMS_ENDPOINT is set) -> e-mail.
The dedicated e-mail (bill with QR codes, credentials, etc.) is sent ONLY when WhatsApp could not take the message. Once WhatsApp accepts a message nothing else is sent.

## What changed
- Converted every "WhatsApp + e-mail both" / "e-mail only" site: new bill, group bill, custom bill message, payment link, late fee, fee adjustment, cash-payment OTP, tenant/admin/guest welcome (credentials), guest messages, admin notices (Notifications page + Activity page), e-FRRO tenant + admin, document / payment reminders, maintenance.
- Login with **phone or e-mail + password** (admin web, tenant app, guest app) and for forgot-password / OTP steps (`src/utils/identifier.js`). Admin OTP goes to WhatsApp.
- Every tenant message starts with Name / PG / Room.
- Admin-sent messages end with a weak `(Sent from system · Livinkey admin)` line. In the admin Inbox, OTP / time-limited messages flip to **Expired** once their time passes.
- Smart links: `https://<api>/l/<code>` (expire after LINK_TTL_HOURS). WhatsApp-clickable; open the app screen, the Play Store, or a UPI pay page. Links never log anyone in.
- Maintenance: new / completed requests alert every authorized admin (super admins + admins with maintenance "view") on WhatsApp, e-mail fallback; tenants are told on status change. Forward-to-number records Bigtos' reply (see server log lines `[messaging] WhatsApp accepted ...`), ignores double clicks, and the modal offers "Open in WhatsApp" if sending fails.
- **Duplicate fix:** reminder cron now claims each request atomically before sending and takes a MySQL lock, so the same "Is your maintenance..." can't go out several times; every message also passes a database-level duplicate guard (works across multiple server processes). Reminders retry hourly only if nothing could be delivered.
- New tables are created automatically at start-up: `message_dedup`, `short_links`; new column `maintenance_requests.completion_reminder_at`.

## Things to check after deploying
1. `BIGTOS_API_KEY` (and `BIGTOS_WEBHOOK_SECRET`) are blank in the supplied .env - set the real ones on the server.
2. Bigtos gives no "number is not on WhatsApp" signal unless its API returns an error; such numbers only fall back to e-mail when Bigtos reports a failure.
