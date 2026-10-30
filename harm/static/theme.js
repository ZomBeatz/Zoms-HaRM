/* Applies the saved theme before the page draws (no flash). The choice is per device.
   data-theme = light | dark (read by the ZomBeatz tokens); data-product = harm | harm-coolant. */
(function () {
  var theme = 'zombeatz', mode = 'auto';  // follows the system until the person picks Light or Dark
  try {
    theme = localStorage.getItem('harm-theme') || theme;
    mode = localStorage.getItem('harm-mode') || mode;
  } catch (e) { /* storage blocked: use defaults */ }
  var r = document.documentElement;
  r.dataset.product = theme === 'coolant' ? 'harm-coolant' : 'harm';
  r.dataset.theme = mode === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (mode === 'light' ? 'light' : 'dark');
  r.dataset.modePref = mode;
})();
