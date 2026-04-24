/* ───────────────────────────────────────────────────────────────────────────
 * AFTERGLO Sequence Detail Viewer (shared)
 * Used by platform.html (store) and my-library.html.
 *
 * Usage:
 *   AGSequenceViewer.open(seqObjectOrId, { onDownload, onBuy, showActions })
 *
 * If you pass a string id, it fetches the Firestore /sequences/{id} doc.
 * If you pass an object (already-hydrated Firestore data), renders directly.
 *
 * Dark palette: #0f0f11 surfaces, #D4A43A gold accent, #e2e8f0 text.
 * No em dashes anywhere in copy.
 * ─────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  // ─── one-time DOM + CSS injection ─────────────────────────────────────────
  let _injected = false;
  let _currentSeq = null;
  let _activePhotoIdx = 0;

  const PROP_ICONS = {
    roofline: '🏠', arch: '🌈', tree: '🌲', 'mega-tree': '🎄',
    stake: '⚡', window: '🪟', yard: '🌟', 'candy-cane': '🍬', other: '✨'
  };

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = (str == null ? '' : String(str));
    return d.innerHTML;
  }

  function durationDisplay(secs) {
    if (!secs || secs <= 0) return '—'.replace('—', '--');
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m + 'm ' + s + 's';
  }

  function inject() {
    if (_injected) return;
    _injected = true;

    const style = document.createElement('style');
    style.textContent = `
      .agv-root { position:fixed; inset:0; z-index:9000; pointer-events:none;
                  display:flex; align-items:center; justify-content:center; }
      .agv-root.open { pointer-events:all; }
      .agv-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.78);
                      opacity:0; transition:opacity 0.25s; }
      .agv-root.open .agv-backdrop { opacity:1; }
      .agv-panel {
        position:relative; z-index:1;
        width:92vw; max-width:980px; height:88vh;
        background:#0f0f11; border:1px solid #2a2a2a; border-radius:20px;
        box-shadow:0 32px 96px rgba(0,0,0,0.8);
        transform:scale(0.94) translateY(28px); opacity:0;
        transition:transform 0.28s cubic-bezier(0.34,1.2,0.64,1), opacity 0.22s ease;
        overflow-y:auto; display:flex; flex-direction:column;
        color:#e2e8f0;
      }
      .agv-root.open .agv-panel { transform:scale(1) translateY(0); opacity:1; }
      .agv-close {
        position:sticky; top:0; right:0; align-self:flex-end;
        margin:16px 16px 0;
        background:#1a1a1a; border:1px solid #333; color:#fff; border-radius:50%;
        width:44px; height:44px; font-size:1.1rem; cursor:pointer;
        z-index:2; flex-shrink:0;
      }
      .agv-close:hover { background:#2a2a2a; }
      .agv-hero {
        width:100%; aspect-ratio:16/9; max-height:420px;
        background:#1a1a1a; position:relative; overflow:hidden;
      }
      .agv-hero img { width:100%; height:100%; object-fit:cover; display:block; }
      .agv-hero-placeholder { width:100%; height:100%; }
      .agv-thumbs {
        display:flex; gap:8px; padding:12px 24px 0; overflow-x:auto;
        scrollbar-width:thin;
      }
      .agv-thumb {
        flex:0 0 auto; width:84px; height:52px; border-radius:8px;
        border:2px solid transparent; cursor:pointer;
        background-size:cover; background-position:center;
        opacity:0.6; transition:opacity 0.15s, border-color 0.15s;
      }
      .agv-thumb:hover { opacity:0.9; }
      .agv-thumb.active { border-color:#D4A43A; opacity:1; }
      .agv-body { padding:24px; flex:1; }
      .agv-title {
        font-family:'Outfit',sans-serif; font-size:1.6rem; font-weight:800;
        color:#fff; margin-bottom:4px;
      }
      .agv-creator { color:#D4A43A; font-size:0.9rem; margin-bottom:16px; }
      .agv-pill {
        display:inline-block; padding:4px 12px; border-radius:20px;
        font-size:0.75rem; font-weight:700; margin-right:8px;
      }
      .agv-pill.free { background:rgba(74,222,128,0.12); color:#4ade80; }
      .agv-pill.paid { background:rgba(212,164,58,0.15); color:#D4A43A; }
      .agv-song {
        background:#17171a; border:1px solid #222; border-radius:10px;
        padding:14px; margin-bottom:16px; display:flex; align-items:center; gap:12px;
      }
      .agv-song-yt {
        margin-left:auto; background:#ff0000; color:#fff; padding:6px 12px;
        border-radius:6px; font-size:0.8rem; font-weight:600; white-space:nowrap;
        text-decoration:none;
      }
      .agv-stats {
        display:grid; grid-template-columns:repeat(3,1fr); gap:12px;
        margin-bottom:20px;
      }
      .agv-stat {
        background:#17171a; border:1px solid #222; border-radius:8px;
        padding:12px; text-align:center;
      }
      .agv-stat-val { font-size:1.1rem; font-weight:700; color:#fff; }
      .agv-stat-key { font-size:0.7rem; color:#666; margin-top:2px;
                      text-transform:uppercase; letter-spacing:0.05em; }
      .agv-desc { color:#94a3b8; font-size:0.95rem; line-height:1.6;
                  margin-bottom:20px; white-space:pre-wrap; }
      .agv-props { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:20px; }
      .agv-prop {
        background:rgba(255,255,255,0.05); border:1px solid #2a2a2a;
        border-radius:8px; padding:6px 10px; font-size:0.8rem; color:#cbd5e1;
      }
      .agv-yt-wrap {
        position:relative; padding-bottom:56.25%; border-radius:10px;
        overflow:hidden; margin-bottom:20px;
      }
      .agv-yt-wrap iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
      .agv-actions {
        padding:20px 0; border-top:1px solid #222;
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        flex-wrap:wrap;
      }
      .agv-price {
        font-family:'Outfit',sans-serif; font-size:1.8rem; font-weight:800;
      }
      .agv-price.free { color:#4ade80; }
      .agv-price.paid { color:#D4A43A; }
      .agv-cta {
        flex:1; min-width:180px; font-weight:700; font-size:1rem;
        padding:14px 16px; border:none; border-radius:12px; cursor:pointer;
        min-height:48px;
      }
      .agv-cta.buy { background:#D4A43A; color:#000; }
      .agv-cta.free { background:#4ade80; color:#000; }
      @media(max-width:600px){
        .agv-panel { width:100vw; height:100dvh; border-radius:0; border:none; }
        .agv-stats { grid-template-columns:repeat(3,1fr); gap:8px; }
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'agvRoot';
    root.className = 'agv-root';
    root.innerHTML = `
      <div class="agv-backdrop" data-agv-close></div>
      <div class="agv-panel">
        <button class="agv-close" data-agv-close aria-label="Close">&#x2715;</button>
        <div id="agvContent"></div>
      </div>
    `;
    document.body.appendChild(root);

    root.addEventListener('click', (e) => {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-agv-close') !== null) {
        close();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('open')) close();
    });
  }

  function setActivePhoto(idx) {
    if (!_currentSeq || !_currentSeq._photos) return;
    _activePhotoIdx = idx;
    const hero = document.getElementById('agvHero');
    const url = _currentSeq._photos[idx];
    if (hero && url) {
      hero.innerHTML = '<img src="' + esc(url) + '" alt="Sequence photo ' + (idx + 1) + '" />';
    }
    document.querySelectorAll('.agv-thumb').forEach((t, i) => {
      t.classList.toggle('active', i === idx);
    });
  }

  function render(seq, opts) {
    inject();
    opts = opts || {};
    _currentSeq = seq;
    _activePhotoIdx = 0;

    const photos = Array.isArray(seq.photos) ? seq.photos.filter(p => typeof p === 'string' && p.length)
      : (seq.coverPhoto ? [seq.coverPhoto] : []);
    seq._photos = photos;

    const isFree = seq.free || seq.isFree || (Number(seq.price || 0) === 0);
    const price = Number(seq.price || 0);
    const gradient = seq.gradient || seq.thumbnailGradient || 'linear-gradient(135deg,#1a1a1a,#333)';

    const heroHtml = photos.length
      ? '<img src="' + esc(photos[0]) + '" alt="Sequence cover" />'
      : '<div class="agv-hero-placeholder" style="background:' + esc(gradient) + '"></div>';

    const thumbsHtml = photos.length > 1
      ? '<div class="agv-thumbs">' + photos.map((p, i) =>
          '<div class="agv-thumb' + (i === 0 ? ' active' : '') + '"' +
          ' style="background-image:url(' + "'" + esc(p) + "'" + ')"' +
          ' data-agv-photo-idx="' + i + '"></div>'
        ).join('') + '</div>'
      : '';

    let ytEmbed = null;
    if (seq.youtubeUrl && typeof seq.youtubeUrl === 'string') {
      let e2 = seq.youtubeUrl.replace('watch?v=', 'embed/').replace('youtu.be/', 'www.youtube.com/embed/');
      if (e2.indexOf('youtube.com/embed/') !== -1 && e2.indexOf('http') !== 0) e2 = 'https://' + e2;
      ytEmbed = e2;
    }

    const durSecs = Number(seq.durationSecs || 0);
    const durStr = durSecs ? (Math.floor(durSecs / 60) + 'm ' + (durSecs % 60) + 's') : (seq.duration || '--');
    const channels = seq.channels || seq.channelCount || '--';
    const downloads = seq.downloads || seq.downloadCount || 0;
    const category = seq.category ? esc(String(seq.category)) : '';

    const propsHtml = (Array.isArray(seq.props) && seq.props.length)
      ? '<div class="agv-props">' + seq.props.map(p =>
          '<span class="agv-prop">' + (PROP_ICONS[p] || '💡') + ' ' + esc(p) + '</span>'
        ).join('') + '</div>'
      : '';

    const showActions = opts.showActions !== false;
    const actionsHtml = showActions ? `
      <div class="agv-actions">
        <div class="agv-price ${price > 0 ? 'paid' : 'free'}">
          ${price > 0 ? '$' + price.toFixed(2) : 'Free'}
        </div>
        ${price > 0
          ? '<button class="agv-cta buy" data-agv-buy>Buy $' + price.toFixed(2) + '</button>'
          : '<button class="agv-cta free" data-agv-download>Download Free</button>'}
      </div>` : '';

    const content = `
      <div class="agv-hero" id="agvHero">${heroHtml}</div>
      ${thumbsHtml}
      <div class="agv-body">
        <span class="agv-pill ${isFree ? 'free' : 'paid'}">${isFree ? 'Free' : 'Premium'}</span>
        ${category ? '<span class="agv-pill" style="background:#17171a;color:#cbd5e1;border:1px solid #2a2a2a;">' + category + '</span>' : ''}
        <div class="agv-title" style="margin-top:12px;">${esc(seq.name || 'Untitled')}</div>
        <div class="agv-creator">by ${esc(seq.creator || 'Community')}</div>

        ${seq.songName ? `<div class="agv-song">
          <span style="font-size:1.4rem;">&#9834;</span>
          <div>
            <div style="font-size:0.75rem;color:#666;margin-bottom:2px;letter-spacing:0.05em;">SYNCED TO</div>
            <div style="color:#fff;font-weight:600;">${esc(seq.songName)}</div>
          </div>
          ${seq.youtubeUrl ? '<a class="agv-song-yt" href="' + esc(seq.youtubeUrl) + '" target="_blank" rel="noopener">&#9654; YouTube</a>' : ''}
        </div>` : ''}

        <div class="agv-stats">
          <div class="agv-stat"><div class="agv-stat-val">${esc(durStr)}</div><div class="agv-stat-key">Duration</div></div>
          <div class="agv-stat"><div class="agv-stat-val">${esc(String(channels))}</div><div class="agv-stat-key">Channels</div></div>
          <div class="agv-stat"><div class="agv-stat-val">${esc(String(downloads))}</div><div class="agv-stat-key">Downloads</div></div>
        </div>

        ${seq.description ? '<p class="agv-desc">' + esc(seq.description) + '</p>' : ''}
        ${propsHtml}
        ${ytEmbed ? '<div class="agv-yt-wrap"><iframe src="' + esc(ytEmbed) + '" allowfullscreen loading="lazy"></iframe></div>' : ''}
        ${actionsHtml}
      </div>
    `;

    const box = document.getElementById('agvContent');
    box.innerHTML = content;

    // Wire thumbnail clicks
    box.querySelectorAll('.agv-thumb').forEach(t => {
      t.addEventListener('click', () => {
        const i = parseInt(t.getAttribute('data-agv-photo-idx'), 10);
        if (!isNaN(i)) setActivePhoto(i);
      });
    });

    // Wire CTA buttons
    const buyBtn = box.querySelector('[data-agv-buy]');
    if (buyBtn) buyBtn.addEventListener('click', () => {
      if (typeof opts.onBuy === 'function') { opts.onBuy(seq); close(); return; }
      if (typeof global.startStripeCheckout === 'function') {
        global.startStripeCheckout({
          sequenceId: String(seq.id),
          sequenceName: seq.name,
          creator: seq.creator,
          price: price
        });
        close();
      }
    });
    const dlBtn = box.querySelector('[data-agv-download]');
    if (dlBtn) dlBtn.addEventListener('click', (ev) => {
      if (typeof opts.onDownload === 'function') { opts.onDownload(seq, ev); close(); return; }
      if (typeof global.handleDownload === 'function') {
        global.handleDownload(ev, String(seq.id));
        close();
      }
    });

    const root = document.getElementById('agvRoot');
    root.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  async function open(seqOrId, opts) {
    inject();
    if (typeof seqOrId === 'string') {
      // Fetch from Firestore
      if (typeof global.firebase === 'undefined' || !global.firebase.firestore) {
        console.warn('AGSequenceViewer: Firebase not loaded; cannot fetch sequence by id.');
        return;
      }
      try {
        const snap = await global.firebase.firestore().collection('sequences').doc(seqOrId).get();
        if (snap.exists) {
          const data = snap.data();
          data.id = snap.id;
          render(data, opts || {});
        } else {
          // Fallback: render minimal stub
          render({ id: seqOrId, name: 'Sequence unavailable', creator: 'Unknown' }, opts || {});
        }
      } catch (err) {
        console.warn('AGSequenceViewer: Firestore fetch failed', err);
        render({ id: seqOrId, name: 'Sequence unavailable', creator: 'Unknown' }, opts || {});
      }
    } else if (seqOrId && typeof seqOrId === 'object') {
      // If caller passes a lightweight object but we have firestore, enrich with full doc.
      const hasEnough = seqOrId.photos || seqOrId.description || seqOrId.props;
      if (!hasEnough && seqOrId.id && global.firebase && global.firebase.firestore) {
        try {
          const snap = await global.firebase.firestore().collection('sequences').doc(String(seqOrId.id)).get();
          if (snap.exists) {
            const data = Object.assign({}, seqOrId, snap.data());
            data.id = snap.id;
            render(data, opts || {});
            return;
          }
        } catch (err) { /* render what we have */ }
      }
      render(seqOrId, opts || {});
    }
  }

  function close() {
    const root = document.getElementById('agvRoot');
    if (root) root.classList.remove('open');
    document.body.style.overflow = '';
  }

  global.AGSequenceViewer = { open, close };
})(window);
