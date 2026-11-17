const db = require("../config/db");
const MaintenanceModel = require("../models/maintenance.model");
const TenantModel = require("../models/tenant.model");
const { uploadFile, deleteFile } = require("./upload.service");
const NotificationEventManager = require("../utils/notification.events");
const { sendMaintenanceCompletionReminder } = require("./mail.service");
const firebase = require("../config/firebase");
const messagingService = require("./messaging.service");
const MaintenanceForward = require("../models/maintenance.forward.model");
const { normalizePhone, maskPhone } = require("../utils/phone");
const { adminPage } = require("./links.service");

const STATUS_LABEL = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

/** Admins who may handle maintenance: every active super admin + admins with maintenance "view" permission. */
const getAuthorizedMaintenanceAdmins = async () => {
    const [rows] = await db.execute(
        `SELECT a.id, a.name, a.email, a.phone
           FROM admins a
          WHERE a.is_active = 1
            AND (a.role = 'super_admin'
                 OR EXISTS (SELECT 1 FROM admin_permissions ap
                             WHERE ap.admin_id = a.id AND ap.module_name = 'maintenance' AND ap.can_view = 1))`
    );
    return rows;
};

const requestSummaryLines = (r) => [
    `Tenant: ${r.tenant_name || "-"}${r.tenant_phone ? ` (${r.tenant_phone})` : ""}`,
    `PG: ${r.pg_name || "-"} · Room ${r.room_number || "-"}`,
    `Issue: ${r.issue_type}${r.description ? ` - ${String(r.description).slice(0, 300)}` : ""}`,
    r.service_date ? `Preferred date: ${new Date(r.service_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${r.free_time ? `, ${r.free_time}` : ""}` : null,
    r.image_url ? `Photo: ${r.image_url}` : null,
].filter(Boolean).join("\n");

/** WhatsApp (then e-mail) every authorized admin about a maintenance event. Never throws. */
const notifyAdminsAboutRequest = async (request, { title, intro, dedupSuffix }) => {
    try {
        const admins = await getAuthorizedMaintenanceAdmins();
        await Promise.all(admins.map(async (a) => {
            try {
                await messagingService.sendMessage({
                    userId: a.id, userType: "admin", phone: a.phone, email: a.email, name: a.name,
                    type: "custom", title,
                    body: `${requestSummaryLines(request)}\n\n${intro}`,
                    link: { url: adminPage("maintenance"), label: "Open in admin panel" },
                    dedupKey: `maint-admin:${request.id}:${dedupSuffix}`, dedupWindowSec: 600,
                });
            } catch (e) {
                console.error(`Maintenance alert to admin ${a.id} failed on every channel:`, e.message);
            }
        }));
    } catch (e) {
        console.error("Maintenance admin alert failed:", e.message);
    }
};

/** Tell the tenant (WhatsApp, then e-mail) how their request moved. Never throws. */
const notifyTenantAboutRequest = async (request, status) => {
    try {
        const text = status === "in_progress"
            ? `Work on your ${request.issue_type} request has started.`
            : status === "completed"
                ? `Your ${request.issue_type} request has been marked as completed.\nIf anything is still wrong, please raise a new request in the app.`
                : `Your ${request.issue_type} request is now ${STATUS_LABEL[status] || status}.`;
        await messagingService.sendMessage({
            userId: request.tenant_id, userType: "tenant", name: request.tenant_name,
            type: "custom", title: `Maintenance ${STATUS_LABEL[status] || status}`, body: text,
            link: { target: "maintenance", params: { title: "Your maintenance request", subtitle: "Open your requests" } },
            dedupKey: `maint-tenant:${request.id}:${status}`, dedupWindowSec: 600,
        });
    } catch (e) {
        console.error("Maintenance tenant message failed on every channel:", e.message);
    }
};

