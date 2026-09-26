document.addEventListener('DOMContentLoaded', () => {
    const togglePw = document.getElementById('togglePw');
    const passwordInput = document.getElementById('password');
    const eyeIcon = document.getElementById('eyeIcon');
    const errorText = document.getElementById('errorMsgText');
    

    togglePw.addEventListener('click', () => {
        const isText = passwordInput.type === 'text';
        passwordInput.type = isText ? 'password' : 'text';
        eyeIcon.innerHTML = isText
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    });

    function showLoginError(message) {
        const errorMsg = document.getElementById('errorMsg');
        errorText.textContent = message;
        errorMsg.classList.add('show');
        document.getElementById('email').classList.add('error');
        document.getElementById('password').classList.add('error');
        const card = document.querySelector('.login-card');
        card.style.animation = 'shake 0.35s ease';
        setTimeout(() => { card.style.animation = ''; }, 350);
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const errorMsg = document.getElementById('errorMsg');
        const loginBtn = document.getElementById('loginBtn');
        const btnText = document.getElementById('btnText');

        errorMsg.classList.remove('show');
        document.getElementById('email').classList.remove('error');
        document.getElementById('password').classList.remove('error');

        if (!window.ParaFirestore) {
            showLoginError('Firebase is not configured. Check firebase-config.js.');
            return;
        }

        if (!email || !password) {
            showLoginError('Email and password are required.');
            return;
        }

        loginBtn.classList.add('loading');
        loginBtn.disabled = true;
        btnText.textContent = 'Signing in…';

        try {
            await window.ParaFirestore.signIn(email, password);
            btnText.textContent = '✓ Redirecting…';
            window.location.href = 'dashboard.html';
        } catch (error) {
            console.error('Login failed:', error);
            loginBtn.classList.remove('loading');
            loginBtn.disabled = false;
            btnText.textContent = 'Sign In';

            showLoginError('Incorrect credentials.');
        }
    });
});
