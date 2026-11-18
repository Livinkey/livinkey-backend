// Document types for international tenants
const INTERNATIONAL_DOCUMENTS = [
    { key: 'passport_photo', label: 'Passport Size Photo', required: true },
    { key: 'signature', label: 'Signature', required: true },
    { key: 'passport', label: 'Passport', required: true },
    { key: 'visa', label: 'Visa', required: true },
    { key: 'arrival_stamp', label: 'Arrival Stamp', required: true },
    { key: 'c_form', label: 'C-Form', required: true },
    { key: 'efrro', label: 'E-FRRO', required: true },
    { key: 'university_id', label: 'University ID', required: false },
    { key: 'agreement', label: 'Agreement', required: true, pdfOnly: true }
];

// Document types for national tenants (Indians).
// Aadhaar has two sides, so the tenant and the parent each upload a FRONT and a BACK.
const NATIONAL_DOCUMENTS = [
    { key: 'passport_photo', label: 'Passport Size Photo', required: true },
    { key: 'signature', label: 'Signature', required: true },
    { key: 'tenant_aadhaar_front', label: 'Tenant Aadhaar Card (Front)', required: true },
    { key: 'tenant_aadhaar_back', label: 'Tenant Aadhaar Card (Back)', required: true },
    { key: 'parent_aadhaar_front', label: 'Parent Aadhaar Card (Front)', required: true },
    { key: 'parent_aadhaar_back', label: 'Parent Aadhaar Card (Back)', required: true },
    { key: 'university_id', label: 'University ID', required: false },
    { key: 'agreement', label: 'Agreement', required: true, pdfOnly: true }
];

// Vehicle documents – available to every tenant who has a vehicle
// vehicle_number is stored as text on tenant_details, not as an image document
const VEHICLE_DOCUMENTS = [
    { key: 'vehicle_photo', label: 'Vehicle Photo', required: true },
    { key: 'vehicle_rc', label: 'RC Photo', required: true },
    { key: 'driver_license', label: 'Driver License', required: true }
];

// All document types mapping.
//   label  = ONE document ("Visa", "Passport") – use whenever a single document is meant.
//   plural = MORE THAN ONE document ("Visas", "Passports") – use only for counts / group headings.
const DOCUMENT_TYPES = {
    passport_photo: { label: 'Passport Size Photo', plural: 'Passport Size Photos', category: 'photos' },
    signature: { label: 'Signature', plural: 'Signatures', category: 'signatures' },
    passport: { label: 'Passport', plural: 'Passports', category: 'passports' },
    visa: { label: 'Visa', plural: 'Visas', category: 'visas' },
    arrival_stamp: { label: 'Arrival Stamp', plural: 'Arrival Stamps', category: 'arrival_stamps' },
    c_form: { label: 'C-Form', plural: 'C-Forms', category: 'c_forms' },
    efrro: { label: 'E-FRRO', plural: 'E-FRROs', category: 'efrros' },
    tenant_aadhaar_front: { label: 'Tenant Aadhaar Card (Front)', plural: 'Tenant Aadhaar Cards (Front)', category: 'aadhaars' },
    tenant_aadhaar_back: { label: 'Tenant Aadhaar Card (Back)', plural: 'Tenant Aadhaar Cards (Back)', category: 'aadhaars' },
    parent_aadhaar_front: { label: 'Parent Aadhaar Card (Front)', plural: 'Parent Aadhaar Cards (Front)', category: 'aadhaars' },
    parent_aadhaar_back: { label: 'Parent Aadhaar Card (Back)', plural: 'Parent Aadhaar Cards (Back)', category: 'aadhaars' },
    // Legacy single-sided uploads made before front/back existed. Still shown and reviewable;
    // they count as the FRONT side (see LEGACY_ALIASES).
    tenant_aadhaar: { label: 'Tenant Aadhaar Card', plural: 'Tenant Aadhaar Cards', category: 'aadhaars', legacy: true },
    parent_aadhaar: { label: 'Parent Aadhaar Card', plural: 'Parent Aadhaar Cards', category: 'aadhaars', legacy: true },
    university_id: { label: 'University ID', plural: 'University IDs', category: 'university_ids' },
    agreement: { label: 'Agreement', plural: 'Agreements', category: 'agreements', pdfOnly: true },
    // Vehicle
    vehicle_photo: { label: 'Vehicle Photo', plural: 'Vehicle Photos', category: 'vehicle' },
    vehicle_rc: { label: 'RC Photo', plural: 'RC Photos', category: 'vehicle' },
    driver_license: { label: 'Driver License', plural: 'Driver Licenses', category: 'vehicle' }
};

// A legacy upload satisfies the matching FRONT requirement, so existing tenants are not asked to redo it.
const LEGACY_ALIASES = {
    tenant_aadhaar_front: 'tenant_aadhaar',
    parent_aadhaar_front: 'parent_aadhaar'
};

const VEHICLE_DOCUMENT_KEYS = VEHICLE_DOCUMENTS.map(d => d.key);
const PDF_ONLY_KEYS = Object.keys(DOCUMENT_TYPES).filter(k => DOCUMENT_TYPES[k].pdfOnly);

/** "Visa" for one, "Visas" for several / none. Unknown keys fall back to the raw key. */
const labelFor = (key, count = 1) => {
    const t = DOCUMENT_TYPES[key];
    if (!t) return String(key || 'Document');
    return Number(count) === 1 ? t.label : t.plural;
};

/** "1 document", "3 documents" */
const countDocuments = (n) => `${n} document${Number(n) === 1 ? '' : 's'}`;

/** Required keys that are still missing, honouring legacy uploads. `have` = Set or array of uploaded keys. */
const missingKeys = (requiredKeys, have) => {
    const set = have instanceof Set ? have : new Set(have || []);
    return requiredKeys.filter(k => !set.has(k) && !(LEGACY_ALIASES[k] && set.has(LEGACY_ALIASES[k])));
};

module.exports = {
    INTERNATIONAL_DOCUMENTS,
    NATIONAL_DOCUMENTS,
    VEHICLE_DOCUMENTS,
    VEHICLE_DOCUMENT_KEYS,
    DOCUMENT_TYPES,
    LEGACY_ALIASES,
    PDF_ONLY_KEYS,
    labelFor,
    countDocuments,
    missingKeys
};
