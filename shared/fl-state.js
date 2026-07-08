/* ════════════════════════════════════════════════════════════════
   fl-state.js — localStorage → server bridge for tile working-state (Real-Data Foundation
   Part B). Tiles that kept REAL business state in localStorage only (buy box, analyzer
   assumptions, business-plan text, jurisdiction, roster drafts, threshold knobs) load and
   save through this seam instead: the server (/api/tile-state via flTileState) is the record,
   localStorage stays as an offline/unauthenticated cache — a cache clear never loses data
   for a signed-in user, and a legacy browser value is migrated UP exactly once.

   Usage (requires fl-auth.js + fl-api.js loaded first):
     FLState.load('buybox', 'fl_buybox_v1').then(function(r){
       // r.value  — the state (or null if none anywhere)
       // r.source — 'server' | 'migrated' (legacy LS pushed up) | 'local' (offline/signed-out)
       //            | 'none'
     });
     FLState.save('buybox', 'fl_buybox_v1', value);   // LS immediately + debounced server PUT
     FLState.flush();                                  // force all pending PUTs (e.g. pagehide)

   Semantics: load() prefers the server copy and mirrors it into LS; a 404 with a legacy LS
   value present pushes that value up (one-time migration) and returns it; signed-out or
   API-down returns the LS copy labeled 'local' so tiles can render an honest badge.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.FLState) return;

  var PUT_DEBOUNCE_MS = 800;
  var timers = {};   // key -> timeout id
  var queued = {};   // key -> latest value awaiting PUT

  function lsGet(lsKey) {
    try { return JSON.parse(localStorage.getItem(lsKey)); } catch (e) { return null; }
  }
  function lsSet(lsKey, value) {
    try { localStorage.setItem(lsKey, JSON.stringify(value)); } catch (e) {}
  }
  function authed() { return !!(window.flApi && flApi.authed && flApi.authed()); }
  function api() { return (window.flTileState && flTileState.get) ? flTileState : null; }

  async function load(key, lsKey) {
    var local = lsKey ? lsGet(lsKey) : null;
    if (!authed() || !api()) {
      return { value: local, source: local != null ? 'local' : 'none' };
    }
    var r = await flTileState.get(key);
    if (r && r.ok) {
      if (lsKey) lsSet(lsKey, r.data.state);            // mirror server -> LS for offline reads
      return { value: r.data.state, source: 'server' };
    }
    if (r && r.status === 404) {
      // The server has NO row for this signed-in principal -> the HONEST answer is empty (0), even
      // if this browser still holds stale localStorage from a prior tenant/session. We deliberately
      // do NOT resurrect that LS into the server: auto-migrating it up would repopulate a cleared /
      // brand-new tenant with another context's data and show fake non-zero counts (Real-Data
      // Foundation requires an empty tenant to read 0 honestly). The stale LS is left as an inert
      // offline breadcrumb; only an explicit user save() ever writes this tenant's server state.
      return { value: null, source: 'none' };
    }
    // API down / session died mid-flight: serve the offline cache, honestly labeled 'local'.
    return { value: local, source: local != null ? 'local' : 'none' };
  }

  function save(key, lsKey, value) {
    if (lsKey) lsSet(lsKey, value);                     // cache immediately, never lose input
    if (!authed() || !api()) return;
    queued[key] = value;
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(function () {
      delete timers[key];
      var v = queued[key];
      delete queued[key];
      flTileState.put(key, v);                          // fire-and-forget; LS still has it
    }, PUT_DEBOUNCE_MS);
  }

  function flush() {
    Object.keys(queued).forEach(function (key) {
      if (timers[key]) { clearTimeout(timers[key]); delete timers[key]; }
      var v = queued[key];
      delete queued[key];
      // keepalive so a pagehide/unload PUT survives document teardown (a plain fetch is cancelled,
      // silently losing the last debounced edit); falls back to a normal PUT if unavailable.
      if (authed() && api()) {
        if (flTileState.putKeepalive) flTileState.putKeepalive(key, v);
        else flTileState.put(key, v);
      }
    });
  }
  window.addEventListener('pagehide', flush);

  window.FLState = { load: load, save: save, flush: flush };
})();
