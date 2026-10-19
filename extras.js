// Admin views for features the mobile app added later: appeals, passenger
// reports, flood hazards, money ledgers, ratings and messages. Kept apart from
// firestore-ui.js so those screens can change without touching the big file.
// Everything here reads straight from Firestore through ParaFirestore.db and
// writes only the fields the rules and Cloud Functions expect from the admin
// (see docs/admin-complaints-reports-appeals.md in the app repo).
(async function () {
    const user = await ParaFirestore.requireAdmin();
    if (!user) return;
    const db = ParaFirestore.db;

    const FLOOD_REPORT_LIFETIME_MS = 3 * 60 * 60 * 1000;

    // ── Small helpers ────────────────────────────────────────────────
    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function toMs(value) {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        if (value.toMillis) return value.toMillis();
        if (value.toDate) return value.toDate().getTime();
        const parsed = new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function fmtDate(value) {
        const ms = toMs(value);
        if (!ms) return '—';
        const date = new Date(ms);
        return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    }

    function peso(value) {
        return '₱' + (Number(value) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type);
    }

    function emptyRow(colspan, message) {
        return `<tr><td colspan="${colspan}" style="text-align:center; color:var(--text-muted); padding:28px;">${esc(message)}</td></tr>`;
    }

    function badge(className, label) {
        return `<span class="status-badge ${className}">${esc(label)}</span>`;
    }

    function setBadge(viewName, count) {
        const el = document.querySelector(`[data-view="${viewName}"] .nav-badge`);
        if (!el) return;
        el.textContent = count || '';
        el.classList.toggle('hidden', !count);
    }

    function row(label, value) {
        const shown = value === undefined || value === null || value === '' ? '—' : value;
        return `<div class="dd-row"><span class="dd-row-label">${esc(label)}</span><span class="dd-row-value">${shown}</span></div>`;
    }

    function bindClicks(container, handlers) {
        if (!container || container.dataset.xBound) return;
        container.dataset.xBound = '1';
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-x]');
            if (!btn || !container.contains(btn)) return;
            const handler = handlers[btn.dataset.x];
            if (handler) handler(btn.dataset);
        });
    }

    // ── People: names for ids ────────────────────────────────────────
    const people = new Map();
    const peopleListeners = [];

    function personName(id) {
        const person = people.get(id);
        return person ? person.name : (id ? id.slice(0, 8) + '…' : '—');
    }

    db.collection('users').onSnapshot((snapshot) => {
        people.clear();
        snapshot.docs.forEach((doc) => {
            const d = doc.data() || {};
            const composed = `${d.firstName || ''} ${d.lastName || ''}`.trim();
            people.set(doc.id, {
                id: doc.id,
                name: d.fullName || d.name || composed || d.email || doc.id,
                role: String(d.role || '').toUpperCase(),
                todaName: d.todaName || '',
                accountStatus: d.accountStatus || '',
                suspensionReason: d.suspensionReason || '',
                suspendedAt: d.suspendedAt || null,
                reportCount: Number(d.reportCount) || 0,
                lastReportedAt: d.lastReportedAt || 0,
                commissionOwed: Number(d.commissionOwed) || 0,
                commissionDueAt: Number(d.commissionDueAt) || 0
            });
        });
        peopleListeners.forEach((fn) => fn());
    }, (error) => console.error('Could not load users for the new views:', error));

    // ── One shared modal for the detail screens ──────────────────────
    const modal = document.getElementById('xModal');
    const modalTitle = document.getElementById('xModalTitle');
    const modalBody = document.getElementById('xModalBody');
    const modalFooter = document.getElementById('xModalFooter');

    function openModal(title, bodyHtml, footerHtml) {
        modalTitle.textContent = title;
        modalBody.innerHTML = bodyHtml;
        modalFooter.innerHTML = footerHtml || '';
        modalFooter.style.display = footerHtml ? '' : 'none'; // the X at the top right closes it
        modal.classList.add('active');
    }

    function closeModal() {
        modal.classList.remove('active');
    }

    window.closeXModal = closeModal;

    // A case or trip opened from an appeal or report window: when it is closed, the
    // window it was opened from comes back instead of everything closing.
    let reopenCurrent = null; // reopens the appeal / report window now showing
    let returnTo = null; // { modalId, reopen, seen }

    function watchForReturn(modalId) {
        const el = document.getElementById(modalId);
        if (!el) return;
        new MutationObserver(() => {
            if (!returnTo || returnTo.modalId !== modalId) return;
            if (el.classList.contains('active')) { returnTo.seen = true; return; }
            if (!returnTo.seen) return;
            const reopen = returnTo.reopen;
            returnTo = null;
            reopen();
        }).observe(el, { attributes: true, attributeFilter: ['class'] });
    }

    async function openOver(modalId, open) {
        // Anything typed in the window is kept for when it comes back.
        const noteBox = document.getElementById('xAppealNote') || document.getElementById('xReportNote');
        const draft = noteBox ? noteBox.value : '';
        const back = reopenCurrent;
        const reopen = async () => {
            if (back) await back();
            const box = document.getElementById('xAppealNote') || document.getElementById('xReportNote');
            if (box && draft && !box.disabled) box.value = draft;
        };
        closeModal();
        returnTo = { modalId, reopen, seen: false };
        try { await open(); } catch (error) { console.error('Could not open it:', error); }
        // It never opened (nothing found): don't leave the admin with no window.
        const el = document.getElementById(modalId);
        if (returnTo && returnTo.modalId === modalId && !returnTo.seen && !(el && el.classList.contains('active'))) {
            returnTo = null;
            reopen();
        }
    }

    // ── Appeals ──────────────────────────────────────────────────────
    let appeals = [];
    let appealFilter = 'PENDING';
    let appealSearch = ''; // typed in the top-bar search box on the Appeals tab

    function appealStatusBadge(status) {
        if (status === 'UPHELD') return badge('declined', 'DENIED');
        if (status === 'OVERTURNED') return badge('approved', 'GRANTED');
        return badge('processing', 'PENDING');
    }

    function renderAppeals() {
        const tbody = document.getElementById('appealsBody');
        if (!tbody) return;
        const matches = (a) => !appealSearch || [personName(a.userId), a.role, a.todaName, a.statement, a.status, a.status === 'UPHELD' ? 'denied' : a.status === 'OVERTURNED' ? 'granted' : '', a.presidentStatement]
            .some((value) => String(value || '').toLowerCase().includes(appealSearch));
        const list = appeals
            .filter((a) => appealFilter === 'ALL' || a.status === appealFilter)
            .filter(matches)
            .sort((a, b) => b.createdAt - a.createdAt);
        if (!list.length) {
            tbody.innerHTML = emptyRow(6, appealSearch ? 'No appeals match your search.' : appealFilter === 'PENDING' ? 'No appeals waiting for a decision.' : 'No appeals found.');
            return;
        }
        tbody.innerHTML = list.map((a) => `
            <tr>
                <td><div class="detail-main">${esc(personName(a.userId))}</div><div class="detail-sub">${esc(a.role || '—')}${a.todaName ? ' · ' + esc(a.todaName) : ''}</div></td>
                <td><div class="detail-main">${a.subjectType === 'DRIVER_ACTION' ? 'Driver warning or suspension' : 'Account suspension'}</div></td>
                <td><div class="detail-sub" style="max-width:320px;">${esc((a.statement || '').slice(0, 140))}${(a.statement || '').length > 140 ? '…' : ''}</div></td>
                <td>${esc(fmtDate(a.createdAt))}</td>
                <td>${appealStatusBadge(a.status)}${a.presidentStatement ? '<div class="detail-sub" style="margin-top:6px;">President statement added</div>' : ''}</td>
                <td><button class="action-btn" data-x="view-appeal" data-id="${esc(a.id)}">${a.status === 'PENDING' ? 'Review' : 'View'}</button></td>
            </tr>`).join('');
    }

    function initialsOf(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
    }

    const rowIf = (label, value) => value ? row(label, value) : '';

    // What the appeal is about, as rows (empty ones left out) and notes for the admin.
    async function decisionParts(appeal) {
        const pending = appeal.status === 'PENDING';
        if (appeal.subjectType === 'DRIVER_ACTION') {
            const snap = await db.collection('driver_actions').doc(appeal.subjectId).get();
            if (!snap.exists) return { rows: '', notes: ['The driver action this appeal is about was not found.'] };
            const act = snap.data() || {};
            // Warnings are never approved or rejected, so they just read "Issued".
            const state = act.overturned ? 'Reversed on appeal'
                : act.actionType === 'Warning' || act.status === 'NOT_APPLICABLE' ? 'Issued'
                : String(act.status || '').charAt(0) + String(act.status || '').slice(1).toLowerCase();
            const rows = row('Decision', esc(act.actionType) + ' · ' + esc(state))
                + rowIf('Reason', esc(act.reason))
                + row('Issued', esc(fmtDate(act.issuedAt)) + (act.issuedByName ? ' by ' + esc(act.issuedByName) : ''))
                + rowIf('Reviewed', act.reviewedAt ? esc(fmtDate(act.reviewedAt)) : '')
                + rowIf('Admin note', esc(act.adminNote))
                + rowIf('Complaint', act.complaintId ? `<button type="button" class="action-btn" data-x-case="${esc(act.complaintId)}">View case</button>` : '');
            const notes = [];
            if (act.actionType === 'Suspension' && pending) notes.push('Granting this appeal also lifts the driver\'s current account suspension, whatever its reason.');
            return { rows, notes };
        }
        const person = people.get(appeal.userId);
        if (!person) return { rows: '', notes: ['The account this appeal is about was not found.'] };
        const stillSuspended = String(person.accountStatus).toLowerCase() === 'suspended';
        // An appeal is about one suspension, "<uid>_<suspendedAt ms>". Granting it only
        // lifts the account if that is still the suspension in place.
        const sameSuspension = appeal.subjectId === `${appeal.userId}_${toMs(person.suspendedAt)}`;
        const notes = [];
        if (pending && !stillSuspended) notes.push('This account is no longer suspended, so granting the appeal will change nothing.');
        else if (pending && !sameSuspension) notes.push('This account was suspended again after this appeal was filed. Granting it will not lift the current suspension.');
        const rows = row('Decision', 'Account suspension')
            + row('Account now', esc(person.accountStatus ? person.accountStatus.charAt(0).toUpperCase() + person.accountStatus.slice(1) : 'Active'))
            + rowIf('Suspended', person.suspendedAt ? esc(fmtDate(person.suspendedAt)) : '')
            + rowIf('Reason', esc(person.suspensionReason));
        return { rows, notes };
    }

    async function openAppeal(id) {
        const appeal = appeals.find((a) => a.id === id);
        if (!appeal) return;
        const open = appeal.status === 'PENDING';
        reopenCurrent = () => openAppeal(id);
        const decision = await decisionParts(appeal);
        const name = personName(appeal.userId);
        const role = appeal.role ? appeal.role.charAt(0) + appeal.role.slice(1).toLowerCase() : '';
        const sub = [role, appeal.todaName, 'Filed ' + fmtDate(appeal.createdAt)].filter(Boolean).map(esc).join(' · ');
        const presidentTitle = 'TODA president'
            + (appeal.presidentStatementBy ? ' · ' + personName(appeal.presidentStatementBy) : '')
            + (appeal.presidentStatementAt ? ' · ' + fmtDate(appeal.presidentStatementAt) : '');
        const body = `
            <div class="ap-head">
                <div class="ap-avatar">${esc(initialsOf(name))}</div>
                <div class="ap-who"><div class="ap-name">${esc(name)}</div><div class="ap-sub">${sub}</div></div>
                <div>${appealStatusBadge(appeal.status)}</div>
            </div>
            <div class="ap-section">
                <div class="ap-title">Decision being appealed</div>
                ${decision.rows ? `<div class="ap-card">${decision.rows}</div>` : ''}
                ${decision.notes.map((n) => `<div class="ap-alert">${esc(n)}</div>`).join('')}
            </div>
            <div class="ap-section">
                <div class="ap-title">Their statement</div>
                <blockquote class="ap-quote">${esc(appeal.statement)}</blockquote>
                ${appeal.presidentStatement ? `<div class="ap-title" style="margin-top:14px;">${esc(presidentTitle)}</div>
                    <blockquote class="ap-quote toda">${esc(appeal.presidentStatement)}</blockquote>` : ''}
            </div>
            <div class="ap-section">
                <div class="ap-title">${open ? 'Your note to the appellant' : 'Your decision' + (appeal.decidedAt ? ' · ' + esc(fmtDate(appeal.decidedAt)) : '')}</div>
                ${open
                    ? `<textarea id="xAppealNote" class="form-input" rows="3" maxlength="400" placeholder="Explain the decision. This is sent with the notification."></textarea>
                       <div class="detail-sub" style="margin-top:8px;">${appeal.subjectType === 'DRIVER_ACTION'
                            ? 'Granting the appeal reverses the decision automatically: the action is rejected, the complaint it came from (if any) is dismissed, and if it was a suspension the driver is reactivated.'
                            : 'Granting the appeal reactivates the account automatically.'}</div>`
                    : `<blockquote class="ap-quote ${appeal.status === 'OVERTURNED' ? 'granted' : 'denied'}">${esc(appeal.adminNote) || 'No note was written.'}</blockquote>`}
            </div>`;
        const footer = open
            ? `<button class="btn" style="background:#EE5D50;color:white;" data-x="decide" data-id="${esc(appeal.id)}" data-status="UPHELD">Deny appeal</button>
               <button class="btn" style="background:#05CD99;color:white;" data-x="decide" data-id="${esc(appeal.id)}" data-status="OVERTURNED">Grant appeal</button>`
            : '';
        openModal('Appeal review', body, footer);
    }
    async function decideAppeal(id, status) {
        const noteEl = document.getElementById('xAppealNote');
        const note = noteEl ? noteEl.value.trim() : '';
        if (!note) {
            toast('Please write a short note for the appellant.', 'warning');
            return;
        }
        const label = status === 'OVERTURNED' ? 'grant this appeal' : 'deny this appeal';
        if (!window.confirm(`Are you sure you want to ${label}? This cannot be undone.`)) return;
        try {
            // Only these three fields: the onAppealDecided function does the rest.
            await db.collection('appeals').doc(id).update({ status, adminNote: note, decidedAt: Date.now() });
            toast(status === 'OVERTURNED' ? 'Appeal granted.' : 'Appeal denied.', 'success');
            closeModal();
        } catch (error) {
            console.error('Failed to decide appeal:', error);
            toast('Could not save the decision.', 'error');
        }
    }

    db.collection('appeals').onSnapshot((snapshot) => {
        appeals = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                userId: d.userId || '',
                role: d.role || '',
                subjectType: d.subjectType || '',
                subjectId: d.subjectId || '',
                todaName: d.todaName || '',
                statement: d.statement || '',
                status: d.status || 'PENDING',
                createdAt: toMs(d.createdAt),
                presidentStatement: d.presidentStatement || '',
                presidentStatementBy: d.presidentStatementBy || '',
                presidentStatementAt: toMs(d.presidentStatementAt),
                adminNote: d.adminNote || '',
                decidedAt: toMs(d.decidedAt)
            };
        });
        // The pending count shows on the Appeals tab of the Complaints page.
        const appealsCount = document.getElementById('appealsCount');
        if (appealsCount) appealsCount.textContent = appeals.filter((a) => a.status === 'PENDING').length;
        renderAppeals();
    }, (error) => {
        console.error('Could not load appeals:', error);
        const tbody = document.getElementById('appealsBody');
        if (tbody) tbody.innerHTML = emptyRow(6, 'Could not load appeals.');
    });
    peopleListeners.push(renderAppeals);

    // Called by the top-bar search box while the Appeals tab is open.
    window.setAppealSearch = function (term) {
        appealSearch = String(term || '').trim().toLowerCase();
        renderAppeals();
    };

    window.setAppealFilter = function (value) {
        appealFilter = value;
        const label = document.getElementById('appealFilterLabel');
        if (label) label.textContent = value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase();
        renderAppeals();
    };

    // ── Passenger reports ────────────────────────────────────────────
    let passengerReports = [];
    let reportFilter = 'PENDING';
    let reportSearch = ''; // typed in the top-bar search box on the Passenger Reports tab

    function severityBadge(severity) {
        if (severity === 'SAFETY') return badge('declined', 'SAFETY');
        if (severity === 'HIGH') return badge('processing', 'HIGH');
        return '';
    }

    function reportStatusBadge(status) {
        if (status === 'RESOLVED') return badge('approved', 'RESOLVED');
        if (status === 'REJECTED') return badge('declined', 'DISMISSED');
        return badge('processing', 'PENDING');
    }

    const SEVERITY_ORDER = { SAFETY: 0, HIGH: 1, NORMAL: 2 };

    function renderPassengerReports() {
        const tbody = document.getElementById('passengerReportsBody');
        if (!tbody) return;
        const matches = (r) => !reportSearch || [personName(r.passengerId), personName(r.driverId), r.todaName, r.category, r.description, r.severity, r.status === 'REJECTED' ? 'dismissed' : r.status]
            .some((value) => String(value || '').toLowerCase().includes(reportSearch));
        const list = passengerReports
            .filter((r) => reportFilter === 'ALL' || r.status === reportFilter)
            .filter(matches)
            .sort((a, b) => ((a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1))
                || ((SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2))
                || b.createdAt - a.createdAt);
        if (!list.length) {
            tbody.innerHTML = emptyRow(6, reportSearch ? 'No passenger reports match your search.' : reportFilter === 'PENDING' ? 'No passenger reports waiting.' : 'No passenger reports found.');
            return;
        }
        tbody.innerHTML = list.map((r) => {
            const person = people.get(r.passengerId);
            const total = person ? person.reportCount : 0;
            const hot = person && (total >= 3 || passengerReports.some((x) => x.passengerId === r.passengerId && x.severity === 'SAFETY'));
            return `
            <tr>
                <td><div class="detail-main">${esc(personName(r.passengerId))}</div><div class="detail-sub" style="${hot ? 'color:#EE5D50; font-weight:600;' : ''}">${total} report${total === 1 ? '' : 's'} in total</div></td>
                <td><div class="detail-main">${esc(r.category)} ${severityBadge(r.severity)}</div><div class="detail-sub" style="max-width:300px;">${esc((r.description || '').slice(0, 120))}${(r.description || '').length > 120 ? '…' : ''}</div></td>
                <td>${esc(personName(r.driverId))}<div class="detail-sub">${esc(r.todaName)}</div></td>
                <td>${esc(fmtDate(r.createdAt))}</td>
                <td>${reportStatusBadge(r.status)}</td>
                <td><button class="action-btn" data-x="view-report" data-id="${esc(r.id)}">${r.status === 'PENDING' ? 'Review' : 'View'}</button></td>
            </tr>`;
        }).join('');
    }

    // The ride's reference, opening the trip window when the booking is loaded.
    function rideLink(bookingId) {
        const booking = (window.allBookings || []).find((b) => b.id === bookingId);
        if (!booking) return esc(bookingId);
        return `<a href="#" data-x-trip="${esc(bookingId)}">${esc(booking.ref)}</a>`;
    }

    function openReport(id) {
        const r = passengerReports.find((x) => x.id === id);
        if (!r) return;
        const open = r.status === 'PENDING';
        reopenCurrent = () => openReport(id);
        const person = people.get(r.passengerId);
        const name = personName(r.passengerId);
        const total = person ? person.reportCount : 0;
        const safetyCount = passengerReports.filter((x) => x.passengerId === r.passengerId && x.severity === 'SAFETY').length;
        const hot = total >= 3 || safetyCount > 0;
        const accountNow = person && person.accountStatus ? person.accountStatus.charAt(0).toUpperCase() + person.accountStatus.slice(1) : 'Active';
        const suspended = person && String(person.accountStatus).toLowerCase() === 'suspended';
        const body = `
            <div class="ap-head">
                <div class="ap-avatar">${esc(initialsOf(name))}</div>
                <div class="ap-who"><div class="ap-name">${esc(name)}</div><div class="ap-sub">Passenger · Filed ${esc(fmtDate(r.createdAt))}</div></div>
                <div>${reportStatusBadge(r.status)}</div>
            </div>
            ${r.severity === 'SAFETY' && open ? '<div class="ap-alert danger" style="margin-top:16px;">Safety report. Look at this one first.</div>' : ''}
            <div class="ap-section">
                <div class="ap-title">The report</div>
                <div class="ap-card">
                    ${row('Category', esc(r.category) + ' ' + severityBadge(r.severity))}
                    ${row('Reported by', esc(personName(r.driverId)) + (r.todaName ? ' · ' + esc(r.todaName) : ''))}
                    ${row('Ride', rideLink(r.bookingId))}
                </div>
            </div>
            <div class="ap-section">
                <div class="ap-title">What the driver wrote</div>
                <blockquote class="ap-quote">${esc(r.description) || 'The driver did not write anything.'}</blockquote>
            </div>
            <div class="ap-section">
                <div class="ap-title">About this passenger</div>
                <div class="ap-card">
                    ${row('Reports in total', `<span style="${hot ? 'color:#EE5D50;' : ''}">${total}</span>`)}
                    ${row('Safety reports', `<span style="${safetyCount ? 'color:#EE5D50;' : ''}">${safetyCount}</span>`)}
                    ${row('Account', esc(accountNow))}
                    ${person ? row('Passenger', `<button type="button" class="action-btn" data-x-passenger="${esc(r.passengerId)}">Open passenger</button>`) : ''}
                </div>
            </div>
            <div class="ap-section">
                <div class="ap-title">${open ? 'Your note (optional)' : 'Your decision' + (r.resolvedAt ? ' · ' + esc(fmtDate(r.resolvedAt)) : '')}</div>
                ${open
                    ? `<textarea id="xReportNote" class="form-input" rows="3" maxlength="400" placeholder="What was decided and why."></textarea>
                       <div class="detail-sub" style="margin-top:8px;">The passenger is never told who reported them. To act on a report, suspend the account${suspended ? ' (already suspended)' : ' from Open passenger'}; they can then appeal.</div>`
                    : `<blockquote class="ap-quote ${r.status === 'RESOLVED' ? 'granted' : 'denied'}">${esc(r.adminNote) || 'No note was written.'}</blockquote>`}
            </div>`;
        const footer = open
            ? `<button class="btn" style="background:var(--primary);color:white;" data-x="decide-report" data-id="${esc(r.id)}" data-status="REJECTED">Dismiss report</button>
               <button class="btn" style="background:#05CD99;color:white;" data-x="decide-report" data-id="${esc(r.id)}" data-status="RESOLVED">Mark resolved</button>`
            : '';
        openModal('Passenger report', body, footer);
    }
    async function decideReport(id, status) {
        const noteEl = document.getElementById('xReportNote');
        const note = noteEl ? noteEl.value.trim() : '';
        try {
            await db.collection('passenger_reports').doc(id).update({ status, adminNote: note, resolvedAt: Date.now() });
            toast(status === 'RESOLVED' ? 'Report marked resolved.' : 'Report dismissed.', 'success');
            closeModal();
        } catch (error) {
            console.error('Failed to update passenger report:', error);
            toast('Could not update the report.', 'error');
        }
    }

    db.collection('passenger_reports').onSnapshot((snapshot) => {
        passengerReports = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                bookingId: d.bookingId || doc.id,
                driverId: d.driverId || '',
                passengerId: d.passengerId || '',
                todaName: d.todaName || '',
                category: d.category || 'Report',
                severity: d.severity || 'NORMAL',
                description: d.description || '',
                status: d.status || 'PENDING',
                createdAt: toMs(d.createdAt),
                adminNote: d.adminNote || '',
                resolvedAt: toMs(d.resolvedAt)
            };
        });
        // The pending count shows on the Passenger Reports tab of the Complaints page.
        const reportsCount = document.getElementById('reportsCount');
        if (reportsCount) reportsCount.textContent = passengerReports.filter((r) => r.status === 'PENDING').length;
        renderPassengerReports();
    }, (error) => {
        console.error('Could not load passenger reports:', error);
        const tbody = document.getElementById('passengerReportsBody');
        if (tbody) tbody.innerHTML = emptyRow(6, 'Could not load passenger reports.');
    });
    peopleListeners.push(renderPassengerReports);

    // Called by the top-bar search box while the Passenger Reports tab is open.
    window.setReportSearch = function (term) {
        reportSearch = String(term || '').trim().toLowerCase();
        renderPassengerReports();
    };

    window.setReportFilter = function (value) {
        reportFilter = value;
        const label = document.getElementById('reportFilterLabel');
        if (label) label.textContent = value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase();
        renderPassengerReports();
    };

    // ── Flood hazards ────────────────────────────────────────────────
    let floodZones = [];
    let floodReports = [];

    const DEPTH_LABELS = { ANKLE: 'Ankle-deep', KNEE: 'Knee-deep', IMPASSABLE: 'Impassable' };

    function mapsLink(point) {
        if (!point || (!point.lat && !point.lng)) return '—';
        const text = `${Number(point.lat).toFixed(5)}, ${Number(point.lng).toFixed(5)}`;
        return `<a href="https://www.google.com/maps?q=${encodeURIComponent(point.lat + ',' + point.lng)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
    }

    function renderFlood() {
        const zonesBody = document.getElementById('floodZonesBody');
        const reportsBody = document.getElementById('floodReportsBody');
        if (zonesBody) {
            const zones = [...floodZones].sort((a, b) => b.updatedAt - a.updatedAt);
            zonesBody.innerHTML = zones.length ? zones.map((z) => `
                <tr>
                    <td><div class="detail-main">${esc(z.name || 'Unnamed area')}</div></td>
                    <td>${esc(z.todaName || '—')}</td>
                    <td>${z.boundary.length} corners</td>
                    <td>${z.boundary.length ? mapsLink(z.boundary[0]) : '—'}</td>
                    <td>${esc(fmtDate(z.updatedAt))}</td>
                    <td><button class="action-btn" style="background:#EE5D50;" data-x="delete-zone" data-id="${esc(z.id)}">Delete</button></td>
                </tr>`).join('') : emptyRow(6, 'No flood-prone areas have been drawn yet.');
        }
        if (reportsBody) {
            const now = Date.now();
            const reports = [...floodReports].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
            reportsBody.innerHTML = reports.length ? reports.map((r) => {
                const active = now - r.createdAt < FLOOD_REPORT_LIFETIME_MS;
                return `
                <tr>
                    <td><div class="detail-main">${esc(DEPTH_LABELS[r.depth] || r.depth || '—')}</div></td>
                    <td>${mapsLink(r.location)}</td>
                    <td>${esc(personName(r.reportedBy))}<div class="detail-sub">${esc(r.reporterRole || '')}</div></td>
                    <td>${esc(fmtDate(r.createdAt))}</td>
                    <td>${active ? badge('processing', 'ACTIVE') : badge('approved', 'EXPIRED')}</td>
                    <td><button class="action-btn" style="background:#EE5D50;" data-x="delete-flood-report" data-id="${esc(r.id)}">Delete</button></td>
                </tr>`;
            }).join('') : emptyRow(6, 'No flooded-road reports yet.');
        }
        const activeCount = floodReports.filter((r) => Date.now() - r.createdAt < FLOOD_REPORT_LIFETIME_MS).length;
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        setText('floodZoneCount', String(floodZones.length));
        setText('floodActiveCount', String(activeCount));
        setText('floodReportCount', String(floodReports.length));
    }

    db.collection('flood_zones').onSnapshot((snapshot) => {
        floodZones = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                name: d.name || '',
                todaName: d.todaName || '',
                boundary: Array.isArray(d.boundary) ? d.boundary : [],
                updatedAt: toMs(d.updatedAt)
            };
        });
        renderFlood();
    }, (error) => console.error('Could not load flood zones:', error));

    db.collection('flood_reports').orderBy('createdAt', 'desc').limit(300).onSnapshot((snapshot) => {
        floodReports = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                depth: d.depth || '',
                location: d.location || null,
                reportedBy: d.reportedBy || '',
                reporterRole: d.reporterRole || '',
                createdAt: toMs(d.createdAt)
            };
        });
        renderFlood();
    }, (error) => console.error('Could not load flood reports:', error));

    // Admins may delete any area or report (firestore.rules), e.g. a stale area or a
    // false report.
    async function deleteFloodDoc(collection, id, question) {
        if (!window.confirm(question)) return;
        try {
            await db.collection(collection).doc(id).delete();
            toast('Deleted.', 'success');
        } catch (error) {
            console.error('Could not delete from ' + collection + ':', error);
            toast('Could not delete it.', 'error');
        }
    }

    bindClicks(document.getElementById('floodZonesBody'), {
        'delete-zone': (ds) => deleteFloodDoc('flood_zones', ds.id, 'Delete this flood-prone area? Routes will stop being marked down for crossing it.')
    });
    bindClicks(document.getElementById('floodReportsBody'), {
        'delete-flood-report': (ds) => deleteFloodDoc('flood_reports', ds.id, 'Delete this flooded-road report? Routes will stop avoiding that spot.')
    });

    // Reports expire on their own, so redraw now and then to flip ACTIVE to EXPIRED.
    setInterval(renderFlood, 60000);
    peopleListeners.push(renderFlood);

    // ── Fees and commission ──────────────────────────────────────────
    // fee_ledger: one row per paid ride (cash when it completes, GCash when the
    // payment is captured). commission_ledger: a TRIP entry puts the PARA + TODA
    // share of a cash ride on the driver's tab (users.commissionOwed); drivers
    // settle the tab by GCash (commission_payments). All written by Cloud
    // Functions (functions/src/commission.ts, fees.ts).
    let feeRows = [];
    let tripRows = []; // commission_ledger TRIP entries: commission added by cash rides
    let commissionPayments = [];
    let gcashFilter = 'ALL'; // status tab on the GCash card
    let owedFilter = 'ALL'; // 'ALL', 'PENDING' (not due yet) or 'OVERDUE' on the balances card
    let settlementDays = 1;
    let ledgerFrom = 0;
    let ledgerTo = Infinity;

    function inRange(ms) {
        return ms >= ledgerFrom && ms <= ledgerTo;
    }

    function plural(n, word) {
        return `${n} ${word}${n === 1 ? '' : 's'}`;
    }

    function driverCell(id) {
        return `<td><div class="detail-main">${esc(personName(id))}</div><div class="detail-sub">${esc((people.get(id) || {}).todaName || '')}</div></td>`;
    }

    // Status of a GCash commission payment (commission.ts): PAID, PENDING,
    // FAILED, SUPERSEDED (a newer checkout replaced it) or PAID_ORPHAN (paid, but
    // the driver account was gone).
    function gcashGroup(p) {
        return p.status === 'PAID' || p.status === 'PAID_ORPHAN' ? 'PAID' : p.status === 'PENDING' ? 'PENDING' : 'OTHER';
    }

    function gcashBadge(status) {
        if (status === 'PAID' || status === 'PAID_ORPHAN') return badge('approved', 'PAID');
        if (status === 'PENDING') return badge('processing', 'PENDING');
        if (status === 'SUPERSEDED') return badge('neutral', 'REPLACED');
        return badge('declined', 'FAILED');
    }

    // fee_ledger stores each share rounded to the centavo. The percentages the ride
    // was booked with (12 / 4 / 4 by default) aren't stored, so work them back out of
    // the row (to the nearest 0.1%, which a centavo can't move on a fare of ₱10 or
    // more) and take the exact share of the fare. Totals then equal fare x percentage
    // on a calculator.
    function exactShares(row) {
        if (!(row.fare >= 10)) return row;
        const exact = (share) => row.fare * (Math.round(share / row.fare * 1000) / 1000);
        const paraShare = exact(row.paraShare);
        const todaShare = exact(row.todaShare);
        const driverShare = exact(row.driverShare);
        return { ...row, paraShare, todaShare, driverShare, serviceFee: paraShare + todaShare + driverShare };
    }

    // An amount with every decimal that matters (up to 4), never rounded to centavos.
    function pesoExact(value) {
        return '₱' + (Number(value) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    }

    function renderLedger() {
        const fees = feeRows.filter((r) => inRange(r.createdAt)).map(exactShares);
        const sum = (list, key) => list.reduce((total, r) => total + (Number(r[key]) || 0), 0);
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        const totalFee = sum(fees, 'serviceFee');
        // The shares are percentages of the ride fare (12 / 4 / 4 by default), not of the fee.
        const totalFare = sum(fees, 'fare');
        const pct = (part) => totalFare > 0 ? (part / totalFare * 100).toFixed(1) + '% of fares' : '—';
        setText('ledgerFares', pesoExact(totalFare));
        setText('ledgerRidesNote', plural(fees.length, 'completed ride'));
        setText('ledgerFeePct', pct(totalFee));
        setText('ledgerServiceFee', pesoExact(totalFee));
        setText('ledgerPara', pesoExact(sum(fees, 'paraShare')));
        setText('ledgerParaPct', pct(sum(fees, 'paraShare')));
        setText('ledgerToda', pesoExact(sum(fees, 'todaShare')));
        setText('ledgerTodaPct', pct(sum(fees, 'todaShare')));
        setText('ledgerDriver', pesoExact(sum(fees, 'driverShare')));
        setText('ledgerDriverPct', pct(sum(fees, 'driverShare')));

        // PARA owes each TODA its share (paid outside the app for now).
        const byToda = new Map();
        fees.forEach((r) => {
            const key = r.todaName || '(no TODA)';
            const entry = byToda.get(key) || { rides: 0, todaShare: 0, paraShare: 0, serviceFee: 0 };
            entry.rides += 1;
            entry.todaShare += Number(r.todaShare) || 0;
            entry.paraShare += Number(r.paraShare) || 0;
            entry.serviceFee += Number(r.serviceFee) || 0;
            byToda.set(key, entry);
        });
        const todaBody = document.getElementById('ledgerTodaBody');
        if (todaBody) {
            const rows = [...byToda.entries()].sort((a, b) => b[1].todaShare - a[1].todaShare);
            todaBody.innerHTML = rows.length ? rows.map(([name, e]) => `
                <tr><td><div class="detail-main">${esc(name)}</div></td><td class="num">${e.rides}</td><td class="num">${pesoExact(e.serviceFee)}</td><td class="num">${pesoExact(e.paraShare)}</td><td class="num"><strong>${pesoExact(e.todaShare)}</strong></td></tr>`).join('')
                : emptyRow(5, 'No service-fee rows in this period.');
        }
        const todaFoot = document.getElementById('ledgerTodaFoot');
        if (todaFoot) {
            const all = [...byToda.values()];
            const add = (key) => all.reduce((total, e) => total + e[key], 0);
            todaFoot.innerHTML = all.length
                ? `<tr><td>Total</td><td class="num">${add('rides')}</td><td class="num">${pesoExact(add('serviceFee'))}</td><td class="num">${pesoExact(add('paraShare'))}</td><td class="num">${pesoExact(add('todaShare'))}</td></tr>`
                : '';
        }
        setText('ledgerTodaNote', byToda.size ? `${pesoExact(sum(fees, 'todaShare'))} across ${plural(byToda.size, 'TODA')}` : '');

        // What each driver owes right now (the user doc the functions keep up to date).
        const now = Date.now();
        const owing = [...people.values()].filter((p) => p.commissionOwed > 0)
            .sort((a, b) => b.commissionOwed - a.commissionOwed);
        const isOverdue = (p) => p.commissionDueAt > 0 && p.commissionDueAt < now;
        const overdue = owing.filter(isOverdue);
        const pending = owing.filter((p) => !isOverdue(p));
        const owingTotal = owing.reduce((total, p) => total + p.commissionOwed, 0);
        setText('ledgerOwedAllTab', String(owing.length));
        setText('ledgerOwedPendingTab', String(pending.length));
        setText('ledgerOwedOverdueTab', String(overdue.length));
        document.querySelectorAll('[data-owed-filter]').forEach((btn) => btn.classList.toggle('active', btn.dataset.owedFilter === owedFilter));
        const shown = owedFilter === 'OVERDUE' ? overdue : owedFilter === 'PENDING' ? pending : owing;
        setText('ledgerOwedNote', owing.length ? `${peso(owingTotal)} owed · ${plural(owing.length, 'driver')}` : '');
        const trips = tripsInRange(); // cash rides in this period
        setText('ledgerOwedDesc', `Cash rides: the driver keeps the fare and owes PARA and the TODA their share. ${peso(trips.reduce((total, r) => total + r.amount, 0))} was added in this period from ${plural(trips.length, 'cash ride')}.`);
        const owedPage = pageOf('owed', shown.length);
        const owedBody = document.getElementById('ledgerOwedBody');
        if (owedBody) {
            owedBody.innerHTML = shown.length ? shown.slice(owedPage.start, owedPage.end).map((p) => `
                <tr>${driverCell(p.id)}<td class="num">${peso(p.commissionOwed)}</td><td>${p.commissionDueAt ? esc(fmtDate(p.commissionDueAt)) : '—'}</td>
                <td>${isOverdue(p) ? badge('declined', 'OVERDUE') : badge('processing', 'PENDING')}</td></tr>`).join('')
                : emptyRow(4, owedFilter === 'OVERDUE' ? 'No driver is overdue.' : owedFilter === 'PENDING' ? 'No pending balances.' : 'No driver owes anything right now.');
        }
        drawPager('ledgerOwedPager', 'owed', owedPage);

        // The GCash payments drivers made to clear that balance.
        const allGcash = commissionPayments.filter((p) => inRange(p.createdAt)).sort((a, b) => b.createdAt - a.createdAt);
        const gcashCount = (group) => allGcash.filter((p) => gcashGroup(p) === group).length;
        setText('ledgerGcashAllTab', String(allGcash.length));
        setText('ledgerGcashPaidTab', String(gcashCount('PAID')));
        setText('ledgerGcashPendingTab', String(gcashCount('PENDING')));
        setText('ledgerGcashOtherTab', String(gcashCount('OTHER')));
        document.querySelectorAll('[data-gcash-filter]').forEach((btn) => btn.classList.toggle('active', btn.dataset.gcashFilter === gcashFilter));
        const payments = gcashFilter === 'ALL' ? allGcash : allGcash.filter((p) => gcashGroup(p) === gcashFilter);
        const paidTotal = allGcash.filter((p) => gcashGroup(p) === 'PAID').reduce((total, p) => total + p.amount, 0);
        setText('ledgerPaymentsNote', allGcash.length ? `${peso(paidTotal)} paid · ${plural(gcashCount('PAID'), 'payment')}` : '');
        const payPage = pageOf('payments', payments.length);
        const payBody = document.getElementById('ledgerPaymentsBody');
        if (payBody) {
            payBody.innerHTML = payments.length ? payments.slice(payPage.start, payPage.end).map((p) => `
                <tr>${driverCell(p.driverId)}<td class="num">${peso(p.amount)}</td><td>${esc(fmtDate(p.createdAt))}</td><td>${gcashBadge(p.status)}</td></tr>`).join('')
                : emptyRow(4, 'No GCash commission payments in this period.');
        }
        drawPager('ledgerPaymentsPager', 'payments', payPage);
    }

    // The TRIP entries inside the chosen period.
    function tripsInRange() {
        return tripRows.filter((r) => inRange(r.createdAt));
    }

    // The two lists are paged so a long history doesn't make the page long.
    const LEDGER_PAGE_SIZE = 8;
    const ledgerPages = { owed: 1, payments: 1 };

    function pageOf(key, total) {
        const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
        ledgerPages[key] = Math.min(Math.max(1, ledgerPages[key]), pages);
        const start = (ledgerPages[key] - 1) * LEDGER_PAGE_SIZE;
        return { page: ledgerPages[key], pages, total, start, end: Math.min(total, start + LEDGER_PAGE_SIZE) };
    }

    // The pager bar is always there (a page of rows is a fixed height too), so the
    // cards don't change size when a tab has fewer rows.
    function drawPager(id, key, info) {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = '';
        const range = info.total ? `<span>${info.start + 1}–${info.end} of ${info.total}</span>` : '<span></span>';
        el.innerHTML = range + (info.pages > 1
            ? `<div><button class="action-btn" ${info.page <= 1 ? 'disabled' : ''} onclick="ledgerPage('${key}', -1)">Prev</button>
               <span>Page ${info.page} of ${info.pages}</span>
               <button class="action-btn" ${info.page >= info.pages ? 'disabled' : ''} onclick="ledgerPage('${key}', 1)">Next</button></div>`
            : '');
    }
    window.ledgerPage = function (key, step) {
        ledgerPages[key] += step;
        renderLedger();
    };

    // Not capped: the totals above must cover every paid ride, not just the latest.
    db.collection('fee_ledger').orderBy('createdAt', 'desc').onSnapshot((snapshot) => {
        feeRows = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                todaName: d.todaName || '',
                fare: Number(d.fare) || 0,
                serviceFee: Number(d.serviceFee) || 0,
                paraShare: Number(d.paraShare) || 0,
                todaShare: Number(d.todaShare) || 0,
                driverShare: Number(d.driverShare) || 0,
                createdAt: toMs(d.createdAt)
            };
        });
        renderLedger();
    }, (error) => console.error('Could not load fee ledger:', error));

    db.collection('commission_ledger').orderBy('createdAt', 'desc').onSnapshot((snapshot) => {
        tripRows = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return { id: doc.id, type: d.type || '', amount: Number(d.amount) || 0, createdAt: toMs(d.createdAt) };
        }).filter((r) => r.type === 'TRIP');
        renderLedger();
    }, (error) => console.error('Could not load commission ledger:', error));

    db.collection('commission_payments').orderBy('createdAt', 'desc').onSnapshot((snapshot) => {
        commissionPayments = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return { id: doc.id, driverId: d.driverId || '', amount: Number(d.amount) || 0, status: d.status || '', createdAt: toMs(d.createdAt) };
        });
        renderLedger();
    }, (error) => console.error('Could not load commission payments:', error));
    peopleListeners.push(renderLedger);

    // config/commission.settlementDays: how long a driver has to settle the tab.
    db.collection('config').doc('commission').onSnapshot((snap) => {
        const days = Number((snap.data() || {}).settlementDays);
        settlementDays = Number.isFinite(days) && days > 0 ? days : 1;
        const input = document.getElementById('settlementDaysInput');
        if (input && document.activeElement !== input) input.value = settlementDays;
    }, (error) => console.error('Could not load commission settings:', error));

    window.saveSettlementDays = async function () {
        const input = document.getElementById('settlementDaysInput');
        const days = Math.floor(Number(input.value));
        if (!(days >= 1 && days <= 30)) {
            toast('Enter a whole number of days from 1 to 30.', 'warning');
            return;
        }
        try {
            await db.collection('config').doc('commission').set({ settlementDays: days }, { merge: true });
            toast('Settlement period saved.', 'success');
        } catch (error) {
            console.error('Could not save the settlement period:', error);
            toast('Could not save the settlement period.', 'error');
        }
    };

    window.setGcashFilter = function (filter) {
        gcashFilter = filter;
        ledgerPages.payments = 1;
        renderLedger();
    };

    window.setOwedFilter = function (filter) {
        owedFilter = filter === 'OVERDUE' || filter === 'PENDING' ? filter : 'ALL';
        ledgerPages.owed = 1;
        renderLedger();
    };

    window.applyLedgerRange = function () {
        const from = document.getElementById('ledgerFrom').value;
        const to = document.getElementById('ledgerTo').value;
        ledgerPages.owed = 1;
        ledgerPages.payments = 1;
        ledgerFrom = from ? new Date(from + 'T00:00:00').getTime() : 0;
        ledgerTo = to ? new Date(to + 'T23:59:59.999').getTime() : Infinity;
        renderLedger();
    };

    window.clearLedgerRange = function () {
        document.getElementById('ledgerFrom').value = '';
        document.getElementById('ledgerTo').value = '';
        window.applyLedgerRange();
    };
    // ── Ratings and messages ─────────────────────────────────────────
    let ratings = [];

    function stars(value) {
        const n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
        return '★'.repeat(n) + '☆'.repeat(5 - n);
    }

    // A driver's ratings and ride chats are shown on the Ratings tab of that
    // driver's window in Driver Management (firestore-ui.js asks for this HTML).
    let openThread = null; // { driverId, bookingId, html } - the chat last opened

    function driverRatings(driverId) {
        return ratings.filter((r) => r.driverId === driverId).sort((a, b) => b.timestamp - a.timestamp);
    }

    window.driverRatingCount = function (driverId) {
        return driverRatings(driverId).length;
    };

    // The ratings table is paged (newest first) so a driver with many ratings
    // doesn't make the tab long.
    const RATINGS_PAGE_SIZE = 8;
    let ratingPaging = { driverId: '', page: 1 };

    function ratingsTableHtml(driverId) {
        const list = driverRatings(driverId);
        if (!list.length) return '<div class="dd-empty" style="padding:28px 20px;">No ratings yet.</div>';
        const pages = Math.max(1, Math.ceil(list.length / RATINGS_PAGE_SIZE));
        ratingPaging.page = Math.min(Math.max(1, ratingPaging.page), pages);
        const start = (ratingPaging.page - 1) * RATINGS_PAGE_SIZE;
        const known = new Set((window.allBookings || []).map((b) => b.id));
        const rows = list.slice(start, start + RATINGS_PAGE_SIZE).map((r) => `
            <tr${known.has(r.bookingId) ? ' class="row-clickable" data-booking-id="' + esc(r.bookingId) + '" title="View trip details"' : ''}>
                <td style="white-space:nowrap;"><span style="color:#FF9E2A;">${stars(r.rating)}</span></td>
                <td>${esc(personName(r.passengerId))}</td>
                <td><div class="detail-sub" style="max-width:320px;">${esc(r.comment) || '—'}</div></td>
                <td style="white-space:nowrap;">${esc(fmtDate(r.timestamp))}</td>
            </tr>`).join('');
        return `
            <div class="table-container"><table class="data-table compact-table">
                <thead><tr><th>Rating</th><th>From</th><th>Comment</th><th>Date</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
            ${pages > 1 ? `<div class="dd-pager">
                <span>Showing ${start + 1}–${Math.min(list.length, start + RATINGS_PAGE_SIZE)} of ${list.length}</span>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="action-btn" data-rt-page="-1" ${ratingPaging.page <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${ratingPaging.page} of ${pages}</span>
                    <button class="action-btn" data-rt-page="1" ${ratingPaging.page >= pages ? 'disabled' : ''}>Next</button>
                </div>
            </div>` : ''}`;
    }

    window.driverRatingsHtml = function (driverId) {
        const list = driverRatings(driverId);
        const total = list.reduce((sum, r) => sum + r.rating, 0);
        const summary = list.length ? `
            <div class="dd-summary">
                <span class="dd-chip"><strong>${(total / list.length).toFixed(2)}</strong><span style="color:#FF9E2A;">${stars(total / list.length)}</span></span>
                <span class="dd-chip"><strong>${list.length}</strong>rating${list.length === 1 ? '' : 's'}</span>
            </div>` : '';
        if (ratingPaging.driverId !== driverId) ratingPaging = { driverId, page: 1 };

        // Ride messages: the driver's rides on the left, the chat of the chosen one on the right.
        const rides = (window.allBookings || []).filter((b) => b.driverId === driverId)
            .sort((a, b) => (new Date(b.createdAtRaw).getTime() || 0) - (new Date(a.createdAtRaw).getTime() || 0));
        const thread = openThread && openThread.driverId === driverId ? openThread : null;
        if (rmFilter.driverId !== driverId) rmFilter = { driverId, text: '', date: '' };
        rmRides = rides;
        rmActiveId = thread ? thread.bookingId : '';
        const messenger = rides.length ? `
            <div class="rm">
                <div class="rm-list">
                    <div class="rm-filters">
                        <input type="search" id="rmSearch" class="form-input" placeholder="Search trip or passenger" value="${esc(rmFilter.text)}" autocomplete="off">
                        <input type="date" id="rmDate" class="form-input" value="${esc(rmFilter.date)}" title="Show only rides booked on this day">
                    </div>
                    <div class="rm-items" id="rmItems">${rideItemsHtml()}</div>
                </div>
                <div class="rm-chat" id="rideMessageThread">${thread ? thread.html : RM_PLACEHOLDER}</div>
            </div>`
            : '<div class="dd-empty" style="padding:28px 20px;">This driver has no rides yet.</div>';

        return `
            <div class="dd-card-title" style="padding-top:0;">Ratings</div>
            ${summary}<div id="ratingsTable">${ratingsTableHtml(driverId)}</div>
            <div class="dd-card-title" style="padding-top:24px;">Ride messages</div>
            <div class="detail-sub" style="margin-bottom:12px;">Pick a ride to read the chat between this driver and the passenger, for example when investigating a complaint.</div>
            ${messenger}`;
    };

    const RM_PLACEHOLDER = '<div class="rm-empty">Select a ride to read its chat.</div>';
    const RM_MAX_SHOWN = 60;
    let rmFilter = { driverId: '', text: '', date: '' }; // search box and day filter on the ride list
    let rmRides = []; // the open driver's rides, newest first
    let rmActiveId = '';

    // The ride list, narrowed by the search box (trip reference, passenger, date)
    // and the day picker. Only the first RM_MAX_SHOWN matches are drawn.
    function rideItemsHtml() {
        const text = rmFilter.text.trim().toLowerCase();
        const matches = rmRides.filter((b) => {
            if (rmFilter.date) {
                const made = new Date(b.createdAtRaw);
                const day = Number.isNaN(made.getTime()) ? '' : `${made.getFullYear()}-${String(made.getMonth() + 1).padStart(2, '0')}-${String(made.getDate()).padStart(2, '0')}`;
                if (day !== rmFilter.date) return false;
            }
            return !text || [b.ref, b.passengerName, b.dateLabel].some((value) => String(value || '').toLowerCase().includes(text));
        });
        if (!matches.length) return '<div class="rm-more">No rides match.</div>';
        const items = matches.slice(0, RM_MAX_SHOWN).map((b) => `
            <button type="button" class="rm-ride${rmActiveId === b.id ? ' active' : ''}" data-rm-ride="${esc(b.id)}">
                <strong>${esc(b.ref)}</strong>
                <span>${esc(b.passengerName || '—')}</span>
                <span>${esc(b.dateLabel)}</span>
            </button>`).join('');
        const more = matches.length > RM_MAX_SHOWN
            ? `<div class="rm-more">Showing ${RM_MAX_SHOWN} of ${matches.length} rides. Search or pick a day to narrow it down.</div>` : '';
        return items + more;
    }

    function redrawRideList() {
        const box = document.getElementById('rmItems');
        if (box) box.innerHTML = rideItemsHtml();
    }

    // Chat between a driver and passenger on one ride. Admins can read every
    // thread; it is meant for looking into a complaint, not for browsing.
    async function loadThread(bookingId) {
        const match = (window.allBookings || []).find((b) => b.id === bookingId);
        const driverId = match ? match.driverId : '';
        const out = document.getElementById('rideMessageThread');
        rmActiveId = bookingId;
        document.querySelectorAll('[data-rm-ride]').forEach((btn) => btn.classList.toggle('active', btn.dataset.rmRide === bookingId));
        if (out) out.innerHTML = '<div class="rm-empty">Loading…</div>';
        let html;
        try {
            const snapshot = await db.collection('messages').where('bookingId', '==', bookingId).get();
            const messages = snapshot.docs.map((doc) => doc.data() || {}).sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
            const head = `<div class="rm-head"><strong>Trip ${esc(match ? match.ref : bookingId)}</strong><span>${esc(match && match.passengerName ? match.passengerName + ' · ' : '')}${plural(messages.length, 'message')}</span></div>`;
            html = !messages.length
                ? head + '<div class="rm-empty">No messages were sent on this ride.</div>'
                : head + '<div class="rm-messages">' + messages.map((m) => {
                    const fromDriver = String((people.get(m.senderId) || {}).role || '').toUpperCase() === 'DRIVER' || m.senderId === driverId;
                    return `
                    <div class="rm-msg ${fromDriver ? 'driver' : 'passenger'}">
                        <div class="rm-bubble">${esc(m.text)}</div>
                        <div class="rm-meta">${esc(personName(m.senderId))} · ${esc(fmtDate(m.createdAt))}</div>
                    </div>`;
                }).join('') + '</div>';
        } catch (error) {
            console.error('Could not load messages:', error);
            html = '<div class="rm-empty">Could not load messages for that ride.</div>';
        }
        openThread = { driverId, bookingId, html };
        const target = document.getElementById('rideMessageThread');
        if (target) target.innerHTML = html;
    }

    document.addEventListener('click', (e) => {
        const ride = e.target.closest('[data-rm-ride]');
        if (ride) loadThread(ride.dataset.rmRide);
    });

    document.addEventListener('click', (e) => {
        const page = e.target.closest('[data-rt-page]');
        const slot = document.getElementById('ratingsTable');
        if (!page || !slot || page.disabled) return;
        ratingPaging.page += Number(page.dataset.rtPage);
        slot.innerHTML = ratingsTableHtml(ratingPaging.driverId);
    });

    document.addEventListener('input', (e) => {
        if (e.target.id === 'rmSearch') { rmFilter.text = e.target.value; redrawRideList(); }
        else if (e.target.id === 'rmDate') { rmFilter.date = e.target.value; redrawRideList(); }
    });
    db.collection('ratings').limit(5000).onSnapshot((snapshot) => {
        ratings = snapshot.docs.map((doc) => {
            const d = doc.data() || {};
            return {
                id: doc.id,
                bookingId: d.bookingId || doc.id,
                driverId: d.driverId || '',
                passengerId: d.passengerId || '',
                rating: Number(d.rating) || 0,
                comment: d.comment || '',
                timestamp: toMs(d.timestamp || d.createdAt)
            };
        });
        notifyRatings();
    }, (error) => console.error('Could not load ratings:', error));

    // Tells the driver window (firestore-ui.js) to redraw if its Ratings tab is open.
    function notifyRatings() {
        document.dispatchEvent(new CustomEvent('para:ratings-updated'));
    }
    peopleListeners.push(notifyRatings);
    // ── Wiring ───────────────────────────────────────────────────────
    bindClicks(document.getElementById('appealsBody'), { 'view-appeal': (ds) => openAppeal(ds.id) });
    bindClicks(document.getElementById('passengerReportsBody'), { 'view-report': (ds) => openReport(ds.id) });
    bindClicks(modalFooter, {
        'decide': (ds) => decideAppeal(ds.id, ds.status),
        'decide-report': (ds) => decideReport(ds.id, ds.status)
    });
    watchForReturn('complaintViewModal');
    watchForReturn('tripModal');
    watchForReturn('passengerDetailsModal');

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
        const caseBtn = e.target.closest('[data-x-case]');
        if (caseBtn && typeof window.openComplaintModal === 'function') {
            openOver('complaintViewModal', () => window.openComplaintModal(caseBtn.dataset.xCase));
            return;
        }
        const passengerBtn = e.target.closest('[data-x-passenger]');
        if (passengerBtn && typeof window.openPassengerDetailsModal === 'function') {
            openOver('passengerDetailsModal', () => window.openPassengerDetailsModal(passengerBtn.dataset.xPassenger));
            return;
        }
        const trip = e.target.closest('[data-x-trip]');
        if (trip && typeof window.openTripModal === 'function') {
            e.preventDefault();
            openOver('tripModal', () => window.openTripModal(trip.dataset.xTrip));
        }
    });
})();
