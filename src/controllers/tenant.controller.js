const tenantService = require("../services/tenant.service");
const { sendGuestMessageEmail } = require("../services/mail.service");
const db = require("../config/db");

const createTenant = async (req, res) => {
    try {
        const {
            role,
            full_name,
            email,
            nationality,
            country_code,
            phone,
            international_phone,
            parent_phone,
            gender,
            pg_id,
            room_id,
            residency,
            aadhaar_id,
            father_aadhaar_id,
            c_form_number,
            efrro_from,
            efrro_till,
            rent,
            security_fee,
            payment_date,
            paid_from,
            paid_till,
            arrival_date,
            period_of_stay,
            number_of_tenants
        } = req.body;

        if (!role || !full_name || !email || !nationality || !country_code || !phone || !gender) {
            return res.status(400).json({
                success: false,
                message: "All basic fields are required: role, full_name, email, nationality, country_code, phone, gender"
            });
        }

        if (!['tenant', 'guest'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: "Role must be either 'tenant' or 'guest'"
            });
        }

        if (role === 'tenant') {
            if (!pg_id || !room_id || !residency || !rent || !security_fee || !payment_date || !paid_from || !paid_till || !arrival_date || !period_of_stay) {
                return res.status(400).json({
                    success: false,
                    message: "All tenant-specific fields are required: pg_id, room_id, residency, rent, security_fee, payment_date, paid_from, paid_till, arrival_date, period_of_stay"
                });
            }

            if (!['national', 'international'].includes(residency)) {
                return res.status(400).json({
                    success: false,
                    message: "Residency must be either 'national' or 'international'"
                });
            }

            const parsedPeriodOfStay = parseInt(period_of_stay, 10);
            if (!Number.isInteger(parsedPeriodOfStay) || parsedPeriodOfStay < 1 || parsedPeriodOfStay > 12) {
                return res.status(400).json({
                    success: false,
                    message: "Period of stay must be between 1 and 12 months"
                });
            }

            if (residency === 'national') {
                if (!aadhaar_id || !father_aadhaar_id) {
                    return res.status(400).json({
                        success: false,
                        message: "Aadhaar ID and Father Aadhaar ID are required for national tenants"
                    });
                }
            }
        }

        const tenantData = {
            role,
            full_name,
            email,
            nationality,
            country_code,
            phone,
            international_phone: international_phone || null,
            parent_phone: parent_phone || null,
            gender,
            created_by: req.admin.id
        };

        if (role === 'tenant') {
            tenantData.pg_id = parseInt(pg_id);
            tenantData.room_id = parseInt(room_id);
            tenantData.residency = residency;
            tenantData.aadhaar_id = aadhaar_id || null;
            tenantData.father_aadhaar_id = father_aadhaar_id || null;
            tenantData.c_form_number = c_form_number || null;
            tenantData.efrro_from = efrro_from || null;
            tenantData.efrro_till = efrro_till || null;
            tenantData.rent = parseFloat(rent);
            tenantData.security_fee = parseFloat(security_fee);
            tenantData.payment_date = parseInt(payment_date);
            tenantData.paid_from = paid_from;
            tenantData.paid_till = paid_till;
            tenantData.arrival_date = arrival_date;
            tenantData.period_of_stay = parseInt(period_of_stay, 10);
            const parsedCount = parseInt(number_of_tenants);
            tenantData.number_of_tenants = (isNaN(parsedCount) || parsedCount <= 0) ? 1 : parsedCount;
        }

        const files = {
            document: req.files?.document || [],
            otherDocuments: req.files?.otherDocuments || []
        };

        const tenant = await tenantService.createTenant(tenantData, files);

        return res.status(201).json({
            success: true,
            message: `${role} created successfully`,
            data: tenant
        });

    } catch (error) {
        console.error("Create Tenant Error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Internal server error"
        });
    }
};

