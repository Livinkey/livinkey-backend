/**
 * WhatsApp (Bigtos) – the first step of the delivery chain.
 *
 *   sendWhatsApp(to, { text, template })
 *     - template + matching BIGTOS_*_TEMPLATE name set -> approved template (type=Template, works any time)
 *     - otherwise                                      -> free-form text (type=Text). WhatsApp only delivers
 *                                                         this inside the 24-hour customer-service window.
 *
 * Bigtos sends no delivery receipts, so an accepted request counts as "sent".
 */
const { post, sendMessageUrl, toBigtosNumber } = require("./bigtos.client");

const warnedMissing = new Set();
const templateNameFor = (envKey) => {
    const v = String(process.env[envKey] || "").trim();
    if (!v) return "";
    if (/^x{3,}$/i.test(v) || /^(your|paste|enter)/i.test(v)) {
        if (!warnedMissing.has(envKey)) {
            warnedMissing.add(envKey);
            console.warn(`[whatsapp] ${envKey} looks like a placeholder - sending free-form text instead.`);
        }
        return "";
    }
    return v;
};

/** Numbered variables {1:..,2:..} -> ordered body parameters for the template JSON. */
const buildTemplateMsg = (name, variables = {}) => {
    const ordered = Object.keys(variables).sort((a, b) => Number(a) - Number(b)).map((k) => ({ type: "text", text: String(variables[k]) }));
    const msg = { name, language: { code: String(process.env.BIGTOS_TEMPLATE_LANGUAGE || "en").trim() || "en" } };
    if (ordered.length) msg.components = [{ type: "body", parameters: ordered }];
    return JSON.stringify(msg);
};

const buildPayload = (to, { text, template } = {}) => {
    const mobileno = toBigtosNumber(to);
    if (!mobileno) throw new Error("WhatsApp recipient number is empty.");

    const tplName = template?.envKey ? templateNameFor(template.envKey) : "";
    if (tplName) return { mobileno, msg: buildTemplateMsg(tplName, template.variables), type: "Template", __mode: "template" };

    if (!String(text || "").trim()) throw new Error("WhatsApp message body is empty.");
    return { mobileno, msg: text, type: "Text", __mode: "text" };
};

/** @returns {Promise<{sid,status,to,mode}>} */
const sendWhatsApp = async (to, content) => {
    const payload = buildPayload(to, content);
    const mode = payload.__mode;
    delete payload.__mode;
    const r = await post(sendMessageUrl(), payload);
    return { sid: r.id, status: "sent", to: payload.mobileno, mode };
};

/** Send an image or document by public URL (Bigtos type=Image / File). */
const sendMedia = async (to, { url, caption = "", kind = "Image" }) => {
    const mobileno = toBigtosNumber(to);
    if (!mobileno || !url) throw new Error("Recipient and file URL are required.");
    const r = await post(sendMessageUrl(), { mobileno, msg: caption, File: url, type: kind === "File" ? "File" : "Image" });
    return { sid: r.id, status: "sent", to: mobileno };
};

/* ---- thin helper kept for older call sites ---- */
const sendTextMessage = (to, body) => sendWhatsApp(to, { text: body });

module.exports = { sendWhatsApp, sendTextMessage, sendMedia, buildPayload, buildTemplateMsg };
