/* Highlights the current section in a page's side contents list (nav.toc / nav.jump) while scrolling. */
(function () {
  var navs = document.querySelectorAll('nav.toc, nav.jump');
  if (!navs.length) return;
  var style = document.createElement('style');
  style.textContent =
    'nav.toc a.is-active,nav.jump a.is-active{background:var(--blue-50);color:var(--blue-800);font-weight:700;' +
    'box-shadow:inset 3px 0 0 var(--blue-800);border-radius:6px}';
  document.head.appendChild(style);
  var groups = [];
  navs.forEach(function (nav) {
    var items = [];
    nav.querySelectorAll('a[href^="#"]').forEach(function (a) {
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      var el = id && document.getElementById(id);
      if (el) items.push({ a: a, el: el });
    });
    if (items.length >= 2) groups.push(items);
  });
  if (!groups.length) return;
  var ticking = false;
  function update() {
    ticking = false;
    var line = Math.min(160, window.innerHeight * 0.3);
    var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    groups.forEach(function (items) {
      var visible = items.filter(function (i) { return i.el.offsetParent !== null || i.el.getClientRects().length; });
      var current = null;
      visible.forEach(function (i) { if (i.el.getBoundingClientRect().top - line <= 0) current = i; });
      if (atBottom && visible.length) current = visible[visible.length - 1];
      items.forEach(function (i) {
        var on = i === current;
        i.a.classList.toggle('is-active', on);
        if (on) i.a.setAttribute('aria-current', 'true'); else i.a.removeAttribute('aria-current');
      });
    });
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();
