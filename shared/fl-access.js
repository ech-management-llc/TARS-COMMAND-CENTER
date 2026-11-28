/* shared/fl-access.js — which companies can this person see, and WHY (wrong-words dispatch, 2026-11-21).

   The Foundation Layer API answers two different situations alike. An owner who has been given no company and the
   owner of a brand-new account that holds none both get GET /api/entities = 200 [] (src/dependencies/scope.py
   require_entity_scope lets every owner through; an owner sees only the companies granted to her). A member who has
   been given none is refused outright: 403 "No entity access granted". A screen that reads "no rows" as "nothing
   exists yet" tells a person who was simply not given access to create a company — the defect this file exists to
   stop.

   One fact, for every screen that needs it:
     kind
       'has'         FL lists at least one company for this person.
       'none'        this person has been given no company and the account is not a new one:
                       - a member FL refuses (403 on the company list), or
                       - an owner whose list is empty while another person in the account holds companies — read from
                         the owner-only roster (GET /api/team, then GET /api/team/{id}/entities for each other person).
       'empty'       no company is known in this account, and this person may create the first: an owner whose roster
                     shows nobody else (active) holding a company. Sign-up always creates the account, so this is the
                     shape of a new customer's owner.
       'signed-out'  no session (or the API says so).
       'unknown'     an answer could not be read (network, a 5xx, an unexpected shape), or an owner FL says has no
                     account at all (409 on the roster: set up by hand — a company she created would belong to no
                     account): offer nothing, and say so.
     mayCreate       true only for 'empty'. FL itself accepts a company from ANY owner, so this is the shell's rule.
     why             a short reason code, for the screens' tests and the report — never shown to a person.

   Limits (measured against FL 054fb17, reported forward): the roster scan is an ESTIMATE, wrong in either direction at
   the edges. It cannot see a company that nobody in the account holds (one the platform account created under a tenant
   parent writes no grant), and it counts a soft-deleted company someone still holds a grant on. An exact answer needs
   one small read-only FL route; until then a company nobody holds reads as 'empty'.

   No words live here: what a person is told is decided by each screen. */
