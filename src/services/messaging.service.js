/**
 * Messaging service – ONE place that delivers every OTP, bill, fine, reminder, notice,
 * inbox reply and forwarded maintenance request.
 *
 *   WhatsApp (main number) -> WhatsApp (tenant's other number) -> SMS -> e-mail
 *
 * Bigtos cannot tell us whether a number is really on WhatsApp (no delivery receipts), so "accepted"
 * is NOT proof the tenant saw the message. To make sure it is seen:
 *   - numbers: the tenant's main number first, then their own second number (international_phone).
 *     The PARENT's number is never used.
 *   - e-mail copy: sent in addition to WhatsApp (MESSAGING_EMAIL_COPY = always | critical | fallback,
 *     default "always"; "text" inbox replies never get a copy).
 *   - critical messages (OTP, passwords / welcome, anything flagged sensitive): WhatsApp goes to BOTH
 *     numbers, not just the first one that accepts.
 *
 * "Failed" is detected in two ways:
 *   1. Bigtos rejects the request straight away (bad number, invalid key, no credit, template
 *      misconfigured ...)                                      -> next channel is tried immediately.
 *   2. (Only if the provider ever posts delivery receipts) a late failure arrives through
 *      processStatusCallback() and is sent on the next channel. Bigtos does not send receipts today,
 *      so nothing is parked for a later fallback and accepted messages are recorded as "sent".
 *
 * The text for each channel comes from messaging.templates.js so the wording is identical
 * everywhere. Secrets (OTPs) are never written to the database in plain text: the conversation
 * inbox gets a safe preview, and the "what to send if this fails" payload is encrypted and wiped
 * as soon as the message is delivered or the chain ends.
 */

const Conversation = require("../models/conversation.model");
const Message = require("../models/message.model");
const Delivery = require("../models/message.delivery.model");
const { compose } = require("./messaging.templates");
const { sendWhatsApp } = require("./whatsapp.service");
const { sendSms } = require("./sms.service");
const bigtos = require("./bigtos.client");
const mailService = require("./mail.service");
const { resolveContact } = require("./contacts.service");
const { normalizePhone, normalizeInternationalOnly, maskPhone, digitsOnly } = require("../utils/phone");
const secretBox = require("../utils/secret.box");
const crypto = require("crypto");
const db = require("../config/db");
const linksService = require("./links.service");

const ALL_CHANNELS = ["whatsapp", "sms", "email"];
const DEDUP_WINDOW_MS = 8000;
const recentSends = new Map(); // key -> timestamp

const LABEL = { whatsapp: "WhatsApp", sms: "SMS", email: "Email" };

/* ------------------------------------------------------------------ helpers */

const configuredOrder = () => {
    // MESSAGING_CHANNELS=whatsapp,sms,email  (remove one to switch a channel off, e.g. while SMS
    // sender registration is pending). Unknown names are ignored; order is the fallback order.
    const raw = String(process.env.MESSAGING_CHANNELS || "").toLowerCase().split(",").map((s) => s.trim());
    const list = raw.filter((c) => ALL_CHANNELS.includes(c));
    return list.length ? [...new Set(list)] : ALL_CHANNELS;
};

const userTypeOf = (user = {}) => {
    const r = String(user.userType || user.user_type || user.role || "").toLowerCase();
    if (r === "super_admin" || r === "admin") return "admin";
    if (r === "guest") return "guest";
    return "tenant";
};

const normalizeUserType = (t) => {
    const s = String(t || "").toLowerCase();
    if (s === "super_admin") return "admin";
    return ["tenant", "guest", "admin"].includes(s) ? s : "tenant";
};

const isDuplicateSend = (key) => {
    const now = Date.now();
    for (const [k, ts] of recentSends.entries()) if (now - ts > DEDUP_WINDOW_MS) recentSends.delete(k);
    if (recentSends.has(key)) return true;
    recentSends.set(key, now);
    return false;
};

