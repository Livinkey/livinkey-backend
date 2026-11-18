const cloudinary = require("../config/cloudinary");
const fs = require("fs");

const uploadFile = (file, folder) => {
    return new Promise((resolve, reject) => {
        if (!file) {
            return resolve(null);
        }

        if (!file.buffer || file.buffer.length === 0) {
            return reject(new Error("File buffer is empty or missing"));
        }

        // PDFs are stored as RAW assets. Cloudinary blocks public delivery of PDFs stored as
        // "image" assets (what resource_type "auto" produces), which made agreements impossible
        // to preview or download. Raw assets keep the .pdf extension in their public_id.
        const isPdf = file.mimetype === "application/pdf" || (file.buffer.slice(0, 5).toString("ascii") === "%PDF-");
        const baseName = String(file.originalname || "document").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "document";
        const options = isPdf
            ? { folder, resource_type: "raw", public_id: `${baseName}_${Date.now()}.pdf`, use_filename: false, unique_filename: false }
            : { folder, resource_type: "auto" };

        const stream = cloudinary.uploader.upload_stream(
            options,
            (error, result) => {
                if (error) {
                    console.error("Cloudinary Upload Error:", error);
                    return reject(error);
                }
                resolve(result);
            }
        );

        stream.end(file.buffer);
    });
};

const deleteFile = async (publicId, resourceType) => {
    if (!publicId) {
        return;
    }

    try {
        await cloudinary.uploader.destroy(
            publicId,
            {
                resource_type: resourceType || "image"
            }
        );
    } catch (error) {
        console.error("Cloudinary Delete Error:", error);
        throw error;
    }
};

const deleteMultipleFiles = async (files) => {
    const results = [];
    for (const file of files) {
        if (file.public_id) {
            try {
                await deleteFile(file.public_id, file.resource_type);
                results.push({ success: true, public_id: file.public_id });
            } catch (error) {
                results.push({ success: false, public_id: file.public_id, error: error.message });
            }
        }
    }
    return results;
};

module.exports = {
    uploadFile,
    deleteFile,
    deleteMultipleFiles
};