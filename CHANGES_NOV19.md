# Update 19 Nov 2026

## Agreement (PDF) preview / download showed an error
Cause: PDFs were uploaded to Cloudinary with resource_type "auto", which stores them as *image* assets. Cloudinary blocks
public delivery of PDF image assets by default, and the admin portal simply redirected / iframed that blocked URL.

Fix
- New `src/services/document.file.service.js`: the API fetches the file server-side (stored URL, then signed URLs, then
  Cloudinary's authenticated download API), checks the real file type, and streams it with the right Content-Type.
- `GET /api/documents/admin/:id/view` (inline preview) and `GET /api/documents/admin/:id/download` (attachment, real
  file name). The tenant download route uses the same service. ZIP bulk download uses it too, so PDFs are included.
- New PDF uploads are stored as Cloudinary RAW assets (`upload.service.js`). Existing PDFs keep working via the fallbacks.
- Admin Documents page and Tenants > Documents preview load the file through the API (blob) and show a clear message
  with a Download fallback if the file is genuinely missing from storage (tenant must re-upload).

## Reset tenant password: "Route not found: POST /api/tenants/:id/reset-password"
The route and controller are in this code (`tenant.routes.js`, `tenant.controller.js`, `password.reset.service.js`).
"Route not found" is produced only by a server that does not contain it, i.e. the deployed build is older.
After deploying open https://api.livinkey.com/ - `build` must be `2026-11-19-document-streaming` and `features` must list
`admin-reset-password` and `document-streaming`. The admin page now shows an explicit "server needs to be updated"
message instead of the raw error if that ever happens again.