const mapProviderStatus = (s) => {
    const v = String(s || "").toLowerCase();
    if (["failed", "undelivered", "canceled"].includes(v)) return "failed";
    if (v === "read") return "read";
    if (v === "delivered") return "delivered";
    if (["sent", "partially_delivered"].includes(v)) return "sent";
    return "queued"; // queued | accepted | scheduled | sending | receiving
};

const tail8 = (v) => digitsOnly(v).slice(-8);


/**
 * Cross-process duplicate guard. The in-memory map above only protects ONE node process; with two
 * workers (or a restart overlapping a cron run) the same reminder used to go out several times
 * within the same minute. This claims the key in MySQL: only the first caller inside the window wins.
 * Fails open (sends) if the database cannot be reached – a duplicate is better than a lost OTP.
 */
const claimInDb = async (key, windowSec) => {
    const hash = crypto.createHash("sha256").update(String(key)).digest("hex");
    try {
        await db.execute(`DELETE FROM message_dedup WHERE dedup_hash = ? AND created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`, [hash, Math.max(1, Math.round(windowSec))]);
        const [r] = await db.execute(`INSERT IGNORE INTO message_dedup (dedup_hash) VALUES (?)`, [hash]);
        return r.affectedRows === 1;
    } catch (e) {
        console.error("[messaging] dedup table unavailable, sending anyway:", e.message);
        return true;
    }
};

/** Name / PG / room of a tenant – put at the top of every message so it is clear who it is about. */
const tenantHeaderOf = async (userId, kind) => {
    if (!userId || kind === "admin") return null;
    try {
        if (kind === "guest") {
            const [[g]] = await db.execute(`SELECT full_name FROM tenants WHERE id = ? LIMIT 1`, [userId]);
            return g ? { name: g.full_name, pg: null, room: null } : null;
        }
        const [[t]] = await db.execute(
            `SELECT t.full_name, p.name AS pg_name, r.room_number
               FROM tenants t
               LEFT JOIN tenant_details td ON td.tenant_id = t.id
               LEFT JOIN pgs p ON p.id = td.pg_id
               LEFT JOIN rooms r ON r.id = td.room_id
              WHERE t.id = ? LIMIT 1`, [userId]);
        return t ? { name: t.full_name, pg: t.pg_name || null, room: t.room_number || null } : null;
    } catch (e) {
        console.error("[messaging] tenant header lookup failed:", e.message);
        return null;
    }
};

const headerText = (h) => (h ? [h.name, [h.pg, h.room ? `Room ${h.room}` : null].filter(Boolean).join(" · ")].filter(Boolean) : []);

const SYSTEM_NOTE = "Sent from system";
const footerFor = (origin, adminName) =>
    origin === "admin" ? `${SYSTEM_NOTE} · Livinkey admin${adminName ? ` (${adminName})` : ""}` : null;

/**
 * Add the tenant header, the app link and the "sent from system" footer to every channel's text.
 * WhatsApp: header in bold, footer in italics (the weakest style WhatsApp offers).
 */
const decorate = (composed, { header, link, footer, expiresAt }) => {
    const hl = headerText(header);
    const out = { ...composed, whatsapp: { ...composed.whatsapp }, email: { ...composed.email } };

    let wa = out.whatsapp.text || "";
    if (hl.length) wa = `*${hl[0]}*${hl[1] ? `\n${hl[1]}` : ""}\n\n${wa}`;
    if (link) wa += `\n\n${link.label || "Open in app"}: ${link.url}`;
    if (expiresAt) wa += `\n\n_Valid until ${fmtWhen(expiresAt)}_`;
    if (footer) wa += `\n\n_(${footer})_`;
    out.whatsapp.text = wa;

    let sms = out.sms || "";
    if (hl.length) sms = `${hl.join(", ")}: ${sms}`;
    if (link) sms += ` ${link.url}`;
    out.sms = sms;

    let em = out.email.text || "";
    if (hl.length) em = `${hl.join(" · ")}\n\n${em}`;
    out.email = { ...out.email, text: em, ctaUrl: link?.url || null, ctaLabel: link?.label || null, footerNote: footer || null };
    return out;
};

