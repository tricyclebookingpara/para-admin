const ParaFirestore = (() => {
    const { auth, db } = window.ParaFirebase;

    const COLLECTIONS = {
        admins: 'admins',
        drivers: 'drivers',
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
            await auth.signOut();
            if (!doc.exists) {
                throw new Error(`Admin record missing for UID ${credential.user.uid}.`);
            }
            if (role === 'toda_president') {
                throw new Error('TODA President accounts can only sign in through the mobile app, not this admin panel.');
            }
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

    function mapDriverDoc(doc) {
        const data = doc.data() || {};
        const verificationStatus = normalizeStatus(
            getField(data, 'verificationStatus', 'verification_status', 'status')
        );
        const rawRating = Number(getField(data, 'rating', 'averageRating', 'driverRating', 'overallRating') || 0);
        const totalRides = Number(getField(data, 'totalRides', 'rides', 'completedTrips', 'tripCount') || 0);
        const rawAcceptanceRate = Number(getField(data, 'acceptanceRate', 'acceptance_rate', 'acceptanceRatePercent', 'acceptance') || 0);
        const acceptedTrips = Number(getField(data, 'acceptedTrips', 'acceptedRides', 'acceptanceCount') || 0);
        const computedAcceptance = totalRides > 0 && acceptedTrips > 0
            ? (acceptedTrips / totalRides) * 100
            : rawAcceptanceRate;

        return {
            id: doc.id,
            name: getField(data, 'fullName', 'name', 'driverName'),
            license: getField(data, 'licenseNumber', 'license', 'licenseNo'),
            vehicle: getField(data, 'vehicleModel', 'vehicle', 'model'),
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
            status: normalizeStatus(getField(data, 'status', 'accountStatus')) || 'active',
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
        const status = normalizeStatus(getField(data, 'status', 'complaintStatus', 'state')) || 'under_review';
        const createdAt = toDate(getField(data, 'createdAt', 'created_at', 'timestamp', 'date', 'submittedAt', 'submitted_at'));
        const updatedAt = toDate(getField(data, 'updatedAt', 'updated_at'));
        const resolvedAt = toDate(getField(data, 'resolvedAt', 'resolved_at'));
        const bookingId = getField(data, 'bookingId', 'booking_id', 'bookingRef', 'booking_ref', 'tripRef', 'trip_ref', 'trip') || '';
        const complaintType = getField(data, 'complaintType', 'issueType', 'type', 'issue') || 'Complaint';

        const driverId = getField(data, 'driverId', 'driver_id', 'driverUid') || '';
        const passengerId = getField(data, 'passengerId', 'passenger_id', 'passengerUid') || '';

        // Confirmed against a real complaint doc: reporter/reported are plain
        // display-name strings, and whichever of driverId/passengerId is
        // populated identifies the reported party (that's the only one an
        // admin can actually act against — the reporter doesn't need an
        // actionable id). passengerId takes precedence if somehow both are set.
        const reportedId = passengerId || driverId || '';
        const reportedIdType = passengerId ? 'passenger' : (driverId ? 'driver' : '');
        const reportedRole = reportedIdType === 'passenger' ? 'Passenger' : (reportedIdType === 'driver' ? 'Driver' : '—');
        const reporterRole = reportedIdType === 'passenger' ? 'Driver' : (reportedIdType === 'driver' ? 'Passenger' : '—');

        return {
            id: doc.id,
            ref: getField(data, 'complaintId', 'complaint_id', 'caseId', 'case_id', 'ref') || doc.id,
            reporter: getField(data, 'reporter') || '—',
            reported: getField(data, 'reported') || '—',
            reporterRole,
            reportedRole,
            reportedId,
            reportedIdType,
            issue: complaintType,
            description: getField(data, 'description', 'details', 'desc', 'message') || '—',
            complaintType,
            adminNotes: getField(data, 'adminNotes', 'admin_notes', 'notes') || '',
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
        const snapshot = await db.collection(COLLECTIONS.drivers).get();
        let drivers = snapshot.docs.map(mapDriverDoc);
        if (verificationStatus) {
            drivers = drivers.filter((d) => d.verificationStatus === verificationStatus);
        }
        return drivers;
    }

    function listenDrivers(verificationStatus, callback) {
        return db.collection(COLLECTIONS.drivers).onSnapshot(async (snapshot) => {
            const now = Date.now();
            const expiredDocs = snapshot.docs.filter((doc) => {
                const data = doc.data() || {};
                const status = normalizeStatus(getField(data, 'accountStatus', 'status'));
                const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
                return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
            });

            if (expiredDocs.length) {
                await Promise.all(expiredDocs.map((doc) => db.collection(COLLECTIONS.drivers).doc(doc.id).update({
                    accountStatus: 'active',
                    suspendedUntil: null,
                    suspendedAt: null,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                })));
            }

            let drivers = snapshot.docs.map(mapDriverDoc);
            if (verificationStatus) {
                drivers = drivers.filter((d) => d.verificationStatus === verificationStatus);
            }
            callback(drivers);
        });
    }

    async function fetchApprovedDrivers() {
        const snapshot = await db.collection(COLLECTIONS.drivers).get();
        return snapshot.docs
            .map(mapDriverDoc)
            .filter((d) => d.verificationStatus === 'approved');
    }

    function listenApprovedDrivers(callback) {
        return db.collection(COLLECTIONS.drivers).onSnapshot((snapshot) => {
            const drivers = snapshot.docs
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
        await db.collection(COLLECTIONS.drivers).doc(driverId).update({
            verificationStatus: status,
            verifiedAt: firebase.firestore.FieldValue.serverTimestamp(),
            infoRequest: null
        });
    }

    async function updateDriver(driverId, updates) {
        await db.collection(COLLECTIONS.drivers).doc(driverId).update({
            fullName: updates.name,
            vehicleModel: updates.vehicle,
            plateNumber: updates.plate,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    async function updateDriverAccountStatus(driverId, status, suspensionDays = 3, reason = '') {
        const payload = {
            accountStatus: status,
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

        await db.collection(COLLECTIONS.drivers).doc(driverId).update(payload);
    }

    async function requestDriverInfo(driverId, { documents, note }) {
        await db.collection(COLLECTIONS.drivers).doc(driverId).update({
            infoRequest: {
                documents: documents || [],
                note: note || '',
                requestedBy: auth.currentUser ? auth.currentUser.uid : '',
                requestedAt: firebase.firestore.FieldValue.serverTimestamp()
            }
        });
    }

    async function reactivateExpiredDrivers() {
        const snapshot = await db.collection(COLLECTIONS.drivers).get();
        const now = Date.now();
        const expiredDrivers = snapshot.docs.filter((doc) => {
            const data = doc.data() || {};
            const status = normalizeStatus(getField(data, 'accountStatus', 'status'));
            const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
            return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
        });

        if (!expiredDrivers.length) return 0;

        await Promise.all(expiredDrivers.map((doc) => db.collection(COLLECTIONS.drivers).doc(doc.id).update({
            accountStatus: 'active',
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
                const status = normalizeStatus(getField(data, 'status', 'accountStatus'));
                const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
                return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
            });

            if (expiredDocs.length) {
                await Promise.all(expiredDocs.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
                    status: 'active',
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
            status,
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
            const status = normalizeStatus(getField(data, 'status', 'accountStatus'));
            const suspendedUntil = toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until'));
            return status === 'suspended' && suspendedUntil && suspendedUntil.getTime() <= now;
        });

        if (!expiredUsers.length) return 0;

        await Promise.all(expiredUsers.map((doc) => db.collection(COLLECTIONS.users).doc(doc.id).update({
            status: 'active',
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

    async function sendBroadcastNotification(title, body, audience) {
        await db.collection('notifications').add({
            title,
            body,
            audience,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    // Same notifications collection the broadcast "Push Notifications" page
    // already writes to — this just targets one specific user instead of an
    // audience, so a warned/suspended driver or passenger actually gets told.
    async function sendDirectNotification(recipientId, title, body) {
        if (!recipientId) return;
        await db.collection('notifications').add({
            title,
            body,
            audience: 'individual',
            recipientId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    // The notifications collection is shared with the mobile app's own
    // automatic system messages ("New Ride Request", "Booking Cancelled", etc.)
    // — those never set an audience field, only ones sent from this admin panel
    // (sendBroadcastNotification/sendDirectNotification) do. Fetch a larger
    // batch and filter to admin-originated ones client-side, since combining a
    // Firestore "in" filter with orderBy would require a composite index.
    const ADMIN_NOTIFICATION_AUDIENCES = ['allDrivers', 'allPassengers', 'everyone', 'individual'];

    async function fetchNotifications(limit = 30) {
        const snapshot = await db.collection('notifications').orderBy('createdAt', 'desc').limit(200).get();
        return snapshot.docs
            .map((doc) => {
                const data = doc.data() || {};
                return {
                    id: doc.id,
                    title: data.title || '',
                    body: data.body || '',
                    audience: data.audience || '',
                    recipientId: data.recipientId || '',
                    createdAtRaw: toDate(data.createdAt)
                };
            })
            .filter((n) => ADMIN_NOTIFICATION_AUDIENCES.includes(n.audience))
            .slice(0, limit);
    }

    async function updateComplaintStatus(complaintId, status, notes) {
        await db.collection(COLLECTIONS.complaints).doc(complaintId).update({
            status,
            adminNotes: notes || '',
            resolvedAt: status === 'resolved'
                ? firebase.firestore.FieldValue.serverTimestamp()
                : null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
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

    async function fetchTodaPresidentAccounts() {
        const snapshot = await db.collection(COLLECTIONS.admins).get();
        return snapshot.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .filter((account) => account.role === 'toda_president');
    }

    async function createTodaPresidentAccount({ name, todaName, barangay, email, phone, password }) {
        const secondaryAuth = getOrCreateSecondaryAuth();
        const credential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
        await db.collection(COLLECTIONS.admins).doc(credential.user.uid).set({
            fullName: name,
            todaName,
            barangay,
            email,
            phone,
            role: 'toda_president',
            status: 'active',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: auth.currentUser ? auth.currentUser.uid : ''
        });
        await secondaryAuth.signOut();
        return credential.user.uid;
    }

    async function updateTodaPresidentAccount(accountId, { name, todaName, barangay, phone, status }) {
        await db.collection(COLLECTIONS.admins).doc(accountId).update({
            fullName: name,
            todaName,
            barangay,
            phone,
            status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    async function updateTodaPresidentStatus(accountId, status) {
        await db.collection(COLLECTIONS.admins).doc(accountId).update({
            status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
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
        const [driversSnap, usersSnap, complaintsSnap] = await Promise.all([
            db.collection(COLLECTIONS.drivers).get(),
            db.collection(COLLECTIONS.users).get(),
            db.collection(COLLECTIONS.complaints).get()
        ]);

        const pendingDrivers = driversSnap.docs.filter((doc) => {
            const status = normalizeStatus(getField(doc.data(), 'verificationStatus', 'verification_status', 'status'));
            return status === 'pending';
        }).length;

        const openComplaints = complaintsSnap.docs.filter((doc) => {
            const status = normalizeStatus(getField(doc.data(), 'status'));
            return status === 'under_review' || status === 'pending' || status === 'review';
        }).length;

        return {
            activeDrivers: driversSnap.docs.filter((doc) => {
                const data = doc.data() || {};
                const verified = normalizeStatus(getField(data, 'verificationStatus', 'verification_status', 'status')) === 'approved';
                const active = normalizeStatus(getField(data, 'accountStatus', 'account_status', 'status')) !== 'suspended';
                return verified && active;
            }).length,
            activePassengers: usersSnap.docs.filter((doc) => {
                const status = normalizeStatus(getField(doc.data(), 'status', 'accountStatus'));
                return status !== 'suspended';
            }).length,
            pendingDrivers,
            openComplaints
        };
    }

    async function getDriverById(driverId) {
        const doc = await db.collection(COLLECTIONS.drivers).doc(driverId).get();
        if (!doc.exists) return null;
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
