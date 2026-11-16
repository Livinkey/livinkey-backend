/**
 * SMS (Bigtos) – the second step of the delivery chain.
 *
 * Bigtos' WhatsApp docs have no SMS endpoint. The step is active only when BIGTOS_SMS_ENDPOINT is set to the
 * URL of your Bigtos SMS API (same fields as sendmessage: key, mobileno, msg, type=Text); otherwise it is skipped.
 *
 * SMS bodies are kept to the GSM-7 alphabet on purpose: one emoji or "₹" turns a message into
 * UCS-2 (70 chars/segment instead of 160) and triples the cost. Currency is written "Rs.".
 */
const { post, smsEndpoint, toBigtosNumber } = require("./bigtos.client");

const MAX_SMS_CHARS = 600; // ~4 segments

/** Convert any text into a short, GSM-friendly SMS. */
const toSmsText = (text) => {
    let s = String(text ?? "")
        .replace(/₹\s?/g, "Rs. ")
        .replace(/[“”«»]/g, '"')
        .replace(/[‘’`´]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/…/g, "...")
        .replace(/\*([^*\n]+)\*/g, "$1")      // WhatsApp *bold*
        .replace(/_([^_\n]+)_/g, "$1")         // WhatsApp _italic_
        // strip emoji / pictographs / variation selectors
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (s.length > MAX_SMS_CHARS) s = s.slice(0, MAX_SMS_CHARS - 3).trimEnd() + "...";
    return s;
};

const sendSms = async (to, body) => {
    const url = smsEndpoint();
    if (!url) throw new Error("SMS endpoint not configured (set BIGTOS_SMS_ENDPOINT).");
    const mobileno = toBigtosNumber(to);
    const r = await post(url, { mobileno, msg: toSmsText(body), type: "Text" });
    return { sid: r.id, status: "sent", to: mobileno };
};

module.exports = { sendSms, toSmsText };
