/**
 * Electricity bill calculator.
 *
 * Every PG can have its own tariff:
 *   billing_mode  flat -> units x rate_per_unit
 *                 slab -> each block of units charged at its own rate
 *                         (slabs = [{ upto: 100, rate: 5 }, { upto: 300, rate: 7 }, { upto: null, rate: 9 }])
 *   multiplier    meter multiplying factor (MF / CT ratio), usually 1
 *   fixed_charge  fixed monthly charge added once per meter
 *   min_charge    the bill never goes below this (applied before tax)
 *   tax_percent   electricity duty / GST etc. on top
 *   round_to_rupee  round the final amount to a whole rupee
 *   meter_mode    single -> one meter (main). dual -> the PG has a MAIN meter and an
 *                 INVERTER meter; bills need previous + current readings for both and
 *                 the units of both meters are added together.
 *
 * An admin only types the previous and current meter readings.
 */
const db = require("../config/db");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function normaliseSlabs(raw) {
    let slabs = raw;
    if (typeof slabs === "string") { try { slabs = JSON.parse(slabs); } catch (_) { slabs = []; } }
    if (!Array.isArray(slabs)) return [];
    return slabs
        .map(s => ({ upto: s.upto === null || s.upto === "" || s.upto === undefined ? null : Number(s.upto), rate: Number(s.rate) }))
        .filter(s => isFinite(s.rate) && s.rate >= 0 && (s.upto === null || (isFinite(s.upto) && s.upto > 0)))
        .sort((a, b) => (a.upto === null ? Infinity : a.upto) - (b.upto === null ? Infinity : b.upto));
}

/** Validates + cleans a settings payload. Returns { errors, data }. */
function validateSettings(b) {
    const errors = [];
    const billing_mode = b.billing_mode === "slab" ? "slab" : "flat";
    const num = (v, def = 0) => (v === "" || v === undefined || v === null ? def : Number(v));
    const rate_per_unit = num(b.rate_per_unit);
    const fixed_charge = num(b.fixed_charge);
    const min_charge = num(b.min_charge);
    const multiplier = num(b.multiplier, 1);
    const tax_percent = num(b.tax_percent);
    if (![rate_per_unit, fixed_charge, min_charge, multiplier, tax_percent].every(isFinite)) errors.push("All values must be numbers.");
    if (rate_per_unit < 0 || fixed_charge < 0 || min_charge < 0) errors.push("Rates and charges cannot be negative.");
    if (multiplier <= 0 || multiplier > 1000) errors.push("The meter multiplier must be more than 0 (usually 1).");
    if (tax_percent < 0 || tax_percent > 100) errors.push("Tax must be between 0 and 100%.");
    let slabs = [];
    if (billing_mode === "slab") {
        slabs = normaliseSlabs(b.slabs);
        if (!slabs.length) errors.push("Add at least one slab (units up to … at rate …).");
        else if (slabs[slabs.length - 1].upto !== null) errors.push("The last slab must have no upper limit (\"and above\").");
        const uptos = slabs.filter(s => s.upto !== null).map(s => s.upto);
        if (new Set(uptos).size !== uptos.length) errors.push("Two slabs cannot end at the same unit.");
    } else if (!(rate_per_unit > 0)) errors.push("Enter the cost per unit (₹ per unit).");
    const meter_mode = b.meter_mode === "dual" ? "dual" : "single";
    return {
        errors,
        data: {
            meter_mode, billing_mode, rate_per_unit, slabs, fixed_charge, min_charge, multiplier, tax_percent,
            round_to_rupee: b.round_to_rupee === undefined ? 1 : (b.round_to_rupee === true || b.round_to_rupee === 1 || b.round_to_rupee === "1" || b.round_to_rupee === "true" ? 1 : 0),
            is_active: b.is_active === undefined ? 1 : (b.is_active === true || b.is_active === 1 || b.is_active === "1" || b.is_active === "true" ? 1 : 0)
        }
    };
}

/** One meter's usage: validates the pair of readings and applies the multiplier. */
function meterUsage(label, key, previous, current, multiplier) {
    const prev = Number(previous), cur = Number(current);
    if (previous === "" || current === "" || previous === null || current === null || previous === undefined || current === undefined
        || !isFinite(prev) || !isFinite(cur) || prev < 0 || cur < 0) throw new Error(label === "Meter" ? "Meter readings must be valid numbers." : `${label}: readings must be valid numbers.`);
    if (cur < prev) throw new Error(label === "Meter" ? "The current reading cannot be lower than the previous reading." : `${label}: the current reading cannot be lower than the previous reading.`);
    const raw = cur - prev;
    return { key, label, previous: prev, current: cur, raw_units: r2(raw), units: r2(raw * multiplier) };
}

