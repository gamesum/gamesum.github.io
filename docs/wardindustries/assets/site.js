/* Ward Industries — sheet zones + exploded view */
(function () {
  // Drawing-sheet zone markers around the frame
  var sheet = document.querySelector('.sheet');
  if (sheet) {
    var mk = function (cls, items) {
      var d = document.createElement('div');
      d.className = 'zones ' + cls;
      d.setAttribute('aria-hidden', 'true');
      items.forEach(function (t) { var s = document.createElement('span'); s.textContent = t; d.appendChild(s); });
      sheet.appendChild(d);
    };
    var nums = ['1','2','3','4','5','6','7','8'], lets = ['A','B','C','D','E','F'];
    mk('z-top', nums); mk('z-bottom', nums); mk('z-left', lets); mk('z-right', lets);
  }

  // Exploded view: scroll separates the layers, then walks through each part
  var ex = document.querySelector('[data-explode]');
  if (!ex) return;
  var rig = ex.querySelector('.rig');
  var wrap = ex.querySelector('.rig-wrap');
  var vp = ex.querySelector('.viewport');
  var layers = Array.prototype.slice.call(ex.querySelectorAll('.layer'));
  var items = Array.prototype.slice.call(ex.querySelectorAll('.parts li'));
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var START = 0.36, SPAN = 0.62;
  var active = -2;

  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function setActive(i) {
    if (i === active) return;
    active = i;
    layers.forEach(function (l) { l.classList.toggle('is-active', +l.dataset.part === i); });
    items.forEach(function (li, k) { li.classList.toggle('is-active', k === i); });
    rig.classList.toggle('has-active', i >= 0);
  }
  function fit() {
    var s = Math.min(1, vp.clientWidth / 600, vp.clientHeight / 720);
    wrap.style.setProperty('--fit', Math.max(0.45, s).toFixed(3));
  }
  function progress() {
    var total = ex.offsetHeight - window.innerHeight;
    return Math.min(1, Math.max(0, -ex.getBoundingClientRect().top / total));
  }
  function update() {
    var p = progress();
    var e = reduce ? 1 : smooth(0.04, 0.32, p);
    rig.style.setProperty('--e', e.toFixed(4));
    var i = p > START ? Math.min(items.length - 1, Math.floor((p - START) / (SPAN / items.length))) : -1;
    setActive(i);
  }
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return; queued = true;
    requestAnimationFrame(function () { queued = false; update(); });
  }, { passive: true });
  window.addEventListener('resize', function () { fit(); update(); });
  items.forEach(function (li, k) {
    li.querySelector('button').addEventListener('click', function () {
      var total = ex.offsetHeight - window.innerHeight;
      var p = START + (k + 0.5) * (SPAN / items.length);
      var top = ex.getBoundingClientRect().top + window.scrollY + p * total;
      window.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
    });
  });
  fit(); update();
})();