const createMaintenanceRequest = async (tenantId, requestData, file = null) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Check if tenant exists
        const tenant = await TenantModel.findById(tenantId);
        if (!tenant) {
            throw new Error("Tenant not found");
        }

        if (!tenant.room_id) {
            throw new Error("No room assigned to this tenant");
        }

        let imageUrl = null;
        let imagePublicId = null;
        let imageResourceType = null;

        // Upload image if provided
        if (file) {
            const uploadResult = await uploadFile(
                file,
                `livinkey/maintenance/${tenantId}`
            );
            if (uploadResult) {
                imageUrl = uploadResult.secure_url;
                imagePublicId = uploadResult.public_id;
                imageResourceType = uploadResult.resource_type || 'image';
            }
        }

        // Create maintenance request
        const requestId = await MaintenanceModel.createMaintenanceRequest(connection, {
            tenant_id: tenantId,
            room_id: tenant.room_id,
            issue_type: requestData.issue_type,
            description: requestData.description || null,
            service_date: requestData.service_date,
            free_time: requestData.free_time || null,
            image_url: imageUrl,
            image_public_id: imagePublicId,
            image_resource_type: imageResourceType,
            created_by: tenantId
        });

        await connection.commit();

        const request = await MaintenanceModel.getRequestById(requestId);

        // Send notification to admins
        try {
            await NotificationEventManager.onMaintenanceCreated(request);
        } catch (notifError) {
            console.error("Failed to send maintenance notification:", notifError);
        }

        // Send notification to tenant (NEW)
        try {
            await NotificationEventManager.onTenantMaintenanceCreated(request);
        } catch (notifError) {
            console.error("Failed to send tenant maintenance notification:", notifError);
        }

        // WhatsApp (e-mail as fallback) to every authorized admin - in the background so the tenant's request returns fast
        notifyAdminsAboutRequest(request, { title: `New maintenance request #${request.id}`, intro: "A tenant has raised a new maintenance request.", dedupSuffix: "new" });

        return request;

    } catch (error) {
        await connection.rollback();
        console.error("Create Maintenance Request Error:", error);
        throw error;

    } finally {
        connection.release();
    }
};

const getTenantRequests = async (tenantId, status = null) => {
    return await MaintenanceModel.getRequestsByTenant(tenantId, status);
};

const getTenantStats = async (tenantId) => {
    return await MaintenanceModel.getTenantStats(tenantId);
};

const getRequestById = async (requestId) => {
    return await MaintenanceModel.getRequestById(requestId);
};

const getAllRequests = async (filters = {}) => {
    return await MaintenanceModel.getAllRequests(filters);
};

const getAdminStats = async (filters = {}) => {
    return await MaintenanceModel.getAdminStats(filters);
};

const updateRequestStatus = async (requestId, status, completedBy = null) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const request = await MaintenanceModel.getRequestById(requestId);
        if (!request) {
            throw new Error("Maintenance request not found");
        }

        // Validate status transition
        if (status === 'in_progress' && request.status !== 'pending') {
            throw new Error("Only pending requests can be started");
        }

        if (status === 'completed' && request.status !== 'in_progress') {
            throw new Error("Only in-progress requests can be completed");
        }

        // Track who completed it (for logging)
        let completedByValue = null;
        if (status === 'completed' && completedBy) {
            completedByValue = completedBy;
        }

        const updated = await MaintenanceModel.updateRequestStatus(
            connection, 
            requestId, 
            status,
            completedByValue
        );

        await connection.commit();

        if (updated > 0) {
            const updatedRequest = await MaintenanceModel.getRequestById(requestId);
            
            // Send notification to admins
            try {
                await NotificationEventManager.onMaintenanceStatusUpdated(updatedRequest);
            } catch (notifError) {
                console.error("Failed to send maintenance status notification:", notifError);
            }

            // Send notification to tenant based on status (NEW)
            try {
                if (status === 'in_progress') {
                    await NotificationEventManager.onTenantMaintenanceStarted(updatedRequest);
                } else if (status === 'completed') {
                    await NotificationEventManager.onTenantMaintenanceCompleted(updatedRequest);
                }
            } catch (notifError) {
                console.error("Failed to send tenant maintenance status notification:", notifError);
            }
            notifyTenantAboutRequest(updatedRequest, status);
            
            return updatedRequest;
        }

        return null;

    } catch (error) {
        await connection.rollback();
        console.error("Update Request Status Error:", error);
        throw error;

    } finally {
        connection.release();
    }
};

