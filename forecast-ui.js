// Availability & Demand Forecast page (admin website).
//
// Two separately trained multiple linear regressions (see forecast.js):
//   Model A  passenger booking requests per barangay and hour
//   Model B  eligible, online, unoccupied drivers per barangay at the start of the hour
//
// The page does three different things, and keeps them apart:
//   TRAINING   learns coefficients from the last six months of Firestore records
//              (automatic, at most once a day, one browser at a time)
//   EVALUATION is shown as the scores of a trial model on later, unseen hours
//   INFERENCE  uses the saved models to forecast one of the next 24 whole hours
// Opening the page shows the NEXT hour. Past hours and anything beyond 24 hours
// ahead cannot be chosen.
(function () {
    'use strict';

    const P = window.ParaPrediction;
    const F = window.ParaForecast;
    const view = document.getElementById('view-driver-availability');
    if (!P || !F || !view) return;

    const $ = (id) => document.getElementById(id);
    const ALL = 'ALL';
    const ENV_CACHE_MS = 30 * 60 * 1000;
    const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const MODELS = [
        { key: 'demand', letter: 'A', title: 'Booking demand', unit: 'booking requests', totalId: 'demand' },
        { key: 'availability', letter: 'B', title: 'Driver availability', unit: 'available drivers', totalId: 'availability' }
    ];

    const state = { demand: null, availability: null, problems: {}, loaded: false };
    let lastAttempt = null;
    let trainNotes = [];
    let loadingModels = false;
    let training = false;
    let lastForecastAt = 0;
    let requestId = 0;
    let slotsBase = null;
    let tideReadings = [];
    let tideIndex = P.indexTide([]);
    const envCache = new Map();
    const lockOwner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // ── small helpers ──────────────────────────────────────────────────
    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'success');
    }

    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    const fmt = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
    const noStop = (text) => String(text || '').replace(/[.\s]+$/, '');
    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtWhen = (ms) => new Date(ms).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const clock = (hour) => `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
    const clockOfMinutes = (m) => `${Math.floor(m / 60) % 12 === 0 ? 12 : Math.floor(m / 60) % 12}:${pad2(m % 60)} ${Math.floor(m / 60) >= 12 ? 'PM' : 'AM'}`;
    const models = () => MODELS.map((m) => state[m.key]).filter(Boolean);
    const anyModel = () => state.demand || state.availability;

    function addTag(parent, text, kind) {
        parent.appendChild(make('span', `fx-tag${kind ? ` ${kind}` : ''}`, text));
    }

    function setLabel(el, text, kind) {
        el.textContent = text || '';
        el.className = `fx-label${kind ? ` ${kind}` : ''}`;
    }

    // Demand is not good or bad, so HIGH is blue and LOW is plain; for drivers
    // a LOW supply is the warning.
    function levelClass(modelKey, level) {
        if (!level) return '';
        if (modelKey === 'demand') return level === 'HIGH' ? 'demand-high' : (level === 'LOW' ? 'demand-low' : 'moderate');
        return level.toLowerCase();
    }

    function validityTag(parent, validity) {
        const v = (validity && validity.status) || 'UNVALIDATED';
        addTag(parent, v === 'VALIDATED' ? 'Validated' : (v === 'EXPLORATORY' ? 'Exploratory' : 'Not evaluated'), v === 'VALIDATED' ? 'good' : (v === 'EXPLORATORY' ? 'warn' : 'bad'));
    }

    // ── target-hour choices: the next 24 whole hours ───────────────────
    function slotLabel(slot, todayKey) {
        const day = slot.dateKey === todayKey ? 'today' : (slot.dateKey === P.addDays(todayKey, 1) ? 'tomorrow' : slot.dateKey);
        const prefix = slot.hoursAhead === 1 ? 'Next hour · ' : '';
        return `${prefix}${clock(slot.hour)}–${pad2(slot.hour)}:59, ${day} (${slot.hoursAhead} h ahead)`;
    }

    function buildSlots() {
        const slots = F.forecastSlots(Date.now());
        const select = $('fx-slot');
        if (slotsBase === slots[0].targetMs && select.options.length === slots.length) return slots;
        const previous = Number(select.value);
        clear(select);
        const todayKey = P.manilaParts(Date.now()).dateKey;
        slots.forEach((slot) => {
            const option = make('option', '', slotLabel(slot, todayKey));
            option.value = String(slot.targetMs);
            select.appendChild(option);
        });
        const keep = slots.find((s) => s.targetMs === previous);
        select.value = String((keep || slots[0]).targetMs);
        slotsBase = slots[0].targetMs;
        return slots;
    }

    function buildAreas() {
        const select = $('fx-area');
        if (select.options.length) return;
        const all = make('option', '', 'All barangays (total)');
        all.value = ALL;
        select.appendChild(all);
        P.HAGONOY_BARANGAYS.forEach((name) => {
            const option = make('option', '', `${name} (${P.todasOf(name).join(' / ')})`);
            option.value = name;
            select.appendChild(option);
        });
    }

    function selectedSlot() {
        const slots = buildSlots();
        const wanted = Number($('fx-slot').value);
        return slots.find((s) => s.targetMs === wanted) || slots[0];
    }

    // ── tide data (uploaded Excel, stored in Firestore) ────────────────
    function setTideReadings(readings) {
        tideReadings = readings;
        tideIndex = P.indexTide(readings);
        const status = $('fc-tide-file-status');
        if (!tideIndex.dates.length) { status.textContent = 'No tide data loaded yet.'; return; }
        const first = tideIndex.dates[0];
        const last = tideIndex.dates[tideIndex.dates.length - 1];
        status.textContent = `${readings.length} reading${readings.length === 1 ? '' : 's'} loaded · ${first}${first === last ? '' : ` to ${last}`}`;
    }

    async function loadTideBulletin() {
        if (!window.ParaFirestore) return;
        try {
            const since = P.addDays(P.trainingWindow(Date.now()).startKey, -(P.CONFIG.baselineDays + 2));
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
            const kept = tideReadings.filter((r) => !readings.some((n) => n.dateKey === r.dateKey));
            setTideReadings([...kept, ...readings]);
        }
        // New tide data can change which predictors the models may use.
        if (!(state.demand && state.availability) || (lastAttempt && lastAttempt.ok === false)) await trainModels();
        runForecast();
    }

    async function clearTideData() {
        if (!window.ParaFirestore) return;
        if (!tideReadings.length) { toast('There is no tide data to clear.', 'error'); return; }
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
        runForecast();
    }

    // ── weather inputs ─────────────────────────────────────────────────
    function getEnvironment(dateKey) {
        const from = P.addDays(dateKey, -P.CONFIG.baselineDays);
        const to = P.addDays(dateKey, P.CONFIG.dischargeAheadDays + 1);
        const key = `${from}|${to}`;
        const cached = envCache.get(key);
        if (cached && Date.now() - cached.at < ENV_CACHE_MS) return cached.promise;
        const promise = P.loadEnvironment(from, to).catch((error) => { envCache.delete(key); throw error; });
        envCache.set(key, { at: Date.now(), promise });
        return promise;
    }

    function showConditions(env, slot, environment) {
        $('fx-rain').textContent = '—';
        $('fx-tide').textContent = '—';
        $('fx-env-note').textContent = '';
        const rainMm = env.rain.get(P.hourKey(slot.dateKey, slot.hour));
        if (rainMm !== undefined) $('fx-rain').textContent = `${rainMm.toFixed(2)} mm · ${P.rainLabel(rainMm)}`;
        const mid = slot.hour * 60 + 30;
        const nearest = P.nearestTideReading(tideIndex, slot.dateKey, mid);
        const reading = nearest ? (P.tideAt(tideIndex, slot.dateKey, mid) || { ...nearest, interpolated: false }) : null;
        if (reading) {
            const level = P.tideLabel(reading.meters, P.tideLevels(tideIndex));
            $('fx-tide').textContent = `${reading.feet.toFixed(1)} ft${level ? ` · ${level}` : ''}`;
            if (!reading.interpolated && nearest.distanceMinutes > P.CONFIG.tideMatchWarnMinutes) {
                $('fx-env-note').textContent = `The nearest tide reading that day is at ${clockOfMinutes(nearest.minutes)}, ${(nearest.distanceMinutes / 60).toFixed(1)} h away, so the tide may not be reliable.`;
            }
        } else {
            $('fx-env-note').textContent = `No tide reading for ${slot.dateKey}.`;
        }
    }

    // ── forecasts and charts ───────────────────────────────────────────
    const charts = {};
    const COLORS = { demand: '#1a73e8', availability: '#05CD99', p33: '#F0A30A', p67: '#E31A1A' };

    function destroyCharts() {
        Object.keys(charts).forEach((k) => { charts[k].destroy(); delete charts[k]; });
    }

    // How far off the forecast usually was on hours the model had not seen (MAE of the trial model).
    function showError(area) {
        const parts = [];
        MODELS.forEach((m) => {
            const e = state[m.key] && state[m.key].evaluation;
            if (!e || !e.performed) return;
            const v = area === ALL ? e.totalMae : e.model.mae;
            if (Number.isFinite(v)) parts.push(`${v.toFixed(1)} ${m.key === 'demand' ? 'requests' : 'drivers'}`);
        });
        $('fx-error').textContent = parts.length ? parts.join(' · ') : '—';
    }

    function resetForecast(message) {
        $('fx-error').textContent = '—';
        MODELS.forEach((m) => {
            $(`fx-${m.totalId}-total`).textContent = '—';
            setLabel($(`fx-${m.totalId}-total-label`), '', '');
        });
        destroyCharts();
        $('fx-balance-status').textContent = '—';
        $('fx-balance-status').className = 'fx-balance-status';
        $('fx-balance-detail').textContent = '';
        $('fx-balance-chart').style.display = 'none';
        $('fx-message').textContent = message || '';
    }

    function unavailableMessage() {
        if (training) return 'Updating the models. This can take a minute or two.';
        const problems = Object.values(state.problems).filter(Boolean);
        const detail = lastAttempt && lastAttempt.message ? ` Latest training attempt: ${noStop(lastAttempt.message)}.` : '';
        const rejected = problems.length ? ` A saved model was rejected: ${noStop(problems[0])}.` : '';
        return `Forecast unavailable: insufficient validated historical data.${rejected}${detail}`;
    }

    async function environmentOf(slot) {
        const env = { ...(await getEnvironment(slot.dateKey)), tide: tideIndex };
        return { env, environment: P.environmentFor(env, slot.dateKey, slot.hour) };
    }

    // One prediction for one slot: a barangay, or all barangays added up.
    // Throws when the model cannot forecast it (no history, missing input, …).
    function predictFor(model, slot, environment, area) {
        const dow = P.dayOfWeekOf(slot.dateKey);
        const one = (name) => F.predictDetailed(model, F.inputFor(model, environment, { hour: slot.hour, dow, area: name }));
        if (area === ALL) {
            let sum = 0;
            let counted = 0;
            P.HAGONOY_BARANGAYS.forEach((name) => {
                if (!model.areas.includes(name)) return;
                sum += one(name).nonNegative;
                counted += 1;
            });
            if (!counted) throw new Error('The model has no records for any barangay.');
            const value = Math.round(sum);
            return { value, level: F.classifyCount(value, F.thresholdsFor(model, true)), counted };
        }
        if (!model.areas.includes(area)) throw new Error(`This model has no records for ${area}.`);
        const detail = one(area);
        return { value: detail.display, level: F.classifyCount(detail.display, F.thresholdsFor(model, false)), raw: detail.raw, clipped: detail.clipped, counted: 1 };
    }

    // Axis labels in plain words: "10 AM", with the weekday under the first hour and
    // under every midnight, so "12 AM" is clearly the start of the next day.
    const tickLabel = (slot, index) => {
        const base = `${slot.hour % 12 === 0 ? 12 : slot.hour % 12} ${slot.hour >= 12 ? 'PM' : 'AM'}`;
        return index === 0 || slot.hour === 0 ? [base, DOW_NAMES[P.dayOfWeekOf(slot.dateKey)].slice(0, 3)] : base;
    };
    const fullSlotLabel = (slot) => `${DOW_NAMES[P.dayOfWeekOf(slot.dateKey)]} ${clock(slot.hour)}–${pad2(slot.hour)}:59 (${slot.hoursAhead} h ahead)`;

    // Predicted requests against predicted drivers, judged against history.
    function showBalance(slot, area, results, series, slots) {
        const status = $('fx-balance-status');
        const detail = $('fx-balance-detail');
        status.className = 'fx-balance-status';
        status.textContent = '—';
        detail.textContent = '';
        destroyCharts(); // the old chart must go before a new one can use the canvas
        $('fx-balance-chart').style.display = 'none';
        const bal = state.demand && state.demand.balance;
        if (!state.demand || !state.availability) { detail.textContent = 'Both forecasts are needed to compare bookings with drivers.'; return; }
        if (!results.demand || !results.availability) { detail.textContent = 'Not available for this hour.'; return; }
        const req = results.demand.value;
        const drv = results.availability.value;
        const ratio = req / Math.max(drv, 1);
        const people = `${req} booking request${req === 1 ? '' : 's'} expected, ${drv} driver${drv === 1 ? '' : 's'} available.`;
        if (!bal) { detail.textContent = people; return; }
        const th = area === ALL ? bal.allBarangays : bal.perBarangayHour;
        const level = F.classifyCount(ratio, th);
        if (!level) { detail.textContent = people; return; }
        const none = drv === 0 && req > 0;
        const words = {
            LOW: ['Enough drivers for the bookings', 'enough', 'Drivers should be able to cover the expected bookings.'],
            MODERATE: ['Drivers and bookings are balanced', 'balanced', 'About the usual balance for this hour.'],
            HIGH: ['Not enough drivers for the bookings', 'short', 'More bookings than usual for the drivers available.']
        }[level];
        status.textContent = none ? 'No drivers available for the bookings' : words[0];
        status.classList.add(none ? 'short' : words[1]);
        detail.textContent = `${people} ${none ? 'Bookings may go unanswered.' : words[2]}`;
        if (typeof Chart !== 'undefined' && $('fx-line-balance')) {
            $('fx-balance-chart').style.display = 'block';
            const selectedIndex = slots.findIndex((x) => x.targetMs === slot.targetMs);
            // a shaded band marks the hour chosen in the Target hour dropdown
            const hourBand = {
                id: 'hourBand',
                beforeDatasetsDraw(chart) {
                    const point = chart.getDatasetMeta(0).data[selectedIndex];
                    if (!point) return;
                    const { ctx, chartArea } = chart;
                    const width = Math.max(14, chartArea.width / slots.length);
                    ctx.save();
                    ctx.fillStyle = 'rgba(27, 37, 75, 0.12)';
                    ctx.fillRect(point.x - width / 2, chartArea.top, width, chartArea.height);
                    ctx.restore();
                }
            };
            charts.balance = new Chart($('fx-line-balance').getContext('2d'), {
                plugins: [hourBand],
                type: 'line',
                data: {
                    labels: slots.map(tickLabel),
                    datasets: [
                        { label: 'Predicted booking requests', data: series.demand, borderColor: COLORS.demand, backgroundColor: COLORS.demand, borderWidth: 2, tension: 0.25, pointRadius: slots.map((x, i) => (i === selectedIndex ? 8 : 2)), pointBackgroundColor: slots.map((x, i) => (i === selectedIndex ? '#1B254B' : COLORS.demand)) },
                        { label: 'Predicted available drivers', data: series.availability, borderColor: COLORS.availability, backgroundColor: COLORS.availability, borderWidth: 2, tension: 0.25, pointRadius: slots.map((x, i) => (i === selectedIndex ? 8 : 2)), pointBackgroundColor: slots.map((x, i) => (i === selectedIndex ? '#1B254B' : COLORS.availability)) }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { title: (items) => fullSlotLabel(slots[items[0].dataIndex]) } } },
                    scales: { y: { min: 0, title: { display: true, text: 'count' }, grid: { color: '#F4F7FE' } }, x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } } }
                }
            });
        }
    }

    // Predicted against actual on the hours the trial model never saw.
    const evidenceCharts = {};
    function drawEvidence() {
        if (typeof Chart === 'undefined') return;
        Object.keys(evidenceCharts).forEach((k) => { evidenceCharts[k].destroy(); delete evidenceCharts[k]; });
        MODELS.forEach((m) => {
            const model = state[m.key];
            const canvas = $(`fx-scatter-${m.key}`);
            if (!canvas) return;
            canvas.parentNode.style.display = model && model.testPoints && model.testPoints.length ? 'block' : 'none';
            if (!model || !model.testPoints || !model.testPoints.length) return;
            const points = model.testPoints.map((p) => ({ x: p.a, y: p.p }));
            const top = Math.max(1, ...points.map((p) => Math.max(p.x, p.y)));
            evidenceCharts[m.key] = new Chart(canvas.getContext('2d'), {
                type: 'scatter',
                data: { datasets: [
                    { label: 'Held-out barangay-hours', data: points, backgroundColor: `${COLORS[m.key]}88`, pointRadius: 3 },
                    { type: 'line', label: 'Perfect prediction', data: [{ x: 0, y: 0 }, { x: top, y: top }], borderColor: '#1B254B', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }
                ] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
                    scales: { x: { min: 0, title: { display: true, text: `Actual ${m.unit}` }, grid: { color: '#F4F7FE' } }, y: { min: 0, title: { display: true, text: 'Predicted' }, grid: { color: '#F4F7FE' } } }
                }
            });
        });
    }

    async function runForecast() {
        const slot = selectedSlot();
        const area = $('fx-area').value || ALL;
        const mine = ++requestId;
        MODELS.forEach((m) => {
            $(`fx-${m.totalId}-total-name`).textContent = `Model ${m.letter} · ${m.key === 'demand' ? 'Booking requests' : 'Available drivers'}, ${area === ALL ? 'all barangays' : area}`;
        });
        if (!anyModel()) {
            resetForecast(state.loaded ? unavailableMessage() : 'Loading the saved models…');
            return;
        }
        let main;
        try {
            main = await environmentOf(slot);
        } catch (error) {
            if (mine !== requestId) return;
            console.error('Failed to load environment data:', error);
            resetForecast('Weather data could not be loaded, so no forecast can be made.');
            return;
        }
        if (mine !== requestId) return;
        showConditions(main.env, slot, main.environment);
        if (!main.environment.ok) {
            resetForecast(`A required weather input is missing (${main.environment.issues.join('; ')}), so no forecast is shown. Nothing is filled in.`);
            return;
        }

        // the next 24 hours for the chosen barangay (or all), and every barangay at the chosen hour
        const slots = F.forecastSlots(Date.now());
        const series = {};
        MODELS.forEach((m) => { series[m.key] = []; });
        for (const s of slots) {
            let envs = null;
            try { envs = await environmentOf(s); } catch (error) { envs = null; }
            MODELS.forEach((m) => {
                let value = null;
                const model = state[m.key];
                if (model && envs && envs.environment.ok) {
                    try { value = predictFor(model, s, envs.environment, area).value; } catch (error) { value = null; }
                }
                series[m.key].push(value);
            });
        }
        if (mine !== requestId) return;
        const notes = [];
        const headline = {};
        MODELS.forEach((m) => {
            const model = state[m.key];
            const totalEl = $(`fx-${m.totalId}-total`);
            const labelEl = $(`fx-${m.totalId}-total-label`);
            totalEl.textContent = '—';
            setLabel(labelEl, '', '');
            if (!model) {
                notes.push(`${m.title}: no valid model (${noStop(state.problems[m.key] || (lastAttempt && lastAttempt.unavailable && lastAttempt.unavailable[m.key]) || 'not trained yet')}).`);
                return;
            }
            try {
                const result = predictFor(model, slot, main.environment, area);
                headline[m.key] = result;
                totalEl.textContent = String(result.value);
                setLabel(labelEl, result.level || 'n/a', levelClass(m.key, result.level));
                totalEl.title = result.raw != null ? `Raw model value ${result.raw.toFixed(3)}${result.clipped ? ' (below 0, shown as 0)' : ''}` : '';
                if (area === ALL && result.counted < P.HAGONOY_BARANGAYS.length) notes.push(`${m.title}: the total covers ${result.counted} of ${P.HAGONOY_BARANGAYS.length} barangays (the model has no records for the others).`);
                const probe = F.inputFor(model, main.environment, { hour: slot.hour, dow: P.dayOfWeekOf(slot.dateKey), area: model.areas[0], histMean: 0 });
                const out = F.outOfRangeInputs(model, probe);
                if (out.length) notes.push(`${m.title}: the ${out.join(', ')} is outside the range the model was trained on, so this is an extrapolation.`);
            } catch (error) {
                notes.push(`${m.title}: no forecast (${noStop(error.message)}).`);
            }
        });
        $('fx-message').textContent = notes.join(' ');
        showBalance(slot, area, headline, series, slots);
        showError(area);
        lastForecastAt = Date.now();
        renderStatusLines();
    }

    // ── model status ───────────────────────────────────────────────────
    function addRow(box, name, value) {
        const row = make('div', 'fx-row');
        row.appendChild(make('span', '', name));
        row.appendChild(make('span', '', value));
        box.appendChild(row);
    }

    function featureLabel(model, name) {
        if (name.startsWith('hour:')) return `Hour of day: ${clock(Number(name.slice(5)))} vs 12:00 AM`;
        if (name.startsWith('dow:')) return `Day of week: ${DOW_NAMES[Number(name.slice(4))]} vs Monday`;
        if (name.startsWith('area:')) return `Barangay: ${name.slice(5)} vs ${model.areaBaseline}`;
        if (name === 'history_mean') return 'Historical mean for the same barangay, weekday and hour';
        if (name === 'rainfall_mm') return 'Rainfall in the target hour (mm)';
        if (name === 'tide_height_m') return 'Tide height (m)';
        return name;
    }

    const prettyDate = (dateKey) => {
        const [y, mo, d] = String(dateKey).split('-').map(Number);
        return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    };

    function renderModelBox(m) {
        const model = state[m.key];
        const box = make('div', 'fx-model');
        const h = make('h4', '', m.key === 'demand' ? 'Booking demand' : 'Driver availability');
        box.appendChild(h);
        if (!model) {
            addTag(h, 'Not available', 'bad');
            addRow(box, 'Status', 'No valid model yet.');
            return box;
        }
        validityTag(h, model.validity);
        const c = model.coverage;
        const e = model.evaluation;
        const reasons = [];
        if (!e.performed) reasons.push('not tested on a later period yet');
        else if (e.beatsBaseline === false) reasons.push('not yet better than a simple weekday-and-hour average');
        if (c.usableDays < P.CONFIG.preliminaryDays) reasons.push(`only ${Math.min(c.usableDays, c.windowDays)} days of data`);
        if (model.adequacy && model.adequacy.thin) reasons.push('little data for the number of factors used');
        addRow(box, 'Status', model.validity.status === 'VALIDATED' ? 'Validated' : `Still being tested${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
        addRow(box, 'Last trained', fmtWhen(model.trainedAt));
        addRow(box, 'Data used', `${prettyDate(c.windowStartKey)} to ${prettyDate(c.windowEndKey)} (${Math.min(c.usableDays, c.windowDays)} days)`);
        addRow(box, 'Barangays', `${model.areaCount}`);
        if (e.performed) {
            addRow(box, 'Tested on', `${prettyDate(e.testFrom)} to ${prettyDate(e.testTo)}`);
            addRow(box, 'Average error (MAE)', `${fmt(e.model.mae, 2)} (simple average: ${fmt(e.baseline.mae, 2)})`);
            addRow(box, 'Typical error (RMSE)', `${fmt(e.model.rmse, 2)} (simple average: ${fmt(e.baseline.rmse, 2)})`);
            addRow(box, 'R²', `${fmt(e.model.r2, 2)} (simple average: ${fmt(e.baseline.r2, 2)})`);
        }
        const t = model.thresholds;
        const ta = model.thresholdsAll;
        if (t.available) addRow(box, 'Low / High cut-offs, one barangay', `Low up to ${fmt(t.p33, 1)}, High above ${fmt(t.p67, 1)}`);
        if (ta.available) addRow(box, 'Low / High cut-offs, all barangays', `Low up to ${fmt(ta.p33, 1)}, High above ${fmt(ta.p67, 1)}`);
        addRow(box, 'Tide used', model.tideMode === 'with_tide' ? 'Yes' : 'No');

        const details = make('details', 'fx-details');
        details.appendChild(make('summary', '', 'Equation'));
        const table = make('table', 'data-table fx-table');
        const body = make('tbody');
        const addCoef = (label, value) => { const tr = make('tr'); tr.appendChild(make('td', '', label)); tr.appendChild(make('td', 'fx-num', value)); body.appendChild(tr); };
        addCoef(`Starting value (${model.areaBaseline})`, fmt(model.intercept, 4));
        model.features.forEach((name) => addCoef(featureLabel(model, name), (model.dropped || []).includes(name) ? '—' : fmt(model.coefficients[name], 4)));
        table.appendChild(body);
        details.appendChild(table);
        box.appendChild(details);
        return box;
    }

    function renderModels() {
        const holder = $('fx-models');
        clear(holder);
        MODELS.forEach((m) => holder.appendChild(renderModelBox(m)));
    }

    function renderMethod() {
        const el = $('fx-method');
        el.textContent = [
            'The system learns from the last six months of bookings and driver activity. For every barangay and every hour it looks at the day of the week, the hour, the barangay, what usually happens at that time, the rain and the tide.',
            'A multiple linear regression turns these into one equation that predicts the number of booking requests (Model A) or the number of available drivers (Model B). The numbers in the equation are learned from the records, not set by hand.',
            'Each model is checked on a later period it was not trained on, and compared with a simple average for the same weekday and hour. Low, Moderate and High compare a prediction with that model\'s own past figures.',
            'Forecasts refresh every hour. The models are retrained once a day.'
        ].join('\n\n');
        el.style.whiteSpace = 'pre-line';
    }

    // Last successful training, last forecast refresh and how retraining is scheduled.
    function renderStatusLines() {
        const box = $('fx-status-lines');
        clear(box);
        const line = (label, value) => { const d = make('div'); d.appendChild(make('b', '', `${label}: `)); d.appendChild(document.createTextNode(value)); box.appendChild(d); };
        const trained = MODELS.map((m) => state[m.key] && state[m.key].trainedAt).filter(Boolean);
        line('Models last trained', trained.length ? fmtWhen(Math.min(...trained)) : 'not yet');
        line('Forecast updated', lastForecastAt ? fmtWhen(lastForecastAt) : 'not yet');
    }

    function renderAll() {
        renderStatusLines();
        buildSlots();
        renderModels();
        renderMethod();
    }

    // ── loading and training ───────────────────────────────────────────
    function setTrainStatus(text) { $('fx-train-status').textContent = text; }

    async function loadModels() {
        state.problems = {};
        const docs = await Promise.all(MODELS.map((m) => window.ParaFirestore.fetchPredictionModel(m.key)));
        MODELS.forEach((m, i) => {
            state[m.key] = null;
            if (!docs[i]) return;
            const check = F.validateArtifact(docs[i]);
            if (check.ok) state[m.key] = docs[i];
            else state.problems[m.key] = check.problems.join('; ');
        });
        state.loaded = true;
    }

    function needsTraining() {
        const today = P.manilaParts(Date.now()).dateKey;
        const stale = MODELS.some((m) => !state[m.key] || F.needsRetrain(state[m.key], Date.now()));
        if (!stale) return false;
        // do not hammer the database right after a failed attempt (15 minutes), but
        // never block a retry for the rest of the day: the data may have changed
        const recent = lastAttempt && lastAttempt.attemptDateKey === today && Number.isFinite(lastAttempt.attemptedAt) && Date.now() - lastAttempt.attemptedAt < 15 * 60 * 1000;
        return !(recent && !(state.demand && state.availability));
    }

    async function loadSavedModels() {
        if (loadingModels || !window.ParaFirestore) return;
        loadingModels = true;
        let failed = false;
        const tidePromise = loadTideBulletin();
        try {
            await loadModels();
            try { lastAttempt = await window.ParaFirestore.fetchPredictionTrainingStatus(); } catch (error) { lastAttempt = null; }
        } catch (error) {
            failed = true;
            console.error('Failed to load the saved models:', error);
            setTrainStatus('Could not load the saved models.');
        } finally {
            loadingModels = false;
        }
        await tidePromise;
        renderAll();
        runForecast();
        if (!failed && needsTraining()) await trainModels();
    }

    function summaryText(s) {
        return `Trained on ${s.records.toLocaleString()} barangay-hour records (${s.days} day${s.days === 1 ? '' : 's'}, ${s.areas} barangay${s.areas === 1 ? '' : 's'}, ${s.from} to ${s.to}) inside the six-month window ${s.window.from} to ${s.window.to}: ${s.requests.toLocaleString()} booking requests and ${s.driverLogs.toLocaleString()} driver log entries.`;
    }

    // Reads Firestore only, never substitutes generated data, never saves a
    // model that failed a check, never replaces the last valid model on failure.
    async function trainModels() {
        if (!window.ParaFirestore || training) return;
        training = true;
        $('fx-train-btn').disabled = true;
        $('fx-train-btn').textContent = 'Updating… please wait';
        if (!anyModel()) resetForecast(unavailableMessage());
        const today = P.manilaParts(Date.now()).dateKey;
        let locked = false;
        try {
            locked = await window.ParaFirestore.acquirePredictionLock(lockOwner);
            if (!locked) { setTrainStatus('Another administrator\'s browser is training the models right now. Reload in a few minutes.'); return; }
            setTrainStatus('Reading the records…');
            await loadTideBulletin();
            const since = new Date(P.trainingWindow(Date.now()).lookbackStartMs);
            const raw = await window.ParaFirestore.fetchPredictionTrainingData(since, { schema: P.CONFIG.dataSchema, plausibleFromMs: P.CONFIG.plausibleFromMs });
            raw.tide = tideReadings;
            const result = await F.train(raw, { onProgress: setTrainStatus });
            const warnings = [...result.warnings];
            const saved = {};
            const kept = {};
            const saveErrors = [];
            for (const m of MODELS) {
                const model = result.models[m.key];
                if (!model) continue;
                const current = state[m.key];
                if (current && model.validity.status === 'UNVALIDATED' && current.validity && current.validity.status !== 'UNVALIDATED') {
                    // a new model that could not be evaluated never replaces a model that was
                    kept[m.key] = true;
                    warnings.push(`The new ${m.title.toLowerCase()} model could not be evaluated on a later period, so the previous model (trained ${fmtWhen(current.trainedAt)}) was kept.`);
                    continue;
                }
                try {
                    await window.ParaFirestore.savePredictionModel(m.key, model);
                    state[m.key] = model;
                    state.problems[m.key] = '';
                    saved[m.key] = true;
                } catch (error) {
                    console.error(`Failed to save the ${m.key} model:`, error);
                    saveErrors.push(`${m.title}: ${error.message}`);
                    warnings.push(`The ${m.title.toLowerCase()} model was trained but NOT saved (${error.message}). The previous saved model, if any, was kept.`);
                }
            }
            const ok = Boolean((saved.demand || kept.demand) && (saved.availability || kept.availability));
            const note = ok ? 'Both models trained and saved.' : `Not every model could be built: ${Object.entries(result.unavailable).map(([k, v]) => `${k}: ${v}`).join(' ') || 'a save was refused.'}${saveErrors.length ? ` Save error: ${saveErrors.join(' | ')}.` : ''} Previous saved models were kept.`;
            lastAttempt = { ok, attemptDateKey: today, message: ok ? '' : note, built: { demand: Boolean(saved.demand), availability: Boolean(saved.availability) }, unavailable: result.unavailable };
            try { await window.ParaFirestore.savePredictionTrainingStatus(lastAttempt); } catch (error) { console.warn('Could not record the training attempt.', error); }
            trainNotes = warnings;
            setTrainStatus(ok ? 'Models updated.' : note);
            if (saved.demand || saved.availability) toast('Models updated.', 'success');
        } catch (error) {
            console.error('Training did not complete:', error);
            lastAttempt = { ok: false, attemptDateKey: today, message: error.message || 'Training failed.', built: { demand: false, availability: false }, unavailable: {} };
            if (locked) { try { await window.ParaFirestore.savePredictionTrainingStatus(lastAttempt); } catch (e) { /* not critical */ } }
            setTrainStatus(`Training did not complete: ${noStop(error.message) || 'unknown error'}.${anyModel() ? ' The last valid model was kept and is shown as stale until training succeeds.' : ' There is no valid model yet.'}`);
        } finally {
            if (locked) { try { await window.ParaFirestore.releasePredictionLock(lockOwner); } catch (e) { console.warn('Could not release the training lock.', e); } }
            training = false;
            $('fx-train-btn').disabled = false;
            $('fx-train-btn').textContent = 'Update models now';
        }
        renderAll();
        runForecast();
    }

    // ── wiring ─────────────────────────────────────────────────────────
    buildSlots();
    renderMethod();
    resetForecast('Loading the saved models…');
    buildAreas();
    const topDetails = document.querySelector('.fx-top-details');
    if (topDetails) topDetails.addEventListener('toggle', () => { if (topDetails.open) drawEvidence(); });
    $('fx-area').addEventListener('change', runForecast);
    $('fx-slot').addEventListener('change', runForecast);
    $('fx-train-btn').addEventListener('click', () => {
        if (training) return;
        if (!window.confirm('Update both models now? This can take a couple of minutes. The current models are kept if it fails.')) return;
        lastAttempt = null;
        trainModels();
    });
    $('fc-tide-clear-btn').addEventListener('click', clearTideData);
    const fileInput = $('fc-tide-file');
    $('fc-tide-upload-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try { await uploadTideBulletin(file); } finally { fileInput.value = ''; }
    });

    let loadedOnce = false;
    function onViewShown() {
        if (!view.classList.contains('active')) return;
        if (!loadedOnce) { loadedOnce = true; loadSavedModels(); } else { buildSlots(); runForecast(); }
    }
    new MutationObserver(onViewShown).observe(view, { attributes: true, attributeFilter: ['class'] });
    // the next-hour list moves forward as the clock does
    setInterval(() => {
        if (!view.classList.contains('active') || training) return;
        const before = slotsBase;
        buildSlots();
        if (slotsBase !== before) runForecast();
    }, 60 * 1000);
    onViewShown();
})();