const fmtWhen = (d) => {
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata" });
};

/** link may be a ready URL string, or { target, params, redirectUrl, label } for a smart link. */
const buildLink = async (link, { userId, userType }) => {
    if (!link) return null;
    if (typeof link === "string") return { url: link, label: "Open" };
    if (link.url) return { url: link.url, label: link.label || "Open" };
    const url = await linksService.createLink({ userId, userType, target: link.target || "home", params: link.params || {}, redirectUrl: link.redirectUrl || null, ttlHours: link.ttlHours });
    return url ? { url, label: link.label || "Open in app" } : null;
};

/**
 * Fill in country code / e-mail / name from the user's own record when the caller didn't pass them, and
 * collect every number we may use for this person, in order: main number first, then their own other
 * number. Parent numbers are never included.
 * @returns {{e164, numbers: {e164, role}[], email, name}}
 */
const resolveRecipient = async ({ userId, userType, phone, countryCode, email, name, useOtherNumbers = true }) => {
    let ph = phone, cc = countryCode, em = email, nm = name, other = null;
    if (userId && Number(userId) > 0) {
        const c = await resolveContact(userId, userType);
        if (c) {
            if (!ph) ph = c.phone;
            if (!cc && c.countryCode && (!phone || tail8(phone) === tail8(c.phone))) cc = c.countryCode;
            if (!em) em = c.email;
            if (!nm) nm = c.name;
            other = c.otherPhone || null;
        }
    }
    const main = normalizePhone(ph, cc);
    const numbers = [];
    if (main) numbers.push({ e164: main, role: "main" });
    if (useOtherNumbers && other) {
        const second = normalizeInternationalOnly(other);
        if (second && !numbers.some((n) => n.e164 === second)) numbers.push({ e164: second, role: "other" });
        else if (!second) console.warn(`[messaging] user ${userId}: second number has no country code, skipped`);
    }
    return { e164: main, numbers, email: em || null, name: nm || "there" };
};

/**
 * Ordered delivery steps. Phone steps are tried number by number (main, then other); e-mail is last.
 * Each step is { channel, to? }.
 */
const buildChain = ({ e164, numbers = null, email, preference, skipEmail }) => {
    const order = configuredOrder();
    const nums = numbers && numbers.length ? numbers.map((n) => n.e164) : e164 ? [e164] : [];
    const chain = [];
    for (const ch of order) {
        if (ch === "whatsapp" && preference !== "email" && bigtos.isWhatsAppConfigured()) nums.forEach((to) => chain.push({ channel: ch, to }));
        if (ch === "sms" && preference !== "email" && bigtos.isSmsConfigured()) nums.forEach((to) => chain.push({ channel: ch, to }));
        if (ch === "email" && email && !skipEmail) chain.push({ channel: ch });
    }
    return chain;
};

const stepOf = (c) => (typeof c === "string" ? { channel: c } : c);
const channelsOf = (chain) => chain.map((c) => stepOf(c).channel);

/** Should an e-mail copy go out even when WhatsApp accepted the message? */
const wantsEmailCopy = ({ type, critical, emailCopy }) => {
    if (typeof emailCopy === "boolean") return emailCopy;
    if (type === "text") return false; // inbox reply inside a live WhatsApp conversation
    const mode = String(process.env.MESSAGING_EMAIL_COPY || "always").toLowerCase();
    if (mode === "fallback") return false;
    if (mode === "critical") return critical || type === "bill" || type === "fine";
    return true;
};

const safeTemplateData = (td = {}) => {
    const { otp, billData, ...rest } = td || {};
    return rest;
};

const iso = () => new Date().toISOString();

