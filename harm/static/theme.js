/* Applies the saved theme before the page draws (no flash). The choice is per device.
   data-theme = light | dark (read by the ZomBeatz tokens); data-product = harm, or harm-<theme> (coolant, graveyard). */
(function () {
  var theme = 'zombeatz', mode = 'auto';  // follows the system until the person picks Light or Dark
  try {
    theme = localStorage.getItem('harm-theme') || theme;
    mode = localStorage.getItem('harm-mode') || mode;
  } catch (e) { /* storage blocked: use defaults */ }
  var r = document.documentElement;
  r.dataset.product = theme === 'coolant' || theme === 'graveyard' ? 'harm-' + theme : 'harm';
  r.dataset.theme = mode === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (mode === 'light' ? 'light' : 'dark');
  r.dataset.modePref = mode;
  // Text size, density and motion from Settings > Appearance (also per device).
  try {
    var look = JSON.parse(localStorage.getItem('harm-look') || '{}');
    if (look.text) r.dataset.text = look.text;
    if (look.density) r.dataset.density = look.density;
    if (look.motion) r.dataset.motion = look.motion;
    if (look.contrast) r.dataset.contrast = look.contrast;
  } catch (e) { /* defaults */ }
})();
