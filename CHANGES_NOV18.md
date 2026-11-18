# Update 18 Nov 2026

## Documents
- Indian tenants upload Aadhaar FRONT and BACK for both tenant and parent (4 documents). Old single-sided uploads still count as the front.
- Agreement must be one PDF (backend rejects non-PDF; app uses a PDF picker; web upload supports PDF).
- Singular/plural labels fixed (admin Documents page, messages, delete/reminder texts).

## Messaging (all messages)
- Tries the tenant's main number, then their own second number (international_phone). Parent numbers are never used.
- Critical messages (OTP, passwords/welcome) go by WhatsApp to BOTH numbers.
- E-mail copy is sent with WhatsApp (MESSAGING_EMAIL_COPY, default always). Inbox replies (type text) are excluded.
- A reply from Bigtos saying the number is not on WhatsApp is treated as a failure so the next number/channel is tried.

## Super admin password reset
- POST /api/tenants/:id/reset-password and /api/admins/:id/reset-password (super admin only).
- New temporary password is generated, sent by the messaging chain, must be changed at first login, old sessions end, lockouts cleared.
- If nothing could deliver it, the old password is restored.
- New columns password_changed_at (tenants, admins) are added automatically at start.

## Room capacity
- Tenants > Add tenant: full rooms are selectable; "Change tenants allowed" edits rooms.capacity (PUT /api/pgs/rooms/:roomId/capacity, needs tenants.add, never below current occupancy).
