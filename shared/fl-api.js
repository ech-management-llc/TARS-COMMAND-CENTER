/* ════════════════════════════════════════════════════════════════
   fl-api.js — Foundation Layer API client seam (Lane 1).

   The single place the static TCC talks to the FL backend. Auth-aware with a
   localStorage fallback: if there's no Supabase session token yet (the TCC has no
   login wired today), every call returns null so the caller keeps using its
   localStorage path — behaviour is unchanged until login lands, at which point the
   same code persists to /api/deals with zero further edits.

   Contract: each method resolves to the parsed JSON on success, or null on
   "use your fallback" (no token / 4xx / 5xx / network error). Never throws.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.flApi) return;

  var BASE = window.FL_API_BASE || 'https://api.foundationlayerhq.com';

  // The Supabase session JWT, once a login writes one. Checks a simple slot first
  // (fl_auth_token), then any supabase-js session blob (sb-<ref>-auth-token).
  function token() {
    try {
      var t = localStorage.getItem('fl_auth_token');
      if (t) return t;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k)) {
          var v = JSON.parse(localStorage.getItem(k) || 'null');
          if (v && v.access_token) return v.access_token;
        }
      }
    } catch (e) {}
    return null;
  }

  function authed() { return !!token(); }

  async function call(method, path, body) {
    var t = token();
    if (!t) return null;                       // no session -> caller uses localStorage fallback
    try {
      var res = await fetch(BASE + path, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return null;                // 401/4xx/5xx -> fallback (never surface a half-state)
      if (res.status === 204) return {};
      return await res.json();
    } catch (e) {
      return null;                             // network/CORS error -> fallback
    }
  }

  window.flApi = { base: BASE, token: token, authed: authed, call: call };

  // AI Agent Layer (Lane 4a) — the hosted TARS advisor (READ-ONLY). Calls the separate
  // fl-agent service with the same Supabase JWT (fl_auth_token). Returns the parsed
  // {answer, tools_called, usage, cost_usd, ...} on success, or null on no-session / any
  // error so the caller falls back to its honest stub — no lockout, no fabricated answer.
  var AGENT_BASE = window.FL_AGENT_BASE || 'https://fl-agent.fly.dev';
  window.flAgent = {
    base: AGENT_BASE,
    authed: authed,
    chat: async function (message, context) {
      var t = token();
      if (!t) return null;                       // not signed in -> caller uses its stub
      try {
        var res = await fetch(AGENT_BASE + '/agent/chat', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message, context: context || null }),
        });
        if (!res.ok) return null;                // 401/4xx/5xx -> honest fallback
        return await res.json();
      } catch (e) {
        return null;                             // network/CORS -> fallback
      }
    },
  };

  // Deal-funnel persistence (Lane 1). buy_box mirrors fl_deal_pipeline_v1.buybox;
  // analysis mirrors fl_deal_analysis_v1; decision is the Decider's gate verdict.
  window.flDeals = {
    create: function (deal) { return call('POST', '/api/deals', deal); },
    get: function (id) { return call('GET', '/api/deals/' + encodeURIComponent(id)); },
    list: function (stage) {
      return call('GET', '/api/deals' + (stage ? ('?stage=' + encodeURIComponent(stage)) : ''));
    },
    update: function (id, patch) { return call('PATCH', '/api/deals/' + encodeURIComponent(id), patch); },
  };
})();
