if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK not loaded. Add firebase-app-compat.js before firebase-init.js.');
}

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

window.ParaFirebase = {
    auth: firebase.auth(),
    db: firebase.firestore()
};