(function () {
  'use strict';

  var ROSTER_CAP = 50;   // a tenant's roster is a handful of people; past this we stop and answer 'unknown'

  function lower(s) { return String(s || '').trim().toLowerCase(); }
  function api() { return window.flApi && window.flApi.callX ? window.flApi : null; }
  function signedIn() { var a = api(); return !!(a && a.authed && a.authed()); }
  function me() { try { return lower(window.flAuth && window.flAuth.email && window.flAuth.email()); } catch (e) { return ''; } }
  function fact(kind, why, extra) {
    var f = { kind: kind, mayCreate: kind === 'empty', why: why };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
    return f;
  }
  function lost(why) { return fact(signedIn() ? 'unknown' : 'signed-out', signedIn() ? why : 'no-session'); }

  // An owner whose own list is empty: does anyone else in the account hold a company?
  function scanRoster() {
    var a = api();
    return a.callX('GET', '/api/team').then(function (t) {
      if (!t) return lost('roster-no-answer');
      if (t.status === 409) return fact('unknown', 'no-tenant');                // "your account has no tenant yet": set up by hand, not by sign-up
      if (t.status === 400) return fact('empty', 'platform-empty');             // the platform account sees every company; it saw none
      if (t.status === 401 || t.status === 0) return lost('roster-' + t.status);
      if (!t.ok || !Array.isArray(t.data)) return fact('unknown', 'roster-' + t.status);
      var self = me();
      var others = t.data.filter(function (p) {
        return p && p.id && lower(p.email) !== self && p.active !== false && lower(p.status) !== 'disabled';
      });
      if (!others.length) return fact('empty', 'alone');
      if (others.length > ROSTER_CAP) return fact('unknown', 'roster-too-long');
      return Promise.all(others.map(function (p) {
        return a.callX('GET', '/api/team/' + encodeURIComponent(p.id) + '/entities');
      })).then(function (rs) {
        var codes = {}, bad = 0;
        rs.forEach(function (r) {
          if (r && r.ok && r.data && Array.isArray(r.data.entities)) {
            r.data.entities.forEach(function (g) { if (g && g.code) codes[g.code] = 1; });
          } else bad++;
        });
        var n = Object.keys(codes).length;
        if (n) return fact('none', 'others-hold', { held: n });
        if (bad) return lost('grants-unread');
        return fact('empty', 'no-one-holds');
      });
    });
  }

  // A read that never answers must not hold a screen open: past this, the fact is 'unknown' and nothing is offered.
  // It covers the whole of a read — the list, its token renewal, the roster — not only the roster (TD-266 R1A1-2).
  var READ_LIMIT_MS = 10000;
  function bounded(p) {
    return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(lost('slow')); }, READ_LIMIT_MS); })]);
  }

  // r = the status-carrying answer to GET /api/entities ({ok, status, data}) a screen already holds.
  function classify(r) {
    return bounded(classify0(r));
  }
  function classify0(r) {
    return Promise.resolve().then(function () {
      if (!r || r.status === 0) return lost('list-no-answer');
      if (r.status === 401) return fact('signed-out', 'list-401');
      if (r.status === 403) return fact('none', 'refused');                     // "No entity access granted"
      if (!r.ok) return fact('unknown', 'list-' + r.status);
      if (!Array.isArray(r.data)) return fact('unknown', 'list-shape');
      if (r.data.length) return fact('has', 'listed', { count: r.data.length });
      if (!api()) return fact('unknown', 'no-api');
      return scanRoster();
    }).catch(function () { return lost('error'); });
  }

  // Reads the list itself. One answer per session token, shared by every caller in this window until forget().
  var memo = null, memoTok = null;
  function read() {
    var a = api();
    if (!a || !signedIn()) return Promise.resolve(fact('signed-out', 'no-session'));
    var tok = a.token ? a.token() : '';
    if (memo && memoTok === tok) return memo;
    memoTok = tok;
    memo = a.callX('GET', '/api/entities').then(classify0, function () { return lost('error'); });   // the real answer is what is kept for the token
    return bounded(memo);   // what a caller gets ends within the limit; a stall is never cached as the answer
  }
  function forget() { memo = null; memoTok = null; }

  // A person who holds companies ('has'): is she the account's OWNER? FL takes a company from an owner (or the platform
  // account) only — a member given companies is refused at the create (routes/entities.py: "only a tenant-owner or
  // genesis can create a company") — and the fact alone cannot tell the two apart. The roster says which: an owner may
  // read it, the platform account gets 400, a member is refused (403). Adds role: 'owner' | 'member' to the fact.
  // (The exact FL signal, a read-only access route, is described in the report and not commissioned.) TD-266 R1A1-3.
  function ownerHolds(a) {
    var x = api();
    if (!x) return Promise.resolve(fact('unknown', 'no-api'));
    return x.callX('GET', '/api/team').then(function (t) {
      if (!t || t.status === 0 || t.status === 401) return lost('role-' + (t ? t.status : 'no-answer'));
      if (t.ok || t.status === 400) return fact('has', 'owner-holds', { count: a.count, role: 'owner' });
      if (t.status === 403) return fact('has', 'member-holds', { count: a.count, role: 'member' });
      return fact('unknown', 'role-' + t.status);
    }, function () { return lost('error'); });
  }

  // At the moment a company create is pressed: read the fact afresh, for the session that will actually be sent.
  // 'first' — a screen that offers the account's FIRST company: only 'empty'. 'more' — a screen that also serves a
  // person who already holds companies (Entities, TARS, Get set up): 'empty', or 'has' as the account's owner. A form
  // drawn under an older fact, a person who changed under it, or a grant taken away meanwhile is caught here, before
  // anything is sent.
  function mayCreateNow(rule) {
    forget();
    return bounded(read().then(function (a) {
      if (!a || a.mayCreate || rule !== 'more' || a.kind !== 'has') return a;
      return ownerHolds(a);
    })).then(function (a) {
      var ok = !!a && (a.mayCreate || (rule === 'more' && a.kind === 'has' && a.role === 'owner'));
      return { ok: ok, a: a };
    }, function () { return { ok: false, a: lost('error') }; });
  }

  window.flAccess = { classify: classify, read: read, forget: forget, mayCreateNow: mayCreateNow };
})();
