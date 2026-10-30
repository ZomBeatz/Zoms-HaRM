/* Applies the saved theme before the page draws (no flash). The choice is per device. */
(function () {
  var theme = 'zombeatz', mode = 'dark';
  try {
    theme = localStorage.getItem('harm-theme') || theme;
    mode = localStorage.getItem('harm-mode') || mode;
  } catch (e) { /* storage blocked: use defaults */ }
  var r = document.documentElement;
  r.dataset.theme = theme === 'coolant' ? 'coolant' : 'zombeatz';
  r.dataset.mode = mode === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (mode === 'light' ? 'light' : 'dark');
  r.dataset.modePref = mode;
})();
