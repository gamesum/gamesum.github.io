/**
 * AFTERGLO Collections Module
 *
 * Local-first, localStorage-backed groupings of saved sequences, purchased
 * packs, and uploaded shows. Attaches to window.AGCollections. Non-ESM.
 *
 * Data shape:
 *   user.collections = [{ id, name, createdAt }]
 *   user.library[i].collectionId   = string
 *   user.purchases[i].collectionId = string
 *   user.uploads[i].collectionId   = string
 *
 * All mutating functions operate on the user object passed in. The caller is
 * responsible for persisting via saveUser(user).
 */
(function () {
  'use strict';

  var DEFAULT_ID   = 'default';
  var DEFAULT_NAME = 'My Shows';
  var MAX_NAME_LEN = 40;

  /* ── palette ───────────────────────────────────────────────── */
  var C = {
    gold:    '#D4A43A',
    bright:  '#F0C04A',
    text:    '#F2F2F4',
    muted:   '#9A9AA2',
    surface: '#0F0F11',
    card:    '#17171A',
    border:  '#3A3A42',
    danger:  '#f87171'
  };

  /* ── utils ─────────────────────────────────────────────────── */
  function uid() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function normName(s) { return String(s == null ? '' : s).trim(); }
  function lc(s)       { return normName(s).toLowerCase(); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  /* ── migrations ────────────────────────────────────────────── */
  function ensureCollections(user) {
    if (!user) return user;
    if (!Array.isArray(user.collections)) user.collections = [];
    if (!user.collections.length) {
      user.collections.push({
        id:        DEFAULT_ID,
        name:      DEFAULT_NAME,
        createdAt: Date.now()
      });
    }
    // Guarantee a default-id collection exists. If the only collection uses a
    // different id (because the user renamed or recreated one), we still need
    // the reserved default so legacy items without a collectionId land safely.
    if (!user.collections.find(function (c) { return c.id === DEFAULT_ID; })) {
      user.collections.unshift({
        id:        DEFAULT_ID,
        name:      DEFAULT_NAME,
        createdAt: Date.now()
      });
    }
    var names = ['library', 'purchases', 'uploads'];
    for (var i = 0; i < names.length; i++) {
      var arr = user[names[i]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        if (!arr[j].collectionId) arr[j].collectionId = DEFAULT_ID;
      }
    }
    return user;
  }

  function listCollections(user) {
    ensureCollections(user);
    return user.collections.slice().sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  function findByName(user, name) {
    var target = lc(name);
    return (user.collections || []).find(function (c) { return lc(c.name) === target; });
  }

  function createCollection(user, name) {
    ensureCollections(user);
    var clean = normName(name);
    if (!clean) {
      var err = new Error('Give your collection a name.');
      err.code = 'EMPTY';
      throw err;
    }
    if (clean.length > MAX_NAME_LEN) {
      var errLen = new Error('Collection name must be 40 characters or fewer.');
      errLen.code = 'TOO_LONG';
      throw errLen;
    }
    if (findByName(user, clean)) {
      var errDup = new Error('You already have a collection with that name.');
      errDup.code = 'DUPLICATE';
      throw errDup;
    }
    var col = { id: uid(), name: clean, createdAt: Date.now() };
    user.collections.push(col);
    return col;
  }

  function renameCollection(user, id, newName) {
    ensureCollections(user);
    var clean = normName(newName);
    if (!clean) {
      var err = new Error('Give your collection a name.');
      err.code = 'EMPTY';
      throw err;
    }
    if (clean.length > MAX_NAME_LEN) {
      var errLen = new Error('Collection name must be 40 characters or fewer.');
      errLen.code = 'TOO_LONG';
      throw errLen;
    }
    var dup = findByName(user, clean);
    if (dup && dup.id !== id) {
      var errDup = new Error('You already have a collection with that name.');
      errDup.code = 'DUPLICATE';
      throw errDup;
    }
    var col = user.collections.find(function (c) { return c.id === id; });
    if (!col) {
      var err404 = new Error('Collection not found.');
      err404.code = 'NOT_FOUND';
      throw err404;
    }
    col.name = clean;
    return col;
  }

  function deleteCollection(user, id, opts) {
    ensureCollections(user);
    opts = opts || {};
    if (id === DEFAULT_ID) {
      var errDef = new Error('The default collection cannot be deleted.');
      errDef.code = 'PROTECTED';
      throw errDef;
    }
    var col = user.collections.find(function (c) { return c.id === id; });
    if (!col) return false;

    var names = ['library', 'purchases', 'uploads'];
    if (opts.reassignTo) {
      var target = user.collections.find(function (c) { return c.id === opts.reassignTo; });
      if (!target) {
        var err = new Error('Target collection not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      for (var i = 0; i < names.length; i++) {
        var arr = user[names[i]];
        if (!Array.isArray(arr)) continue;
        for (var j = 0; j < arr.length; j++) {
          if (arr[j].collectionId === id) arr[j].collectionId = opts.reassignTo;
        }
      }
    } else {
      // Delete items permanently
      for (var k = 0; k < names.length; k++) {
        var arrD = user[names[k]];
        if (!Array.isArray(arrD)) continue;
        user[names[k]] = arrD.filter(function (it) { return it.collectionId !== id; });
      }
    }
    user.collections = user.collections.filter(function (c) { return c.id !== id; });
    return true;
  }

  function assignItem(user, arrayName, itemId, collectionId) {
    ensureCollections(user);
    var arr = user[arrayName];
    if (!Array.isArray(arr)) return false;
    var col = user.collections.find(function (c) { return c.id === collectionId; });
    if (!col) return false;
    var found = false;
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i].id) === String(itemId)) {
        arr[i].collectionId = collectionId;
        found = true;
      }
    }
    return found;
  }

  /* ── picker modal ──────────────────────────────────────────── */
  function openPickerModal(opts) {
    opts = opts || {};
    var title     = opts.title || 'Add to Collection';
    var onPick    = typeof opts.onPick === 'function' ? opts.onPick : function () {};
    var onCancel  = typeof opts.onCancel === 'function' ? opts.onCancel : function () {};

    // Always pull fresh user so the list reflects any recent saves
    var user = (typeof getUser === 'function') ? getUser() : null;
    if (!user) {
      onCancel();
      return;
    }
    ensureCollections(user);
    if (typeof saveUser === 'function') saveUser(user); // persist migration

    // Remove any existing picker
    var prior = document.getElementById('agColPickerOverlay');
    if (prior) prior.remove();

    var overlay = document.createElement('div');
    overlay.id = 'agColPickerOverlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:Inter,sans-serif;';

    var card = document.createElement('div');
    card.style.cssText =
      'background:' + C.card + ';border:1px solid ' + C.border + ';' +
      'border-radius:12px;padding:24px;width:420px;max-width:100%;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.6);color:' + C.text + ';';

    card.innerHTML =
      '<div style="font-family:Outfit,sans-serif;font-size:1.1rem;font-weight:800;' +
      'color:' + C.text + ';margin-bottom:4px;">' + esc(title) + '</div>' +
      '<div style="font-size:0.82rem;color:' + C.muted + ';margin-bottom:18px;">' +
      'Pick a collection or create a new one.</div>' +
      '<div id="agColPickerList" style="display:flex;flex-direction:column;gap:8px;' +
      'max-height:240px;overflow-y:auto;margin-bottom:16px;"></div>' +
      '<div style="border-top:1px solid ' + C.border + ';padding-top:16px;margin-top:4px;">' +
      '<div style="font-size:0.78rem;color:' + C.muted + ';margin-bottom:8px;font-weight:600;' +
      'letter-spacing:0.04em;text-transform:uppercase;">New Collection</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<input id="agColNewName" type="text" maxlength="40" placeholder="e.g. Halloween 2026" ' +
      'style="flex:1;height:36px;padding:0 10px;border-radius:6px;background:' + C.card + ';' +
      'color:' + C.text + ';border:1px solid ' + C.border + ';outline:none;font-size:0.9rem;" />' +
      '<button id="agColCreateBtn" type="button" ' +
      'style="height:36px;padding:0 14px;border-radius:6px;border:none;cursor:pointer;' +
      'background:' + C.gold + ';color:#000;font-weight:700;font-size:0.85rem;">Create</button>' +
      '</div>' +
      '<div id="agColErr" style="color:' + C.danger + ';font-size:0.78rem;margin-top:6px;min-height:1em;"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">' +
      '<button id="agColCancelBtn" type="button" ' +
      'style="background:none;border:1px solid ' + C.border + ';color:' + C.muted + ';' +
      'padding:8px 14px;border-radius:8px;font-size:0.85rem;cursor:pointer;">Cancel</button>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus styling on the input
    var input = card.querySelector('#agColNewName');
    input.addEventListener('focus', function () { input.style.borderColor = C.gold; });
    input.addEventListener('blur',  function () { input.style.borderColor = C.border; });

    var errEl = card.querySelector('#agColErr');
    function showErr(msg) { errEl.textContent = msg || ''; }

    function renderList() {
      var list = card.querySelector('#agColPickerList');
      list.innerHTML = '';
      var cols = listCollections(user);
      cols.forEach(function (col) {
        var count = 0;
        ['library', 'purchases', 'uploads'].forEach(function (k) {
          if (!Array.isArray(user[k])) return;
          for (var i = 0; i < user[k].length; i++) {
            if (user[k][i].collectionId === col.id) count++;
          }
        });
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;' +
          'gap:12px;text-align:left;padding:12px 14px;border-radius:8px;' +
          'border:1px solid ' + C.border + ';background:' + C.surface + ';' +
          'color:' + C.text + ';cursor:pointer;font-size:0.92rem;font-family:inherit;';
        btn.innerHTML =
          '<span style="font-weight:600;">' + esc(col.name) + '</span>' +
          '<span style="font-size:0.78rem;color:' + C.muted + ';">' +
          count + ' item' + (count === 1 ? '' : 's') + '</span>';
        btn.addEventListener('mouseenter', function () {
          btn.style.borderColor = C.gold;
          btn.style.background  = 'rgba(212,164,58,0.08)';
        });
        btn.addEventListener('mouseleave', function () {
          btn.style.borderColor = C.border;
          btn.style.background  = C.surface;
        });
        btn.addEventListener('click', function () {
          cleanup();
          onPick(col.id);
        });
        list.appendChild(btn);
      });
    }

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function cancel() {
      cleanup();
      onCancel();
    }
    function onKey(e) {
      if (e.key === 'Escape') cancel();
    }

    card.querySelector('#agColCancelBtn').addEventListener('click', cancel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey);

    function doCreate() {
      showErr('');
      var v = input.value;
      try {
        var col = createCollection(user, v);
        if (typeof saveUser === 'function') saveUser(user);
        cleanup();
        onPick(col.id);
      } catch (err) {
        showErr(err.message || 'Could not create collection.');
        input.focus();
      }
    }
    card.querySelector('#agColCreateBtn').addEventListener('click', doCreate);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { e.preventDefault(); doCreate(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });

    renderList();
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ── public API ────────────────────────────────────────────── */
  window.AGCollections = {
    DEFAULT_ID:        DEFAULT_ID,
    DEFAULT_NAME:      DEFAULT_NAME,
    MAX_NAME_LEN:      MAX_NAME_LEN,
    ensureCollections: ensureCollections,
    listCollections:   listCollections,
    createCollection:  createCollection,
    renameCollection:  renameCollection,
    deleteCollection:  deleteCollection,
    assignItem:        assignItem,
    openPickerModal:   openPickerModal
  };
})();
