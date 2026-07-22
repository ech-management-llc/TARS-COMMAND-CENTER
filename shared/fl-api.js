/* ════════════════════════════════════════════════════════════════
   fl-api.js — Foundation Layer API client seam (Lane 1).

   The single place the static TCC talks to the FL backend. Auth-aware with a
   localStorage fallback: if there's no Supabase session token yet (the TCC has no
   login wired today), every call returns null so the caller keeps using its
   localStorage path — behaviour is unchanged until login lands, at which point the
   same code persists to /api/deals with zero further edits.

   Contract: each method resolves to the parsed JSON on success, or null on
   "use your fallback" (no token / 4xx / 5xx / network error). Never throws.
   callX()/listX()/createX() are the status-carrying variants ({ok, status, data})
   for callers that must tell 403-forbidden apart from empty or down.
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

  // The single authed-fetch path for every FL call (FL API + the agent service), STATUS-CARRYING:
  // resolves to { ok, status, data } and never throws. status 0 = no session / transport error.
  // Token-expiry aware: refreshes proactively when the stored token is near expiry, and reactively
  // retries ONCE on a 401. A confirmed-dead session is cleared by flAuth.refresh(), so the caller
  // can branch on flApi.authed()/authExpired(). Callers that must tell "forbidden (e.g. a no-grant
  // new operator, 403)" apart from "API down" use this via callX (Ashley proving-run find #1 — a
  // 403 must NOT read as read-only/unreachable); everything else keeps the simpler call().
  async function authedCallX(base, method, path, body) {
    var t = token();
    if (!t) return { ok: false, status: 0, data: null };   // not signed in -> caller fallback
    if (window.flAuth && flAuth.needsRefresh && flAuth.needsRefresh()) {
      await flAuth.refresh();                              // proactive (may clear the session)
      t = token();
      if (!t) return { ok: false, status: 0, data: null };
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
      var data = null;
      if (res.status !== 204) { data = await res.json().catch(function () { return null; }); }
      else { data = {}; }
      if (!res.ok) return { ok: false, status: res.status, data: data };
      if (res.status !== 204 && data === null) {
        return { ok: false, status: 0, data: null };       // 2xx with unparseable body -> fallback
      }
      return { ok: true, status: res.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: null };         // network/CORS error -> fallback
    }
  }

  // Legacy contract (every existing consumer): parsed JSON on success, {} for 204, null on
  // "use your fallback" (no token / 4xx / 5xx / network error) — byte-identical behavior, now
  // implemented on the status-carrying path so there is still exactly ONE fetch/refresh seam.
  async function authedCall(base, method, path, body) {
    var r = await authedCallX(base, method, path, body);
    return r.ok ? r.data : null;
  }

  function call(method, path, body) { return authedCall(BASE, method, path, body); }
  function callX(method, path, body) { return authedCallX(BASE, method, path, body); }

  // Multipart sibling of authedCallX for file uploads: same token/refresh seam, but the body is
  // a FormData and NO Content-Type header is set (the browser writes the multipart boundary).
  async function authedUploadX(path, formData) {
    var t = token();
    if (!t) return { ok: false, status: 0, data: null };
    if (window.flAuth && flAuth.needsRefresh && flAuth.needsRefresh()) {
      await flAuth.refresh();
      t = token();
      if (!t) return { ok: false, status: 0, data: null };
    }
    function doFetch(tok) {
      return fetch(BASE + path, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + tok }, body: formData,
      });
    }
    try {
      var res = await doFetch(t);
      if (res.status === 401 && window.flAuth && flAuth.refresh) {
        var ok = await flAuth.refresh();
        if (ok) res = await doFetch(token());
      }
      var data = res.status === 204 ? {} : await res.json().catch(function () { return null; });
      if (!res.ok) return { ok: false, status: res.status, data: data };
      return { ok: true, status: res.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: null };
    }
  }

  window.flApi = { base: BASE, token: token, authed: authed, authExpired: authExpired,
                   call: call, callX: callX };

  // Documents — REAL server-side file storage (Real-Data Foundation Part C, TD-107 family).
  // Files live in the private fl-documents bucket behind the FL API; these are the only paths
  // to them. upload() takes a real File/Blob; downloadUrl() resolves a short-lived signed URL.
  // All status-carrying ({ok, status, data}) so callers can be honest per-status.
  window.flDocuments = {
    list: function (filters) {
      filters = filters || {};
      var q = [];
      if (filters.entity_code) q.push('entity_code=' + encodeURIComponent(filters.entity_code));
      if (filters.kind) q.push('kind=' + encodeURIComponent(filters.kind));
      // patch 030 — Construction Files category view + doc→record linkage surface.
      if (filters.category) q.push('category=' + encodeURIComponent(filters.category));
      if (filters.target) q.push('target=' + encodeURIComponent(filters.target));
      return callX('GET', '/api/documents' + (q.length ? ('?' + q.join('&')) : ''));
    },
    upload: function (file, meta) {
      meta = meta || {};
      var fd = new FormData();
      fd.append('file', file, file.name || 'document');
      if (meta.kind) fd.append('kind', meta.kind);
      if (meta.entity_code) fd.append('entity_code', meta.entity_code);
      if (meta.notes) fd.append('notes', meta.notes);
      return authedUploadX('/api/documents', fd);
    },
    downloadUrl: function (id) {
      return callX('GET', '/api/documents/' + encodeURIComponent(id) + '/download');
    },
    // Sensitive Documents tile (Quinn P2b): mint a short-lived STEP-UP token — the backend
    // requires a FRESH Supabase JWT, so the caller must have just re-authenticated (the FE
    // re-auth UI is the follow-on; until then a stale session gets 401 reauth_required, which
    // the tile surfaces honestly). Then open the sensitive doc passing X-Step-Up-Token.
    stepUp: function () {
      return callX('POST', '/api/documents/sensitive/step-up');
    },
    downloadUrlSensitive: function (id, stepUpToken) {
      var t = token();
      if (!t) return Promise.resolve({ ok: false, status: 0, data: null });
      return fetch(BASE + '/api/documents/' + encodeURIComponent(id) + '/download', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + t, 'X-Step-Up-Token': stepUpToken || '' },
      }).then(function (res) {
        return res.json().then(function (d) { return { ok: res.ok, status: res.status, data: d }; },
                               function () { return { ok: res.ok, status: res.status, data: null }; });
      }, function () { return { ok: false, status: 0, data: null }; });
    },
    del: function (id) { return callX('DELETE', '/api/documents/' + encodeURIComponent(id)); },
    // patch 030 — doc→record links ("store once, surface everywhere"). target = "<type>:<id>".
    listLinks: function (id) {
      return callX('GET', '/api/documents/' + encodeURIComponent(id) + '/links');
    },
    link: function (id, targetType, targetId) {
      return callX('POST', '/api/documents/' + encodeURIComponent(id) + '/links',
                   { target_type: targetType, target_id: targetId });
    },
    unlink: function (id, linkId) {
      return callX('DELETE', '/api/documents/' + encodeURIComponent(id)
                   + '/links/' + encodeURIComponent(linkId));
    },
  };

  // Per-user tile working-state (Part B) — the server home for what used to be localStorage-only
  // business state (buy box, analyzer assumptions, business plan, threshold knobs, jurisdiction).
  // shared/fl-state.js wraps this with the localStorage-migration bridge most tiles use.
  window.flTileState = {
    list: function () { return call('GET', '/api/tile-state'); },
    get: function (key) { return callX('GET', '/api/tile-state/' + encodeURIComponent(key)); },
    put: function (key, state) {
      return callX('PUT', '/api/tile-state/' + encodeURIComponent(key), { state: state });
    },
    // Best-effort PUT during pagehide/unload: keepalive so the browser does NOT cancel the request
    // as the document tears down (a plain fetch is routinely killed, silently losing the last edit).
    // Fire-and-forget; the caller has already written localStorage as the durable local copy.
    putKeepalive: function (key, state) {
      try {
        var t = token();
        if (!t) return;
        fetch(BASE + '/api/tile-state/' + encodeURIComponent(key), {
          method: 'PUT', keepalive: true,
          headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: state }),
        });
      } catch (e) {}
    },
    del: function (key) { return callX('DELETE', '/api/tile-state/' + encodeURIComponent(key)); },
  };

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
    // Lane 4b: opts.conversation_id continues a thread; opts.scope tags a NEW thread ('all' | layer
    // id). The response carries conversation_id + persisted so the caller can keep the thread going.
    chat: function (message, context, opts) {
      opts = opts || {};
      return authedCall(AGENT_BASE, 'POST', '/agent/chat', {
        message: message,
        context: context || null,
        conversation_id: opts.conversation_id || null,
        scope: opts.scope || (context && context.scope) || null,
      });
    },
  };

  // AI agent memory (Lane 4b) — READ side for the UI: load prior conversations + their messages
  // from FL Postgres so a chat reopens with its history (the agent service does the writes during
  // /agent/chat). RLS-scoped to the signed-in user; null on no-session/error -> caller stays ephemeral.
  window.flAiMemory = {
    conversations: function (scope) {
      return call('GET', '/api/ai/conversations' +
        (scope ? ('?scope_filter=' + encodeURIComponent(scope)) : ''));
    },
    messages: function (conversationId, limit) {
      return call('GET', '/api/ai/conversations/' + encodeURIComponent(conversationId) +
        '/messages' + (limit ? ('?limit=' + encodeURIComponent(limit)) : ''));
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

  // Deadlines (Lane-2 ops, 2C). One-off dated items behind the Calendar tile. Promoted columns +
  // JSONB details; creator-owned, optional entity/property linkage, RLS-scoped.
  window.flDeadlines = {
    list: function () { return call('GET', '/api/deadlines'); },
    get: function (id) { return call('GET', '/api/deadlines/' + encodeURIComponent(id)); },
    create: function (d) { return call('POST', '/api/deadlines', d); },
    update: function (id, patch) { return call('PATCH', '/api/deadlines/' + encodeURIComponent(id), patch); },
    del: function (id) { return call('DELETE', '/api/deadlines/' + encodeURIComponent(id)); },
  };

  // Recurring (Lane-2 ops, 2C). Repeating items behind the Recurring tile. Promoted columns +
  // JSONB details; creator-owned, optional entity linkage, RLS-scoped.
  window.flRecurring = {
    list: function () { return call('GET', '/api/recurring'); },
    get: function (id) { return call('GET', '/api/recurring/' + encodeURIComponent(id)); },
    create: function (r) { return call('POST', '/api/recurring', r); },
    update: function (id, patch) { return call('PATCH', '/api/recurring/' + encodeURIComponent(id), patch); },
    del: function (id) { return call('DELETE', '/api/recurring/' + encodeURIComponent(id)); },
  };

  // Insurance (Lane-2 ops, 2D). One row per policy behind the Insurance tile; renewal_date feeds
  // the Calendar. Promoted columns + JSONB details; creator-owned, optional entity/property
  // linkage, RLS-scoped.
  window.flInsurance = {
    list: function () { return call('GET', '/api/insurance'); },
    get: function (id) { return call('GET', '/api/insurance/' + encodeURIComponent(id)); },
    create: function (p) { return call('POST', '/api/insurance', p); },
    update: function (id, patch) { return call('PATCH', '/api/insurance/' + encodeURIComponent(id), patch); },
    del: function (id) { return call('DELETE', '/api/insurance/' + encodeURIComponent(id)); },
  };

  // Entities (Phase 3 setup). The setup flow creates the LLC rows here, as the SIGNED-IN USER —
  // TARS guides/asks, the app writes (this is NOT the autonomous agent). create() -> the new row,
  // or null on no-session / error (caller surfaces an honest "sign in to persist").
  window.flEntities = {
    list: function () { return call('GET', '/api/entities'); },
    // Status-carrying list ({ok, status, data}) so the Entities tile can tell a no-grant NEW
    // OPERATOR (403 -> offer "create your first company") from an unreachable API (status 0 ->
    // sample fallback). Ashley proving-run find #1.
    listX: function () { return callX('GET', '/api/entities'); },
    create: function (entity) { return call('POST', '/api/entities', entity); },
    // Status-carrying create so save errors are honest per-status (409 code exists · 403 reserved
    // prefix / parent outside scope · 401/0 session/down) instead of one blended guess.
    createX: function (entity) { return callX('POST', '/api/entities', entity); },
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
    // Status-carrying list ({ok, status, data}) so the record tiles can tell an authed 403/5xx apart
    // from a genuinely empty store — otherwise a transient error renders as a false "no records yet".
    listX: function (kind) { return callX('GET', '/api/admin-records?kind=' + encodeURIComponent(kind)); },
    get: function (id) { return call('GET', '/api/admin-records/' + encodeURIComponent(id)); },
    create: function (rec) { return call('POST', '/api/admin-records', rec); },
    update: function (id, patch) { return call('PATCH', '/api/admin-records/' + encodeURIComponent(id), patch); },
    // Hard-delete one record (creator or admin only — enforced server-side). Resolves to {} on
    // success (204), or null on no-session / 4xx / error so the caller keeps the row and explains.
    del: function (id) { return call('DELETE', '/api/admin-records/' + encodeURIComponent(id)); },
  };

  // ── Lane 3 A2 — Text-TARS add-on (entitlement + per-seat Stripe + SMS config) ──
  // Entitlements (server-enforced; closes TD-110). list() -> the caller's features/status/seats.
  window.flEntitlements = {
    list: function () { return call('GET', '/api/entitlements'); },
  };

  // Per-seat Stripe billing. subscribe() -> {checkout_url} to redirect to Stripe Checkout (test
  // mode), or null if billing isn't configured server-side (503) — the caller shows "billing not
  // set up yet" rather than a fake state.
  window.flBilling = {
    subscribe: function () { return call('POST', '/api/billing/text-tars/subscribe'); },
  };

  // SMS config (gated server-side by the active text_tars entitlement -> 403 if not). The wizard
  // connects the tenant's Twilio + registers team phones; each register/remove syncs the seat count.
  window.flSms = {
    getTelephony: function () { return call('GET', '/api/sms/telephony'); },
    setTelephony: function (cfg) { return call('POST', '/api/sms/telephony', cfg); },
    listNumbers: function () { return call('GET', '/api/sms/numbers'); },
    addNumber: function (n) { return call('POST', '/api/sms/numbers', n); },
    removeNumber: function (id) { return call('DELETE', '/api/sms/numbers/' + encodeURIComponent(id)); },
  };

  // ── Google Workspace connector (read-only Gmail + Calendar — brief 2026-07-11) ──
  // status/start/disconnect ride /api/oauth/google; data pulls ride /api/google. All status-
  // carrying: 409 = not connected (honest state, not an error), 502 = Google/agent trouble,
  // 503 = server not configured. start() resolves to {auth_url} — the caller navigates the TOP
  // window there (Google consent), and the backend callback redirects back to this origin with
  // ?google=connected|error. The refresh token NEVER reaches the browser.
  window.flGoogle = {
    status: function () { return callX('GET', '/api/oauth/google/status'); },
    start: function () { return callX('GET', '/api/oauth/google/start'); },
    disconnect: function () { return callX('POST', '/api/oauth/google/disconnect'); },
    inbox: function (max) {
      return callX('GET', '/api/google/inbox' + (max ? ('?max_results=' + max) : ''));
    },
    calendar: function (max) {
      return callX('GET', '/api/google/calendar' + (max ? ('?max_results=' + max) : ''));
    },
    briefEmail: function () { return callX('GET', '/api/google/brief-email'); },
    // Build 3: per-user email-importance rules (VIP/keyword/Gmail-signals). GET returns the
    // normalized config; PUT upserts it. Drives the Brief Email float + Inbox highlighting.
    importance: function () { return callX('GET', '/api/google/importance'); },
    setImportance: function (cfg) { return callX('PUT', '/api/google/importance', cfg); },
  };

  // ── Quinn Auto-File (4c L1 — propose→operator-approves, never auto-commit) ──
  // intake() drafts a proposal from an uploaded document; NOTHING saves until approve().
  // All status-carrying: 403 = not hired / not allowed, 409 = draft not in that state,
  // 422 = validation/acks missing, 502 = document reader trouble.
  window.flQuinn = {
    employees: function () { return callX('GET', '/api/ai/employees'); },
    hire: function (key, hired) {
      return callX('POST', '/api/ai/employees/' + encodeURIComponent(key) + '/hire',
                   { hired: !!hired });
    },
    intake: function (documentId, kind, entityCode) {
      return callX('POST', '/api/ai/intake', {
        document_id: documentId, kind: kind || null, entity_code: entityCode || null,
      });
    },
    pending: function (status) {
      return callX('GET', '/api/ai/pending' + (status ? ('?status=' + encodeURIComponent(status)) : ''));
    },
    affirm: function (id, body) {
      return callX('POST', '/api/ai/pending/' + encodeURIComponent(id) + '/affirm', body);
    },
    approve: function (id, body) {
      return callX('POST', '/api/ai/pending/' + encodeURIComponent(id) + '/approve', body || {});
    },
    reject: function (id) {
      return callX('POST', '/api/ai/pending/' + encodeURIComponent(id) + '/reject', {});
    },
  };

  // Access-code-gated sign-up (pre-auth — NO token; public Supabase sign-up stays OFF). POSTs to
  // /api/signup; returns {ok, status, body} so the caller can show honest per-status messages
  // (403 bad code · 409 email exists · 429 slow down · 503 not enabled). On ok, the caller signs
  // in through flAuth.signIn (the normal JWT path — this never mints a token itself).
  window.flSignup = {
    create: async function (email, password, accessCode) {
      try {
        var res = await fetch(BASE + '/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password, access_code: accessCode }),
        });
        var body = await res.json().catch(function () { return null; });
        return { ok: res.ok, status: res.status, body: body };
      } catch (e) {
        return { ok: false, status: 0, body: null };
      }
    },
  };

  // In-app bug-capture (schema_patch_017) — backs the "Report an issue" control + admin Feedback
  // tile. Owner-scoped server-side: a member's list() returns only their own reports; an admin's
  // returns all (triage). submit() resolves to the created row on success or null on no-session /
  // 4xx / 5xx / network error — the control MUST treat null as an honest failure and preserve the
  // tester's text (never silently drop). severity: blocker|bug|confusing|idea; status: new|triaged|
  // closed. entity_code/context/route/user_agent are optional metadata auto-captured at filing time.
  window.flFeedback = {
    submit: function (report) { return call('POST', '/api/feedback', report); },
    list: function () { return call('GET', '/api/feedback'); },
    setStatus: function (id, status) {
      return call('PATCH', '/api/feedback/' + encodeURIComponent(id), { status: status });
    },
  };
})();
