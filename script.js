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
    registerDropdown('driverMgmtStatusBtn', 'driverMgmtStatusDropdown');
    registerDropdown('driverMgmtSortBtn', 'driverMgmtSortDropdown');
    registerDropdown('passengerMgmtStatusBtn', 'passengerMgmtStatusDropdown');
    registerDropdown('complaintStatusBtn', 'complaintStatusDropdown');
    registerDropdown('alertsBellBtn', 'alertsPanel');
    // ── SPA Router ────────────────────────────────────────────────
    const navLinks = document.querySelectorAll('.nav-link');
    const views = document.querySelectorAll('.view-section');

    // Sidebar groups that collapse several views under one expandable parent link.
    const navGroups = [
        { groupId: 'reportsNavGroup', childViews: ['reports', 'driver-availability'] }
    ];

    // The search box in the top bar is only shown on the pages that list people
    // and records; everywhere else it is hidden.
    const SEARCH_VIEWS = ['driver-management', 'passenger-management', 'complaints', 'bookings'];
    const SEARCH_PLACEHOLDERS = {
        'driver-management': 'Search drivers by name, plate or phone…',
        'passenger-management': 'Search passengers by name, phone or email…',
        'complaints': 'Search complaints and reports by case, driver, passenger or issue…',
        'bookings': 'Search bookings by ID, driver, passenger or place…'
    };

    // The Complaints page has two tabs: the cases (complaints about drivers and
    // reports drivers filed about passengers, in one list) and appeals against
    // warnings and suspensions.
    let complaintTab = 'cases';
    const COMPLAINT_PANELS = { cases: 'complaintsPanel', appeals: 'appealsPanel' };
    const COMPLAINT_TAB_PLACEHOLDERS = {
        cases: 'Search complaints and reports by case, driver, passenger or issue…',
        appeals: 'Search appeals by name, TODA, statement or status…'
    };

    function applyComplaintTab() {
        document.querySelectorAll('#complaintTabs .vf-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === complaintTab));
        const cases = complaintTab === 'cases';
        Object.entries(COMPLAINT_PANELS).forEach(([tab, id]) => {
            const panel = document.getElementById(id);
            if (panel) panel.style.display = tab === complaintTab ? '' : 'none';
        });
        const controls = document.getElementById('complaintHeaderControls');
        // Hidden but still taking up its space, so the title does not move between tabs.
        if (controls) controls.style.visibility = cases ? '' : 'hidden';
        // The search box stays on both tabs; its hint says what it searches.
        const box = document.getElementById('globalSearchInput');
        if (box && document.getElementById('view-complaints')?.classList.contains('active')) {
            box.placeholder = COMPLAINT_TAB_PLACEHOLDERS[complaintTab];
        }
    }

    document.getElementById('complaintTabs')?.addEventListener('click', (e) => {
        const tab = e.target.closest('.vf-tab');
        if (!tab) return;
        complaintTab = tab.dataset.tab;
        const box = document.getElementById('globalSearchInput');
        if (box) box.value = '';
        if (typeof window.resetListSearch === 'function') window.resetListSearch();
        applyComplaintTab();
    });

    function switchView(viewId) {
        // #appeals and #passenger-reports (old links) open the Complaints page.
        if (viewId === 'appeals' || viewId === 'passenger-reports') {
            complaintTab = viewId === 'appeals' ? 'appeals' : 'cases';
            viewId = 'complaints';
        }
        navLinks.forEach(link => link.classList.toggle('active', link.dataset.view === viewId));
        views.forEach(view => view.classList.toggle('active', view.id === 'view-' + viewId));
        const search = document.getElementById('topbarSearch');
        if (search) {
            const show = SEARCH_VIEWS.includes(viewId);
            search.style.display = show ? '' : 'none';
            // A new page starts with an empty search box; the two list pages filter
            // their own list, the others jump to a result.
            const box = document.getElementById('globalSearchInput');
            if (box) {
                box.value = '';
                box.placeholder = SEARCH_PLACEHOLDERS[viewId] || 'Search drivers, passengers, bookings…';
            }
            if (typeof window.resetListSearch === 'function') window.resetListSearch();
            // Without the search box the bar only holds the bell and Admin, so it is compact.
            search.closest('.topbar')?.classList.toggle('topbar-compact', !show);
            if (!show) {
                const input = document.getElementById('globalSearchInput');
                if (input) input.value = '';
            }
        }
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
        applyComplaintTab();
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
    if (initialHash && (initialHash === 'appeals' || initialHash === 'passenger-reports' || document.getElementById('view-' + initialHash))) {
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
    let paymentMethodChart = null;
    window.currentDashboardDateFilter = 'Today';
    window.dashboardBookings = [];

    function formatCurrency(value) {
        return `₱${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    // The service fee is charged on top of the fare and split PARA / driver /
    // TODA (percentages saved in settings/fare; 12 / 4 / 4 until they load).
    // New bookings carry their own fee (mapBookingDoc); this is only used to
    // estimate it for bookings made before the fee existed.
    function getServiceFee() {
        const s = window.serviceFeeSettings || {};
        const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
        const para = num(s.paraPct, 12);
        const driver = num(s.driverPct, 4);
        const toda = num(s.todaPct, 4);
        return { paraPct: para, driverPct: driver, todaPct: toda, totalPct: para + driver + toda };
    }

    const trimPct = (value) => String(Number(Number(value).toFixed(2)));

    // One booking's service fee and its split: what the booking recorded, or
    // for an older booking without one, the current percentages applied to
    // its fare (estimated: true).
    function bookingFee(booking) {
        if (booking.hasServiceFee) {
            return { estimated: false, total: booking.serviceFee, para: booking.paraShare, driver: booking.driverShare, toda: booking.todaShare };
        }
        const fee = getServiceFee();
        const fare = Number(booking.totalFare) || 0;
        const part = (pct) => fare * pct / 100;
        return { estimated: true, total: part(fee.totalPct), para: part(fee.paraPct), driver: part(fee.driverPct), toda: part(fee.todaPct) };
    }

    // Fee totals over completed bookings.
    function sumFees(bookings) {
        return bookings.filter(isRevenueEligible).reduce((sum, b) => {
            const fee = bookingFee(b);
            sum.total += fee.total;
            sum.para += fee.para;
            sum.driver += fee.driver;
            sum.toda += fee.toda;
            if (fee.estimated) sum.estimatedRides += 1;
            return sum;
        }, { total: 0, para: 0, driver: 0, toda: 0, estimatedRides: 0 });
    }

    // The one Dashboard filter (Today / Weekly / Monthly / Yearly) drives the
    // cards, the trend chart and High Demand Areas, so they all read their
    // date range from here. Week, month and year are the current calendar
    // period up to now (the week runs Sunday→Saturday).
    function getPeriodBounds(filter) {
        const now = new Date();
        const start = new Date(now);
        const end = new Date(now);
        start.setHours(0, 0, 0, 0);
        switch (filter) {
            case 'Weekly':
                start.setDate(start.getDate() - start.getDay());
                return { start, end };
            case 'Monthly':
                start.setDate(1);
                return { start, end };
            case 'Yearly':
                start.setMonth(0, 1);
                return { start, end };
            default:
                return { start, end };
        }
    }

    const PERIOD_LABELS = { Today: 'Today', Weekly: 'This week', Monthly: 'This month', Yearly: 'This year' };

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
    // keep their quoted totalFare but never generate real revenue. Every ride
    // belongs to a TODA, so one under a TODA with no president account here
    // (sample data, a misspelled name) isn't counted either. Until the TODA
    // accounts have loaded there is nothing to compare with, so none are left out.
    function isRevenueEligible(booking) {
        if (booking.status !== 'completed') return false;
        const registered = registeredTodas();
        return !registered || registered.has(todaKey(booking.driverTodaName));
    }

    function getBookingMetrics(bookings, start, end) {
        const filtered = (bookings || []).filter((booking) => {
            const date = booking.createdAtRaw || new Date(booking.date || booking.createdAt || null);
            return date && !Number.isNaN(date.getTime()) && date >= start && date <= end;
        });
        const revenue = filtered.reduce((sum, booking) => sum + (isRevenueEligible(booking) ? (Number(booking.totalFare) || 0) : 0), 0);
        return {
            count: filtered.length,
            revenue,
            // PARA's share of the service fee on those fares.
            paraEarnings: sumFees(filtered).para
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
            const revenueTrend = currentMetrics.paraEarnings > previousMetrics.paraEarnings ? 'positive' : currentMetrics.paraEarnings < previousMetrics.paraEarnings ? 'negative' : 'neutral';
            cards[1].querySelector('h2').textContent = formatCurrency(currentMetrics.paraEarnings);
            cards[1].querySelector('.stat-change').textContent = formatChange(currentMetrics.paraEarnings, previousMetrics.paraEarnings);
            // What the number is made of, on hover.
            const fee = getServiceFee();
            cards[1].title = `PARA's share of the service fee on ${formatCurrency(currentMetrics.revenue)} in completed ride fares under registered TODAs (estimated at the current ${trimPct(fee.paraPct)}% for rides booked before the fee). The service fee is ${trimPct(fee.totalPct)}% on top of the fare: PARA ${trimPct(fee.paraPct)}%, driver ${trimPct(fee.driverPct)}%, TODA ${trimPct(fee.todaPct)}%. Click to open Analytics Overview.`;
            cards[1].querySelector('.stat-change').className = `stat-change ${revenueTrend}`;
        }
        // "Active Drivers/Passengers" is a current total, not a period-scoped count —
        // there's no historical snapshot of who was active in the past to diff
        // against. The honest, computable trend is new sign-ups in this period
        // (registration timestamps are real data) rather than a fabricated delta
        // on the total itself.
        const periodPhrase = (PERIOD_LABELS[filter] || 'this period').toLowerCase();
        ['dashboardChartPeriod', 'highDemandPeriod'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = PERIOD_LABELS[filter] || '';
        });
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

    // "Today" buckets the current day by hour.
    function aggregateDailyData(bookings) {
        const labels = Array.from({ length: 24 }, (_, hour) => `${hour % 12 || 12}${hour < 12 ? 'AM' : 'PM'}`);
        const counts = Array(24).fill(0);
        const revenue = Array(24).fill(0);
        const today = new Date().toDateString();

        bookings.forEach((booking) => {
            const date = new Date(booking.createdAtRaw || booking.date || booking.createdAt || null);
            if (Number.isNaN(date.getTime()) || date.toDateString() !== today) return;
            const hour = date.getHours();
            counts[hour] += 1;
            if (isRevenueEligible(booking)) revenue[hour] += booking.totalFare || 0;
        });

        return { labels, counts, revenue };
    }

    function aggregateWeeklyData(bookings) {
        const labels = [];
        const counts = Array(7).fill(0);
        const revenue = Array(7).fill(0);
        // Days after today stay at 0 until they happen.
        const start = getPeriodBounds('Weekly').start;

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

    // Reports → Monthly Ride Report: completed and cancelled bookings in each
    // week of the month picked on the Reports page (days 1-7, 8-14, 15-21 and
    // 22 to the end). Other statuses (declined, pending…) aren't shown.
    function weeklyRideOutcomes(bookings) {
        const completed = [0, 0, 0, 0];
        const cancelled = [0, 0, 0, 0];
        bookingsInReportsMonth(bookings).forEach((booking) => {
            const date = new Date(booking.createdAtRaw);
            const week = Math.min(3, Math.floor((date.getDate() - 1) / 7));
            const status = String(booking.status || '').toLowerCase();
            if (status === 'completed') completed[week] += 1;
            else if (status === 'cancelled' || status === 'canceled') cancelled[week] += 1;
        });
        return { labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], completed, cancelled };
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

    // Location text is free-form rider input ("School", "school", "SCHOOL Gate"),
    // so group by a case-insensitive key and keep a clean, trimmed label for display.
    function normalizeLocationKey(value) {
        return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function computeHighDemandAreas(bookings) {
        const windowStart = getPeriodBounds(window.currentDashboardDateFilter).start;

        const areaCounts = {};
        const areaLabels = {};
        bookings.forEach((booking) => {
            if (booking.status !== 'completed') return; // a ride count, so every TODA's rides stay in
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
        switch (window.currentDashboardDateFilter) {
            case 'Monthly':
                aggregated = aggregateMonthlyData(dashboardBookings);
                break;
            case 'Yearly':
                aggregated = aggregateYearlyData(dashboardBookings);
                break;
            case 'Weekly':
                aggregated = aggregateWeeklyData(dashboardBookings);
                break;
            default:
                aggregated = aggregateDailyData(dashboardBookings);
        }

        dashboardChart.data.labels = aggregated.labels;
        dashboardChart.data.datasets[0].data = aggregated.counts;
        dashboardChart.data.datasets[1].data = aggregated.revenue;
        dashboardChart.update();
    }

    function updateStaticCharts() {
        if (monthlyRidesChart) {
            const outcomes = weeklyRideOutcomes(dashboardBookings);
            monthlyRidesChart.data.labels = outcomes.labels;
            monthlyRidesChart.data.datasets[0].data = outcomes.completed;
            monthlyRidesChart.data.datasets[1].data = outcomes.cancelled;
            monthlyRidesChart.update();
        }

        if (peakHoursRidesChart) {
            // One bar per hour of the day, the same hourly figures as the summary
            // line above the chart and the CSV export. The busiest hour is the
            // darkest bar.
            const { totals, days } = peakHourStats(dashboardBookings);
            const averages = totals.map((count) => Math.round((count / days) * 10) / 10);
            const peak = Math.max(...totals);
            peakHoursRidesChart.data.labels = totals.map((_, hour) => shortHourLabel(hour));
            peakHoursRidesChart.data.datasets[0].data = averages;
            peakHoursRidesChart.data.datasets[0].backgroundColor = totals.map((count) => (peak > 0 && count === peak ? '#05CD99' : 'rgba(5, 205, 153, 0.35)'));
            peakHoursRidesChart.$totals = totals;
            peakHoursRidesChart.$days = days;
            peakHoursRidesChart.update();
        }
    }

    // Bookings per hour of the day (0-23) for the month picked on the Reports
    // page, and how many different days they fall on. Averages are "per day
    // that had bookings", so a quiet half-empty month isn't dragged down.
    function peakHourStats(bookings) {
        const totals = Array(24).fill(0);
        const dayKeys = new Set();
        bookingsInReportsMonth(bookings).forEach((b) => {
            const date = new Date(b.createdAtRaw);
            totals[date.getHours()] += 1;
            dayKeys.add(date.toDateString());
        });
        return { totals, days: Math.max(1, dayKeys.size) };
    }

    // "6AM", "12PM" — short enough to label all 24 bars.
    function shortHourLabel(hour) {
        return `${hour % 12 || 12}${hour < 12 ? 'AM' : 'PM'}`;
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
                    backgroundColor: '#05CD99',
                    borderRadius: 5,
                }, {
                    label: 'Cancelled',
                    data: [0, 0, 0, 0],
                    backgroundColor: '#EE5D50',
                    borderRadius: 5,
                }]
            },
            options: {
                ...chartDefaults,
                plugins: { legend: chartDefaults.plugins.legend },
                scales: {
                    y: { beginAtZero: true, grid: { color: gridColor }, ticks: { font: { size: 11 }, precision: 0 } },
                    x: { grid: { display: false }, ticks: { font: { size: 11 } } }
                }
            }
        });
    }

    const ctxPeak = document.getElementById('peakHoursRidesChart');
    if (ctxPeak) {
        peakHoursRidesChart = new Chart(ctxPeak, {
            type: 'bar',
            data: {
                labels: Array.from({ length: 24 }, (_, hour) => `${hour % 12 || 12}${hour < 12 ? 'AM' : 'PM'}`),
                datasets: [{
                    label: 'Avg. bookings per hour',
                    data: Array(24).fill(0),
                    backgroundColor: 'rgba(5, 205, 153, 0.35)',
                    borderRadius: 4,
                    maxBarThickness: 26
                }]
            },
            options: {
                ...chartDefaults,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => (items.length ? formatHourLabel(items[0].dataIndex) : ''),
                            label: (ctx) => {
                                const total = (ctx.chart.$totals || [])[ctx.dataIndex] || 0;
                                const days = ctx.chart.$days || 1;
                                return `${ctx.raw} bookings per day (${total} in total over ${days} day${days === 1 ? '' : 's'})`;
                            }
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: gridColor }, ticks: { font: { size: 11 }, precision: 0 }, title: { display: true, text: 'Bookings per day', font: { size: 11 } } },
                    x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: false } }
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
        // Update Reports & Analytics panels (payment methods, monthly rides, peak hour)
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

    // The TODAs that have a president account on this site, by name ignoring
    // capital letters; null until those accounts have loaded.
    function todaKey(name) {
        return String(name || '').trim().toLowerCase();
    }
    // Cached per accounts list: this runs for every booking on every redraw.
    let registeredTodasCache = { source: null, map: null };
    function registeredTodas() {
        const accounts = window.todaPresidentAccounts;
        if (!accounts) return null;
        if (registeredTodasCache.source === accounts) return registeredTodasCache.map;
        const registered = new Map();
        accounts.forEach((account) => {
            if (todaKey(account.todaName)) registered.set(todaKey(account.todaName), String(account.todaName).trim());
        });
        registeredTodasCache = { source: accounts, map: registered };
        return registered;
    }

    function updateReportsStats(bookings) {
        updatePaymentComparison(bookings);

        // Peak hour of the selected month lives in the Peak Hours Analysis
        // card's subtitle instead of its own stat card.
        const monthLabel = reportsMonthBounds().label;
        const { totals, days } = peakHourStats(bookings);
        const peakSummaryEl = document.getElementById('peakHourSummary');
        if (!peakSummaryEl) return;
        const peakCount = Math.max(...totals);
        if (!peakCount) {
            peakSummaryEl.textContent = `No bookings in ${monthLabel}.`;
            return;
        }
        const maxHour = totals.indexOf(peakCount);
        const avgPerDay = (peakCount / days).toFixed(1);
        peakSummaryEl.textContent = `Peak hour in ${monthLabel}: ${formatHourLabel(maxHour)} · ${avgPerDay} bookings per day at that hour (${peakCount} in total, across ${days} day${days === 1 ? '' : 's'} with bookings)`;
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
    // The three tables are Excel workbooks (title block, header row, sized columns,
    // amounts as real numbers with a peso format, a totals row). The monthly report
    // is a PDF. All four say who generated them and when.
    function bookingDate(booking) {
        return booking.createdAtRaw || new Date(booking.date || booking.createdAt || null);
    }

    function exportStamp() {
        return `Generated ${ParaFirestore.formatDateTime(new Date())} by ${window.ParaAdminName || 'PARA Admin'}`;
    }

    // "no_show" -> "No show"
    function nicely(text) {
        const spaced = String(text || '').replace(/_/g, ' ').trim();
        return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : '—';
    }

    const EXPORT_FORMATS = { money: '"₱"#,##0.00', int: '#,##0', dec1: '0.0', pct: '0.0%' };

    // One sheet: a title block, a blank line, the header row, the data, and an
    // optional totals row. formats[i] says how column i's numbers are shown.
    function exportWorkbook({ filename, sheetName, title, notes = [], headers, rows, widths, formats = [], totalRow }) {
        if (!window.XLSX) {
            showToast('The Excel library failed to load.', 'error');
            return false;
        }
        const top = [[title], ...notes.map((note) => [note]), [exportStamp()]];
        const headerIndex = top.length + 1;
        const aoa = [...top, [], headers, ...rows];
        if (totalRow) aoa.push([], totalRow);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const lastCol = headers.length - 1;
        ws['!merges'] = top.map((_, r) => ({ s: { r, c: 0 }, e: { r, c: lastCol } }));
        ws['!cols'] = widths.map((wch) => ({ wch }));
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerIndex, c: 0 }, e: { r: headerIndex + rows.length, c: lastCol } }) };

        const formatRow = (r) => {
            formats.forEach((kind, c) => {
                const cell = ws[XLSX.utils.encode_cell({ r, c })];
                if (cell && cell.t === 'n' && EXPORT_FORMATS[kind]) cell.z = EXPORT_FORMATS[kind];
            });
        };
        for (let i = 0; i < rows.length; i++) formatRow(headerIndex + 1 + i);
        if (totalRow) formatRow(headerIndex + rows.length + 2);

        const wb = XLSX.utils.book_new();
        wb.Props = { Title: title, Author: window.ParaAdminName || 'PARA Admin', CreatedDate: new Date() };
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, filename);
        return true;
    }

    const isoToday = () => new Date().toISOString().slice(0, 10);
    const clock = (date) => date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

    window.exportDailyRideReport = function() {
        const bounds = getPeriodBounds('Today');
        const rides = (dashboardBookings || [])
            .filter((b) => {
                const d = bookingDate(b);
                return d && !Number.isNaN(d.getTime()) && d >= bounds.start && d <= bounds.end;
            })
            .sort((a, b) => bookingDate(a) - bookingDate(b));

        if (!rides.length) {
            showToast('No rides recorded today.', 'warning');
            return;
        }
        const completed = rides.filter((b) => b.status === 'completed').length;
        const cancelled = rides.filter((b) => b.status === 'cancelled').length;
        const counted = rides.filter(isRevenueEligible);
        const totalFare = Math.round(counted.reduce((sum, b) => sum + (Number(b.totalFare) || 0), 0) * 100) / 100;
        const rows = rides.map((b) => [
            b.ref, clock(bookingDate(b)), nicely(b.status), b.driverName || '—', b.plate || '—', b.passengerName || '—',
            b.pickupLocation || '—', b.dropoffLocation || '—', Number(b.totalFare) || 0, b.paymentMethod || '—', nicely(b.paymentStatus)
        ]);
        const done = exportWorkbook({
            filename: `PARA-Daily-Ride-Report-${isoToday()}.xlsx`,
            sheetName: 'Daily Rides',
            title: 'PARA - Daily Ride Report',
            notes: [
                new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
                `${rides.length} ride${rides.length === 1 ? '' : 's'} · ${completed} completed · ${cancelled} cancelled`,
                'The total counts completed rides under registered TODAs only.'
            ],
            headers: ['Booking Ref', 'Time', 'Status', 'Driver', 'Plate', 'Passenger', 'Pickup', 'Drop-off', 'Fare', 'Payment', 'Payment Status'],
            rows,
            widths: [38, 10, 12, 22, 11, 22, 38, 38, 13, 10, 14],
            formats: [null, null, null, null, null, null, null, null, 'money'],
            totalRow: ['Total fares (completed rides)', '', '', '', '', '', '', '', totalFare]
        });
        if (done) showToast(`Exported ${rides.length} ride(s).`, 'success');
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
            const sorted = drivers.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            let totalRides = 0;
            let suspended = 0;
            const rows = sorted.map((d) => {
                const stats = ParaFirestore.computeDriverStats(d, bookings);
                totalRides += stats.completed;
                const isSuspended = String(d.accountStatus || '').toLowerCase() === 'suspended';
                if (isSuspended) suspended += 1;
                const rating = Number(d.rating);
                return [d.name || '—', d.todaName || '—', d.vehicle || '—', d.plate || '—', Number.isFinite(rating) && rating > 0 ? rating : '—', stats.completed, stats.acceptanceRate || '—', isSuspended ? 'Suspended' : 'Active'];
            });
            const done = exportWorkbook({
                filename: `PARA-Driver-Activity-${isoToday()}.xlsx`,
                sheetName: 'Driver Activity',
                title: 'PARA - Driver Activity',
                notes: [
                    `${sorted.length} approved driver${sorted.length === 1 ? '' : 's'} · ${sorted.length - suspended} active · ${suspended} suspended`,
                    'Completed rides and acceptance rate are worked out from all recorded bookings.'
                ],
                headers: ['Driver', 'TODA', 'Tricycle No.', 'Plate', 'Rating', 'Completed Rides', 'Acceptance Rate', 'Status'],
                rows,
                widths: [26, 20, 14, 12, 9, 16, 17, 12],
                formats: [null, null, null, null, 'dec1', 'int'],
                totalRow: ['Total completed rides', '', '', '', '', totalRides, '', '']
            });
            if (done) showToast(`Exported ${rows.length} driver(s).`, 'success');
        } catch (error) {
            console.error('Failed to export driver activity:', error);
            showToast('Could not export driver activity.', 'error');
        }
    };

    window.exportPeakHoursAnalysis = function() {
        // Follows the month picked on the Reports page, like the chart does.
        const { totals, days } = peakHourStats(dashboardBookings);
        const sum = totals.reduce((a, b) => a + b, 0);
        const peak = Math.max(...totals);
        const peakHour = totals.indexOf(peak);
        const month = reportsMonthBounds().label;
        const rows = totals.map((count, hour) => [formatHourLabel(hour), count, days ? count / days : 0, sum ? count / sum : 0]);
        const done = exportWorkbook({
            filename: `PARA-Peak-Hours-${monthKey(reportsMonthBounds().start)}.xlsx`,
            sheetName: 'Peak Hours',
            title: `PARA - Peak Hours Analysis, ${month}`,
            notes: [
                peak ? `Peak hour: ${formatHourLabel(peakHour)} with ${(days ? peak / days : 0).toFixed(1)} bookings per day (${peak} in total).` : 'No bookings in this month.',
                `Counted across ${days} day${days === 1 ? '' : 's'} with bookings.`
            ],
            headers: ['Hour', 'Bookings', 'Average per Day', 'Share of Bookings'],
            rows,
            widths: [14, 12, 17, 18],
            formats: [null, 'int', 'dec1', 'pct'],
            totalRow: ['Total', sum, days ? Math.round(sum / days * 10) / 10 : 0, sum ? 1 : 0]
        });
        if (done) showToast('Peak hours analysis exported.', 'success');
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
        const php = (value) => `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const PAGE_W = 210;
        const M = 14;
        const W = PAGE_W - M * 2;
        const NAVY = [27, 37, 75];
        const MUTED = [110, 120, 150];
        const RULE = [226, 231, 242];
        const PANEL = [244, 247, 252];
        const monthLabel = bounds.label;

        // Only completed rides under a registered TODA count toward the money — the
        // same rule as the revenue figures everywhere else in the app.
        const counted = rows.filter(isRevenueEligible);
        const totalFare = counted.reduce((sum, b) => sum + (Number(b.totalFare) || 0), 0);
        const completed = rows.filter((b) => b.status === 'completed').length;
        const cancelled = rows.filter((b) => b.status === 'cancelled').length;
        const fee = getServiceFee();
        const fees = sumFees(rows);

        // Title band
        doc.setFillColor(...NAVY);
        doc.rect(0, 0, PAGE_W, 30, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont(undefined, 'bold');
        doc.setFontSize(19);
        doc.text('PARA Monthly Ride Report', M, 14);
        doc.setFont(undefined, 'normal');
        doc.setFontSize(11);
        doc.setTextColor(200, 210, 235);
        doc.text(monthLabel, M, 22.5);
        doc.setFontSize(8.5);
        doc.text(exportStamp(), PAGE_W - M, 22.5, { align: 'right' });

        // Two rows of summary boxes
        const gap = 4;
        const boxW = (W - gap * 3) / 4;
        const box = (x, y, label, value) => {
            doc.setFillColor(...PANEL);
            doc.roundedRect(x, y, boxW, 17, 2, 2, 'F');
            doc.setFont(undefined, 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(...MUTED);
            doc.text(label.toUpperCase(), x + 4, y + 6);
            doc.setFont(undefined, 'bold');
            doc.setFontSize(12);
            doc.setTextColor(...NAVY);
            doc.text(String(value), x + 4, y + 13.2);
        };
        const stats1 = [['Total rides', rows.length], ['Completed', completed], ['Cancelled', cancelled], ['Total fares', php(totalFare)]];
        const stats2 = [[`Service fee (${trimPct(fee.totalPct)}%)`, php(fees.total)], [`PARA (${trimPct(fee.paraPct)}%)`, php(fees.para)], [`Drivers (${trimPct(fee.driverPct)}%)`, php(fees.driver)], [`TODAs (${trimPct(fee.todaPct)}%)`, php(fees.toda)]];
        stats1.forEach(([label, value], i) => box(M + i * (boxW + gap), 38, label, value));
        stats2.forEach(([label, value], i) => box(M + i * (boxW + gap), 38 + 17 + gap, label, value));

        doc.setFont(undefined, 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...MUTED);
        const estimated = fees.estimatedRides ? ` ${fees.estimatedRides} ride(s) booked before the service fee are estimated at today's percentages.` : '';
        const note = doc.splitTextToSize(`Fares and fees count completed rides under registered TODAs only. The service fee is charged on top of the fare.${estimated}`, W);
        doc.text(note, M, 80);

        // Rides table
        const headers = ['Ref', 'Date', 'Status', 'Driver', 'Passenger', 'Fare'];
        const widths = [36, 31, 22, 36, 33, 24];
        const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
        const BOTTOM = 276;
        const tableHeader = (y) => {
            doc.setFillColor(...NAVY);
            doc.rect(M, y, W, 7.5, 'F');
            doc.setFont(undefined, 'bold');
            doc.setFontSize(8.5);
            doc.setTextColor(255, 255, 255);
            headers.forEach((h, i) => {
                if (i === 5) doc.text(h, xs[i] + widths[i] - 2, y + 5.2, { align: 'right' });
                else doc.text(h, xs[i] + 2, y + 5.2);
            });
            return y + 7.5;
        };
        const statusColor = (status) => (status === 'completed' ? [5, 150, 110] : status === 'cancelled' ? [200, 70, 60] : MUTED);
        const stamp = (date) => (date && !Number.isNaN(new Date(date).getTime())
            ? new Date(date).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : '—');

        let y = tableHeader(80 + note.length * 3.6 + 3);
        rows.forEach((b, index) => {
            const cells = [String(b.ref || '—'), stamp(bookingDate(b)), nicely(b.status), b.driverName || '—', b.passengerName || '—', php(b.totalFare)];
            doc.setFont(undefined, 'normal');
            doc.setFontSize(8.5);
            const wrapped = cells.map((c, i) => doc.splitTextToSize(c, widths[i] - 4));
            const lines = Math.max(1, ...wrapped.map((l) => l.length));
            const rowH = lines * 4.2 + 3.4;
            if (y + rowH > BOTTOM) {
                doc.addPage();
                y = tableHeader(16);
            }
            if (index % 2) {
                doc.setFillColor(250, 251, 254);
                doc.rect(M, y, W, rowH, 'F');
            }
            wrapped.forEach((cellLines, i) => {
                if (i === 2) doc.setTextColor(...statusColor(b.status));
                else doc.setTextColor(...NAVY);
                doc.setFont(undefined, i === 5 ? 'bold' : 'normal');
                cellLines.forEach((line, li) => {
                    const ty = y + 4.6 + li * 4.2;
                    if (i === 5) doc.text(line, xs[i] + widths[i] - 2, ty, { align: 'right' });
                    else doc.text(line, xs[i] + 2, ty);
                });
            });
            doc.setDrawColor(...RULE);
            doc.setLineWidth(0.2);
            doc.line(M, y + rowH, M + W, y + rowH);
            y += rowH;
        });

        // Total line
        if (y + 12 > BOTTOM) {
            doc.addPage();
            y = 16;
        }
        doc.setFont(undefined, 'bold');
        doc.setFontSize(10);
        doc.setTextColor(...NAVY);
        doc.setDrawColor(...NAVY);
        doc.setLineWidth(0.5);
        doc.line(M, y + 3, M + W, y + 3);
        doc.text('Total fares (completed rides)', M + 2, y + 10);
        doc.text(php(totalFare), M + W - 2, y + 10, { align: 'right' });

        // Footer on every page
        const pages = doc.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i);
            doc.setDrawColor(...RULE);
            doc.setLineWidth(0.2);
            doc.line(M, 284, M + W, 284);
            doc.setFont(undefined, 'normal');
            doc.setFontSize(8);
            doc.setTextColor(...MUTED);
            doc.text(`PARA Admin · Monthly Ride Report · ${monthLabel}`, M, 289);
            doc.text(`Page ${i} of ${pages}`, M + W, 289, { align: 'right' });
        }

        doc.save(`PARA-Monthly-Ride-Report-${monthKey(bounds.start)}.pdf`);
        showToast(`Exported ${rows.length} ride(s) to PDF.`, 'success');
    };

    // ── Fare Calculator Preview ───────────────────────────────────
    // The fare is PER PERSON:
    //   fare per person = minimumFare + max(0, km - includedDistanceKm) * perKmRate
    // A shared ride: each rider pays that. A solo ride pays for two persons, so
    // it costs twice as much. The service fee is a percentage of the ride's
    // total, on top of it.
    function updateFarePreview() {
        const minFare = parseFloat(document.getElementById('fare-min')?.value) || 0;
        const included = parseFloat(document.getElementById('fare-included')?.value) || 0;
        const perKm = parseFloat(document.getElementById('fare-perkm')?.value) || 0;

        const exampleKm = 3;
        const extraKm = Math.max(0, exampleKm - included);
        const extra = extraKm * perKm;
        const person = minFare + extra;
        const solo = person * 2; // a solo rider pays for two persons

        const el = (id) => document.getElementById(id);
        const peso = (value) => `₱${value.toFixed(2)}`;
        const kmText = (value) => String(Number(value.toFixed(2)));
        if (el('prev-min')) el('prev-min').textContent = peso(minFare);
        if (el('prev-km-label')) el('prev-km-label').textContent = `Extra distance (${kmText(extraKm)} km beyond the first ${kmText(included)} km)`;
        if (el('prev-km')) el('prev-km').textContent = peso(extra);
        if (el('prev-total')) el('prev-total').textContent = peso(person);
        if (el('prev-solo')) el('prev-solo').textContent = peso(solo);
        if (el('prev-shared')) el('prev-shared').textContent = peso(person);

        // Service fee: a percentage of the fare, added on top and split three ways.
        const pct = (id) => Math.max(0, parseFloat(document.getElementById(id)?.value) || 0);
        const paraPct = pct('fare-fee-para');
        const driverPct = pct('fare-fee-driver');
        const todaPct = pct('fare-fee-toda');
        const totalPct = paraPct + driverPct + todaPct;
        const share = (value) => solo * value / 100;
        if (el('fare-fee-total')) {
            el('fare-fee-total').textContent = `${trimPct(totalPct)}%`;
            el('fare-fee-total').style.color = totalPct > 100 ? 'var(--status-decl-text)' : 'var(--text-main)';
        }
        if (el('prev-fee-pct')) el('prev-fee-pct').textContent = trimPct(totalPct);
        if (el('prev-fee-para-pct')) el('prev-fee-para-pct').textContent = trimPct(paraPct);
        if (el('prev-fee-driver-pct')) el('prev-fee-driver-pct').textContent = trimPct(driverPct);
        if (el('prev-fee-toda-pct')) el('prev-fee-toda-pct').textContent = trimPct(todaPct);
        if (el('prev-fee')) el('prev-fee').textContent = peso(share(totalPct));
        if (el('prev-fee-para')) el('prev-fee-para').textContent = peso(share(paraPct));
        if (el('prev-fee-driver')) el('prev-fee-driver').textContent = peso(share(driverPct));
        if (el('prev-fee-toda')) el('prev-fee-toda').textContent = peso(share(todaPct));
        // Tide surcharge: a flat amount on top of what each rider pays.
        // Below the first level: nothing. From it up to below the higher level: the
        // first fee. At the higher level and above: the second fee.
        const amount = (id) => Math.max(0, parseFloat(document.getElementById(id)?.value) || 0);
        const tideFrom = amount('fare-tide-from');
        const tideHigh = amount('fare-tide-high');
        const tideLevel = parseFloat(el('prev-tide')?.value);
        const tideFee = !Number.isFinite(tideLevel) ? 0
            : tideLevel >= tideHigh ? amount('fare-tide-high-fee')
            : tideLevel >= tideFrom ? amount('fare-tide-fee') : 0;
        if (el('tide-lbl-from')) el('tide-lbl-from').textContent = trimPct(tideFrom);
        if (el('tide-lbl-high')) el('tide-lbl-high').textContent = trimPct(tideHigh);
        ['prev-tide-row', 'prev-shared-tide-row'].forEach((id) => { if (el(id)) el(id).style.display = tideFee > 0 ? '' : 'none'; });
        if (el('prev-tide-fee')) el('prev-tide-fee').textContent = peso(tideFee);
        if (el('prev-shared-tide-fee')) el('prev-shared-tide-fee').textContent = peso(tideFee);
        if (el('prev-pay')) el('prev-pay').textContent = peso(solo + share(totalPct) + tideFee);
        if (el('prev-shared-pct')) el('prev-shared-pct').textContent = trimPct(totalPct);
        if (el('prev-shared-fee')) el('prev-shared-fee').textContent = peso(person * totalPct / 100);
        if (el('prev-shared-pay')) el('prev-shared-pay').textContent = peso(person * (1 + totalPct / 100) + tideFee);
    }

    window.updateFarePreview = updateFarePreview;

    ['fare-min', 'fare-included', 'fare-perkm', 'fare-fee-para', 'fare-fee-driver', 'fare-fee-toda', 'fare-tide-from', 'fare-tide-high', 'fare-tide-fee', 'fare-tide-high-fee', 'prev-tide'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateFarePreview);
    });
    updateFarePreview();
    // Driver Management controls are handled by dropdown menu selections.
});

// ── Dashboard Date Filter ─────────────────────────────────────────
window.selectDashboardDate = function(dateStr) {
    const textSpan = document.getElementById('dashboardDateText');
    const dropdown = document.getElementById('dashboardDateDropdown');
    if (textSpan) textSpan.textContent = dateStr;
    if (dropdown) dropdown.classList.remove('show');

    // One filter for the whole Dashboard: re-render the cards, trend chart
    // and High Demand Areas for the new period.
    window.currentDashboardDateFilter = dateStr;
    window.renderDashboardCharts(window.dashboardBookings);
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
        showToast(`Resubmission request saved for ${selected.length} document(s).`, 'success');
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
    btn.disabled = false;
    btn.style.background = confirmColor;
    btn.style.color = 'white';
    btn.onclick = () => { closeModal('genericConfirmModal'); onConfirm(); };

    const icon = document.getElementById('confirmIcon');
    icon.style.background = confirmColor + '1A';
    icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${confirmColor}" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

    modal.classList.add('active');
}

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

