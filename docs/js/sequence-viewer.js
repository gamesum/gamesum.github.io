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
        /* Outer panel must clip on every axis so the inner scroll container
           respects the rounded corners (otherwise the right side ends up
           with hard corners while the left appears rounded). */
        overflow:hidden; display:flex; flex-direction:column;
        color:#e2e8f0;
      }
      .agv-panel-scroll {
        flex:1; min-height:0; overflow-y:auto;
        display:flex; flex-direction:column;
      }
      .agv-root.open .agv-panel { transform:scale(1) translateY(0); opacity:1; }
      .agv-close {
        /* Floats above the scroll area so it always remains clickable. */
        position:absolute; top:14px; right:14px;
        background:rgba(26,26,26,0.92); border:1px solid #333; color:#fff; border-radius:50%;
        width:36px; height:36px; font-size:0.95rem; cursor:pointer;
        z-index:5;
        backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
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
      /* Side-by-side music + show video block */
      .agv-yt-pair {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 18px;
      }
      .agv-yt-tile {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .agv-yt-tile-label {
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #94a3b8;
      }
      .agv-yt-tile-frame {
        position: relative;
        padding-bottom: 56.25%;
        border-radius: 10px;
        overflow: hidden;
        background: #0e0e0e;
        border: 1px solid #2a2a2a;
      }
      .agv-yt-tile-frame iframe {
        position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
      }
      .agv-yt-placeholder {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 16px;
        color: #6b7280; font-size: 0.82rem; line-height: 1.5;
        background: repeating-linear-gradient(45deg, rgba(255,255,255,0.012) 0 8px, transparent 8px 16px), #0e0e0e;
      }
      .agv-yt-placeholder strong { color: #94a3b8; display: block; margin-bottom: 4px; }
      @media (max-width: 600px) {
        .agv-yt-pair { grid-template-columns: 1fr; }
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
      /* Reviews + ratings */
      .agv-reviews { margin-top:28px; padding-top:24px; border-top:1px solid #1f1f24; }
      .agv-reviews-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
      .agv-reviews-title { font-family:'Outfit',sans-serif; font-size:1.05rem; font-weight:800; color:#fff; }
      .agv-reviews-summary { font-size:0.9rem; color:#cbd5e1; display:flex; align-items:center; gap:8px; }
      .agv-rate-empty { color:#6b7280; font-size:0.85rem; }
      .agv-rate-num { font-weight:700; color:#fff; }
      .agv-rate-count { color:#94a3b8; font-size:0.82rem; }
      .agv-stars { color:#D4A43A; letter-spacing:1px; font-size:0.95rem; }

      .agv-review-form { background:#0f0f11; border:1px solid #2a2a2a; border-radius:10px; padding:14px; margin-bottom:18px; }
      .agv-rate-row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
      .agv-rate-label { font-size:0.82rem; color:#94a3b8; }
      .agv-rate-stars { display:flex; gap:4px; }
      .agv-rate-star { background:transparent; border:none; color:#4b5563; font-size:1.4rem; line-height:1; cursor:pointer; padding:2px 4px; transition:color 0.15s, transform 0.15s; }
      .agv-rate-star:hover { color:#D4A43A; transform:scale(1.1); }
      .agv-rate-star.on { color:#D4A43A; }
      .agv-review-form textarea { width:100%; background:#080808; border:1px solid #2a2a2a; color:#e2e8f0; padding:10px 12px; border-radius:8px; font-family:Inter,sans-serif; font-size:0.88rem; line-height:1.5; resize:vertical; }
      .agv-review-form-row { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:10px; flex-wrap:wrap; }
      .agv-review-count { font-size:0.72rem; color:#6b7280; }
      .agv-review-form-actions { display:flex; gap:8px; align-items:center; }
      .agv-review-cancel { background:transparent; border:1px solid #4a2222; color:#f87171; padding:6px 12px; border-radius:6px; font-size:0.78rem; cursor:pointer; }
      .agv-review-submit { background:#D4A43A; color:#000; border:none; padding:7px 16px; border-radius:6px; font-size:0.85rem; font-weight:700; cursor:pointer; }
      .agv-review-submit:disabled { opacity:0.6; cursor:not-allowed; }
      .agv-review-error { color:#f87171; font-size:0.82rem; margin-top:8px; }
      .agv-review-signin { background:#0f0f11; border:1px solid #2a2a2a; border-radius:10px; padding:12px 14px; margin-bottom:18px; font-size:0.85rem; color:#94a3b8; text-align:center; }
      .agv-review-signin a { color:#D4A43A; font-weight:600; }

      .agv-review-list { display:flex; flex-direction:column; gap:14px; }
      .agv-review { background:#0f0f11; border:1px solid #1f1f24; border-radius:10px; padding:14px; }
      .agv-review-head { display:flex; gap:10px; align-items:center; margin-bottom:8px; }
      .agv-review-av { flex:0 0 auto; }
      .agv-review-meta { display:flex; flex-direction:column; }
      .agv-review-author { font-weight:600; font-size:0.88rem; color:#e2e8f0; }
      .agv-review-sub { display:flex; gap:8px; align-items:center; font-size:0.78rem; color:#94a3b8; }
      .agv-review-date { color:#6b7280; }
      .agv-review-text { font-size:0.88rem; color:#cbd5e1; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
      .agv-review-empty { color:#6b7280; font-size:0.85rem; text-align:center; padding:18px; }

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
        <div class="agv-panel-scroll"><div id="agvContent"></div></div>
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

    // Convert any YouTube watch URL to its embed form so we can iframe it.
    function _ytEmbedify(u) {
      if (!u || typeof u !== 'string') return '';
      let e = u.replace('watch?v=', 'embed/').replace('youtu.be/', 'www.youtube.com/embed/');
      if (e.indexOf('youtube.com/embed/') !== -1 && e.indexOf('http') !== 0) e = 'https://' + e;
      // Strip extra YouTube query params except the video id portion.
      // (Keep what's after the first ? on /embed/<id> URLs.)
      return e;
    }
    const musicEmbed = _ytEmbedify(seq.youtubeUrl);
    const showEmbed  = _ytEmbedify(seq.youtubeShowUrl || seq.showVideoUrl);

    const durSecs = Number(seq.durationSecs || 0);
    const durStr = durSecs ? (Math.floor(durSecs / 60) + 'm ' + (durSecs % 60) + 's') : (seq.duration || '--');
    // We display "Props" (the user-stated total prop count) instead of the
    // legacy "Channels" stat. Falls back to channelCount for older docs.
    const propCount = (typeof seq.propCount === 'number' && seq.propCount > 0)
      ? seq.propCount
      : (Number(seq.channelCount) > 0 ? seq.channelCount : '--');
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
          : '<button class="agv-cta free" data-agv-download>+ Add to my library</button>'}
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
          <div class="agv-stat"><div class="agv-stat-val">${esc(String(propCount))}</div><div class="agv-stat-key">Props</div></div>
          <div class="agv-stat"><div class="agv-stat-val">${esc(String(downloads))}</div><div class="agv-stat-key">Downloads</div></div>
        </div>

        ${seq.description ? '<p class="agv-desc">' + esc(seq.description) + '</p>' : ''}
        ${propsHtml}
        ${(musicEmbed || showEmbed) ? (
          '<div class="agv-yt-pair">' +
            '<div class="agv-yt-tile">' +
              '<span class="agv-yt-tile-label">Music video</span>' +
              '<div class="agv-yt-tile-frame">' +
                (musicEmbed
                  ? '<iframe src="' + esc(musicEmbed) + '" allowfullscreen loading="lazy"></iframe>'
                  : '<div class="agv-yt-placeholder"><div><strong>No music video</strong>The creator didn\'t link the song.</div></div>'
                ) +
              '</div>' +
            '</div>' +
            '<div class="agv-yt-tile">' +
              '<span class="agv-yt-tile-label">Show video</span>' +
              '<div class="agv-yt-tile-frame">' +
                (showEmbed
                  ? '<iframe src="' + esc(showEmbed) + '" allowfullscreen loading="lazy"></iframe>'
                  : '<div class="agv-yt-placeholder"><div><strong>No show video yet</strong>The creator hasn\'t added a recording of this show running.</div></div>'
                ) +
              '</div>' +
            '</div>' +
          '</div>'
        ) : ''}
        ${actionsHtml}

        <!-- Reviews + Ratings -->
        <div class="agv-reviews" id="agvReviews" data-seq-id="${esc(String(seq.id || ''))}">
          <div class="agv-reviews-head">
            <div class="agv-reviews-title">Ratings &amp; Reviews</div>
            <div class="agv-reviews-summary" id="agvReviewsSummary">Loading…</div>
          </div>
          <div class="agv-review-form" id="agvReviewForm" style="display:none;">
            <div class="agv-rate-row">
              <span class="agv-rate-label">Your rating:</span>
              <div class="agv-rate-stars" id="agvRateStars" role="radiogroup" aria-label="Rating">
                ${[1,2,3,4,5].map(i => '<button type="button" class="agv-rate-star" data-val="' + i + '" aria-label="' + i + ' star' + (i===1?'':'s') + '">☆</button>').join('')}
              </div>
            </div>
            <textarea id="agvReviewText" maxlength="1000" rows="3" placeholder="Tell others what you thought about this show…"></textarea>
            <div class="agv-review-form-row">
              <span class="agv-review-count"><span id="agvReviewCharCount">0</span> / 1000</span>
              <span class="agv-review-form-actions">
                <button type="button" class="agv-review-cancel" id="agvReviewDelete" style="display:none;">Delete my review</button>
                <button type="button" class="agv-review-submit" id="agvReviewSubmit">Post review</button>
              </span>
            </div>
            <div class="agv-review-error" id="agvReviewError" style="display:none;"></div>
          </div>
          <div class="agv-review-signin" id="agvReviewSignin" style="display:none;">
            <a href="signin.html?redirect=platform.html">Sign in</a> to leave a review.
          </div>
          <div class="agv-review-list" id="agvReviewList"></div>
        </div>
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

    // Wire reviews UI (async — populates after fetch completes)
    _wireReviews(seq);

    const root = document.getElementById('agvRoot');
    root.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  /* ─── Reviews + Ratings ──────────────────────────────────────── */
  function _renderStars(n) {
    const full = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '<span class="agv-stars">'
      + '★'.repeat(full) + '☆'.repeat(5 - full)
      + '</span>';
  }
  function _fmtReviewDate(ts) {
    try {
      const d = ts && ts.toDate ? ts.toDate() : (ts && ts.seconds ? new Date(ts.seconds * 1000) : null);
      if (!d) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  async function _wireReviews(seq) {
    if (!seq || !seq.id) return;
    if (!global.firebase || !global.firebase.firestore) return;
    const fs = global.firebase.firestore();
    const auth = global.firebase.auth ? global.firebase.auth() : null;
    let me = auth ? auth.currentUser : null;
    // If auth hasn't resolved yet (cached session restoring), wait one tick.
    if (!me && auth) {
      me = await new Promise((resolve) => {
        let resolved = false;
        const off = auth.onAuthStateChanged((u) => {
          if (resolved) return;
          resolved = true;
          off();
          resolve(u || null);
        });
        // Bail after 1.5s so we don't block the viewer forever.
        setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 1500);
      });
    }
    const isCreator = me && (seq.creatorUid === me.uid);

    const summaryEl = document.getElementById('agvReviewsSummary');
    const formEl    = document.getElementById('agvReviewForm');
    const signinEl  = document.getElementById('agvReviewSignin');
    const listEl    = document.getElementById('agvReviewList');
    const errorEl   = document.getElementById('agvReviewError');
    if (!summaryEl || !listEl) return;

    // Show form / sign-in prompt depending on auth + creator state.
    if (me && !isCreator) {
      formEl.style.display = '';
    } else if (!me) {
      signinEl.style.display = '';
    } else {
      // Creator — hide form, no review allowed.
      summaryEl.parentElement.querySelector('.agv-reviews-title').textContent = 'Ratings & Reviews';
    }

    // Load reviews.
    let reviews = [];
    try {
      const snap = await fs.collection('sequences').doc(seq.id).collection('reviews').get();
      snap.forEach(d => reviews.push(Object.assign({ _id: d.id }, d.data())));
    } catch (err) {
      console.warn('reviews fetch failed', err);
    }
    reviews.sort((a, b) => {
      const at = (a.updatedAt && a.updatedAt.seconds) || 0;
      const bt = (b.updatedAt && b.updatedAt.seconds) || 0;
      return bt - at;
    });

    // Aggregate display.
    if (!reviews.length) {
      summaryEl.innerHTML = '<span class="agv-rate-empty">No reviews yet.</span>';
    } else {
      const total = reviews.reduce((s, r) => s + Number(r.rating || 0), 0);
      const avg = total / reviews.length;
      summaryEl.innerHTML = _renderStars(avg)
        + ' <span class="agv-rate-num">' + avg.toFixed(1) + '</span>'
        + ' <span class="agv-rate-count">(' + reviews.length + ' review' + (reviews.length === 1 ? '' : 's') + ')</span>';
    }

    // Pre-populate the form if user already has a review.
    let myReview = null;
    if (me) {
      myReview = reviews.find(r => r.uid === me.uid) || null;
      if (myReview) {
        const ta = document.getElementById('agvReviewText');
        const cc = document.getElementById('agvReviewCharCount');
        const submitBtn = document.getElementById('agvReviewSubmit');
        const deleteBtn = document.getElementById('agvReviewDelete');
        if (ta) { ta.value = myReview.comment || ''; if (cc) cc.textContent = ta.value.length; }
        _setSelectedRating(Number(myReview.rating || 0));
        if (submitBtn) submitBtn.textContent = 'Update review';
        if (deleteBtn) deleteBtn.style.display = '';
      }
    }

    // Render review list (hide own review if it's already shown in the form? Show all.)
    listEl.innerHTML = reviews.length === 0
      ? '<div class="agv-review-empty">Be the first to review this show.</div>'
      : reviews.map(r => {
          const photo = r.authorPhotoURL ? esc(r.authorPhotoURL) : '';
          const av = photo
            ? '<img class="avatar agv-review-av" src="' + photo + '" width="32" height="32" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'avatar avatar-initials agv-review-av\',textContent:\'' + esc((r.authorName || 'U').charAt(0).toUpperCase()) + '\',style:\'width:32px;height:32px;font-size:14px;\'}));" />'
            : '<span class="avatar avatar-initials agv-review-av" style="width:32px;height:32px;font-size:14px;">' + esc((r.authorName || 'U').charAt(0).toUpperCase()) + '</span>';
          return ''
            + '<div class="agv-review">'
            +   '<div class="agv-review-head">'
            +     av
            +     '<div class="agv-review-meta">'
            +       '<div class="agv-review-author">' + esc(r.authorName || 'User') + '</div>'
            +       '<div class="agv-review-sub">' + _renderStars(r.rating) + ' <span class="agv-review-date">' + _fmtReviewDate(r.updatedAt || r.createdAt) + '</span></div>'
            +     '</div>'
            +   '</div>'
            +   (r.comment ? '<div class="agv-review-text">' + esc(r.comment) + '</div>' : '')
            + '</div>';
        }).join('');

    // Wire the star picker.
    const starBtns = document.querySelectorAll('.agv-rate-star');
    starBtns.forEach(btn => btn.addEventListener('click', () => {
      const v = parseInt(btn.getAttribute('data-val'), 10);
      _setSelectedRating(v);
    }));

    // Wire the textarea char counter.
    const textEl = document.getElementById('agvReviewText');
    const ccEl   = document.getElementById('agvReviewCharCount');
    if (textEl && ccEl) {
      textEl.addEventListener('input', () => { ccEl.textContent = textEl.value.length; });
    }

    // Wire submit.
    const submitBtn = document.getElementById('agvReviewSubmit');
    if (submitBtn) submitBtn.addEventListener('click', async () => {
      const rating = _getSelectedRating();
      const comment = (textEl && textEl.value || '').trim();
      if (!rating) {
        _showReviewError('Pick a rating from 1 to 5 stars.');
        return;
      }
      submitBtn.disabled = true;
      const oldText = submitBtn.textContent;
      submitBtn.textContent = 'Posting…';
      try {
        const fn = global.firebase.functions().httpsCallable('submitReview');
        await fn({ sequenceId: seq.id, rating, comment });
        _hideReviewError();
        // Reload the reviews block in place.
        _wireReviews(seq);
      } catch (err) {
        const msg = (err && err.message) || 'Could not post review.';
        _showReviewError(msg);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
      }
    });

    // Wire delete.
    const deleteBtn = document.getElementById('agvReviewDelete');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete your review?')) return;
      try {
        const fn = global.firebase.functions().httpsCallable('deleteOwnReview');
        await fn({ sequenceId: seq.id });
        _wireReviews(seq);
      } catch (err) {
        _showReviewError((err && err.message) || 'Could not delete review.');
      }
    });
  }

  function _setSelectedRating(n) {
    const stars = document.querySelectorAll('.agv-rate-star');
    stars.forEach((s, idx) => {
      const v = idx + 1;
      s.textContent = v <= n ? '★' : '☆';
      s.classList.toggle('on', v <= n);
      s.setAttribute('data-selected', v <= n ? '1' : '0');
    });
    const wrap = document.getElementById('agvRateStars');
    if (wrap) wrap.setAttribute('data-current', String(n));
  }
  function _getSelectedRating() {
    const wrap = document.getElementById('agvRateStars');
    if (!wrap) return 0;
    return parseInt(wrap.getAttribute('data-current') || '0', 10);
  }
  function _showReviewError(msg) {
    const e = document.getElementById('agvReviewError');
    if (!e) return;
    e.textContent = msg;
    e.style.display = '';
  }
  function _hideReviewError() {
    const e = document.getElementById('agvReviewError');
    if (e) e.style.display = 'none';
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
