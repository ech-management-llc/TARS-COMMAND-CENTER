/* ════════════════════════════════════════════════════════════════
   fl-auth.js — real Supabase Auth for the static TCC (Lane 1 unlock).

   Email + password sign-in against the project's Supabase Auth REST endpoint,
   using the PUBLIC publishable (anon) key — safe to ship client-side: it only
   permits auth + RLS-gated requests, never privileged data access. On success
   the access_token (ES256 JWT) is stored in `fl_auth_token`, which fl-api.js
   reads to authenticate /api/* calls. Config comes from window.FL_SUPABASE
   ({url, anon}); if absent, configured() is false and callers fall back to the
   local demo session (no lockout).

   Magic-link / SMS is the team-phase upgrade (needs Supabase email/SMS config);
   password is the reliable single-operator path today.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.flAuth) return;
  // Fall back to the public project config when FL_SUPABASE isn't set — e.g. inside a drill-in
  // artifact iframe, which doesn't inherit the top-level <script> config. The anon/publishable key
  // is public by design (TD-105 — same key already shipped in index.html); RLS + JWKS enforce
  // security. This is what lets token refresh work from inside a tile, not just the shell.
  var CFG = window.FL_SUPABASE || {
    url: 'https://vnsbmzbnvszgsibttkot.supabase.co',
    anon: 'sb_publishable_lAyX64SeqyQz8dyA25i91w_1jp7dxaL',
  };
  var _expired = false;   // true once a refresh CONFIRMS the session is dead (vs merely signed-out)

  function configured() { return !!(CFG.url && CFG.anon); }

  async function signIn(email, password) {
    if (!configured()) return { error: 'Auth is not configured.' };
    try {
      var res = await fetch(CFG.url + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'apikey': CFG.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        return { error: data.error_description || data.msg || data.error || ('Sign-in failed (' + res.status + ')') };
      }
      try {
        localStorage.setItem('fl_auth_token', data.access_token || '');
        if (data.refresh_token) localStorage.setItem('fl_auth_refresh', data.refresh_token);
        localStorage.setItem('fl_auth_exp', String(Date.now() + ((data.expires_in || 3600) * 1000)));
        localStorage.setItem('fl_auth_email', (data.user && data.user.email) || email);
      } catch (e) {}
      _expired = false;   // fresh session
      return { user: data.user, access_token: data.access_token };
    } catch (e) {
      return { error: 'Could not reach Supabase. Check your connection.' };
    }
  }

  function signOut() {
    try {
      ['fl_auth_token', 'fl_auth_refresh', 'fl_auth_exp', 'fl_auth_email']
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  function token() { try { return localStorage.getItem('fl_auth_token'); } catch (e) { return null; } }
  function email() { try { return localStorage.getItem('fl_auth_email'); } catch (e) { return null; } }

  // Access tokens expire after ~1h. needsRefresh() is true when the stored token is within 60s of
  // its expiry (fl_auth_exp), so callers can refresh proactively before a request 401s.
  function needsRefresh() {
    try {
      if (!localStorage.getItem('fl_auth_token')) return false;
      var exp = parseInt(localStorage.getItem('fl_auth_exp') || '0', 10);
      return exp ? (Date.now() > exp - 60000) : false;
    } catch (e) { return false; }
  }

  // expired() = a refresh CONFIRMED the session is dead (refresh token rejected). Distinct from a
  // plain signed-out state — lets the UI say "your session expired" instead of a misleading empty.
  function expired() { return _expired; }

  // Exchange the stored refresh token for a new access token. Returns true on success.
  // On an AUTH rejection (refresh token bad/expired) it clears the session and marks expired.
  // On a transient NETWORK error it returns false WITHOUT clearing (the existing token may still work).
  async function refresh() {
    if (!configured()) return false;
    var rt = null; try { rt = localStorage.getItem('fl_auth_refresh'); } catch (e) {}
    if (!rt) { signOut(); _expired = true; return false; }
    try {
      var res = await fetch(CFG.url + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'apikey': CFG.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.access_token) { signOut(); _expired = true; return false; }
      try {
        localStorage.setItem('fl_auth_token', data.access_token);
        if (data.refresh_token) localStorage.setItem('fl_auth_refresh', data.refresh_token);
        localStorage.setItem('fl_auth_exp', String(Date.now() + ((data.expires_in || 3600) * 1000)));
      } catch (e) {}
      _expired = false;
      return true;
    } catch (e) {
      return false;   // network error — don't clear; could be transient
    }
  }

  window.flAuth = {
    configured: configured, signIn: signIn, signOut: signOut, token: token, email: email,
    refresh: refresh, needsRefresh: needsRefresh, expired: expired,
  };

  // ── DEMO-ENVIRONMENT banner inside drill-in artifacts (Tier-2 backlog #1) ──
  // The shell shows its own SAMPLE banner (app.js), but that can't reach drill-in iframes. When a
  // demo/synthetic account is signed in, mount an amber "DEMO ENVIRONMENT" banner atop the artifact
  // (.art-wrap). Self-mounting here so every artifact that already loads fl-auth gets it for free —
  // no per-tile wiring. Keyed off the same email rule as the shell's isDemoAccount().
  function _isDemoEmail() {
    var e = (email() || '').toLowerCase();
    return !!e && (e === 'demo@foundationlayerhq.com' || /@prebash\.foundationlayerhq\.com$/.test(e));
  }
  function _mountDemoBanner() {
    try {
      if (!_isDemoEmail()) return;
      var w = document.querySelector('.art-wrap');
      if (!w || w.querySelector('.fl-demo-banner')) return;
      var d = document.createElement('div');
      d.className = 'preview-banner fl-demo-banner';
      d.setAttribute('role', 'note');
      d.style.cssText = 'background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.45);color:#f6c453';
      d.innerHTML = '🧪 <b>DEMO ENVIRONMENT</b> — sample data for walkthrough, <b>not real figures</b>.';
      w.insertBefore(d, w.firstChild);
    } catch (e) {}
  }
  if (typeof document !== 'undefined') {
    if (document.readyState !== 'loading') _mountDemoBanner();
    else document.addEventListener('DOMContentLoaded', _mountDemoBanner);
  }
})();
