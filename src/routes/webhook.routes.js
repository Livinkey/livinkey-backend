/**
 * Webhook Routes (Bigtos)
 * Public endpoints, authenticated by the shared secret in the URL (see middleware/bigtos.webhook.js)
 */

const express = require("express");
const multer = require("multer");
const parseForm = multer().none(); // Bigtos may post multipart/form-data, which express.json/urlencoded do not read
const router = express.Router();
const verifyBigtos = require("../middleware/bigtos.webhook");
const webhookController = require("../controllers/whatsapp.webhook.controller");

// Incoming WhatsApp messages
router.post("/bigtos/whatsapp", parseForm, verifyBigtos, webhookController.handleIncomingMessage);
// Some panels "test" the URL with a GET – answer 200 so the URL is accepted
router.get("/bigtos/whatsapp", (req, res) => res.status(200).send("OK"));

module.exports = router;
