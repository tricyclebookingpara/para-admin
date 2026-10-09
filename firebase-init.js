if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK not loaded. Add firebase-app-compat.js before firebase-init.js.');
}

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

window.ParaFirebase = {
    auth: firebase.auth(),
    db: firebase.firestore(),
    // Only the dashboard loads the Storage SDK (driver documents); the login page doesn't.
    storage: typeof firebase.storage === 'function' ? firebase.storage() : null
};
