/**
 * AFTERGLO Firebase Auth Module
 *
 * SETUP: Replace the firebaseConfig below with your project's config.
 * Get it from: Firebase Console → Project Settings → Your Apps → SDK setup and configuration
 *
 * Until configured, auth falls back to the existing localStorage mock so the
 * site continues to work during development.
 */

const firebaseConfig = {
  apiKey:            "AIzaSyAQ7L46n1Nos6nmNcDCAJu8tY1pFdn-zQY",
  authDomain:        "afterglo-website-fbb89.firebaseapp.com",
  projectId:         "afterglo-website-fbb89",
  storageBucket:     "afterglo-website-fbb89.firebasestorage.app",
  messagingSenderId: "307927449736",
  appId:             "1:307927449736:web:0a44b789fd7cab37d41f3d",
  measurementId:     "G-RT2CW89J7C",
};

// ─── Feature flag: is Firebase configured? ────────────────────────────────────
const FIREBASE_ENABLED = !firebaseConfig.apiKey.startsWith("REPLACE");

let _firebaseApp  = null;
let _firebaseAuth = null;

if (FIREBASE_ENABLED) {
  // Firebase v9 compat build (loaded via CDN in the HTML)
  // Guard against duplicate-app errors if the module is loaded more than once.
  try {
    _firebaseApp = firebase.apps.length
      ? firebase.apps[0]
      : firebase.initializeApp(firebaseConfig);
  } catch (e) {
    _firebaseApp = firebase.apps[0] || null;
  }

  // App Check (reCAPTCHA v3). Activates only if:
  //   1. firebase-app-check-compat.js is loaded in the HTML, AND
  //   2. window.AFTERGLO_APPCHECK_SITE_KEY is set to the reCAPTCHA v3 site key.
  // To enable site-wide: (a) register this site in Firebase Console → App Check
  // with reCAPTCHA v3, (b) add the compat script to every HTML page's <head>,
  // (c) set window.AFTERGLO_APPCHECK_SITE_KEY before this file loads, (d) enforce
  // App Check on Firestore/Functions/Storage in the console.
  try {
    if (_firebaseApp
        && typeof firebase.appCheck === 'function'
        && typeof window.AFTERGLO_APPCHECK_SITE_KEY === 'string'
        && window.AFTERGLO_APPCHECK_SITE_KEY.length > 0) {
      firebase.appCheck(_firebaseApp).activate(
        new firebase.appCheck.ReCaptchaV3Provider(window.AFTERGLO_APPCHECK_SITE_KEY),
        true
      );
    }
  } catch (e) { /* App Check optional; continue without it */ }

  _firebaseAuth = _firebaseApp ? firebase.auth(_firebaseApp) : null;

  if (!_firebaseAuth) { /* auth unavailable — will fall back to localStorage */ }
  else {
  // Explicitly set LOCAL persistence so the session survives page navigations
  _firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

  // Keep localStorage in sync whenever the Firebase auth state changes
  _firebaseAuth.onAuthStateChanged(async (fbUser) => {
    if (!fbUser) return;
    // Use non-force-refresh to avoid throwing on slow networks
    const idToken = await fbUser.getIdToken(false).catch(() => null);
    if (!idToken) return;
    const existing = getUser();
    const merged = Object.assign({}, existing || {}, {
      name:       fbUser.displayName || existing?.name || fbUser.email.split('@')[0],
      email:      fbUser.email,
      picture:    fbUser.photoURL   || existing?.picture || '',
      uid:        fbUser.uid,
      token:      idToken,
      library:    existing?.library    || [],
      purchases:  existing?.purchases  || [],
      uploads:    existing?.uploads    || [],
    });
    saveUser(merged);
  });
  } // end if (_firebaseAuth)
}

// ─── Shared localStorage helpers (used by all pages) ─────────────────────────

function getUser() {
  try { return JSON.parse(localStorage.getItem('afterglo_user')); } catch(e) { return null; }
}
function saveUser(u) {
  localStorage.setItem('afterglo_user', JSON.stringify(u));
}
function signOutUser() {
  localStorage.removeItem('afterglo_user');
  if (FIREBASE_ENABLED && _firebaseAuth) _firebaseAuth.signOut();
}

// Returns an ID token string for API calls, or the stored token as fallback.
// Does NOT force-refresh to avoid failures on slow networks.
async function getIdToken() {
  if (FIREBASE_ENABLED && _firebaseAuth && _firebaseAuth.currentUser) {
    return _firebaseAuth.currentUser.getIdToken(false).catch(() => getUser()?.token ?? null);
  }
  return getUser()?.token ?? null;
}

// ─── Email / Password ─────────────────────────────────────────────────────────

async function signInWithEmail(email, password) {
  if (!FIREBASE_ENABLED) {
    // Legacy mock path
    const existing = getUser();
    if (existing && existing.email.toLowerCase() === email.toLowerCase()) {
      existing.token = 'mock_' + Date.now();
      saveUser(existing);
      return { ok: true };
    }
    const user = { name: email.split('@')[0], email, token: 'mock_' + Date.now(),
                   library: [], purchases: [], uploads: [] };
    saveUser(user);
    return { ok: true };
  }

  try {
    const cred = await _firebaseAuth.signInWithEmailAndPassword(email, password);
    const idToken = await cred.user.getIdToken();
    saveUser({
      name:     cred.user.displayName || email.split('@')[0],
      email:    cred.user.email,
      uid:      cred.user.uid,
      token:    idToken,
      library:  getUser()?.library   || [],
      purchases: getUser()?.purchases || [],
      uploads:  getUser()?.uploads   || [],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: firebaseErrorMessage(err.code) };
  }
}

async function createAccountWithEmail(name, email, password) {
  if (!FIREBASE_ENABLED) {
    const user = { name, email, token: 'mock_' + Date.now(),
                   library: [], purchases: [], uploads: [] };
    saveUser(user);
    return { ok: true };
  }

  try {
    const cred = await _firebaseAuth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    const idToken = await cred.user.getIdToken();
    saveUser({ name, email, uid: cred.user.uid, token: idToken,
               library: [], purchases: [], uploads: [] });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: firebaseErrorMessage(err.code) };
  }
}

