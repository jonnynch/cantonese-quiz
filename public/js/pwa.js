/* Service worker registration and the "new version available" flow.
   The page decides WHEN to apply an update (see applyUpdate in app.js); nothing here reloads the page on its own. */
(function (root, factory) {
  const m = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.CQPwa = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const api = {
    reg: null, waiting: null, applying: false, reloaded: false,
    reload() { root.location.reload(); },
    /* Registers ./sw.js relative to the page, so it also works when the app is deployed under a sub-path.
       onUpdate(worker) is called when a new version has been downloaded and is waiting. Returns the registration or null. */
    async register(opts) {
      const nav = root.navigator;
      if (!nav || !nav.serviceWorker) return null;                                  // unsupported / insecure context (e.g. file://): the app simply runs online-only
      const onUpdate = (opts && opts.onUpdate) || (() => { });
      let reg;
      try { reg = await nav.serviceWorker.register('sw.js', { scope: './' }); } catch (e) { return null; }
      api.reg = reg;
      const notify = w => { if (w && nav.serviceWorker.controller) { api.waiting = w; onUpdate(w); } };   // not on the very first install
      notify(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'installed') notify(reg.waiting || w); });
      });
      nav.serviceWorker.addEventListener('controllerchange', () => {
        if (api.applying && !api.reloaded) { api.reloaded = true; api.reload(); }   // only after the learner chose to update
      });
      if (root.document) root.document.addEventListener('visibilitychange', () => { if (root.document.visibilityState === 'visible') reg.update().catch(() => { }); });
      return reg;
    },
    hasUpdate() { return !!api.waiting; },
    /* Activates the waiting version; the page reloads once it has taken control. Call only at a safe moment. */
    applyUpdate() {
      if (!api.waiting) return false;
      api.applying = true; api.waiting.postMessage({ type: 'SKIP_WAITING' }); return true;
    },
  };
  return api;
});
