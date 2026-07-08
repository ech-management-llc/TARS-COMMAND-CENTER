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

  // Self-service password reset: ask GoTrue to email a recovery link that lands on the dedicated
  // /reset-password/ handler. GoTrue returns 200 whether or not the address has an account (no
  // account enumeration), so callers must keep the confirmation message neutral. redirect_to is the
  // allow-listed reset page; 429 (rate-limited) is surfaced distinctly so the UI can say "wait".
  async function requestPasswordReset(emailAddr) {
    if (!configured()) return { error: 'not_configured' };
    var redirectTo = location.origin + '/reset-password/';
    try {
      var res = await fetch(CFG.url + '/auth/v1/recover?redirect_to=' + encodeURIComponent(redirectTo), {
        method: 'POST',
        headers: { 'apikey': CFG.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailAddr }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 429) return { error: 'rate_limited' };
      var data = await res.json().catch(function () { return {}; });
      return { error: data.error_description || data.msg || data.error || ('HTTP ' + res.status) };
    } catch (e) {
      return { error: 'network' };
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
    requestPasswordReset: requestPasswordReset,
    refresh: refresh, needsRefresh: needsRefresh, expired: expired,
    mountReportButton: function () { _mountReportButton(); },   // callable after in-window login
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
  // ── "Report an issue" control (bug-capture loop, schema_patch_017) ──
  // One small persistent button in the TOP window (skipped inside drill-in iframes, so there's
  // exactly one — it floats above the drill-in overlay and is reachable on every screen). Opens a
  // tiny form (severity + free-text) with context/route/user-agent auto-captured, and POSTs via
  // flFeedback. HONEST STATES: a failed send shows an error AND preserves the tester's text — it is
  // never silently dropped. Shown only to a signed-in tester (feedback needs a JWT). startApp()
  // calls flAuth.mountReportButton() after an in-window login; focus/storage retries cover other
  // paths. Cross-tenant scoping is enforced server-side (owner-scoped RLS + route).
  function _reportCtx() {
    try {
      var t = document.querySelector('.ptitle');                 // the open drill-in's title, if any
      if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
      if (document.title) return document.title.trim();
    } catch (e) {}
    return 'dashboard';
  }
  function _mountReportButton() {
    try {
      if (typeof document === 'undefined' || !document.body) return;
      if (window.top !== window.self) return;                    // top window only (one button)
      if (!token()) return;                                      // signed-in testers only
      if (document.getElementById('fl-report-btn')) return;      // mount once

      var style = document.createElement('style');
      style.textContent =
        '#fl-report-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;' +
          'background:#1f2937;color:#e5e7eb;border:1px solid rgba(148,163,184,.4);border-radius:999px;' +
          'padding:9px 14px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;' +
          'box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
        '#fl-report-btn:hover{background:#374151}' +
        '#fl-report-modal{position:fixed;inset:0;z-index:2147483001;display:none;' +
          'align-items:flex-end;justify-content:flex-end;background:rgba(0,0,0,.35)}' +
        '#fl-report-modal.open{display:flex}' +
        '#fl-report-card{background:#0f172a;color:#e5e7eb;border:1px solid rgba(148,163,184,.35);' +
          'border-radius:14px;margin:0 16px 74px 16px;padding:16px;width:min(360px,92vw);' +
          'box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui,-apple-system,sans-serif}' +
        '#fl-report-card h3{margin:0 0 10px;font-size:15px}' +
        '#fl-report-card label{display:block;font-size:12px;color:#9ca3af;margin:8px 0 4px}' +
        '#fl-report-card select,#fl-report-card textarea{width:100%;box-sizing:border-box;background:#111827;' +
          'color:#e5e7eb;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px;' +
          'font:14px system-ui,-apple-system,sans-serif}' +
        '#fl-report-card textarea{min-height:88px;resize:vertical}' +
        '#fl-report-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}' +
        '#fl-report-row button{border-radius:8px;padding:8px 14px;font:600 13px system-ui;cursor:pointer;' +
          'border:1px solid transparent}' +
        '#fl-report-cancel{background:transparent;color:#9ca3af;border-color:rgba(148,163,184,.35)}' +
        '#fl-report-send{background:#2563eb;color:#fff}' +
        '#fl-report-send[disabled]{opacity:.6;cursor:default}' +
        '#fl-report-msg{margin-top:10px;font-size:12.5px;min-height:16px}' +
        '#fl-report-msg.ok{color:#34d399}#fl-report-msg.err{color:#f87171}';
      document.head.appendChild(style);

      var btn = document.createElement('button');
      btn.id = 'fl-report-btn'; btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.textContent = '🐞 Report an issue';

      var modal = document.createElement('div');
      modal.id = 'fl-report-modal';
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      modal.innerHTML =
        '<div id="fl-report-card">' +
          '<h3>Report an issue</h3>' +
          '<label for="fl-report-sev">What kind?</label>' +
          '<select id="fl-report-sev">' +
            '<option value="bug">Something’s broken (bug)</option>' +
            '<option value="blocker">I’m blocked (can’t continue)</option>' +
            '<option value="confusing">Confusing / unclear</option>' +
            '<option value="idea">Idea / suggestion</option>' +
          '</select>' +
          '<label for="fl-report-body">Tell us what happened</label>' +
          '<textarea id="fl-report-body" placeholder="What did you expect, and what happened instead?"></textarea>' +
          '<div id="fl-report-msg" role="status"></div>' +
          '<div id="fl-report-row">' +
            '<button id="fl-report-cancel" type="button">Cancel</button>' +
            '<button id="fl-report-send" type="button">Send</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(btn);
      document.body.appendChild(modal);

      var bodyEl = modal.querySelector('#fl-report-body');
      var sevEl = modal.querySelector('#fl-report-sev');
      var msgEl = modal.querySelector('#fl-report-msg');
      var sendBtn = modal.querySelector('#fl-report-send');

      function openModal() {
        msgEl.className = ''; msgEl.textContent = '';
        modal.classList.add('open');
        setTimeout(function () { try { bodyEl.focus(); } catch (e) {} }, 30);
      }
      function closeModal() { modal.classList.remove('open'); }

      btn.addEventListener('click', openModal);
      modal.querySelector('#fl-report-cancel').addEventListener('click', closeModal);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
      });

      sendBtn.addEventListener('click', async function () {
        var body = (bodyEl.value || '').trim();
        var sev = sevEl.value || 'bug';
        msgEl.className = ''; msgEl.textContent = '';
        if (!body) { msgEl.className = 'err'; msgEl.textContent = 'Please describe the issue first.'; return; }
        if (!window.flFeedback) {
          msgEl.className = 'err';
          msgEl.textContent = 'Reporting is unavailable right now — your text is kept.';
          return;
        }
        sendBtn.disabled = true; msgEl.textContent = 'Sending…';
        var res = await flFeedback.submit({
          severity: sev, body: body, context: _reportCtx(),
          route: (location.pathname + location.hash) || location.href,
          user_agent: navigator.userAgent,
        });
        sendBtn.disabled = false;
        if (res && res.id) {
          msgEl.className = 'ok';
          msgEl.textContent = 'Thanks — logged. TARS will see this.';
          bodyEl.value = '';                                     // clear only on confirmed success
          setTimeout(closeModal, 1200);
        } else {
          // Honest failure — DO NOT clear the textarea; the tester keeps their words.
          var expiredSession = !!(window.flApi && flApi.authExpired && flApi.authExpired());
          msgEl.className = 'err';
          msgEl.textContent = expiredSession
            ? 'Your session expired — sign in again; your text is saved here.'
            : 'Couldn’t send just now — your text is saved here. Try again.';
        }
      });
    } catch (e) {}
  }

  if (typeof document !== 'undefined') {
    var _mountAll = function () { _mountDemoBanner(); _mountReportButton(); };
    if (document.readyState !== 'loading') _mountAll();
    else document.addEventListener('DOMContentLoaded', _mountAll);
    // The report button needs a session; if the tester signs in without a full reload, retry.
    window.addEventListener('focus', _mountReportButton);
    window.addEventListener('storage', function (e) {
      if (!e || e.key === 'fl_auth_token' || e.key === null) _mountReportButton();
    });
  }
})();
