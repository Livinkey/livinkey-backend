/**
 * Bigtos API client (WhatsApp + optional SMS) and configuration helpers.
 *
 * Bigtos exposes ONE send endpoint:  POST {BIGTOS_BASE_URL}/sendmessage
 *   fields: key, mobileno, msg, type (Text | Image | File | Template), File (url, for Image/File)
 * The request is sent as multipart/form-data, exactly like PHP's curl_setopt(CURLOPT_POSTFIELDS, array).
 *
 * Bigtos has no delivery-status callback, so a message that the API accepts is treated as "sent".
 * The delivery chain (WhatsApp -> SMS -> e-mail) therefore falls back on API-level failures only.
 */
const axios = require("axios");

const DEFAULT_BASE_URL = "https://www.cp.bigtos.com/api/v1";

const baseUrl = () => String(process.env.BIGTOS_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
const apiKey = () => {
    const k = String(process.env.BIGTOS_API_KEY || "").trim();
    return !k || /^(your|paste|enter)/i.test(k) ? "" : k;
};
/** Optional separate endpoint for plain SMS (not part of the WhatsApp docs). Same payload as sendmessage. */
const smsEndpoint = () => String(process.env.BIGTOS_SMS_ENDPOINT || "").trim();

const isWhatsAppConfigured = () => !!apiKey();
const isSmsConfigured = () => !!(apiKey() && smsEndpoint());

/** Bigtos wants digits with country code, no "+" (e.g. 919876543210). */
const toBigtosNumber = (n) => String(n || "").replace(/^whatsapp:/i, "").replace(/[^\d]/g, "");

const messageOf = (body) => {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body.trim().slice(0, 300);
    return String(body.message || body.msg || body.error || body.errors || body.status_message || body.statusText || "").slice(0, 300);
};

/** The docs do not describe the reply format, so success is judged defensively. */
const looksFailed = (body) => {
    if (body && typeof body === "object") {
        const st = body.status ?? body.success ?? body.result ?? body.code;
        if (body.success === false || st === false) return true;
        if (typeof st === "string" && /^(false|error|fail(ed)?|invalid|0)$/i.test(st.trim())) return true;
        if (body.error || body.errors) return true;
        return false;
    }
    return /\b(error|fail(ed)?|invalid|insufficient|expired|unauthori[sz]ed|not\s+found|denied)\b/i.test(String(body || ""));
};

const idOf = (body) => {
    if (!body || typeof body !== "object") return null;
    const d = body.data && typeof body.data === "object" ? body.data : {};
    const v = body.id ?? body.messageId ?? body.message_id ?? body.msgid ?? body.msg_id ?? d.id ?? d.messageId ?? d.message_id ?? null;
    return v === null || v === undefined || v === "" ? null : String(v);
};

/**
 * POST form fields to a Bigtos endpoint. Throws on HTTP errors or an error-looking reply.
 * @returns {Promise<{id: string|null, raw: any}>}
 */
const post = async (url, fields) => {
    const key = apiKey();
    if (!key) throw Object.assign(new Error("Bigtos is not configured (set BIGTOS_API_KEY)."), { code: "BIGTOS_NOT_CONFIGURED" });

    const form = new FormData();
    form.append("key", key);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, String(v));

    let res;
    try {
        res = await axios.post(url, form, { timeout: Number(process.env.BIGTOS_TIMEOUT_MS) || 30000, headers: { "User-Agent": process.env.BIGTOS_USER_AGENT || "Mozilla/5.0 (compatible; LivinkeyServer/1.0)", Accept: "*/*" }, responseType: "text", transformResponse: (r) => r, validateStatus: () => true });
    } catch (err) {
        const timedOut = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
        throw Object.assign(new Error(timedOut
            ? `Bigtos did not answer within ${Number(process.env.BIGTOS_TIMEOUT_MS) || 30000} ms (${err.code}). The message may or may not have been sent - check the Bigtos history.`
            : `Bigtos request failed: ${err.code || err.message}`), { code: err.code || "BIGTOS_NETWORK" });
    }

    let body = res.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* plain text reply */ } }

    if (res.status < 200 || res.status >= 300) {
        throw Object.assign(new Error(`Bigtos HTTP ${res.status}${messageOf(body) ? `: ${messageOf(body)}` : ""}`), { code: `HTTP_${res.status}`, status: res.status });
    }
    if (looksFailed(body)) {
        throw Object.assign(new Error(`Bigtos rejected the message${messageOf(body) ? `: ${messageOf(body)}` : ""}`), { code: "BIGTOS_REJECTED" });
    }
    return { id: idOf(body), raw: body };
};

const sendMessageUrl = () => `${baseUrl()}/sendmessage`;

/** Keep only the useful part of an error. */
const describeError = (err) => {
    if (!err) return { message: "Unknown error" };
    return { message: err.message || String(err), code: err.code || null, status: err.status || null };
};

module.exports = {
    HAS_STATUS_CALLBACKS: false,
    post, sendMessageUrl, smsEndpoint, baseUrl, apiKey,
    isWhatsAppConfigured, isSmsConfigured, toBigtosNumber, describeError,
};