const getAllTenants = async (req, res) => {
    try {
        const { search, role, gender, bill_status, pg_id } = req.query;
        const tenants = await tenantService.getAllTenants(search, role, gender, bill_status, pg_id);

        // Format dates for each tenant
        const formatDateString = (dateStr) => {
            if (!dateStr) return null;
            try {
                const d = new Date(dateStr);
                if (isNaN(d.getTime())) return null;
                return d.getFullYear() + '-' + 
                       String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                       String(d.getDate()).padStart(2, '0');
            } catch (e) {
                return null;
            }
        };

        const formattedTenants = tenants.map(tenant => ({
            ...tenant,
            paid_from: formatDateString(tenant.paid_from),
            paid_till: formatDateString(tenant.paid_till),
            arrival_date: formatDateString(tenant.arrival_date),
            efrro_from: formatDateString(tenant.efrro_from),
            efrro_till: formatDateString(tenant.efrro_till)
        }));

        return res.status(200).json({
            success: true,
            count: formattedTenants.length,
            data: formattedTenants
        });

    } catch (error) {
        console.error("Get All Tenants Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

const getTenantStats = async (req, res) => {
    try {
        const stats = await tenantService.getTenantStats();

        return res.status(200).json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error("Get Tenant Stats Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

const getGuestStats = async (req, res) => {
    try {
        const stats = await tenantService.getGuestStats();

        return res.status(200).json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error("Get Guest Stats Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

const getTenantById = async (req, res) => {
    try {
        const { id } = req.params;
        const tenant = await tenantService.getTenantById(id);

        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: "Tenant not found"
            });
        }

        // Format dates
        const formatDateString = (dateStr) => {
            if (!dateStr) return null;
            try {
                const d = new Date(dateStr);
                if (isNaN(d.getTime())) return null;
                return d.getFullYear() + '-' + 
                       String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                       String(d.getDate()).padStart(2, '0');
            } catch (e) {
                return null;
            }
        };

        const { password: _pw, otp: _otp, reset_token: _rt, ...safeTenant } = tenant;
        const formattedTenant = {
            ...safeTenant,
            paid_from: formatDateString(tenant.paid_from),
            paid_till: formatDateString(tenant.paid_till),
            arrival_date: formatDateString(tenant.arrival_date),
            efrro_from: formatDateString(tenant.efrro_from),
            efrro_till: formatDateString(tenant.efrro_till)
        };

        return res.status(200).json({
            success: true,
            data: formattedTenant
        });

    } catch (error) {
        console.error("Get Tenant By ID Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

const updateTenant = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            role,
            full_name,
            email,
            nationality,
            country_code,
            phone,
            international_phone,
            parent_phone,
            gender,
            pg_id,
            room_id,
            residency,
            aadhaar_id,
            father_aadhaar_id,
            c_form_number,
            efrro_from,
            efrro_till,
            rent,
            security_fee,
            payment_date,
            paid_from,
            paid_till,
            arrival_date,
            period_of_stay,
            number_of_tenants
        } = req.body;

        if (!role || !full_name || !email || !nationality || !country_code || !phone || !gender) {
            return res.status(400).json({
                success: false,
                message: "All basic fields are required: role, full_name, email, nationality, country_code, phone, gender"
            });
        }

        if (!['tenant', 'guest'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: "Role must be either 'tenant' or 'guest'"
            });
        }

        if (role === 'tenant') {
            if (!pg_id || !room_id || !residency || !rent || !security_fee || !payment_date || !paid_from || !paid_till || !arrival_date || !period_of_stay) {
                return res.status(400).json({
                    success: false,
                    message: "All tenant-specific fields are required: pg_id, room_id, residency, rent, security_fee, payment_date, paid_from, paid_till, arrival_date, period_of_stay"
                });
            }

            if (!['national', 'international'].includes(residency)) {
                return res.status(400).json({
                    success: false,
                    message: "Residency must be either 'national' or 'international'"
                });
            }

            const parsedPeriodOfStay = parseInt(period_of_stay, 10);
            if (!Number.isInteger(parsedPeriodOfStay) || parsedPeriodOfStay < 1 || parsedPeriodOfStay > 12) {
                return res.status(400).json({
                    success: false,
                    message: "Period of stay must be between 1 and 12 months"
                });
            }

            if (residency === 'national') {
                if (!aadhaar_id || !father_aadhaar_id) {
                    return res.status(400).json({
                        success: false,
                        message: "Aadhaar ID and Father Aadhaar ID are required for national tenants"
                    });
                }
            }
        }

        const tenantData = {
            role,
            full_name,
            email,
            nationality,
            country_code,
            phone,
            international_phone: international_phone || null,
            parent_phone: parent_phone || null,
            gender
        };

        if (role === 'tenant') {
            tenantData.pg_id = parseInt(pg_id);
            tenantData.room_id = parseInt(room_id);
            tenantData.residency = residency;
            tenantData.aadhaar_id = aadhaar_id || null;
            tenantData.father_aadhaar_id = father_aadhaar_id || null;
            tenantData.c_form_number = c_form_number || null;
            tenantData.efrro_from = efrro_from || null;
            tenantData.efrro_till = efrro_till || null;
            tenantData.rent = parseFloat(rent);
            tenantData.security_fee = parseFloat(security_fee);
            tenantData.payment_date = parseInt(payment_date);
            tenantData.paid_from = paid_from;
            tenantData.paid_till = paid_till;
            tenantData.arrival_date = arrival_date;
            tenantData.period_of_stay = parseInt(period_of_stay, 10);
            const parsedCount = parseInt(number_of_tenants);
            tenantData.number_of_tenants = (isNaN(parsedCount) || parsedCount <= 0) ? 1 : parsedCount;
        }

        const files = {
            document: req.files?.document || [],
            otherDocuments: req.files?.otherDocuments || []
        };

        const tenant = await tenantService.updateTenant(id, tenantData, files);

        return res.status(200).json({
            success: true,
            message: `${role} updated successfully`,
            data: tenant
        });

    } catch (error) {
        console.error("Update Tenant Error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Internal server error"
        });
    }
};

const deleteTenant = async (req, res) => {
    try {
        const { id } = req.params;
        const reason = (req.body && req.body.reason) || null;
        const archivedBy = req.admin ? req.admin.id : null;
        await tenantService.deleteTenant(id, { reason, archivedBy });

        return res.status(200).json({
            success: true,
            message: "Tenant moved to Archive successfully"
        });

    } catch (error) {
        console.error("Delete Tenant Error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Internal server error"
        });
    }
};

const checkoutTenant = async (req, res) => {
    try {
        const { id } = req.params;
        const { checkout_date, reason } = req.body || {};
        if (!checkout_date) {
            return res.status(400).json({
                success: false,
                message: "Checkout date is required"
            });
        }
        const archivedBy = req.admin ? req.admin.id : null;
        await tenantService.checkoutTenant(id, checkout_date, archivedBy, reason || null);

        return res.status(200).json({
            success: true,
            message: "Tenant checked out successfully"
        });
    } catch (error) {
        console.error("Checkout Tenant Error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Internal server error"
        });
    }
};

const getArchivedTenants = async (req, res) => {
    try {
        const filters = {
            search: req.query.search || null,
            role: req.query.role || null,
            gender: req.query.gender || null,
            pg_id: req.query.pg_id || null,
            status: req.query.status || null,
            month: req.query.month || null,
            year: req.query.year || null,
            residency: req.query.residency || null
        };
        const data = await tenantService.getArchivedTenants(filters);
        return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
        console.error("Get Archived Tenants Error:", error);
        return res.status(500).json({ success: false, message: error.message || "Internal server error" });
    }
};

const getArchiveStats = async (req, res) => {
    try {
        const data = await tenantService.getArchiveStats();
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("Get Archive Stats Error:", error);
        return res.status(500).json({ success: false, message: error.message || "Internal server error" });
    }
};

const restoreTenant = async (req, res) => {
    try {
        const { id } = req.params;
        await tenantService.restoreTenant(id);
        return res.status(200).json({ success: true, message: "Tenant restored successfully" });
    } catch (error) {
        console.error("Restore Tenant Error:", error);
        return res.status(400).json({ success: false, message: error.message || "Internal server error" });
    }
};

const restoreTenantsBulk = async (req, res) => {
    try {
        const ids = (req.body && req.body.ids) || [];
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ success: false, message: "ids array is required" });
        }
        const results = [];
        for (const id of ids) {
            try {
                await tenantService.restoreTenant(id);
                results.push({ id, success: true });
            } catch (e) {
                results.push({ id, success: false, message: e.message });
            }
        }
        return res.status(200).json({ success: true, results });
    } catch (error) {
        console.error("Bulk Restore Error:", error);
        return res.status(500).json({ success: false, message: error.message || "Internal server error" });
    }
};

