// Shared prediction engine (used by the Availability & Demand page).
//
// What lives here is everything the two predictions have in common:
//   - Manila time, geohash and Hagonoy barangay helpers
//   - the weather inputs: rainfall and river discharge from Open-Meteo, and
//     tide from the LGU bulletin the admin uploads (Excel, stored in Firestore
//     as tide_bulletin), plus the app's flood-risk rules (FloodRiskClassifier)
//   - multiple linear regression: ordinary least squares, the chronological
//     80/20 split, MAE / RMSE / R², and HIGH / MODERATE / LOW thresholds
//   - the fixed training scope (rolling window, minimum rows, forecast horizon)
//
// It is pure logic (no DOM, no Firestore). What each prediction counts and
// which inputs it uses is defined in forecast.js.
(function () {
    'use strict';

    const HOUR_MS = 3600 * 1000;

    const CONFIG = {
        // Same points the mobile app uses (Hagonoy town centre for rain, the
        // river branch for discharge).
        rainPoint: { lat: 14.83, lng: 120.73 },
        riverPoint: { lat: 14.8333, lng: 120.7333 },
        feetToMeters: 0.3048,
        // A bulletin reading further than this from the selected time is
        // still used, but flagged as a weak match.
        tideMatchWarnMinutes: 6 * 60,
        // Tide baseline for the risk level: daily highs of the previous
        // baselineDays days; at least this many must be in the bulletin,
        // otherwise the tide inputs are treated as missing (earlier days only,
        // never later uploaded days).
        tideBaselineMinDays: 3,
        // Philippines is UTC+8 with no daylight saving.
        utcOffsetMs: 8 * HOUR_MS,
        baselineDays: 14,
        // Weather is loaded up to this many days after the target date (the
        // target date itself is all that is read; kept small on purpose).
        dischargeAheadDays: 1,
        // Rainfall labels for one hour of rain (mm): below rainModerateFrom
        // is Light, from rainStrongFrom up is Strong (PAGASA-style bands).
        rainModerateFrom: 2.5,
        rainStrongFrom: 7.5,
        // Tide labels are relative to the uploaded bulletin: the lowest third
        // of its readings is Low, the highest third is High.
        tideMinReadingsForLabel: 3,

        // ── Training scope (fixed; the models retrain themselves daily) ──
        // The training window is the SIX CALENDAR MONTHS ending at the last
        // completed hour (see trainingWindow). One row = one barangay in one
        // hour (the unit that is predicted). The window rolls: each day the
        // oldest records leave it and the newest enter. Records are filtered to
        // the window BEFORE any target is built. The only exception is the
        // historyLookbackDays before the window: driver status events and pings
        // there are used solely to know a driver's state at the start of the
        // window, and bookings and availability there are used solely as the
        // "recent history" inputs (lags up to one week) of the first rows of the
        // window. No row is ever built for those earlier hours.
        // A model reports the coverage it actually had: if six months of records
        // do not exist it says how many days it really used.
        trainingWindowMonths: 6,
        historyLookbackDays: 8,
        // Fewest days of history before a model is trained at all: 4 full
        // weeks, so each day of the week is observed at least 4 times. Below
        // preliminaryDays the model is labelled EXPLORATORY; these tiers are
        // planning guides (about 3, 6 and 12 months), not statistical limits.
        minTrainingDays: 28,
        preliminaryDays: 90,
        extendedDays: 180,
        // Evaluation needs enough hours to hold out: at least this many days.
        minEvaluationDays: 14,
        // Hours left unused between the training period and the test period,
        // because rainfall of the previous 24 h feeds the risk level.
        evaluationGapHours: 24,
        // Rolling-origin evaluation: test blocks of this many days, up to
        // this many blocks, only when the history is at least this long.
        rollingBlockDays: 7,
        rollingMaxBlocks: 4,
        rollingMinDays: 56,
        // Fewest rows: N >= 50 + 8m for m inputs (Green, 1991), see minRowsFor.
        rowsBase: 50,
        rowsPerInput: 8,
        // Chronological hold-out: the newest 20% of the hours is kept aside
        // to test the model on hours it has not seen.
        testShare: 0.2,
        // Furthest day ahead that can be predicted. Rainfall for a future hour
        // comes from the Open-Meteo forecast, whose hourly rain is only
        // dependable within about a week (medium-range forecast skill).
        // Forecasts can be requested for the next 24 whole hours only.
        maxForecastHours: 24,
        // A barangay / day-of-week / hour needs at least this many past
        // observations before its historical mean is used as a predictor.
        minHistoryObservations: 3,
        // The only forecast distance the evaluation covers (target hour at most
        // this many hours after the current hour). Later hours are offered as
        // EXPERIMENTAL because no evaluation measured them.
        validatedHorizonHours: 1,
        // Tide between two bulletin readings is estimated with a smooth curve
        // only when the readings are at most this far apart: the tide in this
        // region can have one high and one low a day, and half of a 24.84 h
        // tidal day is about 12.4 h. Further apart, a reading is missing and
        // the nearest one is used instead.
        tideMaxInterpolateMinutes: 750,
        // Share of past test hours the "likely range" must contain (80%, as in
        // Hyndman & Athanasopoulos, Forecasting: Principles and Practice, 5.5).
        predictionIntervalLevel: 0.8,
        // The range is shown as validated only when, on later hours it was NOT
        // calibrated on, its observed coverage is within this distance of the
        // nominal level and at least intervalMinCoverageRows rows were checked;
        // below intervalHideBelow observed coverage it is not shown at all.
        intervalCoverageTolerance: 0.1,
        intervalMinCoverageRows: 200,
        intervalHideBelow: 0.6,

        // ── Data dependencies that decide what can be trained ────────────
        // A tide predictor is used only when at least this share of the usable
        // training hours has tide data (see tideMode in forecast.js); below it
        // the models are trained WITHOUT tide, and are only used without it.
        tideMinCoverage: 0.9,
        // The `area` of a driver ping is only used when it is a valid geohash that
        // decodes inside Hagonoy; others are ignored and reported. If fewer than this
        // share are valid, driver locations cannot be placed and Model B is not built.
        minLocationFormatShare: 0.05,
        hagonoyBounds: { latMin: 14.70, latMax: 14.95, lngMin: 120.60, lngMax: 120.90 },
        // Fewest training observations per fitted parameter before the model is
        // flagged as thin (a warning, the hard minimum stays minRowsFor).
        minObservationsPerParameter: 20,
        // A numeric predictor with a variance inflation factor above this is
        // reported as strongly collinear with the others.
        vifWarnAbove: 10,
        // A driver's availability at an hour is only a genuine zero when the
        // logging system is shown to be alive around that hour: some driver ping
        // or status event within this many hours of it (either side).
        observationWindowHours: 3,
        // A barangay centre is learned only from at least this many addressed
        // bookings; fewer is too uncertain to place driver pings with.
        minCentroidBookings: 10,
        // Booking timestamps before this are not plausible PARA data
        // (a timestamp in seconds, or a zero-ish value, reads as 1970).
        plausibleFromMs: Date.UTC(2020, 0, 1),
        // The operational data fields the models depend on, as observed with
        // the admin page's "Check data schema" on 2026-10-16 (a sample of 200
        // booking, 200 status-event, 200 location-sample and 18 driver
        // documents). "verified" means the FIELD NAMES AND STORED TYPES below were
        // seen in live documents. What those fields MEAN is still partly assumed;
        // see `assumptions`, which is repeated as a warning on every real model.
        //   bookings        `timestamp` is a number (milliseconds) on 200/200
        //                   documents; `acceptedAt`, `arrivedAt`, `completedAt` are
        //                   numbers; `status` is CANCELLED / COMPLETED / DECLINED /
        //                   NO_SHOW in the sample; no `pickupBarangay` field exists.
        //   driverStatusEvents  `event` holds ONLINE or OFFLINE (no BUSY/AVAILABLE),
        //                   `timestamp` is a Firestore Timestamp.
        //   driverLocationSamples  `timestamp` Timestamp, `area` string, `location`.
        //   users (drivers) role DRIVER; verificationStatus/accountStatus in upper
        //                   case; verifiedAt and suspendedAt are Timestamps.
        // SEEDED records (`isSeed: true`, ids starting SEED_) are present in these
        // collections and are NEVER used for training (see `seedIdPrefix`).
        dataSchema: {
            bookings: {
                requestTimeFields: ['timestamp', 'createdAt'], // first present wins
                acceptedTimeField: 'acceptedAt',
                pickupBarangayField: 'pickupBarangay',         // does not exist yet (0 of 200): used when present
                verified: true
            },
            driverEvents: {
                collection: 'driverStatusEvents',
                statusField: 'event',
                statusValues: { online: ['ONLINE', 'AVAILABLE'], busy: ['BUSY'], offline: ['OFFLINE'] },
                verified: true
            },
            driverLocations: {
                collection: 'driverLocationSamples',
                locationField: 'area', // a string (geohash expected, not confirmed)
                verified: true
            },
            // Records that are not real PARA activity. isSeed === true, or an id
            // (driver, passenger, booking, ride group) starting with this prefix.
            seedIdPrefix: 'SEED_',
            // Test accounts that are NOT flagged as seed (the sample shows one
            // driver with plate "QWEQWEQWE" and a passenger of the same name behind
            // about a third of the sampled bookings). Add their user ids here once
            // confirmed; nothing is guessed.
            // User ids confirmed by the project owner (2026-10-16) as a test
            // account. The owner said "I think" this is the right uid, and did not
            // say whether it is the driver or the passenger account, so it is on
            // both lists. The matching second account (the other role) is still
            // to be identified.
            // tester_d01..10 / tester_p01..10: the tester accounts made by the app
            // repo's seed/testers.mjs (2026-10-19).
            excludeDriverIds: ['1czMxsHB4pZX5DczUYckzaPWUg13', ...Array.from({ length: 10 }, (_, i) => `tester_d${String(i + 1).padStart(2, '0')}`)],
            excludePassengerIds: ['1czMxsHB4pZX5DczUYckzaPWUg13', ...Array.from({ length: 10 }, (_, i) => `tester_p${String(i + 1).padStart(2, '0')}`)],
            assumptions: [
                'An ONLINE or OFFLINE event is written on every change of a driver availability (not fully confirmed: the app source shows that logging out or being forced offline writes no event, so a driver can stay "online" in the log; the freshness of the location ping is used to cover this).',
                'Confirmed from the mobile app source (2026-10-16): the booking `timestamp` is the request-creation time in milliseconds; the `area` of events and samples is a precision-7 geohash; location samples are written about every 5 minutes while a driver is online. Not yet verified against live documents beyond the schema check.'
            ]
        }
    };

    // The rolling training window: the six calendar months (Manila time)
    // ending at the last COMPLETED hour. endMs is exclusive: the current, still
    // unfinished hour is never included. Month arithmetic clamps to the last day
    // of a shorter month (6 months before 31 August is 28 or 29 February).
    function trainingWindow(nowMs) {
        const now = nowMs == null ? Date.now() : nowMs;
        const endMs = Math.floor(now / HOUR_MS) * HOUR_MS;
        const e = manilaParts(endMs);
        const [y, m, day] = e.dateKey.split('-').map(Number);
        const total = (m - 1) - CONFIG.trainingWindowMonths;
        const ty = y + Math.floor(total / 12);
        const tm = ((total % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
        const startMs = Date.UTC(ty, tm, Math.min(day, lastDay), e.hour) - CONFIG.utcOffsetMs;
        const lookbackMs = CONFIG.historyLookbackDays * 24 * HOUR_MS;
        return {
            months: CONFIG.trainingWindowMonths,
            startMs,
            endMs,
            startKey: manilaParts(startMs).dateKey,
            endKey: manilaParts(endMs - 1).dateKey,
            lookbackStartMs: startMs - lookbackMs,
            hours: Math.round((endMs - startMs) / HOUR_MS)
        };
    }

    // Green, S. B. (1991). How many subjects does it take to do a regression
    // analysis? Multivariate Behavioral Research, 26(3): N >= 50 + 8m.
    function minRowsFor(inputCount) {
        return CONFIG.rowsBase + CONFIG.rowsPerInput * inputCount;
    }

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

    // Hourly rainfall (mm). For the past, the Historical Forecast API is tried
    // first: it holds archived FORECASTS (the first hours of each forecast run
    // stitched together), which is what the model is given when it predicts.
    // If it cannot be reached, the ERA5 archive (what actually fell, not a
    // forecast) is used and `rainSource` says so. The forecast API fills the
    // newest hours and everything ahead.
    async function fetchRainfall(fromKey, toKey, nowMs, info) {
        const rain = new Map();
        const today = manilaParts(nowMs).dateKey;
        const { lat, lng } = CONFIG.rainPoint;
        const common = `latitude=${lat}&longitude=${lng}&hourly=precipitation&timezone=Asia%2FManila`;

        // The archive only holds days up to yesterday and rejects anything
        // newer (HTTP 400), so stop two days short; the forecast API below
        // supplies the most recent days.
        const archiveLimit = addDays(today, -2);
        const archiveEnd = toKey < archiveLimit ? toKey : archiveLimit;
        if (fromKey <= archiveEnd) {
            let loaded = false;
            try {
                const data = await fetchJson(`https://historical-forecast-api.open-meteo.com/v1/forecast?${common}&start_date=${fromKey}&end_date=${archiveEnd}`);
                putSeries(rain, data?.hourly?.time || [], data?.hourly?.precipitation || [], false);
                loaded = rain.size > 0;
                if (loaded && info) info.rainSource = 'archived forecasts (Open-Meteo Historical Forecast API)';
            } catch (error) {
                console.warn('Historical forecast rainfall unavailable, using the observed archive instead.', error);
            }
            if (!loaded) {
                const data = await fetchJson(`https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${fromKey}&end_date=${archiveEnd}`);
                putSeries(rain, data?.hourly?.time || [], data?.hourly?.precipitation || [], false);
                if (info) info.rainSource = 'observed archive (ERA5), not forecasts - training/prediction mismatch';
            }
        }

        const recentFrom = addDays(today, -5);
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
        const info = { rainSource: 'unknown' };
        const [rain, discharge] = await Promise.all([
            fetchRainfall(fromKey, toKey, now, info),
            fetchDischarge(fromKey, toKey)
        ]);
        return { rain, discharge, fromKey, toKey, rainSource: info.rainSource };
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

    // Tide height at a time of day, estimated BETWEEN the two bulletin readings
    // on either side of it (they may be on neighbouring days) with a half-cosine
    // curve: it eases away from one high or low tide and eases into the next,
    // the same shape the rule of twelfths approximates. It is not a jump to
    // the nearest reading. Returns null when no pair of readings surrounds the
    // time or they are too far apart (CONFIG.tideMaxInterpolateMinutes).
    function tideAt(tide, dateKey, targetMinutes) {
        if (!tide) return null;
        const dayMinutes = (key) => {
            const [y, m, d] = key.split('-').map(Number);
            return Date.UTC(y, m - 1, d) / 60000;
        };
        const entries = [];
        [-1, 0, 1].forEach((offset) => {
            const key = addDays(dateKey, offset);
            (tide.byDate.get(key) || []).forEach((r) => {
                entries.push({ at: dayMinutes(key) + r.minutes, dateKey: key, minutes: r.minutes, feet: r.feet, meters: r.meters });
            });
        });
        const t = dayMinutes(dateKey) + targetMinutes;
        let before = null;
        let after = null;
        entries.forEach((e) => {
            if (e.at <= t && (!before || e.at > before.at)) before = e;
            if (e.at >= t && (!after || e.at < after.at)) after = e;
        });
        if (!before || !after) return null;
        const span = after.at - before.at;
        if (span <= 0) return { feet: before.feet, meters: before.meters, interpolated: false, before, after };
        if (span > CONFIG.tideMaxInterpolateMinutes) return null;
        const share = (1 - Math.cos(Math.PI * ((t - before.at) / span))) / 2;
        return {
            feet: before.feet + (after.feet - before.feet) * share,
            meters: before.meters + (after.meters - before.meters) * share,
            interpolated: true,
            before,
            after
        };
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

    // The environmental inputs for one Manila date + hour, built ONLY from
    // information that exists when a forecast for that hour is issued:
    //   rainfallMm     rain in the target hour (a forecast; in training, the
    //                  archived short-lead forecast, see fetchRainfall)
    //   rain in the 24 h BEFORE the hour (already fallen: known at issue time)
    //   river discharge of the PREVIOUS day against the median of the 14 days
    //                  before it (already measured/modelled: known at issue time)
    //   tide           the LGU bulletin's tide prediction (a published table,
    //                  known in advance). OPTIONAL: its absence does not stop the
    //                  weather inputs, it only means tideOk is false.
    // Nothing after the forecast origin (no "next 24 h" rain, no future river
    // flow, no uploaded-later tide days) is used.
    //
    // ok:false lists what is missing from the WEATHER inputs. tideOk:false lists
    // what is missing from the tide inputs (tideIssues). Callers never guess.
    //   riskLevelNoTide  high-water risk from rain and river only
    //   riskLevel        the same including the tide factor (null without tide)
    function environmentFor(env, dateKey, hour) {
        const issues = [];
        const tideIssues = [];

        const rainNow = env.rain.get(hourKey(dateKey, hour));
        if (rainNow === undefined) issues.push('rainfall');

        let rainPast = 0;
        let rainCount = 0;
        for (let i = 1; i <= 24; i += 1) {
            const r = env.rain.get(shiftedHourKey(dateKey, hour, -i));
            if (r !== undefined) { rainPast += r; rainCount += 1; }
        }
        if (rainCount < 18) issues.push('rainfall (previous 24 h)');

        const dischargeYesterday = env.discharge.get(addDays(dateKey, -1));
        const dischargeBefore = [];
        for (let k = 2; k <= CONFIG.baselineDays + 1; k += 1) {
            const q = env.discharge.get(addDays(dateKey, -k));
            if (q !== undefined) dischargeBefore.push(q);
        }
        if (dischargeYesterday === undefined || dischargeBefore.length < 7) issues.push('river discharge');

        // Tide (optional). Height: the bulletin reading closest to this hour, eased
        // between neighbouring readings. Risk factor: highest bulletin reading in
        // the 24 hours from this hour against the median daily high of the
        // PREVIOUS days only.
        const hourMinutes = hour * 60 + 30; // middle of the hour
        const tideData = env.tide || { byDate: new Map(), dates: [] };
        const nearestReading = nearestTideReading(tideData, dateKey, hourMinutes);
        if (!nearestReading) tideIssues.push('tide bulletin');
        const tideReading = nearestReading && (tideAt(tideData, dateKey, hourMinutes) || { ...nearestReading, interpolated: false });

        const dailyHigh = (day) => {
            const list = tideData.byDate.get(day);
            return list && list.length ? Math.max(...list.map((r) => r.meters)) : null;
        };
        const tideDailyHighs = [];
        for (let k = 1; k <= CONFIG.baselineDays; k += 1) {
            const high = dailyHigh(addDays(dateKey, -k));
            if (high !== null) tideDailyHighs.push(high);
        }
        if (tideDailyHighs.length < CONFIG.tideBaselineMinDays) tideIssues.push('tide baseline (needs earlier days in the bulletin)');

        let tidePeak = -Infinity;
        (tideData.byDate.get(dateKey) || []).forEach((r) => { if (r.minutes >= hour * 60 && r.meters > tidePeak) tidePeak = r.meters; });
        (tideData.byDate.get(addDays(dateKey, 1)) || []).forEach((r) => { if (r.minutes < hour * 60 && r.meters > tidePeak) tidePeak = r.meters; });
        if (tideReading && tidePeak === -Infinity) tidePeak = tideReading.meters; // no later reading in the bulletin: the matched one

        const tideOk = tideIssues.length === 0;
        if (issues.length) return { ok: false, issues, tideOk, tideIssues };

        const dischargeBaseline = median(dischargeBefore);
        const dischargeRatio = dischargeBaseline > 0 ? dischargeYesterday / dischargeBaseline : 1;
        const rainLevel = classifyRain(rainNow, rainPast);
        const dischargeLevel = classifyDischargeRatio(dischargeRatio);
        const riskLevelNoTide = combineRisk(rainLevel, dischargeLevel, 0);

        let tideLevel = null;
        let tideRatio = null;
        if (tideOk) {
            tideRatio = median(tideDailyHighs) > 0 ? tidePeak / median(tideDailyHighs) : 1;
            tideLevel = classifyTideRatio(tideRatio);
        }

        return {
            ok: true,
            rainfallMm: rainNow,
            tideOk,
            tideIssues,
            tideM: tideOk ? tideReading.meters : null,
            tideReading: tideOk ? tideReading : null, // { minutes, feet, meters, distanceMinutes } for showing which bulletin reading was used
            riskLevelNoTide,
            riskLevel: tideOk ? combineRisk(rainLevel, dischargeLevel, tideLevel) : null,
            parts: { rain: rainLevel, discharge: dischargeLevel, tide: tideLevel, rainPast24h: rainPast, dischargeRatio, tideRatio }
        };
    }

    // ── Locations ──────────────────────────────────────────────────────
    // The barangays PARA covers: the only ones that are forecast. A booking or
    // driver log in any other barangay is left out, and a saved model that
    // includes another barangay is treated as out of date (see isCurrent in
    // forecast.js) until it is retrained. Matching ignores "Sta." vs "Santa"
    // (see normalizeName).
    // The tricycle operators' associations (TODAs) and the barangays each covers.
    // San Isidro is covered by both SMTB and SITODA. Used for display and for the
    // seed-data tool only; a TODA is NOT a model predictor.
    const TODAS = {
        SAMPJ: ['San Agustin', 'San Miguel', 'Palapat', 'San Juan'],
        SMTB: ['Santa Monica', 'Tampok', 'San Isidro'],
        SITODA: ['San Isidro']
    };
    function todasOf(barangay) {
        return Object.keys(TODAS).filter((name) => TODAS[name].includes(barangay));
    }

    const HAGONOY_BARANGAYS = [
        'Palapat', 'San Agustin', 'San Isidro', 'San Juan', 'San Miguel', 'Santa Monica', 'Tampok'
    ];

    // Every barangay of Hagonoy, Bulacan — only used to recognise where a
    // booking or driver log is, so one in an uncovered barangay can be left out
    // instead of being counted in the nearest covered one.
    const ALL_HAGONOY_BARANGAYS = [
        'Abulalas', 'Carillo', 'Iba', 'Iba-Ibayo', 'Mercado', 'Palapat', 'Pugad', 'Sagrada Familia',
        'San Agustin', 'San Isidro', 'San Jose', 'San Juan', 'San Miguel', 'San Nicolas', 'San Pablo',
        'San Pascual', 'San Pedro', 'San Roque', 'San Sebastian', 'Santa Cruz', 'Santa Elena',
        'Santa Monica', 'Santo Niño', 'Santo Rosario', 'Tampok', 'Tibaguin'
    ];

    function normalizeName(text) {
        return String(text || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\bsto\.?\s/g, 'santo ')
            .replace(/\bsta\.?\s/g, 'santa ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // Longest names first so "Iba-Ibayo" is not read as "Iba".
    const BARANGAY_MATCHERS = [...ALL_HAGONOY_BARANGAYS]
        .sort((a, b) => b.length - a.length)
        .map((name) => ({ name, key: ` ${normalizeName(name)} ` }));

    // The barangay named in a pickup address ("…, San Agustin, Hagonoy, …"),
    // or null.
    function barangayFromAddress(address) {
        const text = ` ${normalizeName(address)} `;
        const found = BARANGAY_MATCHERS.find((m) => text.includes(m.key));
        return found ? found.name : null;
    }

    function distanceKm(a, b) {
        const rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad;
        const dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 12742 * Math.asin(Math.sqrt(h));
    }

    // Where each barangay is, learned from the pickup coordinates of bookings
    // whose address names it (mean position). -> { name: {lat, lng} }
    function barangayCentroids(bookings) {
        const sums = {};
        (bookings || []).forEach(({ lat, lng, address }) => {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const name = barangayFromAddress(address);
            if (!name) return;
            const s = sums[name] || (sums[name] = { lat: 0, lng: 0, n: 0 });
            s.lat += lat; s.lng += lng; s.n += 1;
        });
        const centroids = {};
        // A centre learned from only a few bookings is too uncertain to place
        // driver pings with, so it is not used.
        Object.keys(sums).forEach((name) => {
            if (sums[name].n < CONFIG.minCentroidBookings) return;
            centroids[name] = { lat: sums[name].lat / sums[name].n, lng: sums[name].lng / sums[name].n };
        });
        return centroids;
    }

    // The barangay whose centroid is nearest to a point, if within maxKm.
    function nearestBarangay(point, centroids, maxKm) {
        let best = null;
        let bestKm = Infinity;
        Object.keys(centroids).forEach((name) => {
            const km = distanceKm(point, centroids[name]);
            if (km < bestKm) { bestKm = km; best = name; }
        });
        return best !== null && bestKm <= maxKm ? best : null;
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

    // ── Least squares by Householder QR with column pivoting ──────────
    // y = b0 + b1*x1 + b2*x2 + … is fitted by minimising the sum of squared
    // errors. The design matrix A (a column of ones plus the standardised
    // inputs) is factorised as A P = Q R with Householder reflections, and the
    // coefficients come from back-substitution on the triangular R. The normal
    // equations (X'X) are never formed or inverted (that squares the condition
    // number). Column pivoting finds the numerical rank: a column that is a
    // linear combination of earlier ones gets coefficient 0 and is reported in
    // `dropped`, and so does a column that never varies. If there are not more
    // observations than parameters the fit is underdetermined and refused.
    // Returns coefficients in the ORIGINAL units of the inputs.
    const RANK_TOLERANCE = 1e-9; // relative to the first pivot

    function fitLeastSquares(X, y, names) {
        const n = X.length;
        if (n !== y.length) throw new Error('The inputs and the target have different numbers of rows.');
        const kept = [];
        const dropped = [];
        const droppedReasons = {};
        names.forEach((name, j) => {
            let sum = 0;
            for (let i = 0; i < n; i += 1) {
                const v = X[i][j];
                if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`The input "${name}" has a missing or non-numeric value; the regression cannot be fitted.`);
                sum += v;
            }
            const mean = sum / n;
            let sq = 0;
            for (let i = 0; i < n; i += 1) sq += (X[i][j] - mean) ** 2;
            const std = Math.sqrt(sq / n);
            if (std < 1e-12) { dropped.push(name); droppedReasons[name] = 'no variation'; } else kept.push({ name, j, mean, std });
        });
        for (let i = 0; i < n; i += 1) {
            if (typeof y[i] !== 'number' || !Number.isFinite(y[i])) throw new Error('The target has a missing or non-numeric value; the regression cannot be fitted.');
        }
        const p = kept.length + 1; // + intercept
        if (n <= p) throw new Error(`Too few observations (${n}) for ${p} parameters: the regression is underdetermined.`);

        const cols = [new Float64Array(n).fill(1)];
        kept.forEach(({ j, mean, std }) => {
            const c = new Float64Array(n);
            for (let i = 0; i < n; i += 1) c[i] = (X[i][j] - mean) / std;
            cols.push(c);
        });
        const qty = Float64Array.from(y);
        const order = Array.from({ length: p }, (_, i) => i);
        let rank = 0;
        let first = 0;
        for (let j = 0; j < p; j += 1) {
            let best = j;
            let bestNorm = -1;
            for (let l = j; l < p; l += 1) {
                let sumSq = 0;
                const c = cols[l];
                for (let i = j; i < n; i += 1) sumSq += c[i] * c[i];
                if (sumSq > bestNorm) { bestNorm = sumSq; best = l; }
            }
            if (best !== j) { [cols[j], cols[best]] = [cols[best], cols[j]]; [order[j], order[best]] = [order[best], order[j]]; }
            const c = cols[j];
            const norm = Math.sqrt(bestNorm);
            if (j === 0) first = norm;
            if (norm === 0 || norm <= RANK_TOLERANCE * first) break; // what is left is numerically dependent
            const alpha = c[j] > 0 ? -norm : norm;
            const v0 = c[j] - alpha;
            let vtv = v0 * v0;
            for (let i = j + 1; i < n; i += 1) vtv += c[i] * c[i];
            const reflect = (target) => {
                let dot = v0 * target[j];
                for (let i = j + 1; i < n; i += 1) dot += c[i] * target[i];
                const factor = (2 * dot) / vtv;
                target[j] -= factor * v0;
                for (let i = j + 1; i < n; i += 1) target[i] -= factor * c[i];
            };
            for (let l = j + 1; l < p; l += 1) reflect(cols[l]);
            reflect(qty);
            c[j] = alpha;
            for (let i = j + 1; i < n; i += 1) c[i] = 0;
            rank += 1;
        }
        const beta = new Float64Array(p);
        for (let i = rank - 1; i >= 0; i -= 1) {
            let sum = qty[i];
            for (let l = i + 1; l < rank; l += 1) sum -= cols[l][i] * beta[l];
            beta[i] = sum / cols[i][i];
        }
        const standardised = new Float64Array(p);
        for (let k = 0; k < rank; k += 1) standardised[order[k]] = beta[k];
        for (let k = rank; k < p; k += 1) {
            if (order[k] > 0) { const name = kept[order[k] - 1].name; dropped.push(name); droppedReasons[name] = 'linearly dependent on the other inputs'; }
        }
        const coefficients = {};
        let intercept = standardised[0];
        kept.forEach(({ name, mean, std }, idx) => {
            const coef = standardised[idx + 1] / std;
            coefficients[name] = coef;
            intercept -= coef * mean;
        });
        dropped.forEach((name) => { coefficients[name] = 0; });
        return { intercept, coefficients, dropped, droppedReasons, rank, parameters: p, observations: n, method: 'Householder QR with column pivoting' };
    }

    // The name the rest of the code (and its tests) already use.
    const fitOLS = fitLeastSquares;

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

    // Chronological split by TIMESTAMP. Every barangay of the same hour goes to
    // the same side. The oldest (1 - testShare) of the distinct hours train the
    // model; `gapHours` are skipped; the newest testShare of the hours test it.
    // A random or row-position split would put hours on both sides of a test
    // hour (Hyndman & Athanasopoulos, Forecasting: Principles and Practice,
    // "Evaluating forecast accuracy"). Each row needs `hourMs`.
    // Returns null when there are too few hours to hold any out.
    function timeSplit(rows, opts) {
        const o = opts || {};
        const testShare = o.testShare == null ? CONFIG.testShare : o.testShare;
        const gapMs = (o.gapHours == null ? CONFIG.evaluationGapHours : o.gapHours) * HOUR_MS;
        const hours = [...new Set(rows.map((r) => r.hourMs))].sort((a, b) => a - b);
        if (hours.length < CONFIG.minEvaluationDays * 24) return null;
        const cutIndex = Math.floor(hours.length * (1 - testShare));
        const testStart = hours[cutIndex];
        const trainEnd = testStart - gapMs;
        const train = [];
        const test = [];
        rows.forEach((r, i) => {
            if (r.hourMs >= testStart) test.push(i);
            else if (r.hourMs < trainEnd) train.push(i);
        });
        if (!train.length || !test.length) return null;
        return {
            train, test, gapHours: gapMs / HOUR_MS,
            trainFrom: hours[0], trainTo: trainEnd - HOUR_MS,
            testFrom: testStart, testTo: hours[hours.length - 1]
        };
    }

    // The simple forecast PARA's regression has to beat: the average of the
    // same barangay, day of week and hour in the TRAINING rows only (falling
    // back to the same day-of-week and hour over all barangays, then to the
    // overall average). Returns a function row -> number.
    function hourOfWeekBaseline(trainRows, outcome) {
        const acc = (map, key, v) => { const a = map.get(key) || [0, 0]; a[0] += v; a[1] += 1; map.set(key, a); };
        const full = new Map();
        const part = new Map();
        let total = 0;
        trainRows.forEach((r) => {
            acc(full, `${r.area}|${r.dow}|${r.hour}`, r[outcome]);
            acc(part, `${r.dow}|${r.hour}`, r[outcome]);
            total += r[outcome];
        });
        const overall = trainRows.length ? total / trainRows.length : 0;
        const mean = (a) => a[0] / a[1];
        return (row) => {
            const f = full.get(`${row.area}|${row.dow}|${row.hour}`);
            if (f) return mean(f);
            const p = part.get(`${row.dow}|${row.hour}`);
            return p ? mean(p) : overall;
        };
    }

    // Poisson regression (log link) by iteratively reweighted least squares,
    // used ONLY as a comparison against the linear model for these counts. It
    // can never predict a negative count. Returns null if it does not settle.
    function fitPoisson(X, y, names) {
        try {
            const n = X.length;
            const kept = [];
            names.forEach((name, j) => {
                let sum = 0;
                for (let i = 0; i < n; i += 1) sum += X[i][j];
                const mean = sum / n;
                let sq = 0;
                for (let i = 0; i < n; i += 1) sq += (X[i][j] - mean) ** 2;
                const std = Math.sqrt(sq / n);
                if (std >= 1e-12) kept.push({ name, j, mean, std });
            });
            const p = kept.length + 1;
            const Z = X.map((row) => [1, ...kept.map(({ j, mean, std }) => (row[j] - mean) / std)]);
            const yMean = y.reduce((s, v) => s + v, 0) / n;
            if (!(yMean > 0)) return null;
            let beta = Array(p).fill(0);
            beta[0] = Math.log(yMean);
            for (let iter = 0; iter < 30; iter += 1) {
                const A = Array.from({ length: p }, () => Array(p).fill(0));
                const b = Array(p).fill(0);
                for (let i = 0; i < n; i += 1) {
                    let eta = 0;
                    for (let r = 0; r < p; r += 1) eta += Z[i][r] * beta[r];
                    eta = Math.max(-20, Math.min(20, eta));
                    const mu = Math.exp(eta);
                    const z = eta + (y[i] - mu) / mu;
                    for (let r = 0; r < p; r += 1) {
                        b[r] += mu * Z[i][r] * z;
                        for (let c = r; c < p; c += 1) A[r][c] += mu * Z[i][r] * Z[i][c];
                    }
                }
                for (let r = 0; r < p; r += 1) for (let c = 0; c < r; c += 1) A[r][c] = A[c][r];
                for (let r = 1; r < p; r += 1) A[r][r] += 1e-6;
                const next = solveLinearSystem(A, b);
                let change = 0;
                next.forEach((v, r) => { change = Math.max(change, Math.abs(v - beta[r])); });
                beta = next;
                if (!beta.every(Number.isFinite)) return null;
                if (change < 1e-6) break;
            }
            const coefficients = {};
            let intercept = beta[0];
            kept.forEach(({ name, mean, std }, idx) => {
                const coef = beta[idx + 1] / std;
                coefficients[name] = coef;
                intercept -= coef * mean;
            });
            names.forEach((name) => { if (!(name in coefficients)) coefficients[name] = 0; });
            return { intercept, coefficients };
        } catch (error) {
            return null;
        }
    }

    function poissonPredict(fit, names, vector) {
        let eta = fit.intercept;
        names.forEach((name, j) => { eta += (fit.coefficients[name] || 0) * vector[j]; });
        return Math.exp(Math.max(-20, Math.min(20, eta)));
    }

    // Expanding-window, rolling-origin evaluation: for each of the last few
    // blocks of `rollingBlockDays`, fit on everything before the block (minus
    // the gap) and test on the block. Needs `fitFn(trainRows) -> predictor(row)`
    // and `baselineFn`. Returns null when the history is too short.
    function rollingOrigin(rows, outcome, fitFn) {
        const hours = [...new Set(rows.map((r) => r.hourMs))].sort((a, b) => a - b);
        if (hours.length < CONFIG.rollingMinDays * 24) return null;
        const blockMs = CONFIG.rollingBlockDays * 24 * HOUR_MS;
        const gapMs = CONFIG.evaluationGapHours * HOUR_MS;
        const last = hours[hours.length - 1] + HOUR_MS;
        const folds = [];
        for (let k = CONFIG.rollingMaxBlocks; k >= 1; k -= 1) {
            const testFrom = last - k * blockMs;
            const testTo = testFrom + blockMs;
            const trainRows = rows.filter((r) => r.hourMs < testFrom - gapMs);
            const testRows = rows.filter((r) => r.hourMs >= testFrom && r.hourMs < testTo);
            if (trainRows.length < 1000 || !testRows.length) continue;
            const predictor = fitFn(trainRows);
            if (!predictor) continue;
            const baseline = hourOfWeekBaseline(trainRows, outcome);
            const actual = testRows.map((r) => r[outcome]);
            folds.push({
                testFrom, testTo: testTo - HOUR_MS, trainRows: trainRows.length, testRows: testRows.length,
                model: computeMetrics(actual, testRows.map(predictor)),
                baseline: computeMetrics(actual, testRows.map(baseline))
            });
        }
        return folds.length ? folds : null;
    }

    // The range the prediction is "likely" to fall in: the central `level`
    // share of the errors (actual - predicted) the model made on its test
    // hours, added to a new prediction. Built from the test errors themselves
    // (no normal-curve assumption), like the residual-based intervals of
    // Hyndman & Athanasopoulos, Forecasting: Principles and Practice, 5.5.
    function residualInterval(actual, predicted, level) {
        const errors = actual.map((a, i) => a - predicted[i]).sort((x, y) => x - y);
        if (errors.length < 10) return null;
        const tail = (1 - level) / 2;
        return { lo: percentile(errors, tail), hi: percentile(errors, 1 - tail), level };
    }

    function percentile(sortedValues, q) {
        if (!sortedValues.length) return 0;
        const pos = (sortedValues.length - 1) * q;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
    }

    // LOW / MODERATE / HIGH from a model's own TRAINING targets.
    //   P33 and P67 are the 33rd and 67th percentiles of ALL the training targets
    //   (zeros included), by linear interpolation between order statistics (R
    //   type 7, Excel PERCENTILE.INC; Hyndman & Fan, 1996). Nothing is rounded,
    //   no gap is invented, and ties are reported, not hidden.
    //   A value at or below P33 is LOW, above P67 is HIGH, anything between is
    //   MODERATE. With many equal values P33 and P67 can be equal: then there is no
    //   middle band, the categories are unreliable, and NO label is given.
    // These are descriptive labels (relative to the training history), not
    // probabilities, confidence levels or shortage measures.
    function percentileThresholds(values) {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        const method = 'linear interpolation between order statistics (R type 7, Excel PERCENTILE.INC)';
        if (sorted.length < 10) return { available: false, p33: null, p67: null, n: sorted.length, method, tied: false, lowPossible: false, zeroShare: null, note: 'Too few training targets to compute P33 and P67.' };
        const p33 = percentile(sorted, 0.33);
        const p67 = percentile(sorted, 0.67);
        const zeroShare = sorted.filter((v) => v === 0).length / sorted.length;
        const tied = p33 === p67;
        const lowPossible = true;
        let note = '';
        if (tied) note = `P33 and P67 are both ${p33}: most training targets are the same value, so LOW / MODERATE / HIGH would be misleading and no level is shown.`;
        else if (p33 === 0) note = 'P33 is 0 (many training hours had a count of 0), so only a prediction of 0 is LOW.';
        return { available: true, p33, p67, n: sorted.length, method, tied, lowPossible, zeroShare, note };
    }

    // The label for a count (the displayed, nonnegative whole number) against a
    // model's stored thresholds. Returns null when thresholds are not available.
    function classifyCount(value, thresholds) {
        if (!thresholds || !thresholds.available || !Number.isFinite(value)) return null;
        if (thresholds.tied) return null;
        if (value <= thresholds.p33) return 'LOW';
        if (value > thresholds.p67) return 'HIGH';
        return 'MODERATE';
    }

    // The `area` of a driver ping is read as a geohash only if it is one (base-32
    // text of 4 to 12 characters) AND decodes to a point inside Hagonoy.
    const GEOHASH_PATTERN = /^[0-9b-hjkmnp-z]{4,12}$/;

    function isGeohash(text) {
        return typeof text === 'string' && GEOHASH_PATTERN.test(text);
    }

    function geohashInHagonoy(text) {
        if (!isGeohash(text)) return false;
        const c = geohashCenter(text);
        const b = CONFIG.hagonoyBounds;
        return c.lat >= b.latMin && c.lat <= b.latMax && c.lng >= b.lngMin && c.lng <= b.lngMax;
    }

    // ── Qualitative labels for the inputs shown on the admin page ──────
    function rainLabel(mm) {
        if (!Number.isFinite(mm)) return null;
        if (mm < CONFIG.rainModerateFrom) return 'Light';
        if (mm < CONFIG.rainStrongFrom) return 'Moderate';
        return 'Strong';
    }

    // Low / High cut-offs (metres) from every reading in the uploaded bulletin.
    function tideLevels(tide) {
        const heights = [];
        ((tide && tide.byDate) || new Map()).forEach((list) => list.forEach((r) => heights.push(r.meters)));
        if (heights.length < CONFIG.tideMinReadingsForLabel) return null;
        heights.sort((a, b) => a - b);
        return { lowBelow: percentile(heights, 1 / 3), highFrom: percentile(heights, 2 / 3) };
    }

    function tideLabel(meters, levels) {
        if (!Number.isFinite(meters) || !levels) return null;
        if (meters < levels.lowBelow) return 'Low';
        if (meters < levels.highFrom) return 'Moderate';
        return 'High';
    }

    window.ParaPrediction = {
        CONFIG,
        trainingWindow,
        minRowsFor,
        HOUR_MS,
        RISK_LEVELS,
        manilaParts,
        hourKey,
        dayOfWeekOf,
        addDays,
        geohashEncode,
        geohashCenter,
        HAGONOY_BARANGAYS,
        TODAS,
        todasOf,
        ALL_HAGONOY_BARANGAYS,
        barangayFromAddress,
        barangayCentroids,
        nearestBarangay,
        loadEnvironment,
        parseTideWorkbook,
        indexTide,
        nearestTideReading,
        tideAt,
        environmentFor,
        classifyRain,
        classifyDischargeRatio,
        classifyTideRatio,
        combineRisk,
        fitOLS,
        fitLeastSquares,
        fitPoisson,
        poissonPredict,
        residualInterval,
        predictVector,
        computeMetrics,
        timeSplit,
        hourOfWeekBaseline,
        rollingOrigin,
        percentileThresholds,
        classifyCount,
        isGeohash,
        geohashInHagonoy,
        percentile,
        rainLabel,
        tideLevels,
        tideLabel
    };
})();
