/**
 * GET /l/:code – landing page for a smart link (see services/links.service.js).
 * Public, no login. Never reveals who the link belongs to.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const links = require("../services/links.service");
const { APP_STORE_URL, WEBSITE_URL } = require("../utils/links");

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PACKAGE = "com.livinkey.app";

const page = ({ title, body, script = "" }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Livinkey</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0d;color:#f2f2f2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px}
.card{width:100%;max-width:420px;background:#161616;border:1px solid #2a2a2a;border-radius:18px;padding:28px 24px;text-align:center}
.brand{color:#92C24A;font-weight:800;letter-spacing:.5px;font-size:20px;margin-bottom:6px}
h1{font-size:20px;margin:10px 0 6px}p{color:#b5b5b5;line-height:1.55;margin:6px 0}
.amt{font-size:34px;font-weight:800;color:#92C24A;margin:10px 0 2px}
.btn{display:block;width:100%;padding:14px 16px;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;margin-top:12px;border:0;cursor:pointer}
.primary{background:#92C24A;color:#0d0d0d}.ghost{background:transparent;color:#92C24A;border:1px solid #92C24A}
.small{font-size:12px;color:#777;margin-top:16px}
</style></head><body><div class="card"><div class="brand">Livinkey</div>${body}</div>${script}</body></html>`;

const intentUrl = (target) =>
    `intent://open?t=${encodeURIComponent(target)}#Intent;scheme=livinkey;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(APP_STORE_URL)};end`;

router.get("/:code", async (req, res) => {
    res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        // this page needs its own inline style/script (the API-wide CSP blocks them)
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    });
    try {
        const link = await links.getLink(req.params.code);
        if (!link || link.expired) {
            return res.status(link ? 410 : 404).send(page({
                title: "Link expired",
                body: `<h1>This link is no longer active</h1><p>For your security, links expire after a while. Open the Livinkey app to continue.</p>
                <a class="btn primary" href="${esc(APP_STORE_URL)}">Open Livinkey on Play Store</a><a class="btn ghost" href="${esc(WEBSITE_URL)}">livinkey.com</a>`,
            }));
        }
        await links.markUsed(link.code);

        const ua = String(req.get("user-agent") || "");
        const isAndroid = /android/i.test(ua);
        const target = link.target === "pay" ? "payments" : link.target;
        const p = link.params || {};

        let payBlock = "";
        if (link.target === "pay") {
            const upi = typeof p.upi === "string" && /^upi:\/\/pay\?/i.test(p.upi) ? p.upi : "";
            const checkout = link.redirect_url && /^https:\/\//i.test(link.redirect_url) ? link.redirect_url : "";
            payBlock = `<h1>${esc(p.title || "Your bill")}</h1>
                ${p.amount ? `<div class="amt">${esc(p.amount)}</div><p>${esc(p.subtitle || "Amount due")}</p>` : ""}
                ${checkout ? `<a class="btn primary" href="${esc(checkout)}">Pay online</a>` : ""}
                ${upi ? `<a class="btn ${checkout ? "ghost" : "primary"}" href="${esc(upi)}">Pay with a UPI app</a>` : ""}`;
        }

        const body = `${payBlock || `<h1>${esc(p.title || "Opening Livinkey…")}</h1><p>${esc(p.subtitle || "If the app does not open automatically, tap the button below.")}</p>`}
            <a class="btn ${payBlock ? "ghost" : "primary"}" id="open" href="${isAndroid ? esc(intentUrl(target)) : "#"}">Open in Livinkey app</a>
            <a class="btn ghost" href="${esc(APP_STORE_URL)}">Get the app</a>
            <div class="small">Never share this page or your login details with anyone.</div>`;

        // Auto-open the app straight away unless this page is a payment page the person should read.
        const script = isAndroid && link.target !== "pay"
            ? `<script>setTimeout(function(){location.href=${JSON.stringify(intentUrl(target))}},350)</script>`
            : "";
        res.send(page({ title: p.title || "Open Livinkey", body, script }));
    } catch (e) {
        console.error("[links] landing failed:", e.message);
        res.status(500).send(page({ title: "Something went wrong", body: `<h1>Something went wrong</h1><p>Please open the Livinkey app directly.</p>` }));
    }
});

module.exports = router;
