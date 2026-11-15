# Changelog

## Latest release

### Admin console
- Bills: mouse-wheel scrolling no longer changes number fields; verified *paid from / paid till* now update Tenant Management exactly; shared-room (group) bills charge the room rent once; bill edits are rounded, re-validated and keep the meter ledger in sync.
- Tenant Management: the contact line shows the tenant's own number; row actions are stacked vertically; dates use `dd/mm/yyyy` everywhere.
- Audit & Sign-ins: tables are visible again; app activity, admin audit entries and sign-in history can be deleted (permission-gated, confirmed).
- Meter readings: layout fixed; table and CSV export show main meter and inverter previous / current readings and units.
- Documents: approved documents are final (no repeat buttons); rejected documents are deleted automatically and the tenant is notified.
- Announcements and e-mails are signed with the sender's real name instead of their role.

### Backend
- New tenant self-service endpoints: roommates, check-out eligibility, check-out.
- Payment proofs no longer require a transaction ID.
- Receipts show the company logo only, with a friendly date and time.
