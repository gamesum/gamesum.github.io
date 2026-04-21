/**
 * AFTERGLO shared nav Account toggle.
 *
 * Signed out: #navAccountBtn → "Login" linking to signin.html.
 * Signed in:  replaces #navAccountBtn with a compact avatar-and-caret
 *             button that opens a dropdown (My Library / Settings / Sign Out).
 *
 * The mobile menu entry #mobileAccountBtn continues to flip between
 * "Login" ↔ "My Library" for a tap-friendly experience.
 */
(function () {
  var DROPDOWN_ID = 'navAccountDropdown';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureStyles() {
    if (document.getElementById('nav-account-css')) return;
    var style = document.createElement('style');
    style.id = 'nav-account-css';
    style.textContent = [
      '.nav-account-wrap{position:relative;display:inline-flex;align-items:center;}',
      '.nav-account-trigger{display:inline-flex;align-items:center;gap:8px;background:transparent;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:4px 12px 4px 4px;cursor:pointer;color:inherit;font:inherit;line-height:1;}',
      '.nav-account-trigger .nav-account-name{font-size:0.88rem;font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.nav-account-trigger:hover{border-color:var(--accent,#D4A43A);}',
      '.nav-account-trigger .caret{width:10px;height:10px;opacity:0.7;}',
      '.nav-account-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:200px;background:#0f0f0f;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:6px;box-shadow:0 12px 40px rgba(0,0,0,0.5);display:none;z-index:9999;}',
      '.nav-account-menu.open{display:block;}',
      '.nav-account-menu a,.nav-account-menu button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;border-radius:6px;color:#e2e8f0;background:transparent;border:none;cursor:pointer;font:inherit;text-decoration:none;}',
      '.nav-account-menu a:hover,.nav-account-menu button:hover{background:rgba(212,164,58,0.12);color:var(--accent,#D4A43A);}',
      '.nav-account-menu .menu-head{padding:10px 12px 6px;color:#94a3b8;font-size:0.78rem;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;}'
    ].join('');
    document.head.appendChild(style);
  }

  function buildSignedInEl(user) {
    ensureStyles();
    var avatar = (typeof window.avatarHtml === 'function')
      ? window.avatarHtml(user, 28)
      : '<span class="avatar avatar-initials" style="width:28px;height:28px;font-size:12px;">' +
        esc(((user && (user.displayName || user.email)) || 'U').charAt(0).toUpperCase()) + '</span>';

    var displayLabel = (user && (user.displayName || (user.email ? user.email.split('@')[0] : ''))) || 'Account';

    var wrap = document.createElement('div');
    wrap.className = 'nav-account-wrap';
    wrap.id = 'navAccountWrap';
    wrap.innerHTML =
      '<button type="button" class="nav-account-trigger" id="navAccountTrigger" aria-haspopup="menu" aria-expanded="false">' +
        avatar +
        '<span class="nav-account-name">' + esc(displayLabel) + '</span>' +
        '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</button>' +
      '<div class="nav-account-menu" id="' + DROPDOWN_ID + '" role="menu">' +
        '<div class="menu-head">' + esc((user && (user.displayName || user.email)) || 'Signed in') + '</div>' +
        '<a href="my-library.html" role="menuitem">My Library</a>' +
        '<a href="my-library.html#settings" role="menuitem">Settings</a>' +
        '<button type="button" id="navAccountSignOut" role="menuitem">Sign Out</button>' +
      '</div>';

    var trigger = wrap.querySelector('#navAccountTrigger');
    var menu = wrap.querySelector('#' + DROPDOWN_ID);
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.classList.toggle('open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) {
        menu.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    wrap.querySelector('#navAccountSignOut').addEventListener('click', function () {
      if (typeof window.signOutUser === 'function') window.signOutUser();
      else if (window.firebase && firebase.auth) firebase.auth().signOut();
      try { localStorage.removeItem('afterglo_user'); } catch (_) {}
      window.location.href = 'index.html';
    });
    return wrap;
  }

  function apply() {
    var btn = document.getElementById('navAccountBtn');
    var mobBtn = document.getElementById('mobileAccountBtn');
    var existingWrap = document.getElementById('navAccountWrap');
    if (!btn && !mobBtn && !existingWrap) return;
    if (!window.firebase || !firebase.auth) return;

    firebase.auth().onAuthStateChanged(function (u) {
      if (u) {
        if (mobBtn) { mobBtn.textContent = 'My Library'; mobBtn.href = 'my-library.html'; }
        // Replace the signed-out button with the avatar dropdown.
        var target = document.getElementById('navAccountBtn') || document.getElementById('navAccountWrap');
        if (target) {
          var wrap = buildSignedInEl({
            displayName: u.displayName || '',
            email:       u.email       || '',
            photoURL:    u.photoURL    || ''
          });
          target.replaceWith(wrap);
        }
      } else {
        if (mobBtn) { mobBtn.textContent = 'Login'; mobBtn.href = 'signin.html'; }
        var wrap = document.getElementById('navAccountWrap');
        if (wrap) {
          var a = document.createElement('a');
          a.id = 'navAccountBtn';
          a.href = 'signin.html';
          a.className = 'btn btn-ghost nav-cta';
          a.textContent = 'Login';
          wrap.replaceWith(a);
        } else {
          var existing = document.getElementById('navAccountBtn');
          if (existing) { existing.textContent = 'Login'; existing.href = 'signin.html'; }
        }
      }
    });
  }

  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
