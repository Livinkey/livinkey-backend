/**
 * Webhook Routes (Bigtos)
 * Public endpoints, authenticated by the shared secret in the URL (see middleware/bigtos.webhook.js)
 */

const express = require("express");
const router = express.Router();
const verifyBigtos = require("../middleware/bigtos.webhook");
const webhookController = require("../controllers/whatsapp.webhook.controller");

// Incoming WhatsApp messages
router.post("/bigtos/whatsapp", verifyBigtos, webhookController.handleIncomingMessage);

module.exports = router;