const failureSummary = (attempts) =>
    attempts.filter((a) => !a.ok).map((a) => `${LABEL[a.channel] || a.channel}: ${a.error || "failed"}`).join("; ");

/* --------------------------------------------------------------- one channel */

const sendEmailStep = async (payload, richEmail) => {
    if (!payload.emailTo) throw new Error("No e-mail address.");
    if (payload.emailKind === "otp" && payload.otp) {
        return mailService.sendOTPEmail(payload.emailTo, payload.otp, payload.purpose || "Login");
    }
    if (richEmail) return richEmail();
    return mailService.sendCustomAdminNotificationEmail(
        payload.emailTo,
        payload.name || "there",
        payload.email.title,
        payload.email.text,
        payload.adminName || "Livinkey",
        { ctaUrl: payload.email.ctaUrl, ctaLabel: payload.email.ctaLabel, footerNote: payload.email.footerNote }
    );
};

const executeStep = async (channel, payload, richEmail) => {
    if (channel === "whatsapp") return sendWhatsApp(payload.e164, payload.whatsapp);
    if (channel === "sms") return sendSms(payload.e164, payload.sms);
    if (channel === "email") return sendEmailStep(payload, richEmail);
    throw new Error(`Unknown channel ${channel}`);
};

/**
 * Walk the delivery steps.
 *  - Normal message: stop phone attempts at the first number/channel that accepts it.
 *  - Critical message (fanout): WhatsApp is sent to every number.
 *  - SMS only replaces a WhatsApp that failed everywhere.
 *  - E-mail runs when nothing else took the message, or ALWAYS when emailAlways is set (a copy).
 * @returns {{channel, status, sid, pending:Array, attempts, ok:boolean, emailSent:boolean}}
 */
const runChain = async ({ chain, payload, attempts = [], richEmail = null, emailAlways = false, fanout = false }) => {
    let accepted = null; // first phone step that took the message
    let acceptedAt = -1;
    let whatsappAccepted = false;
    let emailSent = false;

    for (let i = 0; i < chain.length; i++) {
        const step = stepOf(chain[i]);
        const channel = step.channel;
        if (channel === "email") {
            if (accepted && !emailAlways) continue;
        } else {
            if (accepted && !fanout) continue; // one number is enough for an ordinary message
            if (channel === "sms" && whatsappAccepted) continue; // SMS is only the replacement for a failed WhatsApp
        }
        const to = step.to || payload.e164 || null;
        try {
            const r = await executeStep(channel, { ...payload, e164: to }, richEmail);
            attempts.push({ channel, to: to ? maskPhone(to) : undefined, ok: true, sid: r?.sid || null, mode: r?.mode || null, reply: r?.providerReply || null, at: iso() });
            if (channel !== "email") console.log(`[messaging] ${LABEL[channel]} accepted${payload.tag ? ` (${payload.tag})` : ""}: ${r?.providerReply || "no reply body"}`);
            if (channel === "email") emailSent = true;
            else {
                if (!accepted) { accepted = { channel, status: mapProviderStatus(r.status), sid: r.sid }; acceptedAt = i; }
                if (channel === "whatsapp") whatsappAccepted = true;
            }
        } catch (err) {
            const d = bigtos.describeError(err);
            attempts.push({ channel, to: to ? maskPhone(to) : undefined, ok: false, error: d.message, code: d.code || null, at: iso() });
            console.error(`[messaging] ${LABEL[channel]} failed${payload.tag ? ` (${payload.tag})` : ""}:`, d.code ? `${d.code} ` : "", d.message);
        }
    }

    if (accepted) {
        // Bigtos has no delivery receipts, so there is nobody to resume the chain later: park nothing.
        const pending = bigtos.HAS_STATUS_CALLBACKS ? chain.slice(acceptedAt + 1) : [];
        return { ok: true, channel: accepted.channel, status: accepted.status, sid: accepted.sid, pending, attempts, emailSent };
    }
    if (emailSent) return { ok: true, channel: "email", status: "sent", sid: null, pending: [], attempts, emailSent };
    return { ok: false, channel: null, status: "failed", sid: null, pending: [], attempts, emailSent: false };
};

