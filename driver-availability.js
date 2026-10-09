// Driver Availability prediction (multiple linear regression).
//
// Follows the algorithm in the project's algorithm deck:
//   Target:  Available Drivers = Drivers Online - Drivers Busy
//   Inputs:  hour of day, day of week, area, weather (rainfall, tide,
//            high-water risk) and past ride demand
//   Model:   ordinary least squares, 80% training / 20% testing, evaluated
//            with MAE, RMSE and R²
//
// Where each number comes from (all real app data, nothing generated):
//   Drivers online  - distinct drivers the app logged in that area and hour
//                     (driverLocationSamples every ~5 min, driverStatusEvents)
//   Drivers busy    - those drivers who were on a ride at some point in that
//                     hour (a ride overlapping the hour). The app flips a
//                     driver to BUSY when a booking is assigned and frees them
//                     when it ends, but does not log that, so busy time is
//                     rebuilt from completed rides: booking created -> drop-off
//                     (completedAt).
//   Past ride demand- average completed rides in the same area at the same
//                     hour of day on EARLIER days.
//
// Shared maths (weather, tide, OLS, thresholds) lives in prediction.js.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    if (!P) return;
    const {
        CONFIG, HOUR_MS, manilaParts, hourKey, dayOfWeekOf, addDays, geohashEncode, cellOfArea, labelAreas,
        loadEnvironment, indexTide, environmentFor, fitOLS, predictVector, computeMetrics, splitIndices,
        suggestThresholds
    } = P;

    // A ride that "lasts" longer than this is treated as bad data rather than
    // marking a driver busy for hours.
    const MAX_BUSY_MS = 3 * HOUR_MS;

    // ── Dataset: online, busy and past demand per (area, hour) ────────
    // Busy windows per driver, from completed rides.
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

    // `samples` / `events` are the app's driverLocationSamples / driverStatusEvents
    // ({driverId, area, ms}); `bookings` are completed bookings
    // ({driverId, lat, lng, ms, createdMs, completedMs}).
    function aggregateActivity({ samples, events, bookings }) {
        const busy = buildBusyWindows(bookings);
        const driverHours = new Map(); // `${cell}|${hourKey}` -> Map(driverId -> wasBusy)
        const rideCounts = new Map();  // `${cell}|${hourKey}` -> completed rides
        const cells = new Set();
        let firstDriverMs = Infinity;

        [...(samples || []), ...(events || [])].forEach((record) => {
            const cell = cellOfArea(record.area);
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
            const onRide = Boolean(windows && windows.some(([start, end]) => start < hourStart + HOUR_MS && end > hourStart));
            const drivers = driverHours.get(key);
            drivers.set(record.driverId, Boolean(drivers.get(record.driverId)) || onRide);
        });

        (bookings || []).forEach((booking) => {
            if (!Number.isFinite(booking.lat) || !Number.isFinite(booking.lng) || !Number.isFinite(booking.ms)) return;
            const cell = geohashEncode(booking.lat, booking.lng, CONFIG.areaPrecision);
            cells.add(cell);
            const parts = manilaParts(booking.ms);
            const key = `${cell}|${hourKey(parts.dateKey, parts.hour)}`;
            rideCounts.set(key, (rideCounts.get(key) || 0) + 1);
        });

        return { driverHours, rideCounts, cells: [...cells].sort(), firstDriverMs, busyStats: busy.stats };
    }

    // One row per (area, hour) from the first driver log up to now, so quiet
    // hours count as real zeros. Rows are skipped (and counted) when the
    // weather/tide data is missing or when there is no earlier day to measure
    // past demand from.
    function buildTrainingRows(activity, env, nowMs) {
        const rows = [];
        const skipped = { missingEnvironment: 0, noHistory: 0, tideDates: new Set() };
        const history = new Map(); // `${cell}|${hour}` -> { sum, days }
        if (!activity.cells.length || !Number.isFinite(activity.firstDriverMs)) {
            return { rows, skipped, hours: 0, pastDemand: {} };
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

            activity.cells.forEach((cell) => {
                const stats = history.get(`${cell}|${hour}`) || { sum: 0, days: 0 };
                const pastDemand = stats.days > 0 ? stats.sum / stats.days : null;
                const rides = activity.rideCounts.get(`${cell}|${key}`) || 0;
                // Past demand only ever uses EARLIER days, so update after reading it.
                history.set(`${cell}|${hour}`, { sum: stats.sum + rides, days: stats.days + 1 });

                if (!environment.ok) {
                    skipped.missingEnvironment += 1;
                    if (environment.issues.some((issue) => issue.startsWith('tide'))) skipped.tideDates.add(dateKey);
                    return;
                }
                if (pastDemand === null) { skipped.noHistory += 1; return; }

                const drivers = activity.driverHours.get(`${cell}|${key}`);
                const online = drivers ? drivers.size : 0;
                let busy = 0;
                if (drivers) drivers.forEach((wasBusy) => { if (wasBusy) busy += 1; });
                rows.push({
                    cell, dateKey, hour, dow,
                    online, busy, available: online - busy,
                    pastDemand,
                    rainfallMm: environment.rainfallMm,
                    tideM: environment.tideM,
                    riskLevel: environment.riskLevel
                });
            });
        }

        // The table the prediction page uses for "past ride demand".
        const pastDemand = {};
        activity.cells.forEach((cell) => {
            pastDemand[cell] = Array.from({ length: 24 }, (_, h) => {
                const stats = history.get(`${cell}|${h}`);
                return stats && stats.days > 0 ? Number((stats.sum / stats.days).toFixed(4)) : 0;
            });
        });
        return { rows, skipped, hours, pastDemand };
    }

    // ── Features ───────────────────────────────────────────────────────
    function featureNames(areas) {
        return [
            'hour',
            'day_of_week',
            ...areas.slice(1).map((cell) => `area:${cell}`), // first area is the baseline (OneHotEncoder drop='first')
            'past_ride_demand',
            'rainfall_mm',
            'tide_height_m',
            'high_water_risk'
        ];
    }

    function encodeRow(row, areas) {
        const vector = [row.hour, row.dow];
        areas.slice(1).forEach((cell) => vector.push(row.cell === cell ? 1 : 0));
        vector.push(row.pastDemand, row.rainfallMm, row.tideM, row.riskLevel);
        return vector;
    }

    // ── Training phase ─────────────────────────────────────────────────
    function fitModel(rows, areas, areaLabels, pastDemand) {
        const names = featureNames(areas);
        const X = rows.map((row) => encodeRow(row, areas));
        const y = rows.map((row) => row.available);

        const { train, test, inSample } = splitIndices(rows.length);
        const fit = fitOLS(train.map((i) => X[i]), train.map((i) => y[i]), names);

        const testActual = test.map((i) => y[i]);
        const testPredicted = test.map((i) => Math.max(0, predictVector(fit, names, X[i])));
        const metrics = computeMetrics(testActual, testPredicted);

        const ranges = {};
        const rangeOf = (name, values) => {
            let min = Infinity;
            let max = -Infinity;
            values.forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
            ranges[name] = { min, max };
        };
        rangeOf('hour', rows.map((r) => r.hour));
        rangeOf('past_ride_demand', rows.map((r) => r.pastDemand));
        rangeOf('rainfall_mm', rows.map((r) => r.rainfallMm));
        rangeOf('tide_height_m', rows.map((r) => r.tideM));
        rangeOf('high_water_risk', rows.map((r) => r.riskLevel));

        const stride = Math.max(1, Math.ceil(test.length / 300));
        const testPoints = [];
        for (let i = 0; i < test.length; i += stride) testPoints.push({ a: testActual[i], p: Number(testPredicted[i].toFixed(3)) });

        return {
            target: 'driver_availability',
            label: 'Available drivers',
            features: names,
            intercept: fit.intercept,
            coefficients: fit.coefficients,
            dropped: fit.dropped,
            areas,
            areaBaseline: areas[0],
            areaLabels,
            pastDemand,
            ranges,
            thresholds: suggestThresholds(y),
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
    // collect → prepare → build features → fit → evaluate.
    async function train(raw, options) {
        const opts = options || {};
        const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
        const loadEnv = opts.loadEnvironment || loadEnvironment;
        const onProgress = opts.onProgress || (() => {});

        onProgress('Counting drivers online and busy per area and hour…');
        const activity = aggregateActivity(raw);
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
        const { rows, skipped, hours, pastDemand } = buildTrainingRows(activity, env, nowMs);
        const tideDateList = [...skipped.tideDates].sort();
        const tideHint = tideDateList.length
            ? ` The uploaded tide bulletin has no readings for ${tideDateList.length} of the training dates (${tideDateList[0]}${tideDateList.length > 1 ? ` … ${tideDateList[tideDateList.length - 1]}` : ''}) — upload a bulletin that covers them.`
            : '';
        if (rows.length < CONFIG.minTrainingRows) {
            throw new Error(`Not enough data to train yet: ${rows.length} usable hour-and-area records (at least ${CONFIG.minTrainingRows} needed). The app has been logging drivers since ${first.dateKey}.${tideHint}`);
        }

        const areas = activity.cells; // sorted; first is the baseline
        const addresses = (raw.bookings || []).map((b) => ({ lat: b.lat, lng: b.lng, address: b.address }));
        const areaLabels = labelAreas(areas, addresses);

        onProgress('Fitting the regression model…');
        const model = fitModel(rows, areas, areaLabels, pastDemand);

        const dayKeys = new Set(rows.map((r) => r.dateKey));
        const totalOnline = rows.reduce((s, r) => s + r.online, 0);
        const totalBusy = rows.reduce((s, r) => s + r.busy, 0);
        const warnings = [];
        if (dayKeys.size < 7) warnings.push(`Only ${dayKeys.size} day${dayKeys.size === 1 ? '' : 's'} of data: day of week cannot be estimated reliably until there is at least a full week.`);
        if (raw.truncated) warnings.push('The activity log was very large, so only the earliest part of the period was loaded. Choose a shorter period for the most recent data.');
        if (skipped.missingEnvironment > 0) warnings.push(`${skipped.missingEnvironment} hour-and-area records were skipped because tide, rainfall or river data was missing for them.${tideHint}`);
        if (skipped.noHistory > 0) warnings.push(`${skipped.noHistory} hour-and-area records were skipped because there was no earlier day yet to measure past ride demand from.`);
        if (activity.busyStats.noDropoffTime > 0) warnings.push(`${activity.busyStats.noDropoffTime} completed ride${activity.busyStats.noDropoffTime === 1 ? ' has' : 's have'} no drop-off time (recorded only by newer app versions), so ${activity.busyStats.noDropoffTime === 1 ? 'its' : 'their'} busy time could not be counted.`);
        if (activity.busyStats.unusable > 0) warnings.push(`${activity.busyStats.unusable} ride${activity.busyStats.unusable === 1 ? ' was' : 's were'} ignored for busy time because the booking-to-drop-off time was zero or longer than 3 hours.`);
        if (totalBusy === 0) warnings.push('No driver busy time could be rebuilt (no completed rides with drop-off times in this period), so every online driver counts as available. The model will mostly learn how many drivers are online.');
        if (model.dropped.length) warnings.push(`${model.dropped.join(', ')} did not vary in the data, so ${model.dropped.length === 1 ? 'it was' : 'they were'} left out of the model.`);
        if (!model.thresholds.suggested) warnings.push('Too few non-zero counts to suggest HIGH / MODERATE / LOW thresholds — set them below.');

        const summary = {
            from: first.dateKey,
            to: last.dateKey,
            days: dayKeys.size,
            hours,
            areas: areas.length,
            records: rows.length,
            driverLogs: (raw.samples || []).length + (raw.events || []).length,
            rides: (raw.bookings || []).length,
            busyWindows: activity.busyStats.windows,
            meanOnline: totalOnline / rows.length,
            meanBusy: totalBusy / rows.length
        };
        return { model, summary, warnings };
    }

    // ── Prediction phase ───────────────────────────────────────────────
    function pastDemandFor(model, area, hour) {
        const table = model.pastDemand && model.pastDemand[area];
        return table && Number.isFinite(table[hour]) ? table[hour] : 0;
    }

    // Y = b0 + b1x1 + b2x2 + … + bnxn, clamped at 0 (a count can't be negative).
    function predict(model, input) {
        const past = input.pastDemand == null ? pastDemandFor(model, input.area, input.hour) : input.pastDemand;
        const vector = [
            input.hour,
            input.dow,
            ...model.areas.slice(1).map((cell) => (input.area === cell ? 1 : 0)),
            past,
            input.rainfallMm,
            input.tideM,
            input.riskLevel
        ];
        let value = model.intercept;
        model.features.forEach((name, j) => { value += (model.coefficients[name] || 0) * vector[j]; });
        return Math.max(0, value);
    }

    // Inputs the model never saw (outside the min/max of its training rows).
    function outOfRangeInputs(model, input) {
        const out = [];
        const check = (name, label, value) => {
            const range = model.ranges && model.ranges[name];
            if (range && (value < range.min || value > range.max)) out.push(label);
        };
        check('hour', 'hour of day', input.hour);
        check('past_ride_demand', 'past ride demand', input.pastDemand == null ? pastDemandFor(model, input.area, input.hour) : input.pastDemand);
        check('rainfall_mm', 'rainfall', input.rainfallMm);
        check('tide_height_m', 'tide height', input.tideM);
        check('high_water_risk', 'high-water risk', input.riskLevel);
        return out;
    }

    window.ParaDriverAvailability = {
        MAX_BUSY_MS,
        aggregateActivity,
        buildTrainingRows,
        featureNames,
        train,
        predict,
        pastDemandFor,
        outOfRangeInputs
    };
})();
