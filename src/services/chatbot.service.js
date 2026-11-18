/**
 * Public website chatbot service.
 *
 * Rules:
 *  - NO PG / rent / amenity / vacancy facts are hardcoded here. Every factual answer is built from the
 *    live MySQL data of ACTIVE PGs (same visibility rules as /api/public/pgs).
 *  - Only public information is exposed (name, location, rent, security fee, amenities, vacancy, ratings,
 *    public contact details). No tenant data, no payment details, no agreement text.
 *  - Never throws on odd input: unknown questions get a helpful fallback answer.
 *
 * Contract with the website (livinkey_web/js/script.js):
 *   getQuickQuestions() -> { questions: [{ label, question }] }
 *   answerQuestion(q)   -> { answer: string, view: 'pg_list'|'vacant_rooms'|'pg_detail'|null, data: any }
 *     pg_list      data: [{ id, name, location, rent, available_spots, amenities, security_fee }]
 *     vacant_rooms data: [{ pg_id, pg_name, location, room_number, floor_number, capacity, room_rent, pg_rent }]
 *     pg_detail    data: { id, name, location, rent, available_spots, security_fee, amenities, ... }
 *   When a view is returned the site shows only the FIRST LINE of `answer` as a heading above the cards.
 */
const db = require("../config/db");

const MAX_PGS = 8;
const MAX_ROOMS = 10;
const CACHE_MS = 20 * 1000;

let cache = { at: 0, data: null };

