document.addEventListener('DOMContentLoaded', async () => {
    if (!window.ParaFirestore) return;

    const user = await ParaFirestore.requireAdmin();
    if (!user) return;
    const dashboardMain = document.getElementById('dashboardMain');
    if (dashboardMain) dashboardMain.style.display = '';

    async function loadAdminIdentity() {
        const emailInput = document.getElementById('settingsAdminEmail');
        if (emailInput) emailInput.value = user.email || '';

        let displayName = user.email || 'Admin';
        try {
            const doc = await ParaFirestore.db.collection('admins').doc(user.uid).get();
            const fullName = doc.exists ? (doc.data().fullName || '') : '';
            if (fullName) displayName = fullName;
        } catch (error) {
            console.error('Failed to load admin profile:', error);
        }

        const nameInput = document.getElementById('settingsAdminName');
        if (nameInput) nameInput.value = displayName === user.email ? '' : displayName;

        const nameLabel = document.getElementById('adminNameLabel');
        if (nameLabel) nameLabel.textContent = displayName;

        const avatar = document.getElementById('adminAvatar');
        if (avatar) {
            const initials = displayName
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase();
            avatar.textContent = initials || 'A';
        }
    }
    loadAdminIdentity();

    window.saveAdminName = async function() {
        const nameInput = document.getElementById('settingsAdminName');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) {
            window.showToast('Please enter a display name.', 'warning');
            return;
        }
        try {
            await ParaFirestore.db.collection('admins').doc(user.uid).set({ fullName: name }, { merge: true });
            window.showToast('Display name updated.', 'success');
            loadAdminIdentity();
        } catch (error) {
            console.error('Failed to update display name:', error);
            window.showToast('Failed to update display name.', 'error');
        }
    };

    let currentVerificationDriverId = null;
    let currentEditDriverId = null;
    let currentEditPassengerId = null;
    let currentComplaintId = null;
    let currentVerificationFilter = 'pending';

    window.driverMgmtStatusFilter = 'all';
    window.driverMgmtSortMode = 'rating-desc';
    window.passengerMgmtStatusFilter = 'all';
    window.bookingStatusFilter = 'all';
    window.allBookings = [];

    const statusBadge = {
        pending: { className: 'processing', label: 'PENDING' },
        reviewing: { className: 'processing', label: 'REVIEWING' },
        approved: { className: 'approved', label: 'APPROVED' },
        rejected: { className: 'declined', label: 'REJECTED' },
        resolved: { className: 'approved', label: 'RESOLVED' },
        completed: { className: 'approved', label: 'COMPLETED' },
        cancelled: { className: 'declined', label: 'CANCELLED' },
        active: { className: 'approved', label: 'ACTIVE' },
        suspended: { className: 'declined', label: 'SUSPENDED' },
        disabled: { className: 'declined', label: 'DISABLED' },
        flagged: { className: 'processing', label: 'FLAGGED', style: 'background:#FFF1D6;color:#FF9E2A;' },
        processing: { className: 'processing', label: 'PROCESSING' },
        ongoing: { className: 'processing', label: 'ONGOING' },
        declined: { className: 'declined', label: 'DECLINED' }
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderBadge(status, customLabel) {
        const key = ParaFirestore.normalizeStatus(status);
        const badge = statusBadge[key] || { className: 'processing', label: String(status || 'UNKNOWN').toUpperCase() };
        const style = badge.style ? ` style="${badge.style}"` : '';
        return `<span class="status-badge ${badge.className}"${style}>${escapeHtml(customLabel || badge.label)}</span>`;
    }

    function emptyRow(colspan, message) {
        return `<tr><td colspan="${colspan}" style="text-align:center; color:var(--text-muted); padding:28px;">${escapeHtml(message)}</td></tr>`;
    }

    // Delegated click handling for row-action buttons rendered via innerHTML.
    // Data comes through dataset (real strings), never re-parsed as JS/HTML,
    // so untrusted names/ids can't break out of an inline onclick attribute.
    function bindRowActions(tbody, handlers) {
        if (!tbody || tbody.dataset.actionsBound) return;
        tbody.dataset.actionsBound = '1';
        tbody.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn || !tbody.contains(btn)) return;
            const handler = handlers[btn.dataset.action];
            if (typeof handler === 'function') handler(btn.dataset, btn);
        });
    }

    function setDocImage(linkId, imgId, url, emptyId) {
        const link = document.getElementById(linkId);
        const img = document.getElementById(imgId);
        const empty = emptyId ? document.getElementById(emptyId) : null;
        if (!link || !img) return;

        if (!url) {
            link.removeAttribute('href');
            link.style.display = 'none';
            img.removeAttribute('src');
            img.style.display = 'none';
            if (empty) empty.style.display = 'block';
            return;
        }

        link.href = url;
        link.style.display = 'flex';
        img.src = url;
        img.style.display = 'block';
        if (empty) empty.style.display = 'none';
    }

    function renderVerificationTable(drivers) {
        const tbody = document.querySelector('#view-driver-verification .data-table tbody');
        if (!tbody) return;

        if (!drivers.length) {
            tbody.innerHTML = emptyRow(5, 'No driver applications found for this status.');
            return;
        }

        tbody.innerHTML = drivers.map((driver) => {
            const label = currentVerificationFilter === 'pending' ? 'Review' : 'View Details';
            const btnStyle = currentVerificationFilter === 'pending' ? '' : ' style="background:var(--bg-light);color:var(--text-main);"';
            const btn = `<button class="action-btn"${btnStyle} data-action="review-driver" data-id="${escapeHtml(driver.id)}">${label}</button>`;
            // Pending covers both "never looked at" and "already reviewed once, waiting
            // on the driver to resubmit requested documents" — flag the latter so it
            // doesn't get mistaken for (or re-requested as) a fresh application.
            const infoRequestNote = (currentVerificationFilter === 'pending' && driver.infoRequest)
                ? `<div class="detail-sub" style="color:#B8860B; margin-top:4px;">Awaiting driver response</div>`
                : '';
            return `<tr>
                <td><div class="detail-main">${escapeHtml(driver.name)}</div><div class="detail-sub">Lic: ${escapeHtml(driver.license)}</div></td>
                <td><div class="detail-main">${escapeHtml(driver.vehicle)}</div><div class="detail-sub">Plate: ${escapeHtml(driver.plate)}</div></td>
                <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(driver.submittedAt)}</td>
                <td>${renderBadge(driver.verificationStatus)}${infoRequestNote}</td>
                <td>${btn}</td>
            </tr>`;
        }).join('');

        bindRowActions(tbody, {
            'review-driver': (ds) => window.openVerificationModal(ds.id)
        });
    }

    function getDriverPerformanceStars(rating) {
        const numericRating = Number(rating || 0);
        if (!Number.isFinite(numericRating) || numericRating <= 0) return '☆☆☆☆☆';
        const normalized = Math.min(Math.max(numericRating, 0), 5);
        const filled = Math.round(normalized);
        return '★'.repeat(filled) + '☆'.repeat(5 - filled);
    }

    function renderDriverManagementTable(drivers) {
        const tbody = document.querySelector('#view-driver-management .data-table tbody');
        if (!tbody) return;
        // store drivers for client-side filtering/sorting, with ride count and
        // acceptance rate filled in — computed from bookings, since the app
        // doesn't store either on the driver doc.
        const bookingsForStats = window.allBookings || window.dashboardBookings || [];
        drivers = (drivers || []).map((d) => {
            const stats = ParaFirestore.computeDriverStats(d, bookingsForStats);
            return { ...d, totalRides: stats.completed, acceptanceRate: stats.acceptanceRate };
        });
        window.driverManagementDrivers = drivers;

        const statusFilter = window.driverMgmtStatusFilter || 'all';
        const sortMode = window.driverMgmtSortMode || 'rating-desc';

        let list = (drivers || []).slice();
        if (statusFilter !== 'all') {
            list = list.filter(d => {
                const acc = String(d.accountStatus || '').toLowerCase();
                if (statusFilter === 'active') return acc !== 'suspended' && acc !== 'declined';
                if (statusFilter === 'suspended') return acc === 'suspended' || acc === 'declined';
                return true;
            });
        }

        if (!list.length) {
            tbody.innerHTML = emptyRow(5, 'No approved drivers found in Firestore.');
            return;
        }

        // sorting: rating-desc, rating-asc, rides-desc, rides-asc
        list.sort((a, b) => {
            const aRating = Number(a.rating) || 0;
            const bRating = Number(b.rating) || 0;
            const aRides = Number(a.totalRides) || 0;
            const bRides = Number(b.totalRides) || 0;
            if (sortMode === 'rating-desc') return bRating - aRating;
            if (sortMode === 'rating-asc') return aRating - bRating;
            if (sortMode === 'rides-desc') return bRides - aRides;
            if (sortMode === 'rides-asc') return aRides - bRides;
            return 0;
        });

        tbody.innerHTML = list.map((driver) => {
            const isSuspended = driver.accountStatus === 'suspended';
            const ratingValue = Number(driver.rating) || 0;
            const actionBtn = isSuspended
                ? `<button class="action-btn" style="background:#05CD99;" data-action="reactivate-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">Reactivate</button>`
                : `<button class="action-btn" style="background:#EE5D50;" data-action="ban-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">Deactivate</button>`;
            let suspensionNote = '';
            if (isSuspended) {
                const untilText = driver.suspendedUntilRaw ? `Until ${ParaFirestore.formatDateTime(driver.suspendedUntilRaw)}` : 'Indefinitely';
                const reasonText = driver.suspensionReason ? ` — ${driver.suspensionReason}` : '';
                suspensionNote = `<div class="detail-sub" style="margin-top:4px;">${escapeHtml(untilText + reasonText)}</div>`;
            }
            return `<tr>
                <td><div class="detail-main">${escapeHtml(driver.name)}</div><div class="detail-sub">Member since ${escapeHtml(driver.memberSince)}</div></td>
                <td><div class="detail-main">${escapeHtml(driver.vehicle || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(driver.plate || '—')}</div></td>
                <td style="white-space:nowrap;"><div class="rating-stars">${escapeHtml(getDriverPerformanceStars(ratingValue))} <span>${escapeHtml(driver.rating === '—' ? '—' : Number(driver.rating).toFixed(1))}</span></div><div class="detail-sub">${escapeHtml(Number(driver.totalRides || 0))} completed ${Number(driver.totalRides || 0) === 1 ? 'ride' : 'rides'} · ${escapeHtml(driver.acceptanceRate || '—')} acceptance</div></td>
                <td>${renderBadge(isSuspended ? 'suspended' : 'active')}${suspensionNote}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex; gap:6px; flex-wrap:nowrap;">
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="edit-driver" data-id="${escapeHtml(driver.id)}">Edit</button>
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="history-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">History</button>
                        ${actionBtn}
                    </div>
                </td>
            </tr>`;
        }).join('');

        bindRowActions(tbody, {
            'edit-driver': (ds) => window.openDriverEditModal(ds.id),
            'history-driver': (ds) => window.openDriverHistoryModal(ds.id, ds.name),
            'reactivate-driver': (ds) => window.reactivateDriver(ds.id, ds.name),
            'ban-driver': (ds) => window.confirmDriverBan(ds.id, ds.name)
        });
    }

    window.setDriverManagementStatus = function(statusKey) {
        window.driverMgmtStatusFilter = (statusKey || 'all').toLowerCase();
        const btn = document.getElementById('driverMgmtStatusBtn');
        if (btn) btn.querySelector('.filter-val').textContent = statusKey.charAt(0).toUpperCase() + statusKey.slice(1);
        if (typeof renderDriverManagementTable === 'function') renderDriverManagementTable(window.driverManagementDrivers || []);
    };

    window.setDriverManagementSort = function(sortKey) {
        // map labels
        const mapKey = {
            'Rating (High)': 'rating-desc',
            'Rating (Low)': 'rating-asc',
            'Rides (High)': 'rides-desc',
            'Rides (Low)': 'rides-asc'
        }[sortKey] || 'rating-desc';
        window.driverMgmtSortMode = mapKey;
        const btn = document.getElementById('driverMgmtSortBtn');
        if (btn) btn.querySelector('.filter-val').textContent = sortKey;
        if (typeof renderDriverManagementTable === 'function') renderDriverManagementTable(window.driverManagementDrivers || []);
    };

    window.setPassengerManagementStatus = function(statusKey) {
        window.passengerMgmtStatusFilter = (statusKey || 'all').toLowerCase();
        const btn = document.getElementById('passengerMgmtStatusBtn');
        if (btn) btn.querySelector('.filter-val').textContent = statusKey;
        if (window.allPassengers) {
            let filtered = window.allPassengers;
            if (window.passengerMgmtStatusFilter !== 'all') {
                filtered = window.allPassengers.filter((p) => p.status.toLowerCase() === window.passengerMgmtStatusFilter);
            }
            renderPassengerTable(filtered);
        }
    };

    // Passenger docs don't carry totalRides/cancelledRides (confirmed against
    // the live schema — nothing writes those fields yet), so compute them
    // live from the bookings already loaded for the rest of the dashboard
    // instead of showing a permanent 0. This is a stopgap: the real fix is a
    // backend Cloud Function maintaining these counters the way driver stats
    // already are, so this can be removed once that exists.
    function computePassengerRideStats(passengerId) {
        const bookings = window.allBookings || window.dashboardBookings || [];
        let completed = 0;
        let cancelled = 0;
        bookings.forEach((booking) => {
            if (booking.passengerId !== passengerId) return;
            const status = ParaFirestore.normalizeStatus(booking.status);
            if (status === 'completed') completed += 1;
            else if (status === 'cancelled' || status === 'canceled') cancelled += 1;
        });
        // Total Rides = every booking attempt (completed + cancelled), so Cancel
        // Rate is a real, comparable 0-100% figure — not cancellations-per-
        // completed-ride, which isn't bounded and isn't what "cancel rate" means.
        const totalRides = completed + cancelled;
        const cancelRate = totalRides > 0 ? ((cancelled / totalRides) * 100).toFixed(1) + '%' : '0.0%';
        return { totalRides, cancelled, cancelRate };
    }

    function renderPassengerTable(passengers) {
        const tbody = document.querySelector('#view-passenger-management .data-table tbody');
        if (!tbody) return;

        if (!passengers.length) {
            tbody.innerHTML = emptyRow(7, 'No passengers found in Firestore.');
            return;
        }

        tbody.innerHTML = passengers.map((passengerRecord) => {
            const rideStats = computePassengerRideStats(passengerRecord.id);
            const passenger = { ...passengerRecord, ...rideStats };
            const isSuspended = passenger.status === 'suspended';
            const isFlagged = passenger.status === 'flagged';
            const cancelStyle = parseFloat(passenger.cancelRate) >= 10
                ? 'color:#EE5D50; font-weight:600;'
                : parseFloat(passenger.cancelRate) >= 5
                    ? 'color:#FF9E2A; font-weight:600;'
                    : 'color:#05CD99; font-weight:600;';
            const actionBtn = isSuspended
                ? `<button class="action-btn" style="background:#05CD99;" data-action="reactivate-passenger" data-id="${escapeHtml(passenger.id)}" data-name="${escapeHtml(passenger.name)}">Reactivate</button>`
                : `<button class="action-btn" style="background:#EE5D50;" data-action="ban-passenger" data-id="${escapeHtml(passenger.id)}" data-name="${escapeHtml(passenger.name)}">Deactivate</button>`;
            const statusKey = isFlagged ? 'flagged' : (isSuspended ? 'suspended' : 'active');
            let suspensionNote = '';
            if (isSuspended) {
                const untilText = passenger.suspendedUntilRaw ? `Until ${ParaFirestore.formatDateTime(passenger.suspendedUntilRaw)}` : 'Indefinitely';
                const reasonText = passenger.suspensionReason ? ` — ${passenger.suspensionReason}` : '';
                suspensionNote = `<div class="detail-sub" style="margin-top:4px;">${escapeHtml(untilText + reasonText)}</div>`;
            }

            return `<tr>
                <td><div class="detail-main">${escapeHtml(passenger.name)}</div><div class="detail-sub">Member since ${escapeHtml(passenger.memberSince)}</div></td>
                <td><div class="detail-main">${escapeHtml(passenger.phone)}</div><div class="detail-sub">${escapeHtml(passenger.email)}</div></td>
                <td>${escapeHtml(passenger.totalRides)}</td>
                <td>${escapeHtml(passenger.cancelled)}</td>
                <td style="${cancelStyle}">${escapeHtml(passenger.cancelRate)}</td>
                <td>${renderBadge(statusKey)}${suspensionNote}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex; gap:6px; flex-wrap:nowrap;">
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="edit-passenger" data-id="${escapeHtml(passenger.id)}">Edit</button>
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="history-passenger" data-id="${escapeHtml(passenger.id)}" data-name="${escapeHtml(passenger.name)}">History</button>
                        ${actionBtn}
                    </div>
                </td>
            </tr>`;
        }).join('');

        bindRowActions(tbody, {
            'edit-passenger': (ds) => window.openPassengerEditModal(ds.id),
            'history-passenger': (ds) => window.openPassengerHistoryModal(ds.id, ds.name),
            'reactivate-passenger': (ds) => window.reactivatePassenger(ds.id, ds.name),
            'ban-passenger': (ds) => window.confirmPassengerBan(ds.id, ds.name)
        });
    }

    const BOOKINGS_PAGE_SIZE = 25;
    let bookingTablePage = 1;

    window.selectBookingStatus = function(statusKey) {
        const normalizedKey = (statusKey || 'All').toLowerCase();
        window.bookingStatusFilter = normalizedKey === 'all' ? 'all' : normalizedKey;

        const btn = document.getElementById('statusFilterBtn');
        if (btn) {
            const filterText = btn.querySelector('.filter-val');
            if (filterText) filterText.textContent = statusKey || 'All';
        }

        const dropdown = document.getElementById('statusDropdown');
        if (dropdown) dropdown.classList.remove('show');

        bookingTablePage = 1;
        if (window.allBookings) {
            renderBookingTable(window.allBookings);
        }
    };

    window.changeBookingPage = function(delta) {
        bookingTablePage += delta;
        renderBookingTable(window.allBookings || []);
    };

    function fareColor(status) {
        const colors = {
            completed: '#05CD99',
            cancelled: '#EE5D50',
            declined: '#EE5D50',
            pending: '#FF9E2A',
            processing: '#FF9E2A',
            ongoing: '#F2C94C'
        };
        return colors[status] || 'var(--text-main)';
    }

    function renderBookingTable(bookings) {
        const tbody = document.querySelector('#view-bookings .data-table tbody');
        if (!tbody) return;

        window.allBookings = Array.isArray(bookings) ? bookings : [];
        let list = [...window.allBookings];

        const selectedStatus = (window.bookingStatusFilter || 'all').toLowerCase();
        if (selectedStatus !== 'all') {
            list = list.filter((booking) => ParaFirestore.normalizeStatus(booking.status) === selectedStatus);
        }

        const datePicker = document.getElementById('bookingDatePicker');
        if (datePicker && datePicker.value) {
            list = list.filter((booking) => {
                if (!booking.createdAtRaw || Number.isNaN(new Date(booking.createdAtRaw).getTime())) return false;
                const bookingDate = new Date(booking.createdAtRaw);
                bookingDate.setHours(0, 0, 0, 0);
                const selectedDate = new Date(datePicker.value + 'T00:00:00');
                selectedDate.setHours(0, 0, 0, 0);
                return bookingDate.getTime() === selectedDate.getTime();
            });
        }

        const paginationEl = document.getElementById('bookingPagination');

        if (!list.length) {
            tbody.innerHTML = emptyRow(8, 'No bookings found in Firestore.');
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        // Render only one page of rows at a time — the underlying dataset (used by
        // the charts, reports and exports) still holds everything, this just caps
        // how many rows get dumped into the DOM at once.
        const totalPages = Math.max(1, Math.ceil(list.length / BOOKINGS_PAGE_SIZE));
        bookingTablePage = Math.min(Math.max(1, bookingTablePage), totalPages);
        const pageStart = (bookingTablePage - 1) * BOOKINGS_PAGE_SIZE;
        const pageItems = list.slice(pageStart, pageStart + BOOKINGS_PAGE_SIZE);

        tbody.innerHTML = pageItems.map((booking) => `
            <tr>
                <td><div class="book-id">${escapeHtml(booking.ref)}</div><div class="book-time">${escapeHtml(booking.relativeTime)}</div></td>
                <td>${renderBadge(booking.status)}</td>
                <td style="font-size:13px;">${escapeHtml(booking.dateLabel)}</td>
                <td><div class="detail-main">${escapeHtml(booking.driverName || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(booking.plate)}</div></td>
                <td>${escapeHtml(booking.passengerName || '—')}</td>
                <td style="max-width:190px; font-size:13px; line-height:1.4;">${escapeHtml(booking.pickupLocation)}</td>
                <td style="max-width:190px; font-size:13px; line-height:1.4;">${escapeHtml(booking.dropoffLocation)}</td>
                <td style="color:${fareColor(booking.status)}; font-weight:600;">&#8369;${escapeHtml(Number(booking.totalFare || 0).toFixed(2))}</td>
            </tr>
        `).join('');

        if (paginationEl) {
            const rangeStart = pageStart + 1;
            const rangeEnd = Math.min(list.length, pageStart + BOOKINGS_PAGE_SIZE);
            paginationEl.innerHTML = `
                <span>Showing ${rangeStart}–${rangeEnd} of ${list.length}</span>
                <div style="display:flex; gap:8px;">
                    <button class="action-btn" ${bookingTablePage <= 1 ? 'disabled' : ''} onclick="changeBookingPage(-1)">Prev</button>
                    <span style="padding:6px 4px;">Page ${bookingTablePage} of ${totalPages}</span>
                    <button class="action-btn" ${bookingTablePage >= totalPages ? 'disabled' : ''} onclick="changeBookingPage(1)">Next</button>
                </div>
            `;
        }
    }

    const bookingDatePicker = document.getElementById('bookingDatePicker');
    if (bookingDatePicker) {
        bookingDatePicker.addEventListener('change', () => {
            bookingTablePage = 1;
            if (window.allBookings) {
                renderBookingTable(window.allBookings);
            }
        });
    }

    window.renderRecentActivity = function(bookings) {
        const tbody = document.getElementById('recentActivityBody');
        if (!tbody) return;

        const recentBookings = (bookings || [])
            .slice(0, 3)
            .map((booking) => ({
                bookingId: booking.ref,
                subtitle: booking.rideType || 'Tricycle Ride',
                status: booking.status,
                passenger: booking.passengerName || 'Unknown passenger',
                driver: booking.driverName || 'Unknown driver',
                relativeTime: booking.relativeTime || booking.dateLabel || '—'
            }));

        if (!recentBookings.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:20px;">No recent activity available.</td></tr>';
            return;
        }

        tbody.innerHTML = recentBookings.map((activity) => `
            <tr>
                <td><div class="book-id">${escapeHtml(activity.bookingId)}</div><div class="book-time">${escapeHtml(activity.subtitle)}</div></td>
                <td>${renderBadge(activity.status)}</td>
                <td><div class="detail-main">${escapeHtml(activity.passenger)}</div><div class="detail-sub">Driver: ${escapeHtml(activity.driver)}</div></td>
                <td style="color:var(--text-muted); font-size:13px;">${escapeHtml(activity.relativeTime)}</td>
            </tr>
        `).join('');
    };

    window.complaintMgmtStatusFilter = 'all';
    let allComplaints = [];

    // Complaint docs only store passengerId/driverId, not name strings (see
    // mapComplaintDoc) — resolve display names against whichever of the
    // driver/passenger lists are currently loaded. Safe to call before
    // either list has loaded; falls back to the '—' placeholder.
    function resolveComplaintNames(complaint) {
        if (!complaint) return complaint;
        const passenger = (window.allPassengers || []).find((p) => p.id === complaint.passengerId);
        // window.driverManagementDrivers is approved-only (Driver Management's
        // own list) — a driver named in a complaint might still be pending/
        // rejected, so fall back to window.allDriversForLookup (every driver,
        // any verification status) before giving up.
        const driver = (window.driverManagementDrivers || []).find((d) => d.id === complaint.driverId)
            || (window.allDriversForLookup || []).find((d) => d.id === complaint.driverId);
        return {
            ...complaint,
            reporter: (passenger && passenger.name) || complaint.reporter || '—',
            reported: (driver && driver.name) || complaint.reported || '—'
        };
    }

    function getComplaintsForFilter(filterKey) {
        const key = (filterKey || 'all').toLowerCase();
        if (key === 'under review') return allComplaints.filter((c) => ['pending', 'reviewing'].includes(c.status));
        if (key === 'resolved') return allComplaints.filter((c) => c.status === 'resolved');
        if (key === 'rejected') return allComplaints.filter((c) => c.status === 'rejected');
        return allComplaints;
    }

    // Driver/passenger lists can finish loading after complaints do (separate
    // listeners, no guaranteed order) — re-resolve names and re-render
    // whenever either list changes, not just when complaints change.
    function refreshComplaintDisplay() {
        if (!allComplaints.length) return;
        allComplaints = allComplaints.map(resolveComplaintNames);
        renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));
    }

    function updateComplaintStats() {
        if (!allComplaints.length) {
            document.getElementById('complaints-under-review').textContent = '0';
            document.getElementById('complaints-resolved').textContent = '0';
            document.getElementById('complaints-total-month').textContent = '0';
            return;
        }

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const underReview = allComplaints.filter((c) => ['pending', 'reviewing'].includes(c.status)).length;
        const resolved = allComplaints.filter((c) => c.status === 'resolved').length;
        const thisMonth = allComplaints.filter((c) => {
            const createdAt = c.createdAtRaw || c.createdAt || new Date(c.createdAt);
            if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return false;
            return createdAt >= monthStart;
        }).length;

        document.getElementById('complaints-under-review').textContent = underReview;
        document.getElementById('complaints-resolved').textContent = resolved;
        document.getElementById('complaints-total-month').textContent = thisMonth;
    }

    window.setComplaintFilter = function(statusKey) {
        const normalizedKey = (statusKey || 'all').toLowerCase();
        window.complaintMgmtStatusFilter = normalizedKey;
        const btn = document.getElementById('complaintStatusBtn');
        if (btn) btn.querySelector('.filter-val').textContent = statusKey;
        
        if (allComplaints) {
            renderComplaintTable(getComplaintsForFilter(normalizedKey));
        }

        const dropdown = document.getElementById('complaintStatusDropdown');
        if (dropdown) dropdown.classList.remove('show');
    };

    function renderComplaintTable(complaints) {
        const tbody = document.querySelector('#view-complaints .data-table tbody');
        if (!tbody) return;

        const sortedComplaints = [...(complaints || [])].sort((a, b) => {
            const timeA = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : (a.createdAt instanceof Date ? a.createdAt.getTime() : 0);
            const timeB = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : (b.createdAt instanceof Date ? b.createdAt.getTime() : 0);
            return timeB - timeA;
        });

        if (!sortedComplaints.length) {
            tbody.innerHTML = emptyRow(5, 'No complaints found in Firestore.');
            return;
        }

        tbody.innerHTML = sortedComplaints.map((complaint) => `
            <tr>
                <td><div class="book-id">${escapeHtml(complaint.ref)}</div><div class="book-time">Reporter: ${escapeHtml(complaint.reporter)}</div></td>
                <td><div class="detail-main">${escapeHtml(complaint.reported)}</div><div class="detail-sub">Trip: ${escapeHtml(complaint.tripRef)}</div></td>
                <td><div class="detail-main">${escapeHtml(complaint.issue)}</div><div class="detail-sub">${escapeHtml(complaint.description)}</div></td>
                <td>${renderBadge(complaint.status)}</td>
                <td><button class="action-btn" data-action="view-complaint" data-id="${escapeHtml(complaint.id)}">View Case</button></td>
            </tr>
        `).join('');

        bindRowActions(tbody, {
            'view-complaint': (ds) => window.openComplaintModal(ds.id)
        });
    }

    async function loadDashboardStats() {
        try {
            const counts = await ParaFirestore.getDashboardCounts();
            window.dashboardCounts = counts;

            const cards = document.querySelectorAll('#view-dashboard .stat-card h2');
            if (cards[2]) cards[2].textContent = counts.activeDrivers.toLocaleString();
            if (cards[3]) cards[3].textContent = counts.activePassengers.toLocaleString();

            const driverBadge = document.querySelector('[data-view="driver-verification"] .nav-badge');
            const complaintBadge = document.querySelector('[data-view="complaints"] .nav-badge');
            if (driverBadge) {
                driverBadge.textContent = counts.pendingDrivers || '';
                driverBadge.classList.toggle('hidden', !counts.pendingDrivers);
            }
            if (complaintBadge) {
                complaintBadge.textContent = counts.openComplaints || '';
                complaintBadge.classList.toggle('hidden', !counts.openComplaints);
            }

            if (typeof window.updateDashboardDateCards === 'function') {
                window.updateDashboardDateCards(window.currentDashboardDateFilter || 'Today');
            }
        } catch (error) {
            console.error('Failed to load dashboard stats:', error);
        }
    }

    function renderTodaPresidentAccounts(accounts) {
        const tbody = document.getElementById('todaPresidentAccountsBody');
        if (!tbody) return;
        if (!accounts.length) {
            tbody.innerHTML = emptyRow(7, 'No TODA President accounts created yet.');
            return;
        }
        tbody.innerHTML = accounts.map((account) => `
            <tr>
                <td><div class="detail-main">${escapeHtml(account.fullName || account.name || '—')}</div><div class="detail-sub">${escapeHtml(account.todaName || '—')}</div></td>
                <td>${escapeHtml(account.barangay || '—')}</td>
                <td>${escapeHtml(account.email || '—')}</td>
                <td>${escapeHtml(account.phone || '—')}</td>
                <td>${renderBadge(account.status || 'active')}</td>
                <td>${escapeHtml(ParaFirestore.formatDateTime(account.createdAt))}</td>
                <td>
                    <button class="action-btn" data-action="edit-toda-president" data-id="${escapeHtml(account.id)}">Edit</button>
                    <button class="action-btn" style="background:${account.status === 'disabled' ? '#05CD99' : '#EE5D50'}; margin-left:6px;" data-action="toggle-toda-president" data-id="${escapeHtml(account.id)}" data-name="${escapeHtml(account.fullName || account.name || 'this account')}" data-next-status="${account.status === 'disabled' ? 'active' : 'disabled'}">${account.status === 'disabled' ? 'Reactivate' : 'Disable'}</button>
                </td>
            </tr>
        `).join('');

        bindRowActions(tbody, {
            'edit-toda-president': (ds) => window.openTodaPresidentEditModal(ds.id),
            'toggle-toda-president': (ds) => window.toggleTodaPresidentStatus(ds.id, ds.name, ds.nextStatus)
        });
    }

    window.openTodaPresidentAccountModal = function() {
        window.editingTodaPresidentId = null;
        window.editingTodaPresidentStatus = 'active';
        ['name', 'toda-name', 'barangay', 'email', 'phone', 'password'].forEach((field) => {
            const input = document.getElementById(`toda-president-${field}`);
            if (input) input.value = '';
        });
        const passwordInput = document.getElementById('toda-president-password');
        const toggleButton = document.getElementById('toggleTodaPresidentPassword');
        if (passwordInput) passwordInput.type = 'password';
        if (toggleButton) toggleButton.textContent = 'Show';
        document.getElementById('todaPresidentAccountModalTitle').textContent = 'Create TODA President Account';
        document.getElementById('createTodaPresidentBtn').textContent = 'Create Account';
        document.getElementById('todaPresidentPasswordGroup').style.display = '';
        document.getElementById('todaPresidentPasswordHelp').style.display = '';
        document.getElementById('toda-president-email').readOnly = false;
        document.getElementById('todaPresidentAccountModal').classList.add('active');
    };

    window.openTodaPresidentEditModal = async function(accountId) {
        const account = (window.todaPresidentAccounts || []).find((item) => item.id === accountId);
        if (!account) return;
        window.editingTodaPresidentId = accountId;
        window.editingTodaPresidentStatus = account.status || 'active';
        document.getElementById('toda-president-name').value = account.fullName || account.name || '';
        document.getElementById('toda-president-toda-name').value = account.todaName || '';
        document.getElementById('toda-president-barangay').value = account.barangay || '';
        document.getElementById('toda-president-email').value = account.email || '';
        document.getElementById('toda-president-phone').value = account.phone || '';
        document.getElementById('toda-president-email').readOnly = true;
        document.getElementById('todaPresidentAccountModalTitle').textContent = 'Edit TODA President Account';
        document.getElementById('createTodaPresidentBtn').textContent = 'Save Changes';
        document.getElementById('todaPresidentPasswordGroup').style.display = 'none';
        document.getElementById('todaPresidentPasswordHelp').style.display = 'none';
        document.getElementById('todaPresidentAccountModal').classList.add('active');
    };

    window.toggleTodaPresidentStatus = function(accountId, name, status) {
        const action = status === 'disabled' ? 'disable' : 'reactivate';
        showConfirmModal(
            `${action.charAt(0).toUpperCase() + action.slice(1)} ${name}?`,
            status === 'disabled' ? 'This account will no longer be able to sign in through the mobile app.' : 'This account will be able to sign in through the mobile app again.',
            action.charAt(0).toUpperCase() + action.slice(1),
            status === 'disabled' ? '#EE5D50' : '#05CD99',
            async () => {
                try {
                    await ParaFirestore.updateTodaPresidentStatus(accountId, status);
                    window.showToast(`Account ${status === 'disabled' ? 'disabled' : 'reactivated'}.`, status === 'disabled' ? 'error' : 'success');
                    loadTodaPresidentAccounts();
                } catch (error) {
                    console.error('Failed to update TODA President status:', error);
                    window.showToast('Failed to update account status.', 'error');
                }
            }
        );
    };

    window.toggleTodaPresidentPasswordVisibility = function() {
        const input = document.getElementById('toda-president-password');
        const button = document.getElementById('toggleTodaPresidentPassword');
        if (!input || !button) return;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        button.textContent = isHidden ? 'Hide' : 'Show';
    };

    window.createTodaPresidentAccount = async function() {
        const values = {
            name: document.getElementById('toda-president-name').value.trim(),
            todaName: document.getElementById('toda-president-toda-name').value.trim(),
            barangay: document.getElementById('toda-president-barangay').value.trim(),
            email: document.getElementById('toda-president-email').value.trim(),
            phone: document.getElementById('toda-president-phone').value.trim(),
            password: document.getElementById('toda-president-password').value
        };
        if (!values.name || !values.todaName || !values.barangay || !values.email || !values.phone || (!window.editingTodaPresidentId && values.password.length < 6)) {
            window.showToast('Complete all fields. Password must be at least 6 characters.', 'warning');
            return;
        }
        const button = document.getElementById('createTodaPresidentBtn');
        try {
            button.disabled = true;
            let createResult = null;
            if (window.editingTodaPresidentId) {
                await ParaFirestore.updateTodaPresidentAccount(window.editingTodaPresidentId, { ...values, status: window.editingTodaPresidentStatus });
            } else {
                createResult = await ParaFirestore.createTodaPresidentAccount(values);
            }
            closeModal('todaPresidentAccountModal');
            if (window.editingTodaPresidentId) {
                window.showToast('TODA President account updated.', 'success');
            } else if (createResult && createResult.emailVerificationSent) {
                window.showToast('Account created — a verification email was sent.', 'success');
            } else {
                window.showToast('Account created, but the verification email could not be sent. Have them check their spelling or request a new one.', 'warning');
            }
            window.editingTodaPresidentId = null;
            window.editingTodaPresidentStatus = 'active';
            loadTodaPresidentAccounts();
        } catch (error) {
            console.error('Failed to create TODA President account:', error);
            window.showToast(error.code === 'auth/email-already-in-use' ? 'That email is already in use.' : 'Failed to create account.', 'error');
        } finally {
            button.disabled = false;
        }
    };

    async function loadTodaPresidentAccounts() {
        try {
            window.todaPresidentAccounts = await ParaFirestore.fetchTodaPresidentAccounts();
            renderTodaPresidentAccounts(window.todaPresidentAccounts);
        } catch (error) {
            console.error('Failed to load TODA President accounts:', error);
            renderTodaPresidentAccounts([]);
        }
    }

    async function loadFareSettings() {
        try {
            const fare = await ParaFirestore.getFareSettings();
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.value = value;
            };
            setValue('fare-base', fare.baseFare);
            setValue('fare-perkm', fare.perKmRate);
            setValue('fare-min', fare.minimumFare);
            setValue('fare-svc', fare.serviceFeePercent);
            const lastUpdatedEl = document.getElementById('fareLastUpdated');
            if (lastUpdatedEl) {
                lastUpdatedEl.textContent = fare.updatedAtRaw
                    ? `Last updated ${ParaFirestore.formatDateTime(fare.updatedAtRaw)}`
                    : 'No changes recorded yet.';
            }
            if (typeof updateFarePreview === 'function') updateFarePreview();
        } catch (error) {
            console.error('Failed to load fare settings:', error);
        }
    }

    window.openVerificationModal = async function(driverId) {
        try {
            const mapped = await ParaFirestore.getDriverById(driverId);
            if (!mapped) {
                window.showToast('Driver record not found.', 'error');
                return;
            }

            currentVerificationDriverId = driverId;
            window.currentVerificationDriverId = driverId;
            document.getElementById('v-name').textContent = mapped.name;
            document.getElementById('v-lic').textContent = mapped.license;
            document.getElementById('v-model').textContent = mapped.vehicle;
            document.getElementById('v-plate').textContent = mapped.plate;

            // Presentation fallback: if a driver record has no uploaded document URL,
            // show a local sample photo instead of the empty state. Real uploaded
            // documents (when present) still take priority.
            setDocImage('v-license-front-link', 'v-license-front-img', mapped.documents.licenseFront || 'license-front.png', 'v-license-front-empty');
            setDocImage('v-license-back-link', 'v-license-back-img', mapped.documents.licenseBack || 'license-back.jpg', 'v-license-back-empty');
            setDocImage('v-vehicle-photo-link', 'v-vehicle-photo-img', mapped.documents.vehiclePhoto || 'vehicle-photo.png', 'v-vehicle-photo-empty');
            setDocImage('v-franchise-link', 'v-franchise-img', mapped.documents.franchisePermit || 'franchise-permit.png', 'v-franchise-empty');

            // "View Details" (Approved/Rejected tabs) is read-only — only a pending
            // application should expose Approve/Reject/Request Info, so browsing an
            // already-decided driver can't accidentally flip their status.
            const isPending = currentVerificationFilter === 'pending';
            ['verifyRejectBtn', 'verifyRequestInfoBtn', 'verifyApproveBtn'].forEach((id) => {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = isPending ? '' : 'none';
            });

            const driverBadge = document.querySelector('[data-view="driver-verification"] .nav-badge');
            if (driverBadge) {
                driverBadge.textContent = '';
                driverBadge.classList.add('hidden');
            }

            document.getElementById('verificationModal').classList.add('active');
        } catch (error) {
            window.showToast('Could not load driver details.', 'error');
            console.error(error);
        }
    };

    let allDrivers = [];

    function timeValue(date) {
        return date && date.getTime ? date.getTime() : 0;
    }

    function applyVerificationFilter() {
        const filtered = allDrivers.filter((d) => d.verificationStatus === currentVerificationFilter);

        if (currentVerificationFilter === 'pending') {
            // Oldest application first — a FIFO queue so nobody waits indefinitely
            // while newer applications get reviewed ahead of them.
            filtered.sort((a, b) => timeValue(a.submittedAtRaw) - timeValue(b.submittedAtRaw));
        } else {
            // Approved/Rejected are a decision log — most recently decided first.
            filtered.sort((a, b) => {
                const bTime = timeValue(b.verifiedAtRaw) || timeValue(b.submittedAtRaw);
                const aTime = timeValue(a.verifiedAtRaw) || timeValue(a.submittedAtRaw);
                return bTime - aTime;
            });
        }

        renderVerificationTable(filtered);
    }

    ParaFirestore.listenDrivers(null, (drivers) => {
        allDrivers = drivers;
        applyVerificationFilter();
    });

    window.selectVerificationStatus = function(statusStr) {
        const textSpan = document.getElementById('driverVerificationStatusText');
        const dropdown = document.getElementById('driverVerificationStatusDropdown');
        if (textSpan) textSpan.textContent = statusStr;
        if (dropdown) dropdown.classList.remove('show');
        currentVerificationFilter = statusStr.toLowerCase();
        applyVerificationFilter();
    };

    window.approveDriver = function() {
        if (!currentVerificationDriverId) return;
        const name = document.getElementById('v-name')?.textContent || 'this driver';
        showConfirmModal(
            `Approve ${name}?`,
            'This driver will be verified and able to accept rides.',
            'Approve',
            '#05CD99',
            async () => {
                try {
                    await ParaFirestore.updateDriverVerification(currentVerificationDriverId, 'approved');
                    ParaFirestore.logDriverAction(currentVerificationDriverId, name, 'Approval', '').catch((error) => console.error('Failed to log driver action:', error));
                    closeModal('verificationModal');
                    window.showToast('Driver approved successfully.', 'success');
                } catch (error) {
                    window.showToast('Failed to approve driver.', 'error');
                    console.error(error);
                }
            }
        );
    };

    window.rejectDriver = function() {
        if (!currentVerificationDriverId) return;
        const name = document.getElementById('v-name')?.textContent || 'this driver';
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">This driver's application will be marked as rejected.</div>
            <div style="text-align:left;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Reason (shown in the driver's record)</label>
                <textarea id="driverRejectReason" class="form-input" rows="3" style="width:100%; resize:vertical;" placeholder="e.g. Blurred license photo, expired documents…"></textarea>
            </div>
        `;
        showConfirmModal(
            `Reject ${name}?`,
            "This driver's application will be marked as rejected.",
            'Reject',
            '#EE5D50',
            async () => {
                try {
                    const reasonInput = document.getElementById('driverRejectReason');
                    const reason = reasonInput ? reasonInput.value.trim() : '';
                    await ParaFirestore.updateDriverVerification(currentVerificationDriverId, 'rejected');
                    ParaFirestore.logDriverAction(currentVerificationDriverId, name, 'Rejection', reason).catch((error) => console.error('Failed to log driver action:', error));
                    closeModal('verificationModal');
                    window.showToast('Driver application rejected.', 'error');
                } catch (error) {
                    window.showToast('Failed to reject driver.', 'error');
                    console.error(error);
                }
            },
            customBodyHtml
        );
    };

    // Shared by driver and passenger "History" buttons — same driver_actions-style
    // shape, just a different collection/id field behind fetchActions.
    async function openActionHistoryModal(name, fetchActions, noneLabel) {
        const titleEl = document.getElementById('driverHistoryTitle');
        const listEl = document.getElementById('driverHistoryList');
        if (titleEl) titleEl.textContent = `${name || 'Record'} — History`;
        if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Loading…</div>';
        document.getElementById('driverHistoryModal').classList.add('active');

        try {
            const actions = await fetchActions();
            if (!listEl) return;
            if (!actions.length) {
                listEl.innerHTML = `<div style="color:var(--text-muted); font-size:13px;">${escapeHtml(noneLabel)}</div>`;
                return;
            }
            const typeColor = { Suspension: '#EE5D50', Rejection: '#EE5D50', Reactivation: '#05CD99', Approval: '#05CD99', Warning: '#FF9E2A' };
            listEl.innerHTML = actions.map((action) => {
                const color = typeColor[action.actionType] || 'var(--text-main)';
                const when = action.issuedAt ? new Date(Number(action.issuedAt)).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
                return `
                    <div style="border:1px solid var(--border-color); border-radius:10px; padding:12px 14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <strong style="color:${color}; font-size:13px;">${escapeHtml(action.actionType || 'Action')}</strong>
                            <span style="font-size:12px; color:var(--text-muted);">${escapeHtml(when)}</span>
                        </div>
                        ${action.reason ? `<div style="font-size:13px; color:var(--text-main);">${escapeHtml(action.reason)}</div>` : ''}
                    </div>
                `;
            }).join('');
        } catch (error) {
            console.error('Failed to load history:', error);
            if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Could not load history.</div>';
        }
    }

    window.openDriverHistoryModal = function(driverId, name) {
        openActionHistoryModal(name, () => ParaFirestore.fetchDriverActions(driverId), 'No actions recorded for this driver yet.');
    };

    window.openPassengerHistoryModal = function(passengerId, name) {
        openActionHistoryModal(name, () => ParaFirestore.fetchPassengerActions(passengerId), 'No actions recorded for this passenger yet.');
    };

    window.openDriverEditModal = async function(driverId) {
        try {
            const driver = await ParaFirestore.getDriverById(driverId);
            if (!driver) return;
            currentEditDriverId = driverId;
            document.getElementById('d-edit-name').value = driver.name;
            document.getElementById('d-edit-vehicle').value = driver.vehicle;
            document.getElementById('d-edit-plate').value = driver.plate;
            document.getElementById('driverEditModal').classList.add('active');
        } catch (error) {
            window.showToast('Could not load driver for editing.', 'error');
        }
    };

    window.saveDriverEdit = async function() {
        if (!currentEditDriverId) return;
        try {
            await ParaFirestore.updateDriver(currentEditDriverId, {
                name: document.getElementById('d-edit-name').value.trim(),
                vehicle: document.getElementById('d-edit-vehicle').value.trim(),
                plate: document.getElementById('d-edit-plate').value.trim()
            });
            closeModal('driverEditModal');
            window.showToast('Driver details updated.', 'success');
        } catch (error) {
            window.showToast('Failed to update driver.', 'error');
        }
    };

    window.confirmDriverBan = function(driverId, name) {
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">This driver will be suspended and cannot accept rides until reactivated.</div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Deactivate for</label>
                <select id="driverSuspendDays" class="form-input" style="width:100%; min-height:42px; padding:10px 12px; border:1px solid var(--border-color); border-radius:10px; background:#fff;">
                    <option value="1">1 day</option>
                    <option value="3" selected>3 days</option>
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="permanent">Indefinitely (until manually reactivated)</option>
                </select>
            </div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Reason (shown in the driver's record)</label>
                <textarea id="driverSuspendReason" class="form-input" rows="3" style="width:100%; resize:vertical;" placeholder="e.g. Passenger safety complaint, expired documents…"></textarea>
            </div>
        `;

        showConfirmModal(
            `Deactivate ${name}?`,
            'This driver will be suspended and cannot accept rides until reactivated.',
            'Deactivate',
            '#EE5D50',
            async () => {
                try {
                    const daysSelect = document.getElementById('driverSuspendDays');
                    const reasonInput = document.getElementById('driverSuspendReason');
                    const daysValue = daysSelect?.value || '3';
                    const reason = reasonInput ? reasonInput.value.trim() : '';
                    await ParaFirestore.updateDriverAccountStatus(driverId, 'suspended', daysValue, reason);
                    ParaFirestore.logDriverAction(driverId, name, 'Suspension', reason).catch((error) => console.error('Failed to log driver action:', error));
                    const durationLabel = daysValue === 'permanent' ? 'indefinitely' : `for ${daysValue} day${daysValue === '1' ? '' : 's'}`;
                    window.showToast(`${name} has been deactivated ${durationLabel}.`, 'error');
                } catch (error) {
                    window.showToast('Failed to deactivate driver.', 'error');
                }
            },
            customBodyHtml
        );
    };

    window.reactivateDriver = async function(driverId, name) {
        try {
            await ParaFirestore.updateDriverAccountStatus(driverId, 'active');
            ParaFirestore.logDriverAction(driverId, name, 'Reactivation', '').catch((error) => console.error('Failed to log driver action:', error));
            window.showToast(`${name} reactivated.`, 'success');
        } catch (error) {
            window.showToast('Failed to reactivate driver.', 'error');
        }
    };

    window.confirmPassengerBan = function(userId, name) {
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">This passenger will be suspended and cannot book rides.</div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Deactivate for</label>
                <select id="passengerSuspendDays" class="form-input" style="width:100%; min-height:42px; padding:10px 12px; border:1px solid var(--border-color); border-radius:10px; background:#fff;">
                    <option value="1">1 day</option>
                    <option value="3" selected>3 days</option>
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="permanent">Indefinitely (until manually reactivated)</option>
                </select>
            </div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Reason (shown in the passenger's record)</label>
                <textarea id="passengerSuspendReason" class="form-input" rows="3" style="width:100%; resize:vertical;" placeholder="e.g. Repeated no-shows, abusive behavior…"></textarea>
            </div>
        `;

        showConfirmModal(
            `Deactivate ${name}?`,
            'This passenger will be suspended and cannot book rides.',
            'Deactivate',
            '#EE5D50',
            async () => {
                try {
                    const daysSelect = document.getElementById('passengerSuspendDays');
                    const reasonInput = document.getElementById('passengerSuspendReason');
                    const daysValue = daysSelect?.value || '3';
                    const reason = reasonInput ? reasonInput.value.trim() : '';
                    await ParaFirestore.updatePassengerStatus(userId, 'suspended', daysValue, reason);
                    ParaFirestore.logPassengerAction(userId, name, 'Suspension', reason).catch((error) => console.error('Failed to log passenger action:', error));
                    const durationLabel = daysValue === 'permanent' ? 'indefinitely' : `for ${daysValue} day${daysValue === '1' ? '' : 's'}`;
                    window.showToast(`${name} has been deactivated ${durationLabel}.`, 'error');
                } catch (error) {
                    window.showToast('Failed to deactivate passenger.', 'error');
                }
            },
            customBodyHtml
        );
    };

    window.reactivatePassenger = async function(userId, name) {
        try {
            await ParaFirestore.updatePassengerStatus(userId, 'active');
            ParaFirestore.logPassengerAction(userId, name, 'Reactivation', '').catch((error) => console.error('Failed to log passenger action:', error));
            window.showToast(`${name} reactivated.`, 'success');
        } catch (error) {
            window.showToast('Failed to reactivate passenger.', 'error');
        }
    };

    window.openPassengerEditModal = function(userId) {
        const passenger = (window.allPassengers || []).find((p) => p.id === userId);
        if (!passenger) {
            window.showToast('Passenger record not found.', 'error');
            return;
        }
        currentEditPassengerId = userId;
        document.getElementById('p-edit-first-name').value = passenger.firstName || '';
        document.getElementById('p-edit-last-name').value = passenger.lastName || '';
        document.getElementById('p-edit-phone').value = passenger.phone || '';
        document.getElementById('p-edit-email').value = passenger.email || '';
        document.getElementById('passengerEditModal').classList.add('active');
    };

    window.savePassengerEdit = async function() {
        if (!currentEditPassengerId) return;
        try {
            await ParaFirestore.updatePassenger(currentEditPassengerId, {
                firstName: document.getElementById('p-edit-first-name').value.trim(),
                lastName: document.getElementById('p-edit-last-name').value.trim(),
                phone: document.getElementById('p-edit-phone').value.trim(),
                email: document.getElementById('p-edit-email').value.trim()
            });
            closeModal('passengerEditModal');
            window.showToast('Passenger details updated.', 'success');
        } catch (error) {
            window.showToast('Failed to update passenger.', 'error');
        }
    };

    window.openComplaintModal = async function(complaintId) {
        try {
            const raw = await ParaFirestore.getComplaintById(complaintId);
            if (!raw) return;
            const data = resolveComplaintNames(raw);
            currentComplaintId = complaintId;

            document.getElementById('c-ref').textContent = data.ref;
            document.getElementById('c-reporter').textContent = data.reporter || '—';
            document.getElementById('c-reported').textContent = data.reported || '—';
            const reporterRoleEl = document.getElementById('c-reporter-role');
            const reportedRoleEl = document.getElementById('c-reported-role');
            if (reporterRoleEl) reporterRoleEl.textContent = data.reporterRole || 'Passenger';
            if (reportedRoleEl) reportedRoleEl.textContent = data.reportedRole || 'Driver';
            document.getElementById('c-issue').value = data.issue || '';
            document.getElementById('c-desc').value = data.description || '';

            const notesEl = document.getElementById('complaint-admin-notes');
            if (notesEl) notesEl.value = data.adminNotes || '';

            const todaEl = document.getElementById('c-toda-rec');
            if (todaEl) {
                todaEl.value = data.todaRec;
                todaEl.style.color = { Warning: '#FF9E2A', Suspension: '#EE5D50' }[data.todaRec] || 'var(--text-main)';
            }

            const statusEl = document.getElementById('c-status');
            const normalizedStatus = data.status;
            statusEl.textContent = normalizedStatus.replace(/_/g, ' ').toUpperCase();
            if (normalizedStatus === 'resolved') {
                statusEl.className = 'status-badge approved';
            } else if (normalizedStatus === 'rejected') {
                statusEl.className = 'status-badge declined';
            } else {
                statusEl.className = 'status-badge processing';
            }

            // Once a case is RESOLVED/REJECTED it's read-only — same reasoning
            // as "View Details" on Driver Verification: don't let an
            // already-decided case be actioned again.
            const isOpen = ['pending', 'reviewing'].includes(normalizedStatus);
            ['complaintWarnBtn', 'complaintSuspendBtn', 'complaintResolveBtn'].forEach((id) => {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = isOpen ? '' : 'none';
            });
            const actionedNote = document.getElementById('complaintActionedNote');
            if (actionedNote) actionedNote.style.display = isOpen ? 'none' : '';
            const notesInput = document.getElementById('complaint-admin-notes');
            if (notesInput) notesInput.disabled = !isOpen;

            const complaintBadge = document.querySelector('[data-view="complaints"] .nav-badge');
            if (complaintBadge) {
                complaintBadge.textContent = '';
                complaintBadge.classList.add('hidden');
            }

            document.getElementById('complaintViewModal').classList.add('active');
        } catch (error) {
            window.showToast('Could not load complaint.', 'error');
        }
    };

    // status is the real ComplaintStatus value to write ('RESOLVED'/'REJECTED')
    // — it no longer encodes which remedy was applied. That's actionType
    // ('Warning'/'Suspension'/null), logged separately to driver_actions.
    async function runComplaintAction(status, notes, actionType, suspendDays) {
        if (!currentComplaintId) return;
        const complaint = allComplaints.find((c) => c.id === currentComplaintId);

        try {
            await ParaFirestore.updateComplaintStatus(currentComplaintId, status, notes);

            // Warning/Suspension also act on the actual reported account (always
            // the driver per the real schema) — logged to driver_actions and
            // notified directly, not just recorded on the complaint itself.
            if (actionType && complaint && complaint.reportedId) {
                ParaFirestore.logDriverAction(complaint.reportedId, complaint.reported, actionType, notes)
                    .catch((error) => console.error('Failed to log complaint action:', error));

                if (actionType === 'Suspension') {
                    await ParaFirestore.updateDriverAccountStatus(complaint.reportedId, 'suspended', suspendDays || 3, notes);
                }

                const notifTitle = actionType === 'Warning' ? 'Account Warning' : 'Account Suspended';
                const notifBody = notes || (actionType === 'Warning'
                    ? 'You have received a warning regarding a recent complaint.'
                    : 'Your account has been suspended regarding a recent complaint.');
                ParaFirestore.sendDirectNotification(complaint.reportedId, notifTitle, notifBody).catch((error) => console.error('Failed to notify:', error));
            }

            const normalizedStatus = ParaFirestore.normalizeStatus(status);
            const targetIndex = allComplaints.findIndex((c) => c.id === currentComplaintId);
            if (targetIndex !== -1) {
                allComplaints[targetIndex] = {
                    ...allComplaints[targetIndex],
                    status: normalizedStatus,
                    adminNotes: notes
                };
            }

            updateComplaintStats();
            renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));

            closeModal('complaintViewModal');
            const successMessages = {
                Warning: 'Warning issued and sent to the account.',
                Suspension: 'Account suspended and notified.'
            };
            window.showToast(successMessages[actionType] || 'Case marked as resolved.', actionType === 'Suspension' ? 'error' : (actionType === 'Warning' ? 'warning' : 'success'));
        } catch (error) {
            console.error(`Failed to update complaint to ${status}:`, error);
            window.showToast('Failed to update complaint status.', 'error');
        }
    }

    window.resolveComplaint = function() {
        if (!currentComplaintId) return;
        showConfirmModal(
            'Mark this case as resolved?',
            'The complaint will be closed with no action taken against either account.',
            'Mark Resolved',
            '#05CD99',
            () => {
                const notesEl = document.getElementById('complaint-admin-notes');
                runComplaintAction('RESOLVED', notesEl ? notesEl.value.trim() : '', null);
            }
        );
    };

    window.warnComplaint = function() {
        if (!currentComplaintId) return;
        const complaint = allComplaints.find((c) => c.id === currentComplaintId);
        const name = complaint ? (complaint.reported || 'this account') : 'this account';
        showConfirmModal(
            `Warn ${name}?`,
            'They will receive a notification about this warning, and it will be recorded on their account.',
            'Issue Warning',
            '#FF9E2A',
            () => {
                const notesEl = document.getElementById('complaint-admin-notes');
                runComplaintAction('RESOLVED', notesEl ? notesEl.value.trim() : '', 'Warning');
            }
        );
    };

    window.suspendComplaint = function() {
        if (!currentComplaintId) return;
        const complaint = allComplaints.find((c) => c.id === currentComplaintId);
        if (!complaint || !complaint.reportedId) {
            window.showToast('No linked driver/passenger account on this complaint — cannot suspend automatically.', 'error');
            return;
        }
        const name = complaint.reported || 'this account';
        const roleLabel = (complaint.reportedRole || 'account').toLowerCase();
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">This ${roleLabel} account will be suspended and notified.</div>
            <div style="text-align:left;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Suspend for</label>
                <select id="complaintSuspendDays" class="form-input" style="width:100%; min-height:42px; padding:10px 12px; border:1px solid var(--border-color); border-radius:10px; background:#fff;">
                    <option value="1">1 day</option>
                    <option value="3" selected>3 days</option>
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="permanent">Indefinitely (until manually reactivated)</option>
                </select>
            </div>
        `;
        showConfirmModal(
            `Suspend ${name}?`,
            `This ${roleLabel} account will be suspended.`,
            'Suspend',
            '#EE5D50',
            () => {
                const notesEl = document.getElementById('complaint-admin-notes');
                const daysSelect = document.getElementById('complaintSuspendDays');
                runComplaintAction('RESOLVED', notesEl ? notesEl.value.trim() : '', 'Suspension', daysSelect?.value || '3');
            },
            customBodyHtml
        );
    };

    async function loadBookingsData() {
        try {
            const bookings = await ParaFirestore.fetchBookings();
            renderBookingTable(bookings);
            if (typeof window.renderDashboardCharts === 'function') {
                window.renderDashboardCharts(bookings);
            }
        } catch (error) {
            console.error('Failed to load bookings:', error);
            renderBookingTable([]);
            if (typeof window.renderDashboardCharts === 'function') {
                window.renderDashboardCharts([]);
            }
        }
    }

    window.saveFareSettings = function() {
        const settings = {
            baseFare: Number(document.getElementById('fare-base').value),
            perKmRate: Number(document.getElementById('fare-perkm').value),
            minimumFare: Number(document.getElementById('fare-min').value),
            serviceFeePercent: Number(document.getElementById('fare-svc').value)
        };

        const invalidField = Object.entries(settings).find(([, value]) => !Number.isFinite(value) || value < 0);
        if (invalidField || settings.serviceFeePercent > 100) {
            window.showToast('Please enter valid, non-negative fare values (service fee 0-100%) before saving.', 'warning');
            return;
        }

        showConfirmModal(
            'Update fare settings?',
            `This takes effect on all new bookings immediately: ₱${settings.baseFare} base fare, ₱${settings.perKmRate}/km, ₱${settings.minimumFare} minimum, ${settings.serviceFeePercent}% service fee. Drivers and passengers will be notified.`,
            'Save Changes',
            '#1A73E8',
            async () => {
                try {
                    await ParaFirestore.saveFareSettings(settings);
                    ParaFirestore.sendBroadcastNotification(
                        'Fare Update',
                        `Fares have been updated: ₱${settings.baseFare} base fare, ₱${settings.perKmRate}/km, ₱${settings.minimumFare} minimum fare, ${settings.serviceFeePercent}% service fee.`,
                        'everyone'
                    ).catch((error) => console.error('Failed to send fare update notification:', error));
                    window.showToast('Fare settings saved and drivers/passengers notified.', 'success');
                    if (typeof loadFareSettings === 'function') loadFareSettings();
                } catch (error) {
                    console.error('Failed to save fare settings:', error);
                    window.showToast(error.message || 'Failed to save fare settings.', 'error');
                }
            }
        );
    };

    const AUDIENCE_LABELS = { allDrivers: 'All Drivers', allPassengers: 'All Passengers', everyone: 'Everyone', individual: 'Individual' };
    const NOTIFICATIONS_PAGE_SIZE = 10;
    let notificationHistoryData = [];
    let notificationHistoryPage = 1;

    function renderNotificationHistoryPage() {
        const listEl = document.getElementById('notificationHistoryList');
        const paginationEl = document.getElementById('notificationHistoryPagination');
        if (!listEl) return;

        if (!notificationHistoryData.length) {
            listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">No notifications sent yet.</div>';
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        const totalPages = Math.max(1, Math.ceil(notificationHistoryData.length / NOTIFICATIONS_PAGE_SIZE));
        notificationHistoryPage = Math.min(Math.max(1, notificationHistoryPage), totalPages);
        const pageStart = (notificationHistoryPage - 1) * NOTIFICATIONS_PAGE_SIZE;
        const pageItems = notificationHistoryData.slice(pageStart, pageStart + NOTIFICATIONS_PAGE_SIZE);

        listEl.innerHTML = pageItems.map((n) => {
            const when = n.createdAtRaw ? ParaFirestore.formatDateTime(n.createdAtRaw) : '—';
            const baseAudienceLabel = AUDIENCE_LABELS[n.audience] || n.audience || '—';
            const audienceLabel = n.recipientCount
                ? `${baseAudienceLabel} · ${n.recipientCount} ${n.recipientCount === 1 ? 'recipient' : 'recipients'}`
                : baseAudienceLabel;
            return `
                <div style="border:1px solid var(--border-color); border-radius:10px; padding:12px 14px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:10px;">
                        <strong style="font-size:13px;">${escapeHtml(n.title || '(no title)')}</strong>
                        <span style="font-size:11px; color:var(--text-muted); white-space:nowrap;">${escapeHtml(when)}</span>
                    </div>
                    <div style="font-size:13px; color:var(--text-main); margin-bottom:4px;">${escapeHtml(n.body || '')}</div>
                    <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">${escapeHtml(audienceLabel)}</div>
                </div>
            `;
        }).join('');

        if (paginationEl) {
            const rangeStart = pageStart + 1;
            const rangeEnd = Math.min(notificationHistoryData.length, pageStart + NOTIFICATIONS_PAGE_SIZE);
            paginationEl.innerHTML = `
                <span>Showing ${rangeStart}–${rangeEnd} of ${notificationHistoryData.length}</span>
                <div style="display:flex; gap:8px;">
                    <button class="action-btn" ${notificationHistoryPage <= 1 ? 'disabled' : ''} onclick="changeNotificationHistoryPage(-1)">Prev</button>
                    <span style="padding:6px 4px;">Page ${notificationHistoryPage} of ${totalPages}</span>
                    <button class="action-btn" ${notificationHistoryPage >= totalPages ? 'disabled' : ''} onclick="changeNotificationHistoryPage(1)">Next</button>
                </div>
            `;
        }
    }

    window.changeNotificationHistoryPage = function(delta) {
        notificationHistoryPage += delta;
        renderNotificationHistoryPage();
    };

    async function loadNotificationHistory() {
        const listEl = document.getElementById('notificationHistoryList');
        if (!listEl) return;
        try {
            notificationHistoryData = await ParaFirestore.fetchNotifications(100);
            notificationHistoryPage = 1;
            renderNotificationHistoryPage();
        } catch (error) {
            console.error('Failed to load notification history:', error);
            listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Could not load notification history.</div>';
        }
    }

    window.sendNotification = function() {
        const titleEl = document.getElementById('notif-title');
        const bodyEl = document.getElementById('notif-body');
        const title = titleEl ? titleEl.value.trim() : '';
        const body = bodyEl ? bodyEl.value.trim() : '';
        if (!title || !body) {
            window.showToast('Please fill in both title and message.', 'warning');
            return;
        }

        const audience = window.selectedNotificationAudience || 'allDrivers';
        const audienceLabel = AUDIENCE_LABELS[audience] || audience;

        showConfirmModal(
            `Send this notification to ${audienceLabel}?`,
            'This cannot be recalled once sent.',
            'Send Notification',
            '#1A73E8',
            async () => {
                try {
                    const { recipientCount } = await ParaFirestore.sendBroadcastNotification(title, body, audience);
                    if (!recipientCount) {
                        window.showToast(`No ${audienceLabel.toLowerCase()} accounts were found, so nothing was sent.`, 'warning');
                        return;
                    }
                    window.showToast(`Notification sent to ${recipientCount} ${recipientCount === 1 ? 'user' : 'users'}.`, 'success');
                    titleEl.value = '';
                    bodyEl.value = '';
                    loadNotificationHistory();
                } catch (error) {
                    console.error('Failed to send notification:', error);
                    window.showToast('Failed to send notification. Check your Firebase connection and rules.', 'error');
                }
            }
        );
    };

    window.confirmSignOut = async function() {
        try {
            await ParaFirestore.signOut();
        } catch (error) {
            console.error(error);
        }
        window.location.href = 'index.html';
    };

    ParaFirestore.listenApprovedDrivers((drivers) => {
        renderDriverManagementTable(drivers);
        refreshComplaintDisplay();
    });
    // Separate from the approved-only list above — this covers every driver
    // regardless of verification status, purely for resolving names (e.g. on
    // complaints) where the driver might not be approved yet.
    ParaFirestore.listenDrivers(null, (drivers) => {
        window.allDriversForLookup = drivers;
        refreshComplaintDisplay();
    });
    ParaFirestore.reactivateExpiredDrivers().catch((error) => {
        console.error('Failed to auto-reactivate expired drivers:', error);
    });
    ParaFirestore.reactivateExpiredPassengers().catch((error) => {
        console.error('Failed to auto-reactivate expired passengers:', error);
    });
    setInterval(() => {
        ParaFirestore.reactivateExpiredDrivers().catch((error) => {
            console.error('Failed to auto-reactivate expired drivers:', error);
        });
        ParaFirestore.reactivateExpiredPassengers().catch((error) => {
            console.error('Failed to auto-reactivate expired passengers:', error);
        });
    }, 60000);
    ParaFirestore.listenPassengers((passengers) => {
        window.allPassengers = passengers;
        renderPassengerTable(passengers);
        refreshComplaintDisplay();
    });
    loadBookingsData();
    ParaFirestore.listenBookings((bookings) => {
        renderBookingTable(bookings);
        if (typeof window.renderDashboardCharts === 'function') {
            window.renderDashboardCharts(bookings);
        }
        // Passenger ride stats are computed live from bookings — refresh that
        // table too whenever booking data changes, not just when passengers do.
        if (window.allPassengers) {
            renderPassengerTable(window.allPassengers);
        }
        if (window.driverManagementDrivers) {
            renderDriverManagementTable(window.driverManagementDrivers);
        }
    });
    ParaFirestore.listenComplaints((complaints) => {
        allComplaints = (complaints || []).map(resolveComplaintNames).sort((a, b) => {
            const timeA = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : (a.createdAt instanceof Date ? a.createdAt.getTime() : 0);
            const timeB = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : (b.createdAt instanceof Date ? b.createdAt.getTime() : 0);
            return timeB - timeA;
        });
        updateComplaintStats();
        renderComplaintTable(allComplaints);
    });

    loadDashboardStats();
    loadFareSettings();
    loadTodaPresidentAccounts();
    loadNotificationHistory();

    // ── Global Search ────────────────────────────────────────────
    // Searches over data already loaded in memory for the other views
    // (drivers, passengers, bookings) — no extra Firestore reads.
    function buildSearchIndex() {
        const results = [];

        (window.driverManagementDrivers || []).forEach((d) => {
            results.push({
                type: 'Driver',
                id: d.id,
                label: d.name || 'Unnamed driver',
                sub: `Plate: ${d.plate || '—'}`,
                haystack: `${d.name || ''} ${d.plate || ''} ${d.license || ''}`.toLowerCase(),
                data: d
            });
        });

        (window.allPassengers || []).forEach((p) => {
            results.push({
                type: 'Passenger',
                id: p.id,
                label: p.name || 'Unnamed passenger',
                sub: p.phone || p.email || '',
                haystack: `${p.name || ''} ${p.phone || ''} ${p.email || ''}`.toLowerCase(),
                data: p
            });
        });

        (window.allBookings || window.dashboardBookings || []).forEach((b) => {
            results.push({
                type: 'Booking',
                id: b.id,
                label: b.ref || b.id,
                sub: `${b.driverName || 'Unknown driver'} · ${b.dateLabel || ''}`,
                haystack: `${b.ref || ''} ${b.driverName || ''} ${b.passengerName || ''}`.toLowerCase(),
                data: b
            });
        });

        return results;
    }

    function goToSearchResult(item) {
        if (item.type === 'Driver') {
            document.querySelector('[data-view="driver-management"]')?.click();
            window.openDriverEditModal(item.id);
        } else if (item.type === 'Passenger') {
            document.querySelector('[data-view="passenger-management"]')?.click();
        } else if (item.type === 'Booking') {
            document.querySelector('[data-view="bookings"]')?.click();
            const datePicker = document.getElementById('bookingDatePicker');
            if (datePicker && item.data.createdAtRaw) {
                const d = new Date(item.data.createdAtRaw);
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                datePicker.value = iso;
            }
            window.bookingStatusFilter = 'all';
            const statusBtn = document.getElementById('statusFilterBtn');
            if (statusBtn) {
                const filterText = statusBtn.querySelector('.filter-val');
                if (filterText) filterText.textContent = 'All';
            }
            bookingTablePage = 1;
            renderBookingTable(window.allBookings || []);
        }
    }

    function renderSearchResults(query) {
        const panel = document.getElementById('globalSearchResults');
        if (!panel) return;

        const q = query.trim().toLowerCase();
        if (q.length < 2) {
            panel.classList.remove('show');
            panel.innerHTML = '';
            return;
        }

        const matches = buildSearchIndex().filter((item) => item.haystack.includes(q)).slice(0, 8);

        if (!matches.length) {
            panel.innerHTML = `<div class="dropdown-content"><div class="dropdown-item" style="cursor:default;"><span class="item-text" style="color:var(--text-muted);">No matches</span></div></div>`;
            panel.classList.add('show');
            return;
        }

        panel.innerHTML = `<div class="dropdown-content">${matches.map((item, i) => `
            <div class="dropdown-item" data-search-index="${i}">
                <span class="item-text"><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.sub)}<br><span style="font-size:11px; color:var(--text-muted);">${item.type}</span></span>
            </div>
        `).join('')}</div>`;
        panel.classList.add('show');

        panel.querySelectorAll('[data-search-index]').forEach((el) => {
            el.addEventListener('click', () => {
                goToSearchResult(matches[Number(el.dataset.searchIndex)]);
                panel.classList.remove('show');
                const input = document.getElementById('globalSearchInput');
                if (input) input.value = '';
            });
        });
    }

    const globalSearchInput = document.getElementById('globalSearchInput');
    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));
        globalSearchInput.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => {
            const panel = document.getElementById('globalSearchResults');
            if (panel) panel.classList.remove('show');
        });
    }
});
