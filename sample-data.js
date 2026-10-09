// Sample (dummy) history for the Availability & Demand models.
//
// Used until the app has logged enough real activity. It imagines the app
// running as a small pilot in Hagonoy and simulates it person by person, then
// hands the trainer the same shapes the real Firestore data is turned into
// (driver logs, completed bookings, tide readings), already placed in
// barangays. Nothing here is saved as real data.
//
//   Pilot      - SAMPLE_DRIVERS drivers and SAMPLE_PASSENGERS passengers in the
//                PILOT_BARANGAYS, split evenly between them (the other barangays
//                have no data yet).
//   Drivers    - each has a home barangay, a shift (morning or afternoon start,
//                7-10 hours), two days off a week, and drifts to other barangays
//                part of the time. Fewer come online in heavy rain and at high
//                water.
//   Passengers - each has a home barangay and their own booking habit
//                (1.2-2.6 rides a day), busiest at the morning (market/school) and
//                late-afternoon rushes, quieter on Sundays, a little more in the
//                rain. A ride is only completed if a driver is free; it is picked
//                up in the passenger's barangay most of the time.
//   Tide       - a harmonic model fitted to the real October 2026 readings
//                (about 0.19 ft average error), giving 1-4 high/low tides a day.
//   Rainfall   - real hourly rainfall and river flow for Hagonoy from
//                Open-Meteo (generated only if that service cannot be reached).
// Seeded, so the same sample comes out each time.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    if (!P) return;
    const { HOUR_MS, manilaParts, addDays } = P;

    const SAMPLE_DAYS = 60;
    const SAMPLE_DRIVERS = 18;
    const SAMPLE_PASSENGERS = 36;
    // Where the pilot runs. Edit to change which barangays have sample data.
    const PILOT_BARANGAYS = ['San Isidro', 'San Agustin', 'San Miguel', 'Palapat', 'San Juan', 'Santa Monica'];

    // Share of a day's rides that fall in each hour (0-23).
    const HOUR_SHARE = [1, 1, 1, 1, 2, 5, 9, 10, 8, 6, 5, 5, 5, 5, 5, 6, 8, 9, 7, 5, 3, 2, 1, 1];

    // Tide height (ft) = c + sum of sin/cos terms for the M2, S2, N2, K1 and O1
    // tide cycles; t is hours since 2026-10-10 00:00 Manila time. Fitted to the
    // uploaded October readings.
    const TIDE_ORIGIN_MS = Date.UTC(2026, 9, 10) - 8 * HOUR_MS;
    const TIDE_FIT = {
        c: 1.7541,
        terms: [
            [28.984104, -0.1724, -0.6286],
            [30.0, 0.2463, -0.2176],
            [28.43973, 0.2162, -0.0499],
            [15.041069, 1.0045, 0.0267],
            [13.943035, -0.9767, 0.383]
        ]
    };

    function tideFeet(ms) {
        const t = (ms - TIDE_ORIGIN_MS) / HOUR_MS;
        let value = TIDE_FIT.c;
        TIDE_FIT.terms.forEach(([speed, a, b]) => {
            const angle = speed * Math.PI / 180 * t;
            value += a * Math.cos(angle) + b * Math.sin(angle);
        });
        // A little wider than the October readings (-0.7 to 4.6 ft), so real
        // tides fall inside what the sample-trained models have seen.
        return TIDE_FIT.c + 0.2 + 1.12 * (value - TIDE_FIT.c);
    }

    // The day's high and low tides (the turning points), as a bulletin lists them.
    function tideReadingsForDay(dateKey) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const dayStart = Date.UTC(y, m - 1, d) - 8 * HOUR_MS;
        const step = 5 * 60 * 1000;
        const readings = [];
        let prev = tideFeet(dayStart - step);
        let cur = tideFeet(dayStart);
        for (let ms = dayStart; ms < dayStart + 24 * HOUR_MS; ms += step) {
            const next = tideFeet(ms + step);
            if ((cur > prev && cur >= next) || (cur < prev && cur <= next)) {
                const feet = Number(cur.toFixed(1));
                readings.push({
                    dateKey,
                    minutes: Math.round((ms - dayStart) / 60000),
                    feet,
                    meters: Number((feet * P.CONFIG.feetToMeters).toFixed(3))
                });
            }
            prev = cur;
            cur = next;
        }
        return readings;
    }

    function mulberry(seed) {
        let a = seed >>> 0;
        return () => {
            a += 0x6D2B79F5;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function poisson(mean, random) {
        if (mean <= 0) return 0;
        const limit = Math.exp(-mean);
        let k = 0;
        let p = 1;
        do { k += 1; p *= random(); } while (p > limit);
        return k - 1;
    }

    function pick(list, random) {
        return list[Math.floor(random() * list.length)];
    }

    function dayFactor(dow) {
        return dow === 6 ? 0.7 : (dow === 5 ? 0.9 : 1);
    }

    // Used only if Open-Meteo cannot be reached.
    function syntheticWeather(fromKey, toKey, random) {
        const rain = new Map();
        const discharge = new Map();
        let storm = 0;
        for (let day = fromKey; day <= toKey; day = addDays(day, 1)) {
            discharge.set(day, 80 + random() * 30 + (random() < 0.1 ? 120 : 0));
            for (let h = 0; h < 24; h += 1) {
                storm = storm > 0 ? storm - 1 : (random() < 0.03 ? 2 + Math.floor(random() * 5) : 0);
                rain.set(P.hourKey(day, h), Number((storm > 0 ? random() * 14 : 0).toFixed(2)));
            }
        }
        return { rain, discharge };
    }

    function makeDrivers(random) {
        return Array.from({ length: SAMPLE_DRIVERS }, (_, i) => {
            const morning = random() < 0.55;
            const off = [Math.floor(random() * 7)];
            off.push((off[0] + 2 + Math.floor(random() * 4)) % 7);
            return {
                id: `driver-${String(i + 1).padStart(2, '0')}`,
                home: PILOT_BARANGAYS[i % PILOT_BARANGAYS.length], // spread evenly
                start: morning ? 5 + Math.floor(random() * 4) : 11 + Math.floor(random() * 4),
                length: 7 + Math.floor(random() * 4),
                off
            };
        });
    }

    function makePassengers(random) {
        return Array.from({ length: SAMPLE_PASSENGERS }, (_, i) => ({
            home: PILOT_BARANGAYS[i % PILOT_BARANGAYS.length], // spread evenly
            rate: 1.2 + random() * 1.4 // rides a day (trips to and from school, market, work)
        }));
    }

    function onShift(driver, hour, dow) {
        if (driver.off.includes(dow)) return false;
        return ((hour - driver.start + 24) % 24) < driver.length;
    }

    async function generate(nowMs, days) {
        const random = mulberry(42);
        const span = days || SAMPLE_DAYS;
        const startMs = Math.floor((nowMs - span * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
        const first = manilaParts(startMs).dateKey;
        const last = manilaParts(nowMs).dateKey;
        const fromKey = addDays(first, -P.CONFIG.baselineDays - 1);
        const toKey = addDays(last, P.CONFIG.dischargeAheadDays + 2);

        let env;
        let weatherSource = 'Open-Meteo';
        try {
            env = await P.loadEnvironment(fromKey, toKey, nowMs);
        } catch (error) {
            console.warn('Sample data: weather service unavailable, using generated weather.', error);
            env = syntheticWeather(fromKey, toKey, random);
            weatherSource = 'generated';
        }

        const tide = [];
        for (let day = fromKey; day <= toKey; day = addDays(day, 1)) tide.push(...tideReadingsForDay(day));
        const tideIndex = P.indexTide(tide);

        const drivers = makeDrivers(random);
        const passengers = makePassengers(random);
        const hourShareTotal = HOUR_SHARE.reduce((s, v) => s + v, 0);
        const samples = [];
        const bookings = [];

        for (let t = startMs; t <= nowMs; t += HOUR_MS) {
            const { dateKey, hour, dow } = manilaParts(t);
            const environment = P.environmentFor({ ...env, tide: tideIndex }, dateKey, hour);
            const risk = environment.ok ? environment.riskLevel : 0;
            const rainMm = env.rain.get(P.hourKey(dateKey, hour)) || 0;

            // Who is online this hour, and where.
            const stayHome = (rainMm >= 7.5 ? 0.7 : 1) * (risk >= 2 ? 0.8 : 1);
            const online = [];
            drivers.forEach((driver) => {
                if (!onShift(driver, hour, dow) || random() > 0.95 * stayHome) return;
                online.push({ driver, barangay: random() < 0.85 ? driver.home : pick(PILOT_BARANGAYS, random), rides: 0 });
            });

            // Who wants a ride, and where from.
            const wanted = [];
            passengers.forEach((passenger) => {
                const mean = passenger.rate * (HOUR_SHARE[hour] / hourShareTotal) * dayFactor(dow)
                    * (1 + Math.min(rainMm, 10) * 0.04) * (risk >= 2 ? 0.85 : 1);
                for (let i = poisson(mean, random); i > 0; i -= 1) {
                    wanted.push(random() < 0.85 ? passenger.home : pick(PILOT_BARANGAYS, random));
                }
            });

            // A ride is completed only if a driver with room can take it
            // (preferably one in the same barangay); a driver does at most 2 an hour.
            wanted.forEach((barangay) => {
                const free = online.filter((o) => o.rides < 2);
                if (!free.length) return;
                const local = free.filter((o) => o.barangay === barangay);
                const chosen = pick(local.length ? local : free, random);
                chosen.rides += 1;
                bookings.push({ barangay, ms: t + 20 * 60 * 1000 });
            });

            online.forEach((o) => {
                samples.push({ driverId: o.driver.id, barangay: o.barangay, ms: t + 10 * 60 * 1000, busy: o.rides > 0 });
            });
        }

        return {
            raw: { samples, events: [], bookings, tide },
            loadEnvironment: async () => env,
            weatherSource,
            nowMs
        };
    }

    window.ParaSampleData = {
        SAMPLE_DAYS, SAMPLE_DRIVERS, SAMPLE_PASSENGERS, PILOT_BARANGAYS,
        tideFeet, tideReadingsForDay, generate
    };
})();
