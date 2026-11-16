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

/** POST /api/webhooks/bigtos/whatsapp */
exports.handleIncomingMessage = async (req, res) => {
    try {
        const inc = readIncoming(req.body);
        // ignore our own outgoing messages echoed back, and group chats
        if (inc.fromMe || inc.isGroup) return res.status(200).send("OK");
        const e164 = jidToE164(inc.from);
        if (!e164) return res.status(200).send("OK");

        // The same webhook may be delivered twice – never store a message twice.
        if (await Message.findOne({ external_id: inc.id })) return res.status(200).send("OK");

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
    } catch (error) {
        console.error("Incoming WhatsApp webhook error:", error.message);
    }
    res.status(200).send("OK");
};
exports._internals = { readIncoming, jidToE164 };
