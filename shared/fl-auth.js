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
  var CFG = window.FL_SUPABASE || {};

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

  window.flAuth = { configured: configured, signIn: signIn, signOut: signOut, token: token, email: email };
})();