async function sendPasswordReset(email) {
  if (!FIREBASE_ENABLED) return { ok: false, message: 'Firebase not configured yet.' };
  try {
    await _firebaseAuth.sendPasswordResetEmail(email);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: firebaseErrorMessage(err.code) };
  }
}

// ─── Google Sign-In via Firebase popup/redirect ───────────────────────────────

async function signInWithGoogle() {
  if (!FIREBASE_ENABLED) {
    return { ok: false, message: 'Firebase not configured.' };
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  try {
    let cred;
    if (isMobile) {
      await _firebaseAuth.signInWithRedirect(provider);
      return { ok: true, redirecting: true };
    } else {
      cred = await _firebaseAuth.signInWithPopup(provider);
    }
    const idToken = await cred.user.getIdToken();
    const existing = getUser();
    saveUser({
      name:      cred.user.displayName || existing?.name || '',
      email:     cred.user.email,
      picture:   cred.user.photoURL    || existing?.picture || '',
      uid:       cred.user.uid,
      token:     idToken,
      library:   existing?.library    || [],
      purchases: existing?.purchases  || [],
      uploads:   existing?.uploads    || [],
    });
    return { ok: true, name: cred.user.displayName };
  } catch (err) {
    return { ok: false, message: firebaseErrorMessage(err.code) };
  }
}

async function checkGoogleRedirectResult() {
  if (!FIREBASE_ENABLED) return null;
  try {
    const cred = await _firebaseAuth.getRedirectResult();
    if (!cred || !cred.user) return null;
    const idToken = await cred.user.getIdToken();
    const existing = getUser();
    saveUser({
      name:      cred.user.displayName || existing?.name || '',
      email:     cred.user.email,
      picture:   cred.user.photoURL    || existing?.picture || '',
      uid:       cred.user.uid,
      token:     idToken,
      library:   existing?.library    || [],
      purchases: existing?.purchases  || [],
      uploads:   existing?.uploads    || [],
    });
    return { ok: true, name: cred.user.displayName };
  } catch (err) {
    return { ok: false, message: firebaseErrorMessage(err.code) };
  }
}

// Keep legacy GIS credential path for any existing callers
async function signInWithGoogleCredential(googleIdToken) {
  if (!FIREBASE_ENABLED) {
    const payload = JSON.parse(atob(googleIdToken.split('.')[1]));
    const { sub, email, name, picture } = payload;
    const existing = getUser();
    saveUser(Object.assign({}, existing || {}, {
      name, email, picture: picture || '',
      googleId: sub, token: 'google_' + sub,
      library:   existing?.library   || [],
      purchases: existing?.purchases || [],
      uploads:   existing?.uploads   || [],
    }));
    return { ok: true, name };
  }
  try {
    const credential = firebase.auth.GoogleAuthProvider.credential(googleIdToken);
    const cred = await _firebaseAuth.signInWithCredential(credential);
    const idToken = await cred.user.getIdToken();
    const existing = getUser();
    saveUser({
      name:      cred.user.displayName || existing?.name || '',
      email:     cred.user.email,
      picture:   cred.user.photoURL    || existing?.picture || '',
      uid:       cred.user.uid,
      token:     idToken,
      library:   existing?.library    || [],
      purchases: existing?.purchases  || [],
      uploads:   existing?.uploads    || [],
    });
    return { ok: true, name: cred.user.displayName };
  } catch (err) {
    return { ok: false, message: firebaseErrorMessage(err.code) };
  }
}

// ─── Firestore: sync purchases from backend ───────────────────────────────────

async function syncPurchasesFromFirestore() {
  const token = await getIdToken();
  if (!token) return [];
  try {
    const res = await fetch(
      `https://us-central1-afterglo-website-fbb89.cloudfunctions.net/purchases`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const purchases = data.purchases ?? [];
    const user = getUser();
    if (user) {
      user.purchases = purchases;
      saveUser(user);
    }
    return purchases;
  } catch (err) {
    console.warn('syncPurchases failed:', err);
    return [];
  }
}

// ─── Error message mapper ─────────────────────────────────────────────────────

function firebaseErrorMessage(code) {
  const map = {
    'auth/user-not-found':           'No account found with that email address.',
    'auth/wrong-password':           'Incorrect password.',
    'auth/invalid-credential':       'Email or password is incorrect.',
    'auth/invalid-login-credentials':'Email or password is incorrect.',
    'auth/INVALID_LOGIN_CREDENTIALS':'Email or password is incorrect.',
    'auth/email-already-in-use':     'An account with that email already exists.',
    'auth/weak-password':            'Password must be at least 6 characters.',
    'auth/invalid-email':            'Please enter a valid email address.',
    'auth/too-many-requests':        'Too many attempts. Please try again later.',
    'auth/network-request-failed':   'Network error. Check your connection.',
    'auth/operation-not-allowed':    'Email sign-in is not enabled. Contact support.',
    'auth/user-disabled':            'This account has been disabled.',
  };
  return map[code] || ('Sign-in failed (' + code + '). Please try again.');
}