// ------------------------------------------------------------------
// Text helpers
// ------------------------------------------------------------------
const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/** Lower-case, accent-free, wifi/ac/currency normalised text used for all matching. */
const norm = (value) => String(value ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[×✕]/g, "x")
    .replace(/wi[\s-]?fi/g, "wifi")
    .replace(/\ba\s*\/\s*c\b/g, "ac")
    .replace(/air[\s-]?condition(?:ing|er|ers|ed)?/g, "ac")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Math.round(parseFloat(n) * 1000)))
    .replace(/₹|\brs\.?\b|\binr\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (value) => norm(value).split(" ").filter(Boolean);
const compact = (value) => norm(value).replace(/\s+/g, "");

const AMENITY_STOP = new Set(["free", "a", "the", "of", "in", "with", "for", "and", "inch", "room", "rooms", "x"]);
const NAME_GENERIC = new Set(["pg", "pgs", "apartment", "apartments", "house", "plot", "no", "suits", "suite", "suites", "hostel"]);
const QUESTION_STOP = new Set([
    "which", "what", "show", "list", "give", "tell", "me", "about", "the", "a", "an", "is", "are", "do", "does", "you",
    "have", "has", "any", "all", "of", "in", "at", "for", "with", "and", "or", "to", "your", "our", "can", "i", "get",
    "pg", "pgs", "room", "rooms", "available", "right", "now", "please", "there", "near", "best", "that", "this", "it"
]);

const hasDigit = (t) => /\d/.test(t);
const isDistinctive = (t) => t.length >= 2 && !AMENITY_STOP.has(t) && !hasDigit(t);

// ------------------------------------------------------------------
// Data access (public data only)
// ------------------------------------------------------------------
const toNum = (v) => (v === null || v === undefined ? null : Number(v));

async function loadData() {
    if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

    const [pgRows] = await db.execute(
        `SELECT p.id, p.name, p.location, p.rent, p.security_fee,
                p.manual_rooms_enabled, p.manual_total_rooms, p.manual_vacant_rooms
           FROM pgs p
          WHERE p.is_active = 1
          ORDER BY p.name ASC`
    );

    const pgs = pgRows.map((p) => ({
        id: p.id,
        name: p.name,
        location: p.location,
        rent: Number(p.rent) || 0,
        security_fee: toNum(p.security_fee),
        manual: Number(p.manual_rooms_enabled) === 1
            && p.manual_total_rooms !== null && p.manual_total_rooms !== undefined
            && p.manual_vacant_rooms !== null && p.manual_vacant_rooms !== undefined,
        manual_total: toNum(p.manual_total_rooms),
        manual_vacant: toNum(p.manual_vacant_rooms),
        amenity_list: [],
        rooms: [],
        rating: null,
        reviews: 0
    }));
    const byId = new Map(pgs.map((p) => [p.id, p]));

    if (pgs.length) {
        const ids = pgs.map((p) => p.id);

        const [amenityRows] = await db.query(
            `SELECT pg_id, amenity_name FROM pg_amenities WHERE pg_id IN (?) ORDER BY id ASC`, [ids]
        );
        for (const a of amenityRows) {
            const pg = byId.get(a.pg_id);
            if (pg && a.amenity_name && !pg.amenity_list.includes(a.amenity_name)) pg.amenity_list.push(a.amenity_name);
        }

        const [roomRows] = await db.query(
            `SELECT r.id, r.room_number, r.capacity, r.rent AS room_rent, f.floor_number, f.pg_id,
                    COALESCE(ro.occupied_count, 0) AS occupied_count
               FROM rooms r
               JOIN floors f ON f.id = r.floor_id
               LEFT JOIN room_occupancy ro ON ro.room_id = r.id
              WHERE r.is_active = 1 AND f.pg_id IN (?)
              ORDER BY f.pg_id, f.floor_number, r.room_number`, [ids]
        );
        for (const r of roomRows) {
            const pg = byId.get(r.pg_id);
            if (!pg) continue;
            pg.rooms.push({
                id: r.id,
                room_number: r.room_number,
                floor_number: r.floor_number,
                capacity: Number(r.capacity) || 0,
                occupied: Number(r.occupied_count) || 0,
                room_rent: toNum(r.room_rent)
            });
        }

        // Ratings (public + tenant feedback). Optional: a failure here must not break the chatbot.
        try {
            const [ratingRows] = await db.query(
                `SELECT pg_id, SUM(cnt) AS reviews, SUM(avg_rating * cnt) / NULLIF(SUM(cnt), 0) AS rating
                   FROM (
                        SELECT pg_id, COUNT(*) AS cnt, AVG(overall_rating) AS avg_rating
                          FROM tenant_feedbacks WHERE pg_id IN (?) GROUP BY pg_id
                        UNION ALL
                        SELECT pg_id, COUNT(*) AS cnt, AVG(overall_rating) AS avg_rating
                          FROM public_feedbacks WHERE pg_id IN (?) GROUP BY pg_id
                   ) x
                  GROUP BY pg_id`, [ids, ids]
            );
            for (const r of ratingRows) {
                const pg = byId.get(r.pg_id);
                if (pg) {
                    pg.reviews = Number(r.reviews) || 0;
                    pg.rating = r.rating === null ? null : Math.round(Number(r.rating) * 10) / 10;
                }
            }
        } catch (err) {
            console.error("Chatbot ratings unavailable:", err.message);
        }
    }

    // Derived numbers (same rules as the public PG pages: manual room counts win when the admin enabled them).
    for (const pg of pgs) {
        const realVacantRooms = pg.rooms.filter((r) => r.occupied === 0);
        pg.real_total_rooms = pg.rooms.length;
        pg.free_beds = pg.rooms.reduce((s, r) => s + Math.max(0, r.capacity - r.occupied), 0);
        if (pg.manual) {
            pg.total_rooms = Math.max(0, pg.manual_total);
            pg.vacant_rooms = Math.min(pg.total_rooms, Math.max(0, pg.manual_vacant));
            pg.vacant_room_list = []; // specific rooms are not listed when counts are manual
        } else {
            pg.total_rooms = pg.real_total_rooms;
            pg.vacant_rooms = realVacantRooms.length;
            pg.vacant_room_list = realVacantRooms;
        }
        pg.amenities = pg.amenity_list.join(", ");
        pg.core_name = norm(String(pg.name).replace(/\([^)]*\)?/g, " "));
    }

    let contact = null;
    try {
        const SiteSettingsModel = require("../models/site.settings.model");
        const cfg = await SiteSettingsModel.getPublicConfig();
        contact = cfg && cfg.contact ? cfg.contact : null;
    } catch (_) { /* optional */ }

    cache = { at: Date.now(), data: { pgs, contact } };
    return cache.data;
}

