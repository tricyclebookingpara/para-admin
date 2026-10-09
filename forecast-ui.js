// Availability & Demand Forecast page (admin website).
//
// Prediction phase: the admin picks a day, hour and area. Rainfall, tide and
// high-water risk for that time are looked up, and each saved model gives a
// number (Y = b0 + b1x1 + … + bnxn) plus a HIGH / MODERATE / LOW status.
// The website shows both the number and the status; the mobile apps show the
// status only.
// Training phase: "Train models" reads what the app has logged, fits both
// regressions (see forecast.js) and saves the coefficients.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    const F = window.ParaForecast;
    const view = document.getElementById('view-driver-availability');
    if (!P || !F || !view) return;

    const $ = (id) => document.getElementById(id);
    const DAY_MS = 24 * 3600 * 1000;
    // Real-data training reads this much history (all that is available, up to a year).
    const REAL_HISTORY_DAYS = 365;
    const ENV_CACHE_MS = 30 * 60 * 1000;
    const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const ALL_AREAS = 'ALL';
    const KINDS = {
        availability: { title: 'Driver availability', unit: 'Available drivers', save: 'saveDriverAvailabilityModel', fetch: 'fetchDriverAvailabilityModel' },
        demand: { title: 'Passenger booking demand', unit: 'Bookings', save: 'savePassengerDemandModel', fetch: 'fetchPassengerDemandModel' }
    };

    const models = { availability: null, demand: null };
    let staleModels = false;
    let modelsLoaded = false;
    let loadingModels = false;
    let requestId = 0;
    let viewKind = 'availability';
    // The tide readings (from Firestore) and their by-date index.
    let tideReadings = [];
    let tideIndex = P.indexTide([]);
    const envCache = new Map(); // key -> { at, promise }
    let scatterChart = null;

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'success');
    }

    function clear(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    function cell(row, text, style) {
        const td = document.createElement('td');
        td.textContent = text;
        if (style) td.style.cssText = style;
        row.appendChild(td);
        return td;
    }

    function fmt(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits) : '—';
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    // ── Labels and colours ─────────────────────────────────────────────
    // Availability and the environment run green (good/calm) → red (scarce/
    // severe). Demand is not good or bad, so HIGH is blue and LOW is plain.
    const TONES = {
        availability: { HIGH: 'tone-green', MODERATE: 'tone-amber', LOW: 'tone-red' },
        demand: { HIGH: 'tone-blue', MODERATE: 'tone-amber', LOW: '' },
        severity: { Light: 'tone-green', Low: 'tone-green', LOW: 'tone-green', Moderate: 'tone-amber', MODERATE: 'tone-amber', Strong: 'tone-red', High: 'tone-red', HIGH: 'tone-red', SEVERE: 'tone-red' }
    };

    function setLabel(el, text, tone) {
        el.textContent = text || '—';
        el.className = `fc-label${el.classList.contains('fc-label-lg') ? ' fc-label-lg' : ''}${tone ? ` ${tone}` : ''}`;
    }

    function formatClock(minutes) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
    }

    // ── Inputs ─────────────────────────────────────────────────────────
    function initInputs() {
        const select = $('fc-hour');
        for (let h = 0; h < 24; h += 1) {
            const option = document.createElement('option');
            option.value = String(h);
            option.textContent = formatClock(h * 60);
            select.appendChild(option);
        }
        const now = P.manilaParts(Date.now());
        $('fc-date').value = now.dateKey;
        select.value = String(now.hour);
        showDayOfWeek();
    }

    function showDayOfWeek() {
        const dateKey = $('fc-date').value;
        $('fc-dow').textContent = dateKey ? DOW_NAMES[P.dayOfWeekOf(dateKey)] : '';
    }

    function useNextHour() {
        const next = P.manilaParts(Date.now() + 3600 * 1000);
        $('fc-date').value = next.dateKey;
        $('fc-hour').value = String(next.hour);
        showDayOfWeek();
        runPrediction();
    }

    function knownModel() {
        return models.availability || models.demand;
    }

    function renderAreaOptions() {
        const select = $('fc-area');
        const previous = select.value;
        clear(select);
        const model = knownModel();
        const all = document.createElement('option');
        all.value = ALL_AREAS;
        all.textContent = 'All barangays (Hagonoy)';
        select.appendChild(all);
        // Every barangay is listed; with a trained model, the ones it has no
        // data for are shown but cannot be chosen.
        P.HAGONOY_BARANGAYS.forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            const hasData = !model || model.areas.includes(name);
            option.textContent = hasData ? name : `${name} (no data yet)`;
            option.disabled = !hasData;
            select.appendChild(option);
        });
        const usable = (name) => Array.from(select.options).some((o) => o.value === name && !o.disabled);
        const preferred = [previous, ALL_AREAS].find((name) => name && usable(name));
        select.value = preferred || (Array.from(select.options).find((o) => !o.disabled) || {}).value || '';
    }

    // ── Tide data (uploaded Excel, stored in Firestore) ────────────────
    function setTideReadings(readings) {
        tideReadings = readings;
        tideIndex = P.indexTide(readings);
        const status = $('fc-tide-file-status');
        if (!tideIndex.dates.length) {
            status.textContent = 'No tide data loaded yet.';
            return;
        }
        const first = tideIndex.dates[0];
        const last = tideIndex.dates[tideIndex.dates.length - 1];
        status.textContent = `${readings.length} reading${readings.length === 1 ? '' : 's'} loaded · ${first}${first === last ? '' : ` to ${last}`}`;
    }

    async function loadTideBulletin() {
        if (!window.ParaFirestore) return;
        try {
            const since = P.addDays(P.manilaParts(Date.now()).dateKey, -130);
            setTideReadings(await window.ParaFirestore.fetchTideBulletin(since));
        } catch (error) {
            console.error('Failed to load the tide data:', error);
            $('fc-tide-file-status').textContent = 'Could not load the saved tide data.';
        }
    }

    async function uploadTideBulletin(file) {
        let readings;
        try {
            readings = P.parseTideWorkbook(await file.arrayBuffer());
        } catch (error) {
            console.error('Failed to parse the tide workbook:', error);
            toast(error.message || 'Could not read that Excel file.', 'error');
            return;
        }
        try {
            const result = await window.ParaFirestore.saveTideBulletin(readings);
            toast(`Tide data saved: ${result.readings} readings for ${result.days} days.`, 'success');
            await loadTideBulletin();
        } catch (error) {
            console.error('Failed to save the tide data:', error);
            toast('Tide data loaded here, but could not be saved — the mobile app will not see it.', 'error');
            // Still usable on this page until reload.
            const kept = tideReadings.filter((r) => !readings.some((n) => n.dateKey === r.dateKey));
            setTideReadings([...kept, ...readings]);
        }
        runPrediction();
    }

    // ── Prediction phase ───────────────────────────────────────────────
    function getEnvironment(dateKey) {
        const from = P.addDays(dateKey, -P.CONFIG.baselineDays);
        const to = P.addDays(dateKey, P.CONFIG.dischargeAheadDays + 1);
        const key = `${from}|${to}`;
        const cached = envCache.get(key);
        if (cached && Date.now() - cached.at < ENV_CACHE_MS) return cached.promise;
        const promise = P.loadEnvironment(from, to).catch((error) => {
            envCache.delete(key);
            throw error;
        });
        envCache.set(key, { at: Date.now(), promise });
        return promise;
    }

    function clearPredictions() {
        ['drv', 'dem'].forEach((p) => {
            $(`fc-${p}-value`).textContent = '—';
            setLabel($(`fc-${p}-badge`), '—', '');
        });
        $('fc-range-warning').style.display = 'none';
    }

    function clearConditions() {
        $('fc-rain-value').textContent = '—';
        setLabel($('fc-rain-label'), '—', '');
        $('fc-tide-value').textContent = '—';
        setLabel($('fc-tide-label'), '—', '');
        setLabel($('fc-risk-label'), '—', '');
        $('fc-tide-note').textContent = '';
        $('fc-tide-note').style.color = '';
    }

    // Shows a predicted count as a whole number and gives it its status. The
    // status is read from the same rounded number the admin sees. For "All
    // barangays" the barangay predictions are added up and the whole-town
    // thresholds apply.
    function showPrediction(kind, prefix, input) {
        const model = models[kind];
        if (!model) {
            $(`fc-${prefix}-value`).textContent = '—';
            setLabel($(`fc-${prefix}-badge`), 'NOT TRAINED', '');
            return;
        }
        const allTown = input.area === ALL_AREAS;
        const raw = allTown ? F.predictAll(model, input) : F.predict(model, input);
        const value = Math.round(raw);
        const status = P.classify(value, F.thresholdsFor(model, allTown));
        $(`fc-${prefix}-value`).textContent = String(value);
        setLabel($(`fc-${prefix}-badge`), status || 'SET THRESHOLDS', status ? TONES[kind][status] : '');
    }

    async function runPrediction() {
        const dateKey = $('fc-date').value;
        const hour = Number($('fc-hour').value);
        const area = $('fc-area').value;
        const myRequest = ++requestId;
        showDayOfWeek();

        if (!dateKey) {
            clearConditions();
            clearPredictions();
            $('fc-env-status').textContent = 'Pick a day.';
            return;
        }
        $('fc-env-status').textContent = '';

        let env;
        try {
            env = { ...(await getEnvironment(dateKey)), tide: tideIndex };
        } catch (error) {
            if (myRequest !== requestId) return;
            console.error('Failed to load environment data:', error);
            clearConditions();
            clearPredictions();
            $('fc-env-status').textContent = 'Could not load weather data.';
            toast('Could not load weather data.', 'error');
            return;
        }
        if (myRequest !== requestId) return;
        clearConditions();

        // Rainfall and tide are shown whenever they exist, even if the full
        // set of inputs the prediction needs is not available yet.
        const rainMm = env.rain.get(P.hourKey(dateKey, hour));
        if (rainMm !== undefined) {
            $('fc-rain-value').textContent = rainMm.toFixed(2);
            setLabel($('fc-rain-label'), P.rainLabel(rainMm), TONES.severity[P.rainLabel(rainMm)]);
        }
        const reading = P.nearestTideReading(tideIndex, dateKey, hour * 60 + 30);
        const tideNote = $('fc-tide-note');
        if (reading) {
            const level = P.tideLabel(reading.meters, P.tideLevels(tideIndex));
            $('fc-tide-value').textContent = reading.feet.toFixed(1);
            setLabel($('fc-tide-label'), level, level ? TONES.severity[level] : '');
            if (reading.distanceMinutes > P.CONFIG.tideMatchWarnMinutes) {
                tideNote.textContent = `⚠ Nearest reading that day is at ${formatClock(reading.minutes)}, ${(reading.distanceMinutes / 60).toFixed(1)} h away — may not be reliable.`;
                tideNote.style.color = 'var(--status-decl-text)';
            } else {
                tideNote.textContent = `Reading at ${formatClock(reading.minutes)}`;
            }
        } else {
            tideNote.textContent = `No tide reading for ${dateKey}.`;
        }

        const environment = P.environmentFor(env, dateKey, hour);
        if (!environment.ok) {
            clearPredictions();
            const messages = [];
            if (environment.issues.some((i) => i.startsWith('tide bulletin'))) {
                messages.push(`No tide data for ${dateKey}.`);
            } else if (environment.issues.some((i) => i.startsWith('tide'))) {
                messages.push('The high-water risk needs a few more days of tide data.');
            }
            if (environment.issues.some((i) => i.startsWith('rain') || i.startsWith('river'))) {
                messages.push(`No rainfall data for ${dateDisplay(dateKey, hour)} yet (forecasts reach about 2 weeks ahead).`);
            }
            $('fc-env-status').textContent = messages.join(' ');
            return;
        }

        const riskName = P.RISK_LEVELS[environment.riskLevel];
        setLabel($('fc-risk-label'), riskName, TONES.severity[riskName]);

        if (!area || (!models.availability && !models.demand)) {
            clearPredictions();
            setLabel($('fc-drv-badge'), 'NOT TRAINED', '');
            setLabel($('fc-dem-badge'), 'NOT TRAINED', '');
            return;
        }

        const input = {
            hour,
            dow: P.dayOfWeekOf(dateKey),
            area,
            rainfallMm: environment.rainfallMm,
            tideM: environment.tideM,
            riskLevel: environment.riskLevel
        };
        showPrediction('availability', 'drv', input);
        showPrediction('demand', 'dem', input);

        const outside = new Set();
        Object.values(models).forEach((m) => { if (m) F.outOfRangeInputs(m, input).forEach((label) => outside.add(label)); });
        const warning = $('fc-range-warning');
        if (outside.size) {
            warning.textContent = `⚠ The ${[...outside].join(', ')} for this request is outside the range the models were trained on, so the prediction is an extrapolation and may be less reliable.`;
            warning.style.display = 'block';
        } else {
            warning.style.display = 'none';
        }
    }

    function dateDisplay(dateKey, hour) {
        return `${dateKey} ${formatClock(hour * 60)}`;
    }

    // ── Showing the trained models ─────────────────────────────────────
    function featureLabel(model, name) {
        if (name === 'hour') return 'Hour of day (x1)';
        if (name === 'day_of_week') return 'Day of week (x2, Monday = 0 … Sunday = 6)';
        if (name === 'rainfall_mm') return 'Rainfall, mm (x4)';
        if (name === 'tide_height_m') return 'Tide height, m (x5)';
        if (name === 'high_water_risk') return 'High-water risk level, 0–3 (x6)';
        if (name.startsWith('area:')) {
            return `Location (x3): ${name.slice(5)} vs. ${model.areaBaseline}`;
        }
        return name;
    }

    function renderModelNote() {
        const note = $('fc-model-note');
        if (staleModels) {
            note.textContent = 'Saved models are out of date — train again.';
            return;
        }
        const model = knownModel();
        if (!model) {
            note.textContent = 'No trained models yet.';
            return;
        }
        const when = new Date(model.trainedAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        const source = model.dataSource === 'sample' ? 'sample data' : 'real app data';
        note.textContent = `Last trained ${when} · ${model.metrics.records.toLocaleString()} records · ${source}`;
    }

    function renderScatter(model) {
        const canvas = $('fc-scatter');
        if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
        if (!model || !canvas || typeof Chart === 'undefined' || !model.testPoints || !model.testPoints.length) return;
        const points = model.testPoints.map((p) => ({ x: p.a, y: p.p }));
        const maxValue = Math.max(1, ...points.map((p) => Math.max(p.x, p.y)));
        scatterChart = new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            data: {
                datasets: [
                    { label: 'Test records', data: points, backgroundColor: 'rgba(26,115,232,0.45)', pointRadius: 3 },
                    { type: 'line', label: 'Perfect prediction', data: [{ x: 0, y: 0 }, { x: maxValue, y: maxValue }], borderColor: '#05CD99', borderDash: [6, 4], borderWidth: 2, pointRadius: 0 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
                scales: {
                    x: { title: { display: true, text: `Actual ${KINDS[viewKind].unit.toLowerCase()}` }, min: 0, grid: { color: '#F4F7FE' } },
                    y: { title: { display: true, text: 'Predicted' }, min: 0, grid: { color: '#F4F7FE' } }
                }
            }
        });
    }

    function renderTrainingResults() {
        const box = $('fc-train-results');
        if (!models.availability && !models.demand) {
            box.style.display = 'none';
            return;
        }
        [['availability', 'drv'], ['demand', 'dem']].forEach(([kind, prefix]) => {
            [['thr', 'thresholds'], ['all', 'thresholdsAll']].forEach(([id, field]) => {
                const thresholds = (models[kind] && models[kind][field]) || {};
                $(`fc-${prefix}-${id}-low`).value = thresholds.lowBelow == null ? '' : thresholds.lowBelow;
                $(`fc-${prefix}-${id}-high`).value = thresholds.highFrom == null ? '' : thresholds.highFrom;
            });
        });
        if (!models[viewKind]) viewKind = models.availability ? 'availability' : 'demand';
        const model = models[viewKind];
        box.style.display = 'block';
        view.querySelectorAll('.fc-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.kind === viewKind);
            tab.disabled = !models[tab.dataset.kind];
        });

        const metricsBody = $('fc-metrics-table').querySelector('tbody');
        clear(metricsBody);
        const tr = document.createElement('tr');
        cell(tr, `${model.metrics.trainRecords.toLocaleString()} / ${model.metrics.testRecords.toLocaleString()}${model.metrics.inSample ? ' (same data)' : ''}`);
        cell(tr, fmt(model.metrics.r2, 3));
        cell(tr, fmt(model.metrics.mae, 2));
        cell(tr, fmt(model.metrics.rmse, 2));
        metricsBody.appendChild(tr);
        $('fc-metrics-note').textContent = model.metrics.inSample ? 'Fewer than 50 records, so these scores are measured on the training data itself.' : '';

        const coefBody = $('fc-coef-table').querySelector('tbody');
        clear(coefBody);
        const interceptRow = document.createElement('tr');
        cell(interceptRow, `Intercept (b0) — reference location: ${model.areaBaseline}`, 'font-weight:600;');
        cell(interceptRow, fmt(model.intercept, 4));
        coefBody.appendChild(interceptRow);
        model.features.forEach((name) => {
            const row = document.createElement('tr');
            cell(row, featureLabel(model, name));
            const dropped = (model.dropped || []).includes(name);
            cell(row, dropped ? '— (no variation in data)' : fmt(model.coefficients[name], 4), dropped ? 'color:var(--text-muted);' : '');
            coefBody.appendChild(row);
        });

        renderScatter(model);
    }

    function refreshAll() {
        renderAreaOptions();
        renderModelNote();
        renderTrainingResults();
    }

    // ── Loading the saved models ───────────────────────────────────────
    async function loadSavedModels() {
        if (loadingModels || !window.ParaFirestore) return;
        loadingModels = true;
        const tidePromise = loadTideBulletin();
        try {
            const [availability, demand] = await Promise.all([
                window.ParaFirestore[KINDS.availability.fetch](),
                window.ParaFirestore[KINDS.demand.fetch]()
            ]);
            staleModels = Boolean((availability && !F.isCurrent(availability)) || (demand && !F.isCurrent(demand)));
            models.availability = F.isCurrent(availability) ? availability : null;
            models.demand = F.isCurrent(demand) ? demand : null;
            modelsLoaded = true;
        } catch (error) {
            console.error('Failed to load the saved models:', error);
            $('fc-model-note').textContent = 'Could not load the saved models.';
        } finally {
            loadingModels = false;
        }
        await tidePromise;
        refreshAll();
        runPrediction();
    }

    // ── Training phase ─────────────────────────────────────────────────
    function setTrainStatus(text) {
        $('fc-train-status').textContent = text;
    }

    function showTrainWarnings(warnings) {
        const box = $('fc-train-warnings');
        if (!warnings.length) { box.style.display = 'none'; return; }
        clear(box);
        warnings.forEach((text) => {
            const line = document.createElement('div');
            line.textContent = `⚠ ${text}`;
            box.appendChild(line);
        });
        box.style.display = 'block';
    }

    function sinceForDays(days) {
        const { dateKey } = P.manilaParts(Date.now() - days * DAY_MS);
        return new Date(`${dateKey}T00:00:00+08:00`);
    }

    // Where the training records come from: generated sample data (until the
    // app has enough history) or what the app has really logged. Both give the
    // trainer the same shapes, so everything after this point is identical.
    async function collectTrainingData(source) {
        if (source === 'sample') {
            setTrainStatus('Generating sample records…');
            const sample = await window.ParaSampleData.generate(Date.now());
            return { raw: sample.raw, options: { labelled: true, dataSource: 'sample', loadEnvironment: sample.loadEnvironment } };
        }
        setTrainStatus('Reading the tide data, driver activity and completed rides…');
        await loadTideBulletin();
        if (!tideReadings.length) {
            throw new Error('Upload the tide data (Excel) first — the models need the tide for the dates they train on.');
        }
        const raw = await window.ParaFirestore.fetchPredictionTrainingData(sinceForDays(REAL_HISTORY_DAYS));
        raw.tide = tideReadings;
        return { raw, options: { dataSource: 'real' } };
    }

    async function trainModels() {
        if (!window.ParaFirestore) return;
        const button = $('fc-train-btn');
        button.disabled = true;
        showTrainWarnings([]);
        const source = $('fc-data-source').value === 'real' ? 'real' : 'sample';

        try {
            const { raw, options } = await collectTrainingData(source);
            const result = await F.train(raw, { ...options, onProgress: setTrainStatus });

            // Keep thresholds the admin already confirmed, but only when they
            // were set for the same kind of data (sample counts and real counts
            // are not comparable).
            Object.keys(KINDS).forEach((kind) => {
                ['thresholds', 'thresholdsAll'].forEach((field) => {
                    const previous = models[kind] && models[kind][field];
                    if (previous && previous.lowBelow != null && previous.highFrom != null && models[kind].dataSource === source) {
                        result.models[kind][field] = { lowBelow: previous.lowBelow, highFrom: previous.highFrom, suggested: false };
                    }
                });
                models[kind] = result.models[kind];
            });
            staleModels = false;

            const warnings = [...result.warnings];
            try {
                await Promise.all(Object.keys(KINDS).map((kind) => window.ParaFirestore[KINDS[kind].save](models[kind])));
            } catch (error) {
                console.error('Failed to save the models:', error);
                warnings.push('The models were trained but could not be saved (check permissions), so they are only available until this page is reloaded.');
            }

            const s = result.summary;
            setTrainStatus(`Trained on ${s.records.toLocaleString()} barangay-hour records from ${s.from} to ${s.to} (${s.days} day${s.days === 1 ? '' : 's'}, ${s.areas} barangay${s.areas === 1 ? '' : 's'}) — ${s.driverLogs.toLocaleString()} driver logs and ${s.rides.toLocaleString()} completed bookings. On average ${s.meanOnline.toFixed(1)} drivers online, ${s.meanBusy.toFixed(1)} busy and ${s.meanBookings.toFixed(2)} bookings per barangay and hour.`);
            showTrainWarnings(warnings);
            refreshAll();
            runPrediction();
            toast('Models trained.', 'success');
        } catch (error) {
            console.error('Training failed:', error);
            setTrainStatus(error.message || 'Training failed.');
            toast(error.message || 'Training failed.', 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function saveThresholds() {
        const edits = [];
        for (const [kind, prefix] of [['availability', 'drv'], ['demand', 'dem']]) {
            if (!models[kind]) continue;
            const next = {};
            for (const [id, field, scope] of [['thr', 'thresholds', 'per barangay'], ['all', 'thresholdsAll', 'all barangays']]) {
                const low = parseFloat($(`fc-${prefix}-${id}-low`).value);
                const high = parseFloat($(`fc-${prefix}-${id}-high`).value);
                if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high <= low) {
                    toast(`${KINDS[kind].title} (${scope}): enter two numbers where HIGH-from is larger than LOW-below.`, 'error');
                    return;
                }
                next[field] = { lowBelow: low, highFrom: high, suggested: false };
            }
            edits.push({ kind, next });
        }
        if (!edits.length) return;
        edits.forEach(({ kind, next }) => Object.assign(models[kind], next));
        try {
            await Promise.all(edits.map(({ kind }) => window.ParaFirestore[KINDS[kind].save](models[kind])));
            toast('Thresholds saved.', 'success');
        } catch (error) {
            console.error('Failed to save thresholds:', error);
            toast('Thresholds applied here, but could not be saved.', 'error');
        }
        refreshAll();
        runPrediction();
    }

    async function clearTideData() {
        if (!window.ParaFirestore) return;
        if (!tideReadings.length) {
            toast('There is no tide data to clear.', 'error');
            return;
        }
        if (!window.confirm('Clear ALL uploaded tide data? The website and the mobile apps will have no tide readings until you upload a new file.')) return;
        const button = $('fc-tide-clear-btn');
        button.disabled = true;
        try {
            const result = await window.ParaFirestore.clearTideBulletin();
            setTideReadings([]);
            toast(`Tide data cleared (${result.days} day${result.days === 1 ? '' : 's'} removed).`, 'success');
        } catch (error) {
            console.error('Failed to clear the tide data:', error);
            toast('Could not clear the tide data (check permissions).', 'error');
        } finally {
            button.disabled = false;
        }
        runPrediction();
    }

    // ── Wiring ─────────────────────────────────────────────────────────
    initInputs();
    renderAreaOptions();

    ['fc-date', 'fc-hour', 'fc-area'].forEach((id) => $(id).addEventListener('change', runPrediction));
    $('fc-next-hour-btn').addEventListener('click', useNextHour);
    $('fc-train-btn').addEventListener('click', trainModels);
    $('fc-save-thresholds-btn').addEventListener('click', saveThresholds);
    $('fc-tide-clear-btn').addEventListener('click', clearTideData);
    view.querySelectorAll('.fc-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            if (!models[tab.dataset.kind]) return;
            viewKind = tab.dataset.kind;
            renderTrainingResults();
        });
    });

    const tideFileInput = $('fc-tide-file');
    $('fc-tide-upload-btn').addEventListener('click', () => tideFileInput.click());
    tideFileInput.addEventListener('change', async () => {
        const file = tideFileInput.files && tideFileInput.files[0];
        if (!file) return;
        try {
            await uploadTideBulletin(file);
        } finally {
            tideFileInput.value = '';
        }
    });

    // Load the saved models the first time the page is opened (the admin is
    // signed in by then).
    function onViewShown() {
        if (view.classList.contains('active') && !modelsLoaded) loadSavedModels();
    }
    new MutationObserver(onViewShown).observe(view, { attributes: true, attributeFilter: ['class'] });
    onViewShown();
})();
