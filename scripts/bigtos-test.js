/**
 * Connectivity check:  node scripts/bigtos-test.js 919876543210 "hello"
 * Run it ON THE SERVER (Render shell). Prints timing + the raw Bigtos reply, so you can see whether the
 * problem is the network (timeout), the key, or the reply format.
 */
require("dotenv").config();
const axios = require("axios");
const { baseUrl, apiKey } = require("../src/services/bigtos.client");

(async () => {
    const [to, msg = "Livinkey test"] = process.argv.slice(2);
    if (!to) return console.log("Usage: node scripts/bigtos-test.js <number-with-country-code> [message]");
    if (!apiKey()) return console.log("BIGTOS_API_KEY is not set.");
    const form = new FormData();
    form.append("key", apiKey()); form.append("mobileno", to); form.append("msg", msg); form.append("type", "Text");
    const t0 = Date.now();
    try {
        const r = await axios.post(`${baseUrl()}/sendmessage`, form, { timeout: 60000, responseType: "text", transformResponse: (x) => x, validateStatus: () => true, headers: { "User-Agent": "Mozilla/5.0 (compatible; LivinkeyServer/1.0)" } });
        console.log(`HTTP ${r.status} in ${Date.now() - t0} ms\n`, String(r.data).slice(0, 800));
    } catch (e) { console.log(`FAILED after ${Date.now() - t0} ms:`, e.code, e.message); }
})();