/**
 * Pure calculation – used by the API, the bill creator and unit tests.
 * For a dual-meter PG (settings.meter_mode === "dual") pass the inverter meter
 * readings in opts.inverterPrevious / opts.inverterCurrent.
 */
function calculate(settings, previous, current, { splitCount = 1, inverterPrevious, inverterCurrent } = {}) {
    const multiplier = Number(settings.multiplier || 1);
    const dual = settings.meter_mode === "dual";
    const meters = [meterUsage(dual ? "Main meter" : "Meter", "main", previous, current, multiplier)];
    if (dual) meters.push(meterUsage("Inverter meter", "inverter", inverterPrevious, inverterCurrent, multiplier));

    const main = meters[0];
    const rawUnits = meters.reduce((t, m) => t + m.raw_units, 0);
    const units = r2(meters.reduce((t, m) => t + m.units, 0));

    let energy = 0;
    const lines = [];
    if (settings.billing_mode === "slab") {
        // Slabs apply to the combined usage of both meters.
        const slabs = normaliseSlabs(settings.slabs);
        let from = 0, left = units;
        for (const s of slabs) {
            if (left <= 0) break;
            const cap = s.upto === null ? Infinity : s.upto - from;
            const used = Math.min(left, cap);
            if (used > 0) { lines.push({ label: `${r2(from)}–${s.upto === null ? "above" : s.upto} units`, units: r2(used), rate: s.rate, amount: r2(used * s.rate) }); energy += used * s.rate; }
            left -= used; from = s.upto === null ? from : s.upto;
        }
    } else {
        const rate = Number(settings.rate_per_unit || 0);
        // One line per meter so the bill shows where every unit came from.
        meters.forEach(m => { lines.push({ label: dual ? `${m.label} energy` : "Energy charge", units: m.units, rate, amount: r2(m.units * rate) }); });
        energy = units * rate;
    }
    energy = r2(energy);

    const fixed = r2(settings.fixed_charge || 0);
    let subtotal = r2(energy + fixed);
    const min = r2(settings.min_charge || 0);
    let minApplied = false;
    if (min > 0 && subtotal < min) { subtotal = min; minApplied = true; }
    const tax = r2(subtotal * (Number(settings.tax_percent || 0) / 100));
    let total = r2(subtotal + tax);
    if (Number(settings.round_to_rupee)) total = Math.round(total);

    const split = Math.max(1, parseInt(splitCount, 10) || 1);
    const out = {
        meter_mode: dual ? "dual" : "single",
        previous: main.previous, current: main.current, raw_units: r2(rawUnits), multiplier, units,
        main_units: main.units,
        meters,
        energy_charge: energy, fixed_charge: fixed, min_charge_applied: minApplied, min_charge: min,
        subtotal, tax_percent: Number(settings.tax_percent || 0), tax, total,
        split_count: split, per_person: split > 1 ? r2(total / split) : total,
        effective_rate: units > 0 ? r2(total / units) : 0,
        lines
    };
    if (dual) {
        out.inverter_previous = meters[1].previous;
        out.inverter_current = meters[1].current;
        out.inverter_units = meters[1].units;
    }
    return out;
}

const DEFAULTS = { meter_mode: "single", billing_mode: "flat", rate_per_unit: 0, slabs: [], fixed_charge: 0, min_charge: 0, multiplier: 1, tax_percent: 0, round_to_rupee: 1, is_active: 1 };

async function getSettings(pgId) {
    const [rows] = await db.execute("SELECT * FROM pg_electricity_settings WHERE pg_id = ? LIMIT 1", [pgId]);
    if (!rows.length) return { ...DEFAULTS, pg_id: Number(pgId), configured: false };
    const r = rows[0];
    return {
        pg_id: r.pg_id, configured: true, meter_mode: r.meter_mode === "dual" ? "dual" : "single", billing_mode: r.billing_mode,
        rate_per_unit: Number(r.rate_per_unit), slabs: normaliseSlabs(r.slabs),
        fixed_charge: Number(r.fixed_charge), min_charge: Number(r.min_charge), multiplier: Number(r.multiplier),
        tax_percent: Number(r.tax_percent), round_to_rupee: Number(r.round_to_rupee), is_active: Number(r.is_active),
        updated_at: r.updated_at
    };
}