// ============================================================
// NEW: Tenant completes a request (with validation)
// ============================================================
const completeRequestByTenant = async (requestId, tenantId) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const request = await MaintenanceModel.getRequestById(requestId);
        if (!request) {
            throw new Error("Maintenance request not found");
        }

        // Verify this tenant owns the request
        if (request.tenant_id !== tenantId) {
            throw new Error("Unauthorized: This request does not belong to you");
        }

        // Only in_progress requests can be completed
        if (request.status !== 'in_progress') {
            throw new Error(`Cannot complete a request with status "${request.status}". Only in-progress requests can be completed.`);
        }

        // Track who completed it
        const completedBy = `tenant_${tenantId}`;

        const updated = await MaintenanceModel.updateRequestStatus(
            connection, 
            requestId, 
            'completed',
            completedBy
        );

        await connection.commit();

        if (updated > 0) {
            const updatedRequest = await MaintenanceModel.getRequestById(requestId);
            
            // Send notification to admins
            try {
                await NotificationEventManager.onMaintenanceStatusUpdated(updatedRequest);
            } catch (notifError) {
                console.error("Failed to send maintenance status notification:", notifError);
            }

            // Send notification to tenant
            try {
                await NotificationEventManager.onTenantMaintenanceCompleted(updatedRequest);
            } catch (notifError) {
                console.error("Failed to send tenant maintenance completion notification:", notifError);
            }
            notifyAdminsAboutRequest(updatedRequest, { title: `Maintenance #${updatedRequest.id} completed`, intro: "The tenant marked this request as completed.", dedupSuffix: "done" });
            
            return updatedRequest;
        }

        return null;

    } catch (error) {
        await connection.rollback();
        console.error("Complete Request By Tenant Error:", error);
        throw error;

    } finally {
        connection.release();
    }
};

// ============================================================
// NEW: Check for in_progress requests older than 20 minutes
// and send push notifications to tenants
// ============================================================
let reminderRunning = false; // stops overlapping runs inside this process
const REMINDER_LOCK = "livinkey_maintenance_reminder";