/* ----------------------------------------------------- persistence of a result */

const sealPending = (pending, payload) => (pending.length ? secretBox.seal({ chain: pending, payload }) : null);

/**
 * Record the outcome on the message row / delivery row / forward row.
 * `target` is { messageId } or { forwardId }.
 */
const persistOutcome = async ({ target, outcome, payload, deliveryId = null }) => {
    const lastErr = outcome.attempts.filter((a) => !a.ok).slice(-1)[0] || null;

    let id = deliveryId;
    if (outcome.ok && outcome.channel !== "email") {
        const fields = {
            channel: outcome.channel,
            status: outcome.status,
            external_id: outcome.sid,
            pending_chain: sealPending(outcome.pending, payload),
            attempts: outcome.attempts,
            error_code: null,
            error_message: null,
        };
        if (id) await Delivery.update(id, fields);
        else id = await Delivery.create({ message_id: target.messageId, forward_id: target.forwardId, ...fields });
    } else if (id) {
        // chain finished on e-mail, or everything failed: close the delivery row and wipe the payload
        await Delivery.update(id, {
            channel: outcome.channel || "email",
            status: outcome.ok ? "sent" : "failed",
            pending_chain: null,
            attempts: outcome.attempts,
            error_code: outcome.ok ? null : lastErr?.code || null,
            error_message: outcome.ok ? null : lastErr?.error || null,
        });
    }

    if (target.messageId) {
        const row = await Message.findOne({ id: target.messageId });
        const meta = { ...Message.parseMetadata(row?.metadata), attempts: outcome.attempts, fallbackUsed: outcome.attempts.some((a) => !a.ok) };
        await Message.update(target.messageId, {
            channel: outcome.channel || row?.channel || "email",
            status: outcome.ok ? outcome.status : "failed",
            external_id: outcome.sid || null,
            metadata: meta,
        });
    }
    if (target.forwardId) {
        const MaintenanceForward = require("../models/maintenance.forward.model");
        await MaintenanceForward.update(target.forwardId, {
            channel: outcome.channel || null,
            status: outcome.ok ? outcome.status : "failed",
            error_message: outcome.ok ? null : failureSummary(outcome.attempts).slice(0, 500),
        });
    }
    return id;
};

/* ------------------------------------------------------------------ main API */

/**
 * Send one message to a Livinkey user.
 * Rejects only when NO channel could take the message.
 */