async function getAllSettings() {
    const [pgs] = await db.execute("SELECT id, name, is_active FROM pgs ORDER BY name");
    const [rows] = await db.execute("SELECT * FROM pg_electricity_settings");
    const map = new Map(rows.map(r => [r.pg_id, r]));
    return pgs.map(p => {
        const r = map.get(p.id);
        const base = r ? {
            configured: true, meter_mode: r.meter_mode === "dual" ? "dual" : "single", billing_mode: r.billing_mode, rate_per_unit: Number(r.rate_per_unit), slabs: normaliseSlabs(r.slabs),
            fixed_charge: Number(r.fixed_charge), min_charge: Number(r.min_charge), multiplier: Number(r.multiplier),
            tax_percent: Number(r.tax_percent), round_to_rupee: Number(r.round_to_rupee), is_active: Number(r.is_active), updated_at: r.updated_at
        } : { ...DEFAULTS, configured: false };
        return { pg_id: p.id, pg_name: p.name, pg_active: !!p.is_active, ...base };
    });
}

async function saveSettings(pgId, data, adminId) {
    await db.execute(
        `INSERT INTO pg_electricity_settings
           (pg_id, meter_mode, billing_mode, rate_per_unit, slabs, fixed_charge, min_charge, multiplier, tax_percent, round_to_rupee, is_active, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE meter_mode=VALUES(meter_mode), billing_mode=VALUES(billing_mode), rate_per_unit=VALUES(rate_per_unit), slabs=VALUES(slabs),
           fixed_charge=VALUES(fixed_charge), min_charge=VALUES(min_charge), multiplier=VALUES(multiplier), tax_percent=VALUES(tax_percent),
           round_to_rupee=VALUES(round_to_rupee), is_active=VALUES(is_active), updated_by=VALUES(updated_by)`,
        [pgId, data.meter_mode === "dual" ? "dual" : "single", data.billing_mode, data.rate_per_unit, JSON.stringify(data.slabs || []), data.fixed_charge, data.min_charge,
         data.multiplier, data.tax_percent, data.round_to_rupee, data.is_active, adminId || null]
    );
}

/**
 * Last known meter reading for a tenant (or a whole room), so the bill form can
 * pre-fill "previous reading" and the admin only types the new one.
 */
async function lastReading({ tenantId, roomId }) {
    let rows;
    const cols = "current_reading, inverter_current_reading, billing_month";
    if (roomId) {
        [rows] = await db.execute(
            `SELECT ${cols} FROM bills WHERE room_id = ? AND current_reading IS NOT NULL AND deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM electricity_meter_readings emr WHERE emr.bill_id = bills.id AND emr.deleted_at IS NOT NULL)
             ORDER BY created_at DESC, id DESC LIMIT 1`, [roomId]);
    } else if (tenantId) {
        [rows] = await db.execute(
            `SELECT ${cols} FROM bills WHERE tenant_id = ? AND current_reading IS NOT NULL AND deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM electricity_meter_readings emr WHERE emr.bill_id = bills.id AND emr.deleted_at IS NOT NULL)
             ORDER BY created_at DESC, id DESC LIMIT 1`, [tenantId]);
    } else rows = [];
    return rows[0] ? {
        reading: Number(rows[0].current_reading),
        inverter_reading: rows[0].inverter_current_reading === null || rows[0].inverter_current_reading === undefined ? null : Number(rows[0].inverter_current_reading),
        billing_month: rows[0].billing_month
    } : null;
}

/** Resolve the PG a bill is being created for. */
async function resolvePgId({ pgId, roomId, tenantIds }) {
    if (pgId) return Number(pgId);
    if (roomId) {
        const [r] = await db.execute("SELECT f.pg_id FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ? LIMIT 1", [roomId]);
        if (r[0]) return r[0].pg_id;
    }
    if (tenantIds && tenantIds.length) {
        const [r] = await db.execute("SELECT pg_id FROM tenant_details WHERE tenant_id = ? LIMIT 1", [tenantIds[0]]);
        if (r[0]) return r[0].pg_id;
    }
    return null;
}


// ============================================================
// METER READING HISTORY
// Readings live on bills; electricity_meter_readings is the history ledger
// (one row per bill). It is synced from bills on demand so every bill path
// (single, split, group) is always covered, and "delete" only hides the reading
// from history - the bill itself is never touched.
// ============================================================
async function syncReadingsFromBills() {
    await db.query(`
        INSERT IGNORE INTO electricity_meter_readings
          (bill_id, tenant_id, pg_id, room_id, billing_month, meter_mode, previous_reading, current_reading, units,
           inverter_previous_reading, inverter_current_reading, inverter_units, amount, recorded_by, recorded_at)
        SELECT b.id, b.tenant_id, COALESCE(ff.pg_id, td.pg_id), b.room_id, b.billing_month, COALESCE(b.meter_mode,'single'),
               b.previous_reading, b.current_reading, b.units_consumed,
               b.inverter_previous_reading, b.inverter_current_reading, b.inverter_units,
               b.electricity_amount, b.created_by, b.created_at
        FROM bills b
        LEFT JOIN tenant_details td ON td.tenant_id = b.tenant_id
        LEFT JOIN rooms rr ON rr.id = b.room_id
        LEFT JOIN floors ff ON ff.id = rr.floor_id
        WHERE b.deleted_at IS NULL AND b.current_reading IS NOT NULL
    `);
}

