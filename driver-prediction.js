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
            highTideM: { min: 0.5, max: 2.0 }
        }
    };

    function isWithinTrainedRange(rainfallMm, highTideM) {
        const r = MODEL.trainedRanges;
        return rainfallMm >= r.rainfallMm.min && rainfallMm <= r.rainfallMm.max
            && highTideM >= r.highTideM.min && highTideM <= r.highTideM.max;
    }

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
    const MARINE_URL = `https://marine-api.open-meteo.com/v1/marine?latitude=${SERVICE_AREA.latitude}&longitude=${SERVICE_AREA.longitude}&current=sea_level_height_msl`;

    // Live rainfall + tide from Open-Meteo (free, no API key). Firestore has no
    // weather/tide data of its own, so this is the real external data source
    // for those two model inputs.
    async function fetchLiveWeather() {
        const [weatherRes, marineRes] = await Promise.all([
            fetch(WEATHER_URL),
            fetch(MARINE_URL)
        ]);
        if (!weatherRes.ok) throw new Error(`Weather API returned ${weatherRes.status}`);
        if (!marineRes.ok) throw new Error(`Marine/tide API returned ${marineRes.status}`);

        const weather = await weatherRes.json();
        const marine = await marineRes.json();

        const rainfallMm = weather?.current?.precipitation;
        const highTideM = marine?.current?.sea_level_height_msl;
        if (typeof rainfallMm !== 'number' || typeof highTideM !== 'number') {
            throw new Error('Unexpected response shape from weather/marine API');
        }

        return {
            rainfallMm,
            highTideM,
            observedAt: weather?.current?.time || null
        };
    }

    window.ParaDriverPrediction = {
        MODEL,
        TRAINED_HOURS,
        SERVICE_AREA,
        computeHighWaterRisk,
        predictAvailableDrivers,
        availabilityStatus,
        isWithinTrainedRange,
        fetchLiveWeather
    };
})();
