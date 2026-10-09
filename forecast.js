// Driver availability + passenger booking demand (multiple linear regression).
//
// Two models are trained from ONE table of historical records, one row per
// (area, hour). Both use exactly the same six inputs:
//   x1 hour of day            x4 precipitation (mm)
//   x2 day of week            x5 tide height (m)
//   x3 location (one-hot)     x6 high-water risk level (0-3)
// and differ only in the outcome they learn:
//   Driver availability  = drivers online - drivers busy in that area and hour
//   Passenger demand     = completed ride bookings in that area and hour
//
// Training phase
//   1. aggregateActivity   - historical logs -> online / busy / bookings per (area, hour)
//   2. buildTrainingRows   - join with weather + tide, one row per area-hour
//   3. fitModel            - one-hot location, OLS (ParaPrediction.fitOLS) -> b0, b1…bn
// Prediction phase
//   predict                - Y = b0 + b1x1 + b2x2 + … + bnxn (clamped at 0)
//   ParaPrediction.classify - Y against the HIGH / MODERATE / LOW thresholds
//
// Shared maths (weather, tide, OLS, thresholds) lives in prediction.js.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    if (!P) return;
    const {
        CONFIG, HOUR_MS, manilaParts, hourKey, dayOfWeekOf, addDays, geohashCenter, HAGONOY_BARANGAYS,
        barangayCentroids, nearestBarangay, loadEnvironment, indexTide, environmentFor, fitOLS, computeMetrics, splitIndices, suggestThresholds
    } = P;

    // Bump when the feature set changes so models saved with an older layout
    // are ignored (and the admin is asked to retrain) instead of misread.
    const MODEL_SCHEMA = 4;

    // A driver log or booking further than this from every known barangay
    // centre is not assigned to a barangay.
    const MAX_BARANGAY_KM = 4;

    // A ride that "lasts" longer than this is treated as bad data rather than
    // marking a driver busy for hours.
    const MAX_BUSY_MS = 3 * HOUR_MS;

    const TARGETS = {
        availability: {
            key: 'availability',
            target: 'driver_availability',
            title: 'Driver Availability',
            unit: 'available drivers',
            outcome: 'available'
        },
        demand: {
            key: 'demand',
            target: 'passenger_demand',
            title: 'Passenger Booking Demand',
            unit: 'bookings',
            outcome: 'bookings'
        }
    };

    // ── Step 1: historical logs -> online / busy / bookings per (area, hour) ──
    function buildBusyWindows(bookings) {
        const byDriver = new Map();
        const stats = { windows: 0, noDropoffTime: 0, unusable: 0 };
        (bookings || []).forEach((b) => {
            if (!b.driverId) return;
            if (!Number.isFinite(b.createdMs) || !Number.isFinite(b.completedMs)) { stats.noDropoffTime += 1; return; }
            const span = b.completedMs - b.createdMs;
            if (span <= 0 || span > MAX_BUSY_MS) { stats.unusable += 1; return; }
            if (!byDriver.has(b.driverId)) byDriver.set(b.driverId, []);
            byDriver.get(b.driverId).push([b.createdMs, b.completedMs]);
            stats.windows += 1;
        });
        return { byDriver, stats };
    }

    // Real app logs only carry map coordinates. Give every driver log and
    // booking a barangay: bookings whose pickup address names one use it, and
    // everything else goes to the nearest barangay centre (centres are learned
    // from those addressed bookings). Anything that cannot be placed is
    // counted and left out. Sample data is already labelled and skips this.
    function assignBarangays(raw) {
        const bookings = raw.bookings || [];
        const centroids = barangayCentroids(bookings);
        const unplaced = { driverLogs: 0, bookings: 0 };
        const pointOf = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);

        const placeLog = (record) => {
            if (!record.area) { unplaced.driverLogs += 1; return null; }
            const barangay = nearestBarangay(geohashCenter(record.area), centroids, MAX_BARANGAY_KM);
            if (!barangay) { unplaced.driverLogs += 1; return null; }
            return { ...record, barangay };
        };
        const samples = (raw.samples || []).map(placeLog).filter(Boolean);
        const events = (raw.events || []).map(placeLog).filter(Boolean);
        const placed = [];
        bookings.forEach((b) => {
            const point = pointOf(b.lat, b.lng);
            const named = P.barangayFromAddress(b.address);
            const barangay = named || (point && nearestBarangay(point, centroids, MAX_BARANGAY_KM));
            if (!barangay) { unplaced.bookings += 1; return; }
            placed.push({ ...b, barangay });
        });
        return { samples, events, bookings: placed, unplaced, truncated: raw.truncated };
    }

    // `samples` / `events` are driver logs ({driverId, barangay, ms, busy?});
    // `bookings` are completed bookings ({barangay, ms, driverId?, createdMs?,
    // completedMs?}). `busy` on a log marks the driver as on a ride that hour
    // (sample data); real logs get it from the bookings' time windows.
    function aggregateActivity({ samples, events, bookings }) {
        const busy = buildBusyWindows(bookings);
        const driverHours = new Map(); // `${cell}|${hourKey}` -> Map(driverId -> wasBusy)
        const rideCounts = new Map();  // `${cell}|${hourKey}` -> completed bookings
        const cells = new Set();
        let firstDriverMs = Infinity;

        [...(samples || []), ...(events || [])].forEach((record) => {
            const cell = record.barangay;
            if (!cell || !record.driverId || !Number.isFinite(record.ms)) return;
            cells.add(cell);
            firstDriverMs = Math.min(firstDriverMs, record.ms);
            const parts = manilaParts(record.ms);
            const key = `${cell}|${hourKey(parts.dateKey, parts.hour)}`;
            if (!driverHours.has(key)) driverHours.set(key, new Map());
            // Busy for this hour if any of the driver's rides overlapped it
            // (the app only pings every ~5 min, so a short ride can fall
            // between two pings).
            const windows = busy.byDriver.get(record.driverId);
            const hourStart = Math.floor(record.ms / HOUR_MS) * HOUR_MS;
            const onRide = record.busy === true || Boolean(windows && windows.some(([start, end]) => start < hourStart + HOUR_MS && end > hourStart));
            const drivers = driverHours.get(key);
            drivers.set(record.driverId, Boolean(drivers.get(record.driverId)) || onRide);
        });

        (bookings || []).forEach((booking) => {
            const cell = booking.barangay;
            if (!cell || !Number.isFinite(booking.ms)) return;
            cells.add(cell);
            const parts = manilaParts(booking.ms);
            const key = `${cell}|${hourKey(parts.dateKey, parts.hour)}`;
            rideCounts.set(key, (rideCounts.get(key) || 0) + 1);
        });

        return { driverHours, rideCounts, cells: HAGONOY_BARANGAYS.filter((name) => cells.has(name)), firstDriverMs, busyStats: busy.stats };
    }

    // ── Step 2: one row per (area, hour) from the first driver log up to now,
    // so quiet hours count as real zeros. Rows are skipped (and counted) when
    // the weather / tide data is missing.
    function buildTrainingRows(activity, env, nowMs) {
        const rows = [];
        const skipped = { missingEnvironment: 0, tideDates: new Set() };
        if (!activity.cells.length || !Number.isFinite(activity.firstDriverMs)) {
            return { rows, skipped, hours: 0 };
        }

        const first = manilaParts(activity.firstDriverMs);
        const last = manilaParts(nowMs);
        const toClock = (parts) => {
            const [y, m, d] = parts.dateKey.split('-').map(Number);
            return Date.UTC(y, m - 1, d, parts.hour);
        };

        let hours = 0;
        for (let clock = toClock(first); clock <= toClock(last); clock += HOUR_MS) {
            const iso = new Date(clock).toISOString();
            const dateKey = iso.slice(0, 10);
            const hour = Number(iso.slice(11, 13));
            const key = hourKey(dateKey, hour);
            const environment = environmentFor(env, dateKey, hour);
            const dow = dayOfWeekOf(dateKey);
            hours += 1;

            activity.cells.forEach((area) => {
                if (!environment.ok) {
                    skipped.missingEnvironment += 1;
                    if (environment.issues.some((issue) => issue.startsWith('tide'))) skipped.tideDates.add(dateKey);
                    return;
                }
                const drivers = activity.driverHours.get(`${area}|${key}`);
                const online = drivers ? drivers.size : 0;
                let busy = 0;
                if (drivers) drivers.forEach((wasBusy) => { if (wasBusy) busy += 1; });
                rows.push({
                    area, dateKey, hour, dow,
                    online, busy,
                    available: online - busy,
                    bookings: activity.rideCounts.get(`${area}|${key}`) || 0,
                    rainfallMm: environment.rainfallMm,
                    tideM: environment.tideM,
                    riskLevel: environment.riskLevel
                });
            });
        }
        return { rows, skipped, hours };
    }

    // ── Step 3: feature coding ─────────────────────────────────────────
    // x1 hour, x2 day of week, x3 location (OneHotEncoder over barangays, first
    // barangay is the dropped baseline), x4 rainfall, x5 tide, x6 high-water risk.
    function featureNames(areas) {
        return [
            'hour',
            'day_of_week',
            ...areas.slice(1).map((area) => `area:${area}`),
            'rainfall_mm',
            'tide_height_m',
            'high_water_risk'
        ];
    }

    function encodeInput(input, areas) {
        return [
            input.hour,
            input.dow,
            ...areas.slice(1).map((area) => (input.area === area ? 1 : 0)),
            input.rainfallMm,
            input.tideM,
            input.riskLevel
        ];
    }

    // The outcome added up over all barangays for each day and hour.
    function townTotals(rows, outcome) {
        const totals = new Map();
        rows.forEach((row) => {
            const key = `${row.dateKey}|${row.hour}`;
            totals.set(key, (totals.get(key) || 0) + row[outcome]);
        });
        return [...totals.values()];
    }

    // ── Step 3: OLS fit + evaluation for one outcome ───────────────────
    function fitModel(rows, areas, targetDef, dataSource) {
        const names = featureNames(areas);
        const X = rows.map((row) => encodeInput(row, areas));
        const y = rows.map((row) => row[targetDef.outcome]);

        const { train, test, inSample } = splitIndices(rows.length);
        const fit = fitOLS(train.map((i) => X[i]), train.map((i) => y[i]), names);

        const predictRaw = (vector) => {
            let value = fit.intercept;
            names.forEach((name, j) => { value += (fit.coefficients[name] || 0) * vector[j]; });
            return Math.max(0, value);
        };
        const testActual = test.map((i) => y[i]);
        const testPredicted = test.map((i) => predictRaw(X[i]));
        const metrics = computeMetrics(testActual, testPredicted);

        const ranges = {};
        const rangeOf = (name, values) => {
            let min = Infinity;
            let max = -Infinity;
            values.forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
            ranges[name] = { min, max };
        };
        rangeOf('hour', rows.map((r) => r.hour));
        rangeOf('rainfall_mm', rows.map((r) => r.rainfallMm));
        rangeOf('tide_height_m', rows.map((r) => r.tideM));
        rangeOf('high_water_risk', rows.map((r) => r.riskLevel));

        const stride = Math.max(1, Math.ceil(test.length / 300));
        const testPoints = [];
        for (let i = 0; i < test.length; i += stride) testPoints.push({ a: testActual[i], p: Number(testPredicted[i].toFixed(3)) });

        return {
            schema: MODEL_SCHEMA,
            target: targetDef.target,
            label: targetDef.title,
            features: names,
            intercept: fit.intercept,
            coefficients: fit.coefficients,
            dropped: fit.dropped,
            areas,
            areaBaseline: areas[0],
            dataSource,
            ranges,
            // For one barangay and hour, and for the whole town (all barangays
            // added together) — the two have very different sizes.
            thresholds: suggestThresholds(y),
            thresholdsAll: suggestThresholds(townTotals(rows, targetDef.outcome)),
            metrics: {
                records: rows.length,
                trainRecords: train.length,
                testRecords: test.length,
                inSample,
                r2: metrics.r2,
                mae: metrics.mae,
                rmse: metrics.rmse
            },
            testPoints,
            trainedAt: Date.now()
        };
    }

    // The whole training phase on data already read from Firestore:
    // aggregate -> encode -> OLS for both outcomes.
    async function train(raw, options) {
        const opts = options || {};
        const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
        const loadEnv = opts.loadEnvironment || loadEnvironment;
        const onProgress = opts.onProgress || (() => {});
        const dataSource = opts.dataSource || 'real';

        let data = raw;
        let unplaced = { driverLogs: 0, bookings: 0 };
        if (!opts.labelled) {
            onProgress('Placing driver logs and bookings in Hagonoy barangays…');
            data = assignBarangays(raw);
            unplaced = data.unplaced;
        }
        onProgress('Counting drivers online, drivers busy and bookings per barangay and hour…');
        const activity = aggregateActivity(data);
        if (!activity.cells.length || !Number.isFinite(activity.firstDriverMs)) {
            throw new Error('No driver activity was found in this period yet — the app has not logged any drivers online, so there is nothing to train on.');
        }

        const first = manilaParts(activity.firstDriverMs);
        const last = manilaParts(nowMs);
        const fromKey = addDays(first.dateKey, -CONFIG.baselineDays);
        const toKey = addDays(last.dateKey, CONFIG.dischargeAheadDays + 1);

        onProgress('Loading rainfall and river data from Open-Meteo…');
        const env = await loadEnv(fromKey, toKey, nowMs);
        env.tide = indexTide(raw.tide || []);

        onProgress('Building the training table…');
        const { rows, skipped, hours } = buildTrainingRows(activity, env, nowMs);
        const tideDateList = [...skipped.tideDates].sort();
        const tideHint = tideDateList.length
            ? ` The uploaded tide data has no readings for ${tideDateList.length} of the training dates (${tideDateList[0]}${tideDateList.length > 1 ? ` … ${tideDateList[tideDateList.length - 1]}` : ''}) — upload a file that covers them.`
            : '';
        if (rows.length < CONFIG.minTrainingRows) {
            throw new Error(`Not enough data to train yet: ${rows.length} usable hour-and-area records (at least ${CONFIG.minTrainingRows} needed). The app has been logging drivers since ${first.dateKey}.${tideHint}`);
        }

        const areas = activity.cells; // barangays with data; the first is the baseline

        onProgress('Fitting the regression models…');
        const models = {
            availability: fitModel(rows, areas, TARGETS.availability, dataSource),
            demand: fitModel(rows, areas, TARGETS.demand, dataSource)
        };

        const dayKeys = new Set(rows.map((r) => r.dateKey));
        const totalOnline = rows.reduce((s, r) => s + r.online, 0);
        const totalBusy = rows.reduce((s, r) => s + r.busy, 0);
        const totalBookings = rows.reduce((s, r) => s + r.bookings, 0);
        const warnings = [];
        if (dayKeys.size < 7) warnings.push(`Only ${dayKeys.size} day${dayKeys.size === 1 ? '' : 's'} of data: day of week cannot be estimated reliably until there is at least a full week.`);
        if (dataSource === 'sample') warnings.push('These models were trained on generated sample data, not real bookings. Retrain with real app data once enough has been logged.');
        if (unplaced.driverLogs > 0) warnings.push(`${unplaced.driverLogs.toLocaleString()} driver logs could not be placed in a barangay (no booking address near them yet) and were left out.`);
        if (unplaced.bookings > 0) warnings.push(`${unplaced.bookings.toLocaleString()} bookings could not be placed in a barangay and were left out.`);
        if (raw.truncated) warnings.push('The activity log was very large, so only the earliest part of the period was loaded. Choose a shorter period for the most recent data.');
        if (skipped.missingEnvironment > 0) warnings.push(`${skipped.missingEnvironment} hour-and-area records were skipped because tide, rainfall or river data was missing for them.${tideHint}`);
        if (activity.busyStats.noDropoffTime > 0) warnings.push(`${activity.busyStats.noDropoffTime} completed ride${activity.busyStats.noDropoffTime === 1 ? ' has' : 's have'} no drop-off time (recorded only by newer app versions), so ${activity.busyStats.noDropoffTime === 1 ? 'its' : 'their'} busy time could not be counted.`);
        if (activity.busyStats.unusable > 0) warnings.push(`${activity.busyStats.unusable} ride${activity.busyStats.unusable === 1 ? ' was' : 's were'} ignored for busy time because the booking-to-drop-off time was zero or longer than 3 hours.`);
        if (totalBusy === 0) warnings.push('No driver busy time could be rebuilt (no completed rides with drop-off times in this period), so every online driver counts as available.');
        if (totalBookings === 0) warnings.push('No completed bookings with a pickup location were found in this period, so the booking demand model has nothing to learn from.');
        Object.values(models).forEach((m) => {
            if (m.dropped.length) warnings.push(`${m.label}: ${m.dropped.join(', ')} did not vary in the data, so ${m.dropped.length === 1 ? 'it was' : 'they were'} left out of the model.`);
            if (!m.thresholds.suggested) warnings.push(`${m.label}: too few non-zero counts to suggest HIGH / MODERATE / LOW thresholds — set them below.`);
        });

        const summary = {
            from: first.dateKey,
            to: last.dateKey,
            days: dayKeys.size,
            hours,
            areas: areas.length,
            records: rows.length,
            dataSource,
            driverLogs: (data.samples || []).length + (data.events || []).length,
            rides: (data.bookings || []).length,
            meanOnline: totalOnline / rows.length,
            meanBusy: totalBusy / rows.length,
            meanBookings: totalBookings / rows.length
        };
        return { models, summary, warnings };
    }

    // ── Prediction phase ───────────────────────────────────────────────
    // Y = b0 + b1x1 + b2x2 + … + bnxn, clamped at 0 (a count can't be negative).
    function predict(model, input) {
        const vector = encodeInput(input, model.areas);
        let value = model.intercept;
        model.features.forEach((name, j) => { value += (model.coefficients[name] || 0) * vector[j]; });
        return Math.max(0, value);
    }

    // The whole municipality: every barangay's prediction added together.
    function predictAll(model, input) {
        return model.areas.reduce((sum, area) => sum + predict(model, { ...input, area }), 0);
    }

    // The thresholds that apply to one barangay or to the whole town.
    function thresholdsFor(model, allTown) {
        return allTown ? model.thresholdsAll : model.thresholds;
    }

    // A saved model is usable only if it was trained with the current inputs.
    function isCurrent(model) {
        return Boolean(model && model.schema === MODEL_SCHEMA && Array.isArray(model.features));
    }

    // Inputs the model never saw (beyond the min/max of its training rows, with
    // a 10% margin).
    function outOfRangeInputs(model, input) {
        const out = [];
        const check = (name, label, value) => {
            const range = model.ranges && model.ranges[name];
            if (!range) return;
            const slack = (range.max - range.min) * 0.1;
            if (value < range.min - slack || value > range.max + slack) out.push(label);
        };
        check('hour', 'hour of day', input.hour);
        check('rainfall_mm', 'rainfall', input.rainfallMm);
        check('tide_height_m', 'tide height', input.tideM);
        check('high_water_risk', 'high-water risk', input.riskLevel);
        return out;
    }

    window.ParaForecast = {
        assignBarangays,
        MODEL_SCHEMA,
        MAX_BUSY_MS,
        TARGETS,
        aggregateActivity,
        buildTrainingRows,
        featureNames,
        train,
        predict,
        predictAll,
        thresholdsFor,
        isCurrent,
        outOfRangeInputs
    };
})();
