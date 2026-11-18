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

## Admin console fixes (reset + search/filter)
- Fixed "Reset token, new password, and confirm password are required." when a super admin resets a tenant password: API.tenants.resetPassword was defined twice in frontend/assets/js/api.js; the tenant-app version overrode the admin one. The tenant-app one is now resetPasswordWithToken.
- New shared LKSearch helper (ui.js): accent/case/space-insensitive, every word must match, phone/amount/room punctuation tolerant, debounced, clear button, Esc to clear.
- Bills: search + room + month + status tab now combine; tab counts; result count; clear-all; Overdue tab shows only overdue (delayed has its own tab). Payment proofs likewise.
- Tenants: typing no longer wipes chip filters; search also covers email, phone, PG, bill status.
- Guests, admins, PGs, documents, feedbacks (local search, was server call per keystroke), maintenance, archive (live filters, Clear button), notifications picker, activity log (debounced) updated.
- Backend bill search: multi-word across name, email, phone, PG, room, month.
