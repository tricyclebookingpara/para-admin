// Passenger booking demand and eligible driver availability: two separate
// multiple linear regressions (ordinary least squares).
//
// Both are trained from ONE table, one row per (barangay, hour), with the same
// predictors:
//   hour of day, day of week, barangay (each one-hot), rainfall in the target
//   hour (mm), tide height (m, OPTIONAL) and a high-water risk level (0-3)
// and differ only in the target they learn (each has its own coefficients):
//
//   MODEL A  Booking demand = distinct booking REQUESTS created in the hour
//            (request timestamp, pickup barangay, any status). NOT completed
//            rides: cancelled / unassigned requests are real demand.
//   MODEL B  Driver availability = distinct ELIGIBLE drivers who are online,
//            not on a ride, and have a fresh location ping, counted at the
//            START of the hour in the barangay of their latest ping.
//
// ONE data path: every valid record in Firestore is historical data. The records
// are read by ParaFirestore.fetchPredictionTrainingData, which registers each
// batch it produces; train() refuses anything else. Records that the project
// seeded for demonstration (isSeed / SEED_ ids) are used like any other history
// and COUNTED in the model's provenance (they are not real activity, and the
// scores say nothing about real-world accuracy until real bookings replace
// them). Only configured test accounts are excluded.
//
// Missing data are never turned into zeros:
//   - Model A counts only on days the booking system is shown to be running
//     (a booking request or any driver log that day).
//   - Model B counts an hour only when driver logging is shown to be alive
//     around it, or every known driver is explicitly OFFLINE, and no driver in
//     the relevant state is of unknown eligibility, status or barangay. Any
//     other hour is UNOBSERVED (null) and left out of that model's training.
//
// Every predictor is information available when the forecast is issued:
// calendar, barangay, target-hour rainfall (a forecast), rain of the previous
// 24 h, river flow of the previous day, and the published tide table.
//
// Estimation: ordinary least squares by Householder QR with column pivoting
// (prediction.js fitLeastSquares), never by inverting X'X. Candidate lag
// predictors (previous hour / day / week) are NOT used: a forecast for an hour
// up to 7 days ahead cannot know the previous hour, and no lag was evaluated.
// Shared maths (least squares, time split, baseline, Poisson comparison,
// thresholds, weather and tide) lives in prediction.js.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    if (!P) return;
    const {
        CONFIG, minRowsFor, HOUR_MS, manilaParts, hourKey, dayOfWeekOf, addDays, geohashCenter, HAGONOY_BARANGAYS,
        barangayCentroids, nearestBarangay, loadEnvironment, indexTide, environmentFor, fitOLS, fitPoisson, poissonPredict,
        residualInterval, computeMetrics, timeSplit, hourOfWeekBaseline, rollingOrigin, percentileThresholds, classifyCount
    } = P;

    // Bump when the feature layout or the saved fields change, so models saved
    // with an older layout are ignored instead of misread.
    const MODEL_SCHEMA = 12;
    const IMPLEMENTATION_VERSION = 'mlr-6.1';

    const TIDE_MODES = ['with_tide', 'no_tide'];

    // A driver ping or booking further than this from every known barangay
    // centre is not assigned to a barangay.
    const MAX_BARANGAY_KM = 4;

    // A ride that "lasts" longer than this is treated as bad data.
    const MAX_BUSY_MS = 3 * HOUR_MS;

    // The app only sets a driver OFFLINE when they tap it, so a driver whose
    // app was closed keeps their last status. Presence is therefore judged by
    // a location ping no older than the app's own cut-off (5 minutes, see
    // DRIVER_PING_FRESH_MS in firestore-ui.js). A driver whose app is not
    // pinging cannot receive a booking, so is not "available".
    const FRESH_PING_MS = 5 * 60 * 1000;

    // Booking timestamps this far in the future are clock errors.
    const FUTURE_SKEW_MS = 5 * 60 * 1000;

    // More than this share of requests placed only by guessing from a map point
    // makes the demand counts too unreliable to train on.
    const MAX_UNVERIFIED_PLACEMENT_SHARE = 0.25;

    const STATUS_RANK = { OFFLINE: 0, BUSY: 1, AVAILABLE: 2, ONLINE: 2 };

    const TARGETS = {
        availability: {
            key: 'availability',
            target: 'driver_availability',
            title: 'Driver Availability',
            unit: 'available drivers',
            outcome: 'available',
            definition: 'Number of distinct eligible drivers (approved at that time, not suspended) who are online, not on a ride and have a location ping from the last 5 minutes, in the barangay of that ping, at the START of the target hour. An hour is used only when driver logging is shown to be working around it.'
        },
        demand: {
            key: 'demand',
            target: 'passenger_demand',
            title: 'Passenger Booking Demand',
            unit: 'booking requests',
            outcome: 'requests',
            definition: 'Number of distinct booking requests created during the target hour (request timestamp, any status) whose pickup barangay is recorded on the booking or named in its pickup address.'
        }
    };


    // ── Step 1: booking requests ────────────────────────────────────────
    // `bookings` are every booking document (any status), as
    // {id, ms (request time), timeKind, statusRaw, driverId, createdMs, completedMs,
    //  lat, lng, address, recordedBarangay, isTest, joinRequestExpired}.
    // Nothing is invented: a request without a usable timestamp is left out and
    // counted, a duplicate id counts once, a future or implausible time is a
    // clock/format error, a record marked as a test is excluded.
    function prepareBookings(bookings, nowMs) {
        const stats = { input: 0, missingTimestamp: 0, invalidTimestamp: 0, future: 0, duplicates: 0, testRecords: 0, joinRequestExpired: 0, byStatus: {} };
        const seen = new Set();
        const requests = [];
        (bookings || []).forEach((b) => {
            stats.input += 1;
            if (b.isTest === true) { stats.testRecords += 1; return; }
            if (!Number.isFinite(b.ms) || b.ms <= 0) {
                if (b.timeKind && b.timeKind !== 'missing') stats.invalidTimestamp += 1;
                else stats.missingTimestamp += 1;
                return;
            }
            if (b.ms < CONFIG.plausibleFromMs) { stats.invalidTimestamp += 1; return; }
            if (b.ms > nowMs + FUTURE_SKEW_MS) { stats.future += 1; return; }
            const id = b.id == null || b.id === '' ? null : String(b.id);
            if (id !== null) {
                if (seen.has(id)) { stats.duplicates += 1; return; }
                seen.add(id);
            }
            if (b.joinRequestExpired === true) stats.joinRequestExpired += 1;
            const status = b.statusRaw || 'unknown';
            stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
            requests.push(b);
        });
        return { requests, stats };
    }

    // The barangay of a booking is VERIFIED only when the booking itself says it:
    //   'recorded'  a pickup-barangay field written when the booking was created
    //   'address'   the pickup address names a barangay
    // A booking with neither is NOT assigned from its map point to "the nearest
    // barangay centre" as if that were certain: it is left out of the demand
    // counts and reported (placement.geoOnly). Driver pings carry only a
    // geohash, so they are placed by nearest learned centre (an inference,
    // stated in the model), using centres learned from at least
    // CONFIG.minCentroidBookings addressed bookings.
    function assignBarangays(raw) {
        const bookings = raw.bookings || [];
        const nameOf = (b) => (b.recordedBarangay ? P.barangayFromAddress(b.recordedBarangay) : null);
        const centroids = barangayCentroids(bookings.map((b) => ({ lat: b.lat, lng: b.lng, address: nameOf(b) || b.address })));
        // outside*: placed in a barangay PARA doesn't cover, so left out.
        const unplaced = { driverLogs: 0, bookings: 0, outsideLogs: 0, outsideBookings: 0 };
        const placement = { recorded: 0, address: 0, geoOnly: 0, recordedUnrecognised: 0 };
        const covered = (name) => HAGONOY_BARANGAYS.includes(name);
        const pointOf = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);

        const placeLog = (record) => {
            if (!record.area) { unplaced.driverLogs += 1; return null; }
            const barangay = nearestBarangay(geohashCenter(record.area), centroids, MAX_BARANGAY_KM);
            if (!barangay) { unplaced.driverLogs += 1; return null; }
            if (!covered(barangay)) { unplaced.outsideLogs += 1; return null; }
            return { ...record, barangay };
        };
        // A status event without a position still tells us the status; it just
        // cannot say where the driver was.
        const placeEvent = (record) => (record.area ? (placeLog(record) || { ...record, barangay: null }) : { ...record, barangay: null });
        const samples = (raw.samples || []).map(placeLog).filter(Boolean);
        const events = (raw.events || []).map(placeEvent);
        const placed = [];
        bookings.forEach((b) => {
            if (b.recordedBarangay && !nameOf(b)) placement.recordedUnrecognised += 1;
            const recorded = nameOf(b);
            const named = P.barangayFromAddress(b.address);
            const barangay = recorded || named;
            if (!barangay) {
                if (pointOf(b.lat, b.lng)) placement.geoOnly += 1;
                unplaced.bookings += 1;
                return;
            }
            if (!covered(barangay)) { unplaced.outsideBookings += 1; return; }
            if (recorded) placement.recorded += 1; else placement.address += 1;
            placed.push({ ...b, barangay, placement: recorded ? 'recorded' : 'address' });
        });
        return { samples, events, bookings: placed, unplaced, placement, centroidCount: Object.keys(centroids).length, truncated: raw.truncated };
    }

    // ── Step 2: Model A target ──────────────────────────────────────────
    // Requests per `${barangay}|${hourKey}`, by the REQUEST timestamp (never the
    // ride's completion time).
    function aggregateRequests(requests) {
        const counts = new Map();
        const cells = new Set();
        let firstMs = Infinity;
        requests.forEach((r) => {
            if (!r.barangay || !Number.isFinite(r.ms)) return;
            const parts = manilaParts(r.ms);
            const key = `${r.barangay}|${hourKey(parts.dateKey, parts.hour)}`;
            counts.set(key, (counts.get(key) || 0) + 1);
            cells.add(r.barangay);
            firstMs = Math.min(firstMs, r.ms);
        });
        return { counts, cells, firstMs };
    }

    // ── Step 3: Model B target ──────────────────────────────────────────
    function lastAtOrBefore(sorted, ms) {
        let lo = 0;
        let hi = sorted.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid].ms <= ms) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return found;
    }

    function firstAtOrAfter(sortedMs, ms) {
        let lo = 0;
        let hi = sortedMs.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sortedMs[mid] < ms) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    function buildRideWindows(bookings) {
        const byDriver = new Map();
        const stats = { windows: 0, noDropoffTime: 0, openRides: 0, unusable: 0 };
        const ended = /cancel|declin|reject|expire|no.?show|unassign/i;
        (bookings || []).forEach((b) => {
            if (!b.driverId) return;
            // A ride occupies the driver from when they ACCEPTED it (when that time
            // is stored) or else from when it was requested, until drop-off.
            const start = Number.isFinite(b.acceptedMs) ? b.acceptedMs : b.createdMs;
            if (!Number.isFinite(start)) { stats.noDropoffTime += 1; return; }
            if (!Number.isFinite(b.completedMs)) {
                // Accepted but no drop-off time: the ride may still have been going, so
                // for up to MAX_BUSY_MS the driver's state is UNCERTAIN (flagged open),
                // never assumed free. A cancelled/declined/expired one frees the driver.
                stats.noDropoffTime += 1;
                if (ended.test(String(b.statusRaw || ''))) return;
                if (!byDriver.has(b.driverId)) byDriver.set(b.driverId, []);
                byDriver.get(b.driverId).push([start, start + MAX_BUSY_MS, true]);
                stats.openRides += 1;
                return;
            }
            const span = b.completedMs - start;
            if (span <= 0 || span > MAX_BUSY_MS) { stats.unusable += 1; return; }
            if (!byDriver.has(b.driverId)) byDriver.set(b.driverId, []);
            byDriver.get(b.driverId).push([start, b.completedMs, false]);
            stats.windows += 1;
        });
        return { byDriver, stats };
    }

    // Whether a driver was eligible at time T, from the roster
    // {id, approved, approvedAtMs, suspended, suspendedAtMs, suspendedUntilMs}.
    // Approval and suspension are stored as CURRENT states; their times are what
    // lets us look back. Anything the times cannot settle is 'unknown' (and the
    // hour then is not used), never assumed:
    //   approved now, hour at/after the stored time   eligible
    //   approved now, hour BEFORE the stored time     unknown (the stored time is the
    //        time of the LAST verification decision, so an earlier approval may exist)
    //   approved now, no time stored                  unknown
    //   not approved now, never had a decision        ineligible
    //   not approved now, had a decision once         unknown (may have been eligible then)
    //   suspended now, suspension time known     ineligible during [suspendedAt, suspendedUntil)
    //   suspended now, time not stored           unknown
    // Earlier suspensions that were lifted are not stored and cannot be seen.
    function eligibilityAt(entry, T) {
        if (!entry) return 'unknown';
        if (entry.approved) {
            if (!Number.isFinite(entry.approvedAtMs)) return 'unknown';
            if (T < entry.approvedAtMs) return 'unknown';
        } else {
            return Number.isFinite(entry.approvedAtMs) ? 'unknown' : 'ineligible';
        }
        if (entry.suspended) {
            if (!Number.isFinite(entry.suspendedAtMs)) return 'unknown';
            if (T >= entry.suspendedAtMs && (!Number.isFinite(entry.suspendedUntilMs) || T < entry.suspendedUntilMs)) return 'ineligible';
        }
        return 'eligible';
    }

    // For each hour start T and each driver, the driver counts as AVAILABLE only
    // if ALL of these hold, otherwise they are not counted (never guessed):
    //   1. their latest status event at or before T is ONLINE / AVAILABLE
    //      (an explicit OFFLINE event is never "online"; events at the same
    //      instant resolve conservatively, OFFLINE winning; exact duplicates
    //      count once; order in the database does not matter);
    //   2. they have a location ping within FRESH_PING_MS before T (a stale
    //      status without a fresh ping does not establish availability);
    //   3. they are not on a ride: no BUSY status, and T is not inside a
    //      completed ride's created -> drop-off window;
    //   4. they were eligible at T (eligibilityAt);
    //   5. the latest ping is placed in a barangay. A driver is counted in
    //      exactly one barangay per hour.
    //
    // Whether the HOUR is observed at all (a count of 0 is only a real zero):
    //   - it is NOT observed if any driver who might be available has an
    //     unknown status (a fresh ping but no status event), unknown
    //     eligibility, or an unplaceable ping: the count would be a guess;
    //   - otherwise it IS observed when driver logging is shown to be alive
    //     (any driver ping or event within CONFIG.observationWindowHours of T),
    //     or when every driver with a known status is explicitly OFFLINE and no
    //     assigned ride is near T;
    //   - in every other case (nothing logged around T, some driver last seen
    //     online, or rides that contradict "nobody was online") it is unobserved.
    // `roster` is an array of driver entries, or null (demo data, where every
    // simulated driver is eligible).
    function reconstructAvailability({ events, samples, bookings, roster, hourStarts }) {
        const stats = {
            eventsRecognised: 0, eventsUnrecognised: 0, eventsDuplicate: 0,
            driverHoursStale: 0, driverHoursIneligible: 0, driverHoursEligibilityUnknown: 0,
            driverHoursStatusUnknown: 0, driverHoursOpenRide: 0, driverHoursUnplaced: 0, driverHoursCounted: 0,
            hoursObserved: 0, hoursObservedKnownOffline: 0, hoursUnobserved: 0
        };
        const rosterMap = roster ? new Map(roster.map((d) => [d.id, d])) : null;
        const drivers = new Map();
        const slot = (id) => { if (!drivers.has(id)) drivers.set(id, { events: [], pings: [], rides: [] }); return drivers.get(id); };
        const allTimes = [];

        (events || []).forEach((e) => {
            if (!e.driverId || !Number.isFinite(e.ms)) return;
            allTimes.push(e.ms);
            const status = String(e.status || '').toUpperCase();
            if (!(status in STATUS_RANK)) { stats.eventsUnrecognised += 1; }
            else { stats.eventsRecognised += 1; slot(e.driverId).events.push({ ms: e.ms, status }); }
            // An event that carries a position is also evidence of where they were.
            if (e.barangay) slot(e.driverId).pings.push({ ms: e.ms, barangay: e.barangay });
        });
        (samples || []).forEach((s) => {
            if (!s.driverId || !Number.isFinite(s.ms)) return;
            allTimes.push(s.ms);
            slot(s.driverId).pings.push({ ms: s.ms, barangay: s.barangay || null });
        });
        allTimes.sort((a, b) => a - b);
        const rides = buildRideWindows(bookings);
        const rideStarts = [];
        rides.byDriver.forEach((windows, id) => {
            if (drivers.has(id)) drivers.get(id).rides = windows;
            windows.forEach(([start, end]) => rideStarts.push([start, end]));
        });
        rideStarts.sort((a, b) => a[0] - b[0]);
        const rideStartMs = rideStarts.map((r) => r[0]);

        drivers.forEach((d) => {
            // ms ascending; at the same instant the LAST item wins, so order
            // ties ONLINE/AVAILABLE, BUSY, OFFLINE (OFFLINE last = conservative).
            d.events.sort((a, b) => (a.ms - b.ms) || (STATUS_RANK[b.status] - STATUS_RANK[a.status]));
            const unique = [];
            d.events.forEach((e) => {
                const prev = unique[unique.length - 1];
                if (prev && prev.ms === e.ms && prev.status === e.status) { stats.eventsDuplicate += 1; return; }
                unique.push(e);
            });
            d.events = unique;
            d.pings.sort((a, b) => a.ms - b.ms);
        });

        const W = CONFIG.observationWindowHours * HOUR_MS;
        const recordNear = (T) => {
            const i = firstAtOrAfter(allTimes, T - W);
            return i < allTimes.length && allTimes[i] <= T + W;
        };
        const rideNear = (T) => {
            let i = firstAtOrAfter(rideStartMs, T - W - MAX_BUSY_MS);
            for (; i < rideStarts.length && rideStarts[i][0] <= T + W; i += 1) {
                if (rideStarts[i][1] >= T - W) return true;
            }
            return false;
        };

        const counts = new Map();
        const observed = new Set();
        hourStarts.forEach((T) => {
            let anyKnown = false;
            let allKnownOffline = true;
            let uncertain = false;
            const here = [];
            let staleHere = 0;
            let ineligibleHere = 0;
            drivers.forEach((d, id) => {
                const pi = lastAtOrBefore(d.pings, T);
                const fresh = pi >= 0 && T - d.pings[pi].ms <= FRESH_PING_MS;
                const ei = lastAtOrBefore(d.events, T);
                if (ei < 0) {
                    // Seen pinging, but no status is known for them: they might be available.
                    if (fresh) { uncertain = true; stats.driverHoursStatusUnknown += 1; }
                    return;
                }
                anyKnown = true;
                const status = d.events[ei].status;
                if (status === 'OFFLINE') return;
                allKnownOffline = false;
                if (!fresh) { staleHere += 1; return; }
                const onRide = status === 'BUSY' || d.rides.some(([start, end, open]) => !open && start <= T && T < end);
                if (onRide) return;
                // an accepted ride with no recorded drop-off might still be running
                if (d.rides.some(([start, end, open]) => open && start <= T && T < end)) { uncertain = true; stats.driverHoursOpenRide += 1; return; }
                const elig = rosterMap ? eligibilityAt(rosterMap.get(id), T) : 'eligible';
                if (elig === 'ineligible') { ineligibleHere += 1; return; }
                if (elig === 'unknown') { uncertain = true; stats.driverHoursEligibilityUnknown += 1; return; }
                const barangay = d.pings[pi].barangay;
                if (!barangay) { uncertain = true; stats.driverHoursUnplaced += 1; return; }
                here.push(barangay);
            });
            const alive = recordNear(T);
            let isObserved = false;
            let viaOffline = false;
            if (!uncertain) {
                if (alive) isObserved = true;
                else if (anyKnown && allKnownOffline && !rideNear(T)) { isObserved = true; viaOffline = true; }
            }
            if (!isObserved) { stats.hoursUnobserved += 1; return; }
            stats.hoursObserved += 1;
            if (viaOffline) stats.hoursObservedKnownOffline += 1;
            stats.driverHoursStale += staleHere;
            stats.driverHoursIneligible += ineligibleHere;
            observed.add(T);
            const parts = manilaParts(T);
            const hk = hourKey(parts.dateKey, parts.hour);
            here.forEach((barangay) => {
                const key = `${barangay}|${hk}`;
                counts.set(key, (counts.get(key) || 0) + 1);
                stats.driverHoursCounted += 1;
            });
        });
        return { counts, observed, stats, rideStats: rides.stats, driverCount: drivers.size };
    }

    // ── Step 4: one row per (barangay, hour) ───────────────────────────
    // Model A: a day counts as COVERED (the booking system was running) when a
    // booking request or any driver log exists that day. A target that is not
    // covered/observed is null on the row, never 0.
    function coveredDaysOf(requests, samples, events) {
        const days = new Set();
        const mark = (ms) => { if (Number.isFinite(ms)) days.add(manilaParts(ms).dateKey); };
        (requests || []).forEach((r) => mark(r.ms));
        (samples || []).forEach((r) => mark(r.ms));
        (events || []).forEach((r) => mark(r.ms));
        return days;
    }

    function buildTrainingRows(demand, availability, areas, demandDays, env, startMs, endMs) {
        const rows = [];
        const skipped = { missingEnvironment: 0, noTargetObserved: 0, tideDates: new Set() };
        const hourStarts = [];
        const hourOf = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
        for (let t = hourOf(startMs); t <= endMs; t += HOUR_MS) hourStarts.push(t);

        hourStarts.forEach((hourMs) => {
            const parts = manilaParts(hourMs);
            const demandSeen = demandDays.has(parts.dateKey);
            const availabilitySeen = Boolean(availability && availability.observed.has(hourMs));
            if (!demandSeen && !availabilitySeen) { skipped.noTargetObserved += 1; return; }
            const environment = environmentFor(env, parts.dateKey, parts.hour);
            const key = hourKey(parts.dateKey, parts.hour);
            areas.forEach((area) => {
                if (!environment.ok) { skipped.missingEnvironment += 1; return; }
                if (!environment.tideOk) skipped.tideDates.add(parts.dateKey);
                rows.push({
                    area, dateKey: parts.dateKey, hour: parts.hour, dow: dayOfWeekOf(parts.dateKey), hourMs,
                    requests: demandSeen ? (demand.counts.get(`${area}|${key}`) || 0) : null,
                    available: availabilitySeen ? (availability.counts.get(`${area}|${key}`) || 0) : null,
                    rainfallMm: environment.rainfallMm,
                    tideOk: environment.tideOk,
                    tideM: environment.tideM,
                    riskLevel: environment.riskLevel,
                    riskLevelNoTide: environment.riskLevelNoTide
                });
            });
        });
        return { rows, skipped, hourStarts };
    }

    // ── Step 5: feature coding ─────────────────────────────────────────
    // Hour of day, day of week and barangay are categorical, so each is one-hot
    // encoded (one 0/1 column per category, the first category - 00:00, Monday,
    // the first barangay - is the dropped baseline). Rainfall, high-water risk
    // and (when the model has it) tide stay numeric.
    // tideMode 'with_tide' has the tide height and the risk level that includes
    // the tide factor; 'no_tide' has neither tide height nor the tide factor.
    const HOURS = Array.from({ length: 24 }, (_, h) => h);
    const DAYS = [0, 1, 2, 3, 4, 5, 6];

    function featureNames(areas, tideMode) {
        const withTide = (tideMode || 'with_tide') === 'with_tide';
        return [
            ...HOURS.slice(1).map((h) => `hour:${h}`),
            ...DAYS.slice(1).map((d) => `dow:${d}`),
            ...areas.slice(1).map((area) => `area:${area}`),
            'history_mean',
            'rainfall_mm',
            ...(withTide ? ['tide_height_m'] : [])
        ];
    }

    function encodeInput(input, areas, tideMode) {
        const withTide = (tideMode || 'with_tide') === 'with_tide';
        return [
            ...HOURS.slice(1).map((h) => (input.hour === h ? 1 : 0)),
            ...DAYS.slice(1).map((d) => (input.dow === d ? 1 : 0)),
            ...areas.slice(1).map((area) => (input.area === area ? 1 : 0)),
            input.histMean,
            input.rainfallMm,
            ...(withTide ? [input.tideM] : [])
        ];
    }

    // A training row as the input the model of that tide mode would be given.
    function inputFromRow(row, tideMode) {
        return {
            hour: row.hour, dow: row.dow, area: row.area, histMean: row._hist, rainfallMm: row.rainfallMm,
            tideM: row.tideM
        };
    }

    // The model input for a forecast from an environmentFor result: only what
    // the model was trained on. A model that uses tide REFUSES a forecast when
    // tide is missing; it never substitutes a value.
    function inputFor(model, environment, base) {
        const mode = model.tideMode || 'with_tide';
        if (!environment || !environment.ok) throw new Error(`Weather inputs are missing (${((environment && environment.issues) || ['no data']).join('; ')}), so no forecast is made.`);
        const input = { ...base, rainfallMm: environment.rainfallMm };
        if (mode === 'with_tide') {
            if (!environment.tideOk) throw new Error(`This model uses tide data, which is missing for that hour (${(environment.tideIssues || []).join('; ')}), so no forecast is made.`);
            input.tideM = environment.tideM;
        }
        return input;
    }

    // The outcome added up over all barangays for each hour.
    function townTotals(rows, outcome) {
        const totals = new Map();
        rows.forEach((row) => {
            totals.set(row.hourMs, (totals.get(row.hourMs) || 0) + row[outcome]);
        });
        return [...totals.values()];
    }

    function readinessOf(days) {
        if (days < CONFIG.minTrainingDays) return { tier: 'INSUFFICIENT', label: `Not enough history (${days} of ${CONFIG.minTrainingDays} days)` };
        if (days < CONFIG.preliminaryDays) return { tier: 'EXPLORATORY', label: 'Exploratory: under 3 months of usable data' };
        if (days < CONFIG.extendedDays) return { tier: 'PRELIMINARY', label: 'Preliminary: about 3 to 6 months of usable data' };
        return { tier: 'EXTENDED', label: 'Extended: about six months of usable data (the full window)' };
    }

    // The six-month window a model was asked to cover, and what THIS model's
    // eligible rows actually cover. Nothing is claimed beyond the usable days.
    function coverageOf(rows, win) {
        const hours = [...new Set(rows.map((r) => r.hourMs))].sort((a, b) => a - b);
        const days = new Set(rows.map((r) => r.dateKey)).size;
        const windowDays = Math.round((win.endMs - win.startMs) / (24 * HOUR_MS));
        return {
            windowMonths: win.months,
            windowStartMs: win.startMs,
            windowEndMs: win.endMs,
            windowStartKey: win.startKey,
            windowEndKey: win.endKey,
            windowDays,
            effectiveStartMs: win.effectiveStartMs,
            earliestEligibleMs: hours.length ? hours[0] : null,
            latestEligibleMs: hours.length ? hours[hours.length - 1] : null,
            usableHours: hours.length,
            usableDays: days,
            usableRows: rows.length,
            daysShare: windowDays ? days / windowDays : 0,
            coversSixMonths: windowDays > 0 && days >= 0.9 * windowDays
        };
    }

    const isoDate = (ms) => manilaParts(ms).dateKey;

    // How well the "likely range" holds up. The range is calibrated on the FIRST
    // half of the held-out hours and its coverage is measured on the SECOND half
    // (hours it was not calibrated on). Returns null when there are too few hours.
    function validateInterval(testRows, predicted, outcome, level) {
        const hours = [...new Set(testRows.map((r) => r.hourMs))].sort((a, b) => a - b);
        if (hours.length < 48) return null;
        const cut = hours[Math.floor(hours.length / 2)];
        const calib = [];
        const check = [];
        testRows.forEach((r, k) => { (r.hourMs < cut ? calib : check).push({ a: r[outcome], p: predicted[k], hourMs: r.hourMs }); });
        const measure = (calibRows, checkRows) => {
            const interval = residualInterval(calibRows.map((r) => r.a), calibRows.map((r) => r.p), level);
            if (!interval || !checkRows.length) return null;
            const hit = checkRows.filter((r) => r.a >= Math.max(0, r.p + interval.lo) - 1e-9 && r.a <= r.p + interval.hi + 1e-9).length;
            return { nominal: level, observed: hit / checkRows.length, n: checkRows.length, calibrationRows: calibRows.length };
        };
        const total = (rowsIn) => {
            const m = new Map();
            rowsIn.forEach((r) => { const t = m.get(r.hourMs) || { a: 0, p: 0, hourMs: r.hourMs }; t.a += r.a; t.p += r.p; m.set(r.hourMs, t); });
            return [...m.values()];
        };
        return { perBarangay: measure(calib, check), allTown: measure(total(calib), total(check)) };
    }

    function intervalStatus(v) {
        if (!v) return 'unvalidated';
        if (v.observed < CONFIG.intervalHideBelow) return 'hidden';
        if (v.n >= CONFIG.intervalMinCoverageRows && Math.abs(v.observed - v.nominal) <= CONFIG.intervalCoverageTolerance) return 'validated';
        return 'heuristic';
    }

    // ── Step 6: evaluation, then the final fit, for ONE target ─────────
    //  1. split the hours in time order (all barangays of an hour stay together)
    //  2. fit a trial model on the earlier hours ONLY and score it on the later
    //     hours, next to a hour-of-week average baseline and a Poisson comparison
    //  3. thresholds and the range come from the training part / test errors only
    //  4. refit the same model on ALL eligible rows: these are the coefficients
    //     that are saved. The scores describe the trial model, not this refit.
    function fitModel(allRows, areas, targetDef, ctx) {
        const outcome = targetDef.outcome;
        const tideMode = ctx.tideMode || 'with_tide';
        const rows = allRows.filter((r) => Number.isFinite(r[outcome]) && (tideMode !== 'with_tide' || r.tideOk));
        const names = featureNames(areas, tideMode);
        const enc = (row) => encodeInput(inputFromRow(row, tideMode), areas, tideMode);
        // History predictor: the mean of the target for the same barangay, day of
        // week and hour, learned from the training partition ONLY. A training row's
        // own value is left out of its own mean (leave-one-out), so the predictor
        // never contains the answer it is meant to explain. Rows without enough
        // history are left out and counted, never given a made-up value.
        const profileKey = (r) => `${r.area}|${r.dow}|${r.hour}`;
        const buildProfile = (set) => {
            const m = new Map();
            set.forEach((r) => { const k = profileKey(r); const e = m.get(k) || { sum: 0, n: 0 }; e.sum += r[outcome]; e.n += 1; m.set(k, e); });
            return m;
        };
        const histOf = (r, profile, loo) => {
            const e = profile.get(profileKey(r));
            if (!e) return NaN;
            if (loo) { const n = e.n - 1; return n >= CONFIG.minHistoryObservations ? (e.sum - r[outcome]) / n : NaN; }
            return e.n >= CONFIG.minHistoryObservations ? e.sum / e.n : NaN;
        };
        const withHist = (set, profile, loo) => {
            const out = [];
            set.forEach((r) => { const h = histOf(r, profile, loo); if (Number.isFinite(h)) out.push({ ...r, _hist: h }); });
            return out;
        };
        const dayCount = new Set(rows.map((r) => r.dateKey)).size;
        const minRows = minRowsFor(names.length);
        if (dayCount < CONFIG.minTrainingDays || rows.length < minRows) {
            throw new Error(`${targetDef.title}: not enough observed data (${dayCount} day${dayCount === 1 ? '' : 's'} and ${rows.length} records; at least ${CONFIG.minTrainingDays} days and ${minRows} records are needed).`);
        }

        const rawWith = (fit) => (row) => {
            const vector = enc(row);
            let value = fit.intercept;
            names.forEach((name, j) => { value += (fit.coefficients[name] || 0) * vector[j]; });
            return value;
        };
        const predictWith = (fit) => { const f = rawWith(fit); return (row) => Math.max(0, f(row)); };
        // A one-hot group needs a reference category that actually occurs. If the
        // usual one (hour 0, Monday, the first barangay) never occurs in these rows
        // (for example no driver data is observed at 12 AM), the group's columns
        // would add up to the intercept and the fit would be singular; so the
        // most common observed category becomes the reference instead (its
        // coefficient is 0 and the others are relative to it).
        const referenceExclusions = (trainRows) => {
            const out = [];
            const pick = (counts, usual, label) => {
                if (counts.has(usual)) return;
                const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
                if (best) out.push(`${label}${best[0]}`);
            };
            const tally = (fn) => { const m = new Map(); trainRows.forEach((r) => m.set(fn(r), (m.get(fn(r)) || 0) + 1)); return m; };
            pick(tally((r) => r.hour), 0, 'hour:');
            pick(tally((r) => r.dow), 0, 'dow:');
            const byArea = tally((r) => r.area);
            if (!byArea.has(areas[0])) { const best = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0]; if (best) out.push(`area:${best[0]}`); }
            return out.filter((n) => names.includes(n));
        };
        const subsetFor = (trainRows) => {
            const excluded = referenceExclusions(trainRows);
            const keep = names.map((n, j) => j).filter((j) => !excluded.includes(names[j]));
            const keepNames = keep.map((j) => names[j]);
            const X = trainRows.map((r) => { const v = enc(r); return keep.map((j) => v[j]); });
            return { excluded, keepNames, X, y: trainRows.map((r) => r[outcome]) };
        };
        const expand = (fit, sub) => {
            const coefficients = {};
            names.forEach((n) => { coefficients[n] = 0; });
            sub.keepNames.forEach((n) => { coefficients[n] = fit.coefficients[n] || 0; });
            return { intercept: fit.intercept, coefficients, dropped: [...(fit.dropped || [])], excluded: sub.excluded, rank: fit.rank, method: fit.method };
        };
        const fitOn = (trainRows) => { const sub = subsetFor(trainRows); return expand(fitOLS(sub.X, sub.y, sub.keepNames), sub); };

        const split = timeSplit(rows);
        let evaluation = {
            performed: false,
            reason: `Fewer than ${CONFIG.minEvaluationDays} days of data, so no later period could be held out. The model is NOT evaluated.`,
            method: 'none'
        };
        let thresholdRows = rows;
        let interval = null;
        let intervalAll = null;
        let intervalCheck = null;
        const testPoints = [];
        let metricsCompat = null;
        let totalMae = null;

        if (split) {
            const trainRaw = split.train.map((i) => rows[i]);
            const testRaw = split.test.map((i) => rows[i]);
            thresholdRows = trainRaw; // P33 / P67 come from the whole training partition
            const trainProfile = buildProfile(trainRaw);
            const trainRows = withHist(trainRaw, trainProfile, true);
            const testRows = withHist(testRaw, trainProfile, false);
            if (trainRows.length < minRows || !testRows.length) {
                throw new Error(`${targetDef.title}: too few rows have enough history (at least ${CONFIG.minHistoryObservations} earlier observations of the same barangay, weekday and hour) to train and test.`);
            }
            const trial = fitOn(trainRows);
            const trialPredict = predictWith(trial);
            const actual = testRows.map((r) => r[outcome]);
            const rawPredicted = testRows.map(rawWith(trial));
            const rawBelowZero = rawPredicted.filter((v) => v < 0).length;
            const predicted = testRows.map(trialPredict);
            const baselineFn = hourOfWeekBaseline(trainRows, outcome);
            // The headline scores use the RAW linear predictions (clipping would
            // hide part of the model's error); the clipped scores are shown next to them.
            const model = computeMetrics(actual, rawPredicted);
            const modelClipped = computeMetrics(actual, predicted);
            const baseline = computeMetrics(actual, testRows.map(baselineFn));

            let poisson = null;
            const subT = subsetFor(trainRows);
            const pRaw = fitPoisson(subT.X, subT.y, subT.keepNames);
            const pFit = pRaw ? expand(pRaw, subT) : null;
            if (pFit) poisson = computeMetrics(actual, testRows.map((r) => poissonPredict(pFit, names, enc(r))));
            const trainMean = trainRows.reduce((s, r) => s + r[outcome], 0) / trainRows.length;
            const trainVar = trainRows.reduce((s, r) => s + (r[outcome] - trainMean) ** 2, 0) / trainRows.length;

            interval = residualInterval(actual, predicted, CONFIG.predictionIntervalLevel);
            const hourly = new Map();
            testRows.forEach((r, k) => {
                const t = hourly.get(r.hourMs) || { a: 0, p: 0 };
                t.a += actual[k];
                t.p += predicted[k];
                hourly.set(r.hourMs, t);
            });
            const totals = [...hourly.values()];
            totalMae = totals.reduce((sum, t) => sum + Math.abs(t.a - t.p), 0) / totals.length; // average miss of the all-barangay hourly total
            intervalAll = residualInterval(totals.map((t) => t.a), totals.map((t) => t.p), CONFIG.predictionIntervalLevel);
            const iv = validateInterval(testRows, predicted, outcome, CONFIG.predictionIntervalLevel);
            intervalCheck = iv ? { perBarangay: iv.perBarangay, allTown: iv.allTown } : null;

            const folds = rollingOrigin(rows, outcome, (tr) => {
                const prof = buildProfile(tr);
                const trH = withHist(tr, prof, true);
                if (trH.length < minRows) return null;
                const predictor = predictWith(fitOn(trH));
                const fallback = trH.reduce((a, r) => a + r[outcome], 0) / trH.length;
                return (r) => { const h = histOf(r, prof, false); return Number.isFinite(h) ? predictor({ ...r, _hist: h }) : fallback; };
            });

            const stride = Math.max(1, Math.ceil(testRows.length / 300));
            for (let i = 0; i < testRows.length; i += stride) testPoints.push({ a: actual[i], p: Number(predicted[i].toFixed(3)) });

            evaluation = {
                performed: true,
                method: `Chronological hold-out by hour: the earlier hours train a trial model, ${split.gapHours} hours are skipped, the latest ${Math.round(CONFIG.testShare * 100)}% of hours test it. All barangays of one hour stay on the same side.`,
                trainFrom: isoDate(split.trainFrom), trainTo: isoDate(split.trainTo),
                testFrom: isoDate(split.testFrom), testTo: isoDate(split.testTo),
                gapHours: split.gapHours,
                trainRows: trainRows.length, testRows: testRows.length,
                model, modelClipped, baseline, poisson,
                scoredOn: 'raw linear predictions (before clipping at 0 and rounding)',
                beatsBaseline: model.mae != null && baseline.mae != null ? model.mae < baseline.mae : null,
                targetMean: trainMean, targetVariance: trainVar,
                clippedShare: rawBelowZero / testRows.length,
                totalMae,
                rawNegativeCount: rawBelowZero,
                rolling: folds ? folds.map((f) => ({
                    from: isoDate(f.testFrom), to: isoDate(f.testTo), trainRows: f.trainRows, testRows: f.testRows,
                    model: f.model, baseline: f.baseline
                })) : null,
                rollingScoredOn: 'clipped predictions',
                rollingNote: folds ? '' : `Rolling-origin evaluation needs at least ${CONFIG.rollingMinDays} days of history, so it was not performed.`,
                note: 'These scores describe the trial model fitted on the earlier hours. The saved model is refitted on all eligible rows, so the test hours are no longer an independent test set for it.'
            };
            metricsCompat = {
                records: rows.length, trainRecords: trainRows.length, testRecords: testRows.length, inSample: false,
                r2: model.r2, mae: model.mae, rmse: model.rmse
            };
        }

        // The model that is saved and used.
        const profileAll = buildProfile(rows);
        const finalRows = withHist(rows, profileAll, true);
        if (finalRows.length < minRows) throw new Error(`${targetDef.title}: too few rows have enough history to fit the model.`);
        const fit = fitOn(finalRows);
        const profile = {};
        profileAll.forEach((e, k) => { profile[k] = { mean: e.sum / e.n, n: e.n }; });
        // The latest 8 ACTUAL values of each barangay / weekday / hour, so the page can
        // show the forecast next to what really happened at that weekday and hour.
        rows.slice().sort((a, b) => a.hourMs - b.hourMs).forEach((r) => {
            const entry = profile[profileKey(r)];
            if (!entry) return;
            if (!entry.recent) entry.recent = [];
            entry.recent.push({ d: r.dateKey, v: r[outcome] }); // objects, not pairs: Firestore does not store arrays inside arrays
            if (entry.recent.length > 8) entry.recent.shift();
        });
        const parameterCount = names.length + 1 - fit.dropped.length - fit.excluded.length;
        const perParameter = finalRows.length / Math.max(1, parameterCount);
        // Variance inflation factor of each numeric predictor: 1 / (1 - R^2) when it
        // is regressed on every other predictor (QR again, no inverse).
        const vif = {};
        const numericNames = names.filter((n) => !/^(hour|dow|area):/.test(n));
        const encodedRows = finalRows.map(enc);
        numericNames.forEach((name) => {
            const target = names.indexOf(name);
            const others = names.map((n, j) => j).filter((j) => j !== target);
            try {
                const Xo = encodedRows.map((v) => others.map((j) => v[j]));
                const yo = encodedRows.map((v) => v[target]);
                const f = fitOLS(Xo, yo, others.map((j) => names[j]));
                const mean = yo.reduce((a, b) => a + b, 0) / yo.length;
                let ssRes = 0;
                let ssTot = 0;
                Xo.forEach((x, i) => {
                    let pred = f.intercept;
                    others.forEach((j, k) => { pred += (f.coefficients[names[j]] || 0) * x[k]; });
                    ssRes += (yo[i] - pred) ** 2;
                    ssTot += (yo[i] - mean) ** 2;
                });
                const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
                vif[name] = r2 >= 1 - 1e-9 ? Infinity : 1 / (1 - r2);
            } catch (e) { vif[name] = null; }
        });
        const adequacy = {
            observations: finalRows.length,
            rowsWithoutHistory: rows.length - finalRows.length,
            parameters: parameterCount,
            observationsPerParameter: perParameter,
            thin: perParameter < CONFIG.minObservationsPerParameter,
            vif,
            collinear: Object.keys(vif).filter((k) => vif[k] === Infinity || (vif[k] != null && vif[k] > CONFIG.vifWarnAbove)),
            rank: fit.rank,
            method: fit.method
        };
        const ranges = {};
        const rangeOf = (name, values) => {
            let min = Infinity;
            let max = -Infinity;
            values.forEach((v) => { if (v < min) min = v; if (v > max) max = v; });
            ranges[name] = { min, max };
        };
        rangeOf('history_mean', finalRows.map((r) => r._hist));
        rangeOf('rainfall_mm', rows.map((r) => r.rainfallMm));
        if (tideMode === 'with_tide') rangeOf('tide_height_m', rows.map((r) => r.tideM));

        // Horizons the evaluation can speak for: only when training used archived
        // FORECASTS of the target-hour rainfall (the same kind of input a forecast
        // issued shortly before the hour uses). With observed rainfall nothing is
        // evaluated at any lead.
        const usedForecasts = String(ctx.rainSource || '').startsWith('archived forecasts');
        const evaluatedHoursAhead = evaluation.performed && usedForecasts ? CONFIG.validatedHorizonHours : 0;
        const trainedAt = ctx.nowMs;
        // Is this model fit to be shown as a forecast? It is a status, not a score.
        const validityReasons = [];
        if (!evaluation.performed) validityReasons.push('it was not evaluated on a later period');
        else if (evaluation.beatsBaseline === false) validityReasons.push('it did not beat the simple hour-of-week average on the held-out hours');
        if (dayCount < CONFIG.preliminaryDays) validityReasons.push(`only ${dayCount} days of usable data (under ${CONFIG.preliminaryDays} is exploratory)`);
        if (finalRows.length / Math.max(1, parameterCount) < CONFIG.minObservationsPerParameter) validityReasons.push('too few observations per fitted parameter');
        const validity = {
            status: !evaluation.performed ? 'UNVALIDATED' : (validityReasons.length ? 'EXPLORATORY' : 'VALIDATED'),
            reasons: validityReasons
        };
        const rangeStatus = interval ? intervalStatus(intervalCheck && intervalCheck.perBarangay) : 'unvalidated';
        const rangeStatusAll = intervalAll ? intervalStatus(intervalCheck && intervalCheck.allTown) : 'unvalidated';
        return {
            schema: MODEL_SCHEMA,
            implementationVersion: IMPLEMENTATION_VERSION,
            modelId: `${targetDef.key}-${trainedAt}`,
            kind: targetDef.key,
            dataSource: ctx.dataSource,
            estimation: fit.method || 'Householder QR with column pivoting',
            adequacy,
            provenance: ctx.provenance,
            schemaVerified: Boolean(ctx.provenance && ctx.provenance.schemaVerified),
            target: targetDef.target,
            label: targetDef.title,
            unit: targetDef.unit,
            targetDefinition: targetDef.definition,
            tideMode,
            tideCoverage: ctx.tideCoverage,
            features: names,
            intercept: fit.intercept,
            coefficients: fit.coefficients,
            dropped: fit.dropped,
            referenceCategories: fit.excluded,
            areas,
            areaBaseline: areas[0],
            trainedHours: [...new Set(rows.map((r) => r.hour))].sort((a, b) => a - b),
            encoding: {
                hour: 'one-hot, columns hour:1 to hour:23, baseline hour 0 (12:00 AM)',
                dow: 'one-hot, columns dow:1 to dow:6, baseline 0 (Monday)',
                area: `one-hot, one column per barangay except the baseline ${areas[0]}`,
                numeric: tideMode === 'with_tide' ? 'rainfall_mm and tide_height_m are used as numbers' : 'rainfall_mm is used as a number; there is NO tide predictor'
            },
            ranges,
            profile,
            historyFeature: `history_mean = mean of the target for the same barangay, day of week and hour over the training window (leave-one-out for training rows; at least ${CONFIG.minHistoryObservations} observations; learned from the training partition only for the hold-out scores)`,
            validity,
            windowStart: ctx.windowStart,
            windowEnd: ctx.windowEnd,
            windowDays: dayCount,
            coverage: coverageOf(rows, ctx.window),
            usableRows: rows.length,
            areaCount: areas.length,
            readiness: readinessOf(dayCount),
            evaluation,
            metrics: metricsCompat,
            supportedHorizons: {
                evaluatedHoursAhead,
                validatedHoursAhead: evaluatedHoursAhead, // same value, name kept for readers of earlier models
                basis: evaluatedHoursAhead
                    ? 'Training used archived forecasts of the target-hour rainfall and only information known when a forecast is issued. The evaluation therefore matches a short-lead forecast; the provider does not document the exact lead of its archived series, and no per-lead error was measured.'
                    : 'Nothing was evaluated at any forecast lead.',
                note: `Hours after the first of the next ${CONFIG.maxForecastHours} are EXPERIMENTAL: their rainfall inputs are longer-lead forecasts than any the evaluation used.`
            },
            postProcessing: 'The raw linear prediction is always kept. For display it is clipped at 0 (a count cannot be negative) and rounded to a whole number; the LOW / MODERATE / HIGH label is taken from that displayed whole number against the stored P33 and P67. The headline hold-out scores use the RAW predictions.',
            thresholds: percentileThresholds(thresholdRows.map((r) => r[outcome])),
            thresholdsAll: percentileThresholds(townTotals(thresholdRows, outcome)),
            thresholdsSource: split ? 'the training partition only (the earlier hours, never the hold-out hours)' : 'all rows (no hold-out was possible, so the labels are not independent of the data)',
            interval: interval ? { ...interval, status: rangeStatus, validation: intervalCheck && intervalCheck.perBarangay } : null,
            intervalAll: intervalAll ? { ...intervalAll, status: rangeStatusAll, validation: intervalCheck && intervalCheck.allTown } : null,
            testPoints,
            weather: {
                rainSource: ctx.rainSource,
                tide: tideMode === 'with_tide'
                    ? 'LGU tide bulletin (uploaded Excel, a published prediction table), eased between readings; one station for all of Hagonoy'
                    : 'NOT USED: the tide bulletin did not cover enough of the training hours'
            },
            exclusions: ctx.exclusions,
            warnings: [],
            trainedAt,
            trainedDateKey: manilaParts(trainedAt).dateKey
        };
    }

    // Gives the browser a turn between the heavy steps, so the page stays clickable and its progress text updates.
    const tick = () => (typeof setTimeout === 'function' ? new Promise((resolve) => setTimeout(resolve, 0)) : Promise.resolve());

    // ── The whole training phase ────────────────────────────────────────
    // `raw` (from ParaFirestore.fetchPredictionTrainingData, or the sample
    // generator in tests):
    //   { samples, events, bookings, roster?, tide, truncated?, dataStartMs?,
    //     eventFieldsSeen?, provenance }
    // The batch must come from the approved reader (options.verifyProvenance,
    // default ParaFirestore.isOperationalBatch). Records labelled simulated are
    // accepted only for the unit tests and never produce a valid artifact.
    // Window: the six calendar months ending at the last completed hour
    // (ParaPrediction.trainingWindow). Bookings are filtered to the window before
    // any target is built; driver events and pings may reach back
    // CONFIG.historyLookbackDays earlier, ONLY to know each driver's state at the
    // start of the window (no row is built for those hours).
    async function train(raw, options) {
        const opts = options || {};
        const prov = raw && raw.provenance;
        const simulated = Boolean(prov && prov.source === 'simulated');
        if (opts.labelled && !simulated) throw new Error('Pre-labelled records can only be used when they are labelled simulated.');
        if (!simulated) {
            const verify = opts.verifyProvenance || (window.ParaFirestore && window.ParaFirestore.isOperationalBatch);
            if (typeof verify !== 'function' || !verify(raw) || !prov || prov.source !== 'firestore') {
                throw new Error('Training refused: the records were not read from Firestore by the approved reader, so they cannot be treated as PARA data.');
            }
        }
        const mode = 'FIRESTORE_HISTORY';
        const dataSource = simulated ? 'simulated' : 'firestore';
        const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
        const loadEnv = opts.loadEnvironment || loadEnvironment;
        const onProgress = opts.onProgress || (() => {});

        // The rolling window. A truncated log keeps only its newest stretch, so the
        // usable window starts after where the shortest log starts.
        const win = P.trainingWindow(nowMs);
        const clampMs = Number.isFinite(raw.dataStartMs) ? Date.parse(`${addDays(manilaParts(raw.dataStartMs).dateKey, 1)}T00:00:00+08:00`) : -Infinity;
        win.effectiveStartMs = Math.max(win.startMs, clampMs);
        const lookbackFrom = Math.max(win.lookbackStartMs, clampMs);
        const keepLog = (r) => !Number.isFinite(r.ms) || (r.ms >= lookbackFrom && r.ms < win.endMs);
        const inWindow = (r) => !Number.isFinite(r.ms) || (r.ms >= win.effectiveStartMs && r.ms < win.endMs);

        onProgress('Checking booking requests…'); await tick();
        const allBookings = raw.bookings || [];
        const windowBookings = allBookings.filter(inWindow);
        const prepared = prepareBookings(windowBookings, nowMs);
        prepared.stats.outsideWindow = allBookings.filter((b) => Number.isFinite(b.ms) && !inWindow(b)).length;
        // Rides that started shortly before the window can still occupy a driver
        // inside it, so ride intervals are built from the lookback period too (they
        // are never counted as demand).
        const rideBookings = prepareBookings(allBookings.filter((b) => Number.isFinite(b.ms) && b.ms >= lookbackFrom && b.ms < win.endMs), nowMs).requests;
        let data = { samples: (raw.samples || []).filter(keepLog), events: (raw.events || []).filter(keepLog), bookings: prepared.requests, truncated: raw.truncated };
        let unplaced = { driverLogs: 0, bookings: 0, outsideLogs: 0, outsideBookings: 0 };
        let placement = { recorded: 0, address: 0, geoOnly: 0, recordedUnrecognised: 0 };
        let centroidCount = null;
        // The driver `area` must be a geohash inside Hagonoy before it is used. A value
        // that is not (any other format) is ignored, counted and reported; it is never
        // decoded as if it were one.
        const withArea = data.samples.filter((r) => r.area);
        const areaValid = withArea.filter((r) => P.geohashInHagonoy(r.area)).length;
        const locationFormat = { samplesWithArea: withArea.length, validGeohash: areaValid, share: withArea.length ? areaValid / withArea.length : null };
        if (!opts.labelled && !simulated) {
            const clean = (r) => (r.area && !P.geohashInHagonoy(r.area) ? { ...r, area: '' } : r);
            data = { ...data, samples: data.samples.map(clean), events: data.events.map(clean) };
        }
        if (!opts.labelled) {
            onProgress('Placing driver pings and booking requests in Hagonoy barangays…'); await tick();
            data = assignBarangays({ samples: data.samples, events: data.events, bookings: prepared.requests, truncated: raw.truncated });
            unplaced = data.unplaced;
            placement = data.placement;
            centroidCount = data.centroidCount;
        } else {
            placement = { recorded: prepared.requests.length, address: 0, geoOnly: 0, recordedUnrecognised: 0 };
        }

        const demand = aggregateRequests(data.bookings);
        const demandDays = coveredDaysOf(data.bookings, data.samples, data.events);
        if (!demandDays.size) {
            throw new Error('No booking requests or driver activity were found in this period, so there is nothing to train on.');
        }
        const cellSet = new Set(demand.cells);
        data.samples.forEach((s) => s.barangay && cellSet.add(s.barangay));
        const areas = HAGONOY_BARANGAYS.filter((name) => cellSet.has(name));
        if (!areas.length) throw new Error('No activity could be placed in a covered barangay, so there is nothing to train on.');

        const endMs = win.endMs - 1; // inside the last completed hour
        const windowStartMs = Math.ceil(win.effectiveStartMs / HOUR_MS) * HOUR_MS;
        const first = manilaParts(windowStartMs);
        const last = manilaParts(endMs);

        onProgress('Rebuilding which drivers were available each hour…'); await tick();
        const hourStarts = [];
        for (let t = Math.floor(windowStartMs / HOUR_MS) * HOUR_MS; t <= endMs; t += HOUR_MS) hourStarts.push(t);
        const roster = Array.isArray(raw.roster) ? raw.roster : null;
        const availability = (simulated || roster)
            ? reconstructAvailability({ events: data.events, samples: data.samples, bookings: rideBookings, roster, hourStarts })
            : null;

        const fromKey = addDays(first.dateKey, -CONFIG.baselineDays - 2);
        const toKey = addDays(last.dateKey, CONFIG.dischargeAheadDays + 1);
        onProgress('Loading rainfall and river data from Open-Meteo…'); await tick();
        const env = await loadEnv(fromKey, toKey, nowMs);
        env.tide = indexTide(raw.tide || []);

        onProgress('Building the training table…'); await tick();
        const built = buildTrainingRows(demand, availability, areas, demandDays, env, windowStartMs, endMs);

        // Tide is an OPTIONAL predictor: used only when the bulletin covers enough
        // of the usable hours. Otherwise both models are trained without it and
        // may only be used without it. Nothing is invented for the missing hours.
        const withTarget = built.rows.filter((r) => Number.isFinite(r.requests) || Number.isFinite(r.available));
        const tideCoverage = withTarget.length ? withTarget.filter((r) => r.tideOk).length / withTarget.length : 0;
        const tideMode = tideCoverage >= CONFIG.tideMinCoverage ? 'with_tide' : 'no_tide';
        const tideDateList = [...built.skipped.tideDates].sort();

        const exclusions = {
            bookings: prepared.stats,
            unplaced,
            placement,
            centroidCount,
            locationFormat,
            noTargetObservedHours: built.skipped.noTargetObserved,
            missingWeatherHours: built.skipped.missingEnvironment,
            tide: { mode: tideMode, coverage: tideCoverage, datesWithoutTide: tideDateList.length },
            availability: availability ? { ...availability.stats, rides: availability.rideStats, drivers: availability.driverCount } : null
        };
        const ctx = {
            mode, nowMs, exclusions, tideMode, tideCoverage,
            provenance: simulated ? { source: 'simulated', note: 'generated by sample-data.js (unit tests only)' } : raw.provenance,
            dataSource, window: win,
            rainSource: env.rainSource || (simulated ? 'simulated' : 'unknown'),
            windowStart: win.startKey, windowEnd: win.endKey
        };

        // Each target is built on its own observed rows: a problem with one must
        // not stop the other.
        const models = { availability: null, demand: null };
        const unavailable = {};
        onProgress('Fitting the regression models…'); await tick();
        const tryFit = (key) => {
            try {
                models[key] = fitModel(built.rows, areas, TARGETS[key], ctx);
            } catch (error) {
                unavailable[key] = error.message;
            }
        };
        const placeable = placement.recorded + placement.address + placement.geoOnly;
        if (!simulated && placeable > 0 && placement.geoOnly / placeable > MAX_UNVERIFIED_PLACEMENT_SHARE) {
            unavailable.demand = `${placement.geoOnly} of ${placeable} requests (${Math.round((100 * placement.geoOnly) / placeable)}%) have neither a recorded pickup barangay nor one named in the address, so their barangay would only be a guess. The app needs to record the pickup barangay when a booking is created (see docs/MLR_DATA_SCHEMA.md).`;
        } else {
            tryFit('demand');
        }
        const locationFormatBad = !simulated && !opts.labelled && locationFormat.share != null && locationFormat.share < CONFIG.minLocationFormatShare;
        const statusFieldMissing = !simulated && !(raw.provenance && raw.provenance.statusField);
        if (locationFormatBad) {
            unavailable.availability = `Only ${areaValid} of ${withArea.length} driver location records have an \`area\` that is a valid geohash inside Hagonoy (at least ${(100 * CONFIG.minLocationFormatShare).toFixed(0)}% needed), so driver locations cannot be placed in barangays and the availability model is not built.`;
        } else if (!availability) {
            unavailable.availability = 'The driver roster (approved / suspended drivers) could not be read, so driver eligibility cannot be applied and the availability model is not built.';
        } else if (statusFieldMissing) {
            const seen = (raw.eventFieldsSeen || []).join(', ') || 'none seen';
            unavailable.availability = `The field that holds a driver status event's value is not configured (CONFIG.dataSchema.driverEvents.statusField), so no event has a recognised status and driver availability cannot be reconstructed. Fields seen on the event documents: ${seen}. Use "Check data schema", then set the verified field name.`;
        } else if (availability.stats.eventsRecognised === 0) {
            const seen = (raw.eventFieldsSeen || []).join(', ') || 'none seen';
            unavailable.availability = `No usable driver status events were found (events read: ${availability.stats.eventsUnrecognised}, fields seen on them: ${seen}). Driver availability cannot be reconstructed without ONLINE/AVAILABLE/BUSY/OFFLINE events, so the availability model is not built.`;
        } else {
            await tick();
            tryFit('availability');
        }
        if (!models.demand && !models.availability) {
            throw new Error(`Training did not produce a model. ${[...new Set(Object.values(unavailable))].join(' ')}`);
        }

        // Demand against supply, relative to history. The ratio is booking requests per
        // available driver (the driver count is floored at 1 so an hour with no driver
        // gives the request count). Its P33 / P67 come from the same training
        // partition as the models' own thresholds (per barangay-hour, and for the
        // all-barangay hourly total). It is not a capacity measure: no rides-per-driver
        // figure is assumed.
        if (models.demand && models.availability) {
            const cuts = [models.demand, models.availability].map((m) => (m.evaluation.performed ? m.evaluation.trainTo : null)).filter(Boolean);
            const cutKey = cuts.length ? cuts.sort()[0] : null;
            const usable = built.rows.filter((r) => Number.isFinite(r.requests) && Number.isFinite(r.available) && (!cutKey || r.dateKey <= cutKey));
            if (usable.length >= 100) {
                const town = new Map();
                usable.forEach((r) => { const t = town.get(r.hourMs) || { q: 0, a: 0 }; t.q += r.requests; t.a += r.available; town.set(r.hourMs, t); });
                const balance = {
                    definition: 'predicted booking requests divided by predicted available drivers (the driver count is at least 1)',
                    perBarangayHour: percentileThresholds(usable.map((r) => r.requests / Math.max(r.available, 1))),
                    allBarangays: percentileThresholds([...town.values()].map((t) => t.q / Math.max(t.a, 1))),
                    rows: usable.length,
                    source: cutKey ? `training partition only (dates up to ${cutKey})` : 'all rows (no hold-out was possible)'
                };
                models.demand.balance = balance;
                models.availability.balance = balance;
            }
        }

        const dayKeys = new Set(withTarget.map((r) => r.dateKey));
        const warnings = [];
        warnings.push(`Rainfall source: ${ctx.rainSource}.`);
        warnings.push(`Training window: the six months ${win.startKey} to ${win.endKey}, rolling daily.${win.effectiveStartMs > win.startMs ? ` It starts ${isoDate(win.effectiveStartMs)} because a log was truncated.` : ''}`);
        if (prepared.stats.outsideWindow) warnings.push(`${prepared.stats.outsideWindow.toLocaleString()} booking(s) fell outside the window and were not used.`);
        if (simulated) warnings.push('SIMULATED RECORDS: generated by the program (unit tests only), not recorded by PARA.');
        if (!String(ctx.rainSource).startsWith('archived forecasts')) warnings.push('Training rainfall is what actually fell, but predictions use forecast rainfall, so no forecast horizon was evaluated.');
        if (!simulated) {
            const prov2 = ctx.provenance;
            warnings.push('Records come from Firestore. They are NOT otherwise verified as genuine activity.');
            if (!prov2.schemaVerified) warnings.push('The data fields used here (booking time, driver event status, driver ping location) have NOT been verified against live PARA documents. Treat every result as provisional until they are (docs/MLR_DATA_SCHEMA.md).');
            (prov2.assumptions || []).forEach((a) => warnings.push(`Assumed, not confirmed: ${a}`));
            const seed = prov2.seedIncluded || {};
            const seedTotal = (seed.bookings || 0) + (seed.samples || 0) + (seed.events || 0) + (seed.drivers || 0);
            if (seedTotal) warnings.push(`Note: ${seedTotal.toLocaleString()} of the records used are seeded sample records (isSeed or SEED_ ids): ${seed.bookings || 0} bookings, ${seed.events || 0} status events, ${seed.samples || 0} location samples, ${seed.drivers || 0} drivers. They are treated as ordinary history for now; they are not real activity, so the scores do not show real-world accuracy.`);
            const test = prov2.testAccountExcluded || {};
            const testTotal = (test.bookings || 0) + (test.samples || 0) + (test.events || 0);
            if (testTotal) warnings.push(`${testTotal.toLocaleString()} record(s) of configured test accounts were excluded.`);
        }
        warnings.push(tideMode === 'with_tide'
            ? `Tide predictor included (the tide table covers ${(100 * tideCoverage).toFixed(0)}% of the usable hours).`
            : `NO tide predictor: the tide table covers only ${(100 * tideCoverage).toFixed(0)}% of the usable hours (at least ${(100 * CONFIG.tideMinCoverage).toFixed(0)}% needed). The models were trained, and can only be used, without tide; upload tide data for the missing dates to use it.`);
        Object.keys(unavailable).forEach((key) => warnings.push(`${TARGETS[key].title}: not built. ${unavailable[key]}`));
        const bs = prepared.stats;
        if (bs.missingTimestamp) warnings.push(`${bs.missingTimestamp} booking(s) had no request time and were left out.`);
        if (bs.invalidTimestamp) warnings.push(`${bs.invalidTimestamp} booking(s) had a request time in an unsupported or implausible format and were left out.`);
        if (bs.future) warnings.push(`${bs.future} booking(s) had a request time in the future and were left out.`);
        if (bs.duplicates) warnings.push(`${bs.duplicates} duplicate booking record(s) were counted once.`);
        if (bs.testRecords) warnings.push(`${bs.testRecords} booking(s) marked as test records were left out.`);
        if (bs.joinRequestExpired) warnings.push(`${bs.joinRequestExpired} booking(s) are expired shared-ride join requests; they are counted as requests (confirm this is intended).`);
        if (placement.geoOnly > 0) warnings.push(`${placement.geoOnly.toLocaleString()} booking request(s) have no recorded pickup barangay and none in the address; they are NOT counted, so demand is undercounted by about ${placeable ? Math.round((100 * placement.geoOnly) / placeable) : 0}%.`);
        if (placement.recordedUnrecognised > 0) warnings.push(`${placement.recordedUnrecognised} booking(s) have a pickup-barangay value that is not a Hagonoy barangay name and were treated as not recorded.`);
        if (unplaced.bookings - placement.geoOnly > 0) warnings.push(`${(unplaced.bookings - placement.geoOnly).toLocaleString()} booking request(s) had no pickup location at all and were left out.`);
        if (locationFormat.share != null && locationFormat.share < 1 && !simulated) warnings.push(`${(locationFormat.samplesWithArea - locationFormat.validGeohash).toLocaleString()} of ${locationFormat.samplesWithArea.toLocaleString()} driver location records have an area that is not a valid Hagonoy geohash; they were ignored, not guessed.`);
        if (unplaced.driverLogs > 0) warnings.push(`${unplaced.driverLogs.toLocaleString()} driver ping(s) could not be placed in a barangay (no learned barangay centre near them) and were left out.`);
        if (unplaced.outsideLogs > 0 || unplaced.outsideBookings > 0) warnings.push(`${unplaced.outsideLogs.toLocaleString()} driver pings and ${unplaced.outsideBookings.toLocaleString()} booking requests were in barangays PARA doesn't cover and were left out.`);
        if (raw.truncated) warnings.push(`The activity log was very large, so only its most recent part was loaded; usable data start ${Number.isFinite(raw.dataStartMs) ? isoDate(clampMs) : 'later than usual'}.`);
        if (built.skipped.noTargetObserved > 0) warnings.push(`${built.skipped.noTargetObserved} hour(s) had neither booking nor driver-log coverage; they are unknown, not zero.`);
        if (built.skipped.missingEnvironment > 0) warnings.push(`${built.skipped.missingEnvironment} hour-and-area records were skipped because rainfall or river data was missing for them.`);
        if (availability) {
            const s = availability.stats;
            const total = s.hoursObserved + s.hoursUnobserved;
            warnings.push(`Driver availability was observed for ${s.hoursObserved.toLocaleString()} of ${total.toLocaleString()} hours; the other ${s.hoursUnobserved.toLocaleString()} are unknown (null), not zero.`);
            if (s.eventsUnrecognised > 0) warnings.push(`${s.eventsUnrecognised.toLocaleString()} driver status event(s) had no recognised ONLINE/AVAILABLE/BUSY/OFFLINE value and were ignored.`);
            if (s.driverHoursEligibilityUnknown > 0) warnings.push(`${s.driverHoursEligibilityUnknown.toLocaleString()} driver-hour(s) made an hour unobserved because the driver's eligibility at that time cannot be known (approval or suspension time not stored).`);
            if (s.driverHoursStatusUnknown > 0) warnings.push(`${s.driverHoursStatusUnknown.toLocaleString()} driver-hour(s) made an hour unobserved because the driver was pinging but had no status event.`);
            if (s.driverHoursIneligible > 0) warnings.push(`${s.driverHoursIneligible.toLocaleString()} driver-hour(s) were not counted because the driver was not eligible then.`);
            if (s.driverHoursStale > 0) warnings.push(`${s.driverHoursStale.toLocaleString()} driver-hour(s) were not counted because there was no location ping in the 5 minutes before the hour started.`);
            if (s.driverHoursOpenRide > 0) warnings.push(`${s.driverHoursOpenRide.toLocaleString()} driver-hour(s) made an hour unobserved because the driver had an accepted ride with no recorded drop-off (it may still have been running).`);
            if (s.driverHoursUnplaced > 0) warnings.push(`${s.driverHoursUnplaced.toLocaleString()} driver-hour(s) made an hour unobserved because the ping could not be placed in a barangay.`);
            warnings.push('Driver eligibility looks back using the stored approval and suspension times; suspensions that were lifted earlier are not recorded and cannot be seen.');
        }
        Object.values(models).forEach((m) => {
            if (!m) return;
            if (!m.coverage.coversSixMonths) warnings.push(`${m.label}: only ${m.coverage.usableDays} of the ${m.coverage.windowDays} days (${Math.round(100 * m.coverage.daysShare)}%) in the six-month window had usable records. The model was trained on that shorter coverage, NOT on six months.`);
            if (m.readiness.tier === 'EXPLORATORY') warnings.push(`${m.label}: only ${m.windowDays} days of data, so this model is EXPLORATORY.`);
            if (!m.evaluation.performed) warnings.push(`${m.label}: ${m.evaluation.reason}`);
            else if (m.evaluation.beatsBaseline === false) warnings.push(`${m.label}: the regression did NOT beat the simple hour-of-week average on the held-out hours (MAE ${m.evaluation.model.mae.toFixed(2)} vs ${m.evaluation.baseline.mae.toFixed(2)}).`);
            if (m.evaluation.performed && m.evaluation.rollingNote) warnings.push(`${m.label}: ${m.evaluation.rollingNote}`);
            if (m.referenceCategories && m.referenceCategories.length) warnings.push(`${m.label}: the usual reference category was never observed, so ${m.referenceCategories.join(', ')} is the reference instead.`);
            if (m.dropped.length) warnings.push(`${m.label}: ${m.dropped.join(', ')} did not vary in the data, so ${m.dropped.length === 1 ? 'it was' : 'they were'} left out of the model.`);
            if (m.trainedHours.length < 24) warnings.push(`${m.label}: observed hours of day are ${m.trainedHours.join(', ')} only; other hours cannot be forecast.`);
            if (!m.thresholds.available) warnings.push(`${m.label}: too few training targets to compute P33 / P67 labels.`);
            else if (m.thresholds.note) warnings.push(`${m.label}: ${m.thresholds.note}`);
            if (m.adequacy.thin) warnings.push(`${m.label}: only ${m.adequacy.observationsPerParameter.toFixed(1)} observations per fitted parameter (at least ${CONFIG.minObservationsPerParameter} recommended); the coefficients are unstable.`);
            if (m.adequacy.collinear.length) warnings.push(`${m.label}: ${m.adequacy.collinear.join(', ')} ${m.adequacy.collinear.length === 1 ? 'is' : 'are'} strongly collinear with the other predictors (variance inflation factor above ${CONFIG.vifWarnAbove}), so individual coefficients should not be read on their own.`);
            if (m.evaluation.performed && m.evaluation.rawNegativeCount) warnings.push(`${m.label}: ${m.evaluation.rawNegativeCount} of ${m.evaluation.testRows} held-out raw predictions were below 0 (${(100 * m.evaluation.clippedShare).toFixed(1)}%); they are clipped to 0 for display.`);
        });
        Object.values(models).forEach((m) => { if (m) m.warnings = warnings.slice(); });

        const sumOf = (key) => withTarget.reduce((s, r) => s + (Number.isFinite(r[key]) ? r[key] : 0), 0);
        const countOf = (key) => withTarget.filter((r) => Number.isFinite(r[key])).length;
        const builtModels = Object.values(models).filter(Boolean);
        const earliest = Math.min(...builtModels.map((m) => m.coverage.earliestEligibleMs).filter(Number.isFinite));
        const latest = Math.max(...builtModels.map((m) => m.coverage.latestEligibleMs).filter(Number.isFinite));
        const summary = {
            // the dates the eligible records ACTUALLY cover (not the window asked for)
            from: Number.isFinite(earliest) ? isoDate(earliest) : first.dateKey,
            to: Number.isFinite(latest) ? isoDate(latest) : last.dateKey,
            days: dayKeys.size,
            hours: built.hourStarts.length,
            areas: areas.length,
            records: withTarget.length,
            driverLogs: data.samples.length + data.events.length,
            requests: data.bookings.length,
            meanRequests: countOf('requests') ? sumOf('requests') / countOf('requests') : 0,
            meanAvailable: availability && countOf('available') ? sumOf('available') / countOf('available') : null,
            rainSource: ctx.rainSource,
            tideMode,
            window: { from: win.startKey, to: win.endKey, months: win.months },
            dataSource,
            seedIncluded: !simulated && raw.provenance ? raw.provenance.seedIncluded || null : null,
            coverage: Object.fromEntries(Object.entries(models).filter(([, m]) => m).map(([k, m]) => [k, m.coverage]))
        };
        return { models, summary, warnings, unavailable, exclusions };
    }

    // ── Saved-model checks ─────────────────────────────────────────────
    // A saved model is usable only if it passes every check: current layout,
    // the right mode for where it was loaded from, a consistent feature list
    // and finite numbers. A model that fails is rejected, not guessed at.
    function validateArtifact(model) {
        const problems = [];
        if (!model || typeof model !== 'object') return { ok: false, problems: ['no model'] };
        if (model.schema !== MODEL_SCHEMA) problems.push(`schema ${model.schema} is not the current ${MODEL_SCHEMA}`);
        if (!TIDE_MODES.includes(model.tideMode)) problems.push('tide mode missing');
        if (!Array.isArray(model.areas) || !model.areas.length || !model.areas.every((a) => HAGONOY_BARANGAYS.includes(a))) problems.push('areas missing or not covered barangays');
        if (!Array.isArray(model.features) || !model.features.length) problems.push('feature list missing');
        else if (Array.isArray(model.areas) && TIDE_MODES.includes(model.tideMode)) {
            const expected = featureNames(model.areas, model.tideMode);
            if (expected.length !== model.features.length || expected.some((n, i) => n !== model.features[i])) problems.push('feature order does not match the encoder');
        }
        if (!Number.isFinite(model.intercept)) problems.push('intercept is not a finite number');
        const coefficients = model.coefficients || {};
        if (Array.isArray(model.features) && !model.features.every((n) => Number.isFinite(coefficients[n]))) problems.push('a coefficient is missing or not finite');
        const prov = model.provenance || {};
        if (model.dataSource !== 'firestore' || prov.source !== 'firestore') problems.push('model has no Firestore provenance');
        else if (!prov.batchId) problems.push('model has no training batch id');
        const th = model.thresholds;
        if (!th || typeof th.available !== 'boolean' || (th.available && !(Number.isFinite(th.p33) && Number.isFinite(th.p67) && th.p33 <= th.p67))) problems.push('P33 / P67 thresholds missing or invalid');
        const cov = model.coverage;
        if (!cov || !Number.isFinite(cov.usableDays) || !Number.isFinite(cov.windowDays) || !Number.isFinite(cov.windowStartMs) || !Number.isFinite(cov.usableHours)) problems.push('data-coverage record missing');
        if (!model.modelId || !model.windowStart || !model.windowEnd || !model.trainedAt) problems.push('model metadata missing');
        if (!model.evaluation || typeof model.evaluation.performed !== 'boolean') problems.push('evaluation record missing');
        if (!model.profile || typeof model.profile !== 'object') problems.push('history profile missing');
        if (!model.validity || !['VALIDATED', 'EXPLORATORY', 'UNVALIDATED'].includes(model.validity.status)) problems.push('validity status missing');
        return { ok: problems.length === 0, problems };
    }

    function isCurrent(model) {
        return validateArtifact(model).ok;
    }

    // ── Prediction phase ───────────────────────────────────────────────
    // Y = b0 + b1x1 + b2x2 + ... + bnxn on validated inputs. The raw value is kept;
    // the nonnegative value is only a display rule (a count cannot be negative).
    function checkInput(model, input) {
        if (!input || typeof input !== 'object') throw new Error('No forecast input was given.');
        if (!model.areas.includes(input.area)) throw new Error(`"${input.area}" is not a barangay this model was trained on.`);
        if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new Error('The hour must be a whole number from 0 to 23.');
        if (Array.isArray(model.trainedHours) && !model.trainedHours.includes(input.hour)) throw new Error(`The model has no observations for ${input.hour}:00 and cannot forecast that hour of day.`);
        if (!Number.isInteger(input.dow) || input.dow < 0 || input.dow > 6) throw new Error('The day of week must be a whole number from 0 (Monday) to 6 (Sunday).');
        const needed = ['histMean', 'rainfallMm'];
        if ((model.tideMode || 'with_tide') === 'with_tide') needed.push('tideM');
        needed.forEach((k) => {
            if (typeof input[k] !== 'number' || !Number.isFinite(input[k])) throw new Error(`The ${k} input is missing or not a finite number.`);
        });
    }

    // The mean of this model's target for the same barangay, day of week and hour
    // over its training window (stored in the artifact). Known for any future hour.
    function historyMean(model, area, dow, hour) {
        const entry = model.profile && model.profile[`${area}|${dow}|${hour}`];
        if (!entry || !(entry.n >= CONFIG.minHistoryObservations) || !Number.isFinite(entry.mean)) {
            throw new Error(`${area} has fewer than ${CONFIG.minHistoryObservations} past observations for this day of week and hour, so no forecast is made for it.`);
        }
        return entry.mean;
    }

    function predictDetailed(model, rawInput) {
        const input = rawInput && typeof rawInput === 'object' && rawInput.histMean === undefined && model.profile && model.areas.includes(rawInput.area)
            ? { ...rawInput, histMean: historyMean(model, rawInput.area, rawInput.dow, rawInput.hour) }
            : rawInput;
        checkInput(model, input);
        const vector = encodeInput(input, model.areas, model.tideMode);
        let raw = model.intercept;
        model.features.forEach((name, j) => { raw += model.coefficients[name] * vector[j]; });
        if (!Number.isFinite(raw)) throw new Error('The prediction is not a finite number.');
        return { raw, clipped: raw < 0, nonNegative: Math.max(0, raw), display: Math.round(Math.max(0, raw)) };
    }

    function predict(model, input) {
        return predictDetailed(model, input).nonNegative;
    }

    // The whole set of covered barangays: every barangay's prediction added together.
    function predictAll(model, input) {
        return model.areas.reduce((sum, area) => sum + predict(model, { ...input, area }), 0);
    }

    // A rough range around a prediction: the middle share of the errors the
    // trial model made on its held-out hours, added to the prediction. Its
    // coverage on later hours is measured at training; `status` says whether it
    // held ('validated'), only roughly ('heuristic'), or failed ('hidden'), in
    // which case no range is returned.
    function predictRange(model, input, allTown) {
        const interval = allTown ? model.intervalAll : model.interval;
        if (!interval || interval.status === 'hidden') return null;
        const raw = allTown ? predictAll(model, input) : predict(model, input);
        const value = Math.round(raw);
        return {
            level: interval.level,
            status: interval.status || 'unvalidated',
            observedCoverage: interval.validation ? interval.validation.observed : null,
            checkedRows: interval.validation ? interval.validation.n : 0,
            low: Math.min(value, Math.max(0, Math.round(raw + interval.lo))),
            high: Math.max(value, Math.round(raw + interval.hi))
        };
    }

    // The thresholds that apply to one barangay or to the whole set.
    function thresholdsFor(model, allTown) {
        return allTown ? model.thresholdsAll : model.thresholds;
    }

    // A model is retrained once per Manila day (window ending at the last
    // completed hour), or when its saved copy is not valid.
    function needsRetrain(model, nowMs) {
        return !isCurrent(model) || model.implementationVersion !== IMPLEMENTATION_VERSION || model.trainedDateKey !== manilaParts(nowMs == null ? Date.now() : nowMs).dateKey;
    }

    // The hours that can be selected: the next CONFIG.maxForecastHours whole
    // hours, starting with the next one. This is a forecast, so the hour in
    // progress and past hours are never offered.
    function forecastSlots(nowMs) {
        const now = nowMs == null ? Date.now() : nowMs;
        const base = Math.floor(now / HOUR_MS) * HOUR_MS;
        const slots = [];
        for (let h = 1; h <= CONFIG.maxForecastHours; h += 1) {
            const targetMs = base + h * HOUR_MS;
            const parts = manilaParts(targetMs);
            slots.push({ hoursAhead: h, targetMs, dateKey: parts.dateKey, hour: parts.hour });
        }
        return slots;
    }

    // How far ahead the chosen hour is, and whether the model's evaluation covers
    // that distance. hoursAhead 0 = the hour in progress. `validated` is true only
    // when the model says it was evaluated at least that far ahead.
    function horizonInfo(dateKey, hour, nowMs, model) {
        const now = nowMs == null ? Date.now() : nowMs;
        const [y, m, d] = dateKey.split('-').map(Number);
        const targetMs = Date.UTC(y, m - 1, d, hour) - CONFIG.utcOffsetMs;
        const hoursAhead = Math.round((targetMs - Math.floor(now / HOUR_MS) * HOUR_MS) / HOUR_MS);
        const evaluatedUpTo = model && model.supportedHorizons ? Number(model.supportedHorizons.evaluatedHoursAhead) || 0 : 0;
        return {
            hoursAhead,
            targetMs,
            issuedMs: now,
            evaluatedUpTo,
            validated: evaluatedUpTo > 0 && hoursAhead >= 0 && hoursAhead <= evaluatedUpTo,
            past: hoursAhead < 0
        };
    }

    // Inputs the model never saw (beyond the min/max of its training rows, with
    // a 10% margin).
    function outOfRangeInputs(model, input) {
        const out = [];
        const check = (name, label, value) => {
            const range = model.ranges && model.ranges[name];
            if (!range || !Number.isFinite(value)) return;
            const slack = (range.max - range.min) * 0.1;
            if (value < range.min - slack || value > range.max + slack) out.push(label);
        };
        check('rainfall_mm', 'rainfall', input.rainfallMm);
        check('tide_height_m', 'tide height', input.tideM);
        return out;
    }

    window.ParaForecast = {
        MODEL_SCHEMA,
        IMPLEMENTATION_VERSION,
        MAX_BUSY_MS,
        FRESH_PING_MS,
        MAX_UNVERIFIED_PLACEMENT_SHARE,
        TARGETS,
        prepareBookings,
        assignBarangays,
        aggregateRequests,
        reconstructAvailability,
        eligibilityAt,
        coveredDaysOf,
        buildTrainingRows,
        featureNames,
        encodeInput,
        inputFromRow,
        inputFor,
        readinessOf,
        validateInterval,
        fitModel,
        train,
        validateArtifact,
        isCurrent,
        predictDetailed,
        predict,
        predictAll,
        predictRange,
        thresholdsFor,
        classifyCount,
        needsRetrain,
        forecastSlots,
        historyMean,
        horizonInfo,
        outOfRangeInputs
    };
})();
