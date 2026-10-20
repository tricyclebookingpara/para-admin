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
            // The 4th verification document: a photo of the tricycle permit
            // (franchise / MTOP). No number or expiry is collected.
            tricyclePermitImageUrl: getField(data, 'tricyclePermitImageUrl'),
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
        // The permit's file name ends in a timestamp (tricycle_permit_<ms>.jpg), so
        // it is matched by prefix. The tricyclePermitImageUrl field on the user doc
        // always points at the current file and is preferred; this is the fallback.
        const permit = listing.items.find((entry) => entry.name.toLowerCase().startsWith('tricycle_permit'));
        documents.tricyclePermit = permit ? await permit.getDownloadURL() : null;
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
            // Reports drivers filed about this passenger (kept by a Cloud Function).
            reportCount: Number(data.reportCount) || 0,
            reversedNoShows: Array.isArray(data.reversedNoShows) ? data.reversedNoShows : [],
            // Booking cooldown, kept by the app's countRideOutcome function: 3
            // late cancels / no-shows in 24 h pause booking (30 min, 2 h, 24 h).
            // 3 pauses in 30 days set cancelReviewFlag for the admin to review.
            bookingBlockedUntil: Number(data.bookingBlockedUntil) || 0,
            cooldownCount30d: Array.isArray(data.cooldownAts)
                ? data.cooldownAts.filter((t) => Date.now() - Number(t) < 30 * 24 * 60 * 60 * 1000).length
                : 0,
            cancelReviewFlag: data.cancelReviewFlag === true,
            cancelReviewFlaggedAt: Number(data.cancelReviewFlaggedAt) || 0
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
            // The service fee on top of the fare, from the percentages the app
            // saved on the booking. Not rounded per ride, so totals equal the fares
            // times the percentage; screens round only when they show an amount.
            // Bookings made before the fee have none: hasServiceFee is false and
            // the screens estimate.
            ...bookingServiceFee(data),
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
            // Who cancelled ('PASSENGER' / 'DRIVER'; blank on bookings cancelled before
            // the app recorded it), from what status, why, and who it counts against
            // ('cancelFault', written by the countRideOutcome function; blank = nobody).
            // cancelRequest.response is 'ACCEPTED' when both sides agreed to cancel.
            cancelledBy: String(data.cancelledBy || '').toUpperCase(),
            cancelledFromStatus: data.cancelledFromStatus || '',
            cancelReason: data.cancelReason || '',
            cancelFault: String(data.cancelFault || '').toUpperCase(),
            cancelRequestResponse: data.cancelRequest ? String(data.cancelRequest.response || '').toUpperCase() : '',
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
            // The passenger's Yes / No after the ride: 'CONFIRMED', 'DISPUTED', or
            // '' when they never answered.
            dropoffResponse: (data.dropoffConfirmation && data.dropoffConfirmation.response) || '',
            dropoffRespondedAtRaw: data.dropoffConfirmation ? toDate(data.dropoffConfirmation.at) : null
        };
    }

    function bookingServiceFee(data) {
        const fare = Number(data.fare) || 0;
        const pct = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
        const paraPct = pct(data.serviceFeeParaPct);
        const driverPct = pct(data.serviceFeeDriverPct);
        const todaPct = pct(data.serviceFeeTodaPct);
        const totalPct = paraPct + driverPct + todaPct;
        if (totalPct <= 0 || totalPct > 100 || fare <= 0) {
            return { hasServiceFee: false, serviceFee: 0, paraShare: 0, driverShare: 0, todaShare: 0, amountPaid: fare };
        }
        const paraShare = fare * paraPct / 100;
        const driverShare = fare * driverPct / 100;
        const todaShare = fare * todaPct / 100;
        const serviceFee = fare * totalPct / 100;
        return { hasServiceFee: true, serviceFee, paraShare, driverShare, todaShare, amountPaid: fare + serviceFee };
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

    // How serious a complaint is. Newer complaints store it; older ones are
    // worked out from the type, with the same table the app uses
    // (ComplaintCategory.severityOf).
    //
    // The scale is HIGH / MEDIUM / LOW (renamed on 2026-10-20 from SAFETY / HIGH / NORMAL,
    // the app team's severity-rename guide). HIGH used to be the middle level and now
    // is the top one, and documents written before the rename haven't been migrated.
    // The severity follows from the type, so a known type is read from this table and
    // old documents still show the right level; only an unknown type falls back to
    // what is stored.
    const COMPLAINT_SEVERITY_BY_TYPE = {
        'reckless driving': 'HIGH', 'unsafe driving': 'HIGH', 'harassment or threat': 'HIGH',
        'overcharging': 'MEDIUM', 'took a longer route': 'MEDIUM',
        'rude behavior': 'LOW', 'vehicle condition': 'LOW', 'other': 'LOW'
    };

    function complaintSeverity(data, complaintType) {
        const known = COMPLAINT_SEVERITY_BY_TYPE[String(complaintType || '').trim().toLowerCase()];
        if (known) return known;
        const stored = String(data.severity || '').toUpperCase();
        if (['HIGH', 'MEDIUM', 'LOW'].includes(stored)) return stored;
        return stored === 'SAFETY' ? 'HIGH' : 'LOW';
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
            severity: complaintSeverity(data, complaintType),
            todaName: data.todaName || '',
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
        // A warning or suspension also shows in the TODA president's driver
        // history, which the app reads by todaName. Approval / Rejection rows
        // are only this site's own verification log, so they stay out of it.
        let todaName = '';
        if (actionType === 'Warning' || actionType === 'Suspension') {
            try {
                const driverDoc = await db.collection(COLLECTIONS.users).doc(driverId).get();
                todaName = getField(driverDoc.data(), 'todaName');
            } catch (error) {
                console.error('Could not read the driver\'s TODA:', error);
            }
        }
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
            complaintId: options.complaintId || '',
            ...(todaName ? { todaName } : {})
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

    // Recommendations the president's app sends to the admin
    // (DriverActionType.needsAdminReview): a suspension, or a request for the
    // admin to review the driver further.
    const ADMIN_REVIEW_ACTION_TYPES = ['Suspension', 'Further Review'];

    function listenSuspensionRequests(callback) {
        return db.collection('driver_actions')
            .where('actionType', 'in', ADMIN_REVIEW_ACTION_TYPES)
            .onSnapshot((snapshot) => callback(snapshot.docs.map(mapDriverActionDoc)));
    }

    // Warnings, for the Warned filter in Complaints: the ones the admin issued
    // from a case carry that case's id (logDriverAction).
    function listenWarnings(callback) {
        return db.collection('driver_actions')
            .where('actionType', '==', 'Warning')
            .onSnapshot(
                (snapshot) => callback(snapshot.docs.map(mapDriverActionDoc)),
                (error) => {
                    console.error('Failed to load warnings:', error);
                    callback([]);
                }
            );
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

    // firestore.rules refuses a notification whose title is over 100 or
    // message over 500 characters, so longer text is cut to fit.
    const NOTIFICATION_TITLE_MAX = 100;
    const NOTIFICATION_MESSAGE_MAX = 500;

    function clampText(text, max) {
        const chars = Array.from(String(text || ''));
        return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
    }

    async function writeNotificationDocs(userIds, title, message, bookingId = '') {
        title = clampText(title, NOTIFICATION_TITLE_MAX);
        message = clampText(message, NOTIFICATION_MESSAGE_MAX);
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

    // The mobile app reads settings/fare live and prices a ride as
    // (util/FareCalculator.kt):
    //   fare = minimumFare + max(0, distanceKm - includedDistanceKm) * perKmRate
    // per person: a shared ride pays that per rider, a solo ride pays for two
    // persons. These defaults are also the app's (FareSettings.kt) and the
    // rules' (firestore.rules hasCurrentServiceFee), used until the admin
    // first saves.
    const APP_FARE_DEFAULTS = { minimumFare: 20, includedDistanceKm: 1, perKmRate: 5 };

    // The service fee is charged ON TOP of the fare (20% in all) and split three
    // ways. The app saves these percentages on every new booking (the rules
    // check they match settings/fare); the Cloud Functions charge GCash and the
    // cash drivers' tab (PARA + TODA shares) from them. A change here applies
    // to bookings made after it.
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

        const { updatedAtRaw, ...previousValues } = previous;
        logFareChange(previousValues, next).catch((error) => console.error('Failed to log fare change:', error));
    }
    // ── Prediction (driver availability & passenger demand) ────────────
    // Training data is what the mobile app already logs: where online drivers
    // are (driverLocationSamples), the status changes of drivers
    // (driverStatusEvents), every booking request, and the driver roster
    // (users with role DRIVER). See docs/MLR_DATA_SCHEMA.md for the exact fields
    // expected and which of them are verified. Models are saved in the
    // `settings` collection, see PREDICTION_MODEL_DOCS.
    const PREDICTION_PAGE_SIZE = 2000;
    const PREDICTION_MAX_LOG_DOCS = 120000;
    const DAY_MS = 24 * 3600 * 1000;

    // Training batches produced by fetchPredictionTrainingData IN THIS PAGE are
    // remembered here. The training code and the model-save
    // layer both ask whether a batch / batch id is one of them, so a data set
    // (or an artifact) that did not come through this function is refused.
    // This is a browser-side check, not a security boundary: see
    // docs/MLR_PRODUCTION_SAFEGUARDS.md.
    const trainingBatches = new WeakSet();
    const trainingBatchIds = new Set();

    function isOperationalBatch(raw) {
        return Boolean(raw && typeof raw === 'object' && trainingBatches.has(raw));
    }

    // A stored time, read without guessing. Only a Firestore Timestamp, a Date
    // or a millisecond number is accepted; seconds, text and anything outside
    // the plausible range are reported as invalid, not converted.
    function normalizeTimestamp(value, plausibleFromMs, nowMs) {
        const from = Number.isFinite(plausibleFromMs) ? plausibleFromMs : Date.UTC(2020, 0, 1);
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        let ms = NaN;
        let kind = 'missing';
        if (value === undefined || value === null || value === '') return { ms, kind, valid: false };
        if (typeof value === 'object' && typeof value.toDate === 'function') { ms = value.toDate().getTime(); kind = 'timestamp'; }
        else if (value instanceof Date) { ms = value.getTime(); kind = 'date'; }
        else if (typeof value === 'number') { ms = value; kind = value >= 1e11 ? 'number-ms' : 'number-seconds-or-small'; }
        else if (typeof value === 'string') { kind = 'string'; }
        else { kind = typeof value; }
        const valid = (kind === 'timestamp' || kind === 'date' || kind === 'number-ms')
            && Number.isFinite(ms) && ms >= from && ms <= now + DAY_MS;
        return { ms: valid ? ms : NaN, kind, valid };
    }

    // Seeded sample records are in the live collections (isSeed: true, ids SEED_...).
    // They are treated as ordinary history and only COUNTED (`seed`), so the page
    // can say how much of the history they are. A record is excluded only when its
    // driver/passenger is on the configured test-account lists.
    function exclusionOf(data, id, schema) {
        const s = schema || {};
        const drivers = s.excludeDriverIds || [];
        const passengers = s.excludePassengerIds || [];
        // a booking or log names the driver / passenger; a user document is the account itself
        if (drivers.includes(data.driverId) || passengers.includes(data.passengerId) || drivers.includes(data.uid) || drivers.includes(id) || passengers.includes(id)) return 'test-account';
        return '';
    }

    function isSeedRecord(data, id, schema) {
        const prefix = (schema && schema.seedIdPrefix) || 'SEED_';
        const ids = [data.driverId, data.passengerId, data.bookingId, data.rideGroupId, data.uid, id];
        return data.isSeed === true || ids.some((v) => typeof v === 'string' && v.startsWith(prefix));
    }

    // The status a driver event records. The field that holds it is read from
    // CONFIG.dataSchema.driverEvents.statusField (the schema check showed it is
    // `event`). Without a configured field no event has a recognised status and
    // the availability model is not built.
    function readEventStatus(data, statusField) {
        if (!statusField) return '';
        const value = data[statusField];
        return value === undefined || value === null ? '' : String(value).toUpperCase();
    }

    // Which kind of value the `timestamp` field holds, from the newest document.
    async function detectLogTimestampKind(collectionName, plausibleFromMs) {
        const snap = await db.collection(collectionName).orderBy('timestamp', 'desc').limit(1).get();
        if (snap.empty) return 'none';
        return normalizeTimestamp((snap.docs[0].data() || {}).timestamp, plausibleFromMs).kind;
    }

    // Newest first. If the cap is hit, the NEWEST contiguous stretch is kept and
    // `earliestMs` says where it starts, so the caller can cut its window there
    // (two truncated logs would otherwise cover different periods).
    async function fetchActivityLog(collectionName, sinceDate, options) {
        const o = options || {};
        const rows = [];
        const fieldsSeen = new Set();
        const stats = { read: 0, invalidTimestamp: 0, seed: 0, testAccount: 0 };
        const kind = await detectLogTimestampKind(collectionName, o.plausibleFromMs);
        if (kind === 'none') return { rows, truncated: false, kind, earliestMs: NaN, fieldsSeen: [], stats };
        if (kind !== 'timestamp' && kind !== 'number-ms') {
            throw new Error(`The "timestamp" field of ${collectionName} is stored as "${kind}". Only Firestore Timestamps and millisecond numbers can be read; no data were used.`);
        }
        const bound = kind === 'timestamp' ? sinceDate : sinceDate.getTime();
        let last = null;
        let truncated = false;
        for (;;) {
            let query = db.collection(collectionName)
                .where('timestamp', '>=', bound)
                .orderBy('timestamp', 'desc')
                .limit(PREDICTION_PAGE_SIZE);
            if (last) query = query.startAfter(last);
            const snap = await query.get();
            snap.docs.forEach((doc) => {
                const data = doc.data() || {};
                stats.read += 1;
                if (exclusionOf(data, doc.id, o.schema) === 'test-account') { stats.testAccount += 1; return; }
                const t = normalizeTimestamp(data.timestamp, o.plausibleFromMs);
                if (!t.valid) { stats.invalidTimestamp += 1; return; }
                if (isSeedRecord(data, doc.id, o.schema)) stats.seed += 1;
                if (fieldsSeen.size < 40 && rows.length < 20) Object.keys(data).forEach((k) => fieldsSeen.add(k));
                const row = { driverId: data.driverId || '', area: data[o.locationField || 'area'] || '', ms: t.ms };
                if (o.withStatus) row.status = readEventStatus(data, o.statusField);
                rows.push(row);
            });
            if (snap.size < PREDICTION_PAGE_SIZE) break;
            if (rows.length >= PREDICTION_MAX_LOG_DOCS) { truncated = true; break; }
            last = snap.docs[snap.docs.length - 1];
        }
        const earliestMs = rows.reduce((m, r) => Math.min(m, r.ms), Infinity);
        return { rows, truncated, kind, earliestMs: Number.isFinite(earliestMs) ? earliestMs : NaN, fieldsSeen: [...fieldsSeen], stats };
    }

    // Eligibility facts about each driver. Approval and suspension are the
    // CURRENT state; the times (verifiedAt, suspendedAt/suspendedUntil) are what
    // lets the trainer decide whether a driver was eligible at an earlier hour.
    // A time that is not stored is NaN, and the trainer treats that driver's
    // earlier hours as uncertain.
    const rosterStats = { excluded: 0, seed: 0 };
    async function fetchDriverRoster(plausibleFromMs, schema) {
        let snap = await db.collection(COLLECTIONS.users).where('role', '==', 'DRIVER').get();
        if (snap.empty) snap = await db.collection(COLLECTIONS.users).get();
        const all = snap.docs.filter((doc) => isDriverRole(doc.data()));
        const kept = all.filter((doc) => exclusionOf(doc.data() || {}, doc.id, schema) === '');
        rosterStats.excluded = all.length - kept.length;
        rosterStats.seed = kept.filter((doc) => isSeedRecord(doc.data() || {}, doc.id, schema)).length;
        return kept.map((doc) => {
            const data = doc.data() || {};
            const driver = mapDriverDoc(doc);
            const at = (value) => normalizeTimestamp(value, plausibleFromMs).ms;
            return {
                id: doc.id,
                approved: driver.verificationStatus === 'approved',
                approvedAtMs: at(data.verifiedAt),
                suspended: driver.accountStatus === 'suspended',
                suspendedAtMs: at(data.suspendedAt),
                suspendedUntilMs: at(data.suspendedUntil)
            };
        });
    }

    // options.schema is ParaPrediction.CONFIG.dataSchema (which fields to read);
    // options.plausibleFromMs is CONFIG.plausibleFromMs.
    async function fetchPredictionTrainingData(sinceDate, options) {
        const o = options || {};
        const schema = o.schema || {};
        const sinceMs = sinceDate.getTime();
        const nowMs = Date.now();
        const eventSchema = schema.driverEvents || {};
        const locationSchema = schema.driverLocations || {};
        const bookingSchema = schema.bookings || {};
        const requestTimeFields = bookingSchema.requestTimeFields || ['timestamp', 'createdAt'];
        const barangayField = bookingSchema.pickupBarangayField || '';

        const [samples, events, bookingsSnap, roster] = await Promise.all([
            fetchActivityLog(locationSchema.collection || 'driverLocationSamples', sinceDate, { plausibleFromMs: o.plausibleFromMs, locationField: locationSchema.locationField || 'area', schema }),
            fetchActivityLog(eventSchema.collection || 'driverStatusEvents', sinceDate, { plausibleFromMs: o.plausibleFromMs, locationField: locationSchema.locationField || 'area', withStatus: true, statusField: eventSchema.statusField, schema }),
            // Every booking, any status: a request that was cancelled or never
            // matched is still demand. The collection is read whole once a day;
            // the booking time may be a number or a Timestamp, so it is filtered
            // here, not in the query.
            db.collection(COLLECTIONS.bookings).get(),
            fetchDriverRoster(o.plausibleFromMs, schema)
        ]);

        const bookingStats = { read: 0, fieldUse: {}, kinds: {}, missingTimestamp: 0, invalidTimestamp: 0, withRecordedBarangay: 0, seed: 0, testAccount: 0 };
        const bookings = [];
        bookingsSnap.docs.forEach((doc) => {
            const data = doc.data() || {};
            bookingStats.read += 1;
            if (exclusionOf(data, doc.id, schema) === 'test-account') { bookingStats.testAccount += 1; return; }
            if (isSeedRecord(data, doc.id, schema)) bookingStats.seed += 1;
            // The REQUEST time: the first of the configured fields that is present.
            let field = null;
            for (const name of requestTimeFields) {
                if (data[name] !== undefined && data[name] !== null && data[name] !== '') { field = name; break; }
            }
            const t = field ? normalizeTimestamp(data[field], o.plausibleFromMs, nowMs) : { ms: NaN, kind: 'missing', valid: false };
            if (!field) bookingStats.missingTimestamp += 1;
            else {
                bookingStats.fieldUse[field] = (bookingStats.fieldUse[field] || 0) + 1;
                bookingStats.kinds[t.kind] = (bookingStats.kinds[t.kind] || 0) + 1;
                if (!t.valid) bookingStats.invalidTimestamp += 1;
            }
            if (t.valid && t.ms < sinceMs) return;
            const pickup = data.pickupLatLng || {};
            const lat = Number(pickup.lat);
            const lng = Number(pickup.lng);
            const hasPickup = Boolean(lat || lng); // the app's "unset" point is 0,0
            const completedMs = Number(data.completedAt) > 0 ? normalizeTimestamp(data.completedAt, o.plausibleFromMs, nowMs).ms : NaN;
            // When the driver ACCEPTED the request (when the stored field exists).
            const acceptedField = bookingSchema.acceptedTimeField || 'acceptedAt';
            const acceptedMs = Number(data[acceptedField]) > 0 ? normalizeTimestamp(data[acceptedField], o.plausibleFromMs, nowMs).ms : NaN;
            const recorded = barangayField && typeof data[barangayField] === 'string' ? data[barangayField].trim() : '';
            if (recorded) bookingStats.withRecordedBarangay += 1;
            bookings.push({
                id: String(getField(data, 'bookingId', 'bookingRef') || doc.id),
                ms: t.valid ? t.ms : NaN,
                timeKind: t.kind,
                statusRaw: normalizeStatus(data.status),
                driverId: data.driverId || '',
                createdMs: t.valid ? t.ms : NaN,
                acceptedMs,
                completedMs,
                lat: hasPickup ? lat : NaN,
                lng: hasPickup ? lng : NaN,
                address: data.pickupLocation || '',
                recordedBarangay: recorded,
                isTest: data.isTest === true || data.isDemo === true,
                joinRequestExpired: data.joinRequestExpired === true
            });
        });

        // A truncated log keeps its newest stretch only; the usable window starts
        // where the SHORTEST of the truncated logs starts.
        const truncatedStarts = [samples, events].filter((l) => l.truncated && Number.isFinite(l.earliestMs)).map((l) => l.earliestMs);
        const dataStartMs = truncatedStarts.length ? Math.max(...truncatedStarts) : null;

        let projectId = '';
        try { projectId = firebase.app().options.projectId || ''; } catch (error) { /* not available */ }
        const batchId = `batch-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const raw = {
            samples: samples.rows,
            events: events.rows,
            bookings,
            roster,
            truncated: samples.truncated || events.truncated,
            dataStartMs,
            eventFieldsSeen: events.fieldsSeen,
            provenance: {
                source: 'firestore',
                seedPolicy: 'Seeded sample records (isSeed or SEED_ ids) are used as ordinary history and counted in seedIncluded; only listed test accounts are excluded; nothing is verified as genuine activity',
                batchId,
                projectId,
                readAt: nowMs,
                collections: [COLLECTIONS.bookings, eventSchema.collection || 'driverStatusEvents', locationSchema.collection || 'driverLocationSamples', COLLECTIONS.users],
                counts: { bookingDocs: bookingStats.read, samples: samples.rows.length, events: events.rows.length, roster: roster.length },
                seedIncluded: { bookings: bookingStats.seed, samples: samples.stats.seed, events: events.stats.seed, drivers: rosterStats.seed },
                testAccountExcluded: { bookings: bookingStats.testAccount, samples: samples.stats.testAccount, events: events.stats.testAccount },
                assumptions: schema.assumptions || [],
                timestamps: {
                    bookings: bookingStats,
                    samples: { kind: samples.kind, invalid: samples.stats.invalidTimestamp },
                    events: { kind: events.kind, invalid: events.stats.invalidTimestamp }
                },
                schemaVerified: Boolean(bookingSchema.verified && eventSchema.verified && locationSchema.verified),
                statusField: eventSchema.statusField || null,
                dataStartMs
            }
        };
        trainingBatches.add(raw);
        trainingBatchIds.add(batchId);
        return raw;
    }

    // A read-only summary of what the booking, driver-event, driver-location and
    // driver documents actually contain: field names, value types, how the time
    // is stored, and the values of short category-like fields. It shows no names,
    // addresses, ids or coordinates. Used to verify the schema the models depend
    // on (docs/MLR_DATA_SCHEMA.md); it writes nothing.
    async function inspectPredictionSchema(options) {
        const o = options || {};
        const schema = o.schema || {};
        const sampleSize = o.sampleSize || 200;
        const describe = (docs, extra) => {
            const out = { sampled: docs.length, fields: {}, categories: {}, time: {} };
            const distinct = {};
            docs.forEach((doc) => {
                const data = doc.data() || {};
                Object.keys(data).forEach((key) => {
                    const v = data[key];
                    const type = v === null ? 'null' : (Array.isArray(v) ? 'array' : (v && typeof v.toDate === 'function' ? 'timestamp' : typeof v));
                    const f = out.fields[key] || (out.fields[key] = { present: 0, types: {} });
                    f.present += 1;
                    f.types[type] = (f.types[type] || 0) + 1;
                    if (type === 'string' && v.length <= 24) {
                        const d = distinct[key] || (distinct[key] = {});
                        d[v.toUpperCase()] = (d[v.toUpperCase()] || 0) + 1;
                    }
                });
            });
            Object.keys(distinct).forEach((key) => {
                // category-like: few distinct short values (not names, addresses or ids)
                if (Object.keys(distinct[key]).length <= 12 && out.fields[key].present >= Math.min(20, docs.length)) out.categories[key] = distinct[key];
            });
            if (extra) extra(out, docs);
            return out;
        };
        const newest = async (name) => {
            try { return (await db.collection(name).orderBy('timestamp', 'desc').limit(sampleSize).get()).docs; } catch (error) { return (await db.collection(name).limit(sampleSize).get()).docs; }
        };
        const timeSummary = (out, docs, fields) => {
            const kinds = {};
            let min = Infinity;
            let max = -Infinity;
            docs.forEach((doc) => {
                const data = doc.data() || {};
                fields.forEach((f) => {
                    if (data[f] === undefined) return;
                    const t = normalizeTimestamp(data[f], o.plausibleFromMs);
                    kinds[`${f}:${t.kind}${t.valid ? '' : ' (invalid)'}`] = (kinds[`${f}:${t.kind}${t.valid ? '' : ' (invalid)'}`] || 0) + 1;
                    if (t.valid) { min = Math.min(min, t.ms); max = Math.max(max, t.ms); }
                });
            });
            out.time = { kinds, earliestMs: Number.isFinite(min) ? min : null, latestMs: Number.isFinite(max) ? max : null };
        };
        const bookingDocs = (await db.collection(COLLECTIONS.bookings).limit(sampleSize).get()).docs;
        const eventDocs = await newest((schema.driverEvents || {}).collection || 'driverStatusEvents');
        const locationDocs = await newest((schema.driverLocations || {}).collection || 'driverLocationSamples');
        const driverDocs = (await db.collection(COLLECTIONS.users).where('role', '==', 'DRIVER').limit(sampleSize).get()).docs;
        const requestFields = (schema.bookings || {}).requestTimeFields || ['timestamp', 'createdAt'];
        return {
            checkedAt: Date.now(),
            bookings: describe(bookingDocs, (out, docs) => {
                timeSummary(out, docs, requestFields);
                out.hasPickupBarangayField = (schema.bookings || {}).pickupBarangayField
                    ? docs.filter((d) => typeof (d.data() || {})[schema.bookings.pickupBarangayField] === 'string').length : null;
            }),
            driverEvents: describe(eventDocs, (out, docs) => timeSummary(out, docs, ['timestamp'])),
            driverLocations: describe(locationDocs, (out, docs) => timeSummary(out, docs, ['timestamp'])),
            drivers: describe(driverDocs, (out, docs) => {
                out.withVerifiedAt = docs.filter((d) => (d.data() || {}).verifiedAt != null).length;
                out.suspendedWithSuspendedAt = docs.filter((d) => normalizeStatus((d.data() || {}).accountStatus) === 'suspended' && (d.data() || {}).suspendedAt != null).length;
                out.suspended = docs.filter((d) => normalizeStatus((d.data() || {}).accountStatus) === 'suspended').length;
            })
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

    // Trained models: one document per prediction, so other screens read only
    // what they need.
    const PREDICTION_MODEL_DOCS = { availability: 'driver_availability_model', demand: 'passenger_demand_model' };
    const PREDICTION_STATUS_DOC = 'prediction_training_status';
    const PREDICTION_LOCK_DOC = 'prediction_training_lock';
    const PREDICTION_LOCK_MS = 10 * 60 * 1000;

    function modelDocFor(kind) {
        const doc = PREDICTION_MODEL_DOCS[kind];
        if (!doc) throw new Error(`Unknown model "${kind}".`);
        return doc;
    }

    async function fetchPredictionModel(kind) {
        const doc = await db.collection(COLLECTIONS.fare).doc(modelDocFor(kind)).get();
        return doc.exists ? doc.data() : null;
    }

    // The checks that must pass BEFORE anything is written, so a failed or
    // invalid training can never replace the last valid model.
    function assertSavableModel(kind, model) {
        modelDocFor(kind);
        if (!model || typeof model !== 'object') throw new Error('Refusing to save: there is no model.');
        if (model.kind !== kind) throw new Error(`Refusing to save: this is the ${model.kind} model, not ${kind}.`);
        // Where the training records came from: a batch that
        // fetchPredictionTrainingData read from Firestore in this session.
        const prov = model.provenance;
        if (model.dataSource !== 'firestore' || !prov || prov.source !== 'firestore' || !prov.batchId || !trainingBatchIds.has(prov.batchId)) {
            throw new Error('Refusing to save: a model must come from a training batch read from Firestore in this session; this one did not.');
        }
        if (!model.coverage || !Number.isFinite(model.coverage.usableDays)) throw new Error('Refusing to save: the data-coverage record is missing.');
        if (!model.modelId || !model.windowStart || !model.windowEnd || !model.trainedAt) throw new Error('Refusing to save: model metadata is incomplete.');
        if (!Array.isArray(model.features) || !Array.isArray(model.areas) || !model.features.length) throw new Error('Refusing to save: feature list is missing.');
        if (!Number.isFinite(model.intercept) || !model.features.every((name) => Number.isFinite((model.coefficients || {})[name]))) {
            throw new Error('Refusing to save: a coefficient is missing or not a finite number.');
        }
        if (!model.thresholds || typeof model.thresholds.available !== 'boolean') throw new Error('Refusing to save: the P33 / P67 thresholds are missing.');
        if (!model.evaluation || typeof model.evaluation.performed !== 'boolean') throw new Error('Refusing to save: the evaluation record is missing.');
    }

    async function savePredictionModel(kind, model) {
        assertSavableModel(kind, model);
        // Firestore rejects NaN/undefined and nested arrays; the model only
        // holds plain numbers, strings, arrays of those and maps.
        const clean = JSON.parse(JSON.stringify(model));
        await db.collection(COLLECTIONS.fare).doc(modelDocFor(kind)).set({
            ...clean,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedBy: auth.currentUser ? auth.currentUser.uid : ''
        });
    }

    // Only one browser retrains at a time. A lock that was not released
    // (closed tab) expires after PREDICTION_LOCK_MS.
    async function acquirePredictionLock(owner) {
        const ref = db.collection(COLLECTIONS.fare).doc(PREDICTION_LOCK_DOC);
        return db.runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            const data = doc.exists ? doc.data() : null;
            if (data && data.owner !== owner && Number(data.expiresAt) > Date.now()) return false;
            tx.set(ref, { owner, acquiredAt: Date.now(), expiresAt: Date.now() + PREDICTION_LOCK_MS });
            return true;
        });
    }

    async function releasePredictionLock(owner) {
        const ref = db.collection(COLLECTIONS.fare).doc(PREDICTION_LOCK_DOC);
        await db.runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (doc.exists && doc.data().owner === owner) tx.delete(ref);
        });
    }

    // What the last production training attempt did, so the page can say that
    // the model on show is older than the latest (failed) attempt.
    async function fetchPredictionTrainingStatus() {
        const doc = await db.collection(COLLECTIONS.fare).doc(PREDICTION_STATUS_DOC).get();
        return doc.exists ? doc.data() : null;
    }

    async function savePredictionTrainingStatus(status) {
        await db.collection(COLLECTIONS.fare).doc(PREDICTION_STATUS_DOC).set({
            ...JSON.parse(JSON.stringify(status)),
            attemptedAt: Date.now(),
            updatedBy: auth.currentUser ? auth.currentUser.uid : ''
        });
    }

    // Adds the seeded sample history made by tools/seed-hagonoy-history.js. Only
    // records flagged isSeed with a SEED_ id are ever written, each with set() on
    // its own id (nothing real is overwritten or deleted). In batches of 400.
    async function writeSeedHistory(docs, onProgress) {
        const targets = { users: COLLECTIONS.users, bookings: COLLECTIONS.bookings, driverStatusEvents: 'driverStatusEvents', driverLocationSamples: 'driverLocationSamples' };
        const names = Object.keys(targets);
        names.forEach((name) => {
            (docs[name] || []).forEach((doc) => {
                if (doc.isSeed !== true || !/^SEED_/.test(String(doc.id))) throw new Error(`Refusing to write: a ${name} record is not a flagged seed record.`);
            });
        });
        const total = names.reduce((n, name) => n + (docs[name] || []).length, 0);
        let done = 0;
        const counts = {};
        for (const name of names) {
            const list = docs[name] || [];
            for (let i = 0; i < list.length; i += 400) {
                const batch = db.batch();
                list.slice(i, i + 400).forEach((doc) => { const { id, ...rest } = doc; batch.set(db.collection(targets[name]).doc(id), rest); });
                await batch.commit();
                done += Math.min(400, list.length - i);
                if (onProgress) onProgress(done, total, name);
            }
            counts[name] = list.length;
        }
        return counts;
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

    // Frequent-cancel review (see mapPassengerDoc): the admin reviewed the
    // passenger and clears the flag; the app re-flags after 3 more pauses.
    async function clearCancelReviewFlag(passengerId) {
        await db.collection(COLLECTIONS.users).doc(passengerId).update({ cancelReviewFlag: false });
    }

    // Ends a booking cooldown early.
    async function liftBookingPause(passengerId) {
        await db.collection(COLLECTIONS.users).doc(passengerId).update({ bookingBlockedUntil: 0 });
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
        reverseNoShow,
        clearCancelReviewFlag,
        liftBookingPause,
        updateDriverAccountStatus,
        requestDriverInfo,
        logDriverAction,
        fetchDriverActions,
        listenSuspensionRequests,
        listenWarnings,
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
        isOperationalBatch,
        inspectPredictionSchema,
        normalizeTimestamp,
        saveTideBulletin,
        clearTideBulletin,
        fetchTideBulletin,
        fetchPredictionModel,
        savePredictionModel,
        writeSeedHistory,
        acquirePredictionLock,
        releasePredictionLock,
        fetchPredictionTrainingStatus,
        savePredictionTrainingStatus,
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
