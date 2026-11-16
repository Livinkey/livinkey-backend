# Bigtos setup – WhatsApp → SMS → Email

Every OTP, bill, fine, reminder, notice, inbox reply and forwarded maintenance request goes through
`src/services/messaging.service.js`:

1. **WhatsApp** (Bigtos `POST /api/v1/sendmessage`) – first choice.
2. **SMS** – only if you set `BIGTOS_SMS_ENDPOINT` (Bigtos' WhatsApp docs have no SMS endpoint; point it at your Bigtos SMS API, which must accept the same fields: `key`, `mobileno`, `msg`, `type=Text`). Otherwise this step is skipped.
3. **Email** – used when the channels above fail (only for messages to Livinkey users who have an email).

**Fallback behaviour:** Bigtos has no delivery-receipt webhook, so the chain falls back only when Bigtos rejects the
request (invalid key, no credit, bad number, bad template …). A message Bigtos accepts is recorded as *sent*; if WhatsApp
later cannot deliver it (person not on WhatsApp, 24-hour window closed) the system cannot know.

## 1. `.env`
```
BIGTOS_API_KEY=your-key
BIGTOS_WEBHOOK_SECRET=long-random-string        # protects the incoming-message webhook
PUBLIC_API_URL=https://api.livinkey.com
DEFAULT_COUNTRY_CODE=91                         # for numbers saved without a country code
MESSAGING_CHANNELS=whatsapp,sms,email           # remove one to switch it off, order = fallback order
```
Open **Admin → Overview → Integrations**: WhatsApp shows *configured* once `BIGTOS_API_KEY` is set (SMS needs `BIGTOS_SMS_ENDPOINT` too).

## 2. Incoming messages (replies from tenants)
In the Bigtos panel set the incoming-message webhook URL to:

`https://api.livinkey.com/api/webhooks/bigtos/whatsapp?token=<BIGTOS_WEBHOOK_SECRET>`

Bigtos does not sign requests, so the secret in the URL is the authentication. Requests without the right token get 403.
The handler reads `body`, `from`, `to` and the JSON `data` blob described in the Bigtos docs, ignores our own echoed
messages and group chats, and never stores the same message twice.

## 3. WhatsApp templates (needed to message people who haven't written to you in the last 24 hours)
Create and get approved the templates in Bigtos/Meta, then put each **template name** in `.env`
(the request is sent as `type=Template` with `{"name":…,"language":{"code":BIGTOS_TEMPLATE_LANGUAGE},"components":[{"type":"body","parameters":[…]}]}`).
Variables are passed in order `{{1}}, {{2}}, …`.

| .env key | Variables | Suggested body |
|---|---|---|
| `BIGTOS_OTP_TEMPLATE` | `{{1}}` = code | Authentication template (`{{2}}` = purpose only if `BIGTOS_OTP_PURPOSE_VAR=true`) |
| `BIGTOS_BILL_TEMPLATE` | 1 name, 2 amount, 3 due date, 4 bill ref | `Hi {{1}}, your Livinkey bill of {{2}} is due on {{3}} (ref {{4}}). Open the Livinkey app to pay.` |
| `BIGTOS_FINE_TEMPLATE` | 1 name, 2 amount, 3 reason | `Hi {{1}}, a fine of {{2}} was added to your account: {{3}}. Open the Livinkey app for details.` |
| `BIGTOS_EFRRO_TEMPLATE` | 1 name, 2 days | `Hi {{1}}, your e-FRRO registration needs attention: {{2}}.` |
| `BIGTOS_CUSTOM_TEMPLATE` | 1 title, 2 message | `{{1}}: {{2}} — Livinkey` |
| `BIGTOS_MAINTENANCE_TEMPLATE` | 1 name, 2 request, 3 location, 4 details | `Hello {{1}}, maintenance request {{2}} at {{3}}. {{4}} — forwarded from Livinkey.` |

Without a template name the free-form text is sent (type `Text`), which WhatsApp only delivers inside the 24-hour window.
The template `language.code` must match the language the template was approved in (`BIGTOS_TEMPLATE_LANGUAGE`, default `en`; your Bigtos sample uses `hindi`).

## 4. What the admin sees
* **Conversations**: every message with its status and channel, plus the reason when nothing could be delivered.
* **Maintenance → forward icon**: type any number (+country code), optional name/note, send. The server sends the details by WhatsApp and logs it (`maintenance_forwards`).
* Inbound attachments are fetched through a server-side proxy limited to `*.bigtos.com`, `*.whatsapp.net`, `*.whatsapp.com` and `BIGTOS_MEDIA_HOSTS`.

## 5. Security notes
* OTPs are never stored in plain text: the inbox shows "Verification code sent".
* Keep `BIGTOS_API_KEY` only in `.env` (never in the app or admin frontend).
