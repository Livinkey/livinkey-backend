/**
 * Tenant self-service endpoints used by the mobile app:
 *   GET  /api/tenants/roommates   - who shares my room (only when I really have roommates)
 *   GET  /api/tenants/checkout/eligibility
 *   POST /api/tenants/checkout    - leave the PG (guarded: no outstanding dues, explicit confirmation)
 */
const db = require("../config/db");
const tenantService = require("../services/tenant.service");

const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const loadMe = async (tenantId) => {
    const [rows] = await db.execute(
        `SELECT t.id, t.full_name, t.status, t.is_active, td.pg_id, td.room_id, r.room_number, p.name AS pg_name
         FROM tenants t
         LEFT JOIN tenant_details td ON td.tenant_id = t.id
         LEFT JOIN rooms r ON r.id = td.room_id
         LEFT JOIN pgs p ON p.id = td.pg_id
         WHERE t.id = ? LIMIT 1`, [tenantId]);
    return rows[0] || null;
};

/** Outstanding balance across the tenant's own bills and shared room bills. */
const outstandingDues = async (tenantId) => {
    const [rows] = await db.execute(
        `SELECT COALESCE(SUM(GREATEST(b.total_amount + COALESCE(b.fine_amount,0) - COALESCE(b.paid_amount,0), 0)), 0) AS due,
                COUNT(*) AS bills
         FROM bills b
         WHERE b.deleted_at IS NULL AND b.status <> 'paid'
           AND (b.tenant_id = ? OR b.bill_group_id IN (
                 SELECT m.bill_group_id FROM bill_group_members m WHERE m.tenant_id = ?))`,
        [tenantId, tenantId]);
    return { due: Math.round(Number(rows[0].due || 0) * 100) / 100, bills: Number(rows[0].bills || 0) };
};

exports.getRoommates = async (req, res) => {
    try {
        const me = await loadMe(req.tenant.id);
        if (!me || !me.room_id) return res.json({ success: true, data: { has_roommates: false, roommates: [] } });
        const [rows] = await db.execute(
            `SELECT t.id, t.full_name, t.email, t.country_code, t.phone, t.gender, t.nationality, td.arrival_date
             FROM tenant_details td
             INNER JOIN tenants t ON t.id = td.tenant_id
             WHERE td.room_id = ? AND td.pg_id = ? AND td.tenant_id <> ?
               AND t.role = 'tenant' AND t.is_active = 1
             ORDER BY t.full_name`, [me.room_id, me.pg_id, me.id]);
        // Only share what a roommate reasonably needs: no rent, documents, ID numbers or parent details.
        const roommates = rows.map(r => ({
            id: r.id,
            full_name: r.full_name,
            phone: r.phone ? `${r.country_code || ""} ${r.phone}`.trim() : null,
            email: r.email || null,
            gender: r.gender || null,
            nationality: r.nationality || null,
            arrival_date: r.arrival_date ? new Date(r.arrival_date).toISOString().slice(0, 10) : null
        }));
        return res.json({
            success: true,
            data: { has_roommates: roommates.length > 0, room_number: me.room_number, pg_name: me.pg_name, roommates }
        });
    } catch (e) {
        console.error("Roommates error:", e);
        return res.status(500).json({ success: false, message: "Could not load roommate details." });
    }
};

exports.checkoutEligibility = async (req, res) => {
    try {
        const me = await loadMe(req.tenant.id);
        if (!me) return res.status(404).json({ success: false, message: "Account not found." });
        const { due, bills } = await outstandingDues(me.id);
        return res.json({
            success: true,
            data: { can_checkout: due <= 0, outstanding_amount: due, unpaid_bills: bills, pg_name: me.pg_name, room_number: me.room_number }
        });
    } catch (e) {
        console.error("Checkout eligibility error:", e);
        return res.status(500).json({ success: false, message: "Could not check your account right now." });
    }
};

exports.checkoutSelf = async (req, res) => {
    try {
        const me = await loadMe(req.tenant.id);
        if (!me) return res.status(404).json({ success: false, message: "Account not found." });
        if (me.status && me.status !== "active") {
            return res.status(400).json({ success: false, message: "Your stay is already closed." });
        }
        if (req.body?.confirm !== true) {
            return res.status(400).json({ success: false, message: "Please confirm that you want to check out." });
        }
        const { due } = await outstandingDues(me.id);
        if (due > 0) {
            return res.status(409).json({
                success: false, code: "DUES_PENDING", outstanding_amount: due,
                message: `You still have ₹${due.toLocaleString("en-IN")} outstanding. Please clear your dues before checking out.`
            });
        }
        const reason = String(req.body?.reason || "").trim().slice(0, 300);
        await tenantService.checkoutTenant(me.id, todayISO(), null, reason ? `Checked out by tenant: ${reason}` : "Checked out by tenant (app)");

        try {
            const NotificationService = require("../services/notification.service");
            await NotificationService.sendNotificationToAllAdmins("SYSTEM_ALERT", {
                title: "Tenant checked out",
                message: `${me.full_name} checked out of ${me.pg_name || "the PG"}${me.room_number ? `, room ${me.room_number}` : ""} from the app.${reason ? ` Reason: ${reason}` : ""}`,
                entity_id: me.id, entity_type: "tenant", link: "/archive"
            });
        } catch (e) { console.error("Checkout admin notification failed:", e.message); }

        return res.json({ success: true, message: "You have checked out successfully. Thank you for staying with us!" });
    } catch (e) {
        console.error("Tenant checkout error:", e);
        return res.status(400).json({ success: false, message: e.message || "Could not complete your checkout." });
    }
};