const permanentDeleteTenant = async (req, res) => {
    try {
        const { id } = req.params;
        await tenantService.permanentDeleteTenant(id);
        return res.status(200).json({
            success: true,
            message: "Tenant permanently deleted"
        });
    } catch (error) {
        console.error("Permanent Delete Error:", error);
        return res.status(400).json({ success: false, message: error.message || "Internal server error" });
    }
};

const permanentDeleteTenantsBulk = async (req, res) => {
    try {
        const ids = (req.body && req.body.ids) || [];
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ success: false, message: "ids array is required" });
        }
        const results = [];
        for (const id of ids) {
            try {
                await tenantService.permanentDeleteTenant(id);
                results.push({ id, success: true });
            } catch (e) {
                results.push({ id, success: false, message: e.message });
            }
        }
        return res.status(200).json({ success: true, results });
    } catch (error) {
        console.error("Bulk Permanent Delete Error:", error);
        return res.status(500).json({ success: false, message: error.message || "Internal server error" });
    }
};

const sendMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const { message, subject } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                message: "Message content is required"
            });
        }

        const tenant = await tenantService.getTenantById(id);
        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: "Tenant not found"
            });
        }

        if (tenant.role !== 'guest') {
            return res.status(400).json({
                success: false,
                message: "Messages can only be sent to guests"
            });
        }

        const adminName = req.admin.name || 'Livinkey Admin';
        const notifTitle = (subject && String(subject).trim()) || 'Message from Livinkey Admin';

        // In-app notification so guests see it in their app
        try {
            const guestNotificationService = require("../services/guest.notification.service");
            await guestNotificationService.sendGuestNotification(tenant.id, 'ADMIN_MESSAGE', {
                title: notifTitle,
                message: message,
                entity_type: 'admin_message',
                link: '/guest-notifications'
            });
        } catch (inAppErr) {
            console.error("Guest in-app notification failed:", inAppErr.message);
        }

        // Device push is sent by guestNotificationService.sendGuestNotification above.

        // WhatsApp first; the e-mail is only the fallback.
        try {
            await require("../services/messaging.service").sendMessage({
                userId: tenant.id, userType: "guest", phone: tenant.phone, countryCode: tenant.country_code,
                email: tenant.email, name: tenant.full_name,
                type: "custom", title: notifTitle, body: String(message),
                origin: "admin", adminName,
                link: { target: "notifications", params: { title: notifTitle } },
                richEmail: () => sendGuestMessageEmail(tenant.email, tenant.full_name, adminName, message, subject || null),
            });
        } catch (sendErr) {
            console.error("Guest message failed on every channel:", sendErr.message);
        }

        // Log for admin history
        try {
            const connection = await db.getConnection();
            try {
                await connection.execute(
                    `INSERT INTO admin_notification_logs
                     (admin_id, recipient_type, recipient_count, recipient_ids, title, message, send_push, send_email, sent_at)
                     VALUES (?, 'guest', 1, ?, ?, ?, 1, 1, NOW())`,
                    [req.admin.id, JSON.stringify([parseInt(id)]), notifTitle, message]
                );
            } catch (e) {
                if (e && (e.code === 'ER_BAD_FIELD_ERROR' || String(e.message || '').includes('recipient_ids'))) {
                    await connection.execute(
                        `INSERT INTO admin_notification_logs
                         (admin_id, recipient_type, recipient_count, title, message, send_push, send_email, sent_at)
                         VALUES (?, 'guest', 1, ?, ?, 1, 1, NOW())`,
                        [req.admin.id, notifTitle, message]
                    );
                }
            }
            connection.release();
        } catch (logErr) {
            console.error("Guest message log failed:", logErr.message);
        }

        return res.status(200).json({
            success: true,
            message: "Message sent successfully to guest"
        });

    } catch (error) {
        console.error("Send Message Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Internal server error"
        });
    }
};

