/**
 * AFTERGLO shared avatar helper.
 *
 * Exposes a global `avatarHtml(user, size)` that returns a markup string:
 *   - An <img class="avatar"> when a photoURL is present
 *   - A <span class="avatar avatar-initials"> fallback with initials on gold
 *
 * Also injects shared CSS once per page so every caller picks up the same
 * circular, object-fit: cover styling.
 *
 * `user` is tolerant of shape:
 *   { displayName, email, photoURL }  (Firebase)
 *   { name,        email, picture  }  (localStorage app user)
 */
(function () {
  if (typeof window === 'undefined') return;
  if (window.avatarHtml) return;

  // Inject shared CSS once.
  if (!document.getElementById('afterglo-avatar-css')) {
    var style = document.createElement('style');
    style.id = 'afterglo-avatar-css';
    style.textContent = [
      '.avatar{border-radius:50%;object-fit:cover;display:inline-block;vertical-align:middle;}',
      '.avatar-initials{display:inline-flex;align-items:center;justify-content:center;',
      'font-family:Outfit,system-ui,sans-serif;font-weight:700;',
      'background:var(--accent,#D4A43A);color:#1a1a1a;line-height:1;text-transform:uppercase;}',
      '.avatar-wrap{position:relative;display:inline-block;}'
    ].join('');
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pickInitials(user) {
    var src = (user && (user.displayName || user.name)) || '';
    if (src) {
      var parts = String(src).trim().split(/\s+/).slice(0, 2);
      return parts.map(function (p) { return p.charAt(0); }).join('').toUpperCase() || 'U';
    }
    var email = (user && user.email) || '';
    return email ? email.charAt(0).toUpperCase() : 'U';
  }

  function pickPhoto(user) {
    if (!user) return '';
    return user.photoURL || user.picture || '';
  }

  function pickLabel(user) {
    if (!user) return 'User';
    return user.displayName || user.name || user.email || 'User';
  }

  window.avatarHtml = function avatarHtml(user, size) {
    var s = Number(size) || 40;
    var photo = pickPhoto(user);
    var label = esc(pickLabel(user));
    var fontSize = Math.max(10, Math.round(s * 0.42));
    var dim = 'width:' + s + 'px;height:' + s + 'px;';
    if (photo) {
      return '<img class="avatar" src="' + esc(photo) + '" ' +
             'width="' + s + '" height="' + s + '" alt="' + label + '" ' +
             'style="' + dim + '" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'avatar avatar-initials\',textContent:\'' +
             esc(pickInitials(user)) + '\',style:\'' + dim + 'font-size:' + fontSize + 'px;\'}));" />';
    }
    return '<span class="avatar avatar-initials" style="' + dim +
           'font-size:' + fontSize + 'px;" aria-label="' + label + '">' +
           esc(pickInitials(user)) + '</span>';
  };

  // Expose initials helper for callers that need just the letters.
  window.avatarInitials = pickInitials;
})();
