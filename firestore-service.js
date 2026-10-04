const ParaFirestore = (() => {
    const { auth, db } = window.ParaFirebase;

    const COLLECTIONS = {
        admins: 'admins',
        // Drivers, passengers, and presidents all live in `users`, distinguished
        // by a `role` field — confirmed against the mobile app's real schema.
        // There is no separate `drivers` collection.
        users: 'users',
        bookings: 'bookings',
        complaints: 'complaints',
        fare: 'settings'
    };

    function getField(data, ...keys) {
        if (!data) return '';
        for (const key of keys) {
            if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
                return data[key];
            }
        }
        return '';
    }

    function toDate(value) {
        if (!value) return null;
        if (value.toDate) return value.toDate();
        return new Date(value);
    }

    function formatDateTime(value) {
        const date = toDate(value);
        if (!date || Number.isNaN(date.getTime())) return '—';
        return date.toLocaleString('en-PH', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    function formatTime(value) {
        const date = toDate(value);
        if (!date || Number.isNaN(date.getTime())) return '—';
        return date.toLocaleTimeString('en-PH', {
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    function formatDateLabel(value) {
        const date = toDate(value);
        if (!date || Number.isNaN(date.getTime())) return '—';
        return date.toLocaleDateString('en-PH', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    function formatRelativeTime(value) {
        const date = toDate(value);
        if (!date || Number.isNaN(date.getTime())) return '—';
        const diffMs = Date.now() - date.getTime();
        const diffMinutes = Math.round(diffMs / 60000);
        if (diffMinutes < 1) return 'just now';
        if (diffMinutes < 60) return `${diffMinutes} min${diffMinutes === 1 ? '' : 's'} ago`;
        const diffHours = Math.round(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
        const diffDays = Math.round(diffHours / 24);
        return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    }

    function normalizeStatus(value) {
        return String(value || '').toLowerCase().replace(/\s+/g, '_');
    }

    // Mirrors the mobile app's User.isAccountSuspended(): accountStatus wins
    // when it's set, the older isSuspended boolean is the fallback. A plain
    // `status` field is only read as a last resort for old admin-written
    // records — the app itself never looks at it.
    function resolveAccountStatus(data) {
        const accountStatus = normalizeStatus(getField(data, 'accountStatus'));
        if (accountStatus) return accountStatus;
        if (data && data.isSuspended === true) return 'suspended';
        return normalizeStatus(getField(data, 'status')) || 'active';
    }

    function normalizeRole(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    async function isAdmin(user) {
        if (!user) return false;
        const docRef = db.collection(COLLECTIONS.admins).doc(user.uid);
        const doc = await docRef.get();
        const role = getField(doc.data(), 'role');
        console.log('[ParaFirestore] isAdmin:', { uid: user.uid, exists: doc.exists, role });
        const status = getField(doc.data(), 'status');
        // TODA Presidents are mobile-app only — this web panel is for admins.
        if (role === 'toda_president') return false;
        return doc.exists && role !== 'disabled' && status !== 'disabled';
    }

    async function signIn(email, password) {
        const credential = await auth.signInWithEmailAndPassword(email, password);
        const admin = await isAdmin(credential.user);
        if (!admin) {
            const doc = await db.collection(COLLECTIONS.admins).doc(credential.user.uid).get();
            const role = getField(doc.data(), 'role');
            if (!doc.exists) {
                // Not an admin doc at all — check whether this is a TODA President
                // account (lives in `users`, not `admins`) so the error is accurate.
                const userDoc = await db.collection(COLLECTIONS.users).doc(credential.user.uid).get();
                const userRole = normalizeRole(getField(userDoc.data(), 'role'));
                await auth.signOut();
                if (userRole === 'president') {
                    throw new Error('TODA President accounts can only sign in through the mobile app, not this admin panel.');
                }
                throw new Error(`Admin record missing for UID ${credential.user.uid}.`);
            }
            await auth.signOut();
            if (role === 'disabled') {
                throw new Error('Admin access has been disabled for this account.');
            }
            throw new Error('This account is not authorized for admin access.');
        }
        return credential.user;
    }

    async function signOut() {
        await auth.signOut();
    }

    async function requireAdmin() {
        return new Promise((resolve) => {
            const unsubscribe = auth.onAuthStateChanged(async (user) => {
                unsubscribe();
                if (!user || !(await isAdmin(user))) {
                    window.location.href = 'index.html';
                    resolve(null);
                    return;
                }
                resolve(user);
            });
        });
    }

    // Drivers live in the SAME `users` collection as passengers/presidents,
    // distinguished only by role: "DRIVER" (confirmed against the mobile
    // app's actual Firestore schema — there's no separate "drivers"
    // collection). Unlike isPassengerRole, a missing role is NOT treated as
    // "driver" by default — that default made sense for passengers (the
    // app's implicit legacy role) but would wrongly pull in president/unknown
    // accounts here.
    function isDriverRole(data) {
        return String((data || {}).role || '').toUpperCase() === 'DRIVER';
    }

    function mapDriverDoc(doc) {
        const data = doc.data() || {};
        const verificationStatus = normalizeStatus(
            getField(data, 'verificationStatus', 'verification_status', 'status')
        );
        const rawRating = Number(getField(data, 'averageRating', 'rating', 'driverRating', 'overallRating') || 0);
        // totalRides/acceptanceRate aren't stored fields on the real User doc —
        // the app computes ride counts on the fly from bookings. These default
        // to 0 here; Driver Management live-recomputes a real count from
        // window.allBookings the same way it already does for passengers.
        const totalRides = Number(getField(data, 'totalRides', 'rides', 'completedTrips', 'tripCount') || 0);
        const rawAcceptanceRate = Number(getField(data, 'acceptanceRate', 'acceptance_rate', 'acceptanceRatePercent', 'acceptance') || 0);
        const acceptedTrips = Number(getField(data, 'acceptedTrips', 'acceptedRides', 'acceptanceCount') || 0);
        const computedAcceptance = totalRides > 0 && acceptedTrips > 0
            ? (acceptedTrips / totalRides) * 100
            : rawAcceptanceRate;

        const firstName = getField(data, 'firstName', 'first_name');
        const lastName = getField(data, 'lastName', 'last_name');
        const composedName = [firstName, lastName].filter(Boolean).join(' ');

        return {
            id: doc.id,
            name: composedName || getField(data, 'fullName', 'name', 'driverName'),
            firstName,
            lastName,
            license: getField(data, 'licenseNumber', 'license', 'licenseNo'),
            vehicle: getField(data, 'tricycleNumber', 'vehicleModel', 'vehicle', 'model'),
            plate: getField(data, 'plateNumber', 'plate', 'plateNo'),
            verificationStatus: verificationStatus || 'pending',
            accountStatus: normalizeStatus(getField(data, 'accountStatus', 'account_status')) || 'active',
            suspendedUntilRaw: toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until')),
            suspensionReason: data.suspensionReason || '',
            rating: Number.isFinite(rawRating) && rawRating > 0 ? rawRating.toFixed(1) : '—',
            totalRides,
            acceptanceRate: Number.isFinite(computedAcceptance) && computedAcceptance > 0 ? `${computedAcceptance.toFixed(0)}%` : '—',
            memberSince: formatDateTime(getField(data, 'createdAt', 'created_at', 'memberSince')),
            memberSinceRaw: toDate(getField(data, 'createdAt', 'created_at', 'memberSince')),
            submittedAt: formatDateTime(getField(data, 'submittedAt', 'submitted_at', 'createdAt', 'created_at')),
            submittedAtRaw: toDate(getField(data, 'submittedAt', 'submitted_at', 'createdAt', 'created_at')),
            verifiedAtRaw: toDate(getField(data, 'verifiedAt', 'verified_at')),
            infoRequest: data.infoRequest || null,
            documents: {
                licenseFront: getField(data, 'licenseFront', 'license_front') || (data.documents && data.documents.licenseFront),
                licenseBack: getField(data, 'licenseBack', 'license_back') || (data.documents && data.documents.licenseBack),
                vehiclePhoto: getField(data, 'vehiclePhoto', 'vehicle_photo') || (data.documents && data.documents.vehiclePhoto),
                franchisePermit: getField(data, 'franchisePermit', 'franchise_permit') || (data.documents && data.documents.franchisePermit)
            }
        };
    }

    function mapPassengerDoc(doc) {
        const data = doc.data() || {};
        const totalRides = Number(getField(data, 'totalRides', 'rides') || 0);
        const cancelled = Number(getField(data, 'cancelledRides', 'cancelled', 'cancellations') || 0);
        const cancelRate = totalRides > 0 ? ((cancelled / totalRides) * 100).toFixed(1) + '%' : '0.0%';

        const firstName = getField(data, 'firstName', 'first_name');
        const lastName = getField(data, 'lastName', 'last_name');
        const composedName = [firstName, lastName].filter(Boolean).join(' ');

        return {
            id: doc.id,
            name: getField(data, 'fullName', 'name') || composedName,
            firstName,
            lastName,
            phone: getField(data, 'phoneNumber', 'phone', 'contact'),
            email: getField(data, 'email'),
            totalRides,
            cancelled,
            cancelRate,
            status: resolveAccountStatus(data),
            suspendedUntilRaw: toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until')),
            suspensionReason: data.suspensionReason || '',
            memberSince: formatDateTime(getField(data, 'createdAt', 'created_at', 'memberSince')),
            memberSinceRaw: toDate(getField(data, 'createdAt', 'created_at', 'memberSince'))
        };
    }

    function mapBookingDoc(doc) {
        const data = doc.data() || {};
        const rawCreatedAt = toDate(getField(data, 'timestamp', 'createdAt', 'created_at', 'date'));
        const rawBookingTime = toDate(getField(data, 'bookingTime', 'booking_time'));
        const driverPlate = getField(data, 'driverPlateNumber', 'plateNumber', 'plate');

        const createdAt = rawCreatedAt || rawBookingTime;

        return {
            id: doc.id,
            ref: getField(data, 'bookingId', 'bookingRef', 'ref') || doc.id,
            status: normalizeStatus(getField(data, 'status') || getField(data, 'paymentStatus')) || 'processing',
            date: formatDateTime(createdAt),
            dateLabel: formatDateLabel(createdAt),
            relativeTime: formatRelativeTime(createdAt),
            createdAtRaw: createdAt,
            driverId: getField(data, 'driverId', 'driver_id', 'driverUid'),
            driverName: getField(data, 'driverName', 'driver'),
            plate: driverPlate || '—',
            // No separate pickup/dropoff TIME field exists on real booking docs —
            // only pickupLocation/destination (addresses) and one timestamp for
            // when the booking was made. Don't fabricate start/end times.
            pickupLocation: getField(data, 'pickupLocation', 'startLocation', 'origin', 'from', 'pickup') || '—',
            dropoffLocation: getField(data, 'destination', 'dropoffLocation', 'endLocation', 'to', 'dropoff') || '—',
            passengerId: getField(data, 'passengerId', 'passenger_id', 'passengerUid', 'userId'),
            passengerName: getField(data, 'passengerName', 'passenger'),
            totalFare: Number(getField(data, 'fare', 'totalFare', 'amountPaid', 'amount', 'price', 'total_amount')) || 0,
            paymentMethod: getField(data, 'paymentMethod', 'payment_method'),
            paymentStatus: normalizeStatus(getField(data, 'paymentStatus', 'payment_status'))
        };
    }

    function mapComplaintDoc(doc) {
        const data = doc.data() || {};
        const status = normalizeStatus(getField(data, 'status', 'complaintStatus', 'state')) || 'pending';
        const createdAt = toDate(getField(data, 'createdAt', 'created_at', 'timestamp', 'date', 'submittedAt', 'submitted_at'));
        const updatedAt = toDate(getField(data, 'updatedAt', 'updated_at'));
        const resolvedAt = toDate(getField(data, 'resolvedAt', 'resolved_at'));
        const bookingId = getField(data, 'bookingId', 'booking_id', 'bookingRef', 'booking_ref', 'tripRef', 'trip_ref', 'trip') || '';
        const complaintType = getField(data, 'complaintType', 'issueType', 'type', 'issue') || 'Complaint';

        // Confirmed against the mobile app's real schema (Complaint.kt): a
        // complaint is always filed BY a passenger (passengerId) ABOUT a
        // driver (driverId) — never the reverse, and there's no generic
        // reporter/reported-role pattern. There are also no reporter/reported
        // NAME-STRING fields at all, only these two uids — display names are
        // resolved client-side against already-loaded driver/passenger lists;
        // see resolveComplaintNames() in firestore-ui.js.
        const driverId = getField(data, 'driverId', 'driver_id', 'driverUid') || '';
        const passengerId = getField(data, 'passengerId', 'passenger_id', 'passengerUid') || '';
        const reportedId = driverId;
        const reportedIdType = 'driver';
        const reportedRole = 'Driver';
        const reporterRole = 'Passenger';

        return {
            id: doc.id,
            ref: getField(data, 'complaintId', 'complaint_id', 'caseId', 'case_id', 'ref') || doc.id,
            // Placeholder names — overwritten by resolveComplaintNames() once
            // the driver/passenger lists are loaded. Left as '—' here so
            // nothing breaks if a caller reads this before that runs.
            reporter: '—',
            reported: '—',
            reporterRole,
            reportedRole,
            reportedId,
            reportedIdType,
            issue: complaintType,
            description: getField(data, 'description', 'details', 'desc', 'message') || '—',
            complaintType,
            adminNotes: getField(data, 'resolutionNote', 'adminNotes', 'admin_notes', 'notes') || '',
            driverId,
            passengerId,
            bookingId,
            tripRef: bookingId,
            status,
            createdAt,
            createdAtRaw: createdAt,
            updatedAt,
            updatedAtRaw: updatedAt,
            resolvedAt,
            resolvedAtRaw: resolvedAt,
            todaRec: getField(data, 'todaRecommendation', 'toda_recommendation', 'todaRec') || 'Waiting for Recommendation...'
        };
    }

    async function fetchDrivers(verificationStatus) {
        const snapshot = await db.collection(COLLECTIONS.users).get();
        let drivers = snapshot.docs.filter((doc) => isDriverRole(doc.data())).map(mapDriverDoc);
        if (verificationStatus) {
            drivers = drivers.filter((d) => d.verificationStatus === verificationStatus);
        }
        return drivers;
    }

    function listenDrivers(verificationStatus, callback) {
        return db.collection(COLLECTIONS.users).onSnapshot(async (snapshot) => {
            const now = Date.now();
            const driverDocs = snapshot.docs.filter((doc) => isDriverRole(doc.data()));
            const expiredDocs = driverDocs.filter((doc) => {
                const data = doc.data() || {};
                const status = normalizeStatus(getField(data, 'accountStatus', 'status'));
                const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
                return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
            });

            if (expiredDocs.length) {
                await Promise.all(expiredDocs.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
                    accountStatus: 'active',
                    isSuspended: false,
                    suspendedUntil: null,
                    suspendedAt: null,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                })));
            }

            let drivers = driverDocs.map(mapDriverDoc);
            if (verificationStatus) {
                drivers = drivers.filter((d) => d.verificationStatus === verificationStatus);
            }
            callback(drivers);
        });
    }

    async function fetchApprovedDrivers() {
        const snapshot = await db.collection(COLLECTIONS.users).get();
        return snapshot.docs
            .filter((doc) => isDriverRole(doc.data()))
            .map(mapDriverDoc)
            .filter((d) => d.verificationStatus === 'approved');
    }

    function listenApprovedDrivers(callback) {
        return db.collection(COLLECTIONS.users).onSnapshot((snapshot) => {
            const drivers = snapshot.docs
                .filter((doc) => isDriverRole(doc.data()))
                .map(mapDriverDoc)
                .filter((d) => d.verificationStatus === 'approved');
            callback(drivers);
        });
    }

    // Matches the existing driver_actions schema (actionId/actionType/driverId/
    // driverName/issuedAt/reason) already used elsewhere in this Firestore project.
    async function logDriverAction(driverId, driverName, actionType, reason) {
        const ref = db.collection('driver_actions').doc();
        await ref.set({
            actionId: ref.id,
            actionType,
            driverId,
            driverName: driverName || '',
            issuedAt: Date.now(),
            reason: reason || '',
            issuedBy: auth.currentUser ? auth.currentUser.uid : ''
        });
    }

    async function fetchDriverActions(driverId) {
        const snapshot = await db.collection('driver_actions').where('driverId', '==', driverId).get();
        return snapshot.docs
            .map((doc) => doc.data() || {})
            .sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
    }

    async function updateDriverVerification(driverId, status) {
        await db.collection(COLLECTIONS.users).doc(driverId).update({
            verificationStatus: status,
            verifiedAt: firebase.firestore.FieldValue.serverTimestamp(),
            infoRequest: null
        });
    }

    async function updateDriver(driverId, updates) {
        const { firstName, lastName } = splitFullName(updates.name);
        await db.collection(COLLECTIONS.users).doc(driverId).update({
            firstName,
            lastName,
            tricycleNumber: updates.vehicle,
            plateNumber: updates.plate,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    async function updateDriverAccountStatus(driverId, status, suspensionDays = 3, reason = '') {
        const payload = {
            accountStatus: status,
            isSuspended: status === 'suspended',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (status === 'suspended') {
            payload.suspensionReason = reason || '';
            if (suspensionDays === 'permanent') {
                payload.suspendedUntil = null;
            } else {
                const days = Number(suspensionDays) > 0 ? Number(suspensionDays) : 3;
                const expiresAt = new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
                payload.suspendedUntil = firebase.firestore.Timestamp.fromDate(expiresAt);
            }
            payload.suspendedAt = firebase.firestore.FieldValue.serverTimestamp();
        } else {
            payload.suspendedUntil = null;
            payload.suspendedAt = null;
            payload.suspensionReason = null;
        }

        await db.collection(COLLECTIONS.users).doc(driverId).update(payload);
    }

    async function requestDriverInfo(driverId, { documents, note }) {
        await db.collection(COLLECTIONS.users).doc(driverId).update({
            infoRequest: {
                documents: documents || [],
                note: note || '',
                requestedBy: auth.currentUser ? auth.currentUser.uid : '',
                requestedAt: firebase.firestore.FieldValue.serverTimestamp()
            }
        });
    }

    async function reactivateExpiredDrivers() {
        const snapshot = await db.collection(COLLECTIONS.users).get();
        const now = Date.now();
        const expiredDrivers = snapshot.docs.filter((doc) => {
            if (!isDriverRole(doc.data())) return false;
            const data = doc.data() || {};
            const status = normalizeStatus(getField(data, 'accountStatus', 'status'));
            const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
            return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
        });

        if (!expiredDrivers.length) return 0;

        await Promise.all(expiredDrivers.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
            accountStatus: 'active',
            isSuspended: false,
            suspendedUntil: null,
            suspendedAt: null,
            suspensionReason: null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })));

        return expiredDrivers.length;
    }

    async function ensurePassengerProfile(userId, profile = {}) {
        const ref = db.collection(COLLECTIONS.users).doc(userId);
        const snapshot = await ref.get();

        if (!snapshot.exists) {
            await ref.set({
                fullName: profile.fullName || '',
                email: profile.email || '',
                phone: profile.phone || '',
                status: profile.status || 'active',
                totalRides: Number(profile.totalRides || 0),
                cancelledRides: Number(profile.cancelledRides || 0),
                suspendedUntil: null,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            return;
        }

        const current = snapshot.data() || {};
        await ref.set({
            fullName: profile.fullName ?? current.fullName ?? '',
            email: profile.email ?? current.email ?? '',
            phone: profile.phone ?? current.phone ?? '',
            status: profile.status ?? current.status ?? 'active',
            totalRides: Number(profile.totalRides ?? current.totalRides ?? 0),
            cancelledRides: Number(profile.cancelledRides ?? current.cancelledRides ?? 0),
            suspendedUntil: current.suspendedUntil ?? null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    async function setPassengerStats(userId, stats = {}) {
        const payload = {
            totalRides: Number(stats.totalRides ?? 0),
            cancelledRides: Number(stats.cancelledRides ?? 0),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (stats.status) payload.status = stats.status;
        if (stats.suspendedUntil !== undefined) payload.suspendedUntil = stats.suspendedUntil;

        await db.collection(COLLECTIONS.users).doc(userId).set(payload, { merge: true });
    }

    // totalRides = every booking attempt (completed + cancelled), so
    // cancelledRides/totalRides is a real, bounded 0-100% cancel rate —
    // matching the admin webapp's live computePassengerRideStats() and the
    // updatePassengerRideStats Cloud Function draft.
    async function incrementPassengerRideStats(userId, { completed = false, cancelled = false } = {}) {
        if (!completed && !cancelled) return;

        const payload = { totalRides: firebase.firestore.FieldValue.increment(1) };
        if (cancelled) {
            payload.cancelledRides = firebase.firestore.FieldValue.increment(1);
        }

        payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection(COLLECTIONS.users).doc(userId).update(payload);
    }

    async function applyBookingOutcomeToPassenger(bookingId, passengerId, status) {
        if (!passengerId || !bookingId) return;
        const normalizedStatus = normalizeStatus(status);
        const isCompleted = normalizedStatus === 'completed';
        const isCancelled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled';
        if (!isCompleted && !isCancelled) return;

        await incrementPassengerRideStats(passengerId, { completed: isCompleted, cancelled: isCancelled });
        await db.collection(COLLECTIONS.bookings).doc(bookingId).set({
            passengerStatsUpdated: true,
            passengerStatsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    // The users collection can hold non-passenger accounts too (role: "PASSENGER"
    // is a real field on real documents) — only exclude a doc when it's
    // explicitly some other role; missing/unknown role stays included so older
    // records without the field aren't hidden.
    function isPassengerRole(data) {
        const role = String(data.role || '').toUpperCase();
        return !role || role === 'PASSENGER';
    }

    async function fetchPassengers() {
        const snapshot = await db.collection(COLLECTIONS.users).get();
        return snapshot.docs
            .filter((doc) => isPassengerRole(doc.data() || {}))
            .map(mapPassengerDoc);
    }

    async function updatePassenger(userId, updates) {
        await db.collection(COLLECTIONS.users).doc(userId).update({
            firstName: updates.firstName,
            lastName: updates.lastName,
            phoneNumber: updates.phone,
            email: updates.email,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    // Same shape as driver_actions (actionId/actionType/.../issuedAt/reason) for
    // consistency — passenger_actions didn't exist yet, so this creates it the
    // first time an action is logged.
    async function logPassengerAction(passengerId, passengerName, actionType, reason) {
        const ref = db.collection('passenger_actions').doc();
        await ref.set({
            actionId: ref.id,
            actionType,
            passengerId,
            passengerName: passengerName || '',
            issuedAt: Date.now(),
            reason: reason || '',
            issuedBy: auth.currentUser ? auth.currentUser.uid : ''
        });
    }

    async function fetchPassengerActions(passengerId) {
        const snapshot = await db.collection('passenger_actions').where('passengerId', '==', passengerId).get();
        return snapshot.docs
            .map((doc) => doc.data() || {})
            .sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
    }

    function listenPassengers(callback) {
        return db.collection(COLLECTIONS.users).onSnapshot(async (snapshot) => {
            const now = Date.now();
            const expiredDocs = snapshot.docs.filter((doc) => {
                const data = doc.data() || {};
                if (!isPassengerRole(data)) return false;
                const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
                return resolveAccountStatus(data) === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
            });

            if (expiredDocs.length) {
                await Promise.all(expiredDocs.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
                    accountStatus: 'active',
                    isSuspended: false,
                    suspendedUntil: null,
                    suspendedAt: null,
                    suspensionReason: null,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                })));
            }

            callback(snapshot.docs
                .filter((doc) => isPassengerRole(doc.data() || {}))
                .map(mapPassengerDoc));
        });
    }

    async function updatePassengerStatus(userId, status, suspensionDays = 3, reason = '') {
        const payload = {
            accountStatus: status,
            isSuspended: status === 'suspended',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (status === 'suspended') {
            payload.suspensionReason = reason || '';
            if (suspensionDays === 'permanent') {
                payload.suspendedUntil = null;
            } else {
                const days = Number(suspensionDays) > 0 ? Number(suspensionDays) : 3;
                const expiresAt = new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
                payload.suspendedUntil = firebase.firestore.Timestamp.fromDate(expiresAt);
            }
            payload.suspendedAt = firebase.firestore.FieldValue.serverTimestamp();
        } else {
            payload.suspendedUntil = null;
            payload.suspendedAt = null;
            payload.suspensionReason = null;
        }

        await db.collection(COLLECTIONS.users).doc(userId).update(payload);
    }

    async function reactivateExpiredPassengers() {
        const snapshot = await db.collection(COLLECTIONS.users).get();
        const now = Date.now();
        const expiredUsers = snapshot.docs.filter((doc) => {
            const data = doc.data() || {};
            if (!isPassengerRole(data)) return false;
            const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
            return resolveAccountStatus(data) === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
        });

        if (!expiredUsers.length) return 0;

        await Promise.all(expiredUsers.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
            accountStatus: 'active',
            isSuspended: false,
            suspendedUntil: null,
            suspendedAt: null,
            suspensionReason: null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })));

        return expiredUsers.length;
    }

    async function fetchBookings() {
        const snapshot = await db.collection(COLLECTIONS.bookings).get();
        return snapshot.docs
            .map(mapBookingDoc)
            .sort((a, b) => {
                const aTime = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : 0;
                const bTime = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : 0;
                return bTime - aTime;
            });
    }

    async function fetchAllBookings() {
        const snapshot = await db.collection(COLLECTIONS.bookings).get();
        return snapshot.docs.map(mapBookingDoc);
    }

    function listenBookings(callback) {
        return db.collection(COLLECTIONS.bookings).onSnapshot((snapshot) => {
            const bookings = snapshot.docs.map(mapBookingDoc);
            bookings.sort((a, b) => {
                const aTime = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : 0;
                const bTime = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : 0;
                return bTime - aTime;
            });
            callback(bookings);
        }, (error) => {
            console.error('[ParaFirestore] Bookings listener failed:', error);
            db.collection(COLLECTIONS.bookings).get().then((fallback) => {
                const bookings = fallback.docs.map(mapBookingDoc);
                bookings.sort((a, b) => {
                    const aTime = a.createdAtRaw && a.createdAtRaw.getTime ? a.createdAtRaw.getTime() : 0;
                    const bTime = b.createdAtRaw && b.createdAtRaw.getTime ? b.createdAtRaw.getTime() : 0;
                    return bTime - aTime;
                });
                callback(bookings);
            }).catch((fallbackError) => {
                console.error('[ParaFirestore] Fallback bookings load failed:', fallbackError);
                callback([]);
            });
        });
    }

    async function fetchComplaints() {
        const snapshot = await db.collection(COLLECTIONS.complaints).get();
        return snapshot.docs.map(mapComplaintDoc);
    }

    function listenComplaints(callback) {
        return db.collection(COLLECTIONS.complaints).onSnapshot((snapshot) => {
            callback(snapshot.docs.map(mapComplaintDoc));
        });
    }

    // The mobile app only ever loads `notifications` docs where
    // userId == the signed-in user (NotificationRepository.kt), shaped like
    // Notification.kt: {notificationId, userId, title, message, bookingId,
    // isRead, createdAt (Long millis)}. There's no "audience"/broadcast doc
    // the app would pick up, so a broadcast has to be fanned out as one doc
    // per recipient. (Delivery is the app's in-app notification list only —
    // the app has no push messaging/FCM.)
    const NOTIFICATION_BATCH_SIZE = 400; // Firestore batches cap at 500 writes

    function notificationRoleKey(data) {
        return String((data || {}).role || '').toUpperCase() || 'PASSENGER';
    }

    function rolesForAudience(audience) {
        if (audience === 'allDrivers') return ['DRIVER'];
        if (audience === 'allPassengers') return ['PASSENGER'];
        if (audience === 'everyone') return ['DRIVER', 'PASSENGER', 'PRESIDENT'];
        return [];
    }

    async function writeNotificationDocs(userIds, title, message) {
        const createdAt = Date.now();
        for (let i = 0; i < userIds.length; i += NOTIFICATION_BATCH_SIZE) {
            const batch = db.batch();
            userIds.slice(i, i + NOTIFICATION_BATCH_SIZE).forEach((userId) => {
                const ref = db.collection('notifications').doc();
                batch.set(ref, {
                    notificationId: ref.id,
                    userId,
                    title,
                    message,
                    bookingId: '',
                    isRead: false,
                    createdAt
                });
            });
            await batch.commit();
        }
    }

    // One row per send for the admin history page — separate from the
    // per-recipient `notifications` docs above, otherwise a broadcast to 500
    // users would show up as 500 history entries. Best-effort: the
    // notification has already been delivered by the time this runs.
    async function logAdminNotification({ title, message, audience, recipientId = '', recipientCount }) {
        try {
            await db.collection('admin_notifications').add({
                title,
                message,
                audience,
                recipientId,
                recipientCount,
                sentBy: auth.currentUser ? auth.currentUser.uid : '',
                createdAt: Date.now()
            });
        } catch (error) {
            console.error('Failed to log admin notification:', error);
        }
    }

    async function sendBroadcastNotification(title, body, audience) {
        const roles = rolesForAudience(audience);
        if (!roles.length) throw new Error(`Unknown notification audience: ${audience}`);

        const snapshot = await db.collection(COLLECTIONS.users).get();
        const userIds = snapshot.docs
            .filter((doc) => roles.includes(notificationRoleKey(doc.data())))
            .map((doc) => doc.id);

        if (!userIds.length) return { recipientCount: 0 };

        await writeNotificationDocs(userIds, title, body);
        await logAdminNotification({ title, message: body, audience, recipientCount: userIds.length });
        return { recipientCount: userIds.length };
    }

    // Targets one specific user (e.g. a warned/suspended driver) — recipientId
    // is their users/{uid} document id, which is the same as their auth uid.
    async function sendDirectNotification(recipientId, title, body) {
        if (!recipientId) return;
        await writeNotificationDocs([recipientId], title, body);
        await logAdminNotification({ title, message: body, audience: 'individual', recipientId, recipientCount: 1 });
    }

    async function fetchNotifications(limit = 30) {
        const snapshot = await db.collection('admin_notifications').orderBy('createdAt', 'desc').limit(limit).get();
        return snapshot.docs.map((doc) => {
            const data = doc.data() || {};
            return {
                id: doc.id,
                title: data.title || '',
                body: data.message || '',
                audience: data.audience || '',
                recipientId: data.recipientId || '',
                recipientCount: Number(data.recipientCount || 0),
                createdAtRaw: toDate(data.createdAt)
            };
        });
    }

    // Real ComplaintStatus enum (Complaint.kt) only has PENDING/REVIEWING/
    // RESOLVED/REJECTED — there's no separate "warned"/"suspended" status.
    // Which remedy was applied (warning/suspension/none) is recorded
    // separately via driver_actions, not on the complaint's own status.
    async function updateComplaintStatus(complaintId, status, notes) {
        const isClosed = status === 'RESOLVED' || status === 'REJECTED';
        await db.collection(COLLECTIONS.complaints).doc(complaintId).update({
            status,
            resolutionNote: notes || '',
            resolvedAt: isClosed ? Date.now() : null
        });
    }

    async function updateComplaintRecommendation(complaintId, recommendation) {
        const value = String(recommendation || '').trim();
        if (!value) throw new Error('A recommendation is required.');
        await db.collection(COLLECTIONS.complaints).doc(complaintId).update({
            todaRecommendation: value,
            todaRecommendationBy: auth.currentUser ? auth.currentUser.uid : '',
            todaRecommendationAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    function getOrCreateSecondaryAuth() {
        const appName = 'toda-president-account-creator';
        const app = firebase.apps.find((candidate) => candidate.name === appName)
            || firebase.initializeApp(firebaseConfig, appName);
        return app.auth();
    }

    // TODA President accounts must live in the SAME `users` collection the
    // mobile app reads, with role "PRESIDENT" (exact casing) — that's the only
    // role value the app's own PresidentGraph recognizes. They used to be
    // written to a separate `admins` collection with role "toda_president",
    // which the mobile app has no concept of, so accounts created that way
    // could never actually sign in on the app. todaName/barangay aren't part
    // of the app's User model — they're extra fields this panel reads back
    // for itself; Firestore has no schema to violate by including them.
    function splitFullName(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        const firstName = parts.shift() || '';
        const lastName = parts.join(' ');
        return { firstName, lastName };
    }

    async function fetchTodaPresidentAccounts() {
        const snapshot = await db.collection(COLLECTIONS.users).where('role', '==', 'PRESIDENT').get();
        return snapshot.docs.map((doc) => {
            const data = doc.data() || {};
            const disabled = data.isSuspended === true || normalizeStatus(getField(data, 'accountStatus')) === 'suspended';
            return {
                id: doc.id,
                fullName: `${getField(data, 'firstName')} ${getField(data, 'lastName')}`.trim(),
                todaName: getField(data, 'todaName'),
                barangay: getField(data, 'barangay'),
                email: getField(data, 'email'),
                phone: getField(data, 'phoneNumber'),
                status: disabled ? 'disabled' : 'active'
            };
        });
    }

    async function createTodaPresidentAccount({ name, todaName, barangay, email, phone, password }) {
        const secondaryAuth = getOrCreateSecondaryAuth();
        const credential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
        const { firstName, lastName } = splitFullName(name);
        await db.collection(COLLECTIONS.users).doc(credential.user.uid).set({
            uid: credential.user.uid,
            role: 'PRESIDENT',
            firstName,
            lastName,
            email,
            phoneNumber: phone,
            createdAt: Date.now(),
            accountStatus: 'active',
            isSuspended: false,
            todaName,
            barangay,
            createdBy: auth.currentUser ? auth.currentUser.uid : ''
        });
        // createUserWithEmailAndPassword does NOT send a verification email on
        // its own — it has to be requested explicitly. Best-effort: the account
        // is already created at this point, so a failure here (rate limit,
        // network) shouldn't make account creation look like it failed.
        let emailVerificationSent = false;
        try {
            await credential.user.sendEmailVerification();
            emailVerificationSent = true;
        } catch (error) {
            console.error('Failed to send TODA President verification email:', error);
        }
        await secondaryAuth.signOut();
        return { uid: credential.user.uid, emailVerificationSent };
    }

    async function updateTodaPresidentAccount(accountId, { name, todaName, barangay, phone, status }) {
        const { firstName, lastName } = splitFullName(name);
        await db.collection(COLLECTIONS.users).doc(accountId).update({
            firstName,
            lastName,
            todaName,
            barangay,
            phoneNumber: phone,
            accountStatus: status === 'disabled' ? 'suspended' : 'active',
            isSuspended: status === 'disabled'
        });
    }

    async function updateTodaPresidentStatus(accountId, status) {
        await db.collection(COLLECTIONS.users).doc(accountId).update({
            accountStatus: status === 'disabled' ? 'suspended' : 'active',
            isSuspended: status === 'disabled'
        });
    }

    async function getFareSettings() {
        const doc = await db.collection(COLLECTIONS.fare).doc('fare').get();
        if (!doc.exists) {
            return { baseFare: 40, perKmRate: 15, minimumFare: 40, serviceFeePercent: 5, updatedAtRaw: null };
        }
        const data = doc.data() || {};
        return {
            baseFare: Number(getField(data, 'baseFare', 'base_fare') || 40),
            perKmRate: Number(getField(data, 'perKmRate', 'per_km_rate') || 15),
            minimumFare: Number(getField(data, 'minimumFare', 'minimum_fare') || 40),
            serviceFeePercent: Number(getField(data, 'serviceFeePercent', 'service_fee_percent') || 5),
            updatedAtRaw: toDate(getField(data, 'updatedAt', 'updated_at'))
        };
    }

    function validateFareSettings(settings) {
        const fields = [
            ['baseFare', 'Base Fare'],
            ['perKmRate', 'Per Kilometer Rate'],
            ['minimumFare', 'Minimum Fare'],
            ['serviceFeePercent', 'Service Fee']
        ];
        for (const [key, label] of fields) {
            const value = settings[key];
            if (!Number.isFinite(value)) {
                throw new Error(`${label} must be a valid number.`);
            }
            if (value < 0) {
                throw new Error(`${label} cannot be negative.`);
            }
        }
        if (settings.serviceFeePercent > 100) {
            throw new Error('Service Fee cannot be more than 100%.');
        }
    }

    // fare_history keeps every change (settings/fare only ever holds the
    // current values) — useful even with a single admin, since it's still
    // the only record of what pricing used to be and when it changed.
    async function logFareChange(previous, next) {
        await db.collection('fare_history').add({
            previous,
            next,
            changedBy: auth.currentUser ? auth.currentUser.uid : '',
            changedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    async function saveFareSettings(settings) {
        validateFareSettings(settings);

        const previous = await getFareSettings();
        const next = {
            baseFare: settings.baseFare,
            perKmRate: settings.perKmRate,
            minimumFare: settings.minimumFare,
            serviceFeePercent: settings.serviceFeePercent
        };

        await db.collection(COLLECTIONS.fare).doc('fare').set({
            ...next,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        logFareChange(
            { baseFare: previous.baseFare, perKmRate: previous.perKmRate, minimumFare: previous.minimumFare, serviceFeePercent: previous.serviceFeePercent },
            next
        ).catch((error) => console.error('Failed to log fare change:', error));
    }

    async function getDashboardCounts() {
        const [usersSnap, complaintsSnap] = await Promise.all([
            db.collection(COLLECTIONS.users).get(),
            db.collection(COLLECTIONS.complaints).get()
        ]);

        const driverDocs = usersSnap.docs.filter((doc) => isDriverRole(doc.data()));
        const passengerDocs = usersSnap.docs.filter((doc) => isPassengerRole(doc.data() || {}));

        const pendingDrivers = driverDocs.filter((doc) => {
            const status = normalizeStatus(getField(doc.data(), 'verificationStatus', 'verification_status', 'status'));
            return status === 'pending';
        }).length;

        const openComplaints = complaintsSnap.docs.filter((doc) => {
            const status = normalizeStatus(getField(doc.data(), 'status'));
            return status === 'pending' || status === 'reviewing';
        }).length;

        return {
            activeDrivers: driverDocs.filter((doc) => {
                const data = doc.data() || {};
                const verified = normalizeStatus(getField(data, 'verificationStatus', 'verification_status', 'status')) === 'approved';
                const active = normalizeStatus(getField(data, 'accountStatus', 'account_status', 'status')) !== 'suspended';
                return verified && active;
            }).length,
            activePassengers: passengerDocs.filter((doc) => {
                return resolveAccountStatus(doc.data()) !== 'suspended';
            }).length,
            pendingDrivers,
            openComplaints
        };
    }

    async function getDriverById(driverId) {
        const doc = await db.collection(COLLECTIONS.users).doc(driverId).get();
        if (!doc.exists || !isDriverRole(doc.data())) return null;
        return mapDriverDoc(doc);
    }

    async function getComplaintById(complaintId) {
        const doc = await db.collection(COLLECTIONS.complaints).doc(complaintId).get();
        if (!doc.exists) return null;
        return mapComplaintDoc(doc);
    }

    return {
        auth,
        db,
        isAdmin,
        signIn,
        signOut,
        requireAdmin,
        fetchDrivers,
        listenDrivers,
        fetchApprovedDrivers,
        listenApprovedDrivers,
        updateDriverVerification,
        updateDriver,
        updateDriverAccountStatus,
        requestDriverInfo,
        logDriverAction,
        fetchDriverActions,
        reactivateExpiredDrivers,
        ensurePassengerProfile,
        setPassengerStats,
        incrementPassengerRideStats,
        applyBookingOutcomeToPassenger,
        fetchPassengers,
        listenPassengers,
        updatePassenger,
        updatePassengerStatus,
        logPassengerAction,
        fetchPassengerActions,
        reactivateExpiredPassengers,
        fetchBookings,
        fetchAllBookings,
        listenBookings,
        fetchComplaints,
        listenComplaints,
        updateComplaintStatus,
        updateComplaintRecommendation,
        sendDirectNotification,
        sendBroadcastNotification,
        fetchNotifications,
        fetchTodaPresidentAccounts,
        createTodaPresidentAccount,
        updateTodaPresidentAccount,
        updateTodaPresidentStatus,
        getFareSettings,
        saveFareSettings,
        getDashboardCounts,
        getDriverById,
        getComplaintById,
        formatDateTime,
        normalizeStatus
    };
})();

window.ParaFirestore = ParaFirestore;