const getEFRROStats = async (req, res) => {
    try {
        const stats = await tenantService.getEFRROStats();

        return res.status(200).json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error("Get e-FRRO Stats Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

const getEFRROExpiringList = async (req, res) => {
    try {
        const { daysRange } = req.query;
        const list = await tenantService.getEFRROExpiringList(daysRange || null);

        // Format dates
        const formatDateString = (dateStr) => {
            if (!dateStr) return null;
            try {
                const d = new Date(dateStr);
                if (isNaN(d.getTime())) return null;
                return d.getFullYear() + '-' + 
                       String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                       String(d.getDate()).padStart(2, '0');
            } catch (e) {
                return null;
            }
        };

        const formattedList = list.map(item => ({
            ...item,
            efrro_from: formatDateString(item.efrro_from),
            efrro_till: formatDateString(item.efrro_till)
        }));

        return res.status(200).json({
            success: true,
            count: formattedList.length,
            data: formattedList
        });

    } catch (error) {
        console.error("Get e-FRRO Expiring List Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// ============================================================
// FULL DETAILS (read-only "View" in Tenants Management)
// ============================================================
const getTenantFullDetails = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: "Invalid tenant id." });

        const [people] = await db.execute(
            `SELECT t.id, t.role, t.full_name, t.email, t.nationality, t.country_code, t.phone,
                    t.international_phone, t.parent_phone, t.gender, t.is_active, t.status, t.checkout_date,
                    t.must_change_password, t.created_at, t.updated_at,
                    t.is_blocked, t.block_reason, t.blocked_at, t.blocked_by,
                    ab.name AS blocked_by_name, ac.name AS created_by_name,
                    td.pg_id, td.room_id, td.residency, td.aadhaar_id, td.father_aadhaar_id, td.c_form_number,
                    td.efrro_from, td.efrro_till, td.rent, td.security_fee, td.payment_date, td.paid_from, td.paid_till,
                    td.arrival_date, td.period_of_stay, td.has_vehicle, td.vehicle_number,
                    p.name AS pg_name, r.room_number, r.capacity, r.rent AS room_list_rent
             FROM tenants t
             LEFT JOIN tenant_details td ON td.tenant_id = t.id
             LEFT JOIN pgs p ON p.id = td.pg_id
             LEFT JOIN rooms r ON r.id = td.room_id
             LEFT JOIN admins ab ON ab.id = t.blocked_by
             LEFT JOIN admins ac ON ac.id = t.created_by
             WHERE t.id = ? LIMIT 1`, [id]);
        if (!people.length) return res.status(404).json({ success: false, message: "Tenant not found." });
        const person = people[0];

        const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { console.error("Tenant view part failed:", e.message); return fallback; } };

        const [documents, bills, devices, roommates, agreement] = await Promise.all([
            safe(async () => (await db.execute(
                `SELECT id, document_type, original_name, document_url, review_status, review_note, created_at
                 FROM tenant_documents WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, [id]))[0], []),
            safe(async () => (await db.execute(
                `SELECT b.id, b.billing_month, b.rent_amount, b.electricity_amount, b.maintenance_amount, b.other_charges,
                        b.total_amount, b.paid_amount, b.fine_amount, b.status, b.created_at
                 FROM bills b
                 WHERE b.deleted_at IS NULL AND (b.tenant_id = ? OR EXISTS (
                        SELECT 1 FROM bill_group_members m INNER JOIN bill_groups g ON g.id = m.bill_group_id
                        WHERE g.bill_id = b.id AND m.tenant_id = ?))
                 ORDER BY b.created_at DESC LIMIT 12`, [id, id]))[0], []),
            safe(async () => (await db.execute(
                `SELECT device_type, app_version, is_active, last_opened_at, last_seen_at, logged_out_at, uninstalled_at, created_at
                 FROM tenant_devices WHERE tenant_id = ? ORDER BY COALESCE(last_opened_at, last_seen_at, updated_at) DESC LIMIT 5`, [id]))[0], []),
            safe(async () => person.room_id ? (await db.execute(
                `SELECT t.id, t.full_name, t.phone FROM tenant_details td INNER JOIN tenants t ON t.id = td.tenant_id
                 WHERE td.room_id = ? AND td.tenant_id <> ? AND t.is_active = 1 AND (t.status IS NULL OR t.status = 'active')`, [person.room_id, id]))[0] : [], []),
            safe(async () => {
                const svc = require("../services/agreement.service");
                const a = await svc.getTenantAgreement(id);
                return !a || !a.enabled ? "not_required" : (a.accepted ? "accepted" : "pending");
            }, "unknown")
        ]);

        const due = bills.reduce((n, b) => {
            if (b.status === "paid") return n;
            return n + Math.max(Number(b.total_amount || 0) + Number(b.fine_amount || 0) - Number(b.paid_amount || 0), 0);
        }, 0);

        const liveDevices = devices.filter(d => !d.uninstalled_at);
        const lastOpened = devices.reduce((m, d) => {
            const v = d.last_opened_at || d.last_seen_at;
            return v && (!m || new Date(v) > new Date(m)) ? v : m;
        }, null);

        return res.json({
            success: true,
            data: {
                tenant: person,
                documents, bills, roommates,
                agreement_status: agreement,
                outstanding_due: due,
                app: {
                    installed: liveDevices.length > 0,
                    logged_in: liveDevices.some(d => Number(d.is_active) === 1),
                    last_opened_at: lastOpened,
                    app_version: (liveDevices[0] && liveDevices[0].app_version) || null,
                    devices
                }
            }
        });
    } catch (error) {
        console.error("Tenant full details error:", error);
        return res.status(500).json({ success: false, message: "Could not load tenant details." });
    }
};

// ============================================================
// BLOCK / UNBLOCK
// ============================================================
const blockTenant = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const reason = String(req.body?.reason || "").trim();
        if (!id) return res.status(400).json({ success: false, message: "Invalid tenant id." });
        if (reason.length < 3) return res.status(400).json({ success: false, message: "Please enter the reason for blocking (it is shown to the tenant)." });
        if (reason.length > 500) return res.status(400).json({ success: false, message: "The reason must be 500 characters or fewer." });

        const [rows] = await db.execute(`SELECT id, role, full_name, is_blocked FROM tenants WHERE id = ? AND role = 'tenant' LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, message: "Tenant not found." });

        await db.execute(
            `UPDATE tenants SET is_blocked = 1, block_reason = ?, blocked_at = NOW(), blocked_by = ? WHERE id = ?`,
            [reason, req.admin.id, id]);
        require("../utils/auth.core").invalidateAccount(id, false);

        // Stop pushes to a blocked tenant's devices (keep install status intact)
        try { await db.execute(`UPDATE tenant_devices SET is_active = 0 WHERE tenant_id = ?`, [id]); } catch (_) {}

        try {
            await require("../services/activity.log.service").adminAction(req, "tenant_blocked", "tenants", {
                tenantId: id, entityType: "tenant", entityId: id, metadata: { reason }
            });
        } catch (_) {}

        return res.json({ success: true, message: `${rows[0].full_name} is now blocked.` });
    } catch (error) {
        console.error("Block tenant error:", error);
        return res.status(500).json({ success: false, message: "Could not block the tenant." });
    }
};

const unblockTenant = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: "Invalid tenant id." });
        const [rows] = await db.execute(`SELECT id, full_name FROM tenants WHERE id = ? AND role = 'tenant' LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, message: "Tenant not found." });

        await db.execute(
            `UPDATE tenants SET is_blocked = 0, block_reason = NULL, blocked_at = NULL, blocked_by = NULL WHERE id = ?`, [id]);
        require("../utils/auth.core").invalidateAccount(id, false);
        try {
            await require("../services/activity.log.service").adminAction(req, "tenant_unblocked", "tenants", {
                tenantId: id, entityType: "tenant", entityId: id, metadata: {}
            });
        } catch (_) {}
        return res.json({ success: true, message: `${rows[0].full_name} has been unblocked.` });
    } catch (error) {
        console.error("Unblock tenant error:", error);
        return res.status(500).json({ success: false, message: "Could not unblock the tenant." });
    }
};

module.exports = {
    getTenantFullDetails,
    blockTenant,
    unblockTenant,
    createTenant,
    getAllTenants,
    getTenantStats,
    getGuestStats,
    getTenantById,
    updateTenant,
    deleteTenant,
    checkoutTenant,
    getArchivedTenants,
    getArchiveStats,
    restoreTenant,
    restoreTenantsBulk,
    permanentDeleteTenant,
    permanentDeleteTenantsBulk,
    sendMessage,
    getEFRROStats,
    getEFRROExpiringList
};