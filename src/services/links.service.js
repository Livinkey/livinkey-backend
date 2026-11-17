/**
 * Smart links – short, expiring https links that work from WhatsApp, SMS and e-mail.
 *
 *   https://api.livinkey.com/l/Ab3dE5gH9k
 *
 * WhatsApp only turns plain https URLs into tappable links (custom schemes such as livinkey:// or
 * upi:// are NOT clickable there). So every message carries an https smart link; the landing page
 * (routes/links.routes.js) then opens the Livinkey app on the right screen, offers the Play Store
 * when the app is missing, or shows the "Pay now" buttons for a bill.
 *
 * A link never logs anybody in. Opening a screen in the app uses the person's own session; if they
 * are signed out the app asks them to log in first and then continues to the screen.
 */
const crypto = require("crypto");
const db = require("../config/db");
const { API_URL, ADMIN_URL, APP_STORE_URL } = require("../utils/links");

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = (len = 10) => {
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
};

// screens the app understands (see lib/services/deep_link_service.dart)
const APP_TARGETS = new Set(["home", "payments", "maintenance", "documents", "notifications", "agreements", "pay"]);

/**
 * Create a smart link. Returns "" (never throws) if it cannot be created, so a message is never
 * blocked because of a link.
 */
const createLink = async ({ userId = null, userType = null, target = "home", params = {}, redirectUrl = null, ttlHours = 72, maxUses = 20 } = {}) => {
    try {
        if (!APP_TARGETS.has(target)) target = "home";
        const hours = Number(process.env.LINK_TTL_HOURS) > 0 ? Number(process.env.LINK_TTL_HOURS) : ttlHours;
        for (let attempt = 0; attempt < 4; attempt++) {
            const code = makeCode();
            try {
                await db.execute(
                    `INSERT INTO short_links (code, user_id, user_type, target, params, redirect_url, max_uses, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
                    [code, userId, userType, target, JSON.stringify(params || {}), redirectUrl, maxUses, Math.round(hours * 60)]
                );
                return `${API_URL}/l/${code}`;
            } catch (e) {
                if (e.code !== "ER_DUP_ENTRY") throw e;
            }
        }
    } catch (e) {
        console.error("[links] could not create link:", e.message);
    }
    return "";
};

/** Open links for the admin console are plain pages – no smart link needed. */
const adminPage = (page, query = "") => `${ADMIN_URL}/${page}.html${query ? `?${query}` : ""}`;

const getLink = async (code) => {
    if (!/^[A-Za-z0-9]{6,16}$/.test(String(code || ""))) return null;
    const [rows] = await db.execute(`SELECT *, (expires_at < NOW()) AS is_expired FROM short_links WHERE code = ? LIMIT 1`, [code]);
    const row = rows[0];
    if (!row) return null;
    let params = {};
    try { params = row.params ? JSON.parse(row.params) : {}; } catch { params = {}; }
    return { ...row, params, expired: !!row.is_expired || row.uses >= row.max_uses };
};

const markUsed = async (code) => {
    await db.execute(`UPDATE short_links SET uses = uses + 1 WHERE code = ?`, [code]).catch(() => {});
};

const purgeExpired = async () => {
    await db.execute(`DELETE FROM short_links WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`).catch(() => {});
    await db.execute(`DELETE FROM message_dedup WHERE created_at < DATE_SUB(NOW(), INTERVAL 2 DAY)`).catch(() => {});
};

module.exports = { createLink, getLink, markUsed, purgeExpired, adminPage, APP_TARGETS, APP_STORE_URL };
