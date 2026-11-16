/**
 * Authenticates incoming Bigtos webhooks. Bigtos does not sign requests, so the webhook URL carries a
 * shared secret that only you and Bigtos know:
 *
 *   https://api.livinkey.com/api/webhooks/bigtos/whatsapp?token=<BIGTOS_WEBHOOK_SECRET>
 *
 * (an "x-webhook-secret" header is accepted too). Set BIGTOS_VALIDATE_WEBHOOK=false only for local testing.
 */
const crypto = require("crypto");

const safeEqual = (a, b) => {
    const x = crypto.createHash("sha256").update(String(a)).digest();
    const y = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};

module.exports = (req, res, next) => {
    if (process.env.BIGTOS_VALIDATE_WEBHOOK === "false") return next();

    const secret = process.env.BIGTOS_WEBHOOK_SECRET;
    const given = req.query?.token || req.headers["x-webhook-secret"];
    if (!secret || !given || !safeEqual(given, secret)) {
        return res.status(403).type("text/plain").send("Forbidden");
    }
    return next();
};
