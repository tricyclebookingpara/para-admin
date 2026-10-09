// Driver Availability Prediction page.
//
// Prediction phase: the admin picks a date, hour and area; rainfall, tide and
// high-water risk for that hour are looked up, and the saved coefficients give
// the predicted number of available drivers plus a HIGH / MODERATE / LOW label.
// Training phase: "Train Model" reads what the app has logged, fits the
// regression (see driver-availability.js) and saves the coefficients.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    const DA = window.ParaDriverAvailability;
    const view = document.getElementById('view-driver-availability');
    if (!P || !DA || !view) return;

    const $ = (id) => document.getElementById(id);
    const DAY_MS = 24 * 3600 * 1000;
    const ENV_CACHE_MS = 30 * 60 * 1000;

    let model = null;
    let modelLoaded = false;
    let loadingModel = false;
    let requestId = 0;
    // The LGU tide bulletin readings (from Firestore) and their by-date index.
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

    function badgeClass(status) {
        if (status === 'HIGH') return 'approved';
        if (status === 'MODERATE') return 'processing';
        if (status === 'LOW') return 'declined';
        return 'processing';
    }

    function setBadge(el, text, status) {
        el.textContent = text;
        el.className = `status-badge ${badgeClass(status)}`;
    }

    // ── Inputs ─────────────────────────────────────────────────────────
    function initInputs() {
        const now = P.manilaParts(Date.now());
        if (!$('da-date').value) $('da-date').value = now.dateKey;
        if (!$('da-time').value) $('da-time').value = `${String(now.hour).padStart(2, '0')}:00`;
    }

    function renderAreaOptions() {
        const select = $('da-area');
        const previous = select.value;
        clear(select);
        if (!model || !model.areas.length) {
            const option = document.createElement('option');
            option.textContent = 'Train the model first';
            option.value = '';
            select.appendChild(option);
            return;
        }
        model.areas.forEach((area) => {
            const option = document.createElement('option');
            option.value = area;
            option.textContent = (model.areaLabels[area] && model.areaLabels[area].label) || area;
            select.appendChild(option);
        });
        if (previous && model.areas.includes(previous)) select.value = previous;
    }

    // ── Tide bulletin (uploaded Excel, stored in Firestore) ────────────
    function formatClock(minutes) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    }

    function setTideReadings(readings) {
        tideReadings = readings;
        tideIndex = P.indexTide(readings);
        const status = $('da-tide-file-status');
        if (!tideIndex.dates.length) {
            status.textContent = 'No tide data loaded yet. Upload the LGU bulletin (.xlsx) with Date, Time and Tide (ft) columns.';
            return;
        }
        const first = tideIndex.dates[0];
        const last = tideIndex.dates[tideIndex.dates.length - 1];
        status.textContent = `Loaded ${readings.length} tide reading${readings.length === 1 ? '' : 's'} for ${tideIndex.dates.length} day${tideIndex.dates.length === 1 ? '' : 's'} (${first}${first === last ? '' : ` to ${last}`}).`;
    }

    async function loadTideBulletin() {
        if (!window.ParaFirestore) return;
        try {
            const since = P.addDays(P.manilaParts(Date.now()).dateKey, -130);
            setTideReadings(await window.ParaFirestore.fetchTideBulletin(since));
        } catch (error) {
            console.error('Failed to load the tide bulletin:', error);
            $('da-tide-file-status').textContent = 'Could not load the saved tide bulletin from Firestore.';
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
            toast(`Tide bulletin saved: ${result.readings} readings for ${result.days} days.`, 'success');
            await loadTideBulletin();
        } catch (error) {
            console.error('Failed to save the tide bulletin:', error);
            toast('Tide data loaded here, but could not be saved to Firestore — the app will not see it.', 'error');
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

    function clearResults(statusText) {
        $('da-value').textContent = '–';
        setBadge($('da-badge'), '–', null);
        $('da-past-demand').value = '';
        $('da-rainfall').value = '';
        $('da-tide').value = '';
        $('da-tide-match-note').textContent = 'From the uploaded LGU tide bulletin (ft → m): the reading closest to the selected time on that date.';
        $('da-tide-match-note').style.color = '';
        setBadge($('da-risk-badge'), '—', null);
        $('da-range-warning').style.display = 'none';
        if (statusText) $('da-env-status').textContent = statusText;
    }

    async function runPrediction() {
        const dateKey = $('da-date').value;
        const time = $('da-time').value;
        const area = $('da-area').value;
        const myRequest = ++requestId;

        if (!dateKey || !time) {
            clearResults('Pick a date and a time.');
            return;
        }
        const hour = Number(time.split(':')[0]);
        $('da-env-status').textContent = 'Loading rainfall and river data from Open-Meteo…';

        let env;
        try {
            env = { ...(await getEnvironment(dateKey)), tide: tideIndex };
        } catch (error) {
            if (myRequest !== requestId) return;
            console.error('Failed to load environment data:', error);
            clearResults('Could not reach Open-Meteo for weather and river data.');
            toast('Could not load weather data.', 'error');
            return;
        }
        if (myRequest !== requestId) return;

        const environment = P.environmentFor(env, dateKey, hour);
        if (!environment.ok) {
            const messages = [];
            const when = `${dateKey} ${String(hour).padStart(2, '0')}:00`;
            if (environment.issues.some((i) => i.startsWith('tide bulletin'))) {
                messages.push(`The uploaded tide bulletin has no reading for ${dateKey}. Upload a bulletin that covers it.`);
            } else if (environment.issues.some((i) => i.startsWith('tide'))) {
                messages.push('The risk level also needs a few more days of tide readings in the uploaded bulletin.');
            }
            if (environment.issues.some((i) => i.startsWith('rain') || i.startsWith('river'))) {
                messages.push(`Open-Meteo doesn't have rainfall or river data for ${when} yet (it forecasts about 2 weeks ahead).`);
            }
            clearResults(messages.join(' '));
            return;
        }

        $('da-rainfall').value = environment.rainfallMm.toFixed(2);
        $('da-tide').value = environment.tideM.toFixed(2);
        const reading = environment.tideReading;
        const matchNote = $('da-tide-match-note');
        if (reading.distanceMinutes > P.CONFIG.tideMatchWarnMinutes) {
            matchNote.textContent = `⚠ Closest bulletin reading that day is at ${formatClock(reading.minutes)} (${reading.feet} ft) — ${(reading.distanceMinutes / 60).toFixed(1)} h from the selected time, so treat this value as unreliable.`;
            matchNote.style.color = 'var(--status-decl-text)';
        } else {
            matchNote.textContent = `Matched to the bulletin reading at ${formatClock(reading.minutes)} (${reading.feet} ft) — the closest on this date.`;
            matchNote.style.color = '';
        }
        const riskName = P.RISK_LEVELS[environment.riskLevel];
        setBadge($('da-risk-badge'), `${riskName} (level ${environment.riskLevel})`, riskName === 'LOW' ? 'HIGH' : (riskName === 'MODERATE' ? 'MODERATE' : 'LOW'));
        $('da-env-status').textContent = `Rainfall and river data from Open-Meteo for ${dateKey} ${String(hour).padStart(2, '0')}:00 (Hagonoy, Bulacan); tide from the uploaded LGU bulletin.`;

        if (!model || !area) {
            $('da-past-demand').value = '';
            $('da-value').textContent = '–';
            setBadge($('da-badge'), 'NOT TRAINED', null);
            $('da-range-warning').style.display = 'none';
            return;
        }

        const pastDemand = DA.pastDemandFor(model, area, hour);
        $('da-past-demand').value = pastDemand.toFixed(2);

        const input = {
            hour,
            dow: P.dayOfWeekOf(dateKey),
            area,
            pastDemand,
            rainfallMm: environment.rainfallMm,
            tideM: environment.tideM,
            riskLevel: environment.riskLevel
        };
        const value = DA.predict(model, input);
        const status = P.classify(value, model.thresholds);
        $('da-value').textContent = value.toFixed(2);
        setBadge($('da-badge'), status || 'SET THRESHOLDS', status);

        const outside = DA.outOfRangeInputs(model, input);
        const warning = $('da-range-warning');
        if (outside.length) {
            warning.textContent = `⚠ The ${outside.join(', ')} for this request is outside the range the model was trained on, so the prediction is an extrapolation and may be less reliable.`;
            warning.style.display = 'block';
        } else {
            warning.style.display = 'none';
        }
    }

    // ── Showing the trained model ──────────────────────────────────────
    function describeThresholds(thresholds) {
        if (!thresholds || thresholds.lowBelow == null || thresholds.highFrom == null) return 'not set';
        return `LOW < ${thresholds.lowBelow} · HIGH ≥ ${thresholds.highFrom}`;
    }

    function featureLabel(name) {
        if (name === 'hour') return 'Hour of day (x1)';
        if (name === 'day_of_week') return 'Day of week (x2, Monday = 0 … Sunday = 6)';
        if (name === 'past_ride_demand') return 'Past ride demand, rides per hour (x3)';
        if (name === 'rainfall_mm') return 'Rainfall, mm (x4)';
        if (name === 'tide_height_m') return 'Tide height, m (x5)';
        if (name === 'high_water_risk') return 'High-water risk level, 0–3 (x6)';
        if (name.startsWith('area:')) {
            const area = name.slice(5);
            const label = (model.areaLabels[area] && model.areaLabels[area].label) || area;
            return `Area: ${label} (compared with the baseline area)`;
        }
        return name;
    }

    function renderModelNote() {
        const note = $('da-model-note');
        if (!model) {
            note.textContent = 'No trained model yet. Use Model Training below once the app has logged some driver activity and completed rides.';
            return;
        }
        const when = new Date(model.trainedAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        note.textContent = `Multiple Linear Regression, last trained ${when} on ${model.metrics.records.toLocaleString()} hour-and-area records · R² ${fmt(model.metrics.r2, 3)} · average error ±${fmt(model.metrics.mae, 2)} drivers.`;
    }

    function renderScatter() {
        const canvas = $('da-scatter');
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
                    x: { title: { display: true, text: 'Actual available drivers' }, min: 0, grid: { color: '#F4F7FE' } },
                    y: { title: { display: true, text: 'Predicted' }, min: 0, grid: { color: '#F4F7FE' } }
                }
            }
        });
    }

    function renderTrainingResults() {
        const box = $('da-train-results');
        const thresholdBox = $('da-threshold-box');
        if (!model) {
            box.style.display = 'none';
            thresholdBox.style.display = 'none';
            return;
        }
        box.style.display = 'block';
        thresholdBox.style.display = 'block';

        const metricsBody = $('da-metrics-table').querySelector('tbody');
        clear(metricsBody);
        const tr = document.createElement('tr');
        cell(tr, `${model.metrics.trainRecords.toLocaleString()} / ${model.metrics.testRecords.toLocaleString()}${model.metrics.inSample ? ' (same data)' : ''}`);
        cell(tr, fmt(model.metrics.r2, 3));
        cell(tr, fmt(model.metrics.mae, 2));
        cell(tr, fmt(model.metrics.rmse, 2));
        cell(tr, describeThresholds(model.thresholds));
        metricsBody.appendChild(tr);
        $('da-metrics-note').textContent = model.metrics.inSample
            ? 'Fewer than 50 records, so these scores are measured on the same data the model was fitted on — they look better than they would on new data.'
            : 'Scores are measured on a random 20% of the records that were held out of training. Counts per area and hour are small, so R² is expected to be modest.';

        const coefBody = $('da-coef-table').querySelector('tbody');
        clear(coefBody);
        const interceptRow = document.createElement('tr');
        cell(interceptRow, 'Intercept (b0)', 'font-weight:600;');
        cell(interceptRow, fmt(model.intercept, 4));
        coefBody.appendChild(interceptRow);
        model.features.forEach((name) => {
            const row = document.createElement('tr');
            cell(row, featureLabel(name));
            const dropped = (model.dropped || []).includes(name);
            cell(row, dropped ? '— (no variation in data)' : fmt(model.coefficients[name], 4), dropped ? 'color:var(--text-muted);' : '');
            coefBody.appendChild(row);
        });

        const thresholds = model.thresholds || {};
        $('da-thr-low').value = thresholds.lowBelow == null ? '' : thresholds.lowBelow;
        $('da-thr-high').value = thresholds.highFrom == null ? '' : thresholds.highFrom;
        renderScatter();
    }

    function refreshAll() {
        renderAreaOptions();
        renderModelNote();
        renderTrainingResults();
    }

    // ── Loading the saved model ────────────────────────────────────────
    async function loadSavedModel() {
        if (loadingModel || !window.ParaFirestore) return;
        loadingModel = true;
        const tidePromise = loadTideBulletin();
        try {
            const saved = await window.ParaFirestore.fetchDriverAvailabilityModel();
            model = saved && Array.isArray(saved.features) ? saved : null;
            modelLoaded = true;
        } catch (error) {
            console.error('Failed to load the driver availability model:', error);
            $('da-model-note').textContent = 'Could not load the saved model from Firestore.';
        } finally {
            loadingModel = false;
        }
        await tidePromise;
        refreshAll();
        runPrediction();
    }

    // ── Training phase ─────────────────────────────────────────────────
    function setTrainStatus(text) {
        $('da-train-status').textContent = text;
    }

    function showTrainWarnings(warnings) {
        const box = $('da-train-warnings');
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

    async function trainModel() {
        if (!window.ParaFirestore) return;
        const button = $('da-train-btn');
        button.disabled = true;
        showTrainWarnings([]);
        const days = Number($('da-train-window').value) || 30;

        try {
            setTrainStatus('Reading the tide bulletin, driver activity and completed rides from Firestore…');
            await loadTideBulletin();
            if (!tideReadings.length) {
                throw new Error('Upload the LGU tide bulletin first — the model needs the tide for the dates it trains on.');
            }
            const raw = await window.ParaFirestore.fetchPredictionTrainingData(sinceForDays(days));
            raw.tide = tideReadings;
            const result = await DA.train(raw, { onProgress: setTrainStatus });

            // Keep thresholds the admin already confirmed instead of replacing
            // them with fresh suggestions on every retrain.
            const previous = model && model.thresholds;
            if (previous && previous.lowBelow != null && previous.highFrom != null) {
                result.model.thresholds = { lowBelow: previous.lowBelow, highFrom: previous.highFrom, suggested: false };
            }
            model = result.model;

            const warnings = [...result.warnings];
            try {
                await window.ParaFirestore.saveDriverAvailabilityModel(model);
            } catch (error) {
                console.error('Failed to save the driver availability model:', error);
                warnings.push('The model was trained but could not be saved to Firestore (check permissions), so it is only available until this page is reloaded.');
            }

            const s = result.summary;
            setTrainStatus(`Trained on ${s.records.toLocaleString()} hour-and-area records from ${s.from} to ${s.to} (${s.days} day${s.days === 1 ? '' : 's'}, ${s.areas} area${s.areas === 1 ? '' : 's'}) — ${s.driverLogs.toLocaleString()} driver location logs and ${s.rides.toLocaleString()} completed rides (${s.busyWindows.toLocaleString()} used as busy time). On average ${s.meanOnline.toFixed(1)} drivers online and ${s.meanBusy.toFixed(1)} busy per area and hour.`);
            showTrainWarnings(warnings);
            refreshAll();
            runPrediction();
            toast('Model trained.', 'success');
        } catch (error) {
            console.error('Training failed:', error);
            setTrainStatus(error.message || 'Training failed.');
            toast(error.message || 'Training failed.', 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function saveThresholds() {
        if (!model) return;
        const low = parseFloat($('da-thr-low').value);
        const high = parseFloat($('da-thr-high').value);
        if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high <= low) {
            toast('Enter two numbers where HIGH-from is larger than LOW-below.', 'error');
            return;
        }
        model.thresholds = { lowBelow: low, highFrom: high, suggested: false };
        try {
            await window.ParaFirestore.saveDriverAvailabilityModel(model);
            toast('Thresholds saved.', 'success');
        } catch (error) {
            console.error('Failed to save thresholds:', error);
            toast('Thresholds applied here, but could not be saved to Firestore.', 'error');
        }
        refreshAll();
        runPrediction();
    }

    // ── Wiring ─────────────────────────────────────────────────────────
    initInputs();
    renderAreaOptions();

    ['da-date', 'da-time', 'da-area'].forEach((id) => $(id).addEventListener('change', runPrediction));
    $('da-generate-btn').addEventListener('click', runPrediction);
    $('da-train-btn').addEventListener('click', trainModel);
    $('da-save-thresholds-btn').addEventListener('click', saveThresholds);

    const tideFileInput = $('da-tide-file');
    $('da-tide-upload-btn').addEventListener('click', () => tideFileInput.click());
    tideFileInput.addEventListener('change', async () => {
        const file = tideFileInput.files && tideFileInput.files[0];
        if (!file) return;
        try {
            await uploadTideBulletin(file);
        } finally {
            tideFileInput.value = '';
        }
    });

    // Load the saved model the first time the page is opened (the admin is
    // signed in by then).
    function onViewShown() {
        if (view.classList.contains('active') && !modelLoaded) loadSavedModel();
    }
    new MutationObserver(onViewShown).observe(view, { attributes: true, attributeFilter: ['class'] });
    onViewShown();
})();