function readingFilters(q = {}, scopePgIds = null) {
    const where = ["e.deleted_at IS NULL"];
    const params = [];
    if (q.pg_id) { where.push("e.pg_id = ?"); params.push(Number(q.pg_id)); }
    if (q.room_id) { where.push("e.room_id = ?"); params.push(Number(q.room_id)); }
    if (q.tenant_id) { where.push("e.tenant_id = ?"); params.push(Number(q.tenant_id)); }
    if (q.month) { where.push("e.billing_month = ?"); params.push(String(q.month)); }
    if (q.from) { where.push("DATE(e.recorded_at) >= ?"); params.push(String(q.from)); }
    if (q.to) { where.push("DATE(e.recorded_at) <= ?"); params.push(String(q.to)); }
    if (q.q) {
        where.push("(t.full_name LIKE ? OR r.room_number LIKE ? OR p.name LIKE ?)");
        const like = `%${String(q.q).trim()}%`;
        params.push(like, like, like);
    }
    if (Array.isArray(scopePgIds)) {
        if (!scopePgIds.length) where.push("1=0");
        else { where.push(`e.pg_id IN (${scopePgIds.map(() => "?").join(",")})`); params.push(...scopePgIds.map(Number)); }
    }
    return { where: where.join(" AND "), params };
}

const READING_FROM = `
    FROM electricity_meter_readings e
    LEFT JOIN tenants t ON t.id = e.tenant_id
    LEFT JOIN pgs p ON p.id = e.pg_id
    LEFT JOIN rooms r ON r.id = e.room_id
    LEFT JOIN bills b ON b.id = e.bill_id
    LEFT JOIN admins a ON a.id = e.recorded_by`;

async function listReadings(q = {}, scopePgIds = null) {
    await syncReadingsFromBills();
    const { where, params } = readingFilters(q, scopePgIds);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 5000);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const [rows] = await db.query(
        `SELECT e.id, e.bill_id, e.tenant_id, e.pg_id, e.room_id, e.billing_month, e.meter_mode,
                e.previous_reading, e.current_reading, e.units,
                e.inverter_previous_reading, e.inverter_current_reading, e.inverter_units,
                e.amount, e.recorded_at, t.full_name AS tenant_name, p.name AS pg_name, r.room_number,
                b.status AS bill_status, b.bill_group_id, a.name AS recorded_by_name
         ${READING_FROM} WHERE ${where}
         ORDER BY e.recorded_at DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const [[tot]] = await db.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(e.units),0) AS units, COALESCE(SUM(e.amount),0) AS amount ${READING_FROM} WHERE ${where}`, params);
    return { rows, total: Number(tot.total), total_units: Number(tot.units), total_amount: Number(tot.amount) };
}

/** Hide readings from history. ids = explicit list, or filters = every reading matching the filter. */
async function deleteReadings({ ids, filters }, adminId, scopePgIds = null) {
    let targetIds = [];
    if (Array.isArray(ids) && ids.length) {
        targetIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    } else if (filters && typeof filters === "object") {
        const { where, params } = readingFilters(filters, scopePgIds);
        const [rows] = await db.query(`SELECT e.id ${READING_FROM} WHERE ${where}`, params);
        targetIds = rows.map(r => r.id);
    }
    if (!targetIds.length) return 0;
    let scopeSql = "", scopeParams = [];
    if (Array.isArray(scopePgIds)) {
        if (!scopePgIds.length) return 0;
        scopeSql = ` AND pg_id IN (${scopePgIds.map(() => "?").join(",")})`;
        scopeParams = scopePgIds.map(Number);
    }
    const [res] = await db.query(
        `UPDATE electricity_meter_readings SET deleted_at = NOW(), deleted_by = ?
         WHERE deleted_at IS NULL AND id IN (?)${scopeSql}`, [adminId || null, targetIds, ...scopeParams]);
    return res.affectedRows || 0;
}

module.exports = { syncReadingsFromBills, listReadings, deleteReadings, calculate, validateSettings, getSettings, getAllSettings, saveSettings, lastReading, resolvePgId, normaliseSlabs, r2 };
