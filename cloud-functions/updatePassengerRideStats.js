// ═══════════════════════════════════════════════════════════════════════
// Cloud Function — keeps a passenger's ride stats accurate in real time.
//
// This is NOT part of the admin webapp — it's a Firebase Cloud Function
// that has to be deployed separately (its own project setup, `firebase
// deploy --only functions`). It mirrors whatever already maintains
// drivers.totalRides/rating on the backend, just for the users
// (passenger) collection instead.
//
// What it does: watches every booking document for writes. Whenever a
// booking's status changes TO "completed" or "cancelled" (and wasn't
// already in that state), it increments the matching passenger's
// totalRides by 1 (every attempt counts), plus cancelledRides by 1 if
// the outcome was a cancellation — so cancelledRides/totalRides is a
// real, bounded 0-100% cancel rate. Runs inside a transaction so
// concurrent updates can't double-count or race.
//
// Setup (for whoever owns the Functions project):
//   1. `firebase init functions` if this project doesn't have a
//      functions/ directory yet (Node.js runtime, firebase-admin +
//      firebase-functions as dependencies).
//   2. Copy this file's exported function into functions/index.js
//      (or require() it from there).
//   3. `firebase deploy --only functions:onBookingWriteUpdatePassengerStats`
//
// Adjust the field names below (BOOKINGS_COLLECTION, USERS_COLLECTION,
// STATUS_FIELD, PASSENGER_ID_FIELD) if your actual Firestore schema
// differs — these match what the admin webapp currently guesses.
// ═══════════════════════════════════════════════════════════════════════

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

const BOOKINGS_COLLECTION = 'bookings';
const USERS_COLLECTION = 'users';
const STATUS_FIELD = 'status';
const PASSENGER_ID_FIELD = 'passengerId'; // change if your bookings use a different field name

function normalizeStatus(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '_');
}

exports.onBookingWriteUpdatePassengerStats = functions.firestore
    .document(`${BOOKINGS_COLLECTION}/{bookingId}`)
    .onWrite(async (change, context) => {
        const before = change.before.exists ? change.before.data() : null;
        const after = change.after.exists ? change.after.data() : null;
        if (!after) return null; // booking deleted — nothing to count

        const previousStatus = normalizeStatus(before ? before[STATUS_FIELD] : null);
        const currentStatus = normalizeStatus(after[STATUS_FIELD]);
        if (previousStatus === currentStatus) return null; // no status change, nothing to do

        const passengerId = after[PASSENGER_ID_FIELD];
        if (!passengerId) {
            console.warn(`Booking ${context.params.bookingId} has no ${PASSENGER_ID_FIELD}; skipping passenger stats update.`);
            return null;
        }

        const isNowCompleted = currentStatus === 'completed';
        const isNowCancelled = currentStatus === 'cancelled' || currentStatus === 'canceled';
        if (!isNowCompleted && !isNowCancelled) return null;

        const passengerRef = db.collection(USERS_COLLECTION).doc(passengerId);

        return db.runTransaction(async (tx) => {
            const snap = await tx.get(passengerRef);
            if (!snap.exists) {
                console.warn(`Passenger ${passengerId} not found; skipping stats update for booking ${context.params.bookingId}.`);
                return;
            }

            // totalRides = every booking attempt (completed + cancelled), so
            // cancelledRides / totalRides is a real, bounded 0-100% cancel rate
            // — matching the admin webapp's computePassengerRideStats().
            const updates = {
                totalRides: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            if (isNowCancelled) {
                updates.cancelledRides = admin.firestore.FieldValue.increment(1);
            }

            tx.update(passengerRef, updates);
        });
    });