const sendMessage = async ({
    userId = null,
    userType = "tenant", // tenant | guest | admin
    phone = null,
    countryCode = null,
    email = null,
    name = null,
    channelPreference = "auto", // auto (WhatsApp -> SMS -> e-mail) | email
    type = "text", // otp | bill | fine | efrro | custom | reminder | text
    subject = null,
    title = null,
    body = null,
    templateData = {},
    metadata = {},
    skipEmail = false, // legacy: only for callers that really must not send e-mail
    richEmail = null, // optional () => Promise – dedicated e-mail used ONLY if WhatsApp (and SMS) could not take the message
    origin = "system", // "admin" = typed/sent by an admin from the admin panel -> gets the "Sent from system" footer
    adminName = null,
    link = null, // URL string | { target, params, redirectUrl, label } -> smart link added to every channel
    expiresAt = null, // OTPs / payment QR: the admin inbox relabels the message "Expired" once this time passes
    dedupKey = null, // explicit idempotency key (e.g. "maint-reminder:123"); default = hash of the content
    dedupWindowSec = null,
    header = true, // start tenant messages with name / PG / room
    sensitive = false, // true for passwords etc.: the admin inbox keeps only previewText, never the text
    previewText = null,
    critical = false, // OTP / passwords: WhatsApp goes to every registered number of the person, not just the first
    emailCopy = undefined, // true/false forces an e-mail copy on/off; default follows MESSAGING_EMAIL_COPY
}) => {
    const kind = normalizeUserType(userType);
    const results = {
        whatsapp: null, sms: null, email: null,
        channel: null, primaryChannel: null, fallbackUsed: false,
        status: null, attempts: [],
        conversationId: null, messageId: null, skippedDuplicate: false,
    };

    // Replies typed in the WhatsApp inbox go to the number that wrote to us, nowhere else.
    const rcpt = await resolveRecipient({ userId, userType: kind, phone, countryCode, email, name, useOtherNumbers: type !== "text" });
    const isCritical = !!(critical || sensitive || type === "otp");
    const emailAlways = !skipEmail && wantsEmailCopy({ type, critical: isCritical, emailCopy });
    const fanout = isCritical && rcpt.numbers.length > 1;
    const data = { ...(templateData || {}), title: title || subject || templateData?.title, body: body ?? templateData?.body ?? templateData?.message };
    const hdr = header && type !== "otp" ? await tenantHeaderOf(userId, kind) : null;
    const lnk = await buildLink(link, { userId, userType: kind });
    const composed = decorate(compose(type, data, { name: rcpt.name }), { header: hdr, link: lnk, footer: footerFor(origin, adminName), expiresAt: type === "otp" ? null : expiresAt });

    const autoKey = [userId || "", rcpt.numbers.map((n) => n.e164).join(","), rcpt.email || "", type, composed.whatsapp.text].join("|");
    const key = dedupKey ? `${dedupKey}|${userId || rcpt.e164 || rcpt.email || ""}` : autoKey;
    const windowSec = Number(dedupWindowSec) > 0 ? Number(dedupWindowSec) : origin === "admin" ? 20 : type === "otp" ? 30 : 120;
    if (isDuplicateSend(key) || !(await claimInDb(key, windowSec))) {
        results.skippedDuplicate = true;
        console.warn("[messaging] duplicate send skipped:", type, userId || rcpt.e164);
        return results;
    }

    const chain = buildChain({ e164: rcpt.e164, numbers: rcpt.numbers, email: rcpt.email, preference: channelPreference, skipEmail });

    // ---- conversation + message row (so the admin inbox shows it, and deliveries can link to it)
    let messageId = null;
    try {
        if (userId) {
            let conv = await Conversation.findOne({ user_id: userId, user_type: kind });
            if (!conv) {
                conv = await Conversation.create({
                    user_id: userId, user_type: kind, phone: rcpt.e164, email: rcpt.email,
                    name: rcpt.name === "there" ? null : rcpt.name, last_message_at: new Date(), unread_count: 0,
                });
            } else {
                await Conversation.update(conv.id, {
                    last_message_at: new Date(),
                    phone: rcpt.e164 || conv.phone,
                    email: rcpt.email || conv.email,
                });
            }
            results.conversationId = conv.id;
            const rec = await Message.create({
                conversation_id: conv.id,
                direction: "outbound",
                channel: (chain[0] && stepOf(chain[0]).channel) || "email",
                message_type: type,
                content: type === "otp" || sensitive ? (previewText || composed.preview) : composed.whatsapp.text || composed.preview,
                status: "queued",
                metadata: { ...metadata, type, chain: channelsOf(chain), emailCopy: emailAlways, origin, expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined, templateData: safeTemplateData(templateData) },
            });
            messageId = rec.id;
            results.messageId = messageId;
        }
    } catch (logErr) {
        console.error("[messaging] could not log to conversation:", logErr.message);
    }

    const payload = {
        tag: `${type}${userId ? `#${userId}` : ""}`,
        type, name: rcpt.name, e164: rcpt.e164, adminName,
        emailTo: rcpt.email, email: composed.email,
        whatsapp: composed.whatsapp, sms: composed.sms,
        emailKind: type === "otp" ? "otp" : null,
        ...(type === "otp" ? { otp: data.otp, purpose: data.purpose || "Login" } : {}),
    };

    if (!chain.length) {
        const why = !rcpt.numbers.length && !rcpt.email ? "no valid phone number or e-mail on file"
            : skipEmail && !bigtos.isWhatsAppConfigured() && !bigtos.isSmsConfigured() ? "WhatsApp/SMS are not configured"
            : "no usable channel";
        if (messageId) await Message.update(messageId, { status: "failed", metadata: { ...metadata, type, error: why } }).catch(() => {});
        throw new Error(`Message not sent: ${why}.`);
    }

    const outcome = await runChain({ chain, payload, richEmail, emailAlways, fanout });
    if (messageId) {
        try { await persistOutcome({ target: { messageId }, outcome, payload }); }
        catch (e) { console.error("[messaging] could not save delivery state:", e.message); }
    }

    for (const a of outcome.attempts) {
        if (a.ok) results[a.channel] = { success: true, sid: a.sid || undefined, status: outcome.status };
        else if (!results[a.channel]?.success) results[a.channel] = { success: false, error: a.error };
    }
    results.emailSent = !!outcome.emailSent;
    results.channel = results.primaryChannel = outcome.channel;
    results.status = outcome.status;
    results.attempts = outcome.attempts;
    results.fallbackUsed = outcome.attempts.some((a) => !a.ok);

    if (!outcome.ok) throw new Error(`Could not deliver the message. ${failureSummary(outcome.attempts)}`);
    return results;
};

