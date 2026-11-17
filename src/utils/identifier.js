/**
 * Login identifier = e-mail OR phone number.
 *
 * Every auth handler in Livinkey keys on the account's e-mail. Rather than touching each handler,
 * identifierMiddleware() turns a phone number typed in the `email` / `identifier` field into the
 * account's e-mail BEFORE the handler runs, so login, forgot-password, OTP verify/resend and
 * reset-password all accept "phone or e-mail" with no further change.
 *
 * Unknown / ambiguous numbers are left untouched (the handler then answers with its normal
 * "invalid credentials" message, so accounts can't be probed by number).
 */
const db = require("../config/db");
const { normalizePhone, digitsOnly } = require("./phone");

const looksLikeEmail = (v) => /@/.test(String(v || ""));

const loginTail = (digits) => digits.slice(-8);

/** @returns {Promise<string|null>} the account e-mail for a phone number, or null */
const emailForPhone = async (kind, raw) => {
    const digits = digitsOnly(raw);
    if (digits.length < 7) return null;
    const tail = loginTail(digits);
    const typedHasCode = String(raw).trim().startsWith("+") || String(raw).trim().startsWith("00");

    const matches = [];
    if (kind === "admin") {
        const [rows] = await db.execute(`SELECT email, phone FROM admins WHERE phone LIKE ? AND is_active = 1 LIMIT 25`, [`%${tail}`]);
        for (const r of rows) {
            const stored = normalizePhone(r.phone);
            const typed = normalizePhone(raw);
            const sameNational = digitsOnly(r.phone).slice(-10) === digits.slice(-10);
            if ((stored && typed && stored === typed) || (!typedHasCode && sameNational)) matches.push(r.email);
        }
    } else {
        const role = kind === "guest" ? "guest" : "tenant";
        const [rows] = await db.execute(
            `SELECT email, phone, country_code FROM tenants WHERE role = ? AND is_active = 1 AND phone LIKE ? LIMIT 25`,
            [role, `%${tail}`]
        );
        for (const r of rows) {
            const stored = normalizePhone(r.phone, r.country_code);
            const typed = normalizePhone(raw, r.country_code);
            if (stored && typed && stored === typed) matches.push(r.email);
        }
    }
    const unique = [...new Set(matches.filter(Boolean))];
    return unique.length === 1 ? unique[0] : null;
};

const KIND_BY_PREFIX = [
    ["/api/tenants/auth", "tenant"],
    ["/api/guests", "guest"],
    ["/api/auth", "admin"],
];

const identifierMiddleware = async (req, res, next) => {
    try {
        if (req.method !== "POST" || !req.body || typeof req.body !== "object") return next();
        const hit = KIND_BY_PREFIX.find(([p]) => req.originalUrl.startsWith(p));
        if (!hit) return next();
        const typed = req.body.identifier ?? req.body.email;
        if (typed && !looksLikeEmail(typed) && /^[+\d\s().-]{7,20}$/.test(String(typed).trim())) {
            const email = await emailForPhone(hit[1], String(typed).trim());
            req.body.email = email || String(typed).trim(); // unresolved => normal "invalid" path
            if (email) req.body.__loginPhone = String(typed).trim();
        } else if (req.body.identifier && !req.body.email) {
            req.body.email = String(req.body.identifier).trim();
        }
    } catch (e) {
        console.error("[identifier] lookup failed:", e.message);
    }
    next();
};

module.exports = { identifierMiddleware, emailForPhone, looksLikeEmail };