// ------------------------------------------------------------------
// Shapers (what the website renders)
// ------------------------------------------------------------------
const shapePg = (pg) => ({
    id: pg.id,
    name: pg.name,
    location: pg.location,
    rent: pg.rent,
    available_spots: pg.vacant_rooms,
    security_fee: pg.security_fee,
    amenities: pg.amenities,
    rating: pg.rating,
    total_reviews: pg.reviews
});

const shapeRoom = (pg, room) => ({
    pg_id: pg.id,
    pg_name: pg.name,
    location: pg.location,
    room_number: room.room_number,
    floor_number: room.floor_number,
    capacity: room.capacity,
    room_rent: room.room_rent !== null && room.room_rent !== undefined ? room.room_rent : pg.rent,
    pg_rent: pg.rent
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

// ------------------------------------------------------------------
// Question understanding
// ------------------------------------------------------------------
function findMentionedPgs(q, pgs) {
    const qTokens = new Set(tokens(q));
    const qCompact = compact(q);
    const qNorm = ` ${norm(q)} `;

    // token frequency across PG names -> a unique token identifies a PG on its own
    const freq = new Map();
    for (const pg of pgs) {
        for (const t of new Set(tokens(pg.core_name))) if (!NAME_GENERIC.has(t)) freq.set(t, (freq.get(t) || 0) + 1);
    }

    const hits = [];
    for (const pg of pgs) {
        if (!pg.core_name) continue;
        const nameTokens = tokens(pg.core_name).filter((t) => !NAME_GENERIC.has(t));
        let matched = false;

        if (qNorm.includes(` ${pg.core_name} `) || (compact(pg.core_name).length >= 4 && qCompact.includes(compact(pg.core_name)))) {
            matched = true;
        } else if (nameTokens.length && nameTokens.every((t) => t.length >= 2 && qTokens.has(t))) {
            matched = true;
        } else if (nameTokens.some((t) => t.length >= 4 && freq.get(t) === 1 && qTokens.has(t))) {
            matched = true;
        }
        if (matched) hits.push(pg);
    }
    return hits;
}

function findMentionedLocations(q, pgs) {
    const qNorm = ` ${norm(q)} `;
    const qCompact = compact(q);
    const parts = new Map(); // compact -> display
    for (const pg of pgs) {
        String(pg.location || "").split(",").forEach((raw) => {
            const part = raw.trim();
            if (compact(part).length >= 4) parts.set(compact(part), part);
        });
    }
    const found = [];
    for (const [c, display] of parts) {
        if (qCompact.includes(c) || qNorm.includes(` ${norm(display)} `)) found.push(display);
    }
    return found;
}

/** Question words that equal a distinctive word of at least one real amenity name (e.g. wifi, ac, cctv). */
function matchAmenityTokens(q, pgs) {
    const real = new Set();
    for (const pg of pgs) for (const a of pg.amenity_list) tokens(a).filter(isDistinctive).forEach((t) => real.add(t));
    const matched = new Set();
    for (const t of tokens(q)) if (real.has(t) && !QUESTION_STOP.has(t)) matched.add(t);
    return [...matched];
}

const pgHasAmenityToken = (pg, token) => pg.amenity_list.some((a) => tokens(a).includes(token));

/** Human label for matched amenity words, using the real amenity names stored in MySQL. */
function amenityLabelFor(matchedTokens, pgs) {
    const groups = [];
    for (const tk of matchedTokens) {
        const names = [];
        for (const pg of pgs) for (const a of pg.amenity_list) if (tokens(a).includes(tk) && !names.includes(a)) names.push(a);
        if (names.length) groups.push(names);
    }
    // drop a group whose names are already covered by another (e.g. "washing" + "machine" -> "Washing Machine")
    const kept = groups.filter((g, i) => !groups.some((o, j) => j !== i && g.every((n) => o.includes(n)) && (o.length > g.length || j < i)));
    return kept.map((g) => g.join(" / ")).join(" + ");
}

function parseBudget(q) {
    const t = norm(q);
    const num = "(\\d{3,7})";
    let m = t.match(new RegExp(`between ${num} (?:and|to) ${num}`)) || t.match(new RegExp(`\\b${num} (?:to|and) ${num}\\b`));
    if (m) { const a = Number(m[1]); const b = Number(m[2]); return { min: Math.min(a, b), max: Math.max(a, b) }; }
    m = t.match(new RegExp(`(?:under|below|less than|within|upto|up to|max(?:imum)?|budget(?: of| is)?|not more than|cheaper than|lower than|at most) ${num}`));
    if (m) return { min: null, max: Number(m[1]) };
    m = t.match(new RegExp(`(?:above|over|more than|at least|min(?:imum)?|greater than|higher than|costlier than) ${num}`));
    if (m) return { min: Number(m[1]), max: null };
    m = t.match(new RegExp(`\\b${num}\\b`));
    if (m && /\b(rent|price|cost|budget|pgs?|rooms?|around|about)\b/.test(t)) {
        const v = Number(m[1]);
        if (v >= 1000) return { min: null, max: v };
    }
    return null;
}

function parseCapacity(q) {
    const t = norm(q);
    if (/\b(single|1 sharing|one sharing|single occupancy|private room|1 bed|one bed)\b/.test(t)) return 1;
    if (/\b(double|2 sharing|two sharing|twin|double sharing|2 bed|two bed)\b/.test(t)) return 2;
    if (/\b(triple|3 sharing|three sharing|triple sharing|3 bed|three bed)\b/.test(t)) return 3;
    return null;
}

const inBudget = (value, b) => !b || ((b.min === null || value >= b.min) && (b.max === null || value <= b.max));

const budgetText = (b) => {
    if (!b) return "";
    if (b.min !== null && b.max !== null) return ` between ${money(b.min)} and ${money(b.max)}`;
    if (b.max !== null) return ` under ${money(b.max)}`;
    return ` above ${money(b.min)}`;
};

// ------------------------------------------------------------------
// Answer builders
// ------------------------------------------------------------------
const helpAnswer = (pgs) => ({
    answer: pgs.length
        ? "I can help with the PGs listed on Livinkey right now. Try asking about vacant rooms, rent, amenities, security deposit, ratings or a PG by name."
        : "There are no PGs listed on Livinkey right now. Please check back soon.",
    view: null,
    data: null
});

function listPgs(pgs, heading) {
    const shown = pgs.slice(0, MAX_PGS);
    const more = pgs.length > shown.length ? ` Showing the first ${shown.length}.` : "";
    return { answer: `${heading}${more}`, view: "pg_list", data: shown.map(shapePg) };
}

function pgDetail(pg) {
    const lines = [`Location: ${pg.location || "not listed"}`, `Rent: ${money(pg.rent)} per month`];
    const rents = pg.rooms.map((r) => r.room_rent).filter((v) => v !== null && v !== undefined);
    if (rents.length) {
        const lo = Math.min(...rents);
        const hi = Math.max(...rents);
        if (lo !== hi) lines.push(`Room rents range from ${money(lo)} to ${money(hi)}`);
    }
    if (pg.security_fee !== null) lines.push(`Security fee: ${money(pg.security_fee)}`);
    lines.push(`${plural(pg.vacant_rooms, "completely vacant room")} right now`);
    if (pg.amenity_list.length) lines.push(`Amenities: ${pg.amenities}`);
    if (pg.rating) lines.push(`Rating: ${pg.rating}/5 from ${plural(pg.reviews, "review")}`);
    return { answer: `Here are the details for ${pg.name}.\n${lines.join("\n")}`, view: "pg_detail", data: shapePg(pg) };
}

function vacantRooms({ pgs, budget, capacity, scopeText }) {
    const rooms = [];
    for (const pg of pgs) {
        for (const room of pg.vacant_room_list) {
            const rent = room.room_rent !== null && room.room_rent !== undefined ? room.room_rent : pg.rent;
            if (!inBudget(rent, budget)) continue;
            if (capacity && room.capacity !== capacity) continue;
            rooms.push({ pg, room, rent });
        }
    }
    rooms.sort((a, b) => a.rent - b.rent
        || a.pg.name.localeCompare(b.pg.name)
        || String(a.room.room_number).localeCompare(String(b.room.room_number), undefined, { numeric: true }));

    const sharing = capacity ? ` (${capacity === 1 ? "single" : capacity === 2 ? "double" : "triple"} sharing)` : "";
    const filterText = `${sharing}${budgetText(budget)}`;

    if (!rooms.length) {
        const manualVacant = pgs.filter((p) => p.manual && p.vacant_rooms > 0);
        const freeBeds = pgs.reduce((s, p) => s + p.free_beds, 0);
        let note = `I couldn't find a completely vacant room${scopeText}${filterText} right now.`;
        if (manualVacant.length && !budget && !capacity) {
            note = `${manualVacant.map((p) => `${p.name} has ${plural(p.vacant_rooms, "vacant room")}`).join("; ")}. Please contact Livinkey for the exact rooms.`;
        } else if (freeBeds > 0 && !budget && !capacity) {
            note += ` Some shared rooms still have a free bed (${plural(freeBeds, "bed")} in total), so it's worth contacting Livinkey.`;
        } else if (budget || capacity) {
            note += " Try a different budget or room type.";
        }
        return { answer: note, view: null, data: null };
    }

    const shown = rooms.slice(0, MAX_ROOMS);
    const more = rooms.length > shown.length ? ` Showing the first ${shown.length}.` : "";
    return {
        answer: `${plural(rooms.length, "completely vacant room")} available${scopeText}${filterText}.${more}`,
        view: "vacant_rooms",
        data: shown.map(({ pg, room }) => shapeRoom(pg, room))
    };
}

// ------------------------------------------------------------------
// Main entry points
// ------------------------------------------------------------------
async function answerQuestion(question) {
    const q = String(question || "").trim().slice(0, 500);
    const { pgs, contact } = await loadData();
    const t = norm(q);
    const has = (re) => re.test(t);

    if (!t) return helpAnswer(pgs);

    // ---- small talk ----------------------------------------------------
    if (has(/^(hi|hii+|hello|hey|namaste|good (morning|afternoon|evening))\b/) && t.split(" ").length <= 4) {
        return { answer: "Hello! 👋 I'm the Livinkey assistant. Ask me about our PGs, vacant rooms, rent or amenities.", view: null, data: null };
    }
    if (has(/\b(thanks|thank you|thx)\b/) && t.split(" ").length <= 4) {
        return { answer: "You're welcome! Let me know if you'd like to know anything else about our PGs.", view: null, data: null };
    }
    if (has(/\b(help|what can you do|how (do|can) you help)\b/)) return helpAnswer(pgs);

    if (!pgs.length) return helpAnswer(pgs);

    // ---- contact ------------------------------------------------------------
    if (has(/\b(contact|phone|call|whatsapp|email|mail|reach|talk to|owner|manager|office)\b/) && !has(/\b(vacan\w*|available)\b/)) {
        const bits = [];
        if (contact && contact.phone) bits.push(`Phone: ${contact.phone}`);
        if (contact && contact.whatsapp) bits.push(`WhatsApp: ${contact.whatsapp}`);
        if (contact && contact.email) bits.push(`Email: ${contact.email}`);
        if (contact && contact.address) bits.push(`Address: ${contact.address}`);
        return {
            answer: bits.length
                ? `You can reach Livinkey here:\n${bits.join("\n")}`
                : "Please use the Contact page on this website to reach the Livinkey team.",
            view: null,
            data: null
        };
    }

    // ---- entities -------------------------------------------------------
    const mentionedPgs = findMentionedPgs(q, pgs);
    const mentionedLocations = findMentionedLocations(q, pgs);
    const amenityTokens = matchAmenityTokens(q, pgs);
    const budget = parseBudget(q);
    const capacity = parseCapacity(q);

    let scope = pgs;
    let scopeText = "";
    if (mentionedPgs.length) {
        scope = mentionedPgs;
        scopeText = mentionedPgs.length === 1 ? ` in ${mentionedPgs[0].name}` : "";
    } else if (mentionedLocations.length) {
        const locs = mentionedLocations.map((l) => compact(l));
        const inLoc = pgs.filter((p) => locs.some((l) => compact(p.location).includes(l)));
        if (inLoc.length) { scope = inLoc; scopeText = ` in ${mentionedLocations.join(" / ")}`; }
    }
    if (amenityTokens.length && !mentionedPgs.length) {
        scope = scope.filter((p) => amenityTokens.every((tk) => pgHasAmenityToken(p, tk)));
    }
    const amenityLabel = amenityLabelFor(amenityTokens, pgs);
    const amenityText = amenityTokens.length && !mentionedPgs.length ? ` with ${amenityLabel}` : "";

    // ---- intent words --------------------------------------------------------
    const vacancy = has(/\b(vacan\w*|available|availability|empty|unoccupied|free (rooms?|beds?|spots?|space)|openings?|book|booking|spots?|beds?|seats?|space|move in)\b/);
    const wantsRooms = has(/\b(rooms?|beds?|seats?|spots?|sharing)\b/) || !!capacity;
    const wantsPg = has(/\b(pgs?|propert(y|ies)|hostels?|apartments?|accommodations?|places?|houses?)\b/);
    const security = has(/\b(security|deposit|refundable)\b/);
    const amenityAsk = has(/\b(amenit\w*|facilit\w*|features?|services?|offer|includes?|included|provided|provide|have|has|with)\b/);
    const cheapest = has(/\b(cheap\w*|lowest|affordable|least expensive|economical|low cost|minimum rent|budget friendly|pocket friendly)\b/);
    const costliest = has(/\b(expensive|costliest|highest|premium|luxury|luxurious|most costly)\b/);
    const rentAsk = has(/\b(rent|price|prices|pricing|cost|costs|charges?|fees?|per month|monthly|how much|tariff)\b/);
    const ratingAsk = has(/\b(rating|ratings|rated|review|reviews|stars?|feedback|top|popular)\b/);
    const locationAsk = has(/\b(location|locations|where|address|area|areas|located|nearby|near)\b/);
    const countAsk = has(/\bhow many\b/);
    const listAsk = has(/\b(list|all|every|show|which|options)\b/);

    const roomSearch = wantsRooms && (!!budget || !!capacity) && !security;
    const single = mentionedPgs.length === 1 ? mentionedPgs[0] : null;

    // ---- security deposit ----------------------------------------------------
    if (security) {
        if (single) {
            return single.security_fee === null
                ? { answer: `The security deposit for ${single.name} isn't listed. Please contact Livinkey to confirm.`, view: null, data: null }
                : { answer: `The security fee for ${single.name} is ${money(single.security_fee)}.`, view: "pg_detail", data: shapePg(single) };
        }
        const fees = scope.filter((p) => p.security_fee !== null);
        if (!fees.length) return { answer: "Security deposit amounts aren't listed yet. Please contact Livinkey.", view: null, data: null };
        const lines = fees.slice(0, MAX_PGS).map((p) => `• ${p.name}: ${money(p.security_fee)}`);
        return { answer: `Security fee by PG:\n${lines.join("\n")}`, view: null, data: null };
    }

    // ---- ratings --------------------------------------------------------------
    if (ratingAsk && !vacancy) {
        if (single) {
            return single.rating
                ? { answer: `${single.name} is rated ${single.rating}/5 from ${plural(single.reviews, "review")}.`, view: "pg_detail", data: shapePg(single) }
                : { answer: `${single.name} doesn't have any reviews yet.`, view: "pg_detail", data: shapePg(single) };
        }
        const rated = scope.filter((p) => p.rating).sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
        if (!rated.length) return { answer: "There are no reviews yet. Reviews will appear here once guests and tenants share feedback.", view: null, data: null };
        const lines = rated.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${p.rating}/5 (${plural(p.reviews, "review")})`);
        return { answer: `Top rated PGs${scopeText}:\n${lines.join("\n")}`, view: null, data: null };
    }

    // ---- vacancy ----------------------------------------------------------------
    if (vacancy || roomSearch) {
        if (single && !wantsRooms && !budget && !capacity) {
            // "Is Alishan PG available?" -> a PG-level answer
            return {
                answer: single.vacant_rooms > 0
                    ? `${single.name} has ${plural(single.vacant_rooms, "completely vacant room")} right now.`
                    : `${single.name} has no completely vacant rooms right now.`,
                view: "pg_detail",
                data: shapePg(single)
            };
        }
        if (wantsRooms || roomSearch || !wantsPg) {
            return vacantRooms({ pgs: scope, budget, capacity, scopeText: `${scopeText}${amenityText}` });
        }
        // PG-level: "Show all available PGs", "PGs with vacancy"
        const available = scope.filter((p) => p.vacant_rooms > 0 && inBudget(p.rent, budget));
        if (!available.length) {
            return { answer: `No PGs${scopeText}${amenityText}${budgetText(budget)} have a completely vacant room right now.`, view: null, data: null };
        }
        return listPgs([...available].sort((a, b) => a.rent - b.rent),
            `${plural(available.length, "PG")} with vacant rooms${scopeText}${amenityText}${budgetText(budget)}.`);
    }

    // ---- single PG asked about ------------------------------------------------
    if (single) {
        if (rentAsk && !amenityAsk) {
            return {
                answer: `The rent at ${single.name} is ${money(single.rent)} per month${single.security_fee !== null ? ` with a security fee of ${money(single.security_fee)}` : ""}.`,
                view: "pg_detail",
                data: shapePg(single)
            };
        }
        if (locationAsk && !rentAsk) {
            return { answer: `${single.name} is located at ${single.location || "an address that isn't listed yet"}.`, view: "pg_detail", data: shapePg(single) };
        }
        if (amenityTokens.length) {
            const missing = amenityTokens.filter((tk) => !pgHasAmenityToken(single, tk));
            return {
                answer: missing.length
                    ? `${single.name} does not list ${amenityLabelFor(missing, pgs)}.`
                    : `Yes, ${single.name} has ${amenityLabelFor(amenityTokens, [single])}.`,
                view: "pg_detail",
                data: shapePg(single)
            };
        }
        if (has(/\b(amenit\w*|facilit\w*|features?|services?|offer|includes?|included|provided)\b/)) {
            return {
                answer: single.amenity_list.length ? `${single.name} offers: ${single.amenities}.` : `No amenities are listed for ${single.name} yet.`,
                view: "pg_detail",
                data: shapePg(single)
            };
        }
        return pgDetail(single);
    }
    if (mentionedPgs.length > 1 && !amenityTokens.length) {
        return listPgs(mentionedPgs, "Here are the PGs matching your question.");
    }

    // ---- amenity search across PGs ---------------------------------------------
    if (amenityTokens.length) {
        const matching = scope.filter((p) => inBudget(p.rent, budget));
        if (!matching.length) return { answer: `No PG currently lists ${amenityLabel}${scopeText}${budgetText(budget)}.`, view: null, data: null };
        return listPgs([...matching].sort((a, b) => a.rent - b.rent), `${plural(matching.length, "PG")} with ${amenityLabel}${scopeText}${budgetText(budget)}.`);
    }

    // ---- price based lists ------------------------------------------------------
    if (cheapest || costliest || budget || rentAsk) {
        const list = scope.filter((p) => inBudget(p.rent, budget));
        if (!list.length) {
            return { answer: `No PG matches${budgetText(budget) || " that price"}${scopeText}. Try a different budget.`, view: null, data: null };
        }
        const desc = costliest && !cheapest;
        const sorted = [...list].sort((a, b) => (desc ? b.rent - a.rent : a.rent - b.rent) || a.name.localeCompare(b.name));
        if (cheapest || costliest) {
            const top = sorted[0];
            const tie = sorted.filter((p) => p.rent === top.rent);
            const word = desc ? "Highest" : "Lowest";
            if (tie.length === 1) {
                return { answer: `${word} rent: ${top.name} at ${money(top.rent)} per month.`, view: "pg_detail", data: shapePg(top) };
            }
            return listPgs(tie, `${word} rent is ${money(top.rent)} per month at ${tie.length} PGs.`);
        }
        return listPgs(sorted, `${plural(sorted.length, "PG")}${budgetText(budget) || " by rent (lowest first)"}${scopeText}.`);
    }

    // ---- locations ------------------------------------------------------------------
    if (locationAsk && !mentionedLocations.length) {
        const byLoc = new Map();
        pgs.forEach((p) => { const k = p.location || "Location not listed"; byLoc.set(k, (byLoc.get(k) || 0) + 1); });
        const lines = [...byLoc.entries()].map(([loc, n]) => `• ${loc}: ${plural(n, "PG")}`);
        return { answer: `Our PGs are located in:\n${lines.join("\n")}`, view: null, data: null };
    }

    // ---- generic listing -------------------------------------------------------------
    if (countAsk || listAsk || mentionedLocations.length || wantsPg) {
        const heading = countAsk
            ? `We currently have ${plural(scope.length, "PG")}${scopeText}.`
            : `${plural(scope.length, "PG")}${scopeText || " available on Livinkey"}.`;
        return listPgs(scope, heading);
    }

    // ---- unknown -----------------------------------------------------------------------
    return {
        answer: "I couldn't match that to our current PG data. You can ask about vacant rooms, rent, amenities, security deposit, ratings or a PG by name.",
        view: null,
        data: null
    };
}

async function getQuickQuestions() {
    const { pgs } = await loadData();
    const questions = [];
    const push = (label, question) => {
        if (questions.length < 6 && !questions.some((x) => x.question === question)) questions.push({ label, question });
    };

    if (!pgs.length) {
        return { questions: [{ label: "👋 What can you do?", question: "What can you help me with?" }] };
    }

    push("🏠 Available PGs", "Show all available PGs");
    push("🚪 Vacant rooms", "Which rooms are vacant right now?");
    push("💰 Cheapest PG", "Which is the cheapest PG?");

    // most common locality among the live PGs
    const locCount = new Map();
    pgs.forEach((p) => {
        const first = String(p.location || "").split(",")[0].trim();
        if (first) locCount.set(first, (locCount.get(first) || 0) + 1);
    });
    const topLoc = [...locCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topLoc) push(`📍 PGs in ${topLoc[0]}`, `Show PGs in ${topLoc[0]}`);

    // most common amenity across the live PGs
    const amenityCount = new Map();
    pgs.forEach((p) => p.amenity_list.forEach((a) => amenityCount.set(a, (amenityCount.get(a) || 0) + 1)));
    const topAmenity = [...amenityCount.entries()].filter(([a]) => tokens(a).some(isDistinctive)).sort((a, b) => b[1] - a[1])[0];
    if (topAmenity) push(`✨ PGs with ${topAmenity[0]}`, `Which PGs have ${topAmenity[0]}?`);

    // budget question derived from the median rent
    const rents = pgs.map((p) => p.rent).filter((r) => r > 0).sort((a, b) => a - b);
    if (rents.length) {
        const median = rents[Math.floor(rents.length / 2)];
        const cap = Math.ceil(median / 1000) * 1000;
        push(`💸 Under ${money(cap)}`, `Show PGs under ${cap}`);
    }

    return { questions };
}

/** Drop cached data so the next call re-reads MySQL (used by tests / maintenance). */
const clearCache = () => { cache = { at: 0, data: null }; };

module.exports = { getQuickQuestions, answerQuestion, clearCache };
