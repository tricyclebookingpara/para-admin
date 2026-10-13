const ParaFirestore = (() => {
    const { auth, db, storage } = window.ParaFirebase;

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
        // No ride count / acceptance rate here: the app doesn't store either on
        // the driver doc. They are worked out live from bookings (computeDriverStats).

        const firstName = getField(data, 'firstName', 'first_name');
        const lastName = getField(data, 'lastName', 'last_name');
        const composedName = [firstName, lastName].filter(Boolean).join(' ');

        return {
            id: doc.id,
            name: composedName || getField(data, 'fullName', 'name', 'driverName'),
            firstName,
            lastName,
            phone: getField(data, 'phoneNumber', 'phone', 'contact'),
            email: getField(data, 'email'),
            license: getField(data, 'licenseNumber', 'license', 'licenseNo'),
            vehicle: getField(data, 'tricycleNumber', 'vehicleModel', 'vehicle', 'model'),
            plate: getField(data, 'plateNumber', 'plate', 'plateNo'),
            verificationStatus: verificationStatus || 'pending',
            accountStatus: resolveAccountStatus(data),
            suspendedUntilRaw: toDate(getField(data, 'suspendedUntil', 'suspensionEndsAt', 'suspended_until')),
            suspensionReason: data.suspensionReason || '',
            // Written by the app (DriverRepository.updateDriverStatus): OFFLINE /
            // ONLINE / AVAILABLE / BUSY (on a ride), and the time of the last
            // position ping — a driver whose app was killed keeps their last
            // status, so presence is judged by how fresh that ping is.
            driverStatus: String(data.driverStatus || 'OFFLINE').toUpperCase(),
            lastLocationAt: Number(data.currentLatLngUpdatedAt) || 0,
            rating: Number.isFinite(rawRating) && rawRating > 0 ? rawRating.toFixed(1) : '—',
            memberSince: formatDateTime(getField(data, 'createdAt', 'created_at', 'memberSince')),
            memberSinceRaw: toDate(getField(data, 'createdAt', 'created_at', 'memberSince')),
            submittedAt: formatDateTime(getField(data, 'submittedAt', 'submitted_at', 'createdAt', 'created_at')),
            submittedAtRaw: toDate(getField(data, 'submittedAt', 'submitted_at', 'createdAt', 'created_at')),
            verifiedAtRaw: toDate(getField(data, 'verifiedAt', 'verified_at')),
            infoRequest: data.infoRequest || null,
            // What the driver typed when signing up (DriverSignupScreen); the
            // document photos themselves are in Storage, see fetchDriverDocuments.
            governmentId: getField(data, 'governmentId'),
            licenseExpiry: getField(data, 'licenseExpiryDate'),
            vehicleRegistrationDate: getField(data, 'vehicleRegistrationDate'),
            todaName: getField(data, 'todaName'),
            // Typed by the driver in the app (free text — never put it into
            // innerHTML unescaped) and their tricycle photo's URL. Both are empty
            // on drivers who registered before this was added; the photo is not
            // one of the three verification documents and has no review step.
            motorcycleModel: getField(data, 'motorcycleModel'),
            tricycleImageUrl: getField(data, 'tricycleImageUrl'),
            // Profile photo (set by the app). A new or replaced photo is
            // "pending" until the admin approves or rejects it; "" on drivers
            // who registered before the feature. See approveProfilePhoto /
            // rejectProfilePhoto. The ID photo URLs are also copied onto the
            // user doc by the app; Storage (fetchDriverDocuments) is the fallback.
            profileImage: getField(data, 'profileImage'),
            profilePhotoStatus: String(data.profilePhotoStatus || '').toLowerCase(),
            profilePhotoUpdatedAtRaw: toDate(data.profilePhotoUpdatedAt),
            profilePhotoRejectReason: data.profilePhotoRejectReason || '',
            governmentIdImageUrl: getField(data, 'governmentIdImageUrl'),
            licenseImageUrl: getField(data, 'licenseImageUrl'),
            vehicleRegistrationImageUrl: getField(data, 'vehicleRegistrationImageUrl')
        };
    }

    // The app uploads each driver's documents to Firebase Storage:
    //   driver_documents/{driver uid}/government_id.jpg
    //   driver_documents/{driver uid}/license.jpg
    //   driver_documents/{driver uid}/vehicle_registration.jpg
    // Matched by file name without the extension, so a .png upload also works.
    // A missing file is null; a Storage rules problem throws (code
    // storage/unauthorized) so the screen can say why nothing is shown.
    const DRIVER_DOCUMENT_FILES = {
        governmentId: 'government_id',
        license: 'license',
        vehicleRegistration: 'vehicle_registration'
    };

    async function fetchDriverDocuments(driverId) {
        if (!storage) throw new Error('Firebase Storage is not loaded on this page.');
        const listing = await storage.ref(`driver_documents/${driverId}`).listAll();
        const documents = {};
        await Promise.all(Object.entries(DRIVER_DOCUMENT_FILES).map(async ([key, baseName]) => {
            const item = listing.items.find((entry) => entry.name.replace(/\.[^.]+$/, '').toLowerCase() === baseName);
            documents[key] = item ? await item.getDownloadURL() : null;
        }));
        return documents;
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
            memberSinceRaw: toDate(getField(data, 'createdAt', 'created_at', 'memberSince')),
            // Raised by the app when a driver marks the passenger a no-show; the
            // admin can take one back (reverseNoShow) and the booking is kept in
            // reversedNoShows so the same one can't be reversed twice.
            noShowCount: Number(data.noShowCount) || 0,
            reversedNoShows: Array.isArray(data.reversedNoShows) ? data.reversedNoShows : []
        };
    }

    // {lat, lng} as saved by the app, or null when there was no GPS fix (null /
    // missing / 0,0) — shown as "Not recorded".
    function toLatLng(value) {
        if (!value || typeof value !== 'object') return null;
        const lat = Number(value.lat);
        const lng = Number(value.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return null;
        return { lat, lng };
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
            paymentStatus: normalizeStatus(getField(data, 'paymentStatus', 'payment_status')),
            // The only ride-progress times the app records: when the driver
            // tapped "Arrived" at the pickup, and when the trip was completed
            // (drop-off). There's no saved time for the rider actually boarding.
            arrivedAtRaw: toDate(data.arrivedAt),
            startedAtRaw: toDate(data.startedAt),
            completedAtRaw: toDate(data.completedAt),
            // Set by the app when a shared-ride join request times out / is
            // turned away — those end as DECLINED but aren't a driver declining.
            joinRequestExpired: data.joinRequestExpired === true,
            driverTodaName: getField(data, 'driverTodaName'),
            // Where the driver was when they tapped Arrived / Start ride / End
            // ride, and the pins the passenger set. GPS can't be verified by
            // Firestore, so these are the evidence the admin works from.
            pickupLatLng: toLatLng(data.pickupLatLng),
            destinationLatLng: toLatLng(data.destinationLatLng),
            arrivedLatLng: toLatLng(data.arrivedLatLng),
            startedLatLng: toLatLng(data.startedLatLng),
            completedLatLng: toLatLng(data.completedLatLng),
            // The driver ended the ride more than 300 m from the destination.
            endedEarly: data.endedEarly === true,
            earlyEndReviewedAtRaw: toDate(data.earlyEndReviewedAt),
            earlyEndReviewNote: data.earlyEndReviewNote || ''
        };
    }

    // Per-driver stats from bookings — the app stores neither on the driver doc.
    //  - completed: COMPLETED bookings with this driver's id.
    //  - acceptance: accepted / (accepted + declined). "Accepted" = the driver
    //    took the request and it got at least as far as ACCEPTED. A decline
    //    blanks the booking's driverId (BookingRepository.kt), so declines are
    //    matched back to the driver by the plate number the booking still
    //    carries — weaker than an id (it misses if a driver changes their
    //    plate, and two drivers sharing a plate would be merged).
    const ACCEPTED_BOOKING_STATUSES = ['accepted', 'arrived', 'ongoing', 'completed', 'no_show'];

    function normalizePlate(value) {
        const plate = String(value || '').replace(/\s+/g, '').toUpperCase();
        return plate === '—' ? '' : plate;
    }

    function computeDriverStats(driver, bookings) {
        const plate = normalizePlate(driver.plate);
        let completed = 0;
        let accepted = 0;
        let declined = 0;
        (bookings || []).forEach((booking) => {
            const status = normalizeStatus(booking.status);
            const isDriverDecline = status === 'declined' && !booking.joinRequestExpired;
            if (booking.driverId && booking.driverId === driver.id) {
                if (status === 'completed') completed += 1;
                if (ACCEPTED_BOOKING_STATUSES.includes(status)) accepted += 1;
                if (isDriverDecline) declined += 1;
            } else if (!booking.driverId && isDriverDecline && plate && normalizePlate(booking.plate) === plate) {
                declined += 1;
            }
        });
        const offered = accepted + declined;
        return {
            completed,
            accepted,
            declined,
            acceptanceRate: offered > 0 ? `${Math.round((accepted / offered) * 100)}%` : '—'
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
            resolvedAtRaw: resolvedAt
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

    // driver_actions is shared with the mobile app (model/DriverAction.kt): the
    // TODA president writes Warning / Invalid / Suspension records there, and a
    // Suspension from the president is only a PENDING recommendation until the
    // admin decides on it. The app defaults a missing `status` to PENDING, so
    // every record written here must carry one: a suspension the admin issues
    // is already decided (APPROVED); everything else is NOT_APPLICABLE.
    async function logDriverAction(driverId, driverName, actionType, reason, options = {}) {
        const ref = db.collection('driver_actions').doc();
        await ref.set({
            actionId: ref.id,
            actionType,
            driverId,
            driverName: driverName || '',
            issuedAt: Date.now(),
            reason: reason || '',
            status: actionType === 'Suspension' ? 'APPROVED' : 'NOT_APPLICABLE',
            issuedBy: auth.currentUser ? auth.currentUser.uid : '',
            issuedByName: window.ParaAdminName || 'PARA Admin',
            issuedByRole: 'ADMIN',
            complaintId: options.complaintId || ''
        });
    }

    async function fetchDriverActions(driverId) {
        const snapshot = await db.collection('driver_actions').where('driverId', '==', driverId).get();
        return snapshot.docs
            .map((doc) => doc.data() || {})
            .sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
    }

    // ── Recommendations from the TODA president ────────────────────────
    // When the president isn't sure what penalty a driver should get, the app
    // saves a driver_actions record (Warning / Invalid / Suspension) with the
    // reason. The admin site shows it in the complaint case to help the admin
    // decide, and tells the president's app once the admin has acted.
    function mapDriverActionDoc(doc) {
        const data = doc.data() || {};
        return {
            id: doc.id,
            driverId: data.driverId || '',
            driverName: data.driverName || '',
            actionType: data.actionType || '',
            reason: data.reason || '',
            issuedAt: Number(data.issuedAt) || 0,
            status: String(data.status || '').toUpperCase(),
            issuedBy: data.issuedBy || '',
            issuedByName: data.issuedByName || '',
            issuedByRole: data.issuedByRole || '',
            complaintId: data.complaintId || '',
            reviewedAt: Number(data.reviewedAt) || 0,
            adminNote: data.adminNote || ''
        };
    }

    function listenSuspensionRequests(callback) {
        return db.collection('driver_actions')
            .where('actionType', '==', 'Suspension')
            .onSnapshot((snapshot) => callback(snapshot.docs.map(mapDriverActionDoc)));
    }

    // Every approval / rejection this admin site has logged, for the Approved and
    // Rejected lists in Driver Verification (who decided, when, and why).
    function listenVerificationDecisions(callback) {
        return db.collection('driver_actions')
            .where('actionType', 'in', ['Approval', 'Rejection'])
            .onSnapshot(
                (snapshot) => callback(snapshot.docs.map(mapDriverActionDoc)),
                (error) => {
                    console.error('Failed to load verification decisions:', error);
                    callback([]);
                }
            );
    }

    // The driver risk score (0-100) the app's Cloud Functions keep in
    // driver_risk/{driverId}. Read only — the functions are the only writer,
    // and the admin site must not recalculate it: two copies of the formula
    // would drift apart. A driver with no doc hasn't been scored yet (treated
    // as LOW). The score only advises; nothing is suspended automatically.
    function mapDriverRiskDoc(doc) {
        const data = doc.data() || {};
        return {
            driverId: doc.id,
            todaName: data.todaName || '',
            score: Number(data.score) || 0,
            level: String(data.level || 'LOW').toUpperCase(),
            suggestedAction: data.suggestedAction || 'No Action',
            reasons: Array.isArray(data.reasons) ? data.reasons.map(String) : [],
            bayesianRating: Number(data.bayesianRating) || 0,
            ratingCount: Number(data.ratingCount) || 0,
            openComplaints: Number(data.openComplaints) || 0,
            priorWarnings: Number(data.priorWarnings) || 0,
            priorSuspensions: Number(data.priorSuspensions) || 0,
            updatedAtRaw: toDate(data.updatedAt)
        };
    }

    function listenDriverRisk(callback) {
        return db.collection('driver_risk').onSnapshot(
            (snapshot) => callback(snapshot.docs.map(mapDriverRiskDoc)),
            (error) => {
                console.error('Failed to load driver risk scores:', error);
                callback([]);
            }
        );
    }

    async function fetchAdminIds() {
        const ids = new Set();
        if (auth.currentUser) ids.add(auth.currentUser.uid);
        try {
            const snapshot = await db.collection(COLLECTIONS.admins).get();
            snapshot.docs.forEach((doc) => ids.add(doc.id));
        } catch (error) {
            console.error('Could not list admin accounts:', error);
        }
        return ids;
    }

    // The president's app shows a suspension recommendation as "Awaiting admin"
    // until the admin acts on it. Called when the admin suspends the driver
    // (APPROVED) or closes the case without suspending (REJECTED), so the
    // president sees what happened; adminNote is shown under it in the app.
    async function settleDriverActions(actionIds, decision, adminNote) {
        if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Error('Unknown decision.');
        const reviewedAt = Date.now();
        const reviewedBy = auth.currentUser ? auth.currentUser.uid : '';
        const note = String(adminNote || '').trim();
        for (let i = 0; i < actionIds.length; i += 400) {
            const batch = db.batch();
            actionIds.slice(i, i + 400).forEach((id) => {
                batch.update(db.collection('driver_actions').doc(id), { status: decision, reviewedAt, adminNote: note, reviewedBy });
            });
            await batch.commit();
        }
    }

    // Suspensions this admin site logged before `status` existed have none, so
    // the president's app shows them as "awaiting admin". Mark them decided.
    async function repairAdminSuspensionStatus(actions, adminIds) {
        const stale = actions.filter((a) => a.actionType === 'Suspension' && !a.status && adminIds.has(a.issuedBy));
        for (let i = 0; i < stale.length; i += 400) {
            const batch = db.batch();
            stale.slice(i, i + 400).forEach((a) => {
                batch.update(db.collection('driver_actions').doc(a.id), { status: 'APPROVED' });
            });
            await batch.commit();
        }
        return stale.length;
    }

    async function updateDriverVerification(driverId, status) {
        const payload = {
            verificationStatus: status,
            verifiedAt: firebase.firestore.FieldValue.serverTimestamp(),
            infoRequest: null
        };
        // Approving the driver also approves the profile photo they registered
        // with — the admin checked it against the ID photo in the same review.
        if (status === 'approved') {
            payload.isVerified = true;
            payload.profilePhotoStatus = 'approved';
        }
        await db.collection(COLLECTIONS.users).doc(driverId).update(payload);
    }

    // Profile photos: the app sets profilePhotoStatus to "pending" whenever a
    // driver adds or replaces their photo (the new photo is already visible to
    // passengers); the admin settles it here.
    async function approveProfilePhoto(driverId) {
        await db.collection(COLLECTIONS.users).doc(driverId).update({
            profilePhotoStatus: 'approved'
        });
    }

    // Rejecting clears the photo so passengers stop seeing it, and tells the
    // driver why. The old file stays in Storage; the app replaces it on the
    // driver's next upload.
    async function rejectProfilePhoto(driverId, reason = '') {
        await db.collection(COLLECTIONS.users).doc(driverId).update({
            profilePhotoStatus: 'rejected',
            profileImage: '',
            profilePhotoRejectReason: reason
        });

        const ref = db.collection('notifications').doc();
        await ref.set({
            notificationId: ref.id,
            userId: driverId,
            title: 'Profile photo rejected',
            message: reason
                ? `Your profile photo was not accepted: ${reason}. Please add a new photo from your profile.`
                : 'Your profile photo was not accepted. Please add a new photo from your profile.',
            type: 'profile_photo',
            refId: driverId,
            bookingId: '',
            isRead: false,
            createdAt: Date.now()
        });
    }

    // When a suspension ends: 'permanent' never does (null), anything else is
    // that many days (3 if it isn't a positive number).
    function suspensionEndDate(suspensionDays) {
        if (suspensionDays === 'permanent') return null;
        const days = Number(suspensionDays) > 0 ? Number(suspensionDays) : 3;
        return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
    }

    async function updateDriverAccountStatus(driverId, status, suspensionDays = 3, reason = '') {
        const payload = {
            accountStatus: status,
            isSuspended: status === 'suspended',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (status === 'suspended') {
            payload.suspensionReason = reason || '';
            const endsAt = suspensionEndDate(suspensionDays);
            payload.suspendedUntil = endsAt ? firebase.firestore.Timestamp.fromDate(endsAt) : null;
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
            const endsAt = suspensionEndDate(suspensionDays);
            payload.suspendedUntil = endsAt ? firebase.firestore.Timestamp.fromDate(endsAt) : null;
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

    async function writeNotificationDocs(userIds, title, message, bookingId = '') {
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
                    bookingId,
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
    async function sendDirectNotification(recipientId, title, body, bookingId = '') {
        if (!recipientId) return;
        await writeNotificationDocs([recipientId], title, body, bookingId);
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

    // What the TODA president did about a complaint: the app links a driver
    // action (Warning / Invalid / Suspension recommendation) to it by complaintId.
    async function fetchDriverActionsForComplaint(complaintId) {
        const snapshot = await db.collection('driver_actions').where('complaintId', '==', complaintId).get();
        return snapshot.docs.map(mapDriverActionDoc).sort((a, b) => b.issuedAt - a.issuedAt);
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
                status: disabled ? 'disabled' : 'active',
                // Saved as milliseconds when the account is created here.
                createdAt: toDate(getField(data, 'createdAt', 'created_at'))
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

    // The mobile app prices a ride as (util/FareCalculator.kt):
    //   fare = minimumFare + max(0, distanceKm - includedDistanceKm) * perKmRate
    // per person: a shared ride pays that per rider, a solo ride pays for two persons. The
    // app has not been checked against these numbers (₱20 minimum, 1 km, ₱5/km per person),
    // so they are the defaults here, and what the admin saves in settings/fare
    // is for the app to read.
    const APP_FARE_DEFAULTS = { minimumFare: 20, includedDistanceKm: 1, perKmRate: 5 };

    // The service fee is charged ON TOP of the fare (20% in all) and split three
    // ways. These are percentages of the fare; the app has to apply them when it
    // prices a ride — the admin site only stores them and estimates from them.
    const SERVICE_FEE_DEFAULTS = { serviceFeeParaPct: 12, serviceFeeDriverPct: 4, serviceFeeTodaPct: 4 };
    const SERVICE_FEE_KEYS = [
        ['serviceFeeParaPct', 'PARA service fee'],
        ['serviceFeeDriverPct', 'Driver service fee'],
        ['serviceFeeTodaPct', 'TODA service fee']
    ];

    async function getFareSettings() {
        const doc = await db.collection(COLLECTIONS.fare).doc('fare').get();
        const data = doc.exists ? (doc.data() || {}) : {};
        const read = (value, fallback) => {
            const number = Number(value);
            return value !== undefined && value !== null && value !== '' && Number.isFinite(number) ? number : fallback;
        };
        return {
            minimumFare: read(data.minimumFare, APP_FARE_DEFAULTS.minimumFare),
            includedDistanceKm: read(data.includedDistanceKm, APP_FARE_DEFAULTS.includedDistanceKm),
            perKmRate: read(data.perKmRate, APP_FARE_DEFAULTS.perKmRate),
            serviceFeeParaPct: read(data.serviceFeeParaPct, SERVICE_FEE_DEFAULTS.serviceFeeParaPct),
            serviceFeeDriverPct: read(data.serviceFeeDriverPct, SERVICE_FEE_DEFAULTS.serviceFeeDriverPct),
            serviceFeeTodaPct: read(data.serviceFeeTodaPct, SERVICE_FEE_DEFAULTS.serviceFeeTodaPct),
            updatedAtRaw: toDate(getField(data, 'updatedAt', 'updated_at'))
        };
    }

    function validateFareSettings(settings) {
        const fields = [
            ['minimumFare', 'Minimum Fare'],
            ['includedDistanceKm', 'Included Distance'],
            ['perKmRate', 'Per Kilometer Rate']
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
        let feeTotal = 0;
        for (const [key, label] of SERVICE_FEE_KEYS) {
            const value = settings[key];
            if (!Number.isFinite(value) || value < 0) {
                throw new Error(`${label} must be a number of 0 or more.`);
            }
            feeTotal += value;
        }
        if (feeTotal > 100) {
            throw new Error('The service fee shares can’t add up to more than 100%.');
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
            minimumFare: settings.minimumFare,
            includedDistanceKm: settings.includedDistanceKm,
            perKmRate: settings.perKmRate,
            serviceFeeParaPct: settings.serviceFeeParaPct,
            serviceFeeDriverPct: settings.serviceFeeDriverPct,
            serviceFeeTodaPct: settings.serviceFeeTodaPct
        };

        // Replace the document (not merge) so the old base-fare / service-fee
        // fields from the earlier version of this page don't linger.
        await db.collection(COLLECTIONS.fare).doc('fare').set({
            ...next,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        logFareChange(
            {
                minimumFare: previous.minimumFare, includedDistanceKm: previous.includedDistanceKm, perKmRate: previous.perKmRate,
                serviceFeeParaPct: previous.serviceFeeParaPct, serviceFeeDriverPct: previous.serviceFeeDriverPct, serviceFeeTodaPct: previous.serviceFeeTodaPct
            },
            next
        ).catch((error) => console.error('Failed to log fare change:', error));
    }
    // ── Prediction (driver availability & passenger demand) ────────────
    // Training data is what the mobile app already logs: where online drivers
    // are (driverLocationSamples, every ~5 min) and when they go on/offline
    // (driverStatusEvents), plus completed bookings. Trained coefficients are
    // saved in settings/driver_availability_model so every screen reads the
    // same model.
    const PREDICTION_PAGE_SIZE = 2000;
    const PREDICTION_MAX_LOG_DOCS = 60000;

    async function fetchActivityLog(collectionName, sinceDate) {
        const rows = [];
        let last = null;
        for (;;) {
            let query = db.collection(collectionName)
                .where('timestamp', '>=', sinceDate)
                .orderBy('timestamp')
                .limit(PREDICTION_PAGE_SIZE);
            if (last) query = query.startAfter(last);
            const snap = await query.get();
            snap.docs.forEach((doc) => {
                const data = doc.data() || {};
                const date = toDate(data.timestamp);
                if (!date || Number.isNaN(date.getTime())) return;
                rows.push({ driverId: data.driverId || '', area: data.area || '', ms: date.getTime() });
            });
            if (snap.size < PREDICTION_PAGE_SIZE) return { rows, truncated: false };
            if (rows.length >= PREDICTION_MAX_LOG_DOCS) return { rows, truncated: true };
            last = snap.docs[snap.docs.length - 1];
        }
    }

    async function fetchPredictionTrainingData(sinceDate) {
        const sinceMs = sinceDate.getTime();
        const [samples, events, bookingsSnap] = await Promise.all([
            fetchActivityLog('driverLocationSamples', sinceDate),
            fetchActivityLog('driverStatusEvents', sinceDate),
            db.collection(COLLECTIONS.bookings).where('status', '==', 'COMPLETED').get()
        ]);

        const bookings = [];
        bookingsSnap.docs.forEach((doc) => {
            const data = doc.data() || {};
            const pickup = data.pickupLatLng || {};
            const lat = Number(pickup.lat);
            const lng = Number(pickup.lng);
            // Counted when the ride ended; older bookings without completedAt
            // fall back to when they were booked.
            const ms = Number(data.completedAt) > 0 ? Number(data.completedAt) : Number(data.timestamp);
            if (!Number.isFinite(ms) || ms < sinceMs) return;
            const hasPickup = Boolean(lat || lng); // the app's "unset" point is 0,0
            bookings.push({
                driverId: data.driverId || '',
                lat: hasPickup ? lat : NaN,
                lng: hasPickup ? lng : NaN,
                ms,
                // booking created -> drop-off: the stretch the driver was busy
                createdMs: Number(data.timestamp),
                completedMs: Number(data.completedAt) > 0 ? Number(data.completedAt) : NaN,
                address: data.pickupLocation || ''
            });
        });

        return {
            samples: samples.rows,
            events: events.rows,
            bookings,
            truncated: samples.truncated || events.truncated
        };
    }

    // The LGU tide bulletin the admin uploads (Excel) is stored one document
    // per date in `tide_bulletin`, so the prediction page and the mobile app
    // read the same readings:
    //   tide_bulletin/{YYYY-MM-DD} = { date, readings: [{ minutes, feet, meters }], uploadedAt, uploadedBy }
    // `minutes` is minutes after midnight, Manila time. Uploading a date that
    // already exists replaces that date's readings; other dates are untouched.
    async function saveTideBulletin(readings) {
        const byDate = {};
        readings.forEach((r) => {
            if (!byDate[r.dateKey]) byDate[r.dateKey] = [];
            byDate[r.dateKey].push({ minutes: r.minutes, feet: r.feet, meters: r.meters });
        });
        const dates = Object.keys(byDate).sort();
        const uploadedBy = auth.currentUser ? auth.currentUser.uid : '';
        for (let i = 0; i < dates.length; i += 400) {
            const batch = db.batch();
            dates.slice(i, i + 400).forEach((dateKey) => {
                batch.set(db.collection('tide_bulletin').doc(dateKey), {
                    date: dateKey,
                    readings: byDate[dateKey].sort((a, b) => a.minutes - b.minutes),
                    uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    uploadedBy
                });
            });
            await batch.commit();
        }
        return { days: dates.length, readings: readings.length, from: dates[0], to: dates[dates.length - 1] };
    }

    // Removes every uploaded tide day (for when a wrong file was uploaded).
    async function clearTideBulletin() {
        const snap = await db.collection('tide_bulletin').get();
        for (let i = 0; i < snap.docs.length; i += 400) {
            const batch = db.batch();
            snap.docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
        }
        return { days: snap.size };
    }

    async function fetchTideBulletin(sinceDateKey) {
        let query = db.collection('tide_bulletin');
        if (sinceDateKey) query = query.where('date', '>=', sinceDateKey);
        const snap = await query.get();
        const readings = [];
        snap.docs.forEach((doc) => {
            const data = doc.data() || {};
            const dateKey = data.date || doc.id;
            (Array.isArray(data.readings) ? data.readings : []).forEach((r) => {
                if (Number.isFinite(r.minutes) && Number.isFinite(r.meters)) {
                    readings.push({ dateKey, minutes: r.minutes, feet: r.feet, meters: r.meters });
                }
            });
        });
        return readings;
    }

    // The trained Driver Availability model (coefficients, areas, past-demand
    // table, thresholds). One document per prediction, so the app and the
    // other prediction pages read only what they need.
    // Passenger booking demand is saved the same way in
    // settings/passenger_demand_model.
    const PREDICTION_MODEL_DOCS = {
        availability: 'driver_availability_model',
        demand: 'passenger_demand_model'
    };

    async function fetchDriverAvailabilityModel() {
        const doc = await db.collection(COLLECTIONS.fare).doc(PREDICTION_MODEL_DOCS.availability).get();
        return doc.exists ? doc.data() : null;
    }

    async function fetchPassengerDemandModel() {
        const doc = await db.collection(COLLECTIONS.fare).doc(PREDICTION_MODEL_DOCS.demand).get();
        return doc.exists ? doc.data() : null;
    }

    async function savePredictionModel(kind, model) {
        // Firestore rejects NaN/undefined and nested arrays; the model only
        // holds plain numbers, strings, arrays of those and maps.
        const clean = JSON.parse(JSON.stringify(model));
        await db.collection(COLLECTIONS.fare).doc(PREDICTION_MODEL_DOCS[kind]).set({
            ...clean,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedBy: auth.currentUser ? auth.currentUser.uid : ''
        });
    }

    const saveDriverAvailabilityModel = (model) => savePredictionModel('availability', model);
    const savePassengerDemandModel = (model) => savePredictionModel('demand', model);

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

        // Approved drivers whose new profile photo waits for review (Photo Changes).
        const pendingPhotoChanges = driverDocs.filter((doc) => {
            const data = doc.data() || {};
            return normalizeStatus(getField(data, 'verificationStatus', 'verification_status', 'status')) === 'approved'
                && String(data.profilePhotoStatus || '').toLowerCase() === 'pending';
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
            pendingPhotoChanges,
            openComplaints
        };
    }

    // A trip the driver ended more than 300 m from the destination is flagged by
    // the app (endedEarly). Most are harmless — the passenger asked to get off —
    // so reviewing it just records that an admin looked, with an optional note.
    async function markEarlyEndReviewed(bookingId, note = '') {
        await db.collection(COLLECTIONS.bookings).doc(bookingId).update({
            earlyEndReviewedAt: Date.now(),
            earlyEndReviewNote: note
        });
    }

    // Takes back one no-show: the passenger's count goes down by 1, never below 0,
    // and the booking is remembered in reversedNoShows so the same no-show can't
    // be reversed twice. Throws an Error with a plain-language message when it
    // can't be done.
    async function reverseNoShow(passengerId, bookingId) {
        const ref = db.collection(COLLECTIONS.users).doc(passengerId);
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw new Error('The passenger account was not found.');
            const data = snap.data() || {};
            const reversed = Array.isArray(data.reversedNoShows) ? data.reversedNoShows : [];
            if (reversed.includes(bookingId)) throw new Error('This no-show was already reversed.');
            if ((Number(data.noShowCount) || 0) <= 0) throw new Error('This passenger has no no-shows on record to reverse.');
            tx.update(ref, {
                noShowCount: firebase.firestore.FieldValue.increment(-1),
                reversedNoShows: firebase.firestore.FieldValue.arrayUnion(bookingId)
            });
        });
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
        approveProfilePhoto,
        rejectProfilePhoto,
        markEarlyEndReviewed,
        reverseNoShow,
        updateDriverAccountStatus,
        requestDriverInfo,
        logDriverAction,
        fetchDriverActions,
        listenSuspensionRequests,
        listenVerificationDecisions,
        listenDriverRisk,
        fetchAdminIds,
        settleDriverActions,
        repairAdminSuspensionStatus,
        reactivateExpiredDrivers,
        ensurePassengerProfile,
        fetchPassengers,
        listenPassengers,
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
        fetchDriverActionsForComplaint,
        sendDirectNotification,
        sendBroadcastNotification,
        fetchNotifications,
        fetchTodaPresidentAccounts,
        createTodaPresidentAccount,
        updateTodaPresidentAccount,
        updateTodaPresidentStatus,
        getFareSettings,
        saveFareSettings,
        fetchPredictionTrainingData,
        saveTideBulletin,
        clearTideBulletin,
        fetchTideBulletin,
        fetchDriverAvailabilityModel,
        saveDriverAvailabilityModel,
        fetchPassengerDemandModel,
        savePassengerDemandModel,
        getDashboardCounts,
        getDriverById,
        fetchDriverDocuments,
        computeDriverStats,
        normalizePlate,
        getComplaintById,
        formatDateTime,
        normalizeStatus
    };
})();

window.ParaFirestore = ParaFirestore;
