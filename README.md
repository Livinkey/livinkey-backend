# Livinkey Backend API

Node.js / Express API that powers the **Livinkey admin console** and the **Livinkey tenant & guest mobile app**: PG (paying-guest) management, tenants, rooms, billing, payments, documents, notices, maintenance, messaging and analytics.

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime / framework | Node.js, Express 5 |
| Database | MySQL (`mysql2` connection pool) |
| Auth | JWT (admins and tenants have separate middleware), bcrypt |
| Files | Cloudinary (documents, proofs, meter photos, QR codes) |
| Messaging | Bigtos WhatsApp → SMS → e-mail delivery chain, Nodemailer |
| Push notifications | Firebase Cloud Messaging (`firebase-admin`) |
| Scheduling | `node-cron` (reminders, fines, expiry checks) |

## Getting started

```bash
cd backend
npm ci
cp .env.example .env      # fill in real values (never commit .env)
npm run migrate           # idempotent, additive schema migration
npm run dev               # nodemon  |  npm start for production
```

### Configuration

All settings come from environment variables. `.env.example` lists every key with a short comment; the important groups are:

- **Database** – `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_LIMIT`
- **Security** – `JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGINS`
- **Public URLs** – `PUBLIC_API_URL`, `WEBSITE_URL`, `ADMIN_URL`, `APP_STORE_URL`
- **E-mail** – `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`
- **Cloudinary** – `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Push** – `ENABLE_PUSH_NOTIFICATIONS`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`
- **Payments / UPI** – `MERCHANT_UPI_ID`, `MERCHANT_NAME`, optional gateway keys
- **Messaging** – Bigtos API key and template names, see [docs/BIGTOS_SETUP.md](docs/BIGTOS_SETUP.md)
- **Time zone** – `APP_TIMEZONE` (optional, default `Asia/Kolkata`) used for receipt timestamps

> Keep `.env` and any `firebase-service-account.json` out of version control and out of shared archives. Rotate a secret immediately if it has ever been shared.

## Database migrations

`npm run migrate` (`scripts/migrate.js`) is **additive and idempotent**: it creates missing tables/columns/indexes and inserts missing permission rows. It never imports a dump and never deletes or rewrites business records. SQL files in `src/migrations/` document each schema step.

Recommended production routine:

1. Take a provider-side backup and confirm it can be restored.
2. Deploy the new code, then run `npm run migrate` once and read the log.
3. Start the service with `npm start` and smoke-test: admin login, tenant login, bill creation, payment proof verification, receipts, notifications.

Do not import `src/db.sql` into a live database – it is a reference snapshot containing `DROP TABLE` statements.

## Project structure

```
backend/
├── scripts/migrate.js        # schema migration runner
├── docs/BIGTOS_SETUP.md      # messaging provider setup
└── src/
    ├── server.js / app.js    # bootstrap, middleware, route mounting
    ├── config/               # db, cloudinary, schema bootstrap
    ├── middleware/           # admin / tenant / guest auth, audit logging, uploads
    ├── routes/               # route definitions
    ├── controllers/          # request handlers
    ├── services/             # business logic (billing, payments, receipts, messaging…)
    ├── models/               # SQL access layer
    ├── utils/                # helpers (auth core, notification events, validators)
    ├── migrations/           # SQL migrations (reference)
    └── assets/               # logo used on PDF/HTML receipts
```

## API overview

| Mount point | Purpose |
| --- | --- |
| `/api/admins` | Admin auth, admin accounts, permissions, sign-in history |
| `/api/tenants` | Tenant CRUD, archive / check-out / restore (admin) and **tenant self-service** (login, profile, `GET /roommates`, `GET /checkout/eligibility`, `POST /checkout`) |
| `/api/bills`, `/api/payments` | Billing, payments, payment-proof verification, receipts |
| `/api/tenant-payments` | Tenant-facing bills, payment history, proof upload, receipts |
| `/api/documents` | Tenant documents with review workflow |
| `/api/activity-logs` | App activity & admin audit logs (list, export, **delete**) |
| `/api/electricity` | Electricity meter reading history and export |
| `/api/notifications`, `/api/admin-notifications`, `/api/tenant-notifications` | Admin notifications, announcements and tenant notifications |

## Behaviour worth knowing

- **Rent for shared rooms** – a *Full (group)* bill charges the room's rent **once** (highest recorded rent among occupants); a *Split* bill bills each tenant their own rent and divides other charges evenly. Editing a bill recomputes totals, status and payment QR codes, and keeps the meter-reading ledger in sync.
- **Paid from / paid till** – the dates entered when verifying a payment are written exactly to the tenant record, so Tenant Management always matches what the admin verified.
- **Documents** – approved documents are final. A rejected document is removed from storage and the database automatically and the tenant is told why so they can upload it again.
- **Payment proofs** – tenants attach a screenshot only; no transaction ID is required. An internal unique reference is generated.
- **Tenant check-out** – refused while any bill is unpaid (own bills and shared room bills). On success the tenant is archived as `checked_out`, the room is freed and admins are notified.
- **Roommates** – the roommate endpoint only returns name, phone, e-mail, gender, nationality and arrival date of *other active tenants in the same room*; nothing else is shared.
- **Admin names** – messages, e-mails and audit entries are signed with the real admin's name, never their role.
- **Activity deletion** – requires the `delete` permission on *Activity Logs* (super admins always). Bulk deletes need an explicit confirmation flag; deleting the admin audit trail or sign-in history is super-admin only and is itself logged.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start with nodemon |
| `npm start` | Start for production |
| `npm run migrate` | Apply additive schema migrations |
