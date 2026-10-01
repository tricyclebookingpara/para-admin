// Driver Availability Forecast
//
// Ports the fitted Multiple Linear Regression model from PARA's
// driver_prediction.py (scikit-learn, trained on data/sample_driver_availability.csv)
// into plain JS so the admin panel can run the same formula without a Python
// backend. Coefficients below are the real fitted values extracted via
// export_model.py — not guessed or hardcoded placeholders.
(function () {
    const MODEL = {
        intercept: 22.98747714399619,
        locations: ['Poblacion', 'San Agustin', 'San Isidro', 'San Juan'],
        locationBaseline: 'Poblacion',
        coefficients: {
            location: {
                'Poblacion': 0.0,
                'San Agustin': -0.6703739534209378,
                'San Isidro': -2.4386655906756793,
                'San Juan': -0.35604221550746196
            },
            hour: -0.12304611758301487,
            rainfall_mm: -0.5124792868019857,
            high_tide_m: -2.4105756392534237,
            high_water_risk: -2.148941305508785
        },
        metrics: {
            mae: 1.1819287194491999,
            rmse: 1.5144351830929361,
            r2: 0.8629459466642921,
            trainingRecords: 160,
            testingRecords: 40
        },
        availabilityThresholds: { low: 6, moderate: 12 },
        highWaterRiskRule: { rainfallMm: 8, highTideM: 1.55 },
        // Real min/max observed in data/sample_driver_availability.csv. Inputs
        // outside these bounds are extrapolation — the model has never seen
        // data out there, so predictions become unreliable past this range.
        trainedRanges: {
            rainfallMm: { min: 0, max: 14.24 },
            highTideM: { min: 0.5, max: 2.0 },
            hour: { min: 6, max: 20 }
        }
    };

    function isWithinTrainedRange(rainfallMm, highTideM, hour) {
        const r = MODEL.trainedRanges;
        const hourOk = hour == null || (hour >= r.hour.min && hour <= r.hour.max);
        return rainfallMm >= r.rainfallMm.min && rainfallMm <= r.rainfallMm.max
            && highTideM >= r.highTideM.min && highTideM <= r.highTideM.max
            && hourOk;
    }

    // The hours actually present in the training data (6 AM-8 PM, whole
    // hours only). The Time of Day field now accepts any HH:MM, so this is
    // kept only as a reference for the trained range check above.
    const TRAINED_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

    function computeHighWaterRisk(rainfallMm, highTideM) {
        return (rainfallMm >= MODEL.highWaterRiskRule.rainfallMm || highTideM >= MODEL.highWaterRiskRule.highTideM) ? 1 : 0;
    }

    function predictAvailableDrivers({ hour, location, rainfallMm, highTideM, highWaterRisk }) {
        const locCoef = MODEL.coefficients.location[location] ?? 0;
        const raw = MODEL.intercept
            + locCoef
            + MODEL.coefficients.hour * hour
            + MODEL.coefficients.rainfall_mm * rainfallMm
            + MODEL.coefficients.high_tide_m * highTideM
            + MODEL.coefficients.high_water_risk * highWaterRisk;
        return raw;
    }

    function availabilityStatus(predictedDrivers) {
        if (predictedDrivers < MODEL.availabilityThresholds.low) return 'LOW';
        if (predictedDrivers < MODEL.availabilityThresholds.moderate) return 'MODERATE';
        return 'HIGH';
    }

    // PARA operates in Hagonoy, Bulacan — a coastal/riverine town on Manila Bay,
    // which is why tide level is a model feature. Coordinates are the town center.
    const SERVICE_AREA = { name: 'Hagonoy, Bulacan', latitude: 14.83, longitude: 120.73 };

    const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${SERVICE_AREA.latitude}&longitude=${SERVICE_AREA.longitude}&current=precipitation`;

    // Live current rainfall from Open-Meteo (free, no API key). Firestore has no
    // weather data of its own, so this is the real external source for that
    // model input. Tide no longer comes from here — see parseTideWorkbook below,
    // which reads it from the LGU's own published tide bulletin (uploaded as .xlsx).
    async function fetchLiveRainfall() {
        const res = await fetch(WEATHER_URL);
        if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
        const data = await res.json();
        const rainfallMm = data?.current?.precipitation;
        if (typeof rainfallMm !== 'number') {
            throw new Error('Unexpected response shape from weather API');
        }
        return { rainfallMm, observedAt: data?.current?.time || null };
    }

    const FEET_TO_METERS = 0.3048;

    // SheetJS's `cellDates: true` Date-object conversion is timezone-sensitive
    // and has floating-point drift (verified: it shifted dates by a day and
    // times by several minutes depending on the browser's local timezone).
    // So workbooks are read WITHOUT cellDates, and raw Excel serial numbers
    // are converted here ourselves with exact, timezone-independent integer
    // arithmetic (serial day 0 = 1899-12-30, the standard Excel epoch).
    function excelSerialToUtcMidnight(serial) {
        const utcDays = Math.round(serial - 25569); // days between Excel epoch and Unix epoch
        return new Date(utcDays * 86400 * 1000);
    }

    function excelTimeToHoursMinutes(value) {
        if (typeof value === 'number') {
            const fractionOfDay = value - Math.floor(value);
            const totalMinutes = Math.round(fractionOfDay * 24 * 60);
            return { hours: Math.floor(totalMinutes / 60) % 24, minutes: totalMinutes % 60 };
        }
        if (typeof value === 'string') {
            const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
            if (match) {
                let h = parseInt(match[1], 10);
                const m = parseInt(match[2], 10);
                const ampm = match[3] ? match[3].toUpperCase() : null;
                if (ampm === 'PM' && h !== 12) h += 12;
                if (ampm === 'AM' && h === 12) h = 0;
                return { hours: h, minutes: m };
            }
        }
        return null;
    }

    function excelDateToYmd(value) {
        if (typeof value === 'number') {
            const utcMidnight = excelSerialToUtcMidnight(value);
            return { y: utcMidnight.getUTCFullYear(), m: utcMidnight.getUTCMonth(), d: utcMidnight.getUTCDate() };
        }
        if (typeof value === 'string') {
            const parsed = new Date(value);
            if (!isNaN(parsed.getTime())) {
                return { y: parsed.getFullYear(), m: parsed.getMonth(), d: parsed.getDate() };
            }
        }
        return null;
    }

    function findColumnKey(row, aliases) {
        for (const key of Object.keys(row)) {
            if (aliases.includes(String(key).trim().toLowerCase())) return key;
        }
        return null;
    }

    function toIsoDateKey(y, m, d) {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // Parses an admin-uploaded .xlsx transcription of the LGU's tide bulletin.
    // Expected columns (header row, any order): Date, Time, Tide (ft).
    // Each day typically has 1-2 rows (the bulletin's listed tide extremes),
    // not a continuous hourly series — see findNearestTideEntry.
    function parseTideWorkbook(arrayBuffer) {
        if (typeof XLSX === 'undefined') throw new Error('Excel parser failed to load — check your internet connection and reload the page.');
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) throw new Error('The uploaded file has no sheets.');
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { raw: true, defval: null });
        if (!rows.length) throw new Error('The uploaded sheet has no data rows.');

        const dateKey = findColumnKey(rows[0], ['date']);
        const timeKey = findColumnKey(rows[0], ['time']);
        const tideKey = findColumnKey(rows[0], ['tide (ft)', 'tide(ft)', 'tide', 'height (ft)', 'height(ft)', 'height', 'tide height', 'tide height (ft)']);

        if (!dateKey || !timeKey || !tideKey) {
            throw new Error('Expected columns "Date", "Time", and "Tide (ft)" were not found in the header row.');
        }

        const entries = [];
        for (const row of rows) {
            const dateVal = row[dateKey];
            const timeVal = row[timeKey];
            const tideVal = row[tideKey];
            if (dateVal == null || timeVal == null || tideVal == null) continue;

            const ymd = excelDateToYmd(dateVal);
            const hm = excelTimeToHoursMinutes(timeVal);
            const tideFt = Number(tideVal);
            if (!ymd || !hm || !Number.isFinite(tideFt)) continue;

            entries.push({
                dateTime: new Date(ymd.y, ymd.m, ymd.d, hm.hours, hm.minutes, 0, 0),
                dateKey: toIsoDateKey(ymd.y, ymd.m, ymd.d),
                minutesOfDay: hm.hours * 60 + hm.minutes,
                tideFt,
                tideM: tideFt * FEET_TO_METERS
            });
        }

        if (!entries.length) throw new Error('No valid tide rows could be parsed — check the Date/Time/Tide values.');
        entries.sort((a, b) => a.dateTime - b.dateTime);
        return entries;
    }

    // Among entries matching isoDateStr (YYYY-MM-DD), returns the one whose
    // listed time is closest to targetMinutes (minutes since midnight, e.g.
    // 14:30 -> 870). Returns null if nothing was uploaded for that date —
    // callers should treat that as "no data", not default to 0.
    function findNearestTideEntry(entries, isoDateStr, targetMinutes) {
        if (!entries || !entries.length || !isoDateStr) return null;
        const sameDate = entries.filter((e) => e.dateKey === isoDateStr);
        if (!sameDate.length) return null;
        let best = sameDate[0];
        let bestDiff = Math.abs(best.minutesOfDay - targetMinutes);
        for (const entry of sameDate) {
            const diff = Math.abs(entry.minutesOfDay - targetMinutes);
            if (diff < bestDiff) { bestDiff = diff; best = entry; }
        }
        return best;
    }

    window.ParaDriverPrediction = {
        MODEL,
        TRAINED_HOURS,
        SERVICE_AREA,
        FEET_TO_METERS,
        computeHighWaterRisk,
        predictAvailableDrivers,
        availabilityStatus,
        isWithinTrainedRange,
        fetchLiveRainfall,
        parseTideWorkbook,
        findNearestTideEntry
    };
})();