/**
 * Send to any phone number (not a Livinkey user) – used to forward maintenance details.
 * WhatsApp -> SMS only (there is no e-mail address). Tracked through message_deliveries.forward_id.
 */
const sendToNumber = async ({ phone, countryCode = null, name = null, type = "custom", data = {}, forwardId = null }) => {
    const e164 = normalizePhone(phone, countryCode);
    if (!e164) throw Object.assign(new Error("That phone number is not valid."), { status: 400 });
    const composed = compose(type, data, { name: name || "there" });
    const waLink = `https://wa.me/${digitsOnly(e164)}?text=${encodeURIComponent(composed.whatsapp.text || "")}`;

    // double-click / retry guard: the same details to the same number within 15 s are sent once
    const dupKey = ["fwd", type, e164, data.id || "", data.note || "", forwardId ? "" : composed.whatsapp.text.slice(0, 80)].join("|");
    if (!(await claimInDb(dupKey, 15))) {
        return { ok: true, duplicate: true, to: e164, channel: null, status: "sent", attempts: [], fallbackUsed: false, error: null, waLink };
    }
    const chain = buildChain({ e164, numbers: [{ e164, role: "main" }], email: null, preference: "auto", skipEmail: true });
    if (!chain.length) throw Object.assign(new Error("WhatsApp and SMS are not configured on the server (Bigtos settings missing: BIGTOS_API_KEY)."), { status: 503 });

    const payload = { tag: `${type}->${maskPhone(e164)}`, type, name: name || "there", e164, whatsapp: composed.whatsapp, sms: composed.sms, email: composed.email };
    const outcome = await runChain({ chain, payload });
    if (forwardId) await persistOutcome({ target: { forwardId }, outcome, payload });
    return {
        ok: outcome.ok, to: e164, channel: outcome.channel, status: outcome.status, waLink,
        attempts: outcome.attempts, fallbackUsed: outcome.attempts.some((a) => !a.ok),
        error: outcome.ok ? null : failureSummary(outcome.attempts),
    };
};

/* ------------------------------------------------ provider status callback logic (unused by Bigtos) */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Called for every delivery-status callback a provider posts (Bigtos does not post any).
 *  - progress (sent / delivered / read) updates the message tick marks;
 *  - failure (failed / undelivered) hands the message to the next channel in the chain.
 */
