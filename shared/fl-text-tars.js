/* ════════════════════════════════════════════════════════════════
   fl-text-tars.js — Text-TARS add-on surface + self-serve setup wizard (Lane 3 A2)
   - Renders the add-on card: real entitlement state from GET /api/entitlements
     (server-enforced — never localStorage; TD-110).
   - Not active -> "what you'll need" checklist + Enable (Stripe Checkout, test mode).
   - Active -> wizard: (1) connect Twilio, (2) register team phones (each syncs the
     per-seat Stripe quantity), (3) test (talks to the same L0 advisor the texts reach).
   - Honest fallbacks: signed out -> prompt sign-in; an endpoint returning null ->
     plain "not available / sign in" — never a fabricated subscription/seat state.
   Mount: FLTextTars.mount(elementOrId).
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function authed() { return !!(window.flApi && flApi.authed && flApi.authed()); }

  var CHECKLIST = [
    'A Twilio account + a phone number you own (BYO — telecom is billed to you by Twilio).',
    'A2P 10DLC registration on that number (US carrier requirement; allow a few days lead time).',
    'Your Twilio Account SID + Auth Token (pasted in step 1; stored encrypted, never shown again).',
  ];

  async function entitlement() {
    var rows = await window.flEntitlements.list();
    if (!Array.isArray(rows)) return null;            // null = signed out / error
    return rows.filter(function (r) { return r.feature === 'text_tars'; })[0]
           || { feature: 'text_tars', status: 'inactive', seats: 0 };
  }

  function row(el, html) { var d = document.createElement('div'); d.innerHTML = html; el.appendChild(d); return d; }

  async function mount(target) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    el.innerHTML = '<div class="tt-card"><h3>📱 Text-TARS <span class="pill">add-on</span></h3>'
      + '<p class="su-dim">Your crew texts your AI employee from the field — answers scoped to '
      + 'exactly their access, governed the same way your staff are. Per registered phone, per month.</p>'
      + '<div class="tt-body">Loading…</div></div>';
    var body = el.querySelector('.tt-body');
    if (!authed()) { body.innerHTML = 'Sign in to the Command Center to enable Text-TARS.'; return; }
    var ent = await entitlement();
    if (!ent) { body.innerHTML = 'Couldn’t load your add-on status — sign in again and retry.'; return; }
    if (ent.status === 'active') renderWizard(body, ent);
    else renderPaywall(body, ent);
  }

  function renderPaywall(body, ent) {
    var statusNote = ent.status === 'past_due'
      ? '<div class="tt-warn">Your subscription is past due — update billing to re-enable.</div>' : '';
    body.innerHTML = statusNote
      + '<div class="tt-status">Status: <b>' + esc(ent.status) + '</b></div>'
      + '<div class="tt-what"><b>What you’ll need</b><ul>'
      + CHECKLIST.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('')
      + '</ul></div>'
      + '<button type="button" class="echip on" id="tt-enable">Enable Text-TARS</button>'
      + '<div class="su-dim" id="tt-enable-msg"></div>';
    body.querySelector('#tt-enable').onclick = async function () {
      var msg = body.querySelector('#tt-enable-msg'); msg.textContent = 'Starting checkout…';
      var res = await window.flBilling.subscribe();
      if (res && res.checkout_url) { window.location.href = res.checkout_url; return; }
      msg.innerHTML = 'Billing isn’t set up on the server yet (no Stripe keys). An admin can also '
        + 'enable this account directly for dogfooding.';
    };
  }

  async function renderWizard(body, ent) {
    body.innerHTML = '<div class="tt-status">✅ Active · <b>' + (ent.seats || 0) + '</b> seat(s)</div>'
      + '<ol class="tt-wiz">'
      + '<li><b>Connect Twilio</b><div id="tt-tw"></div></li>'
      + '<li><b>Register team phones</b><div id="tt-nums"></div></li>'
      + '<li><b>Test</b><div id="tt-test"></div></li>'
      + '</ol>';
    renderTwilio(body.querySelector('#tt-tw'));
    renderNumbers(body.querySelector('#tt-nums'));
    renderTest(body.querySelector('#tt-test'));
  }

  function renderTwilio(el) {
    el.innerHTML = '<input class="setup-mini-in" id="tt-sid" placeholder="Twilio Account SID (AC…)">'
      + '<input class="setup-mini-in" id="tt-tok" placeholder="Twilio Auth Token (stored encrypted)">'
      + '<input class="setup-mini-in" id="tt-num" placeholder="Your Twilio number (+1…)">'
      + '<button type="button" class="echip" id="tt-tw-save">Save Twilio config</button>'
      + '<span class="su-dim" id="tt-tw-msg"></span>';
    window.flSms.getTelephony().then(function (t) {
      if (t && t.inbound_number) el.querySelector('#tt-tw-msg').textContent =
        'Connected: ' + t.inbound_number + (t.token_set ? ' (token set)' : '');
    });
    el.querySelector('#tt-tw-save').onclick = async function () {
      var msg = el.querySelector('#tt-tw-msg'); msg.textContent = 'Saving…';
      var res = await window.flSms.setTelephony({
        twilio_account_sid: el.querySelector('#tt-sid').value.trim(),
        twilio_auth_token: el.querySelector('#tt-tok').value.trim(),
        inbound_number: el.querySelector('#tt-num').value.trim(),
      });
      msg.textContent = res ? 'Saved (token encrypted server-side).'
        : 'Couldn’t save — check sign-in / that Text-TARS is active.';
      if (res) el.querySelector('#tt-tok').value = '';   // never keep the token in the DOM
    };
  }

  function renderNumbers(el) {
    function refresh() {
      window.flSms.listNumbers().then(function (rows) {
        var list = Array.isArray(rows) ? rows : [];
        el.querySelector('#tt-list').innerHTML = list.length
          ? list.map(function (n) {
              return '<div class="tt-num">' + esc(n.phone) + ' <span class="su-dim">'
                + esc(n.label || '') + '</span> <button type="button" class="echip" data-id="'
                + esc(n.id) + '">remove</button></div>'; }).join('')
          : '<div class="su-dim">No phones registered yet.</div>';
        el.querySelectorAll('[data-id]').forEach(function (b) {
          b.onclick = async function () { await window.flSms.removeNumber(b.getAttribute('data-id')); refresh(); };
        });
      });
    }
    el.innerHTML = '<input class="setup-mini-in" id="tt-phone" placeholder="Team phone (+1…)">'
      + '<input class="setup-mini-in" id="tt-label" placeholder="Label (e.g. Foreman)">'
      + '<button type="button" class="echip" id="tt-add">Register phone</button>'
      + '<div class="su-dim">Each registered phone is one billed seat.</div><div id="tt-list"></div>';
    el.querySelector('#tt-add').onclick = async function () {
      var p = el.querySelector('#tt-phone').value.trim(); if (!p) return;
      await window.flSms.addNumber({ phone: p, label: el.querySelector('#tt-label').value.trim(), scope: 'all' });
      el.querySelector('#tt-phone').value = ''; el.querySelector('#tt-label').value = ''; refresh();
    };
    refresh();
  }

  function renderTest(el) {
    el.innerHTML = '<div class="su-dim">Ask the same advisor your texts will reach (web path, no '
      + 'live number needed):</div><input class="setup-mini-in" id="tt-q" placeholder="e.g. any open '
      + 'work orders?"><button type="button" class="echip" id="tt-go">Ask</button>'
      + '<div id="tt-ans" class="tt-ans"></div>';
    el.querySelector('#tt-go').onclick = async function () {
      var q = el.querySelector('#tt-q').value.trim(); if (!q) return;
      var ans = el.querySelector('#tt-ans'); ans.textContent = '…';
      var res = (window.flAgent && flAgent.authed && flAgent.authed())
        ? await window.flAgent.chat(q, { scope: 'all', hint: 'Text-TARS setup test' }, { scope: 'all' }) : null;
      ans.textContent = res && res.answer ? res.answer : 'Sign in to test the advisor.';
    };
  }

  window.FLTextTars = { mount: mount };
})();
