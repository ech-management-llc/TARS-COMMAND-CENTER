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
  // authExpired() = the session was alive but a refresh confirmed it's dead. Consumers use it to show
  // "your session expired" instead of a misleading empty state when a call returns null.
  function authExpired() { return !!(window.flAuth && flAuth.expired && flAuth.expired()); }

  // The single authed-fetch path for every FL call (FL API + the agent service). Returns parsed JSON,
  // {} for 204, or null ("use your fallback"). Token-expiry aware: refreshes proactively when the
  // stored token is near expiry, and reactively retries ONCE on a 401. A confirmed-dead session is
  // cleared by flAuth.refresh(), so after a null the caller can branch on flApi.authed()/authExpired()
  // — distinguishing an expired session from a genuinely-empty result.
  async function authedCall(base, method, path, body) {
    var t = token();
    if (!t) return null;                                   // not signed in -> caller fallback
    if (window.flAuth && flAuth.needsRefresh && flAuth.needsRefresh()) {
      await flAuth.refresh();                              // proactive (may clear the session)
      t = token();
      if (!t) return null;
    }
    function doFetch(tok) {
      return fetch(base + path, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    try {
      var res = await doFetch(t);
      if (res.status === 401 && window.flAuth && flAuth.refresh) {
        var ok = await flAuth.refresh();                   // ONE reactive refresh
        if (ok) res = await doFetch(token());
      }
      if (!res.ok) return null;                            // incl. a still-401 (session now cleared)
      if (res.status === 204) return {};
      return await res.json();
    } catch (e) {
      return null;                                         // network/CORS error -> fallback
    }
  }

  function call(method, path, body) { return authedCall(BASE, method, path, body); }

  window.flApi = { base: BASE, token: token, authed: authed, authExpired: authExpired, call: call };

  // AI Agent Layer (Lane 4a) — the hosted TARS advisor (READ-ONLY). Calls the separate
  // fl-agent service with the same Supabase JWT (fl_auth_token). Returns the parsed
  // {answer, tools_called, usage, cost_usd, ...} on success, or null on no-session / any
  // error so the caller falls back to its honest stub — no lockout, no fabricated answer.
  var AGENT_BASE = window.FL_AGENT_BASE || 'https://fl-agent.fly.dev';
  window.flAgent = {
    base: AGENT_BASE,
    authed: authed,
    // Token-expiry aware (shares authedCall): refreshes proactively + retries once on 401, and a
    // confirmed-dead session flips flApi.authed()/authExpired() so the caller can prompt re-sign-in.
    chat: function (message, context) {
      return authedCall(AGENT_BASE, 'POST', '/agent/chat', { message: message, context: context || null });
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

  // Portfolio facts (P1b) — per-entity LTV + per-door inputs (door_count / asset_value /
  // loan_balance / as_of_date / source). Server-only: these feed the LIVE capital rules, so
  // there is NO localStorage fallback — every method needs the signed-in JWT (else call() -> null).
  window.flPortfolioFacts = {
    list: function () { return call('GET', '/api/portfolio-facts'); },
    get: function (code) { return call('GET', '/api/portfolio-facts/' + encodeURIComponent(code)); },
    upsert: function (facts) { return call('POST', '/api/portfolio-facts', facts); },
    update: function (code, patch) { return call('PATCH', '/api/portfolio-facts/' + encodeURIComponent(code), patch); },
    // Remove one entity's facts (TD-111) — LTV/per-door revert to UNKNOWN for that entity.
    del: function (code) { return call('DELETE', '/api/portfolio-facts/' + encodeURIComponent(code)); },
  };

  // Properties (Lane-2 ops keystone). Per-property records behind Property File + the manual base
  // for Rent Roll. Promoted columns + JSONB details; creator-owned, optional entity_code, RLS-scoped.
  // No localStorage fallback — server is the source of truth (signed-in JWT required, else null).
  window.flProperties = {
    list: function () { return call('GET', '/api/properties'); },
    get: function (id) { return call('GET', '/api/properties/' + encodeURIComponent(id)); },
    create: function (p) { return call('POST', '/api/properties', p); },
    update: function (id, patch) { return call('PATCH', '/api/properties/' + encodeURIComponent(id), patch); },
    del: function (id) { return call('DELETE', '/api/properties/' + encodeURIComponent(id)); },
  };

  // Work orders (Lane-2 ops). Maintenance jobs behind the Maintenance tile. Promoted columns +
  // JSONB details; linked to a property + optional entity, creator-owned, RLS-scoped. Server is the
  // source of truth (signed-in JWT required, else null).
  window.flWorkOrders = {
    list: function () { return call('GET', '/api/work-orders'); },
    get: function (id) { return call('GET', '/api/work-orders/' + encodeURIComponent(id)); },
    create: function (w) { return call('POST', '/api/work-orders', w); },
    update: function (id, patch) { return call('PATCH', '/api/work-orders/' + encodeURIComponent(id), patch); },
    del: function (id) { return call('DELETE', '/api/work-orders/' + encodeURIComponent(id)); },
  };

  // Entities (Phase 3 setup). The setup flow creates the LLC rows here, as the SIGNED-IN USER —
  // TARS guides/asks, the app writes (this is NOT the autonomous agent). create() -> the new row,
  // or null on no-session / error (caller surfaces an honest "sign in to persist").
  window.flEntities = {
    list: function () { return call('GET', '/api/entities'); },
    create: function (entity) { return call('POST', '/api/entities', entity); },
    update: function (id, patch) { return call('PATCH', '/api/entities/' + encodeURIComponent(id), patch); },
    // Soft-delete one entity (admin-gated server-side; sets active=false + writes an audit row).
    // Resolves to the {status:'soft-deleted',...} body on success, or null on no-session / 4xx
    // (403 not-admin · 409 has active children unless ?cascade=true) so the caller keeps the row.
    del: function (id) { return call('DELETE', '/api/entities/' + encodeURIComponent(id)); },
  };

  // Source-of-truth admin records (Phase 3 / spine §2b): personal_info | bank_account | loan |
  // vendor. One resource, many kinds — structured fields + linked documents + retention, RLS-scoped.
  // No localStorage fallback (these ARE the source of truth): every method needs the signed-in JWT.
  window.flRecords = {
    list: function (kind) { return call('GET', '/api/admin-records?kind=' + encodeURIComponent(kind)); },
    get: function (id) { return call('GET', '/api/admin-records/' + encodeURIComponent(id)); },
    create: function (rec) { return call('POST', '/api/admin-records', rec); },
    update: function (id, patch) { return call('PATCH', '/api/admin-records/' + encodeURIComponent(id), patch); },
    // Hard-delete one record (creator or admin only — enforced server-side). Resolves to {} on
    // success (204), or null on no-session / 4xx / error so the caller keeps the row and explains.
    del: function (id) { return call('DELETE', '/api/admin-records/' + encodeURIComponent(id)); },
  };
})();
