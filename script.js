document.addEventListener('DOMContentLoaded', () => {

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── Toast System ──────────────────────────────────────────────
    function showToast(msg, type = 'success') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '✓', error: '✕', warning: '⚠' };
        const icon = document.createElement('span');
        icon.style.fontSize = '16px';
        icon.textContent = icons[type] || '✓';
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(' ' + msg));
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
    window.showToast = showToast;

    // ── Generic Dropdown Registration ────────────────────────────
    const activeDropdowns = new Set();

    function registerDropdown(btnId, dropId) {
        const btn = document.getElementById(btnId);
        const drop = document.getElementById(dropId);
        if (!btn || !drop) return;

        btn.addEventListener('click', (e) => {
            const isOpen = drop.classList.toggle('show');
            if (isOpen) {
                activeDropdowns.add(drop);
            } else {
                activeDropdowns.delete(drop);
            }
            e.stopPropagation();
        });

        drop.addEventListener('click', (e) => e.stopPropagation());

        drop.querySelectorAll('.dropdown-item').forEach((item) => {
            item.addEventListener('click', () => {
                drop.classList.remove('show');
                activeDropdowns.delete(drop);
            });
        });
    }

    document.addEventListener('click', () => {
        activeDropdowns.forEach((drop) => {
            drop.classList.remove('show');
        });
        activeDropdowns.clear();
    });

    registerDropdown('statusFilterBtn', 'statusDropdown');
    registerDropdown('dashboardDateBtn', 'dashboardDateDropdown');
    registerDropdown('chartFilterBtn', 'chartFilterDropdown');
    registerDropdown('driverVerificationStatusBtn', 'driverVerificationStatusDropdown');
    registerDropdown('driverMgmtStatusBtn', 'driverMgmtStatusDropdown');
    registerDropdown('driverMgmtSortBtn', 'driverMgmtSortDropdown');
    registerDropdown('passengerMgmtStatusBtn', 'passengerMgmtStatusDropdown');
    registerDropdown('complaintStatusBtn', 'complaintStatusDropdown');

    // ── SPA Router ────────────────────────────────────────────────
    const navLinks = document.querySelectorAll('.nav-link');
    const views = document.querySelectorAll('.view-section');

    // Sidebar groups that collapse several views under one expandable parent link.
    const navGroups = [
        { groupId: 'reportsNavGroup', childViews: ['reports', 'driver-prediction'] }
    ];

    function switchView(viewId) {
        navLinks.forEach(link => link.classList.toggle('active', link.dataset.view === viewId));
        views.forEach(view => view.classList.toggle('active', view.id === 'view-' + viewId));
        // Update page title in topbar breadcrumb
        const breadcrumb = document.getElementById('topbar-title');
        if (breadcrumb) {
            const activeLink = document.querySelector(`.nav-link[data-view="${viewId}"] span`);
            breadcrumb.textContent = activeLink ? activeLink.textContent : '';
        }
        // Sync the parent toggle's highlight/expansion to whichever child view is active.
        navGroups.forEach(({ groupId, childViews }) => {
            const group = document.getElementById(groupId);
            if (!group) return;
            const isChildActive = childViews.includes(viewId);
            const parentToggle = group.querySelector('.nav-parent');
            if (parentToggle) parentToggle.classList.toggle('active', isChildActive);
            if (isChildActive) group.classList.add('expanded');
        });
    }

    document.body.addEventListener('click', (e) => {
        const link = e.target.closest('[data-view]');
        if (link) {
            e.preventDefault();
            const viewId = link.dataset.view;
            if (viewId) { switchView(viewId); window.location.hash = viewId; }
            return;
        }
        const parentToggle = e.target.closest('.nav-parent');
        if (parentToggle) {
            e.preventDefault();
            const group = parentToggle.closest('.nav-group');
            if (group) group.classList.toggle('expanded');
        }
    });

    const initialHash = window.location.hash.replace('#', '');
    if (initialHash && document.getElementById('view-' + initialHash)) {
        switchView(initialHash);
    } else {
        switchView('dashboard');
    }

    // ── Notification Audience Selection ─────────────────────────
    const notificationChips = document.querySelectorAll('.target-chip');
    window.selectedNotificationAudience = 'allDrivers';

    notificationChips.forEach((chip) => {
        chip.addEventListener('click', () => {
            notificationChips.forEach((item) => item.classList.remove('selected'));
            chip.classList.add('selected');
            window.selectedNotificationAudience = chip.dataset.target || 'allDrivers';
        });
    });

    // ── Charts ────────────────────────────────────────────────────
    const chartDefaults = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } } },
    };

    const gridColor = '#F4F7FE';
    let dashboardBookings = [];
    let dashboardChart = null;
    let monthlyRidesChart = null;
    let peakHoursRidesChart = null;
    let passengerDemandChart = null;
    let paymentMethodChart = null;
    let currentChartFilter = 'This Week';
    window.currentDashboardDateFilter = 'Today';
    window.dashboardBookings = [];

    function formatCurrency(value) {
        return `₱${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function getPeriodBounds(filter) {
        const now = new Date();
        const start = new Date(now);
        const end = new Date(now);
        start.setHours(0, 0, 0, 0);
        switch (filter) {
            case 'Weekly':
                start.setDate(start.getDate() - 6);
                return { start, end };
            case 'Monthly':
                start.setDate(1);
                return { start, end };
            default:
                return { start, end };
        }
    }

    function getPreviousPeriodBounds(filter) {
        // Compare against the most recent period of EQUAL LENGTH immediately
        // before the current one. A naive "yesterday/last week/last month"
        // would compare a partial "so far today" window against a complete
        // prior period — always shorter, so it would systematically make the
        // current period look worse than it's actually pacing.
        const current = getPeriodBounds(filter);
        const durationMs = current.end.getTime() - current.start.getTime();
        const end = new Date(current.start.getTime());
        const start = new Date(end.getTime() - durationMs);
        return { start, end };
    }

    // ── Reports & Analytics month filter ─────────────────────────
    // null = the current month. Every chart and export on the Reports page
    // reads its date range from reportsMonthBounds() so they always agree.
    let reportsMonth = null; // { year, month } with month 0-11

    function monthKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    function reportsMonthBounds() {
        const now = new Date();
        const year = reportsMonth ? reportsMonth.year : now.getFullYear();
        const month = reportsMonth ? reportsMonth.month : now.getMonth();
        const start = new Date(year, month, 1, 0, 0, 0, 0);
        const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
        return { start, end, label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
    }

    function bookingsInReportsMonth(bookings) {
        const { start, end } = reportsMonthBounds();
        return (bookings || []).filter((b) => {
            const date = b.createdAtRaw ? new Date(b.createdAtRaw) : null;
            return date && !Number.isNaN(date.getTime()) && date >= start && date <= end;
        });
    }

    // Only completed rides actually collected a fare — cancelled/declined bookings
    // keep their quoted totalFare but never generate real revenue.
    function isRevenueEligible(booking) {
        return booking.status === 'completed';
    }

    function getBookingMetrics(bookings, start, end) {
        const filtered = (bookings || []).filter((booking) => {
            const date = booking.createdAtRaw || new Date(booking.date || booking.createdAt || null);
            return date && !Number.isNaN(date.getTime()) && date >= start && date <= end;
        });
        return {
            count: filtered.length,
            revenue: filtered.reduce((sum, booking) => sum + (isRevenueEligible(booking) ? (Number(booking.totalFare) || 0) : 0), 0)
        };
    }

    function formatChange(current, previous) {
        if (previous === 0) {
            // Percent change from a zero base is undefined — there's no real
            // percentage to report, so leave it blank rather than showing a
            // made-up number or a vague label.
            return current === 0 ? '→ Stable' : '';
        }
        const diff = current - previous;
        const percent = Math.round((diff / previous) * 100);
        if (percent > 0) return `↑ +${percent}% from prior period`;
        if (percent < 0) return `↓ ${percent}% from prior period`;
        return '→ Stable';
    }

    window.updateDashboardDateCards = function(filter) {
        window.currentDashboardDateFilter = filter;
        const cards = document.querySelectorAll('#view-dashboard .stat-card');
        const counts = window.dashboardCounts || { activeDrivers: 0, activePassengers: 0 };
        const currentBounds = getPeriodBounds(filter);
        const previousBounds = getPreviousPeriodBounds(filter);
        const currentMetrics = getBookingMetrics(dashboardBookings, currentBounds.start, currentBounds.end);
        const previousMetrics = getBookingMetrics(dashboardBookings, previousBounds.start, previousBounds.end);

        if (cards[0]) {
            const bookingTrend = currentMetrics.count > previousMetrics.count ? 'positive' : currentMetrics.count < previousMetrics.count ? 'negative' : 'neutral';
            cards[0].querySelector('h2').textContent = currentMetrics.count.toLocaleString();
            cards[0].querySelector('.stat-change').textContent = formatChange(currentMetrics.count, previousMetrics.count);
            cards[0].querySelector('.stat-change').className = `stat-change ${bookingTrend}`;
        }
        if (cards[1]) {
            const revenueTrend = currentMetrics.revenue > previousMetrics.revenue ? 'positive' : currentMetrics.revenue < previousMetrics.revenue ? 'negative' : 'neutral';
            cards[1].querySelector('h2').textContent = formatCurrency(currentMetrics.revenue);
            cards[1].querySelector('.stat-change').textContent = formatChange(currentMetrics.revenue, previousMetrics.revenue);
            cards[1].querySelector('.stat-change').className = `stat-change ${revenueTrend}`;
        }
        // "Active Drivers/Passengers" is a current total, not a period-scoped count —
        // there's no historical snapshot of who was active in the past to diff
        // against. The honest, computable trend is new sign-ups in this period
        // (registration timestamps are real data) rather than a fabricated delta
        // on the total itself.
        const periodPhrase = { Today: 'today', Weekly: 'this week', Monthly: 'this month' }[filter] || 'this period';
        if (cards[2]) {
            const newDrivers = countNewInPeriod(window.driverManagementDrivers, currentBounds);
            cards[2].querySelector('h2').textContent = counts.activeDrivers.toLocaleString();
            cards[2].querySelector('.stat-change').textContent = newDrivers > 0 ? `+${newDrivers} new ${periodPhrase}` : `No new drivers ${periodPhrase}`;
            cards[2].querySelector('.stat-change').className = `stat-change ${newDrivers > 0 ? 'positive' : 'neutral'}`;
        }
        if (cards[3]) {
            const newPassengers = countNewInPeriod(window.allPassengers, currentBounds);
            cards[3].querySelector('h2').textContent = counts.activePassengers.toLocaleString();
            cards[3].querySelector('.stat-change').textContent = newPassengers > 0 ? `+${newPassengers} new ${periodPhrase}` : `No new passengers ${periodPhrase}`;
            cards[3].querySelector('.stat-change').className = `stat-change ${newPassengers > 0 ? 'positive' : 'neutral'}`;
        }
    }

    function countNewInPeriod(list, bounds) {
        return (list || []).filter((item) => {
            const date = item.memberSinceRaw;
            return date && !Number.isNaN(date.getTime()) && date >= bounds.start && date <= bounds.end;
        }).length;
    }

    function normalizeLocation(value) {
        if (!value) return 'Unknown';
        return String(value).trim().replace(/\s+/g, ' ');
    }

    function getDayLabel(date) {
        return date.toLocaleDateString('en-US', { weekday: 'short' });
    }

    function aggregateWeeklyData(bookings) {
        const labels = [];
        const counts = Array(7).fill(0);
        const revenue = Array(7).fill(0);
        // Calendar week, Sunday→Saturday (getDay() is Sunday=0). Days after
        // today stay at 0 until they happen.
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - start.getDay());

        for (let i = 0; i < 7; i += 1) {
            const day = new Date(start);
            day.setDate(start.getDate() + i);
            labels.push(getDayLabel(day));
        }

        bookings.forEach((booking) => {
            const date = new Date(booking.createdAtRaw || booking.date || booking.createdAt || null);
            if (Number.isNaN(date.getTime())) return;
            date.setHours(0, 0, 0, 0);
            const diff = Math.round((date - start) / 86400000);
            if (diff >= 0 && diff < 7) {
                counts[diff] += 1;
                if (isRevenueEligible(booking)) revenue[diff] += booking.totalFare || 0;
            }
        });

        return { labels, counts, revenue };
    }

    // "This Month" buckets the actual calendar month-to-date (same definition
    // getPeriodBounds('Monthly') uses), not a rolling 28-day window, so this
    // chart and the Reports page agree on what "this month" means.
    function aggregateMonthlyData(bookings, monthDate = new Date()) {
        const labels = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
        const counts = [0, 0, 0, 0];
        const revenue = [0, 0, 0, 0];
        const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 0, 0, 0, 0);
        const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59, 999);

        bookings.forEach((booking) => {
            const date = new Date(booking.createdAtRaw || booking.date || booking.createdAt || null);
            if (Number.isNaN(date.getTime())) return;
            if (date < monthStart || date > monthEnd) return;
            const week = Math.min(3, Math.floor((date.getDate() - 1) / 7));
            counts[week] += 1;
            if (isRevenueEligible(booking)) revenue[week] += booking.totalFare || 0;
        });

        return { labels, counts, revenue };
    }

    function aggregateYearlyData(bookings) {
        const year = new Date().getFullYear();
        const labels = Array.from({ length: 12 }, (_, i) => new Date(year, i, 1).toLocaleDateString('en-US', { month: 'short' }));
        const counts = Array(12).fill(0);
        const revenue = Array(12).fill(0);

        bookings.forEach((booking) => {
            const date = new Date(booking.createdAtRaw || booking.date || booking.createdAt || null);
            if (Number.isNaN(date.getTime()) || date.getFullYear() !== year) return;
            const month = date.getMonth();
            counts[month] += 1;
            if (isRevenueEligible(booking)) revenue[month] += booking.totalFare || 0;
        });

        return { labels, counts, revenue };
    }

    const HIGH_DEMAND_WINDOW_DAYS = 7;

    // Location text is free-form rider input ("School", "school", "SCHOOL Gate"),
    // so group by a case-insensitive key and keep a clean, trimmed label for display.
    function normalizeLocationKey(value) {
        return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function computeHighDemandAreas(bookings) {
        const windowStart = new Date();
        windowStart.setHours(0, 0, 0, 0);
        windowStart.setDate(windowStart.getDate() - (HIGH_DEMAND_WINDOW_DAYS - 1));

        const areaCounts = {};
        const areaLabels = {};
        bookings.forEach((booking) => {
            if (!isRevenueEligible(booking)) return;
            const date = bookingDate(booking);
            if (!date || Number.isNaN(date.getTime()) || date < windowStart) return;

            const raw = booking.pickupLocation || booking.dropoffLocation;
            const key = normalizeLocationKey(raw) || 'unknown';
            areaCounts[key] = (areaCounts[key] || 0) + 1;
            if (!areaLabels[key]) areaLabels[key] = normalizeLocation(raw);
        });

        const entries = Object.entries(areaCounts);
        if (!entries.length) return [];

        // Compare each area to the average across all areas in the window, not just
        // whichever one happens to rank #1 — so "VERY HIGH" means genuinely above
        // typical demand, not just "today's busiest of however many areas there are".
        const totalRides = entries.reduce((sum, [, rides]) => sum + rides, 0);
        const average = totalRides / entries.length;

        const sorted = entries.sort((a, b) => b[1] - a[1]).slice(0, 5);

        return sorted.map(([key, rides]) => {
            const ratio = average > 0 ? rides / average : 0;
            let label = 'LOW';
            let badgeClass = 'approved';

            if (ratio >= 2) {
                label = 'VERY HIGH';
                badgeClass = 'declined';
            } else if (ratio >= 1.5) {
                label = 'HIGH';
                badgeClass = 'processing';
            } else if (ratio >= 1) {
                label = 'MODERATE';
                badgeClass = 'approved';
            }

            return { area: areaLabels[key], rides, label, badgeClass };
        });
    }

    function renderHighDemandAreas(bookings) {
        const tbody = document.getElementById('highDemandBody');
        if (!tbody) return;

        const areas = computeHighDemandAreas(bookings);
        if (!areas.length) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:20px;">No demand data available.</td></tr>';
            return;
        }

        tbody.innerHTML = areas.map((item) => `
            <tr>
                <td><div class="detail-main">${escapeHtml(item.area)}</div></td>
                <td><span class="status-badge ${item.badgeClass}">${escapeHtml(item.label)}</span></td>
                <td>${escapeHtml(item.rides)}</td>
            </tr>
        `).join('');
    }

    function updateDashboardCharts() {
        if (!dashboardChart) return;
        let aggregated;
        if (currentChartFilter === 'This Month') {
            aggregated = aggregateMonthlyData(dashboardBookings);
        } else if (currentChartFilter === 'This Year') {
            aggregated = aggregateYearlyData(dashboardBookings);
        } else {
            aggregated = aggregateWeeklyData(dashboardBookings);
        }

        dashboardChart.data.labels = aggregated.labels;
        dashboardChart.data.datasets[0].data = aggregated.counts;
        dashboardChart.data.datasets[1].data = aggregated.revenue;
        dashboardChart.update();
    }

    function updateStaticCharts() {
        if (monthlyRidesChart) {
            const aggregated = aggregateMonthlyData(dashboardBookings, reportsMonthBounds().start);
            monthlyRidesChart.data.labels = aggregated.labels;
            monthlyRidesChart.data.datasets[0].data = aggregated.counts;
            monthlyRidesChart.data.datasets[1].data = aggregated.revenue;
            monthlyRidesChart.update();
        }

        if (peakHoursRidesChart) {
            const labels = ['6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'];
            const counts = Array(9).fill(0);
            const uniqueDays = new Set();

            bookingsInReportsMonth(dashboardBookings).forEach((booking) => {
                const date = new Date(booking.createdAtRaw);
                uniqueDays.add(date.toDateString());
                const bucket = Math.floor((date.getHours() - 6) / 2);
                if (bucket >= 0 && bucket < 9) counts[bucket] += 1;
            });

            // The dataset is labeled "Avg. Rides/hr" — actually divide by the
            // number of days represented, otherwise this is a running total
            // that only ever climbs as more history accumulates, which isn't
            // what "average" means and contradicts the Peak Hour stat card
            // right above it (which does compute a real average).
            const daysCount = Math.max(1, uniqueDays.size);
            const averages = counts.map((c) => Math.round((c / daysCount) * 10) / 10);

            peakHoursRidesChart.data.labels = labels;
            peakHoursRidesChart.data.datasets[0].data = averages;
            peakHoursRidesChart.update();
        }
    }

    // Shared by any chart pairing a booking count with a peso revenue series on
    // a secondary axis: right-axis ticks and tooltips show real currency instead
    // of a scaled/rounded stand-in.
    function revenueTooltipLabel(ctx) {
        if (ctx.dataset.yAxisID === 'y1') return `${ctx.dataset.label}: ${formatCurrency(ctx.raw)}`;
        return `${ctx.dataset.label}: ${ctx.raw}`;
    }

    const ctx = document.getElementById('dashboardChart');
    if (ctx) {
        dashboardChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Bookings',
                    data: Array(7).fill(0),
                    yAxisID: 'y',
                    borderColor: '#1A73E8',
                    backgroundColor: 'rgba(26, 115, 232, 0.08)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                }, {
                    label: 'Revenue',
                    data: Array(7).fill(0),
                    yAxisID: 'y1',
                    borderColor: '#05CD99',
                    backgroundColor: 'transparent',
                    borderWidth: 2.5,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                }]
            },
            options: {
                ...chartDefaults,
                plugins: {
                    legend: chartDefaults.plugins.legend,
                    tooltip: { callbacks: { label: revenueTooltipLabel } }
                },
                scales: {
                    y: { beginAtZero: true, position: 'left', grid: { color: gridColor }, ticks: { font: { size: 11 } } },
                    y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 11 }, callback: (value) => formatCurrency(value) } },
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } }
                }
            }
        });
    }

    const ctxMonthly = document.getElementById('monthlyRidesChart');
    if (ctxMonthly) {
        monthlyRidesChart = new Chart(ctxMonthly, {
            type: 'bar',
            data: {
                labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
                datasets: [{
                    label: 'Completed',
                    data: [0, 0, 0, 0],
                    yAxisID: 'y',
                    backgroundColor: '#1A73E8',
                    borderRadius: 5,
                }, {
                    label: 'Revenue',
                    data: [0, 0, 0, 0],
                    yAxisID: 'y1',
                    backgroundColor: '#05CD99',
                    borderRadius: 5,
                }]
            },
            options: {
                ...chartDefaults,
                plugins: {
                    legend: chartDefaults.plugins.legend,
                    tooltip: { callbacks: { label: revenueTooltipLabel } }
                },
                scales: {
                    y: { beginAtZero: true, position: 'left', grid: { color: gridColor }, ticks: { font: { size: 11 } } },
                    y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 11 }, callback: (value) => formatCurrency(value) } },
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } }
                }
            }
        });
    }

    const ctxPeak = document.getElementById('peakHoursRidesChart');
    if (ctxPeak) {
        peakHoursRidesChart = new Chart(ctxPeak, {
            type: 'line',
            data: {
                labels: ['6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'],
                datasets: [{
                    label: 'Avg. Rides/hr',
                    data: [0, 0, 0, 0, 0, 0, 0, 0, 0],
                    borderColor: '#05CD99',
                    backgroundColor: 'rgba(5, 205, 153, 0.1)',
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                }]
            },
            options: {
                ...chartDefaults,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { color: gridColor }, ticks: { font: { size: 11 } } },
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } }
                }
            }
        });
    }

    // Passenger demand: completed vs cancelled rides per weekday.
    const ctxDemand = document.getElementById('passengerDemandChart');
    if (ctxDemand) {
        passengerDemandChart = new Chart(ctxDemand, {
            type: 'bar',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [
                    { label: 'Completed', data: Array(7).fill(0), backgroundColor: '#05CD99', borderRadius: 4 },
                    { label: 'Cancelled', data: Array(7).fill(0), backgroundColor: '#EE5D50', borderRadius: 4 }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                    y: {
                        beginAtZero: true,
                        grid: { color: gridColor },
                        ticks: { font: { size: 11 }, precision: 0 },
                        title: { display: true, text: 'Rides', font: { size: 11 } }
                    }
                }
            }
        });
    }

    const ctxPayment = document.getElementById('paymentMethodChart');
    if (ctxPayment) {
        paymentMethodChart = new Chart(ctxPayment, {
            type: 'pie',
            data: {
                labels: ['GCash', 'Cash'],
                datasets: [{ data: [0, 0], backgroundColor: ['#1A73E8', '#05CD99'], borderColor: '#fff', borderWidth: 2 }]
            },
            options: {
                ...chartDefaults,
                plugins: { legend: { display: false } }
            }
        });
    }

    window.renderDashboardCharts = function(bookings) {
        dashboardBookings = bookings || [];
        window.dashboardBookings = dashboardBookings;
        updateDashboardCharts();
        populateReportsMonthOptions(dashboardBookings);
        updateStaticCharts();
        renderHighDemandAreas(dashboardBookings);
        if (typeof window.renderRecentActivity === 'function') {
            window.renderRecentActivity(dashboardBookings);
        }
        if (typeof window.updateDashboardDateCards === 'function') {
            window.updateDashboardDateCards(window.currentDashboardDateFilter || 'Today');
        }
        // Update Reports & Analytics panels (passenger demand, payment methods, peak hour)
        try {
            updateReportsStats(dashboardBookings);
        } catch (e) {
            console.warn('Failed to update reports stats', e);
        }
    };

    function formatHourLabel(hour) {
        const d = new Date();
        d.setHours(hour, 0, 0, 0);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    // Completed vs cancelled rides by weekday. Declined, no-show and still-in-
    // progress bookings are deliberately not charted, so bars add up to fewer
    // than the total number of requests made.
    function updatePassengerDemand(bookings) {
        if (!passengerDemandChart) return;

        const completed = Array(7).fill(0);
        const cancelled = Array(7).fill(0);

        bookingsInReportsMonth(bookings).forEach((b) => {
            const day = new Date(b.createdAtRaw).getDay();
            const status = String(b.status || '').toLowerCase();
            if (status === 'completed') completed[day] += 1;
            else if (status === 'cancelled' || status === 'canceled') cancelled[day] += 1;
        });

        // Chart runs Monday→Sunday; getDay() is Sunday=0.
        const order = [1, 2, 3, 4, 5, 6, 0];
        passengerDemandChart.data.datasets[0].data = order.map((d) => completed[d]);
        passengerDemandChart.data.datasets[1].data = order.map((d) => cancelled[d]);
        passengerDemandChart.update();
    }

    function updatePaymentComparison(bookings) {
        const summaryEl = document.getElementById('paymentSummary');
        const legendEl = document.getElementById('paymentLegend');
        const wrapEl = document.getElementById('paymentChartWrap');
        if (!paymentMethodChart) return;

        const stats = { GCASH: { count: 0, revenue: 0 }, CASH: { count: 0, revenue: 0 } };
        let unrecorded = 0;
        bookingsInReportsMonth(bookings).forEach((b) => {
            if (String(b.status || '').toLowerCase() !== 'completed') return;
            const method = String(b.paymentMethod || '').toUpperCase();
            if (stats[method]) {
                stats[method].count += 1;
                stats[method].revenue += Number(b.totalFare || 0);
            } else {
                unrecorded += 1;
            }
        });

        const total = stats.GCASH.count + stats.CASH.count;
        paymentMethodChart.data.datasets[0].data = [stats.GCASH.count, stats.CASH.count];
        paymentMethodChart.update();
        if (wrapEl) wrapEl.style.display = total ? '' : 'none';

        const note = unrecorded ? ` (${unrecorded} completed ${unrecorded === 1 ? 'ride has' : 'rides have'} no payment method recorded)` : '';
        if (summaryEl) {
            summaryEl.textContent = total
                ? `${total} completed ${total === 1 ? 'ride' : 'rides'} with a recorded payment method${note}`
                : `No completed rides with a recorded payment method in ${reportsMonthBounds().label}${note}.`;
        }
        if (legendEl) {
            legendEl.innerHTML = total
                ? [['GCash', 'GCASH', '#1A73E8'], ['Cash', 'CASH', '#05CD99']].map(([label, key, color]) => {
                    const s = stats[key];
                    const pct = Math.round((s.count / total) * 100);
                    return `<div style="display:flex; align-items:center; gap:8px;"><span style="width:10px; height:10px; border-radius:50%; background:${color};"></span><span><strong>${label}</strong> · ${pct}% · ${s.count} ${s.count === 1 ? 'ride' : 'rides'} · ${formatCurrency(s.revenue)}</span></div>`;
                }).join('')
                : '';
        }
    }

    function updateReportsStats(bookings) {
        updatePassengerDemand(bookings);
        updatePaymentComparison(bookings);

        // Peak hour of the selected month lives in the Peak Hours Analysis
        // card's subtitle instead of its own stat card.
        const monthLabel = reportsMonthBounds().label;
        const hourTotals = Array(24).fill(0);
        const uniqueDays = new Set();
        bookingsInReportsMonth(bookings).forEach((b) => {
            const date = new Date(b.createdAtRaw);
            hourTotals[date.getHours()] += 1;
            uniqueDays.add(date.toDateString());
        });
        const peakSummaryEl = document.getElementById('peakHourSummary');
        if (!peakSummaryEl) return;
        const peakCount = Math.max(...hourTotals);
        if (!peakCount) {
            peakSummaryEl.textContent = `No bookings in ${monthLabel}.`;
            return;
        }
        const maxHour = hourTotals.indexOf(peakCount);
        const daysCount = Math.max(1, uniqueDays.size);
        const avgPerHour = (peakCount / daysCount).toFixed(1);
        peakSummaryEl.textContent = `Peak hour in ${monthLabel}: ${formatHourLabel(maxHour)} · ${avgPerHour} rides per day at that hour`;
    }

    // Month dropdown on the Reports page: one option per month from the
    // earliest booking (capped at 24 months back) to the current month.
    function populateReportsMonthOptions(bookings) {
        const select = document.getElementById('reportsMonthSelect');
        if (!select) return;

        const now = new Date();
        const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const cap = new Date(now.getFullYear(), now.getMonth() - 24, 1);
        let earliest = currentMonth;
        (bookings || []).forEach((b) => {
            const date = b.createdAtRaw ? new Date(b.createdAtRaw) : null;
            if (!date || Number.isNaN(date.getTime())) return;
            const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
            if (monthStart < earliest) earliest = monthStart;
        });
        if (earliest < cap) earliest = cap;

        const months = [];
        for (let d = new Date(currentMonth); d >= earliest; d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
            months.push(d);
        }

        // Rebuilding the list on every booking update would reset the open
        // dropdown, so only touch it when the set of months actually changed.
        const signature = months.map(monthKey).join(',');
        if (select.dataset.signature !== signature) {
            select.innerHTML = months
                .map((d) => `<option value="${monthKey(d)}">${d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</option>`)
                .join('');
            select.dataset.signature = signature;
        }

        const wanted = reportsMonth ? monthKey(new Date(reportsMonth.year, reportsMonth.month, 1)) : monthKey(currentMonth);
        select.value = months.some((d) => monthKey(d) === wanted) ? wanted : monthKey(currentMonth);
    }

    const reportsMonthSelect = document.getElementById('reportsMonthSelect');
    if (reportsMonthSelect) {
        reportsMonthSelect.addEventListener('change', () => {
            const [year, month] = reportsMonthSelect.value.split('-').map(Number);
            reportsMonth = { year, month: month - 1 };
            updateStaticCharts();
            updateReportsStats(dashboardBookings);
        });
    }

    // ── Reports & Analytics Exports ─────────────────────────────────
    function escapeCsvValue(value) {
        const str = String(value ?? '');
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }

    function downloadCsv(filename, headers, rows) {
        const lines = [headers, ...rows].map((row) => row.map(escapeCsvValue).join(','));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function bookingDate(booking) {
        return booking.createdAtRaw || new Date(booking.date || booking.createdAt || null);
    }

    window.exportDailyRideReport = function() {
        const bounds = getPeriodBounds('Today');
        const rows = (dashboardBookings || [])
            .filter((b) => {
                const d = bookingDate(b);
                return d && !Number.isNaN(d.getTime()) && d >= bounds.start && d <= bounds.end;
            })
            .map((b) => [b.ref, b.dateLabel, b.status, b.driverName || '—', b.passengerName || '—', b.pickupLocation, b.dropoffLocation, (Number(b.totalFare) || 0).toFixed(2), b.paymentMethod || '—']);

        if (!rows.length) {
            showToast('No rides recorded today.', 'warning');
            return;
        }
        downloadCsv(`daily-ride-report-${new Date().toISOString().slice(0, 10)}.csv`,
            ['Booking Ref', 'Date', 'Status', 'Driver', 'Passenger', 'Pickup', 'Dropoff', 'Fare', 'Payment Method'], rows);
        showToast(`Exported ${rows.length} ride(s).`, 'success');
    };

    window.exportDriverActivity = async function() {
        if (!window.ParaFirestore) {
            showToast('Firestore is not available.', 'error');
            return;
        }
        try {
            const drivers = await ParaFirestore.fetchApprovedDrivers();
            if (!drivers.length) {
                showToast('No driver activity to export.', 'warning');
                return;
            }
            // Ride counts / acceptance aren't stored on the driver doc — compute from bookings.
            const bookings = (window.allBookings && window.allBookings.length)
                ? window.allBookings
                : await ParaFirestore.fetchAllBookings();
            const rows = drivers.map((d) => {
                const stats = ParaFirestore.computeDriverStats(d, bookings);
                return [d.name, d.vehicle || '—', d.plate || '—', Number(d.rating || 0).toFixed(1), stats.completed, stats.acceptanceRate, d.accountStatus || 'active'];
            });
            downloadCsv(`driver-activity-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Name', 'Vehicle', 'Plate', 'Rating', 'Completed Rides', 'Acceptance Rate', 'Status'], rows);
            showToast(`Exported ${rows.length} driver(s).`, 'success');
        } catch (error) {
            console.error('Failed to export driver activity:', error);
            showToast('Could not export driver activity.', 'error');
        }
    };

    window.exportPeakHoursAnalysis = function() {
        // Follows the month picked on the Reports page, like the chart does.
        const hourTotals = Array(24).fill(0);
        bookingsInReportsMonth(dashboardBookings).forEach((b) => {
            hourTotals[new Date(b.createdAtRaw).getHours()] += 1;
        });
        const rows = hourTotals.map((count, hour) => [formatHourLabel(hour), count]);
        downloadCsv(`peak-hours-analysis-${new Date().toISOString().slice(0, 10)}.csv`,
            ['Hour', 'Rides'], rows);
        showToast('Peak hours analysis exported.', 'success');
    };

    window.exportMonthlyRideReport = function() {
        if (!window.jspdf || !window.jspdf.jsPDF) {
            showToast('PDF library failed to load.', 'error');
            return;
        }
        // Follows the month picked on the Reports page, like the charts do.
        const bounds = reportsMonthBounds();
        const rows = bookingsInReportsMonth(dashboardBookings)
            .sort((a, b) => bookingDate(a) - bookingDate(b));

        if (!rows.length) {
            showToast(`No rides recorded in ${bounds.label}.`, 'warning');
            return;
        }

        // jsPDF's built-in fonts don't have a glyph for ₱, so use "PHP" in the PDF only.
        const formatCurrencyPdf = (value) => `PHP ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const monthLabel = bounds.label;
        // Only completed rides count toward the total — same rule as the
        // revenue figures everywhere else in the app (a cancelled booking's
        // fare was only ever a quote, never collected).
        const totalFare = rows.filter(isRevenueEligible).reduce((sum, b) => sum + (Number(b.totalFare) || 0), 0);

        doc.setFontSize(16);
        doc.text('PARA Monthly Ride Report', 14, 18);
        doc.setFontSize(11);
        doc.text(`Period: ${monthLabel}`, 14, 26);
        doc.text(`Total rides: ${rows.length}    Total fare (completed only): ${formatCurrencyPdf(totalFare)}`, 14, 33);

        const headers = ['Ref', 'Date', 'Status', 'Driver', 'Passenger', 'Fare'];
        const colX = [14, 46, 76, 100, 138, 172];
        // Width available to each column before wrapping to a second line —
        // nothing gets cut off, a long reference or name just wraps within
        // its own cell instead of overlapping the next column.
        const colWidths = [30, 28, 22, 36, 32, 24];
        const lineHeight = 4.5;
        let y = 45;
        doc.setFontSize(9);
        doc.setFont(undefined, 'bold');
        headers.forEach((h, i) => doc.text(h, colX[i], y));
        doc.setFont(undefined, 'normal');
        y += 6;

        rows.forEach((b) => {
            const cells = [b.ref, b.dateLabel, b.status, b.driverName || '—', b.passengerName || '—', formatCurrencyPdf(b.totalFare)];
            const wrappedCells = cells.map((c, i) => doc.splitTextToSize(String(c), colWidths[i]));
            const lineCount = Math.max(1, ...wrappedCells.map((lines) => lines.length));
            const rowHeight = lineCount * lineHeight;

            if (y + rowHeight > 285) {
                doc.addPage();
                y = 20;
            }

            wrappedCells.forEach((lines, i) => {
                lines.forEach((line, lineIndex) => doc.text(line, colX[i], y + lineIndex * lineHeight));
            });

            y += rowHeight + 2;
        });

        doc.save(`monthly-ride-report-${monthKey(bounds.start)}.pdf`);
        showToast(`Exported ${rows.length} ride(s) to PDF.`, 'success');
    };

    window.selectChartFilter = function(filterStr) {
        const textSpan = document.getElementById('chartFilterText');
        const dropdown = document.getElementById('chartFilterDropdown');
        if (textSpan) textSpan.textContent = filterStr;
        if (dropdown) dropdown.classList.remove('show');
        currentChartFilter = filterStr;
        window.renderDashboardCharts(dashboardBookings);
    };

    // ── Fare Calculator Preview ───────────────────────────────────
    function updateFarePreview() {
        const base = parseFloat(document.getElementById('fare-base')?.value) || 0;
        const perKm = parseFloat(document.getElementById('fare-perkm')?.value) || 0;
        const minFare = parseFloat(document.getElementById('fare-min')?.value) || 0;
        const svcFee = parseFloat(document.getElementById('fare-svc')?.value) || 0;

        const exampleKm = 3;
        let raw = base + (perKm * exampleKm);
        raw = Math.max(raw, minFare);
        const fee = raw * (svcFee / 100);
        const total = raw + fee;

        const el = (id) => document.getElementById(id);
        if (el('prev-base')) el('prev-base').textContent = `₱${base.toFixed(2)}`;
        if (el('prev-km')) el('prev-km').textContent = `₱${(perKm * exampleKm).toFixed(2)}`;
        if (el('prev-fee')) el('prev-fee').textContent = `₱${fee.toFixed(2)}`;
        if (el('prev-total')) el('prev-total').textContent = `₱${total.toFixed(2)}`;
    }

    window.updateFarePreview = updateFarePreview;

    ['fare-base', 'fare-perkm', 'fare-min', 'fare-svc'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateFarePreview);
    });
    updateFarePreview();

    // ── Driver Availability Forecast ────────────────────────────
    const TIDE_STORAGE_KEY = 'para_tide_entries_v1';

    function initDriverForecast() {
        const dateInput = document.getElementById('forecast-date');
        const hourInput = document.getElementById('forecast-hour');
        const locationSelect = document.getElementById('forecast-location');
        const rainfallInput = document.getElementById('forecast-rainfall');
        const tideInput = document.getElementById('forecast-tide');
        const riskBadge = document.getElementById('forecast-risk-badge');
        const generateBtn = document.getElementById('forecast-generate-btn');
        const valueEl = document.getElementById('forecast-value');
        const statusBadgeEl = document.getElementById('forecast-status-badge');
        const modelNoteEl = document.getElementById('forecast-model-note');
        const rangeWarningEl = document.getElementById('forecast-range-warning');
        const weatherStatusEl = document.getElementById('forecast-weather-status');
        const refreshWeatherBtn = document.getElementById('forecast-refresh-weather-btn');
        const tideFileInput = document.getElementById('forecast-tide-file');
        const tideUploadBtn = document.getElementById('forecast-tide-upload-btn');
        const tideFileStatusEl = document.getElementById('forecast-tide-file-status');
        const tideMatchNoteEl = document.getElementById('forecast-tide-match-note');

        if (!hourInput || !locationSelect || !window.ParaDriverPrediction) return;

        const {
            MODEL, SERVICE_AREA,
            computeHighWaterRisk, predictAvailableDrivers, availabilityStatus, isWithinTrainedRange,
            fetchLiveRainfall, parseTideWorkbook, findNearestTideEntry
        } = window.ParaDriverPrediction;

        let tideEntries = [];

        locationSelect.innerHTML = MODEL.locations.map(loc => `<option value="${loc}">${loc}</option>`).join('');
        if (dateInput && !dateInput.value) {
            const today = new Date();
            dateInput.value = today.toISOString().slice(0, 10);
        }
        if (hourInput && !hourInput.value) hourInput.value = '08:00';

        // Parses the "HH:MM" time input into usable numeric forms, or null if
        // empty/invalid — callers treat that the same as "no tide match".
        function getSelectedTime() {
            const raw = hourInput.value;
            if (!raw) return null;
            const [hStr, mStr] = raw.split(':');
            const h = Number(hStr);
            const m = Number(mStr);
            if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
            return { hours: h, minutes: m, totalMinutes: h * 60 + m, decimalHour: h + m / 60 };
        }

        if (modelNoteEl) {
            modelNoteEl.textContent = `Multiple Linear Regression · trained on ${MODEL.metrics.trainingRecords} historical records, tested on ${MODEL.metrics.testingRecords} · R² = ${MODEL.metrics.r2.toFixed(3)} · avg error ±${MODEL.metrics.mae.toFixed(2)} drivers.`;
        }

        function tideSummaryText(entries) {
            if (!entries.length) return 'No tide data uploaded yet.';
            const dateKeys = entries.map((e) => e.dateKey).sort();
            const first = dateKeys[0];
            const last = dateKeys[dateKeys.length - 1];
            const range = first === last ? first : `${first} to ${last}`;
            return `Loaded ${entries.length} tide reading${entries.length === 1 ? '' : 's'} covering ${range}.`;
        }

        function saveTideEntriesToStorage(entries) {
            try {
                const serializable = entries.map((e) => ({ ...e, dateTime: e.dateTime.toISOString() }));
                localStorage.setItem(TIDE_STORAGE_KEY, JSON.stringify(serializable));
            } catch (error) {
                console.error('Could not save tide data locally:', error);
            }
        }

        function loadTideEntriesFromStorage() {
            try {
                const raw = localStorage.getItem(TIDE_STORAGE_KEY);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                return parsed.map((e) => ({ ...e, dateTime: new Date(e.dateTime) }));
            } catch (error) {
                console.error('Could not load saved tide data:', error);
                return [];
            }
        }

        function currentTideMatch() {
            const time = getSelectedTime();
            if (!dateInput || !dateInput.value || !time) return null;
            return findNearestTideEntry(tideEntries, dateInput.value, time.totalMinutes);
        }

        function formatMatchTime(entry) {
            const h = entry.dateTime.getHours();
            const m = entry.dateTime.getMinutes();
            const period = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 === 0 ? 12 : h % 12;
            return `${h12}:${String(m).padStart(2, '0')} ${period}`;
        }

        // If the nearest uploaded reading is more than this many hours from the
        // selected time, it's too far a stretch to pass off as "the tide at
        // that hour" — flag it loudly instead of quietly showing a number.
        const TIDE_MATCH_WARN_MINUTES = 6 * 60;

        function updateTideField() {
            const match = currentTideMatch();
            if (match) {
                tideInput.value = match.tideM.toFixed(2);
                tideInput.placeholder = '';
                const time = getSelectedTime();
                const diffMinutes = time ? Math.abs(match.minutesOfDay - time.totalMinutes) : 0;
                const diffHours = (diffMinutes / 60).toFixed(1);
                if (tideMatchNoteEl) {
                    if (diffMinutes > TIDE_MATCH_WARN_MINUTES) {
                        tideMatchNoteEl.innerHTML = `⚠ Only reading available that day is at ${formatMatchTime(match)} (${match.tideFt} ft) — ${diffHours}h from the selected time. Treat this value as unreliable.`;
                        tideMatchNoteEl.style.color = 'var(--status-decl-text)';
                    } else {
                        tideMatchNoteEl.textContent = `Matched to uploaded reading at ${formatMatchTime(match)} (${match.tideFt} ft) — the closest reading on this date.`;
                        tideMatchNoteEl.style.color = '';
                    }
                }
            } else {
                tideInput.value = '';
                tideInput.placeholder = tideEntries.length ? 'No data for this date' : 'Upload tide data below';
                if (tideMatchNoteEl) { tideMatchNoteEl.textContent = ''; tideMatchNoteEl.style.color = ''; }
            }
            return match;
        }

        function currentRisk() {
            const rainfall = parseFloat(rainfallInput.value) || 0;
            const tide = parseFloat(tideInput.value) || 0;
            return computeHighWaterRisk(rainfall, tide);
        }

        function updateRiskBadge() {
            const risk = currentRisk();
            if (riskBadge) {
                riskBadge.textContent = risk ? 'High-Water Risk: Yes' : 'High-Water Risk: No';
                riskBadge.className = 'status-badge ' + (risk ? 'declined' : 'approved');
            }
            return risk;
        }

        function updateRangeWarning() {
            const rainfall = parseFloat(rainfallInput.value) || 0;
            const tide = parseFloat(tideInput.value) || 0;
            const time = getSelectedTime();
            const inRange = isWithinTrainedRange(rainfall, tide, time ? time.decimalHour : null);
            if (rangeWarningEl) rangeWarningEl.style.display = inRange ? 'none' : 'block';
        }

        function generateForecast() {
            const tideMatch = updateTideField();
            const time = getSelectedTime();

            if (!tideMatch || !time) {
                if (valueEl) valueEl.textContent = '–';
                if (statusBadgeEl) {
                    statusBadgeEl.textContent = time ? 'NO TIDE DATA' : 'SELECT A TIME';
                    statusBadgeEl.className = 'status-badge declined';
                }
                if (riskBadge) {
                    riskBadge.textContent = 'High-Water Risk: Unknown';
                    riskBadge.className = 'status-badge processing';
                }
                if (rangeWarningEl) rangeWarningEl.style.display = 'none';
                return;
            }

            const hour = time.decimalHour;
            const location = locationSelect.value;
            const rainfall = parseFloat(rainfallInput.value) || 0;
            const tide = parseFloat(tideInput.value) || 0;
            const risk = updateRiskBadge();
            updateRangeWarning();

            const predicted = predictAvailableDrivers({ hour, location, rainfallMm: rainfall, highTideM: tide, highWaterRisk: risk });
            const status = availabilityStatus(predicted);
            const statusClass = status === 'HIGH' ? 'approved' : (status === 'MODERATE' ? 'processing' : 'declined');

            if (valueEl) valueEl.textContent = Math.max(0, predicted).toFixed(2);
            if (statusBadgeEl) {
                statusBadgeEl.textContent = status;
                statusBadgeEl.className = 'status-badge ' + statusClass;
            }
        }

        // Rainfall is a live, read-only API reading. Tide is a read-only lookup
        // from the uploaded table. Neither is user-typed anymore, so the only
        // things that change the forecast are Date/Hour/Zone and a new upload.
        [dateInput, hourInput, locationSelect].forEach((el) => el && el.addEventListener('change', generateForecast));
        if (generateBtn) generateBtn.addEventListener('click', generateForecast);

        // Firestore has no weather data of its own, so rainfall comes from a
        // real external source (Open-Meteo) instead of manual entry.
        async function loadLiveRainfall() {
            if (weatherStatusEl) weatherStatusEl.textContent = `Loading live rainfall from Open-Meteo (${SERVICE_AREA.name})…`;
            if (refreshWeatherBtn) refreshWeatherBtn.disabled = true;
            try {
                const { rainfallMm, observedAt } = await fetchLiveRainfall();
                rainfallInput.value = rainfallMm.toFixed(2);
                const timeLabel = observedAt ? new Date(observedAt).toLocaleString() : 'just now';
                if (weatherStatusEl) weatherStatusEl.textContent = `Live rainfall from Open-Meteo (${SERVICE_AREA.name}) as of ${timeLabel}.`;
                generateForecast();
            } catch (error) {
                console.error('Failed to load live rainfall data:', error);
                if (weatherStatusEl) weatherStatusEl.textContent = `Could not reach Open-Meteo for live rainfall.`;
                window.showToast('Could not fetch live rainfall data.', 'error');
            } finally {
                if (refreshWeatherBtn) refreshWeatherBtn.disabled = false;
            }
        }

        if (refreshWeatherBtn) refreshWeatherBtn.addEventListener('click', loadLiveRainfall);

        // Tide data: admin uploads the LGU's tide bulletin as .xlsx. Parsed
        // client-side (SheetJS) and kept in this browser's localStorage so it
        // survives reloads without needing a backend for it.
        if (tideUploadBtn && tideFileInput) {
            tideUploadBtn.addEventListener('click', () => tideFileInput.click());
            tideFileInput.addEventListener('change', async () => {
                const file = tideFileInput.files && tideFileInput.files[0];
                if (!file) return;
                try {
                    const buffer = await file.arrayBuffer();
                    tideEntries = parseTideWorkbook(buffer);
                    saveTideEntriesToStorage(tideEntries);
                    if (tideFileStatusEl) tideFileStatusEl.textContent = tideSummaryText(tideEntries);
                    window.showToast('Tide data uploaded.', 'success');
                    generateForecast();
                } catch (error) {
                    console.error('Failed to parse tide workbook:', error);
                    window.showToast(error.message || 'Could not read that Excel file.', 'error');
                } finally {
                    tideFileInput.value = '';
                }
            });
        }

        tideEntries = loadTideEntriesFromStorage();
        if (tideFileStatusEl) tideFileStatusEl.textContent = tideSummaryText(tideEntries);

        updateTideField();
        updateRiskBadge();
        updateRangeWarning();
        generateForecast();
        loadLiveRainfall();
    }
    initDriverForecast();

    // Driver Management controls are handled by dropdown menu selections.
});

// ── Dashboard Date Filter ─────────────────────────────────────────
window.selectDashboardDate = function(dateStr) {
    const textSpan = document.getElementById('dashboardDateText');
    const dropdown = document.getElementById('dashboardDateDropdown');
    if (textSpan) textSpan.textContent = dateStr;
    if (dropdown) dropdown.classList.remove('show');

        updateDashboardDateCards(dateStr);
};

// ── Sign Out ──────────────────────────────────────────────────────
window.openSignOutModal = function() {
    document.getElementById('signOutModal').classList.add('active');
};

window.confirmSignOut = function() {
    window.location.href = 'index.html';
};

// ── Modal Helpers ─────────────────────────────────────────────────
window.closeModal = function(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
};

// ── Driver / Passenger Management ────────────────────────────────
window.openDriverEditModal = function(name, vehicle, plate) {
    document.getElementById('d-edit-name').value = name;
    document.getElementById('d-edit-vehicle').value = vehicle;
    document.getElementById('d-edit-plate').value = plate;
    document.getElementById('driverEditModal').classList.add('active');
};

window.saveDriverEdit = function() {
    closeModal('driverEditModal');
    showToast('Driver details updated.', 'success');
};

window.confirmDriverBan = function(name) {
    showConfirmModal(
        `Deactivate ${name}?`,
        `This driver's account will be suspended. They won't be able to accept rides until reactivated.`,
        'Deactivate',
        '#EE5D50',
        () => showToast(`${name} has been deactivated.`, 'error')
    );
};

window.confirmPassengerBan = function(name) {
    showConfirmModal(
        `Deactivate ${name}?`,
        `This passenger's account will be suspended. They won't be able to book rides.`,
        'Deactivate',
        '#EE5D50',
        () => showToast(`${name} has been deactivated.`, 'error')
    );
};

// ── Complaints ────────────────────────────────────────────────────
window.openComplaintModal = function(ref, reporter, reported, issue, desc, status, todaRec) {
    document.getElementById('c-ref').textContent = ref;
    document.getElementById('c-reporter').textContent = reporter;
    document.getElementById('c-reported').textContent = reported;
    document.getElementById('c-issue').value = issue;
    document.getElementById('c-desc').value = desc;

    const todaEl = document.getElementById('c-toda-rec');
    if (todaEl) {
        todaEl.value = todaRec || 'Waiting for Recommendation...';
        todaEl.style.color = { 'Warning': '#FF9E2A', 'Suspension': '#EE5D50' }[todaRec] || 'var(--text-main)';
    }

    const statusEl = document.getElementById('c-status');
    statusEl.textContent = status;
    statusEl.className = 'status-badge ' + (status === 'RESOLVED' ? 'approved' : 'processing');

    document.getElementById('complaintViewModal').classList.add('active');
};

// ── Request Info Modal ────────────────────────────────────────────
window.openRequestInfoModal = function() {
    document.querySelectorAll('#requestInfoCheckboxes input[type="checkbox"]').forEach(cb => cb.checked = false);
    const note = document.getElementById('requestInfoNote');
    if (note) note.value = '';
    document.getElementById('requestInfoModal').classList.add('active');
};

window.submitRequestInfo = async function() {
    const selected = Array.from(document.querySelectorAll('#requestInfoCheckboxes input[type="checkbox"]:checked')).map(cb => cb.value);
    if (selected.length === 0) {
        showToast('Select at least one document to request.', 'warning');
        return;
    }
    const driverId = window.currentVerificationDriverId;
    if (!driverId || !window.ParaFirestore) {
        showToast('No driver selected for this request.', 'error');
        return;
    }
    const note = document.getElementById('requestInfoNote');
    try {
        await ParaFirestore.requestDriverInfo(driverId, { documents: selected, note: note ? note.value.trim() : '' });
        closeModal('requestInfoModal');
        showToast(`Request saved for ${selected.length} document(s).`, 'success');
    } catch (error) {
        console.error('Failed to save info request:', error);
        showToast('Could not save the request. Please try again.', 'error');
    }
};

// ── Generic Confirm Modal ─────────────────────────────────────────
function showConfirmModal(title, body, confirmLabel, confirmColor, onConfirm, customBodyHtml = '') {
    let modal = document.getElementById('genericConfirmModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'genericConfirmModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:400px; text-align:center;">
                <div class="modal-body" style="padding:32px 28px;">
                    <div class="confirm-modal-icon" id="confirmIcon"></div>
                    <p id="confirmTitle" style="font-size:18px; font-weight:700; margin-bottom:10px;"></p>
                    <div id="confirmBody" style="font-size:14px; color:var(--text-muted); line-height:1.6;"></div>
                </div>
                <div class="modal-footer" style="justify-content:center; border-top:1px solid var(--border-color);">
                    <button class="btn btn-secondary" onclick="closeModal('genericConfirmModal')">Cancel</button>
                    <button class="btn" id="confirmActionBtn"></button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    document.getElementById('confirmTitle').textContent = title;
    const confirmBody = document.getElementById('confirmBody');
    confirmBody.innerHTML = customBodyHtml || body;
    if (customBodyHtml) {
        confirmBody.innerHTML = customBodyHtml;
    } else {
        confirmBody.textContent = body;
    }
    const btn = document.getElementById('confirmActionBtn');
    btn.textContent = confirmLabel;
    btn.style.background = confirmColor;
    btn.style.color = 'white';
    btn.onclick = () => { closeModal('genericConfirmModal'); onConfirm(); };

    const icon = document.getElementById('confirmIcon');
    icon.style.background = confirmColor + '1A';
    icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${confirmColor}" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

    modal.classList.add('active');
}

// ── Fare Save ─────────────────────────────────────────────────────
window.saveFareSettings = function() {
    showToast('Fare settings saved successfully.', 'success');
};

// ── Password Update ───────────────────────────────────────────────
window.updatePassword = async function() {
    const currentPw = document.getElementById('currentPassword')?.value;
    const newPw = document.getElementById('newPassword')?.value;
    const confirmPw = document.getElementById('confirmPassword')?.value;

    if (!currentPw || !newPw || !confirmPw) {
        showToast('Please fill in all password fields.', 'warning');
        return;
    }

    if (newPw.length < 6) {
        showToast('New password must be at least 6 characters.', 'warning');
        return;
    }

    if (newPw !== confirmPw) {
        showToast('New passwords do not match.', 'error');
        return;
    }

    const auth = window.ParaFirebase?.auth;
    const user = auth?.currentUser;
    if (!auth || !user || !user.email) {
        showToast('You must be signed in to update your password.', 'error');
        return;
    }

    try {
        const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPw);
        await user.reauthenticateWithCredential(credential);
        await user.updatePassword(newPw);

        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';

        showToast('Password updated successfully.', 'success');
    } catch (error) {
        console.error('Failed to update password:', error);
        const message = error.code === 'auth/wrong-password'
            ? 'Current password is incorrect.'
            : error.code === 'auth/requires-recent-login'
                ? 'Please sign in again and try your password update.'
                : 'Failed to update password.';
        showToast(message, 'error');
    }
};

window.toggleSettingsPasswordVisibility = function() {
    const showing = document.getElementById('showPasswordsToggle')?.checked;
    document.querySelectorAll('.settings-pw-field').forEach((el) => {
        el.type = showing ? 'text' : 'password';
    });
};

