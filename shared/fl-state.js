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
     FLState.local('fl_buybox_v1');                    // sync read of THIS person's browser copy
     FLState.setLocal('fl_buybox_v1', value);          // sync browser-only write (no server PUT)
     FLState.removeLocal('fl_buybox_v1');              // sync browser-only remove
     FLState.storageKey('fl_buybox_v1');               // the real localStorage name (raw-string keys)
     FLState.suffix();                                 // '::<account>' — for prefix scanners
     FLState.account();                                // the signed-in account id, or null

   Semantics: load() prefers the server copy and mirrors it into LS; a 404 with a legacy LS
   value present pushes that value up (one-time migration) and returns it; signed-out or
   API-down returns the LS copy labeled 'local' so tiles can render an honest badge.

   The browser copy belongs to a PERSON, not to the browser (TD-264). Every lsKey this file
   touches lives under '<lsKey>::<account>' — <account> is the signed-in user's id (the JWT
   'sub'; the lower-cased email when the token does not decode) — or under '<lsKey>::anon'
   while nobody is signed in. fl_state_owner_v1 remembers whose copies this browser holds;
   when the signed-in account changes, or the person signs out, that account's copies are
   removed (and, on a change, its pending PUTs dropped), so the next person on a shared
   browser never sees — and never saves into their own account — what the last person typed.
   The server's answer for THIS person decides what is shown once it arrives. A tile that
   reads its lsKey directly for the first paint must read it through local() / storageKey();
   a plain localStorage.getItem(lsKey) finds nothing.

   The pre-TD-264 plain name is never read: a plain copy is deleted on sight, unread. It cannot
   be attributed to anyone (the old sign-out left it behind), so claiming it for whoever signs
   in next would replay the defect once per key; the server is the record for a signed-in
   person (every save was PUT), and a signed-out copy from the old build belongs to nobody.

   Clearing: a deliberate sign-out leaves no fl_auth_ended note, and that person's copies go
   with them. A session that merely ended (failed refresh, token lost) leaves the note, and
   the copies stay for the same person's return — keys with no server home (a dispatch
   setting, a "last good" stamp, a scope selection) would otherwise be lost to an expiry.
   A different account signing in clears the previous one's copies either way.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.FLState) return;

  var PUT_DEBOUNCE_MS = 800;
  var OWNER_KEY = 'fl_state_owner_v1';         // the account whose copies this browser holds
  var ANON = 'anon';                           // the bucket while nobody is signed in
  var timers = {};     // key -> timeout id
  var queued = {};     // key -> latest value awaiting PUT
  var queuedAs = {};   // key -> the account the queued value was typed as

  function rawGet(name) { try { return localStorage.getItem(name); } catch (e) { return null; } }
  function rawSet(name, s) { try { localStorage.setItem(name, s); } catch (e) {} }
  function rawRemove(name) { try { localStorage.removeItem(name); } catch (e) {} }
  function parse(s) { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } }

  function authed() { return !!(window.flApi && flApi.authed && flApi.authed()); }
  function api() { return (window.flTileState && flTileState.get) ? flTileState : null; }

  // ── who is signed in ──
  // The JWT's 'sub' is the user id: stable across an email change and carries no address into
  // key names. Decoded once per distinct token string.
  function jwtSub(tok) {
    try {
      var p = String(tok).split('.');
      if (p.length < 2) return null;
      var b = p[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var claims = JSON.parse(atob(b));
      return (claims && typeof claims.sub === 'string' && claims.sub) ? claims.sub : null;
    } catch (e) { return null; }
  }
  var _acctTok = null, _acctSub = null;
  function account() {
    var tok = null;
    try { tok = (window.flAuth && flAuth.token && flAuth.token()) || (window.flApi && flApi.token && flApi.token()) || null; } catch (e) {}
    if (tok) {
      if (tok !== _acctTok) { _acctTok = tok; _acctSub = jwtSub(tok); }
      if (_acctSub) return _acctSub;
    }
    var em = null;
    try { em = window.flAuth && flAuth.email && flAuth.email(); } catch (e) {}
    em = (typeof em === 'string') ? em.trim().toLowerCase() : '';
    return em || null;
  }
  function suffix() { return '::' + (account() || ANON); }

  // ── one account's copies per browser ──
  function clearAccount(acct) {
    var sfx = '::' + acct, names = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.length > sfx.length && k.slice(-sfx.length) === sfx) names.push(k);
      }
    } catch (e) {}
    names.forEach(rawRemove);
  }
  function dropQueued() {
    Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
    timers = {}; queued = {}; queuedAs = {};
  }
  // fl-auth.js writes fl_auth_ended when a session ENDED on its own (failed refresh); a deliberate
  // signOut() removes it. So, with nobody signed in: note present = expiry, note absent = sign-out.
  function sessionEnded() { return rawGet('fl_auth_ended') != null; }
  // Runs at load, on every auth change this window can hear, and at the top of every call — so
  // the clean-up happens even when no copy of this file was alive at the moment of sign-out.
  function reconcile() {
    var cur = account();
    var owner = rawGet(OWNER_KEY);
    if (owner === cur) return;
    if (!cur) {
      if (sessionEnded()) return;                       // expiry: the copies wait for the same person
      if (owner) clearAccount(owner);                   // deliberate sign-out: the copies leave with them
      rawRemove(OWNER_KEY);
      return;
    }
    if (owner) { clearAccount(owner); dropQueued(); }   // a different person: a real account change
    rawSet(OWNER_KEY, cur);
  }

  // ── the pre-TD-264 plain name: deleted on sight, never read, never given to an account ──
  function dropPlain(lsKey) { if (rawGet(lsKey) != null) rawRemove(lsKey); }
  function storageKey(lsKey) {
    reconcile();
    dropPlain(lsKey);
    return lsKey + '::' + (account() || ANON);
  }

  function lsGet(lsKey) { return parse(rawGet(storageKey(lsKey))); }
  function lsSet(lsKey, value) { rawSet(storageKey(lsKey), JSON.stringify(value)); }
  function lsRemove(lsKey) { rawRemove(storageKey(lsKey)); }

  async function load(key, lsKey) {
    var local = lsKey ? lsGet(lsKey) : null;
    if (!authed() || !api()) {
      return { value: local, source: local != null ? 'local' : 'none' };
    }
    var as = account();
    var r = await flTileState.get(key);
    // The answer is about the person the request was SENT for. If someone else is signed in by
    // now, it must not be mirrored into their bucket or painted as theirs.
    if (account() !== as) return { value: null, source: 'none' };
    if (r && r.ok) {
      if (lsKey) lsSet(lsKey, r.data.state);            // mirror server -> LS for offline reads
      return { value: r.data.state, source: 'server' };
    }
    if (r && r.status === 404) {
      // The server has NO row for this signed-in principal -> the HONEST answer is empty (0), even
      // if this browser still holds a copy from an earlier visit. We deliberately do NOT resurrect
      // that copy into the server: auto-migrating it up would repopulate a cleared / brand-new
      // tenant with older data and show fake non-zero counts (Real-Data Foundation requires an
      // empty tenant to read 0 honestly). The browser copy — this person's own, never another
      // account's (TD-264) — stays an inert offline breadcrumb; only an explicit user save() ever
      // writes this tenant's server state.
      return { value: null, source: 'none' };
    }
    // API down / session died mid-flight: serve the offline cache, honestly labeled 'local'.
    return { value: local, source: local != null ? 'local' : 'none' };
  }

  function save(key, lsKey, value) {
    reconcile();
    if (lsKey) lsSet(lsKey, value);                     // cache immediately, never lose input
    if (!authed() || !api()) return;
    queued[key] = value;
    queuedAs[key] = account();
    if (timers[key]) clearTimeout(timers[key]);
    timers[key] = setTimeout(function () {
      delete timers[key];
      var v = queued[key], who = queuedAs[key];
      delete queued[key]; delete queuedAs[key];
      if (who !== account()) return;                    // typed as one person, never sent as another
      flTileState.put(key, v);                          // fire-and-forget; LS still has it
    }, PUT_DEBOUNCE_MS);
  }

  function flush() {
    Object.keys(queued).forEach(function (key) {
      if (timers[key]) { clearTimeout(timers[key]); delete timers[key]; }
      var v = queued[key], who = queuedAs[key];
      delete queued[key]; delete queuedAs[key];
      if (who !== account()) return;                    // typed as one person, never sent as another
      // keepalive so a pagehide/unload PUT survives document teardown (a plain fetch is cancelled,
      // silently losing the last debounced edit); falls back to a normal PUT if unavailable.
      if (authed() && api()) {
        if (flTileState.putKeepalive) flTileState.putKeepalive(key, v);
        else flTileState.put(key, v);
      }
    });
  }
  window.addEventListener('pagehide', flush);

  // Another window signed out, signed in, or had its session end: a 'storage' event never reaches
  // the window that wrote, so the writer's own window hears fl:auth-ended (fl-auth.js) instead.
  window.addEventListener('storage', function (e) {
    var k = e ? e.key : null;
    if (k == null || k === 'fl_auth_token' || k === 'fl_auth_email' || k === 'fl_auth_ended' || k === OWNER_KEY) reconcile();
  });
  window.addEventListener('fl:auth-ended', function () { reconcile(); });
  reconcile();

  window.FLState = {
    load: load, save: save, flush: flush,
    local: lsGet, setLocal: lsSet, removeLocal: lsRemove,
    storageKey: storageKey, suffix: suffix, account: account,
  };
})();
