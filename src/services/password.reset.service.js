/**
 * Password reset performed by a SUPER ADMIN for a tenant / guest or for another admin.
 *
 * What a reset does:
 *   1. Generates a strong one-time temporary password (never chosen or seen by the super admin).
 *   2. Stores only its bcrypt hash, forces a password change at the next sign-in, clears pending
 *      OTPs / reset links and failed-login lockouts, and ends every session that was signed in before
 *      the reset (password_changed_at is compared with the token's issue time).
 *   3. Delivers the new credentials through the normal messaging chain (WhatsApp to the person's
 *      numbers, then SMS / e-mail; an e-mail copy is sent too). The parent's number is never used.
 *   4. If NO channel could deliver the credentials, the account is put back exactly as it was, so
 *      nobody is locked out by a password they never received.
 */
const bcrypt = require("bcrypt");
const db = require("../config/db");
const { generatePassword } = require("../utils/helpers");
const messagingService = require("./messaging.service");
const mailService = require("./mail.service");
const attemptGuard = require("../utils/attempt.guard");
const { invalidateAccount } = require("../utils/auth.core");
const { ADMIN_URL, APP_STORE_URL } = require("../utils/links");

const fail = (status, message) => Object.assign(new Error(message), { status });

const fmtSent = (r) => {
    const parts = [];
    if (r.whatsapp?.success) parts.push("WhatsApp");
    if (r.sms?.success) parts.push("SMS");
    if (r.email?.success || r.emailSent) parts.push("email");
    return parts;
};

/** Run the update, deliver the credentials, and roll back if nothing could be delivered. */
const resetAndDeliver = async ({ table, isAdmin, row, userType, loginId, loginUrl, richEmail, body, title }) => {
    const plain = generatePassword(12);
    const hash = await bcrypt.hash(plain, 12);

    // Remember exactly what was there so a failed delivery can be undone.
    const [[before]] = await db.execute(
        `SELECT password, must_change_password, password_changed_at, otp, otp_expiry, reset_token, reset_token_expiry FROM \`${table}\` WHERE id = ? LIMIT 1`,
        [row.id]
    );

    await db.execute(
        `UPDATE \`${table}\`
            SET password = ?, must_change_password = 1, password_changed_at = NOW(),
                otp = NULL, otp_expiry = NULL, reset_token = NULL, reset_token_expiry = NULL
          WHERE id = ?`,
        [hash, row.id]
    );
    invalidateAccount(row.id, isAdmin);

    let result;
    try {
        result = await messagingService.sendMessage({
            userId: row.id,
            userType,
            phone: row.phone,
            countryCode: row.country_code || null,
            email: row.email,
            name: row.full_name || row.name,
            type: "custom",
            critical: true,
            sensitive: true, // the inbox keeps only the preview, never the password
            previewText: "Password reset - new login details sent",
            title,
            body: body(plain),
            link: loginUrl ? { url: loginUrl, label: isAdmin ? "Admin login" : "Download the app" } : null,
            richEmail: () => richEmail(plain),
            dedupKey: `pwreset:${table}:${row.id}:${Date.now()}`,
            dedupWindowSec: 5,
        });
    } catch (sendErr) {
        // Nothing could carry the new password: restore the previous state.
        try {
            await db.execute(
                `UPDATE \`${table}\`
                    SET password = ?, must_change_password = ?, password_changed_at = ?,
                        otp = ?, otp_expiry = ?, reset_token = ?, reset_token_expiry = ?
                  WHERE id = ?`,
                [before.password, before.must_change_password, before.password_changed_at,
                 before.otp, before.otp_expiry, before.reset_token, before.reset_token_expiry, row.id]
            );
            invalidateAccount(row.id, isAdmin);
        } catch (restoreErr) {
            console.error("Password reset: could not restore the previous password:", restoreErr.message);
        }
        throw fail(502, "The new password could not be delivered by WhatsApp, SMS or email, so the password was NOT changed. Check the person's phone number and email, then try again.");
    }

    // Let the person sign in straight away: clear failed-login lockouts.
    if (row.email) {
        attemptGuard.success(isAdmin ? "admin-login" : "tenant-login", row.email);
        attemptGuard.success(isAdmin ? "admin-otp" : "tenant-otp", row.email);
    }
    return { channels: fmtSent(result), primary: result.channel };
};

/** Tenant or guest (both live in the `tenants` table). */
const resetTenantPassword = async (tenantId) => {
    const [rows] = await db.execute(
        `SELECT id, role, full_name, email, phone, country_code, is_active, status FROM tenants WHERE id = ? LIMIT 1`,
        [tenantId]
    );
    const t = rows[0];
    if (!t) throw fail(404, "Tenant not found.");
    if (!t.email && !t.phone) throw fail(400, "This person has no email or phone number to send the new password to.");

    const kind = t.role === "guest" ? "guest" : "tenant";
    const out = await resetAndDeliver({
        table: "tenants", isAdmin: false, row: t, userType: kind,
        loginId: t.email, loginUrl: APP_STORE_URL,
        title: "Your Livinkey password was reset",
        body: (pw) => `A Livinkey administrator has reset your password.\n\nSign in with your phone number or email:\n• Email: ${t.email}\n• Phone: ${t.country_code || ""} ${t.phone || ""}\n• Temporary password: ${pw}\n\nYou will be asked to set a new password the first time you sign in. Never share your password with anyone.`,
        richEmail: (pw) => mailService.sendPasswordResetByAdminEmail(t.email, t.full_name, t.email, pw, APP_STORE_URL),
    });
    return { id: t.id, name: t.full_name, role: kind, ...out };
};

/** Another admin (an admin cannot reset their own password here – they use Change password). */
const resetAdminPassword = async (adminId, actingAdminId) => {
    if (Number(adminId) === Number(actingAdminId)) throw fail(400, "Use \"Change password\" to change your own password.");
    const [rows] = await db.execute(
        `SELECT id, name, email, phone, role, is_active FROM admins WHERE id = ? LIMIT 1`,
        [adminId]
    );
    const a = rows[0];
    if (!a) throw fail(404, "Admin not found.");
    if (!a.email && !a.phone) throw fail(400, "This admin has no email or phone number to send the new password to.");

    const out = await resetAndDeliver({
        table: "admins", isAdmin: true, row: a, userType: "admin",
        loginId: a.email, loginUrl: ADMIN_URL,
        title: "Your Livinkey Admin password was reset",
        body: (pw) => `A super admin has reset your Livinkey Admin password.\n\nLogin: ${ADMIN_URL}\n• Email: ${a.email}${a.phone ? `\n• Phone: ${a.phone}` : ""}\n• Temporary password: ${pw}\n\nYou will be asked to set a new password the first time you sign in. Never share this password.`,
        richEmail: (pw) => mailService.sendPasswordResetByAdminEmail(a.email, a.name, a.email, pw, ADMIN_URL),
    });
    return { id: a.id, name: a.name, role: a.role, ...out };
};

module.exports = { resetTenantPassword, resetAdminPassword };
