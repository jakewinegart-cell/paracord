/* theme1: light / dark mode. The inline script in <head> already set <html data-theme> before first paint (no flash);
   this wires the header switch, remembers the choice under 'p13:theme', and follows the device setting until the user picks. */
(function () {
  var KEY = 'p13:theme', META = { light: '#ffffff', dark: '#121316' }, root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; } }
  function current() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', META[t]);
    var b = document.getElementById('themeBtn');
    if (b) { b.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false'); b.setAttribute('aria-label', t === 'dark' ? 'Dark mode on. Switch to light mode' : 'Light mode on. Switch to dark mode'); b.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
    try { window.dispatchEvent(new CustomEvent('p13:theme', { detail: t })); } catch (e) {}
  }
  function set(t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); }
  apply(stored() || current());
  var btn = document.getElementById('themeBtn');
  if (btn) btn.addEventListener('click', function () { set(current() === 'dark' ? 'light' : 'dark'); });
  if (mq) { var on = function (e) { if (!stored()) apply(e.matches ? 'dark' : 'light'); }; mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener && mq.addListener(on); }
  window.PCTheme = { get: current, set: set, KEY: KEY, META: META };
})();
