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
    // One-line trace of every hit so a mis-set webhook is easy to diagnose in the server log.
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body).join(",") : "";
    console.log(`[bigtos-webhook] ${req.method} ${req.path} ct=${String(req.headers["content-type"] || "").split(";")[0]} keys=[${keys}]`);
    if (process.env.BIGTOS_WEBHOOK_DEBUG === "true") console.log("[bigtos-webhook] body:", JSON.stringify(req.body).slice(0, 3000));

    if (process.env.BIGTOS_VALIDATE_WEBHOOK === "false") return next();

    const secret = process.env.BIGTOS_WEBHOOK_SECRET;
    const given = req.query?.token || req.headers["x-webhook-secret"] || req.body?.token;
    if (!secret || !given || !safeEqual(given, secret)) {
        console.warn(`[bigtos-webhook] REJECTED: ${!secret ? "BIGTOS_WEBHOOK_SECRET is not set on the server" : !given ? "no ?token= in the webhook URL" : "token does not match"}`);
        return res.status(403).type("text/plain").send("Forbidden");
    }
    return next();
};
