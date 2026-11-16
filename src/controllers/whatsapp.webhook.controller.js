/**
 * Bigtos webhook
 *   POST /api/webhooks/bigtos/whatsapp?token=...  – a person wrote to our WhatsApp number
 *
 * Bigtos posts  body / from / to  and a JSON "data" blob (see their "Incoming Messages" docs).
 * Always answers 200 (providers retry on anything else); errors are logged.
 * Bigtos has no delivery-receipt webhook, so there is no status endpoint.
 */

const Conversation = require("../models/conversation.model");
const Message = require("../models/message.model");
const messagingService = require("../services/messaging.service");
const { findUserByE164 } = require("../services/contacts.service");
const { normalizePhone, digitsOnly } = require("../utils/phone");

const crypto = require("crypto");

/** "919950448844@c.us" -> "+919950448844" (Bigtos always includes the country code) */
const jidToE164 = (v) => {
    const d = digitsOnly(String(v || "").split("@")[0]);
    return d ? normalizePhone("+" + d) : null;
};

const parseJson = (v) => {
    if (v && typeof v === "object") return v;
    if (typeof v !== "string") return null;
    try { return JSON.parse(v); } catch { return null; }
};

/** Normalise the different shapes Bigtos may post into one flat object. */
const readIncoming = (reqBody) => {
    const b = reqBody || {};
    const outer = parseJson(b.data) || {};
    const m = (outer.data && typeof outer.data === "object" ? outer.data : null) || outer || {};
    const sender = m.sender && typeof m.sender === "object" ? m.sender : {};
    const from = b.from || m.from || m.chatid || "";
    const body = b.body ?? m.body ?? "";
    const type = String(m.type || b.type || "chat").toLowerCase();
    const media = m.mediaUrl || m.media_url || m.file || m.fileUrl || b.mediaUrl || b.file || null;
    const t = m.t || outer.ts || b.t || "";
    const id = m.id || b.id || b.messageId || crypto.createHash("sha1").update(`${from}|${t}|${body}`).digest("hex");
    return {
        id: String(id).slice(0, 100),
        from, to: b.to || m.to || "", body, type, media,
        name: m.notifyName || sender.pushname || sender.name || sender.formattedName || b.name || null,
        fromMe: m.fromme === true || m.fromMe === true || String(m.self || "").toLowerCase() === "out",
        isGroup: /@g\.us$/i.test(String(from)),
        raw: m,
    };
};

/** Text / media out of a Baileys-style `message` object. */
const unwrapBaileys = (message = {}) => {
    const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
    const kinds = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
    const k = kinds.find((x) => m[x]);
    return {
        text: m.conversation || m.extendedTextMessage?.text || (k && m[k].caption) || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || "",
        mediaKind: k ? k.replace("Message", "") : null,
        mediaUrl: k ? (m[k].url || m[k].link || null) : null,
    };
};

/**
 * Bigtos can post several shapes; all are turned into the same flat list:
 *  A) { messages:[ {key:{remoteJid,fromMe,id}, message:{...}, pushName} ], type:"notify" }   (WhatsApp-Web style)
 *  B) { messages:[ {from, id, type, text:{body}, image:{link}} ], contacts:[{profile:{name}}] }  (Cloud-API style)
 *  C) { body, from, to, data:"{...}" }                                                            (documented flat/JSON)
 */
const readAll = (reqBody) => {
    const b = reqBody || {};
    const outer = parseJson(b.data) || {};
    const list = Array.isArray(b.messages) ? b.messages : Array.isArray(outer.messages) ? outer.messages : Array.isArray(outer.data?.messages) ? outer.data.messages : null;
    if (!list) return [readIncoming(b)];
    if (String(b.type || "").toLowerCase() === "append") return []; // history sync, not new messages

    const contactName = (b.contacts || outer.contacts || [])[0]?.profile?.name || null;
    return list.map((m) => {
        m = m || {};
        const key = m.key || {};
        const jid = String(key.remoteJid || "");
        // "@lid" ids are privacy aliases, not phone numbers – use the alt field when the provider supplies it
        const from = /@lid$/i.test(jid) ? (key.remoteJidAlt || key.senderPn || m.senderPn || m.from || "") : (jid || m.from || m.sender || m.chatid || "");
        const bag = m.message ? unwrapBaileys(m.message) : { text: "", mediaKind: null, mediaUrl: null };
        const kind = m.type && typeof m.type === "string" ? m.type : null;
        const typed = kind && m[kind] && typeof m[kind] === "object" ? m[kind] : {};
        const body = bag.text || m.text?.body || (typeof m.text === "string" ? m.text : "") || m.body || typed.caption || "";
        const media = bag.mediaUrl || typed.link || typed.url || m.mediaUrl || m.file || null;
        const t = m.messageTimestamp || m.timestamp || m.t || "";
        const id = key.id || m.id || crypto.createHash("sha1").update(`${from}|${t}|${body}`).digest("hex");
        return {
            id: String(id).slice(0, 100),
            from, to: b.to || m.to || "", body, media,
            type: bag.mediaKind || kind || "chat",
            name: m.pushName || m.notifyName || m.profile?.name || m.name || contactName || null,
            fromMe: key.fromMe === true || m.fromMe === true || m.from_me === true || String(m.self || "").toLowerCase() === "out",
            isGroup: /@g\.us$/i.test(jid || String(from)),
        };
    });
};

