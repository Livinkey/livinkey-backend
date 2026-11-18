/**
 * Reliable delivery of stored tenant documents (agreement PDFs, ID scans, ...).
 *
 * WHY THIS EXISTS
 * Documents live on Cloudinary. The old code simply redirected the browser to the stored
 * `document_url`. For PDFs that fails in practice:
 *   - PDFs uploaded with resource_type "auto" are stored as *image* assets, and Cloudinary blocks
 *     public delivery of PDF / ZIP "image" assets by default (HTTP 401/403 "deliver blocked"),
 *   - the browser then shows an error page both in the preview iframe and in the download tab,
 *   - the Cloudinary URL has no `Content-Disposition`/`Content-Type` we control.
 *
 * The backend now fetches the file server-side (trying the stored URL first, then signed delivery
 * URLs and finally Cloudinary's authenticated download API) and streams it to the admin with the
 * correct Content-Type, so the preview and the download always work regardless of how the file was
 * originally stored.
 */
const axios = require("axios");
const cloudinary = require("../config/cloudinary");
const { detectType } = require("../middleware/upload.middleware");

const FETCH_TIMEOUT_MS = 30000;
const MAX_BYTES = 25 * 1024 * 1024;

const EXT_BY_TYPE = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic"
};

const extOf = (s) => {
    const m = String(s || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : "";
};

/** Candidate URLs, most direct first. Duplicates removed. Never throws. */
const buildCandidates = (doc) => {
    const out = [];
    const push = (u) => { if (u && !out.includes(u)) out.push(u); };

    push(doc.document_url);

    const publicId = doc.document_public_id;
    if (!publicId) return out.map((url) => ({ url }));

    const stored = doc.document_resource_type || "image";
    const types = [...new Set([stored, "raw", "image"])];
    const ext = extOf(doc.document_url) || extOf(doc.original_name) || "pdf";
    const idHasExt = extOf(publicId) === ext;
    const bareId = idHasExt ? publicId.slice(0, -(ext.length + 1)) : publicId;

    const signed = [];
    const api = [];
    for (const rt of types) {
        try {
            // Signed delivery URL (works even when "strict" / authenticated delivery is on).
            signed.push(cloudinary.url(rt === "raw" ? publicId : bareId, {
                resource_type: rt, type: "upload", secure: true, sign_url: true,
                ...(rt === "raw" ? {} : { format: ext })
            }));
        } catch (_) { /* ignore */ }
        try {
            // Authenticated download through the Admin API – not affected by the PDF-delivery block.
            api.push(cloudinary.utils.private_download_url(rt === "raw" ? publicId : bareId, rt === "raw" ? "" : ext, {
                resource_type: rt, type: "upload", attachment: false,
                expires_at: Math.floor(Date.now() / 1000) + 600
            }));
        } catch (_) { /* ignore */ }
    }
    signed.forEach(push);
    api.forEach(push);
    return out.map((url) => ({ url }));
};

const download = async (url) => {
    const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300
    });
    return Buffer.from(res.data);
};

/**
 * Returns { buffer, contentType, ext } for a document row, or throws an Error with `.status`.
 * The body is verified by its magic bytes, so an HTML/JSON error page from a CDN is never
 * mistaken for the document.
 */
const fetchDocumentFile = async (doc) => {
    if (!doc || (!doc.document_url && !doc.document_public_id)) {
        const e = new Error("This document has no file attached."); e.status = 404; throw e;
    }
    const attempts = [];
    for (const c of buildCandidates(doc)) {
        try {
            const buffer = await download(c.url);
            const contentType = detectType(buffer);
            if (!contentType) { attempts.push("not a PDF/image"); continue; }
            return { buffer, contentType, ext: EXT_BY_TYPE[contentType] || "bin" };
        } catch (err) {
            const status = err.response && err.response.status;
            attempts.push(status ? `HTTP ${status}` : (err.code || err.message));
        }
    }
    console.error(`Document ${doc.id} could not be fetched (${attempts.join(", ")})`);
    const e = new Error("The file could not be retrieved from storage. Please ask the tenant to upload it again.");
    e.status = 502;
    throw e;
};

const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();

const buildFileName = (doc, ext) => {
    let name = safeName(doc.original_name);
    if (!name) name = safeName(`${doc.tenant_name || "tenant"}_${doc.document_type || "document"}`);
    if (extOf(name) !== ext) name = `${name.replace(/\.[a-z0-9]{2,5}$/i, "")}.${ext}`;
    return name;
};

/** Stream a document to the client. inline=true → preview in the browser, false → download. */
const sendDocument = async (res, doc, { inline = false } = {}) => {
    const file = await fetchDocumentFile(doc);
    const name = buildFileName(doc, file.ext);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", file.buffer.length);
    res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.end(file.buffer);
};

module.exports = { fetchDocumentFile, sendDocument, buildFileName, buildCandidates };