const checkAndSendCompletionReminders = async () => {
    if (reminderRunning) return { sent: 0, details: [], skipped: "already running" };
    reminderRunning = true;

    const connection = await db.getConnection();
    let sentCount = 0;
    let haveLock = false;
    const details = [];

    try {
        // Cross-process lock: with two workers / a restart overlapping a tick, only ONE runs the job.
        const [[lock]] = await connection.query(`SELECT GET_LOCK(?, 0) AS got`, [REMINDER_LOCK]);
        haveLock = Number(lock.got) === 1;
        if (!haveLock) return { sent: 0, details: [], skipped: "another instance is running" };

        // in_progress for 20+ minutes, reminder not yet sent (or a failed attempt more than 1 hour ago)
        const [requests] = await connection.execute(
            `
            SELECT
                mr.*,
                t.full_name as tenant_name,
                t.email as tenant_email,
                t.phone as tenant_phone,
                t.country_code as tenant_country_code,
                r.room_number,
                p.name as pg_name
            FROM maintenance_requests mr
            INNER JOIN tenants t ON mr.tenant_id = t.id
            INNER JOIN rooms r ON mr.room_id = r.id
            LEFT JOIN tenant_details td ON t.id = td.tenant_id
            LEFT JOIN pgs p ON td.pg_id = p.id
            WHERE mr.status = 'in_progress'
            AND mr.updated_at <= DATE_SUB(NOW(), INTERVAL 20 MINUTE)
            AND mr.completion_reminder_sent = 0
            AND (mr.completion_reminder_at IS NULL OR mr.completion_reminder_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR))
            `
        );

        for (const request of requests) {
            try {
                // CLAIM FIRST: flip the flag atomically before anything is sent. Whoever changes the
                // row (affectedRows = 1) owns this reminder; every other run skips it. This is what
                // stops the same "Is your maintenance completed?" going out many times in a minute.
                const [claim] = await connection.execute(
                    `UPDATE maintenance_requests
                        SET completion_reminder_sent = 1, completion_reminder_at = NOW()
                      WHERE id = ? AND completion_reminder_sent = 0 AND status = 'in_progress'`,
                    [request.id]
                );
                if (claim.affectedRows !== 1) continue;

                let delivered = false;

                // Push notification (once)
                try {
                    const fcmTokens = await firebase.getTenantFCMTokens(request.tenant_id);
                    if (fcmTokens.length > 0) {
                        await firebase.sendPushNotificationToMultiple(
                            fcmTokens,
                            { title: "🔧 Is your maintenance completed?", body: "Don't forget to mark your maintenance request as done!" },
                            { type: 'maintenance_reminder', entity_id: request.id, action: 'open_maintenance' }
                        );
                        delivered = true;
                    }
                } catch (pushErr) {
                    console.error(`Maintenance reminder push failed for request ${request.id}:`, pushErr.message);
                }

                // WhatsApp -> (SMS) -> e-mail; the dedicated e-mail is only used if WhatsApp could not take it
                try {
                    const r = await messagingService.sendMessage({
                        userId: request.tenant_id, userType: "tenant", name: request.tenant_name,
                        phone: request.tenant_phone, countryCode: request.tenant_country_code, email: request.tenant_email,
                        type: "reminder", title: "Is your maintenance completed?",
                        body: `Your ${request.issue_type} request is in progress.\nIf the work is done, please mark it as completed.`,
                        link: { target: "maintenance", params: { title: "Mark maintenance as done", subtitle: "Open your requests" } },
                        dedupKey: `maint-reminder:${request.id}`, dedupWindowSec: 7 * 24 * 3600,
                        richEmail: () => sendMaintenanceCompletionReminder(
                            request.tenant_email, request.tenant_name,
                            { id: request.id, issue_type: request.issue_type, room_number: request.room_number, pg_name: request.pg_name }
                        ),
                    });
                    delivered = delivered || !r.skippedDuplicate;
                } catch (msgError) {
                    console.error("Failed to send maintenance reminder message:", msgError.message);
                }

                if (delivered) {
                    sentCount++;
                    details.push({ request_id: request.id, tenant_id: request.tenant_id, tenant_name: request.tenant_name, issue_type: request.issue_type });
                } else {
                    // Nothing could be delivered: release the claim so it is retried in an hour.
                    await connection.execute(`UPDATE maintenance_requests SET completion_reminder_sent = 0 WHERE id = ?`, [request.id]);
                }
            } catch (error) {
                console.error(`Failed to send completion reminder for request ${request.id}:`, error);
            }
        }

        return { sent: sentCount, details };

    } catch (error) {
        console.error("Check And Send Completion Reminders Error:", error);
        throw error;
    } finally {
        if (haveLock) await connection.query(`SELECT RELEASE_LOCK(?)`, [REMINDER_LOCK]).catch(() => {});
        connection.release();
        reminderRunning = false;
    }
};


// ============================================================
// Forward the details of a request to ANY phone number (plumber, electrician, caretaker ...).
// Sent from the server over WhatsApp, falling back to SMS - never through the admin's own phone.
// ============================================================
const STATUS_LABELS = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

