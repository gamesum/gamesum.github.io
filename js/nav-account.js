/**
 * AFTERGLO shared nav Account toggle.
 *
 * Flips the #navAccountBtn between "Account" → signin.html
 * and "My Library" → my-library.html based on Firebase auth state.
 * Falls back to "Account" when Firebase is not loaded on the page.
 */
(function () {
  function apply() {
    var btn = document.getElementById('navAccountBtn');
    var mobBtn = document.getElementById('mobileAccountBtn');
    if (!btn && !mobBtn) return;
    if (!window.firebase || !firebase.auth) return;
    firebase.auth().onAuthStateChanged(function (u) {
      if (u) {
        if (btn)    { btn.textContent    = 'My Library'; btn.href    = 'my-library.html'; }
        if (mobBtn) { mobBtn.textContent = 'My Library'; mobBtn.href = 'my-library.html'; }
      } else {
        if (btn)    { btn.textContent    = 'Account'; btn.href    = 'signin.html'; }
        if (mobBtn) { mobBtn.textContent = 'Account'; mobBtn.href = 'signin.html'; }
      }
    });
  }
  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
