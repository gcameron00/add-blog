/**
 * Applies the stored theme before first paint.
 *
 * Loaded as a plain blocking script (no type="module", no defer) so it runs
 * before the stylesheets paint. main.js's own initTheme() only runs on
 * DOMContentLoaded, which is too late on a multi-page app: every full-page
 * navigation would render the default light palette for a beat before JS
 * caught up, flashing white on every jump between admin pages. Same
 * addblog.theme key main.js uses, kept in sync manually since this has to
 * load before main.js and can't import from it.
 */
(function () {
  try {
    var theme = localStorage.getItem('addblog.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) { /* ignore */ }
})();
