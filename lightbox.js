// Landing-page enhancements: a screenshot lightbox, plus accordion deep-links.
//
// Everything here is progressive enhancement. Each screenshot is authored as a
// plain <a href="screenshots/x.png"><img></a>, so with JS off (or if <dialog>
// is unsupported) clicking a shot still opens the full-size PNG — the "at a
// minimum, clickable to full size" requirement never depends on this file.
(function () {
  'use strict';

  var links = Array.prototype.slice.call(
    document.querySelectorAll('a[data-lightbox]')
  );

  /* ── Accordion deep-links ────────────────────────────────
     The feature sections are <details> elements. A #hash pointing at one (from
     the table of contents, or a shared URL) must open it — browsers only
     auto-expand for in-page find, not for fragment navigation. */
  function openFromHash() {
    if (!location.hash) return;
    var id = location.hash.slice(1);
    // Escape the id before it reaches a selector: getElementById has no such
    // problem and also cannot be tricked by a crafted hash.
    var el = document.getElementById(id);
    if (!el) return;
    var details = el.closest ? el.closest('details') : null;
    if (details) details.open = true;
    // Re-run the scroll now that the target actually has height.
    el.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  /* ── Expand / collapse all ─────────────────────────────── */
  var toggle = document.querySelector('[data-toggle-all]');
  var features = Array.prototype.slice.call(document.querySelectorAll('.feature'));
  if (toggle && features.length) {
    toggle.hidden = false;
    var syncLabel = function () {
      var allOpen = features.every(function (f) { return f.open; });
      toggle.textContent = allOpen ? 'Collapse all' : 'Expand all';
      toggle.setAttribute('aria-expanded', String(allOpen));
    };
    toggle.addEventListener('click', function () {
      var allOpen = features.every(function (f) { return f.open; });
      features.forEach(function (f) { f.open = !allOpen; });
      syncLabel();
    });
    features.forEach(function (f) { f.addEventListener('toggle', syncLabel); });
    syncLabel();
  }

  /* ── Lightbox ──────────────────────────────────────────── */
  var dialog = document.getElementById('lightbox');
  // Bail out to native navigation when <dialog> is unavailable.
  if (!dialog || typeof dialog.showModal !== 'function' || !links.length) return;

  var imgEl = dialog.querySelector('.lightbox-img');
  var capEl = dialog.querySelector('.lightbox-caption-text');
  var countEl = dialog.querySelector('.lightbox-count');
  var prevBtn = dialog.querySelector('.lightbox-prev');
  var nextBtn = dialog.querySelector('.lightbox-next');
  var closeBtn = dialog.querySelector('.lightbox-close');

  var index = 0;
  var lastFocus = null;

  function captionFor(link) {
    var img = link.querySelector('img');
    return link.getAttribute('data-caption') || (img && img.getAttribute('alt')) || '';
  }

  // Warm the neighbours so prev/next feels instant — these are 2x captures and
  // decoding one cold is visible.
  function preloadNeighbours() {
    [index - 1, index + 1].forEach(function (i) {
      if (i < 0 || i >= links.length) return;
      var pre = new Image();
      pre.src = links[i].getAttribute('href');
    });
  }

  function show(i) {
    index = (i + links.length) % links.length;
    var link = links[index];
    imgEl.setAttribute('src', link.getAttribute('href'));
    imgEl.setAttribute('alt', captionFor(link));
    capEl.textContent = captionFor(link);
    countEl.textContent = (index + 1) + ' / ' + links.length;
    preloadNeighbours();
  }

  function open(i, trigger) {
    lastFocus = trigger || document.activeElement;
    show(i);
    dialog.showModal();
  }

  links.forEach(function (link, i) {
    link.addEventListener('click', function (e) {
      // Preserve the browser's own affordances: modified clicks and
      // middle-clicks should still open the PNG in a new tab.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      open(i, link);
    });
  });

  prevBtn.addEventListener('click', function () { show(index - 1); });
  nextBtn.addEventListener('click', function () { show(index + 1); });
  closeBtn.addEventListener('click', function () { dialog.close(); });

  // Click anywhere that is not the image or a control closes — the usual
  // lightbox convention.
  dialog.addEventListener('click', function (e) {
    if (!e.target.closest('.lightbox-img, .lightbox-btn')) dialog.close();
  });

  dialog.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    // Escape is handled natively by <dialog>.
  });

  // Return focus to the thumbnail that opened the lightbox, so keyboard users
  // resume where they left off rather than at the top of the document.
  dialog.addEventListener('close', function () {
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  });
})();
