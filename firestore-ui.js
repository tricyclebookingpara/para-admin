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
        // Shown to the president in the app on suspension requests the admin decides.
        window.ParaAdminName = displayName === user.email ? 'PARA Admin' : displayName;

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
    let currentComplaintId = null;
    let currentVerificationFilter = 'pending';

    window.driverMgmtStatusFilter = 'all';
    window.driverMgmtSortMode = 'rating-desc';
    window.passengerMgmtStatusFilter = 'all';
    window.bookingStatusFilter = 'all';
    window.allBookings = [];

    const statusBadge = {
        pending: { className: 'processing', label: 'PENDING' },
        // The president's app moves a complaint to REVIEWING when they recommend
        // something; here it is still just open, so it reads Pending.
        reviewing: { className: 'processing', label: 'PENDING' },
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
        declined: { className: 'declined', label: 'DECLINED' },
        accepted: { className: 'processing', label: 'ACCEPTED' },
        arrived: { className: 'processing', label: 'ARRIVED' },
        no_show: { className: 'declined', label: 'NO-SHOW' }
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

    // A complaint closed without action is "Dismissed", the word the TODA
    // president's app uses; the stored status is still REJECTED. The plain
    // 'rejected' label stays for driver applications.
    function complaintStatusLabel(status) {
        const key = ParaFirestore.normalizeStatus(status);
        if (key === 'rejected') return 'Dismissed';
        if (key === 'reviewing') return 'Pending';
        return String(status || '').replace(/_/g, ' ');
    }

    function complaintBadge(status) {
        return ParaFirestore.normalizeStatus(status) === 'rejected' ? renderBadge('rejected', 'DISMISSED') : renderBadge(status);
    }

    // A driver's profile photo as a circle, or their initials when there is none
    // (or the picture can't load). `sizeClass`: '' (36px), 'pf-avatar-md', 'pf-avatar-lg'.
    function driverInitials(driver) {
        return String((driver && driver.name) || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
    }

    function driverAvatarHtml(driver, sizeClass = '') {
        const initials = driverInitials(driver);
        const inner = driver && driver.profileImage
            ? `<img src="${escapeHtml(driver.profileImage)}" alt="" loading="lazy" data-initials="${escapeHtml(initials)}" onerror="this.parentNode.textContent=this.dataset.initials">`
            : escapeHtml(initials);
        return `<div class="pf-avatar ${sizeClass}">${inner}</div>`;
    }

    // ── Driver risk score ────────────────────────────────────────
    // Read from driver_risk (kept by the app's Cloud Functions) — never
    // recalculated here. It only advises: nothing is suspended automatically,
    // the admin decides. No doc = not scored yet = treated as LOW.
    const driverRisk = new Map();

    function riskOf(driverId) {
        return driverRisk.get(driverId) || null;
    }

    function riskScoreOf(driverId) {
        const risk = riskOf(driverId);
        return risk ? risk.score : 0;
    }

    function riskChipHtml(risk) {
        if (!risk) return '';
        const level = ['HIGH', 'MEDIUM', 'LOW'].includes(risk.level) ? risk.level : 'LOW';
        return `<span class="risk-chip ${level.toLowerCase()}" title="Driver risk score, 0 to 100">${Math.round(risk.score)} · ${level}</span>`;
    }

    // How the score is built, so an admin can explain it to a driver.
    function riskExplainHtml() {
        return `<details class="risk-explain"><summary>How is this calculated?</summary>
            <ul>
                <li><strong>Complaints (45%)</strong> — each counts 1 when filed, half as much every 30 days, and stops after 90 days. Complaints that were dismissed never count. A total of 3 or more gives the full 45 points.</li>
                <li><strong>Rating (25%)</strong> — adjusted so a driver with few ratings isn’t judged on one bad trip. 4.0★ or better adds nothing; 2.5★ or lower adds the full 25.</li>
                <li><strong>Past offences (15%)</strong> — warnings from the last 180 days plus suspensions you approved (a suspension and the president recommendation it carried out count once). 3 or more gives the full 15.</li>
                <li><strong>Cancellations (15%)</strong> — rides the driver cancelled after accepting, out of those accepted in the last 30 days. Needs at least 10 accepted rides. 5% or less adds nothing; 25% or more adds the full 15.</li>
            </ul>
            <div>60+ is HIGH, 30–59 MEDIUM, under 30 LOW. Suspension is only suggested for a driver who already has a warning or an approved suspension.</div>
        </details>`;
    }

    // The score, what it suggests, why, and (in a case) how it compares with
    // what the TODA president recommended.
    function riskBodyHtml(risk, presidentSuspension = false) {
        const level = ['HIGH', 'MEDIUM', 'LOW'].includes(risk.level) ? risk.level : 'LOW';
        const cls = level.toLowerCase();
        const score = Math.round(risk.score);
        const width = Math.min(100, Math.max(0, risk.score));
        const reasons = risk.reasons.length
            ? `<ul class="risk-reasons">${risk.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '<div class="risk-quiet">Nothing is raising this driver’s score.</div>';
        let comparison = '';
        if (presidentSuspension) {
            comparison = risk.suggestedAction === 'Suspension'
                ? '<div class="risk-compare ok">The TODA president recommends a suspension — the score agrees.</div>'
                : `<div class="risk-compare differs"><strong>The TODA president recommends a suspension, but the score suggests ${escapeHtml(risk.suggestedAction)}.</strong> Look at why they differ before deciding.</div>`;
        }
        return `<div class="risk-top">
                <div class="risk-num"><span class="risk-num-value ${cls}">${score}</span><span class="risk-num-max">/ 100</span></div>
                <div class="risk-top-main">
                    <div class="risk-level-row"><span class="risk-chip ${cls}">${level}</span><span class="risk-action">Suggested action: <strong>${escapeHtml(risk.suggestedAction)}</strong></span></div>
                    <div class="risk-bar" title="Score ${score} of 100 (30 and 60 mark the levels)"><div class="risk-bar-fill ${cls}" style="width:${width}%"></div><i style="left:30%"></i><i style="left:60%"></i></div>
                </div>
            </div>
            ${comparison}${reasons}
            <div class="risk-foot">Advisory only — nothing is suspended automatically${risk.updatedAtRaw ? ` · Calculated ${escapeHtml(ParaFirestore.formatDateTime(risk.updatedAtRaw))}` : ''}</div>
            ${riskExplainHtml()}`;
    }

    // ── Document expiry ──────────────────────────────────────────
    // The only expiry the app asks drivers for is the driver's license
    // (licenseExpiryDate, typed as dd/mm/yy). The government ID and the OR/CR
    // have no expiry on file, so they can't be tracked here.
    const EXPIRY_SOON_DAYS = 30;

    // dd/mm/yy, dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, mm/yyyy or "May 2028" ->
    // a Date at local midnight (a month on its own means its last day), or null.
    function parseExpiryDate(text) {
        const s = String(text || '').trim();
        if (!s) return null;
        const valid = (y, m, d) => {
            const date = new Date(y, m - 1, d);
            return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
        };
        let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
        m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
        if (m) {
            let day = Number(m[1]);
            let month = Number(m[2]);
            let year = Number(m[3]);
            if (year < 100) year += 2000;
            if (month > 12 && day <= 12) [day, month] = [month, day]; // typed month/day
            return valid(year, month, day);
        }
        m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
        if (m) {
            const month = Number(m[1]);
            return month >= 1 && month <= 12 ? new Date(Number(m[2]), month, 0) : null;
        }
        const named = Date.parse(`1 ${s}`);
        if (/[a-z]{3}/i.test(s) && !Number.isNaN(named)) {
            const d = new Date(named);
            return new Date(d.getFullYear(), d.getMonth() + 1, 0);
        }
        return null;
    }

    // status: 'expired' | 'soon' | 'ok' | 'unreadable' | 'none'
    function licenseExpiryInfo(driver) {
        const raw = String((driver && driver.licenseExpiry) || '').trim();
        if (!raw) return { status: 'none', raw };
        const date = parseExpiryDate(raw);
        if (!date) return { status: 'unreadable', raw };
        const today = new Date();
        const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const days = Math.round((date - midnight) / 86400000);
        const dateLabel = date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
        const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
        if (days < 0) return { status: 'expired', raw, date, days, dateLabel, text: `License expired ${plural(-days)} ago`, short: 'License expired' };
        if (days === 0) return { status: 'soon', raw, date, days, dateLabel, text: 'License expires today', short: 'License expires today' };
        if (days <= EXPIRY_SOON_DAYS) return { status: 'soon', raw, date, days, dateLabel, text: `License expires in ${plural(days)}`, short: `License expires in ${plural(days)}` };
        return { status: 'ok', raw, date, days, dateLabel };
    }

    function expiryChipHtml(info) {
        return info && (info.status === 'expired' || info.status === 'soon')
            ? `<span class="expiry-chip ${info.status}" title="Expires ${escapeHtml(info.dateLabel)}">${escapeHtml(info.short)}</span>`
            : '';
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

    // The document photos the driver uploaded in the app, from Firebase Storage
    // (see fetchDriverDocuments). Nothing is shown in place of a missing file.
    // The government ID is shown once, next to the profile photo (prefix cmp-gov).
    const REQUIRED_DOCUMENT_COUNT = 4;
    const VERIFICATION_DOC_SLOTS = [
        { key: 'license', prefix: 'license' },
        { key: 'vehicleRegistration', prefix: 'reg' },
        { key: 'tricyclePermit', prefix: 'permit' }
    ];

    function setDocMessage(prefix, message) {
        setDocImage(`v-${prefix}-link`, `v-${prefix}-img`, '', `v-${prefix}-empty`);
        const empty = document.getElementById(`v-${prefix}-empty`);
        if (empty) empty.textContent = message;
    }

    // The three document photos for a driver: from Storage, and from the URLs
    // the app also copies onto the user doc (used when Storage has no match or
    // can't be read). `error` is set when Storage failed.
    async function fetchDriverDocumentUrls(driver) {
        const fromDoc = {
            governmentId: driver.governmentIdImageUrl || '',
            license: driver.licenseImageUrl || '',
            vehicleRegistration: driver.vehicleRegistrationImageUrl || '',
            tricyclePermit: driver.tricyclePermitImageUrl || ''
        };
        let stored = {};
        let error = null;
        try {
            stored = await ParaFirestore.fetchDriverDocuments(driver.id);
        } catch (storageError) {
            console.error('Failed to load driver documents:', storageError);
            error = storageError;
        }
        const documents = {};
        Object.keys(fromDoc).forEach((key) => { documents[key] = stored[key] || fromDoc[key] || null; });
        // The permit file name ends in a timestamp, so the user-doc URL always
        // points at the current file and wins over whatever Storage lists.
        documents.tricyclePermit = fromDoc.tricyclePermit || stored.tricyclePermit || null;
        return { documents, error };
    }

    function documentErrorMessage(error) {
        const blocked = error && (error.code === 'storage/unauthorized' || error.code === 'storage/unauthenticated');
        return blocked ? 'Can’t open — Storage rules don’t allow the admin site to read this file' : 'Could not load';
    }

    async function loadVerificationDocuments(driver) {
        const driverId = driver.id;
        VERIFICATION_DOC_SLOTS.forEach(({ prefix }) => setDocMessage(prefix, 'Loading…'));
        setDocMessage('cmp-gov', 'Loading…');
        const { documents, error } = await fetchDriverDocumentUrls(driver);
        if (currentVerificationDriverId !== driverId) return; // another application was opened meanwhile
        const show = (prefix, url, storageBacked = true) => {
            if (url) setDocImage(`v-${prefix}-link`, `v-${prefix}-img`, url, `v-${prefix}-empty`);
            else setDocMessage(prefix, error && storageBacked ? documentErrorMessage(error) : 'Not uploaded');
        };
        // The permit's URL is on the user doc, which is always readable, so a Storage
        // error says nothing about it — an empty field just means "Not uploaded".
        VERIFICATION_DOC_SLOTS.forEach(({ key, prefix }) => show(prefix, documents[key], key !== 'tricyclePermit'));
        // The same ID photo again, next to the profile photo for the face check.
        show('cmp-gov', documents.governmentId);
        // "x of 4 documents": the app counts the ID, license, OR/CR and tricycle
        // permit. Left out when Storage couldn't be read, since the count would be a guess.
        const found = ['governmentId', 'license', 'vehicleRegistration', 'tricyclePermit'].filter((key) => documents[key]).length;
        const meta = document.getElementById('v-meta');
        if (meta && !(error && found < REQUIRED_DOCUMENT_COUNT)) {
            meta.insertAdjacentHTML('beforeend', `<span>${found} of ${REQUIRED_DOCUMENT_COUNT} documents</span>`);
        }
    }

    // ── Duplicate accounts ───────────────────────────────────────
    // The app lets anyone register, so the check happens here, at approval: two
    // accounts that share a license number, government ID number or mobile
    // number are the same person. A match with an already-APPROVED account
    // blocks approval; a match with a pending or rejected one is a warning.
    // A shared plate number alone is only noted — a tricycle can have more
    // than one driver.
    const DUPLICATE_FIELDS = [
        { key: 'license', label: 'license number', normalize: (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '') },
        { key: 'governmentId', label: 'government ID number', normalize: (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '') },
        { key: 'phone', label: 'mobile number', normalize: (v) => {
            const digits = String(v || '').replace(/\D/g, '');
            if (digits.length === 12 && digits.startsWith('63')) return `0${digits.slice(2)}`;
            if (digits.length === 10 && digits.startsWith('9')) return `0${digits}`;
            return digits;
        } }
    ];
    const PLATE_FIELD = { key: 'plate', label: 'plate number', normalize: (v) => ParaFirestore.normalizePlate(v) };

    function findDuplicates(driver) {
        if (!driver) return [];
        const matches = new Map();
        const check = (field, soft) => {
            const value = field.normalize(driver[field.key]);
            if (value.length < 4) return; // nothing real to compare
            allDrivers.forEach((other) => {
                if (other.id === driver.id || field.normalize(other[field.key]) !== value) return;
                const entry = matches.get(other.id) || { other, fields: [], soft: true };
                entry.fields.push(field.label);
                if (!soft) entry.soft = false;
                matches.set(other.id, entry);
            });
        };
        DUPLICATE_FIELDS.forEach((field) => check(field, false));
        check(PLATE_FIELD, true);
        return [...matches.values()].map((entry) => ({
            ...entry,
            blocking: !entry.soft && entry.other.verificationStatus === 'approved'
        }));
    }

    function renderVerificationHead() {
        const head = document.getElementById('verificationHead');
        if (!head) return;
        if (currentVerificationFilter === 'photos') {
            head.innerHTML = '<tr><th>Driver Name</th><th>TODA / Vehicle</th><th>Photo Uploaded</th><th>Status</th><th>Actions</th></tr>';
        } else if (currentVerificationFilter === 'pending') {
            head.innerHTML = '<tr><th>Driver Name</th><th>Vehicle Details</th><th>Submitted On</th><th>Status</th><th>Actions</th></tr>';
        } else {
            head.innerHTML = `<tr><th>Driver Name</th><th>Vehicle Details</th><th>${currentVerificationFilter === 'approved' ? 'Approved On' : 'Rejected On'}</th><th>Decision</th><th>Actions</th></tr>`;
        }
    }

    function renderVerificationTable(drivers) {
        const tbody = document.querySelector('#view-driver-verification .data-table tbody');
        if (!tbody) return;
        renderVerificationHead();

        if (!drivers.length) {
            const emptyLabels = {
                pending: 'No pending applications.',
                approved: 'No approved drivers yet.',
                rejected: 'No rejected applications.',
                photos: 'No profile photos are waiting for review.'
            };
            tbody.innerHTML = emptyRow(5, emptyLabels[currentVerificationFilter]);
            return;
        }

        const isPending = currentVerificationFilter === 'pending';
        tbody.innerHTML = drivers.map((driver) => {
            const label = isPending ? 'Review' : 'View Details';
            const btnStyle = isPending ? '' : ' style="background:var(--bg-light);color:var(--text-main);"';
            const btn = `<button class="action-btn"${btnStyle} data-action="review-driver" data-id="${escapeHtml(driver.id)}">${label}</button>`;
            const nameCell = `<td><div class="pf-name">${driverAvatarHtml(driver, currentVerificationFilter === 'photos' ? 'pf-avatar-md' : '')}<div><div class="detail-main">${escapeHtml(driver.name)}</div><div class="detail-sub">Lic: ${escapeHtml(driver.license)}</div></div></div></td>`;
            const vehicleCell = `<td><div class="detail-main">${escapeHtml(driver.vehicle)}</div><div class="detail-sub">Plate: ${escapeHtml(driver.plate)}</div></td>`;

            if (currentVerificationFilter === 'photos') {
                // An approved driver replaced their photo — it's visible to passengers
                // already and waits here for the admin to approve or reject it.
                return `<tr>
                    ${nameCell}
                    <td><div class="detail-main">${escapeHtml(driver.todaName || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(driver.plate || '—')}</div></td>
                    <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(driver.profilePhotoUpdatedAtRaw ? ParaFirestore.formatDateTime(driver.profilePhotoUpdatedAtRaw) : '—')}</td>
                    <td>${renderBadge('pending', 'UNDER REVIEW')}</td>
                    <td><button class="action-btn" data-action="review-photo" data-id="${escapeHtml(driver.id)}">Review Photo</button></td>
                </tr>`;
            }

            if (!isPending) {
                // The decision log: when, who, and (for a rejection) why.
                const decision = verificationDecisions.get(driver.id);
                const decidedAt = driver.verifiedAtRaw || (decision && decision.issuedAt ? new Date(decision.issuedAt) : null);
                const detail = currentVerificationFilter === 'rejected'
                    ? (decision && decision.reason ? decision.reason : '')
                    : (decision && decision.issuedByName ? `By ${decision.issuedByName}` : '');
                return `<tr>
                    ${nameCell}${vehicleCell}
                    <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(decidedAt ? ParaFirestore.formatDateTime(decidedAt) : '—')}</td>
                    <td>${renderBadge(driver.verificationStatus)}${detail ? `<div class="detail-sub" style="margin-top:4px; max-width:240px; line-height:1.4;">${escapeHtml(detail)}</div>` : ''}</td>
                    <td>${btn}</td>
                </tr>`;
            }

            // Pending covers both "never looked at" and "already reviewed once, waiting
            // on the driver to resubmit requested documents" — flag the latter so it
            // doesn't get mistaken for (or re-requested as) a fresh application.
            const resubmittedAt = driver.infoRequest ? Number(driver.infoRequest.submittedAt) || 0 : 0;
            const infoRequestNote = !driver.infoRequest ? ''
                : resubmittedAt
                    ? `<div class="detail-sub" style="color:#1A73E8; font-weight:600; margin-top:4px;">Resubmitted ${escapeHtml(ParaFirestore.formatDateTime(resubmittedAt))} — review the new documents</div>`
                    : `<div class="detail-sub" style="color:#B8860B; margin-top:4px;">Awaiting driver response</div>`;
            const duplicates = findDuplicates(driver).filter((d) => !d.soft);
            const duplicateNote = duplicates.length
                ? `<div class="detail-sub" style="color:#EE5D50; font-weight:600; margin-top:4px;">${duplicates.some((d) => d.blocking) ? 'Duplicate account' : 'Possible duplicate'}</div>`
                : '';
            return `<tr>
                ${nameCell}${vehicleCell}
                <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(driver.submittedAt)}</td>
                <td>${renderBadge(driver.verificationStatus)}${infoRequestNote}${duplicateNote}</td>
                <td>${btn}</td>
            </tr>`;
        }).join('');

        bindRowActions(tbody, {
            'review-driver': (ds) => window.openVerificationModal(ds.id),
            'review-photo': (ds) => window.openPhotoReviewModal(ds.id)
        });
    }

    function getDriverPerformanceStars(rating) {
        const numericRating = Number(rating || 0);
        if (!Number.isFinite(numericRating) || numericRating <= 0) return '☆☆☆☆☆';
        const normalized = Math.min(Math.max(numericRating, 0), 5);
        const filled = Math.round(normalized);
        return '★'.repeat(filled) + '☆'.repeat(5 - filled);
    }

    // Whether a driver is on the road right now, from what the app writes
    // (driverStatus + the time of the last position ping). The app only goes
    // OFFLINE when the driver taps it, so a driver whose app was closed keeps
    // their last status; a ping older than the app's own 5-minute cutoff
    // means they aren't really reachable.
    const DRIVER_PING_FRESH_MS = 5 * 60 * 1000;

    function driverPresenceLine(driver) {
        // A suspended driver isn't offered to passengers whatever their last status was.
        if (driver.accountStatus === 'suspended') return '';
        if (driver.driverStatus === 'OFFLINE') {
            return '<div class="detail-sub" style="margin-top:4px;"><span style="color:#A3AED0;">●</span> Offline</div>';
        }
        const fresh = driver.lastLocationAt && (Date.now() - driver.lastLocationAt) <= DRIVER_PING_FRESH_MS;
        if (!fresh) {
            return '<div class="detail-sub" style="margin-top:4px;"><span style="color:#A3AED0;">●</span> Not responding</div>';
        }
        if (driver.driverStatus === 'BUSY') {
            return '<div class="detail-sub" style="margin-top:4px;"><span style="color:#FF9E2A;">●</span> On a ride</div>';
        }
        return '<div class="detail-sub" style="margin-top:4px;"><span style="color:#05CD99;">●</span> Online</div>';
    }

    // ── Document alerts (the bell in the top bar) ────────────────
    // Approved drivers whose license has expired or expires within 30 days,
    // expired first. There's no push channel to the admin, so this is what the
    // bell counts, and a one-time toast per session says so on opening the site.
    function documentAlerts() {
        return (window.driverManagementDrivers || [])
            .map((driver) => ({ driver, info: licenseExpiryInfo(driver) }))
            .filter(({ info }) => info.status === 'expired' || info.status === 'soon')
            .sort((a, b) => a.info.days - b.info.days);
    }

    let documentAlertsToasted = false;

    function renderDocumentAlerts() {
        const alerts = documentAlerts();
        const count = document.getElementById('alertsCount');
        if (count) {
            count.textContent = alerts.length || '';
            count.classList.toggle('hidden', !alerts.length);
        }
        const list = document.getElementById('alertsList');
        if (list) {
            if (!alerts.length) {
                list.innerHTML = '<div class="alerts-empty">No driver’s licenses are expired or about to expire.</div>';
            } else {
                const row = ({ driver, info }) => `<div class="alert-row" data-alert-driver="${escapeHtml(driver.id)}">
                    ${driverAvatarHtml(driver)}
                    <div class="alert-row-main">
                        <div class="alert-row-name">${escapeHtml(driver.name || 'Unnamed driver')}</div>
                        <div class="alert-row-text">${escapeHtml(info.text)} · ${escapeHtml(info.dateLabel)}</div>
                    </div>
                    <button class="btn btn-secondary alert-remind" data-remind-driver="${escapeHtml(driver.id)}" title="Send the driver a reminder in the app">Remind</button>
                </div>`;
                const expired = alerts.filter((a) => a.info.status === 'expired');
                const soon = alerts.filter((a) => a.info.status === 'soon');
                list.innerHTML = (expired.length ? `<div class="alerts-group expired">Expired (${expired.length})</div>${expired.map(row).join('')}` : '')
                    + (soon.length ? `<div class="alerts-group soon">Expiring within ${EXPIRY_SOON_DAYS} days (${soon.length})</div>${soon.map(row).join('')}` : '');
            }
        }
        if (alerts.length && !documentAlertsToasted) {
            documentAlertsToasted = true;
            const expired = alerts.filter((a) => a.info.status === 'expired').length;
            const soon = alerts.length - expired;
            window.showToast(`Driver licenses: ${[expired && `${expired} expired`, soon && `${soon} expiring soon`].filter(Boolean).join(', ')}. See the bell.`, 'warning');
        }
    }

    // A reminder goes to the driver's in-app notifications; the admin confirms first.
    function remindDriverAboutLicense(driverId) {
        const driver = (window.driverManagementDrivers || []).find((d) => d.id === driverId);
        if (!driver) return;
        const info = licenseExpiryInfo(driver);
        const body = info.status === 'expired'
            ? `Your driver’s license expired on ${info.dateLabel}. Please renew it and update your documents in the app so you can keep driving.`
            : `Your driver’s license expires on ${info.dateLabel}. Please renew it and update your documents in the app before then.`;
        showConfirmModal(
            `Remind ${driver.name || 'this driver'}?`,
            `They get this in-app notification: “${body}”`,
            'Send Reminder',
            '#1A73E8',
            async () => {
                try {
                    await ParaFirestore.sendDirectNotification(driver.id, 'Driver’s license renewal', body);
                    window.showToast('Reminder sent.', 'success');
                } catch (error) {
                    console.error('Failed to send the reminder:', error);
                    window.showToast('Could not send the reminder.', 'error');
                }
            }
        );
    }

    document.getElementById('alertsList')?.addEventListener('click', (e) => {
        const remind = e.target.closest('[data-remind-driver]');
        const panel = document.getElementById('alertsPanel');
        if (remind) {
            if (panel) panel.classList.remove('show');
            remindDriverAboutLicense(remind.dataset.remindDriver);
            return;
        }
        const row = e.target.closest('[data-alert-driver]');
        if (row) {
            if (panel) panel.classList.remove('show');
            document.querySelector('.nav-link[data-view="driver-management"]')?.click();
            window.openDriverDetailsModal(row.dataset.alertDriver);
        }
    });
    // Days tick over at midnight even if the page stays open.
    setInterval(renderDocumentAlerts, 60 * 60 * 1000);

    // Only MEDIUM and HIGH are flagged in the list; LOW stays quiet (it's in the details window).
    function driverRiskFlag(driver) {
        const risk = riskOf(driver.id);
        return risk && risk.level !== 'LOW' ? `<div style="margin-top:6px;">${riskChipHtml(risk)}</div>` : '';
    }

    function driverLicenseFlag(driver) {
        const chip = expiryChipHtml(licenseExpiryInfo(driver));
        return chip ? `<div style="margin-top:6px;">${chip}</div>` : '';
    }

    // On Driver Management and Passenger Management the top-bar search box filters
    // the list as you type, matching any part of the name, plate, phone, e-mail…
    // (on the other pages it still opens the quick-jump results instead).
    let listSearchTerm = '';
    function matchesListSearch(values) {
        return !listSearchTerm || values.some((value) => String(value || '').toLowerCase().includes(listSearchTerm));
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
        refreshDriverDetails();
        renderDocumentAlerts();

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

        list = list.filter((d) => matchesListSearch([d.name, d.vehicle, d.plate, d.motorcycleModel, d.phone, d.email, d.license]));

        if (!list.length) {
            tbody.innerHTML = emptyRow(5, listSearchTerm ? 'No drivers match your search.' : 'No approved drivers found in Firestore.');
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
            if (sortMode === 'risk-desc') return riskScoreOf(b.id) - riskScoreOf(a.id) || bRating - aRating;
            return 0;
        });

        tbody.innerHTML = list.map((driver) => {
            const isSuspended = driver.accountStatus === 'suspended';
            const ratingValue = Number(driver.rating) || 0;
            const actionBtn = isSuspended
                ? `<button class="action-btn" style="background:#05CD99;" data-action="reactivate-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">Reactivate</button>`
                : `<button class="action-btn" style="background:#EE5D50;" data-action="ban-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">Suspend</button>`;
            let suspensionNote = '';
            if (isSuspended) {
                const untilText = driver.suspendedUntilRaw ? `Until ${ParaFirestore.formatDateTime(driver.suspendedUntilRaw)}` : 'Indefinitely';
                const reasonText = driver.suspensionReason ? ` — ${driver.suspensionReason}` : '';
                suspensionNote = `<div class="detail-sub" style="margin-top:4px;">${escapeHtml(untilText + reasonText)}</div>`;
            }
            return `<tr class="row-clickable" data-driver-id="${escapeHtml(driver.id)}" title="View driver details">
                <td><div class="pf-name">${driverAvatarHtml(driver)}<div><div class="detail-main">${escapeHtml(driver.name)}</div><div class="detail-sub">Member since ${escapeHtml(driver.memberSince)}</div></div></div></td>
                <td><div class="detail-main">${escapeHtml(driver.vehicle || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(driver.plate || '—')}${driver.motorcycleModel ? ` · ${escapeHtml(driver.motorcycleModel)}` : ''}</div></td>
                <td style="white-space:nowrap;"><div class="rating-stars">${escapeHtml(getDriverPerformanceStars(ratingValue))} <span>${escapeHtml(driver.rating === '—' ? '—' : Number(driver.rating).toFixed(1))}</span></div><div class="detail-sub">${escapeHtml(Number(driver.totalRides || 0))} completed ${Number(driver.totalRides || 0) === 1 ? 'ride' : 'rides'} · ${escapeHtml(driver.acceptanceRate || '—')} acceptance</div></td>
                <td>${renderBadge(isSuspended ? 'suspended' : 'active')}${driverRiskFlag(driver)}${driverLicenseFlag(driver)}${suspensionNote}${driverPresenceLine(driver)}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex; gap:6px; flex-wrap:nowrap; justify-content:center;">
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="history-driver" data-id="${escapeHtml(driver.id)}" data-name="${escapeHtml(driver.name)}">Logs</button>
                        ${actionBtn}
                    </div>
                </td>
            </tr>`;
        }).join('');

        bindRowActions(tbody, {
            'history-driver': (ds) => window.openDriverHistoryModal(ds.id, ds.name),
            'reactivate-driver': (ds) => window.reactivateDriver(ds.id, ds.name),
            'ban-driver': (ds) => window.confirmDriverBan(ds.id, ds.name)
        });

        // Clicking anywhere on a row (except its buttons) opens the driver's details.
        if (!tbody.dataset.rowClickBound) {
            tbody.dataset.rowClickBound = '1';
            tbody.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const row = e.target.closest('tr[data-driver-id]');
                if (row && tbody.contains(row)) window.openDriverDetailsModal(row.dataset.driverId);
            });
        }
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
            'Risk (High)': 'risk-desc',
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
        passengerTablePage = 1;
        if (window.allPassengers) renderPassengerTable(window.allPassengers);
    };

    // Like Booking Records: one page of rows at a time.
    const PASSENGERS_PAGE_SIZE = 25;
    let passengerTablePage = 1;

    window.changePassengerPage = function(delta) {
        passengerTablePage += delta;
        renderPassengerTable(window.allPassengers || []);
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
        refreshPassengerDetails();
        const tbody = document.querySelector('#view-passenger-management .data-table tbody');
        if (!tbody) return;
        const paginationEl = document.getElementById('passengerPagination');

        // The Account Status filter applies on every redraw (live updates too).
        const statusFilter = window.passengerMgmtStatusFilter || 'all';
        // Newest sign-up first (those with no sign-up date go last).
        const joined = (p) => (p.memberSinceRaw ? new Date(p.memberSinceRaw).getTime() || 0 : 0);
        const all = (statusFilter === 'all' ? passengers : passengers.filter((p) => String(p.status).toLowerCase() === statusFilter))
            .filter((p) => matchesListSearch([p.name, p.phone, p.email]))
            .slice()
            .sort((a, b) => joined(b) - joined(a));

        if (!all.length) {
            tbody.innerHTML = emptyRow(7, listSearchTerm ? 'No passengers match your search.' : 'No passengers found in Firestore.');
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        const totalPages = Math.max(1, Math.ceil(all.length / PASSENGERS_PAGE_SIZE));
        passengerTablePage = Math.min(Math.max(1, passengerTablePage), totalPages);
        const pageStart = (passengerTablePage - 1) * PASSENGERS_PAGE_SIZE;
        const pageItems = all.slice(pageStart, pageStart + PASSENGERS_PAGE_SIZE);

        tbody.innerHTML = pageItems.map((passengerRecord) => {
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
                : `<button class="action-btn" style="background:#EE5D50;" data-action="ban-passenger" data-id="${escapeHtml(passenger.id)}" data-name="${escapeHtml(passenger.name)}">Suspend</button>`;
            const statusKey = isFlagged ? 'flagged' : (isSuspended ? 'suspended' : 'active');
            let suspensionNote = '';
            if (isSuspended) {
                const untilText = passenger.suspendedUntilRaw ? `Until ${ParaFirestore.formatDateTime(passenger.suspendedUntilRaw)}` : 'Indefinitely';
                const reasonText = passenger.suspensionReason ? ` — ${passenger.suspensionReason}` : '';
                suspensionNote = `<div class="detail-sub" style="margin-top:4px;">${escapeHtml(untilText + reasonText)}</div>`;
            }

            return `<tr class="row-clickable" data-passenger-id="${escapeHtml(passenger.id)}" title="View passenger details">
                <td><div class="detail-main">${escapeHtml(passenger.name)}</div><div class="detail-sub">Member since ${escapeHtml(passenger.memberSince)}</div></td>
                <td><div class="detail-main">${escapeHtml(passenger.phone)}</div><div class="detail-sub">${escapeHtml(passenger.email)}</div></td>
                <td>${escapeHtml(passenger.totalRides)}</td>
                <td>${escapeHtml(passenger.cancelled)}</td>
                <td style="${cancelStyle}">${escapeHtml(passenger.cancelRate)}</td>
                <td>${renderBadge(statusKey)}${suspensionNote}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex; gap:6px; flex-wrap:nowrap; justify-content:center;">
                        <button class="action-btn" style="background:var(--bg-light);color:var(--text-main);" data-action="history-passenger" data-id="${escapeHtml(passenger.id)}" data-name="${escapeHtml(passenger.name)}">Logs</button>
                        ${actionBtn}
                    </div>
                </td>
            </tr>`;
        }).join('');

        if (paginationEl) {
            const rangeEnd = Math.min(all.length, pageStart + PASSENGERS_PAGE_SIZE);
            paginationEl.innerHTML = `
                <span>Showing ${pageStart + 1}–${rangeEnd} of ${all.length}</span>
                <div style="display:flex; gap:8px;">
                    <button class="action-btn" ${passengerTablePage <= 1 ? 'disabled' : ''} onclick="changePassengerPage(-1)">Prev</button>
                    <span style="padding:6px 4px;">Page ${passengerTablePage} of ${totalPages}</span>
                    <button class="action-btn" ${passengerTablePage >= totalPages ? 'disabled' : ''} onclick="changePassengerPage(1)">Next</button>
                </div>
            `;
        }

        bindRowActions(tbody, {
            'history-passenger': (ds) => window.openPassengerHistoryModal(ds.id, ds.name),
            'reactivate-passenger': (ds) => window.reactivatePassenger(ds.id, ds.name),
            'ban-passenger': (ds) => window.confirmPassengerBan(ds.id, ds.name)
        });

        // Clicking anywhere on a row (except its buttons) opens the passenger's details.
        if (!tbody.dataset.rowClickBound) {
            tbody.dataset.rowClickBound = '1';
            tbody.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const row = e.target.closest('tr[data-passenger-id]');
                if (row && tbody.contains(row)) window.openPassengerDetailsModal(row.dataset.passengerId);
            });
        }
    }

    const BOOKINGS_PAGE_SIZE = 25;
    let bookingTablePage = 1;

    window.selectBookingStatus = function(statusKey) {
        const normalizedKey = (statusKey || 'All').toLowerCase().replace(/-/g, '_');
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

    // "Arrived 8:12 AM" / "Dropped off 8:40 AM" line under an address. Empty
    // when the app never recorded that time (e.g. cancelled/declined bookings).
    // If it happened on a different day than the booking, the date is shown too.
    function eventTimeLine(label, eventDate, bookingDate) {
        if (!eventDate || Number.isNaN(new Date(eventDate).getTime())) return '';
        const when = new Date(eventDate);
        const booked = bookingDate ? new Date(bookingDate) : null;
        const sameDay = booked && !Number.isNaN(booked.getTime()) && when.toDateString() === booked.toDateString();
        const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const text = sameDay ? time : `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
        return `<div class="detail-sub" style="margin-top:4px;">${escapeHtml(label)} ${escapeHtml(text)}</div>`;
    }

    // "Cash" / "GCash · Paid" under the fare. A GCash ride is paid through
    // Xendit after the trip (the app's Cloud Function sets paymentStatus to
    // PAID or FAILED), so the status only means something once it's completed.
    function paymentLine(booking) {
        const method = String(booking.paymentMethod || '').toUpperCase();
        if (!method) return '';
        const methodLabel = method === 'GCASH' ? 'GCash' : (method === 'CASH' ? 'Cash' : method);
        let statusLabel = '';
        if (method === 'GCASH' && ParaFirestore.normalizeStatus(booking.status) === 'completed') {
            const labels = { paid: 'Paid', pending: 'Payment pending', failed: 'Payment failed' };
            statusLabel = labels[ParaFirestore.normalizeStatus(booking.paymentStatus)] || '';
        }
        const color = statusLabel === 'Payment failed' ? 'color:#EE5D50;' : '';
        return `<div class="detail-sub" style="margin-top:2px; ${color}">${escapeHtml(statusLabel ? `${methodLabel} · ${statusLabel}` : methodLabel)}</div>`;
    }

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

    // ── Trip location checks ─────────────────────────────────────
    // The app saves where the driver was at Arrived / Start ride / End ride. A
    // ride ended more than 300 m from the destination is flagged endedEarly.
    // Most are harmless (the passenger asked to get off), so it shows as a note
    // under the booking's status and in the trip window, where it can be reviewed.

    // Straight-line distance in metres between two {lat, lng} points, or null
    // when either has no location.
    function distanceM(a, b) {
        if (!a || !b) return null;
        const R = 6371000;
        const rad = (d) => (d * Math.PI) / 180;
        const dLat = rad(b.lat - a.lat);
        const dLng = rad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function fmtDistance(meters) {
        if (meters === null || meters === undefined) return 'Not recorded';
        return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
    }

    function timeOf(date) {
        const t = date ? new Date(date).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
    }

    // Complaints filed about this ride (a complaint stores the booking's id or ref).
    function complaintsForBooking(booking) {
        return allComplaints.filter((c) => c.bookingId && (c.bookingId === booking.id || c.bookingId === booking.ref));
    }

    function renderBookingTable(bookings) {
        const tbody = document.querySelector('#view-bookings .data-table tbody');
        if (!tbody) return;

        window.allBookings = Array.isArray(bookings) ? bookings : [];
        refreshTripModal();

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

        list = list.filter((b) => matchesListSearch([b.ref, b.id, b.driverName, b.plate, b.passengerName, b.pickupLocation, b.dropoffLocation, b.status]));

        const paginationEl = document.getElementById('bookingPagination');

        if (!list.length) {
            tbody.innerHTML = emptyRow(8, listSearchTerm ? 'No bookings match your search.' : 'No bookings found in Firestore.');
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
            <tr class="row-clickable" data-booking-id="${escapeHtml(booking.id)}" title="View trip details">
                <td><div class="book-id">${escapeHtml(booking.ref)}</div><div class="book-time">${escapeHtml(booking.relativeTime)}</div></td>
                <td>${renderBadge(booking.status)}</td>
                <td style="font-size:13px;">${escapeHtml(booking.dateLabel)}</td>
                <td><div class="detail-main">${escapeHtml(booking.driverName || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(booking.plate)}</div></td>
                <td>${escapeHtml(booking.passengerName || '—')}</td>
                <td style="max-width:190px; font-size:13px; line-height:1.4;">${escapeHtml(booking.pickupLocation)}${eventTimeLine('Arrived', booking.arrivedAtRaw, booking.createdAtRaw)}</td>
                <td style="max-width:190px; font-size:13px; line-height:1.4;">${escapeHtml(booking.dropoffLocation)}${eventTimeLine('Dropped off', booking.completedAtRaw, booking.createdAtRaw)}</td>
                <td><div style="color:${fareColor(booking.status)}; font-weight:600;">&#8369;${escapeHtml(Number(booking.totalFare || 0).toFixed(2))}</div>${paymentLine(booking)}</td>
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

    // Booking Records: a click on a row opens the trip.
    (function bindBookingRecords() {
        const tbody = document.querySelector('#view-bookings .data-table tbody');
        tbody?.addEventListener('click', (e) => {
            const row = e.target.closest('tr[data-booking-id]');
            if (row && tbody.contains(row)) window.openTripModal(row.dataset.bookingId);
        });
    })();

    const bookingDatePicker = document.getElementById('bookingDatePicker');
    if (bookingDatePicker) {
        bookingDatePicker.addEventListener('change', () => {
            bookingTablePage = 1;
            if (window.allBookings) {
                renderBookingTable(window.allBookings);
            }
        });
    }

    // ── Trip details window ──────────────────────────────────────
    // One booking with where the driver was at each step, a map of the pins,
    // any complaints about it, and the two admin actions that come from the
    // trip checks: reviewing an early drop-off and reversing a no-show.
    const ARRIVE_LIMIT_M = 150; // the app only allows "Arrived" within this distance of the pickup
    const TRIP_PINS = [
        { key: 'pickupLatLng', label: 'Pickup pin', color: '#05CD99' },
        { key: 'arrivedLatLng', label: 'Driver arrived here', color: '#1A73E8' },
        { key: 'startedLatLng', label: 'Ride started here', color: '#7551FF' },
        { key: 'destinationLatLng', label: 'Destination pin', color: '#EE5D50' },
        { key: 'completedLatLng', label: 'Ended here', color: '#FF9E2A' }
    ];
    let tripBookingId = null;
    let tripMap = null;
    let tripMapKey = '';
    let tripReviewKey = '';

    function tripBooking() {
        return (window.allBookings || []).find((b) => b.id === tripBookingId) || null;
    }

    function tripPassenger(booking) {
        return (window.allPassengers || []).find((p) => p.id === booking.passengerId) || null;
    }

    function tripClockTime(date) {
        return date && !Number.isNaN(new Date(date).getTime())
            ? new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : '';
    }

    // "8:12 AM · 40 m from the pickup" / "… · location not recorded".
    function tripStepValue(time, point, reference, referenceLabel) {
        const when = tripClockTime(time);
        if (!when && !point) return '';
        const where = point
            ? (reference ? `${fmtDistance(distanceM(point, reference))} from the ${referenceLabel}` : 'location recorded')
            : 'location not recorded';
        return [when, where].filter(Boolean).join(' · ');
    }

    function renderTripBanners(booking) {
        const out = [];
        const status = ParaFirestore.normalizeStatus(booking.status);
        if (booking.endedEarly) {
            const away = fmtDistance(distanceM(booking.completedLatLng, booking.destinationLatLng));
            if (booking.earlyEndReviewedAtRaw) {
                out.push(`<div class="vf-dup muted"><strong>Ended early — reviewed ${escapeHtml(ParaFirestore.formatDateTime(booking.earlyEndReviewedAtRaw))}.</strong> The ride ended ${escapeHtml(away)} from the destination.${booking.earlyEndReviewNote ? ` Note: “${escapeHtml(booking.earlyEndReviewNote)}”` : ''}</div>`);
            } else {
                out.push(`<div class="vf-dup warn"><strong>Ended early.</strong> The driver ended this ride ${escapeHtml(away)} from the destination. Most are harmless (the passenger asked to get off) — look for patterns or a complaint about this ride.</div>`);
            }
        }
        if (status === 'no_show') {
            const away = distanceM(booking.arrivedLatLng, booking.pickupLatLng);
            const at = tripClockTime(booking.arrivedAtRaw);
            let text;
            let tone = 'warn';
            if (away === null) {
                text = 'The driver’s arrival location is not recorded (bookings made before this update don’t have one).';
            } else if (away > ARRIVE_LIMIT_M) {
                tone = 'block';
                text = `The driver tapped Arrived ${fmtDistance(away)} from the pickup${at ? ` at ${at}` : ''}. The app only allows Arrived within ${ARRIVE_LIMIT_M} m, so check this one.`;
            } else {
                text = `The driver tapped Arrived ${fmtDistance(away)} from the pickup${at ? ` at ${at}` : ''}, within the ${ARRIVE_LIMIT_M} m the app requires.`;
            }
            out.push(`<div class="vf-dup ${tone}"><strong>No-show.</strong> ${escapeHtml(text)}</div>`);
        }
        return out.join('');
    }

    function renderTripCards(booking) {
        const passenger = tripPassenger(booking);
        const arrived = tripStepValue(booking.arrivedAtRaw, booking.arrivedLatLng, booking.pickupLatLng, 'pickup');
        const started = tripStepValue(booking.startedAtRaw, booking.startedLatLng, booking.pickupLatLng, 'pickup');
        const dropped = tripStepValue(booking.completedAtRaw, booking.completedLatLng, booking.destinationLatLng, 'destination');
        return `<div class="dd-cards">
            <div class="dd-card">
                <div class="dd-card-title">People</div>
                ${ddRow('Passenger', booking.passengerName)}
                ${ddRow('Driver', booking.driverName)}
                ${ddRow('TODA', booking.driverTodaName)}
                ${ddRow('Plate number', booking.plate === '—' ? '' : booking.plate)}
            </div>
            <div class="dd-card">
                <div class="dd-card-title">Fare</div>
                ${ddRow('Fare', `₱${Number(booking.totalFare || 0).toFixed(2)}`)}
                ${booking.hasServiceFee ? ddRow('Service fee', `₱${booking.serviceFee.toFixed(2)}<div class="dd-row-sub">(PARA ₱${booking.paraShare.toFixed(2)} · driver ₱${booking.driverShare.toFixed(2)} · TODA ₱${booking.todaShare.toFixed(2)})</div>`, { html: true }) : ''}
                ${booking.hasServiceFee ? ddRow('Passenger paid', `₱${booking.amountPaid.toFixed(2)}`) : ''}
                ${ddRow('Payment', [booking.paymentMethod, booking.paymentStatus && String(booking.paymentStatus).toUpperCase()].filter(Boolean).join(' · '))}
                ${ddRow('Booked on', booking.createdAtRaw ? ParaFirestore.formatDateTime(booking.createdAtRaw) : '')}
                ${passenger && ParaFirestore.normalizeStatus(booking.status) === 'no_show' ? ddRow('Passenger’s no-shows', passenger.noShowCount) : ''}
            </div>
            <div class="dd-card wide">
                <div class="dd-card-title">Route</div>
                ${ddRow('Pickup', booking.pickupLocation === '—' ? '' : booking.pickupLocation)}
                ${ddRow('Destination', booking.dropoffLocation === '—' ? '' : booking.dropoffLocation)}
            </div>
            <div class="dd-card wide">
                <div class="dd-card-title">Location checks</div>
                ${ddRow('Driver arrived', arrived || 'Not recorded')}
                ${ddRow('Ride started', started || 'Not recorded')}
                ${ddRow('Dropped off', dropped || 'Not recorded')}
            </div>
        </div>`;
    }

    function renderTripComplaints(booking) {
        const complaints = complaintsForBooking(booking);
        if (!complaints.length) return '';
        return `<div class="vf-block-title" style="margin:20px 0 10px;">Complaints about this ride</div>
            <div class="table-container"><table class="data-table">
                <thead><tr><th>Case</th><th>Issue</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${complaints.map((c) => `<tr>
                    <td><div class="book-id">${escapeHtml(c.ref)}</div><div class="book-time">${escapeHtml(ParaFirestore.formatDateTime(c.createdAtRaw))}</div></td>
                    <td><div class="detail-main">${escapeHtml(c.issue)}</div><div class="detail-sub">${escapeHtml(c.description)}</div></td>
                    <td>${complaintBadge(c.status)}</td>
                    <td><button class="action-btn" data-trip-case="${escapeHtml(c.id)}">View Case</button></td>
                </tr>`).join('')}</tbody>
            </table></div>`;
    }

    // The note box is only rebuilt when the review state changes, so what the
    // admin is typing survives the live refresh.
    function renderTripReview(booking) {
        const box = document.getElementById('trip-review');
        const key = `${booking.id}|${booking.endedEarly}|${Boolean(booking.earlyEndReviewedAtRaw)}`;
        if (!box || key === tripReviewKey) return;
        tripReviewKey = key;
        box.innerHTML = booking.endedEarly && !booking.earlyEndReviewedAtRaw
            ? `<div class="form-group" style="margin-top:20px;"><label>Review note (optional)</label><textarea id="trip-review-note" class="form-input" rows="2" placeholder="e.g. Passenger confirmed they asked to get off at the market."></textarea></div>`
            : '';
    }

    // The trip map is Google Maps, like the app. The key is in google-maps-config.js
    // (window.GOOGLE_MAPS_API_KEY); the Maps script is only fetched when a trip map
    // is first opened. When there is no key, or Google refuses it (wrong website
    // address, billing off), the pins fall back to Leaflet on Esri's public street
    // map, which needs no key, so the trip's locations are still visible.
    const TRIP_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
    const TRIP_TILE_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, OpenStreetMap contributors';

    let googleMapsPromise = null;
    let googleMapsBroken = false;

    function loadGoogleMaps() {
        if (window.google && window.google.maps) return Promise.resolve();
        if (googleMapsPromise) return googleMapsPromise;
        googleMapsPromise = new Promise((resolve, reject) => {
            window.__paraGoogleMapsReady = resolve;
            // Google calls this when the key is rejected.
            window.gm_authFailure = () => {
                console.error('Google Maps refused the API key (check the allowed website addresses, the enabled API and billing).');
                googleMapsBroken = true;
                const booking = tripBooking();
                if (booking) { tripMapKey = ''; renderTripMap(booking); }
            };
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(window.GOOGLE_MAPS_API_KEY)}&v=weekly&callback=__paraGoogleMapsReady`;
            script.async = true;
            script.onerror = () => { googleMapsPromise = null; reject(new Error('The Google Maps script could not be loaded.')); };
            document.head.appendChild(script);
        });
        return googleMapsPromise;
    }

    function clearTripMap() {
        if (tripMap) { tripMap.remove(); tripMap = null; }
        document.getElementById('trip-map').innerHTML = '';
    }

    function drawGoogleTripMap(container, points, line) {
        container.innerHTML = '';
        const map = new google.maps.Map(container, {
            center: { lat: points[0].lat, lng: points[0].lng },
            zoom: 15,
            gestureHandling: 'cooperative',
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            clickableIcons: false
        });
        if (line) {
            new google.maps.Polyline({
                map,
                path: line,
                strokeOpacity: 0,
                icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#A3AED0', scale: 2 }, offset: '0', repeat: '12px' }]
            });
        }
        const bounds = new google.maps.LatLngBounds();
        points.forEach(({ pin, lat, lng }, index) => {
            bounds.extend({ lat, lng });
            new google.maps.Marker({
                map,
                position: { lat, lng },
                title: pin.label,
                zIndex: index,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: pin.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
            });
        });
        const fit = () => {
            map.fitBounds(bounds, 36);
            // One pin (or pins on top of each other) would zoom in all the way.
            google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 17) map.setZoom(17); });
        };
        fit();
        // The window is still fading in, so the map has to re-measure itself.
        setTimeout(() => { google.maps.event.trigger(map, 'resize'); fit(); }, 260);
    }

    function drawLeafletTripMap(container, points, line) {
        if (!window.L) {
            container.innerHTML = '<div class="vf-tile-empty">The map could not be loaded.</div>';
            return;
        }
        tripMap = L.map(container, { scrollWheelZoom: false });
        L.tileLayer(TRIP_TILE_URL, { maxZoom: 19, attribution: TRIP_TILE_ATTRIBUTION }).addTo(tripMap);
        if (line) {
            L.polyline(line.map((point) => [point.lat, point.lng]), { color: '#A3AED0', weight: 2, dashArray: '6 6' }).addTo(tripMap);
        }
        const latLngs = points.map(({ pin, lat, lng }) => {
            L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 2, fillColor: pin.color, fillOpacity: 1 }).addTo(tripMap).bindTooltip(pin.label);
            return [lat, lng];
        });
        tripMap.fitBounds(latLngs, { padding: [36, 36], maxZoom: 17 });
        setTimeout(() => { if (tripMap) { tripMap.invalidateSize(); tripMap.fitBounds(latLngs, { padding: [36, 36], maxZoom: 17 }); } }, 260);
    }

    function renderTripMap(booking) {
        const wrap = document.getElementById('trip-map-wrap');
        const empty = document.getElementById('trip-map-empty');
        const pins = TRIP_PINS.filter((pin) => booking[pin.key]);
        const key = `${booking.id}|${pins.map((pin) => `${pin.key}:${booking[pin.key].lat},${booking[pin.key].lng}`).join(';')}`;
        if (key === tripMapKey) return;
        tripMapKey = key;
        clearTripMap();

        if (!pins.length) {
            wrap.style.display = 'none';
            empty.style.display = '';
            return;
        }
        wrap.style.display = '';
        empty.style.display = 'none';

        const legend = document.getElementById('trip-legend');
        legend.innerHTML = pins.map((pin) => `<span class="trip-legend-item"><i style="background:${pin.color};"></i>${escapeHtml(pin.label)}</span>`).join('');

        const container = document.getElementById('trip-map');
        const points = pins.map((pin) => ({ pin, lat: booking[pin.key].lat, lng: booking[pin.key].lng }));
        const line = booking.pickupLatLng && booking.destinationLatLng
            ? [{ lat: booking.pickupLatLng.lat, lng: booking.pickupLatLng.lng }, { lat: booking.destinationLatLng.lat, lng: booking.destinationLatLng.lng }]
            : null;

        if (!window.GOOGLE_MAPS_API_KEY || googleMapsBroken) {
            drawLeafletTripMap(container, points, line);
            return;
        }
        container.innerHTML = '<div class="vf-tile-empty">Loading map…</div>';
        loadGoogleMaps().then(() => {
            if (tripMapKey !== key) return; // another trip was opened meanwhile
            drawGoogleTripMap(container, points, line);
        }).catch((error) => {
            console.error('Google Maps failed to load:', error);
            googleMapsBroken = true;
            if (tripMapKey === key) { tripMapKey = ''; renderTripMap(booking); }
        });
    }

    function renderTripModal() {
        const booking = tripBooking();
        if (!booking) return;
        const status = ParaFirestore.normalizeStatus(booking.status);
        document.getElementById('trip-title').textContent = `Trip ${booking.ref}`;
        document.getElementById('trip-meta').innerHTML = renderBadge(booking.status)
            + (booking.endedEarly ? renderBadge(booking.earlyEndReviewedAtRaw ? 'resolved' : 'pending', booking.earlyEndReviewedAtRaw ? 'ENDED EARLY · REVIEWED' : 'ENDED EARLY') : '')
            + (booking.createdAtRaw ? `<span>${escapeHtml(ParaFirestore.formatDateTime(booking.createdAtRaw))}</span>` : '');
        document.getElementById('trip-banners').innerHTML = renderTripBanners(booking);
        document.getElementById('trip-cards').innerHTML = renderTripCards(booking);
        document.getElementById('trip-complaints').innerHTML = renderTripComplaints(booking);
        renderTripReview(booking);

        const reviewBtn = document.getElementById('tripReviewBtn');
        if (reviewBtn) reviewBtn.style.display = booking.endedEarly && !booking.earlyEndReviewedAtRaw ? '' : 'none';

        const reverseBtn = document.getElementById('tripReverseBtn');
        if (reverseBtn) {
            const passenger = tripPassenger(booking);
            reverseBtn.style.display = status === 'no_show' ? '' : 'none';
            let blocked = '';
            if (!passenger) blocked = 'The passenger account was not found.';
            else if (passenger.reversedNoShows.includes(booking.id)) blocked = 'This no-show was already reversed.';
            else if (passenger.noShowCount <= 0) blocked = 'This passenger has no no-shows on record.';
            reverseBtn.disabled = Boolean(blocked);
            reverseBtn.title = blocked;
            reverseBtn.textContent = passenger && passenger.reversedNoShows.includes(booking.id) ? 'No-show reversed' : 'Reverse No-show';
        }
        // Nothing to do on this trip -> no empty footer bar.
        const footer = document.getElementById('trip-footer');
        if (footer) footer.style.display = (reviewBtn && reviewBtn.style.display !== 'none') || (reverseBtn && reverseBtn.style.display !== 'none') ? '' : 'none';
    }

    // Called whenever bookings, passengers or complaints refresh.
    function refreshTripModal() {
        const modal = document.getElementById('tripModal');
        if (!tripBookingId || !modal || !modal.classList.contains('active')) return;
        const booking = tripBooking();
        if (!booking) return;
        renderTripModal();
        renderTripMap(booking);
    }

    window.openTripModal = function(bookingId) {
        tripBookingId = bookingId;
        if (!tripBooking()) return;
        tripMapKey = '';
        tripReviewKey = '';
        renderTripModal();
        document.getElementById('tripModal').classList.add('active');
        renderTripMap(tripBooking());
    };

    window.markTripReviewed = async function() {
        const booking = tripBooking();
        if (!booking) return;
        const note = (document.getElementById('trip-review-note')?.value || '').trim();
        try {
            await ParaFirestore.markEarlyEndReviewed(booking.id, note);
            closeModal('tripModal');
            window.showToast('Trip marked as reviewed.', 'success');
        } catch (error) {
            window.showToast('Could not mark the trip as reviewed.', 'error');
            console.error(error);
        }
    };

    window.reverseNoShowFromTrip = function() {
        const booking = tripBooking();
        const passenger = booking ? tripPassenger(booking) : null;
        if (!booking || !passenger) return;
        showConfirmModal(
            `Reverse this no-show?`,
            `${passenger.name || 'The passenger'}’s no-show count goes down by 1 (now ${passenger.noShowCount}). This can only be done once for this trip.`,
            'Reverse No-show',
            '#1A73E8',
            async () => {
                try {
                    await ParaFirestore.reverseNoShow(passenger.id, booking.id);
                    ParaFirestore.logPassengerAction(passenger.id, passenger.name, 'No-show Reversal', `Trip ${booking.ref}`).catch((error) => console.error('Failed to log passenger action:', error));
                    window.showToast('No-show reversed.', 'success');
                } catch (error) {
                    window.showToast(error && error.message ? error.message : 'Could not reverse the no-show.', 'error');
                    console.error(error);
                }
            }
        );
    };

    document.getElementById('c-trip-line')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-case-trip]');
        if (btn) window.openTripModal(btn.dataset.caseTrip);
    });

    document.getElementById('tripModal')?.addEventListener('click', (e) => {
        const caseBtn = e.target.closest('[data-trip-case]');
        if (!caseBtn) return;
        closeModal('tripModal');
        window.openComplaintModal(caseBtn.dataset.tripCase);
    });

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

    // The Status filter, then whatever is typed in the top-bar search box (case
    // number, passenger, driver, issue, description or trip).
    function getComplaintsForFilter(filterKey) {
        const key = (filterKey || 'all').toLowerCase();
        let list = allComplaints;
        if (key === 'pending') list = allComplaints.filter((c) => ['pending', 'reviewing'].includes(c.status));
        else if (key === 'warned') list = allComplaints.filter(wasWarnedByAdmin);
        else if (key === 'resolved') list = allComplaints.filter((c) => c.status === 'resolved');
        else if (key === 'dismissed') list = allComplaints.filter((c) => c.status === 'rejected');
        return listSearchTerm
            ? list.filter((c) => matchesListSearch([c.ref, c.id, c.reporter, c.reported, c.issue, c.description, c.tripRef]))
            : list;
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

    const COMPLAINTS_PAGE_SIZE = 25;
    let complaintTablePage = 1;

    window.changeComplaintPage = function(delta) {
        complaintTablePage += delta;
        renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));
    };

    // The "Driver Risk Score" block in the case window: the stored score for the
    // reported driver, what it suggests, why, and how it compares with the
    // TODA president's recommendation.
    function renderCaseRisk(complaint) {
        const box = document.getElementById('c-risk-box');
        if (!box || !complaint) return;
        const risk = riskOf(complaint.driverId);
        if (!risk) {
            box.innerHTML = '<div class="risk-note" style="margin-top:0;">Not scored yet — treated as LOW.</div>';
            return;
        }
        // Only a recommended suspension is compared with the score; a "further
        // review" request names no penalty.
        box.innerHTML = riskBodyHtml(risk, suspensionRecommendationsFor(complaint).some((a) => a.actionType === 'Suspension'));
    }

    window.setComplaintFilter = function(statusKey) {
        const normalizedKey = (statusKey || 'all').toLowerCase();
        window.complaintMgmtStatusFilter = normalizedKey;
        complaintTablePage = 1;
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

        // Cases still waiting on the admin stay on top; once one is closed it drops
        // below them. Newest first within each group.
        const isOpen = (c) => ['pending', 'reviewing'].includes(c.status);
        const sortedComplaints = [...(complaints || [])].sort((a, b) => {
            const timeA = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : (a.createdAt instanceof Date ? a.createdAt.getTime() : 0);
            const timeB = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : (b.createdAt instanceof Date ? b.createdAt.getTime() : 0);
            return (isOpen(b) - isOpen(a)) || timeB - timeA;
        });

        const paginationEl = document.getElementById('complaintPagination');
        if (!sortedComplaints.length) {
            tbody.innerHTML = emptyRow(5, listSearchTerm ? 'No complaints match your search.' : 'No complaints found in Firestore.');
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        // One page of rows at a time, like Booking Records.
        const totalPages = Math.max(1, Math.ceil(sortedComplaints.length / COMPLAINTS_PAGE_SIZE));
        complaintTablePage = Math.min(Math.max(1, complaintTablePage), totalPages);
        const pageStart = (complaintTablePage - 1) * COMPLAINTS_PAGE_SIZE;
        const pageItems = sortedComplaints.slice(pageStart, pageStart + COMPLAINTS_PAGE_SIZE);

        tbody.innerHTML = pageItems.map((complaint) => `
            <tr>
                <td><div class="book-id">${escapeHtml(complaint.ref)}</div><div class="book-time">Reporter: ${escapeHtml(complaint.reporter)}</div></td>
                <td><div class="detail-main">${escapeHtml(complaint.reported)} ${riskChipHtml(riskOf(complaint.driverId))}</div><div class="detail-sub">Trip: ${escapeHtml(complaint.tripRef)}</div></td>
                <td><div class="detail-main">${escapeHtml(complaint.issue)}</div><div class="detail-sub">${escapeHtml(complaint.description)}</div></td>
                <td>${complaintBadge(complaint.status)}${openRecommendationLabel(complaint)}${wasSuspendedByAdmin(complaint) ? '<div class="detail-sub" style="margin-top:6px; color:#EE5D50; font-weight:600;">Driver suspended</div>' : ''}${wasWarnedByAdmin(complaint) ? '<div class="detail-sub" style="margin-top:6px; color:#E08A00; font-weight:600;">Warning issued</div>' : ''}</td>
                <td><button class="action-btn" data-action="view-complaint" data-id="${escapeHtml(complaint.id)}">View Case</button></td>
            </tr>
        `).join('');

        if (paginationEl) {
            const rangeEnd = Math.min(sortedComplaints.length, pageStart + COMPLAINTS_PAGE_SIZE);
            paginationEl.innerHTML = `
                <span>Showing ${pageStart + 1}–${rangeEnd} of ${sortedComplaints.length}</span>
                <div style="display:flex; gap:8px;">
                    <button class="action-btn" ${complaintTablePage <= 1 ? 'disabled' : ''} onclick="changeComplaintPage(-1)">Prev</button>
                    <span style="padding:6px 4px;">Page ${complaintTablePage} of ${totalPages}</span>
                    <button class="action-btn" ${complaintTablePage >= totalPages ? 'disabled' : ''} onclick="changeComplaintPage(1)">Next</button>
                </div>
            `;
        }

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
                // New applications plus photo changes waiting for review.
                const waitingForReview = (counts.pendingDrivers || 0) + (counts.pendingPhotoChanges || 0);
                driverBadge.textContent = waitingForReview || '';
                driverBadge.classList.toggle('hidden', !waitingForReview);
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

    // "Oct 10, 2026" with the time on a line under it, so the column stays narrow
    // and every row lines up the same way.
    function createdCellHtml(value) {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '<span class="detail-sub">—</span>';
        return `<div class="detail-main" style="font-size:13px;">${escapeHtml(date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }))}</div>`
            + `<div class="detail-sub">${escapeHtml(date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }))}</div>`;
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
                <td style="white-space:nowrap;">${createdCellHtml(account.createdAt)}</td>
                <td style="white-space:nowrap;">
                  <div style="display:flex; gap:6px; flex-wrap:nowrap; justify-content:center;">
                    <button class="action-btn" data-action="edit-toda-president" data-id="${escapeHtml(account.id)}">Edit</button>
                    <button class="action-btn" style="background:${account.status === 'disabled' ? '#05CD99' : '#EE5D50'};" data-action="toggle-toda-president" data-id="${escapeHtml(account.id)}" data-name="${escapeHtml(account.fullName || account.name || 'this account')}" data-next-status="${account.status === 'disabled' ? 'active' : 'disabled'}">${account.status === 'disabled' ? 'Reactivate' : 'Disable'}</button>
                  </div>
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
            // Left unset on purpose: an empty list would count as "no TODA is
            // registered" and zero out every revenue figure.
            console.error('Failed to load TODA President accounts:', error);
            renderTodaPresidentAccounts([]);
        }
        // Only rides under a registered TODA count toward revenue, so redraw every
        // chart, card and report that shows it.
        if (typeof window.renderDashboardCharts === 'function' && window.dashboardBookings) window.renderDashboardCharts(window.dashboardBookings);
    }

    async function loadFareSettings() {
        try {
            const fare = await ParaFirestore.getFareSettings();
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.value = value;
            };
            setValue('fare-min', fare.minimumFare);
            setValue('fare-included', fare.includedDistanceKm);
            setValue('fare-perkm', fare.perKmRate);
            setValue('fare-fee-para', fare.serviceFeeParaPct);
            setValue('fare-fee-driver', fare.serviceFeeDriverPct);
            setValue('fare-fee-toda', fare.serviceFeeTodaPct);
            setValue('fare-tide-from', fare.tideSurchargeFromFt);
            setValue('fare-tide-fee', fare.tideSurchargeFee);
            setValue('fare-tide-high', fare.tideSurchargeHighFt);
            setValue('fare-tide-high-fee', fare.tideSurchargeHighFee);
            // The dashboard and reports estimate earnings from the SAVED percentages.
            window.serviceFeeSettings = { paraPct: fare.serviceFeeParaPct, driverPct: fare.serviceFeeDriverPct, todaPct: fare.serviceFeeTodaPct };
            if (typeof window.updateDashboardDateCards === 'function') window.updateDashboardDateCards(window.currentDashboardDateFilter || 'Today');
            if (typeof window.refreshReportsFees === 'function') window.refreshReportsFees();
            const lastUpdatedEl = document.getElementById('fareLastUpdated');
            if (lastUpdatedEl) {
                lastUpdatedEl.textContent = fare.updatedAtRaw
                    ? `Last updated ${ParaFirestore.formatDateTime(fare.updatedAtRaw)}`
                    : 'Showing the default fares. Press Save once so the app and the database rules use these numbers.';
            }
            if (typeof updateFarePreview === 'function') updateFarePreview();
        } catch (error) {
            console.error('Failed to load fare settings:', error);
        }
    }

    // ── Profile photo in the review window ───────────────────────
    // The driver who registered is asked for a photo. The admin's face-vs-ID
    // check is the only safeguard that it's real, so Approve stays off until
    // there is a photo that hasn't been rejected and the checklist is ticked.
    let currentVerificationDriver = null;
    let verificationDuplicateBlocking = false;

    const PHOTO_STATUS_LABELS = { pending: 'Under review', approved: 'Approved', rejected: 'Rejected' };

    function approveBlockReason(driver) {
        if (!driver.profileImage) {
            return driver.profilePhotoStatus === 'rejected'
                ? 'The profile photo was rejected — the driver needs to add a new one.'
                : 'The driver hasn’t added a profile photo yet.';
        }
        if (driver.profilePhotoStatus === 'rejected') return 'The profile photo was rejected — the driver needs to add a new one.';
        return '';
    }

    function refreshApproveState() {
        const approveBtn = document.getElementById('verifyApproveBtn');
        const hint = document.getElementById('v-approve-hint');
        const driver = currentVerificationDriver;
        if (!approveBtn || !driver) return;
        // Approve needs a profile photo that hasn't been rejected. The tricycle
        // photo and permit are never required (older drivers don't have them).
        const photoReason = approveBlockReason(driver);
        approveBtn.disabled = verificationDuplicateBlocking || Boolean(photoReason);
        approveBtn.title = verificationDuplicateBlocking ? 'This application matches an approved account' : photoReason;
        if (hint) hint.textContent = currentVerificationFilter === 'pending' ? photoReason : '';
    }

    // Motorcycle model (free text, set with textContent) and the tricycle photo.
    function renderVerificationTricycle(driver) {
        const model = document.getElementById('v-moto-model');
        if (model) model.textContent = driver.motorcycleModel || '—';
        setDocImage('v-tri-link', 'v-tri-img', driver.tricycleImageUrl, 'v-tri-empty');
    }

    function renderVerificationPhoto(driver) {
        const avatar = document.getElementById('v-avatar');
        if (avatar) avatar.innerHTML = driver.profileImage
            ? `<img src="${escapeHtml(driver.profileImage)}" alt="" data-initials="${escapeHtml(driverInitials(driver))}" onerror="this.parentNode.textContent=this.dataset.initials">`
            : escapeHtml(driverInitials(driver));

        const statusEl = document.getElementById('v-photo-status');
        if (statusEl) {
            const parts = [];
            if (driver.profilePhotoStatus && PHOTO_STATUS_LABELS[driver.profilePhotoStatus]) parts.push(PHOTO_STATUS_LABELS[driver.profilePhotoStatus]);
            if (driver.profileImage && driver.profilePhotoUpdatedAtRaw) parts.push(`uploaded ${ParaFirestore.formatDateTime(driver.profilePhotoUpdatedAtRaw)}`);
            if (driver.profilePhotoStatus === 'rejected' && driver.profilePhotoRejectReason) parts.push(driver.profilePhotoRejectReason);
            statusEl.textContent = parts.join(' · ') || 'No photo yet';
        }

        setDocImage('v-photo-link', 'v-photo-img', driver.profileImage, 'v-photo-empty');
        const empty = document.getElementById('v-photo-empty');
        if (empty && !driver.profileImage) {
            empty.textContent = driver.profilePhotoStatus === 'rejected' ? 'Photo rejected — waiting for a new one' : 'No profile photo';
        }
    }

    // A license that has expired (or is about to) is flagged at the top of the
    // review. It doesn't block approval — that stays the admin's call.
    function renderExpiryNotice(driver) {
        const box = document.getElementById('v-expiry-box');
        if (!box) return;
        const info = licenseExpiryInfo(driver);
        if (info.status !== 'expired' && info.status !== 'soon') {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        box.className = `vf-dup ${info.status === 'expired' ? 'block' : 'warn'}`;
        box.style.display = '';
        box.innerHTML = info.status === 'expired'
            ? `<strong>The driver’s license has expired.</strong> It was valid until ${escapeHtml(info.dateLabel)} (${escapeHtml(info.text.replace('License expired ', ''))}). Ask for a renewed license before approving.`
            : `<strong>${escapeHtml(info.text)}.</strong> It is valid until ${escapeHtml(info.dateLabel)}.`;
    }

    // The warning at the top of the review window, and the Approve button: off
    // while the application matches an approved account.
    function renderDuplicateNotice(driver) {
        const box = document.getElementById('v-duplicate-box');
        const duplicates = findDuplicates(driver);
        const blocking = duplicates.some((d) => d.blocking);
        verificationDuplicateBlocking = blocking;
        refreshApproveState();
        if (!box) return;
        if (!duplicates.length) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        const statusLabel = (d) => d.other.verificationStatus.charAt(0).toUpperCase() + d.other.verificationStatus.slice(1);
        const items = duplicates.map((d) => `<li><strong>${escapeHtml(d.other.name || 'Unnamed driver')}</strong> (${escapeHtml(statusLabel(d))}) — same ${escapeHtml(d.fields.join(', '))}</li>`).join('');
        box.className = `vf-dup ${blocking ? 'block' : 'warn'}`;
        box.style.display = '';
        box.innerHTML = blocking
            ? `<strong>Duplicate account — approval is blocked.</strong> This application matches a driver who is already approved. Reject it, or sort out the duplicate first.<ul>${items}</ul>`
            : `<strong>Check before approving.</strong> This application shares details with another account.<ul>${items}</ul>`;
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

            document.getElementById('v-lic-expiry').textContent = mapped.licenseExpiry || '—';
            document.getElementById('v-gov-no').textContent = mapped.governmentId || '—';
            document.getElementById('v-reg-date').textContent = mapped.vehicleRegistrationDate || '—';
            const request = mapped.infoRequest;
            const requestNote = !request ? ''
                : request.submittedAt
                    ? `<span>Requested documents resubmitted ${escapeHtml(ParaFirestore.formatDateTime(Number(request.submittedAt)))}</span>`
                    : `<span>Waiting for: ${escapeHtml((request.documents || []).join(', ') || 'documents')}</span>`;
            document.getElementById('v-meta').innerHTML = renderBadge(mapped.verificationStatus)
                + (mapped.submittedAt && mapped.submittedAt !== '—' ? `<span>Submitted ${escapeHtml(mapped.submittedAt)}</span>` : '')
                + requestNote;

            loadVerificationDocuments(mapped);

            // "View Details" (Approved/Rejected tabs) is read-only — only a pending
            // application should expose Approve/Reject/Request Info, so browsing an
            // already-decided driver can't accidentally flip their status.
            const isPending = currentVerificationFilter === 'pending';
            ['verifyRejectBtn', 'verifyRequestInfoBtn', 'verifyApproveBtn'].forEach((id) => {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = isPending ? '' : 'none';
            });
            currentVerificationDriver = mapped;
            renderVerificationPhoto(mapped);
            renderVerificationTricycle(mapped);
            renderExpiryNotice(mapped);
            renderDuplicateNotice(mapped);

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
    // Latest approval / rejection logged for each driver (see logDriverAction).
    const verificationDecisions = new Map();

    function timeValue(date) {
        return date && date.getTime ? date.getTime() : 0;
    }

    // "Photo Changes": an approved driver replaced their profile photo and it
    // waits for the admin. (A brand-new driver's photo is checked in their
    // application instead.)
    const inVerificationTab = (driver, tab) => (tab === 'photos'
        ? driver.verificationStatus === 'approved' && driver.profilePhotoStatus === 'pending'
        : driver.verificationStatus === tab);

    function applyVerificationFilter() {
        ['pending', 'approved', 'rejected', 'photos'].forEach((tab) => {
            const el = document.getElementById(`vf-count-${tab}`);
            if (el) el.textContent = allDrivers.filter((d) => inVerificationTab(d, tab)).length;
        });
        document.querySelectorAll('#verificationTabs .vf-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.status === currentVerificationFilter);
        });

        const filtered = allDrivers.filter((d) => inVerificationTab(d, currentVerificationFilter));

        if (currentVerificationFilter === 'photos') {
            // Oldest upload first.
            filtered.sort((a, b) => timeValue(a.profilePhotoUpdatedAtRaw) - timeValue(b.profilePhotoUpdatedAtRaw));
        } else if (currentVerificationFilter === 'pending') {
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
        syncOpenPhotoWindows();
    }

    // Drivers update live: if the driver uploads a new photo, or the photo is
    // settled somewhere else, while a window is open, bring it up to date.
    function syncOpenPhotoWindows() {
        const review = document.getElementById('verificationModal');
        if (review && review.classList.contains('active') && currentVerificationDriverId) {
            const fresh = allDrivers.find((d) => d.id === currentVerificationDriverId);
            if (fresh && currentVerificationDriver) {
                currentVerificationDriver = { ...currentVerificationDriver, ...fresh };
                renderVerificationPhoto(currentVerificationDriver);
                renderVerificationTricycle(currentVerificationDriver);
                refreshApproveState();
            }
        }
        const queue = document.getElementById('photoReviewModal');
        if (queue && queue.classList.contains('active') && currentPhotoReviewDriverId) {
            const fresh = allDrivers.find((d) => d.id === currentPhotoReviewDriverId);
            if (!fresh || !inVerificationTab(fresh, 'photos')) {
                closeModal('photoReviewModal'); // settled elsewhere
            } else if (fresh.profileImage !== currentPhotoReviewImage) {
                fillPhotoReviewModal(fresh); // the driver uploaded another one
            }
        }
    }

    ParaFirestore.listenDrivers(null, (drivers) => {
        allDrivers = drivers;
        applyVerificationFilter();
    });

    ParaFirestore.listenVerificationDecisions((actions) => {
        verificationDecisions.clear();
        actions
            .filter((a) => a.driverId)
            .sort((a, b) => a.issuedAt - b.issuedAt)
            .forEach((a) => verificationDecisions.set(a.driverId, a)); // newest ends up last
        applyVerificationFilter();
    });

    document.getElementById('verificationTabs')?.addEventListener('click', (e) => {
        const tab = e.target.closest('.vf-tab');
        if (!tab) return;
        currentVerificationFilter = tab.dataset.status;
        applyVerificationFilter();
    });


    // ── Photo review: reject (shared by the application and the queue) ──
    const PHOTO_REJECT_REASONS = [
        'Face not clearly visible',
        'Doesn’t match ID',
        'Sunglasses / cap / mask',
        'Not a real photo of a person',
        'Not a recent photo',
        'Other'
    ];

    // Asks for a reason, rejects the photo (clears it, tells the driver) and
    // logs it. `onDone` runs after it has gone through.
    function promptRejectProfilePhoto(driverId, name, onDone) {
        const options = PHOTO_REJECT_REASONS.map((reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(reason)}</option>`).join('');
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">The photo is removed from the driver’s profile and they’re asked to add a new one.</div>
            <div style="text-align:left;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Reason (sent to the driver)</label>
                <select id="photoRejectReason" class="form-input" style="width:100%; min-height:42px; padding:10px 12px; border:1px solid var(--border-color); border-radius:10px; background:#fff;">${options}</select>
            </div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Details (optional)</label>
                <textarea id="photoRejectNote" class="form-input" rows="2" style="width:100%; resize:vertical;" placeholder="Anything that helps the driver take a better photo"></textarea>
            </div>
        `;
        showConfirmModal(
            `Reject ${name || 'this'} photo?`,
            '',
            'Reject Photo',
            '#EE5D50',
            async () => {
                const choice = document.getElementById('photoRejectReason')?.value || '';
                const note = (document.getElementById('photoRejectNote')?.value || '').trim();
                const reason = choice === 'Other' ? note : [choice, note].filter(Boolean).join(' — ');
                try {
                    await ParaFirestore.rejectProfilePhoto(driverId, reason);
                    ParaFirestore.logDriverAction(driverId, name, 'Photo Rejection', reason).catch((error) => console.error('Failed to log driver action:', error));
                    window.showToast('Profile photo rejected. The driver has been notified.', 'warning');
                    if (onDone) onDone();
                } catch (error) {
                    window.showToast('Failed to reject the photo.', 'error');
                    console.error(error);
                }
            },
            customBodyHtml
        );
    }

    // ── Photo Changes queue ──────────────────────────────────────
    let currentPhotoReviewDriverId = null;
    let currentPhotoReviewImage = '';

    async function fillPhotoReviewModal(driver) {
        currentPhotoReviewDriverId = driver.id;
        currentPhotoReviewImage = driver.profileImage;
        document.getElementById('pr-title').textContent = driver.name || 'Review profile photo';
        document.getElementById('pr-sub').textContent = [
            driver.todaName,
            driver.plate && `Plate ${driver.plate}`,
            driver.profilePhotoUpdatedAtRaw && `Uploaded ${ParaFirestore.formatDateTime(driver.profilePhotoUpdatedAtRaw)}`
        ].filter(Boolean).join(' · ');
        setDocImage('pr-photo-link', 'pr-photo-img', driver.profileImage, 'pr-photo-empty');
        setDocMessage('pr-gov', 'Loading…');
        const { documents, error } = await fetchDriverDocumentUrls(driver);
        if (currentPhotoReviewDriverId !== driver.id) return; // another driver was opened meanwhile
        if (documents.governmentId) setDocImage('pr-gov-link', 'pr-gov-img', documents.governmentId, 'pr-gov-empty');
        else setDocMessage('pr-gov', error ? documentErrorMessage(error) : 'Not uploaded');
    }

    window.openPhotoReviewModal = function(driverId) {
        const driver = allDrivers.find((d) => d.id === driverId);
        if (!driver) return;
        fillPhotoReviewModal(driver);
        document.getElementById('photoReviewModal').classList.add('active');
    };

    window.approveProfilePhotoFromQueue = async function() {
        const driver = allDrivers.find((d) => d.id === currentPhotoReviewDriverId);
        if (!driver) return;
        try {
            await ParaFirestore.approveProfilePhoto(driver.id);
            ParaFirestore.logDriverAction(driver.id, driver.name, 'Photo Approval', '').catch((error) => console.error('Failed to log driver action:', error));
            closeModal('photoReviewModal');
            window.showToast('Profile photo approved.', 'success');
        } catch (error) {
            window.showToast('Failed to approve the photo.', 'error');
            console.error(error);
        }
    };

    window.rejectProfilePhotoFromQueue = function() {
        const driver = allDrivers.find((d) => d.id === currentPhotoReviewDriverId);
        if (!driver) return;
        promptRejectProfilePhoto(driver.id, driver.name, () => closeModal('photoReviewModal'));
    };

    window.approveDriver = function() {
        if (!currentVerificationDriverId) return;
        // Checked again here, against the live list, not just by the disabled button.
        const current = allDrivers.find((d) => d.id === currentVerificationDriverId);
        if (findDuplicates(current).some((d) => d.blocking)) {
            window.showToast('Duplicate account — this driver matches an approved account.', 'error');
            return;
        }
        const photoReason = current ? approveBlockReason(current) : '';
        if (photoReason) {
            window.showToast(photoReason, 'error');
            return;
        }
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

    // Shared by the driver and passenger "Logs" buttons: the account's suspensions
    // and reactivations, newest first. (Warnings, approvals and the TODA president's
    // recommendations are not shown here.)
    const ACCOUNT_LOG_TYPES = ['Suspension', 'Reactivation'];

    async function openActionHistoryModal(name, fetchActions, noneLabel) {
        const titleEl = document.getElementById('driverHistoryTitle');
        const listEl = document.getElementById('driverHistoryList');
        if (titleEl) titleEl.textContent = `${name || 'Record'} — Logs`;
        if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Loading…</div>';
        document.getElementById('driverHistoryModal').classList.add('active');

        try {
            const fromPresident = (action) => action.issuedByRole !== 'ADMIN' && action.issuedBy && action.issuedBy !== user.uid;
            const actions = (await fetchActions()).filter((action) => ACCOUNT_LOG_TYPES.includes(action.actionType) && !fromPresident(action));
            if (!listEl) return;
            if (!actions.length) {
                listEl.innerHTML = `<div style="color:var(--text-muted); font-size:13px;">${escapeHtml(noneLabel)}</div>`;
                return;
            }
            const typeColor = { Suspension: '#EE5D50', Reactivation: '#05CD99' };
            listEl.innerHTML = actions.map((action) => {
                const color = typeColor[action.actionType] || 'var(--text-main)';
                const when = action.issuedAt ? new Date(Number(action.issuedAt)).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

                return `
                    <div style="border:1px solid var(--border-color); border-radius:10px; padding:12px 14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <strong style="color:${color}; font-size:13px;">${escapeHtml(action.actionType)}</strong>
                            <span style="font-size:12px; color:var(--text-muted);">${escapeHtml(when)}</span>
                        </div>
                        ${action.reason ? `<div style="font-size:13px; color:var(--text-main);">${escapeHtml(action.reason)}</div>` : ''}
                    </div>
                `;
            }).join('');
        } catch (error) {
            console.error('Failed to load logs:', error);
            if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Could not load the logs.</div>';
        }
    }

    window.openDriverHistoryModal = function(driverId, name) {
        openActionHistoryModal(name, () => ParaFirestore.fetchDriverActions(driverId), 'No suspensions or reactivations recorded for this driver yet.');
    };
    // ── Driver details window (click a row in Driver Management) ──
    const DD_BOOKINGS_PAGE_SIZE = 8;
    let ddDriver = null;
    let ddTab = 'info';
    let ddBookingPage = 1;
    let ddBookingFilter = 'all';

    // A driver's bookings: the ones carrying their id, plus the driver-declined
    // requests whose driverId the app blanks — matched by plate, same as
    // ParaFirestore.computeDriverStats so the counts agree with the table.
    function bookingsForDriver(driver) {
        const plate = ParaFirestore.normalizePlate(driver.plate);
        return (window.allBookings || []).filter((b) => {
            if (b.driverId) return b.driverId === driver.id;
            const declined = ParaFirestore.normalizeStatus(b.status) === 'declined' && !b.joinRequestExpired;
            return declined && plate && ParaFirestore.normalizePlate(b.plate) === plate;
        }).sort((a, b) => {
            const ta = a.createdAtRaw ? new Date(a.createdAtRaw).getTime() || 0 : 0;
            const tb = b.createdAtRaw ? new Date(b.createdAtRaw).getTime() || 0 : 0;
            return tb - ta;
        });
    }

    function complaintsForDriver(driver) {
        return allComplaints.filter((c) => c.driverId === driver.id).sort((a, b) => {
            const ta = a.createdAtRaw ? new Date(a.createdAtRaw).getTime() || 0 : 0;
            const tb = b.createdAtRaw ? new Date(b.createdAtRaw).getTime() || 0 : 0;
            return tb - ta;
        });
    }

    // One "label ........ value" line inside an info card. `html` values (badges)
    // are passed pre-escaped.
    function ddRow(label, value, { html = false } = {}) {
        const empty = value === undefined || value === null || value === '';
        const shown = empty ? '—' : (html ? value : escapeHtml(value));
        return `<div class="dd-row"><span class="dd-row-label">${escapeHtml(label)}</span><span class="dd-row-value">${shown}</span></div>`;
    }

    function ddStat(value, label) {
        return `<div class="dd-stat"><div class="dd-stat-value">${escapeHtml(value)}</div><div class="dd-stat-label">${escapeHtml(label)}</div></div>`;
    }

    function ddEmpty(message) {
        return `<div class="dd-empty">${escapeHtml(message)}</div>`;
    }

    // Trips this driver ended more than 300 m from the destination in the last
    // 30 days — repeated ones are worth a look (and a TODA recommendation).
    function earlyDropoffSummary(driver) {
        const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const trips = (window.allBookings || []).filter((b) => b.driverId === driver.id && b.endedEarly
            && timeOf(b.completedAtRaw || b.createdAtRaw) >= since);
        if (!trips.length) return '0';
        const waiting = trips.filter((b) => !b.earlyEndReviewedAtRaw).length;
        return waiting ? `${trips.length} (${waiting} to review)` : String(trips.length);
    }

    // "05/12/26" plus a red / amber chip when the license has expired or is about to.
    function licenseExpiryRowHtml(driver) {
        const info = licenseExpiryInfo(driver);
        if (info.status === 'none') return '';
        const chip = expiryChipHtml(info);
        return `${escapeHtml(info.raw)}${info.status === 'unreadable' ? ' <span class="detail-sub">(date not understood)</span>' : ''}${chip ? ` ${chip}` : ''}`;
    }

    function driverRiskCardBody(driver) {
        const risk = riskOf(driver.id);
        return risk ? riskBodyHtml(risk) : '<div class="risk-note" style="margin-top:0;">Not scored yet — treated as LOW.</div>';
    }

    function ddInfoHtml(driver) {
        const stats = ParaFirestore.computeDriverStats(driver, window.allBookings || []);
        const isSuspended = driver.accountStatus === 'suspended';
        const rating = driver.rating === '—' ? '—' : `${Number(driver.rating).toFixed(1)} ★`;
        let suspension = '';
        if (isSuspended) {
            const until = driver.suspendedUntilRaw ? `until ${ParaFirestore.formatDateTime(driver.suspendedUntilRaw)}` : 'indefinitely';
            suspension = `<div class="dd-notice"><strong>Suspended ${escapeHtml(until)}.</strong>${driver.suspensionReason ? ` ${escapeHtml(driver.suspensionReason)}` : ''}</div>`;
        }
        const expiry = licenseExpiryInfo(driver);
        const expiryNotice = expiry.status === 'expired' || expiry.status === 'soon'
            ? `<div class="dd-notice${expiry.status === 'soon' ? ' warn' : ''}"><strong>${escapeHtml(expiry.text)}.</strong> The license is valid until ${escapeHtml(expiry.dateLabel)}.</div>`
            : '';
        return `
            ${suspension}${expiryNotice}
            <div class="dd-stats">
                ${ddStat(rating, 'Rating')}
                ${ddStat(stats.completed, 'Completed rides')}
                ${ddStat(stats.acceptanceRate, 'Acceptance rate')}
            </div>
            <div class="dd-cards">
                <div class="dd-card wide">
                    <div class="dd-card-title">Risk score</div>
                    <div class="risk-box">${driverRiskCardBody(driver)}</div>
                </div>
                <div class="dd-card">
                    <div class="dd-card-title">Contact &amp; account</div>
                    ${ddRow('Phone', driver.phone)}
                    ${ddRow('Email', driver.email)}
                    ${ddRow('Verification', renderBadge(driver.verificationStatus), { html: true })}
                    ${ddRow('Member since', driver.memberSince)}
                    ${ddRow('Ended early (30 days)', earlyDropoffSummary(driver))}
                </div>
                <div class="dd-card">
                    <div class="dd-card-title">Vehicle</div>
                    ${ddRow('Tricycle number', driver.vehicle)}
                    ${ddRow('Motorcycle model', driver.motorcycleModel)}
                    ${ddRow('Plate number', driver.plate)}
                    ${ddRow('Registration date', driver.vehicleRegistrationDate)}
                    ${driver.tricycleImageUrl
                        ? `<a class="dd-thumb" href="${escapeHtml(driver.tricycleImageUrl)}" target="_blank" rel="noopener" title="Open the tricycle photo"><img src="${escapeHtml(driver.tricycleImageUrl)}" alt="Tricycle photo" loading="lazy"></a>`
                        : ddRow('Tricycle photo', 'Not added yet')}
                    ${driver.tricyclePermitImageUrl
                        ? `<a class="dd-thumb" href="${escapeHtml(driver.tricyclePermitImageUrl)}" target="_blank" rel="noopener" title="Open the tricycle permit"><img src="${escapeHtml(driver.tricyclePermitImageUrl)}" alt="Tricycle permit" loading="lazy"></a>`
                        : ddRow('Tricycle permit', 'Not uploaded yet')}
                </div>
                <div class="dd-card wide">
                    <div class="dd-card-title">License &amp; identification</div>
                    ${ddRow('License number', driver.license)}
                    ${ddRow('License expiry', licenseExpiryRowHtml(driver), { html: true })}
                    ${ddRow('Government ID', driver.governmentId)}
                </div>
            </div>`;
    }

    function ddBookingsHtml(driver) {
        const all = bookingsForDriver(driver);
        if (!all.length) return ddEmpty('No bookings found for this driver.');
        const count = (status) => all.filter((b) => ParaFirestore.normalizeStatus(b.status) === status).length;
        const list = ddBookingFilter === 'all' ? all : all.filter((b) => ParaFirestore.normalizeStatus(b.status) === ddBookingFilter);
        const chip = (key, label, n) => `<button type="button" class="dd-chip${ddBookingFilter === key ? ' active' : ''}" data-dd-filter="${key}"${n === 0 && key !== 'all' ? ' disabled' : ''}><strong>${n}</strong>${label}</button>`;
        const totalPages = Math.max(1, Math.ceil(list.length / DD_BOOKINGS_PAGE_SIZE));
        ddBookingPage = Math.min(Math.max(1, ddBookingPage), totalPages);
        const start = (ddBookingPage - 1) * DD_BOOKINGS_PAGE_SIZE;
        const rows = list.slice(start, start + DD_BOOKINGS_PAGE_SIZE).map((b) => `
            <tr class="row-clickable" data-booking-id="${escapeHtml(b.id)}" title="View trip details">
                <td><div class="book-id">${escapeHtml(b.ref)}</div><div class="book-time">${escapeHtml(b.relativeTime)}</div></td>
                <td style="font-size:13px;">${escapeHtml(b.dateLabel)}</td>
                <td style="font-size:13px;">${escapeHtml(b.passengerName || '—')}</td>
                <td style="max-width:230px; font-size:13px; line-height:1.4;">${escapeHtml(b.pickupLocation)}<div class="detail-sub">to ${escapeHtml(b.dropoffLocation)}</div></td>
                <td>${renderBadge(b.status)}</td>
                <td><div style="color:${fareColor(ParaFirestore.normalizeStatus(b.status))}; font-weight:600;">&#8369;${escapeHtml(Number(b.totalFare || 0).toFixed(2))}</div>${paymentLine(b)}</td>
            </tr>`).join('');
        return `
            <div class="dd-summary">
                ${chip('all', 'total', all.length)}
                ${chip('completed', 'completed', count('completed'))}
                ${chip('cancelled', 'cancelled', count('cancelled'))}
                ${chip('declined', 'declined', count('declined'))}
            </div>
            <div class="table-container"><table class="data-table">
                <thead><tr><th>Booking</th><th>Date</th><th>Passenger</th><th>Route</th><th>Status</th><th>Fare</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
            <div class="dd-pager">
                <span>Showing ${start + 1}–${Math.min(list.length, start + DD_BOOKINGS_PAGE_SIZE)} of ${list.length}</span>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="action-btn" data-dd-page="-1" ${ddBookingPage <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${ddBookingPage} of ${totalPages}</span>
                    <button class="action-btn" data-dd-page="1" ${ddBookingPage >= totalPages ? 'disabled' : ''}>Next</button>
                </div>
            </div>`;
    }

    function ddComplaintsHtml(driver) {
        const list = complaintsForDriver(driver);
        if (!list.length) return ddEmpty('No complaints filed against this driver.');
        const rows = list.map((c) => `
            <tr>
                <td><div class="book-id">${escapeHtml(c.ref)}</div><div class="book-time">${escapeHtml(ParaFirestore.formatDateTime(c.createdAtRaw))}</div></td>
                <td><div class="detail-main">${escapeHtml(c.issue)}</div><div class="detail-sub">${escapeHtml(c.description)}</div></td>
                <td>${escapeHtml(c.reporter)}${c.tripRef ? `<div class="detail-sub">Trip: ${escapeHtml(c.tripRef)}</div>` : ''}</td>
                <td>${complaintBadge(c.status)}</td>
                <td><button class="action-btn" data-dd-case="${escapeHtml(c.id)}">View Case</button></td>
            </tr>`).join('');
        return `
            <div class="table-container"><table class="data-table">
                <thead><tr><th>Case</th><th>Issue</th><th>Reported by</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    }

    function renderDriverDetails() {
        if (!ddDriver) return;
        const body = document.getElementById('dd-body');
        if (!body) return;
        document.querySelectorAll('#driverDetailsModal .dd-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === ddTab));
        // Header: initials, name, account status + presence, vehicle.
        const isSuspended = ddDriver.accountStatus === 'suspended';
        const initials = driverInitials(ddDriver);
        const avatarEl = document.getElementById('dd-avatar');
        if (ddDriver.profileImage) {
            avatarEl.innerHTML = `<img src="${escapeHtml(ddDriver.profileImage)}" alt="" data-initials="${escapeHtml(initials)}" onerror="this.parentNode.textContent=this.dataset.initials">`;
        } else {
            avatarEl.textContent = initials;
        }
        document.getElementById('dd-title').textContent = ddDriver.name || 'Driver Details';
        const presence = driverPresenceLine(ddDriver).replace(/^<div[^>]*>|<\/div>$/g, '');
        const vehicle = [ddDriver.vehicle && `Tricycle ${ddDriver.vehicle}`, ddDriver.plate && `Plate ${ddDriver.plate}`].filter(Boolean).join(' · ');
        document.getElementById('dd-meta').innerHTML = renderBadge(isSuspended ? 'suspended' : 'active')
            + (ddDriver.profilePhotoStatus === 'pending' ? renderBadge('pending', 'PHOTO UNDER REVIEW') : '')
            + (presence ? `<span>${presence}</span>` : '')
            + (vehicle ? `<span>${escapeHtml(vehicle)}</span>` : '');
        document.getElementById('dd-bookings-count').textContent = `(${bookingsForDriver(ddDriver).length})`;
        document.getElementById('dd-complaints-count').textContent = `(${complaintsForDriver(ddDriver).length})`;
        body.innerHTML = ddTab === 'bookings' ? ddBookingsHtml(ddDriver)
            : ddTab === 'complaints' ? ddComplaintsHtml(ddDriver)
            : ddInfoHtml(ddDriver);
    }

    // Live listeners (drivers, bookings, complaints) keep updating while the
    // window is open — redraw it from the fresh data.
    function refreshDriverDetails() {
        const modal = document.getElementById('driverDetailsModal');
        if (!ddDriver || !modal || !modal.classList.contains('active')) return;
        const fresh = (window.driverManagementDrivers || []).find((d) => d.id === ddDriver.id);
        if (!fresh) return;
        ddDriver = fresh;
        renderDriverDetails();
    }

    window.openDriverDetailsModal = function(driverId) {
        const driver = (window.driverManagementDrivers || []).find((d) => d.id === driverId);
        if (!driver) return;
        ddDriver = driver;
        ddTab = 'info';
        ddBookingPage = 1;
        ddBookingFilter = 'all';
        renderDriverDetails();
        document.getElementById('driverDetailsModal').classList.add('active');
    };

    (function bindDriverDetailsModal() {
        const modal = document.getElementById('driverDetailsModal');
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            const tab = e.target.closest('.dd-tab');
            if (tab) {
                ddTab = tab.dataset.tab;
                renderDriverDetails();
                return;
            }
            const filterBtn = e.target.closest('[data-dd-filter]');
            if (filterBtn && !filterBtn.disabled) {
                ddBookingFilter = filterBtn.dataset.ddFilter;
                ddBookingPage = 1;
                renderDriverDetails();
                return;
            }
            const pageBtn = e.target.closest('[data-dd-page]');
            if (pageBtn) {
                ddBookingPage += Number(pageBtn.dataset.ddPage);
                renderDriverDetails();
                return;
            }
            const tripRow = e.target.closest('tr[data-booking-id]');
            if (tripRow && !e.target.closest('button')) {
                window.openTripModal(tripRow.dataset.bookingId);
                return;
            }
            const caseBtn = e.target.closest('[data-dd-case]');
            if (caseBtn) {
                modal.classList.remove('active');
                window.openComplaintModal(caseBtn.dataset.ddCase);
            }
        });
    })();

    // ── Passenger details window (click a row in Passenger Management) ──
    // Same look as the driver window; reuses its row/stat/chip helpers.
    let pdPassenger = null;
    let pdTab = 'info';
    let pdBookingPage = 1;
    let pdBookingFilter = 'all';

    function bookingsForPassenger(passenger) {
        return (window.allBookings || []).filter((b) => b.passengerId === passenger.id).sort((a, b) => {
            const ta = a.createdAtRaw ? new Date(a.createdAtRaw).getTime() || 0 : 0;
            const tb = b.createdAtRaw ? new Date(b.createdAtRaw).getTime() || 0 : 0;
            return tb - ta;
        });
    }

    // Complaints this passenger filed (a complaint is always passenger -> driver).
    function complaintsForPassenger(passenger) {
        return allComplaints.filter((c) => c.passengerId === passenger.id).sort((a, b) => {
            const ta = a.createdAtRaw ? new Date(a.createdAtRaw).getTime() || 0 : 0;
            const tb = b.createdAtRaw ? new Date(b.createdAtRaw).getTime() || 0 : 0;
            return tb - ta;
        });
    }

    function pdInfoHtml(passenger) {
        const stats = computePassengerRideStats(passenger.id);
        const bookings = bookingsForPassenger(passenger);
        const completed = bookings.filter((b) => ParaFirestore.normalizeStatus(b.status) === 'completed');
        const spent = completed.reduce((sum, b) => sum + (Number(b.totalFare) || 0), 0);
        const isSuspended = passenger.status === 'suspended';
        let suspension = '';
        if (isSuspended) {
            const until = passenger.suspendedUntilRaw ? `until ${ParaFirestore.formatDateTime(passenger.suspendedUntilRaw)}` : 'indefinitely';
            suspension = `<div class="dd-notice"><strong>Suspended ${escapeHtml(until)}.</strong>${passenger.suspensionReason ? ` ${escapeHtml(passenger.suspensionReason)}` : ''}</div>`;
        }
        return `
            ${suspension}
            <div class="dd-stats">
                ${ddStat(stats.totalRides, 'Total rides')}
                ${ddStat(stats.cancelled, 'Cancelled')}
                ${ddStat(stats.cancelRate, 'Cancellation rate')}
            </div>
            <div class="dd-cards">
                <div class="dd-card">
                    <div class="dd-card-title">Contact &amp; account</div>
                    ${ddRow('Phone', passenger.phone)}
                    ${ddRow('Email', passenger.email)}
                    ${ddRow('Account status', renderBadge(passenger.status === 'flagged' ? 'flagged' : (isSuspended ? 'suspended' : 'active')), { html: true })}
                    ${ddRow('Member since', passenger.memberSince)}
                </div>
                <div class="dd-card">
                    <div class="dd-card-title">Ride activity</div>
                    ${ddRow('Completed rides', completed.length)}
                    ${ddRow('No-shows on record', passenger.noShowCount)}
                    ${ddRow('Total spent', `₱${spent.toFixed(2)}`)}
                    ${ddRow('Last completed ride', completed.length ? completed[0].dateLabel : '')}
                    ${ddRow('Complaints filed', complaintsForPassenger(passenger).length)}
                </div>
            </div>`;
    }

    function pdBookingsHtml(passenger) {
        const all = bookingsForPassenger(passenger);
        if (!all.length) return ddEmpty('No bookings found for this passenger.');
        const count = (status) => all.filter((b) => ParaFirestore.normalizeStatus(b.status) === status).length;
        const list = pdBookingFilter === 'all' ? all : all.filter((b) => ParaFirestore.normalizeStatus(b.status) === pdBookingFilter);
        const chip = (key, label, n) => `<button type="button" class="dd-chip${pdBookingFilter === key ? ' active' : ''}" data-dd-filter="${key}"${n === 0 && key !== 'all' ? ' disabled' : ''}><strong>${n}</strong>${label}</button>`;
        const totalPages = Math.max(1, Math.ceil(list.length / DD_BOOKINGS_PAGE_SIZE));
        pdBookingPage = Math.min(Math.max(1, pdBookingPage), totalPages);
        const start = (pdBookingPage - 1) * DD_BOOKINGS_PAGE_SIZE;
        const rows = list.slice(start, start + DD_BOOKINGS_PAGE_SIZE).map((b) => `
            <tr class="row-clickable" data-booking-id="${escapeHtml(b.id)}" title="View trip details">
                <td><div class="book-id">${escapeHtml(b.ref)}</div><div class="book-time">${escapeHtml(b.relativeTime)}</div></td>
                <td style="font-size:13px;">${escapeHtml(b.dateLabel)}</td>
                <td><div class="detail-main" style="font-size:13px;">${escapeHtml(b.driverName || '—')}</div><div class="detail-sub">Plate: ${escapeHtml(b.plate)}</div></td>
                <td style="max-width:230px; font-size:13px; line-height:1.4;">${escapeHtml(b.pickupLocation)}<div class="detail-sub">to ${escapeHtml(b.dropoffLocation)}</div></td>
                <td>${renderBadge(b.status)}</td>
                <td><div style="color:${fareColor(ParaFirestore.normalizeStatus(b.status))}; font-weight:600;">&#8369;${escapeHtml(Number(b.totalFare || 0).toFixed(2))}</div>${paymentLine(b)}</td>
            </tr>`).join('');
        return `
            <div class="dd-summary">
                ${chip('all', 'total', all.length)}
                ${chip('completed', 'completed', count('completed'))}
                ${chip('cancelled', 'cancelled', count('cancelled'))}
                ${chip('declined', 'declined', count('declined'))}
                ${chip('no_show', 'no-show', count('no_show'))}
            </div>
            <div class="table-container"><table class="data-table">
                <thead><tr><th>Booking</th><th>Date</th><th>Driver</th><th>Route</th><th>Status</th><th>Fare</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
            <div class="dd-pager">
                <span>Showing ${start + 1}–${Math.min(list.length, start + DD_BOOKINGS_PAGE_SIZE)} of ${list.length}</span>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="action-btn" data-dd-page="-1" ${pdBookingPage <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${pdBookingPage} of ${totalPages}</span>
                    <button class="action-btn" data-dd-page="1" ${pdBookingPage >= totalPages ? 'disabled' : ''}>Next</button>
                </div>
            </div>`;
    }

    function pdComplaintsHtml(passenger) {
        const list = complaintsForPassenger(passenger);
        if (!list.length) return ddEmpty('This passenger hasn’t filed any complaints.');
        const rows = list.map((c) => `
            <tr>
                <td><div class="book-id">${escapeHtml(c.ref)}</div><div class="book-time">${escapeHtml(ParaFirestore.formatDateTime(c.createdAtRaw))}</div></td>
                <td><div class="detail-main">${escapeHtml(c.issue)}</div><div class="detail-sub">${escapeHtml(c.description)}</div></td>
                <td>${escapeHtml(c.reported)}${c.tripRef ? `<div class="detail-sub">Trip: ${escapeHtml(c.tripRef)}</div>` : ''}</td>
                <td>${complaintBadge(c.status)}</td>
                <td><button class="action-btn" data-dd-case="${escapeHtml(c.id)}">View Case</button></td>
            </tr>`).join('');
        return `
            <div class="table-container"><table class="data-table">
                <thead><tr><th>Case</th><th>Issue</th><th>Against driver</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    }

    function renderPassengerDetails() {
        if (!pdPassenger) return;
        const body = document.getElementById('pd-body');
        if (!body) return;
        document.querySelectorAll('#passengerDetailsModal .dd-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === pdTab));
        const status = pdPassenger.status === 'flagged' ? 'flagged' : (pdPassenger.status === 'suspended' ? 'suspended' : 'active');
        const initials = String(pdPassenger.name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
        document.getElementById('pd-avatar').textContent = initials || '?';
        document.getElementById('pd-title').textContent = pdPassenger.name || 'Passenger Details';
        document.getElementById('pd-meta').innerHTML = renderBadge(status);
        document.getElementById('pd-bookings-count').textContent = `(${bookingsForPassenger(pdPassenger).length})`;
        document.getElementById('pd-complaints-count').textContent = `(${complaintsForPassenger(pdPassenger).length})`;
        body.innerHTML = pdTab === 'bookings' ? pdBookingsHtml(pdPassenger)
            : pdTab === 'complaints' ? pdComplaintsHtml(pdPassenger)
            : pdInfoHtml(pdPassenger);
    }

    function refreshPassengerDetails() {
        const modal = document.getElementById('passengerDetailsModal');
        if (!pdPassenger || !modal || !modal.classList.contains('active')) return;
        const fresh = (window.allPassengers || []).find((p) => p.id === pdPassenger.id);
        if (!fresh) return;
        pdPassenger = fresh;
        renderPassengerDetails();
    }

    window.openPassengerDetailsModal = function(passengerId) {
        const passenger = (window.allPassengers || []).find((p) => p.id === passengerId);
        if (!passenger) return;
        pdPassenger = passenger;
        pdTab = 'info';
        pdBookingPage = 1;
        pdBookingFilter = 'all';
        renderPassengerDetails();
        document.getElementById('passengerDetailsModal').classList.add('active');
    };

    (function bindPassengerDetailsModal() {
        const modal = document.getElementById('passengerDetailsModal');
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            const tab = e.target.closest('.dd-tab');
            if (tab) {
                pdTab = tab.dataset.tab;
                renderPassengerDetails();
                return;
            }
            const filterBtn = e.target.closest('[data-dd-filter]');
            if (filterBtn && !filterBtn.disabled) {
                pdBookingFilter = filterBtn.dataset.ddFilter;
                pdBookingPage = 1;
                renderPassengerDetails();
                return;
            }
            const pageBtn = e.target.closest('[data-dd-page]');
            if (pageBtn) {
                pdBookingPage += Number(pageBtn.dataset.ddPage);
                renderPassengerDetails();
                return;
            }
            const tripRow = e.target.closest('tr[data-booking-id]');
            if (tripRow && !e.target.closest('button')) {
                window.openTripModal(tripRow.dataset.bookingId);
                return;
            }
            const caseBtn = e.target.closest('[data-dd-case]');
            if (caseBtn) {
                modal.classList.remove('active');
                window.openComplaintModal(caseBtn.dataset.ddCase);
            }
        });
    })();

    window.openPassengerHistoryModal = function(passengerId, name) {
        openActionHistoryModal(name, () => ParaFirestore.fetchPassengerActions(passengerId), 'No suspensions or reactivations recorded for this passenger yet.');
    };

    // "indefinitely" / "for 3 days" in the suspension toasts.
    function suspensionDurationLabel(value) {
        if (value === 'permanent') return 'indefinitely';
        return `for ${value} day${value === '1' ? '' : 's'}`;
    }

    window.confirmDriverBan = function(driverId, name) {
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">This driver will be suspended and cannot accept rides until reactivated.</div>
            <div style="text-align:left; margin-top:14px;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Suspend for</label>
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
            `Suspend ${name}?`,
            'This driver will be suspended and cannot accept rides until reactivated.',
            'Suspend',
            '#EE5D50',
            async () => {
                try {
                    const daysSelect = document.getElementById('driverSuspendDays');
                    const reasonInput = document.getElementById('driverSuspendReason');
                    const daysValue = daysSelect?.value || '3';
                    const reason = reasonInput ? reasonInput.value.trim() : '';
                    await ParaFirestore.updateDriverAccountStatus(driverId, 'suspended', daysValue, reason);
                    ParaFirestore.logDriverAction(driverId, name, 'Suspension', reason).catch((error) => console.error('Failed to log driver action:', error));
                    settleOnSuspension(driverId, reason);
                    const durationLabel = suspensionDurationLabel(daysValue);
                    window.showToast(`${name} has been suspended ${durationLabel}.`, 'error');
                } catch (error) {
                    window.showToast('Failed to suspend driver.', 'error');
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
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Suspend for</label>
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
            `Suspend ${name}?`,
            'This passenger will be suspended and cannot book rides.',
            'Suspend',
            '#EE5D50',
            async () => {
                try {
                    const daysSelect = document.getElementById('passengerSuspendDays');
                    const reasonInput = document.getElementById('passengerSuspendReason');
                    const daysValue = daysSelect?.value || '3';
                    const reason = reasonInput ? reasonInput.value.trim() : '';
                    await ParaFirestore.updatePassengerStatus(userId, 'suspended', daysValue, reason);
                    ParaFirestore.logPassengerAction(userId, name, 'Suspension', reason).catch((error) => console.error('Failed to log passenger action:', error));
                    const durationLabel = suspensionDurationLabel(daysValue);
                    window.showToast(`${name} has been suspended ${durationLabel}.`, 'error');
                } catch (error) {
                    window.showToast('Failed to suspend passenger.', 'error');
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
            const filedEl = document.getElementById('c-filed');
            if (filedEl) filedEl.textContent = data.createdAtRaw ? `Filed ${ParaFirestore.formatDateTime(data.createdAtRaw)}` : '—';
            // The ride this complaint is about, with where the driver was at each step.
            const tripLine = document.getElementById('c-trip-line');
            if (tripLine) {
                const trip = data.bookingId ? (window.allBookings || []).find((b) => b.id === data.bookingId || b.ref === data.bookingId) : null;
                tripLine.style.display = trip ? '' : 'none';
                tripLine.innerHTML = trip
                    ? `<span>Trip ${escapeHtml(trip.ref)}${trip.endedEarly ? ' · <strong style="color:#FF9E2A;">ended early</strong>' : ''}${ParaFirestore.normalizeStatus(trip.status) === 'no_show' ? ' · <strong style="color:#EE5D50;">no-show</strong>' : ''}</span><button class="action-btn" data-case-trip="${escapeHtml(trip.id)}" style="background:var(--bg-light);color:var(--text-main);">View trip</button>`
                    : '';
            }
            document.getElementById('c-issue').value = data.issue || '';
            document.getElementById('c-desc').value = data.description || '';

            const notesEl = document.getElementById('complaint-admin-notes');
            if (notesEl) notesEl.value = data.adminNotes || '';

            // What the TODA president recommended for this case, with
            // Approve / Decline while a suspension is waiting for a decision.
            currentComplaintData = data;
            const recBox = document.getElementById('c-toda-rec-box');
            if (recBox) recBox.innerHTML = '<div style="color:var(--text-muted);">Checking…</div>';
            renderPresidentRecommendation(data);
            renderCaseRisk(data);

            const statusEl = document.getElementById('c-status');
            const normalizedStatus = data.status;
            statusEl.textContent = complaintStatusLabel(normalizedStatus).toUpperCase();
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
            ['complaintDismissBtn', 'complaintWarnBtn', 'complaintSuspendBtn', 'complaintResolveBtn'].forEach((id) => {
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

            // Tell the passenger how their complaint ended — same notification
            // the app sends when the TODA president closes one.
            if (complaint && complaint.passengerId) {
                const type = String(complaint.complaintType || '').trim() || 'complaint';
                const outcome = status === 'RESOLVED'
                    ? `Your ${type} report has been resolved by PARA admin.`
                    : `Your ${type} report was reviewed and closed without action.`;
                ParaFirestore.sendDirectNotification(
                    complaint.passengerId,
                    'Complaint update',
                    notes ? `${outcome}\n\nNote: ${notes}` : outcome,
                    complaint.bookingId || ''
                ).catch((error) => console.error('Failed to notify the passenger:', error));
            }

            // Warning/Suspension also act on the actual reported account (always
            // the driver per the real schema) — logged to driver_actions and
            // notified directly, not just recorded on the complaint itself.
            if (actionType && complaint && complaint.reportedId) {
                ParaFirestore.logDriverAction(complaint.reportedId, complaint.reported, actionType, notes, { complaintId: complaint.id })
                    .catch((error) => console.error('Failed to log complaint action:', error));

                if (actionType === 'Suspension') {
                    await ParaFirestore.updateDriverAccountStatus(complaint.reportedId, 'suspended', suspendDays || 3, notes);
                    settleOnSuspension(complaint.reportedId, notes);
                }

                const notifTitle = actionType === 'Warning' ? 'Account Warning' : 'Account Suspended';
                const notifBody = notes || (actionType === 'Warning'
                    ? 'You have received a warning regarding a recent complaint.'
                    : 'Your account has been suspended regarding a recent complaint.');
                ParaFirestore.sendDirectNotification(complaint.reportedId, notifTitle, notifBody).catch((error) => console.error('Failed to notify:', error));
            }

            // Closed without a suspension (a warning, or just resolved): the
            // president's recommendation for this case no longer waits on the admin.
            if (complaint && actionType !== 'Suspension') settleOnCaseClosed(complaint, notes);

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
            const closedMessage = status === 'REJECTED' ? 'Complaint dismissed.' : 'Case marked as resolved.';
            window.showToast(successMessages[actionType] || closedMessage, actionType === 'Suspension' ? 'error' : (actionType === 'Warning' ? 'warning' : 'success'));
        } catch (error) {
            console.error(`Failed to update complaint to ${status}:`, error);
            window.showToast('Failed to update complaint status.', 'error');
        }
    }

    window.resolveComplaint = function() {
        if (!currentComplaintId) return;
        showConfirmModal(
            'Mark this case as resolved?',
            'The complaint will be closed as handled, with no warning or suspension. The passenger is notified.',
            'Mark Resolved',
            '#05CD99',
            () => {
                const notesEl = document.getElementById('complaint-admin-notes');
                runComplaintAction('RESOLVED', notesEl ? notesEl.value.trim() : '', null);
            }
        );
    };

    // For a complaint with no basis (the president's app calls it Dismissed). It is
    // saved as REJECTED, so it no longer counts toward the driver's risk score.
    window.dismissComplaint = function() {
        if (!currentComplaintId) return;
        showConfirmModal(
            'Dismiss this complaint?',
            'The complaint will be closed as unfounded. It will not count toward the driver’s risk score, and the passenger is told it was closed without action.',
            'Dismiss',
            '#6B7A99',
            () => {
                const notesEl = document.getElementById('complaint-admin-notes');
                runComplaintAction('REJECTED', notesEl ? notesEl.value.trim() : '', null);
            }
        );
    };

    window.warnComplaint = function() {
        if (!currentComplaintId) return;
        const complaint = allComplaints.find((c) => c.id === currentComplaintId);
        const name = complaint ? (complaint.reported || 'this account') : 'this account';
        // The message is what the driver is told, so it can't be left blank. It
        // starts from whatever is already typed in the Resolution Note.
        const notesEl = document.getElementById('complaint-admin-notes');
        const customBodyHtml = `
            <div style="text-align:left; margin-bottom:12px; color:var(--text-muted);">They will receive a notification with this message, and the warning will be recorded on their account.</div>
            <div style="text-align:left;">
                <label style="display:block; margin-bottom:8px; font-size:12px; font-weight:600; color:var(--text-muted);">Message to the driver <span style="color:#EE5D50;">*</span></label>
                <textarea id="complaintWarnMessage" class="form-input" rows="4" style="width:100%; resize:vertical;" placeholder="e.g. Please charge only the fare shown in the app and treat passengers respectfully. Another report may lead to a suspension."></textarea>
                <div class="detail-sub" style="margin-top:6px;">Also saved as this case's resolution note.</div>
            </div>
        `;
        showConfirmModal(
            `Warn ${name}?`,
            '',
            'Issue Warning',
            '#FF9E2A',
            () => {
                const messageEl = document.getElementById('complaintWarnMessage');
                const message = messageEl ? messageEl.value.trim() : '';
                if (!message) return;
                runComplaintAction('RESOLVED', message, 'Warning');
            },
            customBodyHtml
        );
        const messageEl = document.getElementById('complaintWarnMessage');
        const confirmBtn = document.getElementById('confirmActionBtn');
        if (messageEl && confirmBtn) {
            messageEl.value = notesEl ? notesEl.value.trim() : '';
            const sync = () => { confirmBtn.disabled = !messageEl.value.trim(); };
            messageEl.addEventListener('input', sync);
            sync();
            messageEl.focus();
        }
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
            minimumFare: Number(document.getElementById('fare-min').value),
            includedDistanceKm: Number(document.getElementById('fare-included').value),
            perKmRate: Number(document.getElementById('fare-perkm').value),
            serviceFeeParaPct: Number(document.getElementById('fare-fee-para').value),
            serviceFeeDriverPct: Number(document.getElementById('fare-fee-driver').value),
            serviceFeeTodaPct: Number(document.getElementById('fare-fee-toda').value),
            tideSurchargeFromFt: Number(document.getElementById('fare-tide-from').value),
            tideSurchargeHighFt: Number(document.getElementById('fare-tide-high').value),
            tideSurchargeFee: Number(document.getElementById('fare-tide-fee').value),
            tideSurchargeHighFee: Number(document.getElementById('fare-tide-high-fee').value)
        };

        const invalidField = Object.entries(settings).find(([, value]) => !Number.isFinite(value) || value < 0);
        if (invalidField) {
            window.showToast('Please enter valid, non-negative values before saving.', 'warning');
            return;
        }
        const feeTotal = settings.serviceFeeParaPct + settings.serviceFeeDriverPct + settings.serviceFeeTodaPct;
        if (feeTotal > 100) {
            window.showToast('The service fee shares can’t add up to more than 100%.', 'warning');
            return;
        }
        if (settings.tideSurchargeHighFt <= settings.tideSurchargeFromFt) {
            window.showToast('The higher tide level must be above the first one.', 'warning');
            return;
        }

        showConfirmModal(
            'Save fare settings?',
            `Saves ₱${settings.minimumFare} minimum fare (first ${settings.includedDistanceKm} km included) and ₱${settings.perKmRate} per km after that, plus a ${Number(feeTotal.toFixed(2))}% service fee on top of the fare (PARA ${settings.serviceFeeParaPct}%, driver ${settings.serviceFeeDriverPct}%, TODA ${settings.serviceFeeTodaPct}%), and a tide surcharge of ₱${settings.tideSurchargeFee} from ${settings.tideSurchargeFromFt} ft up to ${settings.tideSurchargeHighFt} ft and ₱${settings.tideSurchargeHighFee} at ${settings.tideSurchargeHighFt} ft and above. The mobile app reads the fare and service fee live: they apply to bookings made after this (each booking keeps the numbers it was made with). The tide surcharge only takes effect once the app is updated to read it. Nobody is notified.`,
            'Save Changes',
            '#1A73E8',
            async () => {
                try {
                    await ParaFirestore.saveFareSettings(settings);
                    window.showToast('Fare settings saved.', 'success');
                    if (typeof loadFareSettings === 'function') loadFareSettings();
                } catch (error) {
                    console.error('Failed to save fare settings:', error);
                    window.showToast(error.message || 'Failed to save fare settings.', 'error');
                }
            }
        );
    };

    // ── The TODA president's recommendations (shown inside the complaint) ──
    // Information for the admin, not a request: when the president isn't sure
    // what penalty a driver should get, the app saves a driver_actions record
    // (Warning / Invalid / Suspension) with the reason, and the admin decides
    // for themselves using Issue Warning / Suspend Account / Mark Resolved.
    let suspensionActions = [];
    let warningActions = [];
    let suspensionAdminIds = new Set([user.uid]);
    let suspensionRepairDone = false;
    let currentComplaintData = null;

    function isAdminAction(action) {
        return action.issuedByRole === 'ADMIN' || suspensionAdminIds.has(action.issuedBy);
    }

    function presidentSuspensionRecommendations() {
        return suspensionActions
            .filter((action) => !isAdminAction(action))
            .sort((a, b) => b.issuedAt - a.issuedAt);
    }

    function formatActionTime(ms) {
        return ms ? new Date(ms).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
    }

    // Does this recommendation belong to this complaint? The app links one by
    // complaintId when it was sent from a complaint; one sent for the driver in
    // general has none, so it shows on that driver's complaints.
    function recommendationBelongsTo(action, complaint) {
        return action.complaintId
            ? action.complaintId === complaint.id
            : Boolean(action.driverId && action.driverId === complaint.driverId);
    }

    function suspensionRecommendationsFor(complaint) {
        return presidentSuspensionRecommendations().filter((action) => recommendationBelongsTo(action, complaint));
    }

    // Still "Awaiting admin" in the president's app: status PENDING, or none at
    // all on a record written before the field existed.
    function isAwaitingAdmin(action) {
        const status = String(action.status || '').toUpperCase();
        return status === 'PENDING' || status === '';
    }

    // The admin closed this case by suspending the driver: Suspend Account logs a
    // Suspension with the case's id. (A suspension from Driver Management has none.)
    function wasSuspendedByAdmin(complaint) {
        return suspensionActions.some((action) => isAdminAction(action) && action.complaintId === complaint.id);
    }

    // The admin closed this case by issuing the driver a warning (Issue Warning
    // logs a Warning with the case's id). The president's recommended warnings
    // aren't counted.
    function wasWarnedByAdmin(complaint) {
        return warningActions.some((action) => isAdminAction(action) && action.complaintId === complaint.id);
    }

    // A case that is still open and has a suspension recommendation the admin
    // hasn't acted on yet.
    // "Suspension recommended" / "Further review requested" under a case's status
    // while the president's recommendation still waits for the admin.
    function openRecommendationLabel(complaint) {
        if (!hasOpenRecommendation(complaint)) return '';
        const waiting = suspensionRecommendationsFor(complaint).filter(isAwaitingAdmin);
        const suspension = waiting.some((a) => a.actionType === 'Suspension');
        return `<div class="detail-sub" style="margin-top:6px; color:${suspension ? '#EE5D50' : '#FF9E2A'}; font-weight:600;">${suspension ? 'Suspension recommended' : 'Further review requested'}</div>`;
    }

    function hasOpenRecommendation(complaint) {
        return ['pending', 'reviewing'].includes(complaint.status)
            && suspensionRecommendationsFor(complaint).some(isAwaitingAdmin);
    }

    // Tell the president's app what the admin did. Best-effort: the admin's own
    // action has already gone through, so a failure here only leaves the
    // recommendation showing "Awaiting admin".
    async function settleRecommendations(actions, decision, note) {
        if (!actions.length) return;
        try {
            await ParaFirestore.settleDriverActions(actions.map((a) => a.id), decision, note);
        } catch (error) {
            console.error('Failed to update the president recommendation:', error);
        }
    }

    // The admin suspended the driver (from a case or from Driver Management):
    // every recommendation to suspend them is now carried out.
    function settleOnSuspension(driverId, reason) {
        const waiting = presidentSuspensionRecommendations().filter((a) => a.driverId === driverId && isAwaitingAdmin(a));
        return settleRecommendations(waiting, 'APPROVED', reason ? `Driver suspended: ${reason}` : 'Driver suspended by admin.');
    }

    // The admin closed a case without suspending: the recommendation attached
    // to it is done with. One sent for the driver in general stays until their
    // last open case is closed.
    function settleOnCaseClosed(complaint, note) {
        const otherOpenCases = allComplaints.filter((c) => c.driverId === complaint.driverId && c.id !== complaint.id && ['pending', 'reviewing'].includes(c.status));
        const waiting = presidentSuspensionRecommendations().filter((a) => a.driverId === complaint.driverId && isAwaitingAdmin(a)
            && (a.complaintId ? a.complaintId === complaint.id : otherOpenCases.length === 0));
        return settleRecommendations(waiting, 'REJECTED', note || 'Case closed without a suspension.');
    }

    // Everything that shows the president's recommendations, refreshed whenever
    // they, the complaints or the driver list change.
    function refreshRecommendationUi() {
        renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));
        const modal = document.getElementById('complaintViewModal');
        if (currentComplaintData && modal && modal.classList.contains('active')) {
            renderPresidentRecommendation(currentComplaintData);
            renderCaseRisk(currentComplaintData);
        }
    }

    // The "TODA President Recommendation" block in the case window: what the
    // president recommended for the driver and why, plus any warning or
    // "invalid" mark they attached to this complaint.
    async function renderPresidentRecommendation(complaint) {
        const box = document.getElementById('c-toda-rec-box');
        if (!box) return;
        const complaintId = complaint.id;

        let linked = [];
        try {
            linked = await ParaFirestore.fetchDriverActionsForComplaint(complaintId);
        } catch (error) {
            console.error('Failed to load the president recommendation:', error);
        }
        if (!currentComplaintData || currentComplaintData.id !== complaintId) return; // another case was opened meanwhile

        const suspensionHeading = (action) => {
            const status = String(action.status || '').toUpperCase();
            // "Request further review": the president wants the admin to look
            // at the driver without naming a penalty.
            if (action.actionType === 'Further Review') {
                if (status === 'APPROVED') return { text: 'Requested further review — the driver was suspended', color: '#EE5D50' };
                if (status === 'REJECTED') return { text: 'Requested further review — the case was closed', color: 'var(--text-muted)' };
                return { text: 'Requests further review of the driver', color: '#FF9E2A' };
            }
            if (status === 'APPROVED') return { text: 'Recommended suspending the driver — the driver was suspended', color: '#EE5D50' };
            if (status === 'REJECTED') return { text: 'Recommended suspending the driver — the case was closed without one', color: 'var(--text-muted)' };
            return { text: 'Recommends suspending the driver', color: '#EE5D50' };
        };
        const entries = [
            ...suspensionRecommendationsFor(complaint).map((action) => ({ action, ...suspensionHeading(action) })),
            ...linked
                .filter((a) => a.actionType !== 'Suspension' && a.actionType !== 'Further Review' && a.issuedByRole !== 'ADMIN' && a.issuedBy !== user.uid)
                .map((action) => ({
                    action,
                    text: action.actionType === 'Warning' ? 'Issued a warning to the driver' : (action.actionType === 'Invalid' ? 'Marked the driver report as invalid' : action.actionType),
                    color: action.actionType === 'Warning' ? '#FF9E2A' : 'var(--text-main)'
                }))
        ];

        box.innerHTML = entries.length
            ? entries.map(({ action, text, color }) => `<div style="padding:2px 0;">
                    <div style="font-weight:600; color:${color};">${escapeHtml(text)}</div>
                    <div class="detail-sub" style="margin-top:4px; line-height:1.5;">${escapeHtml(action.issuedByName || 'TODA president')} · ${escapeHtml(formatActionTime(action.issuedAt))}</div>
                    ${action.reason ? `<div style="margin-top:6px; font-size:13px; line-height:1.5;">“${escapeHtml(action.reason)}”</div>` : ''}
                </div>`).join('<hr style="border:none; border-top:1px solid var(--border-color); margin:10px 0;">')
            : '<div style="font-weight:600; color:var(--text-muted);">No recommendation from the TODA president</div>';
    }
    // ── Case report (PDF) ────────────────────────────────────────
    // A printable record of one complaint case — who, what, which trip, what the
    // president recommended and what the admin did — for documentation and for
    // handing to the police on serious cases (assault, harassment). Everything
    // in it comes from data already in Firestore; nothing is added or inferred.
    window.exportComplaintPdf = async function() {
        const complaint = currentComplaintData;
        if (!complaint) return;
        if (!window.jspdf || !window.jspdf.jsPDF) {
            window.showToast('PDF library failed to load.', 'error');
            return;
        }
        const btn = document.getElementById('complaintExportBtn');
        if (btn) btn.disabled = true;

        try {
            let linked = [];
            try {
                linked = await ParaFirestore.fetchDriverActionsForComplaint(complaint.id);
            } catch (error) {
                console.error('Failed to load case actions for the PDF:', error);
            }

            const driver = (window.allDriversForLookup || []).find((d) => d.id === complaint.driverId)
                || (window.driverManagementDrivers || []).find((d) => d.id === complaint.driverId) || null;
            const passenger = (window.allPassengers || []).find((p) => p.id === complaint.passengerId) || null;
            const booking = complaint.bookingId
                ? (window.allBookings || []).find((b) => b.id === complaint.bookingId || b.ref === complaint.bookingId) || null
                : null;
            const otherCases = allComplaints.filter((c) => c.driverId === complaint.driverId && c.id !== complaint.id);

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ unit: 'mm', format: 'a4' });
            const M = 15;
            const W = 210 - M * 2;
            const TOP = 20; // first line on the pages after the first
            const BOTTOM = 278;
            const NAVY = [27, 37, 75];
            const MUTED = [110, 120, 150];
            const RULE = [226, 231, 242];
            const PANEL = [244, 247, 252];
            let y = M;

            // jsPDF's built-in fonts only cover Latin-1 (no peso sign, no emoji).
            const clean = (value) => String(value ?? '').replace(/[^ -~ -ÿ–—‘’“”…•\n]/g, '?');
            const ensure = (height) => {
                if (y + height > BOTTOM) {
                    doc.addPage();
                    y = TOP;
                }
            };
            // `keep` = space the section's first rows need, so a heading never
            // sits alone at the bottom of a page and short sections stay together.
            const heading = (text, keep = 18) => {
                ensure(keep);
                y += 3;
                doc.setFillColor(...NAVY);
                doc.rect(M, y - 0.4, 1.4, 5.4, 'F');
                doc.setFont(undefined, 'bold');
                doc.setFontSize(10);
                doc.setTextColor(...NAVY);
                doc.text(clean(text).toUpperCase(), M + 4, y + 3.8);
                doc.setDrawColor(...RULE);
                doc.setLineWidth(0.3);
                doc.line(M, y + 7.2, M + W, y + 7.2);
                y += 10;
            };
            // A label and its value, with a hairline under the row.
            const field = (label, value) => {
                const lines = doc.splitTextToSize(clean(value === undefined || value === null || value === '' ? '—' : value), W - 54);
                const rowHeight = lines.length * 4.4 + 2.2;
                ensure(rowHeight);
                doc.setFont(undefined, 'bold');
                doc.setFontSize(8.5);
                doc.setTextColor(...MUTED);
                doc.text(clean(label), M + 2, y + 3.4);
                doc.setFont(undefined, 'normal');
                doc.setFontSize(9.5);
                doc.setTextColor(...NAVY);
                lines.forEach((line, i) => doc.text(line, M + 52, y + 3.4 + i * 4.4));
                doc.setDrawColor(...RULE);
                doc.setLineWidth(0.15);
                doc.line(M, y + rowHeight - 0.3, M + W, y + rowHeight - 0.3);
                y += rowHeight;
            };
            const paragraph = (text, { size = 10, indent = 2 } = {}) => {
                doc.setFont(undefined, 'normal');
                doc.setFontSize(size);
                doc.setTextColor(...NAVY);
                doc.splitTextToSize(clean(text || '—'), W - indent * 2).forEach((line) => {
                    ensure(5);
                    doc.text(line, M + indent, y + 3.4);
                    y += 5;
                });
                y += 1;
            };
            // The passenger's own words: a tinted block with an accent bar.
            const quote = (text) => {
                doc.setFont(undefined, 'normal');
                doc.setFontSize(10);
                y += 1;
                doc.splitTextToSize(clean(text || '—'), W - 10).forEach((line) => {
                    ensure(5.4);
                    doc.setFillColor(...PANEL);
                    doc.rect(M, y, W, 5.4, 'F');
                    doc.setFillColor(...NAVY);
                    doc.rect(M, y, 1.2, 5.4, 'F');
                    doc.setTextColor(...NAVY);
                    doc.text(line, M + 5, y + 3.9);
                    y += 5.4;
                });
                y += 2;
            };
            const peso = (value) => `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const when = (value) => (value ? ParaFirestore.formatDateTime(value) : '—');
            const statusText = complaintStatusLabel(complaint.status);
            const caseStatus = statusText ? statusText.charAt(0).toUpperCase() + statusText.slice(1) : '—';
            const statusKey = ParaFirestore.normalizeStatus(complaint.status);
            const statusColor = statusKey === 'resolved' ? [5, 150, 110] : statusKey === 'rejected' ? MUTED : [200, 120, 0];

            // Title band
            doc.setFillColor(...NAVY);
            doc.rect(0, 0, 210, 30, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFont(undefined, 'bold');
            doc.setFontSize(19);
            doc.text('PARA Complaint Case Report', M, 14);
            doc.setFont(undefined, 'normal');
            doc.setFontSize(11);
            doc.setTextColor(200, 210, 235);
            doc.text(clean(`Case ${complaint.ref}`), M, 22.5);
            doc.setFontSize(8.5);
            doc.text(clean(`Generated ${ParaFirestore.formatDateTime(new Date())} by ${window.ParaAdminName || 'PARA Admin'}`), 210 - M, 22.5, { align: 'right' });

            // Four summary boxes
            const gap = 4;
            const boxW = (W - gap * 3) / 4;
            const box = (x, label, value, color) => {
                doc.setFillColor(...PANEL);
                doc.roundedRect(x, 38, boxW, 17, 2, 2, 'F');
                doc.setFont(undefined, 'normal');
                doc.setFontSize(7.5);
                doc.setTextColor(...MUTED);
                doc.text(label.toUpperCase(), x + 4, 44);
                doc.setFont(undefined, 'bold');
                doc.setFontSize(10);
                doc.setTextColor(...(color || NAVY));
                doc.text(doc.splitTextToSize(clean(value || '—'), boxW - 6)[0], x + 4, 51);
            };
            const filedShort = complaint.createdAtRaw
                ? new Date(complaint.createdAtRaw).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : '—';
            [['Case reference', complaint.ref], ['Status', caseStatus, statusColor], ['Complaint type', complaint.issue], ['Date filed', filedShort]]
                .forEach(([label, value, color], i) => box(M + i * (boxW + gap), label, value, color));
            y = 58;

            if ((complaint.ref !== complaint.id) || complaint.updatedAtRaw || complaint.resolvedAtRaw) {
                heading('Case record', 14);
                if (complaint.ref !== complaint.id) field('Record ID', complaint.id);
                field('Date and time filed', when(complaint.createdAtRaw));
                if (complaint.updatedAtRaw) field('Last updated', when(complaint.updatedAtRaw));
                if (complaint.resolvedAtRaw) field('Closed on', when(complaint.resolvedAtRaw));
            }

            heading('Description of the incident (as reported by the passenger)');
            quote(complaint.description);

            heading('Complainant (passenger)');
            field('Name', complaint.reporter);
            field('Mobile number', passenger && passenger.phone);
            field('Email', passenger && passenger.email);
            field('Account ID', complaint.passengerId);

            heading('Driver reported');
            field('Name', complaint.reported);
            field('Mobile number', driver && driver.phone);
            field('Email', driver && driver.email);
            field('Account ID', complaint.driverId);
            field('Driver\'s license no.', driver && driver.license);
            field('License expiry', driver && driver.licenseExpiry);
            field('Government ID no.', driver && driver.governmentId);
            field('Tricycle number', driver && driver.vehicle);
            field('Motorcycle model', driver && driver.motorcycleModel);
            field('Plate number', driver && driver.plate);
            const risk = riskOf(complaint.driverId);
            field('Risk score', risk ? `${Math.round(risk.score)} / 100 (${risk.level}) - suggests: ${risk.suggestedAction}` : 'Not scored yet');
            if (risk && risk.reasons.length) field('Risk reasons', risk.reasons.join('; '));
            field('Account status', driver ? (driver.accountStatus === 'suspended'
                ? `Suspended${driver.suspendedUntilRaw ? ` until ${ParaFirestore.formatDateTime(driver.suspendedUntilRaw)}` : ' indefinitely'}${driver.suspensionReason ? ` - ${driver.suspensionReason}` : ''}`
                : 'Active') : '');

            heading('Trip details', 75);
            if (booking) {
                field('Booking reference', booking.ref);
                field('Booked on', when(booking.createdAtRaw));
                field('Trip status', String(booking.status || '').toUpperCase());
                field('Pickup', booking.pickupLocation);
                field('Destination', booking.dropoffLocation);
                if (booking.arrivedAtRaw) field('Driver arrived at', when(booking.arrivedAtRaw));
                if (booking.completedAtRaw) field('Dropped off at', when(booking.completedAtRaw));
                // Where the driver was at each step (GPS saved by the app), for the record.
                const awayText = (point, pin, label) => (point ? (pin ? `${fmtDistance(distanceM(point, pin))} from the ${label}` : 'Recorded (no pin to compare)') : 'Not recorded');
                field('Driver location at Arrived', awayText(booking.arrivedLatLng, booking.pickupLatLng, 'pickup'));
                field('Driver location at drop-off', awayText(booking.completedLatLng, booking.destinationLatLng, 'destination'));
                if (booking.endedEarly) {
                    field('Ended early', `Yes${booking.earlyEndReviewedAtRaw ? ` - reviewed ${when(booking.earlyEndReviewedAtRaw)}` : ' - not yet reviewed'}${booking.earlyEndReviewNote ? ` - ${booking.earlyEndReviewNote}` : ''}`);
                }
                field('Fare', peso(booking.totalFare));
                field('Payment', [booking.paymentMethod, booking.paymentStatus && String(booking.paymentStatus).toUpperCase()].filter(Boolean).join(' - '));
            } else if (complaint.bookingId) {
                field('Booking reference', complaint.bookingId);
                paragraph('The details of this booking are not available in the admin panel.', { size: 9 });
            } else {
                paragraph('No trip is linked to this complaint.', { size: 9 });
            }

            heading('Other complaints against this driver');
            if (otherCases.length) {
                const widths = [40, 62, 28, 50];
                const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
                ensure(18);
                doc.setFillColor(...PANEL);
                doc.rect(M, y, W, 6.5, 'F');
                doc.setFont(undefined, 'bold');
                doc.setFontSize(8);
                doc.setTextColor(...MUTED);
                ['Case', 'Issue', 'Status', 'Filed'].forEach((h, i) => doc.text(h, xs[i] + 2, y + 4.5));
                y += 6.5;
                otherCases.slice(0, 15).forEach((c) => {
                    ensure(7);
                    doc.setFont(undefined, 'normal');
                    doc.setFontSize(8.5);
                    doc.setTextColor(...NAVY);
                    [c.ref, c.issue, complaintStatusLabel(c.status).replace(/^./, (ch) => ch.toUpperCase()), when(c.createdAtRaw)].forEach((value, i) => {
                        doc.text(doc.splitTextToSize(clean(value || '—'), widths[i] - 3)[0], xs[i] + 2, y + 4.6);
                    });
                    doc.setDrawColor(...RULE);
                    doc.setLineWidth(0.15);
                    doc.line(M, y + 7, M + W, y + 7);
                    y += 7;
                });
                if (otherCases.length > 15) paragraph(`...and ${otherCases.length - 15} more.`, { size: 9 });
            } else {
                paragraph('None on record.', { size: 9 });
            }

            // One recorded action: when it happened on the left, what it was on the right.
            const timeline = (timeText, text, reason) => {
                const lines = doc.splitTextToSize(clean(text), W - 50);
                const reasonLines = reason ? doc.splitTextToSize(clean(`Reason: "${reason}"`), W - 50) : [];
                const rowHeight = (lines.length + reasonLines.length) * 4.6 + 3;
                ensure(rowHeight);
                doc.setFont(undefined, 'normal');
                doc.setFontSize(8.5);
                doc.setTextColor(...MUTED);
                doc.text(clean(timeText), M + 2, y + 3.6);
                doc.setFont(undefined, 'bold');
                doc.setFontSize(9.5);
                doc.setTextColor(...NAVY);
                lines.forEach((line, i) => doc.text(line, M + 48, y + 3.6 + i * 4.6));
                doc.setFont(undefined, 'normal');
                doc.setTextColor(...MUTED);
                reasonLines.forEach((line, i) => doc.text(line, M + 48, y + 3.6 + (lines.length + i) * 4.6));
                doc.setDrawColor(...RULE);
                doc.setLineWidth(0.15);
                doc.line(M, y + rowHeight - 0.4, M + W, y + rowHeight - 0.4);
                y += rowHeight;
            };

            heading('TODA president recommendation and actions taken');
            const seen = new Set();
            const entries = [...suspensionRecommendationsFor(complaint), ...linked]
                .filter((a) => !seen.has(a.id) && seen.add(a.id))
                .sort((a, b) => a.issuedAt - b.issuedAt);
            if (entries.length) {
                entries.forEach((action) => {
                    const admin = isAdminAction(action);
                    const who = admin ? 'PARA admin' : 'TODA president';
                    let label;
                    if (admin) {
                        label = action.actionType === 'Suspension' ? 'Suspended the driver'
                            : action.actionType === 'Warning' ? 'Issued a warning to the driver'
                            : action.actionType === 'Invalid' ? 'Marked the report as invalid' : action.actionType;
                    } else if (action.actionType === 'Suspension') {
                        const outcome = action.status === 'APPROVED' ? ' (the driver was suspended)'
                            : action.status === 'REJECTED' ? ' (the case was closed without a suspension)' : ' (awaiting admin)';
                        label = `Recommended suspending the driver${outcome}`;
                    } else if (action.actionType === 'Further Review') {
                        const outcome = action.status === 'APPROVED' ? ' (the driver was suspended)'
                            : action.status === 'REJECTED' ? ' (the case was closed)' : ' (awaiting admin)';
                        label = `Requested further review of the driver${outcome}`;
                    } else {
                        label = action.actionType === 'Warning' ? 'Issued a warning to the driver'
                            : action.actionType === 'Invalid' ? 'Marked the driver report as invalid' : action.actionType;
                    }
                    timeline(formatActionTime(action.issuedAt), `${who}${action.issuedByName ? ` (${action.issuedByName})` : ''}: ${label}`, action.reason);
                });
            } else {
                paragraph('Nothing recorded for this case.', { size: 9 });
            }

            heading('Admin resolution note');
            quote(complaint.adminNotes || 'No note entered.');

            // Sign-off block for the printed copy.
            ensure(30);
            y += 8;
            doc.setDrawColor(160, 170, 190);
            doc.line(M, y + 12, M + 70, y + 12);
            doc.line(M + 100, y + 12, M + 100 + 60, y + 12);
            doc.setFontSize(8.5);
            doc.setTextColor(110, 120, 150);
            doc.text('Prepared by (name and signature)', M, y + 17);
            doc.text('Date', M + 100, y + 17);

            // Confidentiality notice: one sentence in a black-outlined white box at the
            // bottom of the last page (on a new page if the sign-off leaves no room).
            const noticeLines = doc.splitTextToSize('This report is confidential. It contains personal information and is intended only for documentation and for reporting to the proper authorities.', W - 16);
            const noticeHeight = noticeLines.length * 4.8 + 9;
            const noticeBottom = 279;
            if (y + 17 + 8 > noticeBottom - noticeHeight) doc.addPage();
            const noticeTop = noticeBottom - noticeHeight;
            doc.setFillColor(255, 255, 255);
            doc.setDrawColor(0, 0, 0);
            doc.setLineWidth(0.5);
            doc.roundedRect(M, noticeTop, W, noticeHeight, 1.5, 1.5, 'FD');
            doc.setFont(undefined, 'normal');
            doc.setFontSize(9);
            doc.setTextColor(0, 0, 0);
            doc.text(noticeLines, M + W / 2, noticeTop + 6.4, { align: 'center' });
            doc.setLineWidth(0.2);

            // Running header (after the first page) and footer on every page
            const pages = doc.getNumberOfPages();
            for (let i = 1; i <= pages; i++) {
                doc.setPage(i);
                doc.setFont(undefined, 'normal');
                doc.setFontSize(8);
                doc.setTextColor(...MUTED);
                doc.setDrawColor(...RULE);
                doc.setLineWidth(0.2);
                if (i > 1) {
                    doc.text(clean(`PARA Complaint Case Report · ${complaint.ref}`), M, 11);
                    doc.line(M, 14, M + W, 14);
                }
                doc.line(M, 284, M + W, 284);
                doc.text(clean(`PARA Admin · Case ${complaint.ref} · Confidential`), M, 289);
                doc.text(`Page ${i} of ${pages}`, 210 - M, 289, { align: 'right' });
            }

            const safeRef = String(complaint.ref || complaint.id).replace(/[^A-Za-z0-9_-]+/g, '_');
            doc.save(`complaint-case-${safeRef}.pdf`);
            window.showToast('Case report exported.', 'success');
        } catch (error) {
            console.error('Failed to export the case report:', error);
            window.showToast('Could not export the case report.', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
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
        refreshRecommendationUi();
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
        refreshTripModal();
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
        refreshRecommendationUi();
        refreshDriverDetails();
        refreshPassengerDetails();
        refreshTripModal();
    });
    // Risk scores update on their own (when a complaint comes in, a rating, a
    // report, a decision — and nightly): redraw everything that shows one.
    ParaFirestore.listenDriverRisk((scores) => {
        driverRisk.clear();
        scores.forEach((risk) => driverRisk.set(risk.driverId, risk));
        if (window.driverManagementDrivers) renderDriverManagementTable(window.driverManagementDrivers);
        renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));
        refreshDriverDetails();
        const caseModal = document.getElementById('complaintViewModal');
        if (currentComplaintData && caseModal && caseModal.classList.contains('active')) renderCaseRisk(currentComplaintData);
    });
    ParaFirestore.listenWarnings((actions) => {
        warningActions = actions;
        renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter));
    });
    ParaFirestore.listenSuspensionRequests((actions) => {
        suspensionActions = actions;
        refreshRecommendationUi();
        if (suspensionRepairDone) return;
        suspensionRepairDone = true;
        ParaFirestore.fetchAdminIds().then((ids) => {
            suspensionAdminIds = ids;
            refreshRecommendationUi();
            return ParaFirestore.repairAdminSuspensionStatus(suspensionActions, ids);
        }).catch((error) => console.error('Failed to tidy older suspension records:', error));
    });

    loadDashboardStats();
    loadFareSettings();
    loadTodaPresidentAccounts();
    loadNotificationHistory();

    // ── Top-bar search ───────────────────────────────────────────
    // On the list pages (Driver Management, Passenger Management, Complaints and
    // Booking Records) the search box filters that page's list as you type.
    const globalSearchInput = document.getElementById('globalSearchInput');

    const SEARCH_REDRAW = {
        'view-driver-management': () => renderDriverManagementTable(window.driverManagementDrivers || []),
        'view-passenger-management': () => { passengerTablePage = 1; renderPassengerTable(window.allPassengers || []); },
        'view-complaints': () => { complaintTablePage = 1; renderComplaintTable(getComplaintsForFilter(window.complaintMgmtStatusFilter)); },
        'view-bookings': () => { bookingTablePage = 1; renderBookingTable(window.allBookings || []); }
    };

    // Called when another page is opened: the typed text is cleared, so the lists show everything again.
    window.resetListSearch = function() {
        if (!listSearchTerm) return;
        listSearchTerm = '';
        Object.values(SEARCH_REDRAW).forEach((redraw) => redraw());
    };

    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => {
            const redraw = SEARCH_REDRAW[document.querySelector('.view-section.active')?.id];
            if (!redraw) return;
            listSearchTerm = e.target.value.trim().toLowerCase();
            redraw();
        });
    }
});