const processStatusCallback = async ({ sid, status, errorCode = null, errorMessage = null }) => {
    if (!sid) return { handled: false };
    const mapped = mapProviderStatus(status);

    // The callback can (rarely) beat our own database insert – give it a moment.
    let d = await Delivery.findByExternalId(sid);
    for (let i = 0; !d && i < 3; i++) {
        await sleep(800);
        d = await Delivery.findByExternalId(sid);
    }

    if (!d) {
        // older rows sent before deliveries existed
        const m = await Message.findOne({ external_id: sid });
        if (m) await Message.advanceStatus(m.id, mapped, { statusCallback: { status, errorCode, errorMessage, at: iso() } });
        return { handled: !!m };
    }

    if (mapped !== "failed") {
        const rank = Delivery.RANK;
        if ((rank[mapped] ?? 0) > (rank[d.status] ?? 0)) {
            const fields = { status: mapped };
            if (mapped === "delivered" || mapped === "read") fields.pending_chain = null; // done – wipe the parked payload
            await Delivery.update(d.id, fields);
        }
        if (d.message_id) await Message.advanceStatus(d.message_id, mapped);
        if (d.forward_id) {
            const MaintenanceForward = require("../models/maintenance.forward.model");
            await MaintenanceForward.advance(d.forward_id, mapped);
        }
        return { handled: true, status: mapped };
    }

    // ---------- failure: try the next channel (exactly one worker wins the claim)
    if (!(await Delivery.claimFallback(d.id, sid))) return { handled: true, duplicate: true };

    let attempts = [];
    try { attempts = JSON.parse(d.attempts || "[]"); } catch { attempts = []; }
    attempts.push({ channel: d.channel, ok: false, async: true, error: errorMessage || `Provider status: ${status}`, code: errorCode ? String(errorCode) : null, at: iso() });
    console.error(`[messaging] ${LABEL[d.channel] || d.channel} delivery failed (${errorCode || status}) – falling back`, d.message_id ? `message ${d.message_id}` : `forward ${d.forward_id}`);

    const sealed = secretBox.open(d.pending_chain);
    const target = { messageId: d.message_id || null, forwardId: d.forward_id || null };

    if (!sealed || !Array.isArray(sealed.chain) || !sealed.chain.length) {
        await persistOutcome({ target, outcome: { ok: false, channel: d.channel, status: "failed", sid, pending: [], attempts }, payload: null, deliveryId: d.id });
        return { handled: true, exhausted: true };
    }

    const outcome = await runChain({ chain: sealed.chain, payload: sealed.payload, attempts });
    await persistOutcome({ target, outcome, payload: sealed.payload, deliveryId: d.id });
    return { handled: true, fellBackTo: outcome.channel, ok: outcome.ok };
};

/* ------------------------------------------------------------ convenience API */

const contactFields = (user) => ({
    userId: user.id,
    userType: userTypeOf(user),
    phone: user.phone,
    countryCode: user.country_code || user.countryCode || null,
    email: user.email,
    name: user.full_name || user.name || null,
});

const sendOTP = (user, otp, purpose = "Login", opts = {}) =>
    sendMessage({ ...contactFields(user), type: "otp", critical: true, templateData: { otp, purpose }, expiresAt: new Date(Date.now() + 5 * 60 * 1000), ...opts });

const sendBill = (user, billData, opts = {}) =>
    sendMessage({ ...contactFields(user), type: "bill", templateData: billData, ...opts });

const sendFine = (user, fineData, opts = {}) =>
    sendMessage({ ...contactFields(user), type: "fine", templateData: fineData, ...opts });

const sendCustom = (user, title, message, opts = {}) =>
    sendMessage({ ...contactFields(user), type: "custom", title, body: message, ...opts });

module.exports = {
    sendMessage,
    sendToNumber,
    sendOTP,
    sendBill,
    sendFine,
    sendCustom,
    processStatusCallback,
    normalizePhone,
    userTypeOf,
    // exported for tests
    _internals: { buildChain, runChain, mapProviderStatus, configuredOrder, resolveRecipient, wantsEmailCopy },
};