/**
 * Find the conversation a phone number belongs to – creating it when needed.
 *  1. a Livinkey user owns this number -> that user's conversation
 *  2. an earlier conversation already uses this number
 *  3. a stranger: new conversation with a NEGATIVE user_id derived from the number
 *     (the (user_id, user_type) key is unique, so a shared 0 would collide on the 2nd stranger)
 */
const findOrCreateConversation = async (e164, profileName) => {
    const user = await findUserByE164(e164);
    if (user) {
        let conv = await Conversation.findOne({ user_id: user.userId, user_type: user.userType });
        if (!conv) {
            conv = await Conversation.create({
                user_id: user.userId, user_type: user.userType, phone: e164, email: user.email || null,
                name: user.name || profileName || e164, last_message_at: new Date(), unread_count: 0,
            });
        } else if (!conv.phone) {
            await Conversation.update(conv.id, { phone: e164 });
        }
        return conv;
    }

    const byPhone = await Conversation.findOne({ phone: e164 });
    if (byPhone) return byPhone;

    const strangerId = -(Number(digitsOnly(e164).slice(-9)) || 1);
    try {
        return await Conversation.create({
            user_id: strangerId, user_type: "tenant", phone: e164,
            name: profileName || e164, last_message_at: new Date(), unread_count: 0,
        });
    } catch (err) {
        const again = (await Conversation.findOne({ phone: e164 })) || (await Conversation.findOne({ user_id: strangerId, user_type: "tenant" }));
        if (again) return again;
        throw err;
    }
};

/** Store one inbound message (and send the optional auto-reply). */
const processOne = async (inc, rawBody) => {
    // ignore our own outgoing messages echoed back, and group chats
    if (inc.fromMe || inc.isGroup) { console.log("[bigtos-webhook] ignored (own message or group)"); return; }
    const e164 = jidToE164(inc.from);
    if (!e164) { console.warn("[bigtos-webhook] ignored: no usable sender number in", JSON.stringify(inc.from), "| body:", JSON.stringify(rawBody).slice(0, 1500)); return; }

    // The same webhook may be delivered twice – never store a message twice.
    if (await Message.findOne({ external_id: inc.id })) return;

    const ProfileName = inc.name;
    const conversation = await findOrCreateConversation(e164, ProfileName);
    const media = !!inc.media || !["chat", "text", ""].includes(inc.type);

    await Message.create({
        conversation_id: conversation.id,
        direction: "inbound",
        channel: "whatsapp",
        message_type: media ? "media" : "text",
        content: inc.body || "",
        media_url: inc.media || null,
        status: "received",
        external_id: inc.id,
        metadata: { profileName: ProfileName || null, to: digitsOnly(String(inc.to).split("@")[0]) || null, waType: inc.type },
    });
    await Conversation.update(conversation.id, {
        last_message_at: new Date(),
        unread_count: (conversation.unread_count || 0) + 1,
        ...(ProfileName && (!conversation.name || conversation.name === conversation.phone) ? { name: ProfileName } : {}),
    });

    // Optional auto-reply (free-form is allowed: the person just wrote to us, so the 24h window is open)
    if (process.env.WHATSAPP_AUTO_REPLY === "true") {
        try {
            await messagingService.sendMessage({
                userId: conversation.user_id,
                userType: conversation.user_type,
                phone: conversation.phone,
                name: conversation.name,
                type: "text",
                body: process.env.WHATSAPP_AUTO_REPLY_TEXT || "Thank you for your message. Our team will get back to you shortly.",
                skipEmail: true,
            });
        } catch (autoReplyErr) {
            console.error("Auto-reply failed:", autoReplyErr.message);
        }
    }
};

/** POST /api/webhooks/bigtos/whatsapp */
exports.handleIncomingMessage = async (req, res) => {
    try {
        for (const inc of readAll(req.body)) {
            try { await processOne(inc, req.body); }
            catch (e) { console.error("Incoming WhatsApp message error:", e.message); }
        }
    } catch (error) {
        console.error("Incoming WhatsApp webhook error:", error.message);
    }
    res.status(200).send("OK");
};
exports._internals = { readIncoming, readAll, jidToE164 };