const forwardRequest = async (requestId, { phone, countryCode = null, name = null, note = null, markInProgress = false }, admin = {}, req = null) => {
    const to = normalizePhone(phone, countryCode);
    if (!to) {
        throw Object.assign(new Error("Enter a valid phone number including the country code (for example +91 98765 43210)."), { status: 400 });
    }

    const request = await MaintenanceModel.getRequestById(requestId);
    if (!request) throw Object.assign(new Error("Maintenance request not found"), { status: 404 });

    // Accurate details: the tenant's international number and the PG the ROOM belongs to
    const [[tenantRow]] = await db.execute(`SELECT country_code FROM tenants WHERE id = ? LIMIT 1`, [request.tenant_id]);
    const tenantPhone = normalizePhone(request.tenant_phone, tenantRow?.country_code) || request.tenant_phone || null;
    const [[roomRow]] = await db.execute(
        `SELECT p.name AS pg_name FROM rooms r LEFT JOIN floors fl ON fl.id = r.floor_id LEFT JOIN pgs p ON p.id = fl.pg_id WHERE r.id = ? LIMIT 1`,
        [request.room_id]
    );

    const cleanName = name ? String(name).trim().slice(0, 80) : null;
    const cleanNote = note ? String(note).trim().slice(0, 300) : null;

    const forwardId = await MaintenanceForward.create({ request_id: request.id, admin_id: admin.id || null, to_phone: to, to_name: cleanName, note: cleanNote });

    const result = await messagingService.sendToNumber({
        phone: to,
        name: cleanName,
        type: "maintenance_forward",
        forwardId,
        data: {
            id: request.id,
            issueType: request.issue_type,
            pgName: roomRow?.pg_name || request.pg_name || null,
            roomNumber: request.room_number,
            tenantName: request.tenant_name,
            tenantPhone,
            serviceDate: request.service_date,
            freeTime: request.free_time,
            statusLabel: STATUS_LABELS[request.status] || request.status,
            description: request.description,
            imageUrl: request.image_url,
            note: cleanNote,
            senderName: admin.name || null,
            recipientName: cleanName,
        },
    });

    if (result.duplicate) {
        await MaintenanceForward.update(forwardId, { status: "sent", error_message: "Duplicate click ignored" }).catch(() => {});
    }

    let statusUpdated = false;
    let statusWarning = null;
    if (result.ok && markInProgress && request.status === "pending") {
        try {
            await updateRequestStatus(request.id, "in_progress");
            statusUpdated = true;
        } catch (e) {
            statusWarning = "The message was sent, but the request could not be marked In Progress.";
        }
    }

    if (req) {
        try {
            const ActivityService = require("./activity.log.service");
            ActivityService.adminAction(req, "maintenance_forwarded", "maintenance", {
                entityType: "maintenance_request", entityId: request.id,
                metadata: { to: maskPhone(to), channel: result.channel, ok: result.ok },
            });
        } catch { /* activity log is best-effort */ }
    }

    return { forward_id: forwardId, ...result, status_updated: statusUpdated, warning: statusWarning };
};

const getForwards = async (requestId) => MaintenanceForward.listByRequest(requestId);
const getRecentForwardRecipients = async () => MaintenanceForward.recentRecipients();

const deleteRequest = async (requestId) => {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const request = await MaintenanceModel.getRequestById(requestId);
        if (!request) {
            throw new Error("Maintenance request not found");
        }

        // Delete image from Cloudinary if exists
        if (request.image_public_id) {
            try {
                await deleteFile(request.image_public_id, request.image_resource_type);
            } catch (error) {
                console.error("Failed to delete image from Cloudinary:", error);
            }
        }

        const deleted = await MaintenanceModel.deleteRequest(connection, requestId);

        await connection.commit();
        return deleted > 0;

    } catch (error) {
        await connection.rollback();
        console.error("Delete Request Error:", error);
        throw error;

    } finally {
        connection.release();
    }
};

module.exports = {
    createMaintenanceRequest,
    getTenantRequests,
    getTenantStats,
    getRequestById,
    getAllRequests,
    getAdminStats,
    updateRequestStatus,
    completeRequestByTenant,        // NEW
    checkAndSendCompletionReminders, // NEW
    deleteRequest,
    forwardRequest,
    getForwards,
    getRecentForwardRecipients
};