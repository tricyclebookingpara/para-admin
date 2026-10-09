// Shared prediction engine (used by the Driver Availability page, and by the
// Passenger Demand page when it is added).
//
// What lives here is everything the two predictions have in common:
//   - Manila time and geohash area helpers
//   - the weather inputs: rainfall and river discharge from Open-Meteo, and
//     tide from the LGU bulletin the admin uploads (Excel, stored in Firestore
//     as tide_bulletin), plus the app's flood-risk rules (FloodRiskClassifier)
//   - multiple linear regression: ordinary least squares, the 80/20 split,
//     MAE / RMSE / R², and HIGH / MODERATE / LOW thresholds
//
// It is pure logic (no DOM, no Firestore). What each prediction counts and
// which inputs it uses is defined in its own file (driver-availability.js).
(function () {
    'use strict';

    const HOUR_MS = 3600 * 1000;

    const CONFIG = {
        // ~5 km geohash cells. The app stores a precision-7 geohash (~150 m);
        // any prefix is the larger cell that contains it.
        areaPrecision: 5,
        // Same points the mobile app uses (Hagonoy town centre for rain, the
        // river branch for discharge).
        rainPoint: { lat: 14.83, lng: 120.73 },
        riverPoint: { lat: 14.8333, lng: 120.7333 },
        feetToMeters: 0.3048,
        // A bulletin reading further than this from the selected time is
        // still used, but flagged as a weak match.
        tideMatchWarnMinutes: 6 * 60,
        // Tide baseline for the risk level: daily highs of the previous
        // baselineDays days when at least this many are in the bulletin,
        // otherwise all uploaded days.
        tideBaselineMinDays: 3,
        // Philippines is UTC+8 with no daylight saving.
        utcOffsetMs: 8 * HOUR_MS,
        baselineDays: 14,
        dischargeAheadDays: 5,
        minTrainingRows: 30,
        splitMinRows: 50,
        testShare: 0.2,
        seed: 42
    };

    // ── Time helpers (everything is Manila local time) ─────────────────
    // "Manila clock as UTC": a Date whose UTC fields read as the Manila wall
    // clock, so plain UTC getters/setters give local days and hours.
    function manilaClock(ms) {
        return new Date(ms + CONFIG.utcOffsetMs);
    }

    function manilaParts(ms) {
        const d = manilaClock(ms);
        return {
            dateKey: d.toISOString().slice(0, 10),
            hour: d.getUTCHours(),
            // Monday = 0 … Sunday = 6
            dow: (d.getUTCDay() + 6) % 7
        };
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function hourKey(dateKey, hour) {
        return `${dateKey}T${pad2(hour)}:00`;
    }

    function addDays(dateKey, n) {
        const [y, m, d] = dateKey.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    }

    function dayOfWeekOf(dateKey) {
        const [y, m, d] = dateKey.split('-').map(Number);
        return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    }

    // Key of the hour that is `offsetHours` after the given Manila date/hour.
    function shiftedHourKey(dateKey, hour, offsetHours) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const shifted = new Date(Date.UTC(y, m - 1, d, hour) + offsetHours * HOUR_MS);
        return `${shifted.toISOString().slice(0, 13)}:00`;
    }

    // ── Geohash (same encoding as the app's util/Geohash.kt) ──────────
    const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

    function geohashEncode(lat, lng, precision) {
        let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
        let hash = '';
        let isLng = true;
        let bit = 0;
        let ch = 0;
        while (hash.length < precision) {
            if (isLng) {
                const mid = (lngMin + lngMax) / 2;
                if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch = ch << 1; lngMax = mid; }
            } else {
                const mid = (latMin + latMax) / 2;
                if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
            }
            isLng = !isLng;
            if (++bit === 5) {
                hash += BASE32[ch];
                bit = 0;
                ch = 0;
            }
        }
        return hash;
    }

    function geohashCenter(hash) {
        let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
        let isLng = true;
        for (const c of hash) {
            const value = BASE32.indexOf(c);
            for (let bit = 4; bit >= 0; bit -= 1) {
                const on = (value >> bit) & 1;
                if (isLng) {
                    const mid = (lngMin + lngMax) / 2;
                    if (on) lngMin = mid; else lngMax = mid;
                } else {
                    const mid = (latMin + latMax) / 2;
                    if (on) latMin = mid; else latMax = mid;
                }
                isLng = !isLng;
            }
        }
        return { lat: (latMin + latMax) / 2, lng: (lngMin + lngMax) / 2 };
    }

    // ── Weather, tide and river data (Open-Meteo, no API key) ──────────
    async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) {
            let reason = '';
            try { reason = (await res.json()).reason || ''; } catch (e) { /* no body */ }
            throw new Error(`Weather service returned ${res.status}${reason ? `: ${reason}` : ''}`);
        }
        return res.json();
    }

    function putSeries(map, times, values, onlyIfMissing) {
        times.forEach((time, i) => {
            const value = values[i];
            if (typeof value !== 'number') return;
            if (onlyIfMissing && map.has(time)) return;
            map.set(time, value);
        });
    }

    // Hourly rainfall (mm). The archive covers the past; the forecast API
    // fills the newest hours the archive lacks and everything ahead.
    async function fetchRainfall(fromKey, toKey, nowMs) {
        const rain = new Map();
        const today = manilaParts(nowMs).dateKey;
        const { lat, lng } = CONFIG.rainPoint;
        const common = `latitude=${lat}&longitude=${lng}&hourly=precipitation&timezone=Asia%2FManila`;

        const archiveEnd = toKey < today ? toKey : today;
        if (fromKey <= archiveEnd) {
            const data = await fetchJson(`https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${fromKey}&end_date=${archiveEnd}`);
            putSeries(rain, data?.hourly?.time || [], data?.hourly?.precipitation || [], false);
        }

        const recentFrom = addDays(today, -3);
        const forecastFrom = fromKey > recentFrom ? fromKey : recentFrom;
        const forecastTo = toKey < addDays(today, 14) ? toKey : addDays(today, 14);
        if (forecastFrom <= forecastTo) {
            const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${common}&start_date=${forecastFrom}&end_date=${forecastTo}`);
            putSeries(rain, data?.hourly?.time || [], data?.hourly?.precipitation || [], true);
        }
        return rain;
    }

    // Daily river discharge (m3/s), used by the app's flood-risk classifier.
    async function fetchDischarge(fromKey, toKey) {
        const discharge = new Map();
        const { lat, lng } = CONFIG.riverPoint;
        const data = await fetchJson(`https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lng}&daily=river_discharge&start_date=${fromKey}&end_date=${toKey}`);
        putSeries(discharge, data?.daily?.time || [], data?.daily?.river_discharge || [], false);
        return discharge;
    }

    // Rainfall and river discharge from Open-Meteo. Tide is added by the
    // caller from the uploaded bulletin (see indexTide).
    async function loadEnvironment(fromKey, toKey, nowMs) {
        const now = nowMs == null ? Date.now() : nowMs;
        const [rain, discharge] = await Promise.all([
            fetchRainfall(fromKey, toKey, now),
            fetchDischarge(fromKey, toKey)
        ]);
        return { rain, discharge, fromKey, toKey };
    }

    // ── Tide: the LGU bulletin uploaded as Excel ───────────────────────
    // The bulletin lists the day's tide readings (typically 1-2 per day), not
    // an hourly series. Expected columns (header row, any order):
    // Date, Time, Tide (ft).
    //
    // SheetJS's `cellDates: true` conversion is timezone-sensitive and drifts
    // (it shifted dates by a day and times by minutes), so workbooks are read
    // WITHOUT it and the raw Excel serial numbers are converted here with
    // exact integer arithmetic (serial day 0 = 1899-12-30).
    function excelSerialToUtcMidnight(serial) {
        const utcDays = Math.round(serial - 25569); // Excel epoch -> Unix epoch
        return new Date(utcDays * 86400 * 1000);
    }

    function excelTimeToMinutes(value) {
        if (typeof value === 'number') {
            const fractionOfDay = value - Math.floor(value);
            const total = Math.round(fractionOfDay * 24 * 60);
            return total % (24 * 60);
        }
        if (typeof value === 'string') {
            const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
            if (match) {
                let h = parseInt(match[1], 10);
                const m = parseInt(match[2], 10);
                const ampm = match[3] ? match[3].toUpperCase() : null;
                if (ampm === 'PM' && h !== 12) h += 12;
                if (ampm === 'AM' && h === 12) h = 0;
                return h * 60 + m;
            }
        }
        return null;
    }

    function excelDateToKey(value) {
        if (typeof value === 'number') {
            const d = excelSerialToUtcMidnight(value);
            return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
        }
        if (typeof value === 'string') {
            const parsed = new Date(value);
            if (!Number.isNaN(parsed.getTime())) {
                return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
            }
        }
        return null;
    }

    function findColumnKey(row, aliases) {
        return Object.keys(row).find((key) => aliases.includes(String(key).trim().toLowerCase())) || null;
    }

    // -> [{ dateKey, minutes, feet, meters }] sorted by date then time
    function parseTideWorkbook(arrayBuffer) {
        if (typeof XLSX === 'undefined') throw new Error('Excel parser failed to load — check your internet connection and reload the page.');
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) throw new Error('The uploaded file has no sheets.');
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true, defval: null });
        if (!rows.length) throw new Error('The uploaded sheet has no data rows.');

        const dateCol = findColumnKey(rows[0], ['date']);
        const timeCol = findColumnKey(rows[0], ['time']);
        const tideCol = findColumnKey(rows[0], ['tide (ft)', 'tide(ft)', 'tide', 'height (ft)', 'height(ft)', 'height', 'tide height', 'tide height (ft)']);
        if (!dateCol || !timeCol || !tideCol) {
            throw new Error('Expected columns "Date", "Time", and "Tide (ft)" were not found in the header row.');
        }

        const readings = [];
        rows.forEach((row) => {
            if (row[dateCol] == null || row[timeCol] == null || row[tideCol] == null) return;
            const dateKey = excelDateToKey(row[dateCol]);
            const minutes = excelTimeToMinutes(row[timeCol]);
            const feet = Number(row[tideCol]);
            if (!dateKey || minutes == null || !Number.isFinite(feet)) return;
            readings.push({ dateKey, minutes, feet, meters: feet * CONFIG.feetToMeters });
        });
        if (!readings.length) throw new Error('No valid tide rows could be parsed — check the Date/Time/Tide values.');
        readings.sort((a, b) => (a.dateKey === b.dateKey ? a.minutes - b.minutes : (a.dateKey < b.dateKey ? -1 : 1)));
        return readings;
    }

    // Readings grouped by date for fast lookup. `dates` is the sorted list of
    // dates that have at least one reading.
    function indexTide(readings) {
        const byDate = new Map();
        (readings || []).forEach((r) => {
            if (!byDate.has(r.dateKey)) byDate.set(r.dateKey, []);
            byDate.get(r.dateKey).push({ minutes: r.minutes, feet: r.feet, meters: r.meters });
        });
        byDate.forEach((list) => list.sort((a, b) => a.minutes - b.minutes));
        return { byDate, dates: [...byDate.keys()].sort() };
    }

    // The bulletin reading closest to a time of day on one date (the old
    // process: "auto-pick nearest"). Null when nothing was uploaded for it.
    function nearestTideReading(tide, dateKey, targetMinutes) {
        const list = tide && tide.byDate.get(dateKey);
        if (!list || !list.length) return null;
        let best = list[0];
        list.forEach((r) => {
            if (Math.abs(r.minutes - targetMinutes) < Math.abs(best.minutes - targetMinutes)) best = r;
        });
        return { ...best, distanceMinutes: Math.abs(best.minutes - targetMinutes) };
    }

    // ── High-water risk level (port of the app's FloodRiskClassifier.kt) ──
    const RISK_LEVELS = ['LOW', 'MODERATE', 'HIGH', 'SEVERE'];

    function classifyRain(mmNextHour, mmNext24h) {
        if (mmNextHour > 30 || mmNext24h > 150) return 3;
        if (mmNextHour > 15 || mmNext24h > 100) return 2;
        if (mmNextHour > 7.5 || mmNext24h > 50) return 1;
        return 0;
    }

    function classifyDischargeRatio(ratio) {
        if (ratio > 3) return 3;
        if (ratio > 2) return 2;
        if (ratio > 1.3) return 1;
        return 0;
    }

    function classifyTideRatio(ratio) {
        if (ratio > 1.3) return 3;
        if (ratio > 1.15) return 2;
        if (ratio > 1.05) return 1;
        return 0;
    }

    // Worst single factor, escalated one level when two or more factors are
    // independently moderate-or-worse (and the worst isn't already severe).
    function combineRisk(rain, discharge, tide) {
        const levels = [rain, discharge, tide];
        const base = Math.max(...levels);
        const elevated = levels.filter((l) => l >= 1).length;
        return elevated >= 2 && base !== 3 ? base + 1 : base;
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }

    // The three environmental inputs (x4 rainfall, x5 tide, x6 high-water
    // risk) for one Manila date + hour, from the loaded series. ok:false lists
    // what the weather service had no data for, so callers never guess.
    function environmentFor(env, dateKey, hour) {
        const issues = [];

        const rainNow = env.rain.get(hourKey(dateKey, hour));
        if (rainNow === undefined) issues.push('rainfall');

        let rain24 = 0;
        let rainCount = 0;
        for (let i = 0; i < 24; i += 1) {
            const r = env.rain.get(shiftedHourKey(dateKey, hour, i));
            if (r !== undefined) { rain24 += r; rainCount += 1; }
        }
        if (rainCount < 18) issues.push('rainfall (next 24 h)');

        // Tide height: the bulletin reading closest to this hour on this date.
        const hourMinutes = hour * 60 + 30; // middle of the hour
        const tideReading = nearestTideReading(env.tide, dateKey, hourMinutes);
        if (!tideReading) issues.push('tide bulletin');

        // Highest bulletin reading in the 24 hours from this hour (today's
        // later readings plus tomorrow's earlier ones).
        let tidePeak = -Infinity;
        const todayReadings = env.tide.byDate.get(dateKey) || [];
        const tomorrowReadings = env.tide.byDate.get(addDays(dateKey, 1)) || [];
        todayReadings.forEach((r) => { if (r.minutes >= hour * 60 && r.meters > tidePeak) tidePeak = r.meters; });
        tomorrowReadings.forEach((r) => { if (r.minutes < hour * 60 && r.meters > tidePeak) tidePeak = r.meters; });
        if (tideReading && tidePeak === -Infinity) tidePeak = tideReading.meters; // no later reading in the bulletin: fall back to the matched one

        // Tide baseline for the risk level: median daily high of the previous
        // days in the bulletin (or of every uploaded day if fewer than a few
        // of those exist).
        const dailyHigh = (day) => {
            const list = env.tide.byDate.get(day);
            return list && list.length ? Math.max(...list.map((r) => r.meters)) : null;
        };
        const tideDailyHighs = [];
        const dischargePast = [];
        for (let k = 1; k <= CONFIG.baselineDays; k += 1) {
            const day = addDays(dateKey, -k);
            const high = dailyHigh(day);
            if (high !== null) tideDailyHighs.push(high);
            const q = env.discharge.get(day);
            if (q !== undefined) dischargePast.push(q);
        }
        let tideBaselineValues = tideDailyHighs;
        if (tideBaselineValues.length < CONFIG.tideBaselineMinDays) {
            tideBaselineValues = env.tide.dates.map(dailyHigh).filter((v) => v !== null);
        }
        if (tideBaselineValues.length < CONFIG.tideBaselineMinDays) issues.push('tide baseline (upload more days)');

        const dischargeAhead = [];
        for (let k = 0; k <= CONFIG.dischargeAheadDays; k += 1) {
            const q = env.discharge.get(addDays(dateKey, k));
            if (q !== undefined) dischargeAhead.push(q);
        }
        if (dischargePast.length < 7 || !dischargeAhead.length) issues.push('river discharge');

        if (issues.length) return { ok: false, issues };

        const tideBaseline = median(tideBaselineValues);
        const tideRatio = tideBaseline > 0 ? tidePeak / tideBaseline : 1;
        const dischargeBaseline = median(dischargePast);
        const dischargeRatio = dischargeBaseline > 0 ? Math.max(...dischargeAhead) / dischargeBaseline : 1;

        const rainLevel = classifyRain(rainNow, rain24);
        const dischargeLevel = classifyDischargeRatio(dischargeRatio);
        const tideLevel = classifyTideRatio(tideRatio);

        return {
            ok: true,
            rainfallMm: rainNow,
            tideM: tideReading.meters,
            tideReading, // { minutes, feet, meters, distanceMinutes } for showing which bulletin reading was used
            riskLevel: combineRisk(rainLevel, dischargeLevel, tideLevel),
            parts: { rain: rainLevel, discharge: dischargeLevel, tide: tideLevel, rain24h: rain24, dischargeRatio, tideRatio }
        };
    }

    // ── Training data ──────────────────────────────────────────────────
    function cellOfArea(area) {
        const text = String(area || '');
        return text.length >= CONFIG.areaPrecision ? text.slice(0, CONFIG.areaPrecision) : '';
    }

    // Readable name for an area cell: the barangay most often seen in the
    // pickup addresses inside it ("…, San Agustin, Hagonoy, …"), else its
    // coordinates.
    function labelAreas(cells, bookingAddresses) {
        const barangayVotes = {};
        (bookingAddresses || []).forEach(({ lat, lng, address }) => {
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || !address) return;
            const match = String(address).match(/,\s*([^,]+?),\s*Hagonoy/i);
            if (!match) return;
            const cell = geohashEncode(lat, lng, CONFIG.areaPrecision);
            barangayVotes[cell] = barangayVotes[cell] || {};
            const name = match[1].trim();
            barangayVotes[cell][name] = (barangayVotes[cell][name] || 0) + 1;
        });

        const labels = {};
        cells.forEach((cell) => {
            const center = geohashCenter(cell);
            const votes = barangayVotes[cell];
            const top = votes ? Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] : null;
            labels[cell] = {
                label: top ? `${top} (${cell})` : `Area ${cell} (${center.lat.toFixed(3)}°N, ${center.lng.toFixed(3)}°E)`,
                lat: Number(center.lat.toFixed(5)),
                lng: Number(center.lng.toFixed(5))
            };
        });
        return labels;
    }

    // ── Ordinary least squares ─────────────────────────────────────────
    function solveLinearSystem(A, b) {
        const n = b.length;
        const M = A.map((row, i) => [...row, b[i]]);
        for (let col = 0; col < n; col += 1) {
            let pivot = col;
            for (let r = col + 1; r < n; r += 1) {
                if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
            }
            if (Math.abs(M[pivot][col]) < 1e-9) {
                throw new Error('The inputs are perfectly correlated in this data, so the coefficients cannot be separated.');
            }
            [M[col], M[pivot]] = [M[pivot], M[col]];
            for (let r = 0; r < n; r += 1) {
                if (r === col) continue;
                const factor = M[r][col] / M[col][col];
                if (factor === 0) continue;
                for (let c = col; c <= n; c += 1) M[r][c] -= factor * M[col][c];
            }
        }
        return M.map((row, i) => row[n] / row[i]);
    }

    // y = b0 + b1*x1 + … fitted by minimising squared error (normal
    // equations). Columns are standardised for numerical stability and the
    // coefficients converted back to the original units. Inputs that never
    // vary in the data cannot be estimated and are reported as dropped.
    function fitOLS(X, y, names) {
        const n = X.length;
        const kept = [];
        const dropped = [];
        names.forEach((name, j) => {
            let sum = 0;
            for (let i = 0; i < n; i += 1) sum += X[i][j];
            const mean = sum / n;
            let sq = 0;
            for (let i = 0; i < n; i += 1) sq += (X[i][j] - mean) ** 2;
            const std = Math.sqrt(sq / n);
            if (std < 1e-12) dropped.push(name);
            else kept.push({ name, j, mean, std });
        });

        const p = kept.length + 1; // + intercept
        const Z = X.map((row) => [1, ...kept.map(({ j, mean, std }) => (row[j] - mean) / std)]);
        const A = Array.from({ length: p }, () => Array(p).fill(0));
        const b = Array(p).fill(0);
        for (let i = 0; i < n; i += 1) {
            for (let r = 0; r < p; r += 1) {
                b[r] += Z[i][r] * y[i];
                for (let c = r; c < p; c += 1) A[r][c] += Z[i][r] * Z[i][c];
            }
        }
        for (let r = 0; r < p; r += 1) for (let c = 0; c < r; c += 1) A[r][c] = A[c][r];

        const beta = solveLinearSystem(A, b);
        const coefficients = {};
        let intercept = beta[0];
        kept.forEach(({ name, mean, std }, idx) => {
            const coef = beta[idx + 1] / std;
            coefficients[name] = coef;
            intercept -= coef * mean;
        });
        dropped.forEach((name) => { coefficients[name] = 0; });
        return { intercept, coefficients, dropped };
    }

    function predictVector(fit, names, vector) {
        let value = fit.intercept;
        names.forEach((name, j) => { value += (fit.coefficients[name] || 0) * vector[j]; });
        return value;
    }

    function computeMetrics(actual, predicted) {
        const n = actual.length;
        if (!n) return { r2: null, mae: null, rmse: null };
        const mean = actual.reduce((s, v) => s + v, 0) / n;
        let ssRes = 0;
        let ssTot = 0;
        let abs = 0;
        for (let i = 0; i < n; i += 1) {
            const err = actual[i] - predicted[i];
            ssRes += err * err;
            ssTot += (actual[i] - mean) ** 2;
            abs += Math.abs(err);
        }
        return { r2: ssTot > 0 ? 1 - ssRes / ssTot : null, mae: abs / n, rmse: Math.sqrt(ssRes / n) };
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a += 0x6D2B79F5;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Repeatable 80/20 split (the paper's training script used test_size=0.2,
    // random_state=42). With very little data the whole set is used and the
    // metrics are flagged as in-sample.
    function splitIndices(n) {
        const indices = Array.from({ length: n }, (_, i) => i);
        if (n < CONFIG.splitMinRows) return { train: indices, test: indices, inSample: true };
        const random = mulberry32(CONFIG.seed);
        for (let i = n - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        const testSize = Math.max(1, Math.round(n * CONFIG.testShare));
        return { train: indices.slice(testSize), test: indices.slice(0, testSize), inSample: false };
    }

    function percentile(sortedValues, q) {
        if (!sortedValues.length) return 0;
        const pos = (sortedValues.length - 1) * q;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
    }

    // Starting thresholds taken from the training data itself (the 33rd and
    // 67th percentile of non-zero counts) — the paper's "project thresholds"
    // are for the admin to confirm or change on the page.
    function suggestThresholds(values) {
        const positives = values.filter((v) => v > 0).sort((a, b) => a - b);
        if (positives.length < 6) return { lowBelow: null, highFrom: null, suggested: false };
        let lowBelow = Math.max(1, Math.round(percentile(positives, 0.33)));
        let highFrom = Math.round(percentile(positives, 0.67));
        if (highFrom <= lowBelow) highFrom = lowBelow + 1;
        return { lowBelow, highFrom, suggested: true };
    }

    function classify(value, thresholds) {
        if (!thresholds || thresholds.lowBelow == null || thresholds.highFrom == null) return null;
        if (value < thresholds.lowBelow) return 'LOW';
        if (value < thresholds.highFrom) return 'MODERATE';
        return 'HIGH';
    }

    window.ParaPrediction = {
        CONFIG,
        HOUR_MS,
        RISK_LEVELS,
        manilaParts,
        hourKey,
        dayOfWeekOf,
        addDays,
        geohashEncode,
        geohashCenter,
        cellOfArea,
        labelAreas,
        loadEnvironment,
        parseTideWorkbook,
        indexTide,
        nearestTideReading,
        environmentFor,
        classifyRain,
        classifyDischargeRatio,
        classifyTideRatio,
        combineRisk,
        fitOLS,
        predictVector,
        computeMetrics,
        splitIndices,
        suggestThresholds,
        classify
    };
})();
