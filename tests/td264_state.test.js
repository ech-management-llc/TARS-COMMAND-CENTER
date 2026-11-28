'use strict';
/* TD-264 — a browser copy of tile state belongs to the signed-in person, not to the browser.
   Plain node, no dependencies: shared/fl-state.js runs inside a fake window with a fake
   localStorage, the fl-auth.js / fl-api.js surface it reads, and a fake /api/tile-state that
   keeps one row set per account. Run:  node tests/td264_state.test.js   (exit code 1 on failure)

   The sequence it proves (the register's own run, made reproducible):
     person A signs in and types a draft  -> saved under A's account on the server, and in the
                                             browser under A only
     A signs out                          -> every browser copy of A's is removed
     person B signs in on the same browser-> first paint shows nothing of A's; the server says B
                                             has no row; B's first keystroke saves B's line only
     B signs out, A signs in              -> A's draft comes back from A's account */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'fl-state.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log(t); }
const tick = () => new Promise(r => setImmediate(r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function jwt(sub, email) {
  return b64url('{"alg":"ES256","typ":"JWT"}') + '.' + b64url(JSON.stringify({ sub: sub, email: email, role: 'authenticated' })) + '.sig';
}

class FakeStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { const k = Array.from(this.m.keys())[i]; return k === undefined ? null : k; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(String(k), String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return Array.from(this.m.keys()); }
}

// One browser window with fl-state.js loaded. Pass a storage to stand for a page reload in the
// same browser (same localStorage, a fresh copy of the script).
function makeWorld(storage) {
  const localStorage = storage || new FakeStorage();
  const listeners = {};
  const server = { rows: {}, puts: [] };   // rows[account][key] = state
  const win = {
    localStorage: localStorage,
    setTimeout: setTimeout, clearTimeout: clearTimeout, atob: globalThis.atob,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
  };
  win.window = win;
  // the fl-auth.js / fl-api.js surface fl-state.js reads
  win.flAuth = {
    token() { return localStorage.getItem('fl_auth_token'); },
    email() { return localStorage.getItem('fl_auth_email'); },
  };
  win.flApi = { token: () => localStorage.getItem('fl_auth_token'), authed: () => !!localStorage.getItem('fl_auth_token') };
  function whoami() {
    const t = localStorage.getItem('fl_auth_token'); if (!t) return null;
    try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).sub; } catch (e) { return null; }
  }
  win.flTileState = {
    get: async (key) => {
      const a = whoami(); if (!a) return { ok: false, status: 401 };
      const row = (server.rows[a] || {})[key];
      return row === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, data: { state: row } };
    },
    put: async (key, state) => {
      const a = whoami(); server.puts.push({ as: a, key: key, state: state });
      if (!a) return { ok: false, status: 401 };
      (server.rows[a] = server.rows[a] || {})[key] = state;
      return { ok: true, status: 200, data: { state: state } };
    },
  };
  vm.runInContext(SRC, vm.createContext(win), { filename: 'fl-state.js' });

  const AUTH_KEYS = ['fl_auth_token', 'fl_auth_refresh', 'fl_auth_exp', 'fl_auth_email'];
  const acts = {
    // what fl-auth.js writes at sign-in, plus the storage event other windows receive
    signIn(sub, email) {
      localStorage.setItem('fl_auth_token', jwt(sub, email)); localStorage.setItem('fl_auth_email', email);
      localStorage.removeItem('fl_auth_ended');
      win.dispatchEvent({ type: 'storage', key: 'fl_auth_token', newValue: localStorage.getItem('fl_auth_token') });
    },
    // flAuth.signOut() as another window sees it
    signOut() { AUTH_KEYS.forEach(k => localStorage.removeItem(k)); win.dispatchEvent({ type: 'storage', key: 'fl_auth_token', newValue: null }); },
    // the session ends while no copy of fl-state.js is alive to hear it
    signOutSilently() { AUTH_KEYS.forEach(k => localStorage.removeItem(k)); },
    // a failed refresh: fl-auth.js clears the session, writes fl_auth_ended, fires fl:auth-ended
    sessionEnds(email) {
      AUTH_KEYS.forEach(k => localStorage.removeItem(k));
      localStorage.setItem('fl_auth_ended', JSON.stringify({ at: Date.now(), email: email }));
      win.dispatchEvent({ type: 'fl:auth-ended' });
    },
  };
  return { win: win, localStorage: localStorage, server: server, FLState: win.FLState, acts: acts };
}
const keysOf = (w, acct) => w.localStorage.keys().filter(k => k.endsWith('::' + acct));

async function main() {
  const PLAN = 'fl_business_plan_v1', MODE = 'fl_bizplan_mode';

  section('1. the old unkeyed key migrates once, to the first known account, then is never read again');
  {
    const w = makeWorld();
    w.localStorage.setItem(PLAN, JSON.stringify({ mode: 'manual', sections: { exec: 'OLD DRAFT' } }));
    w.localStorage.setItem(MODE, 'manual');   // legacy raw string, not JSON
    eq(w.FLState.local(PLAN), null, 'signed out, the old plain copy is not shown');
    ok(w.localStorage.getItem(PLAN) != null, 'signed out, the plain copy is left for the migration');
    w.acts.signIn('uuid-a', 'a@example.test');
    const v = w.FLState.local(PLAN);
    eq(v && v.sections.exec, 'OLD DRAFT', 'first signed-in sight claims the plain copy for that account');
    eq(w.localStorage.getItem(PLAN), null, 'the plain name is deleted after the claim');
    ok(w.localStorage.getItem(PLAN + '::uuid-a') != null, 'the copy now lives under the account');
    eq(w.localStorage.getItem(w.FLState.storageKey(MODE)), 'manual', 'a raw-string legacy key migrates through storageKey()');
    eq(w.localStorage.getItem(MODE), null, 'and its plain name is deleted too');
    // stale code writing the plain name again: deleted unread, never claimed
    w.localStorage.setItem(PLAN, JSON.stringify({ sections: { exec: 'STALE WRITER' } }));
    eq(w.FLState.local(PLAN).sections.exec, 'OLD DRAFT', 'a later plain copy is never read');
    eq(w.localStorage.getItem(PLAN), null, 'a later plain copy is deleted');
    w.acts.signOut();
    w.localStorage.setItem(PLAN, JSON.stringify({ sections: { exec: 'LEFT BEHIND' } }));
    w.acts.signIn('uuid-b', 'b@example.test');
    eq(w.FLState.local(PLAN), null, 'a plain copy appearing after the one-time claim is not given to the next account');
    eq(w.localStorage.getItem(PLAN), null, 'it is deleted');
  }

  section('2. the register sequence: A types, signs out; B sees nothing and saves only B; A signs in and has the draft back');
  {
    const w = makeWorld();
    w.acts.signIn('uuid-a', 'a@example.test');
    w.FLState.save('business_plan', PLAN, { mode: 'manual', sections: { exec: 'PERSON-A TEXT' } });
    eq(w.FLState.local(PLAN).sections.exec, 'PERSON-A TEXT', 'A sees A\'s own copy at once');
    w.FLState.flush(); await tick();
    eq(w.server.rows['uuid-a'].business_plan.sections.exec, 'PERSON-A TEXT', 'A\'s draft reached A\'s account');
    ok(keysOf(w, 'uuid-a').length >= 1, 'the browser holds A\'s copy under A');

    w.acts.signOut();
    eq(keysOf(w, 'uuid-a').length, 0, 'sign-out removes every browser copy of A\'s');
    eq(w.localStorage.getItem('fl_state_owner_v1'), null, 'sign-out forgets whose copies the browser held');

    w.acts.signIn('uuid-b', 'b@example.test');
    eq(w.FLState.local(PLAN), null, 'B\'s first paint shows nothing of A\'s');
    const rb = await w.FLState.load('business_plan', PLAN);
    eq(rb.value, null, 'the server has no row for B and nothing of A\'s is painted');
    eq(rb.source, 'none', 'honest source for B');
    w.FLState.save('business_plan', PLAN, { mode: 'manual', sections: { team: 'person B types one line' } });
    w.FLState.flush(); await tick();
    const bRow = w.server.rows['uuid-b'].business_plan;
    eq(bRow.sections.exec, undefined, 'B\'s account never receives A\'s text');
    eq(bRow.sections.team, 'person B types one line', 'B\'s own line is saved to B');
    eq(w.server.rows['uuid-a'].business_plan.sections.exec, 'PERSON-A TEXT', 'A\'s row is untouched');

    w.acts.signOut();
    eq(keysOf(w, 'uuid-b').length, 0, 'B\'s sign-out removes B\'s copies');
    w.acts.signIn('uuid-a', 'a@example.test');
    eq(w.FLState.local(PLAN), null, 'A\'s browser copy was cleared at A\'s sign-out');
    const ra = await w.FLState.load('business_plan', PLAN);
    eq(ra.source, 'server', 'A\'s draft comes from the server');
    eq(ra.value.sections.exec, 'PERSON-A TEXT', 'A\'s draft is back');
    eq(ra.value.sections.team, undefined, 'and carries nothing of B\'s');
    eq(w.FLState.local(PLAN).sections.exec, 'PERSON-A TEXT', 'mirrored into A\'s own bucket again');
  }

  section('3. a sign-out nobody heard is noticed at the next call, and at the next page load');
  {
    const w = makeWorld();
    w.acts.signIn('uuid-a', 'a@example.test');
    w.FLState.setLocal('fl_reno_estimate_v1', { estimates: [{ id: 1, total: 5000 }] });
    w.acts.signOutSilently();
    ok(w.localStorage.getItem('fl_reno_estimate_v1::uuid-a') != null, 'nothing heard yet: the copy is still there');
    eq(w.FLState.local('fl_reno_estimate_v1'), null, 'the next call sees nobody signed in and an empty bucket');
    eq(w.localStorage.getItem('fl_reno_estimate_v1::uuid-a'), null, 'and A\'s copy is gone');

    const w2 = makeWorld();
    w2.acts.signIn('uuid-a', 'a@example.test');
    w2.FLState.setLocal('fl_buybox_v1', { target: 95000 });
    w2.acts.signOutSilently();
    const reloaded = makeWorld(w2.localStorage);   // fresh fl-state.js over the same browser storage
    eq(reloaded.localStorage.getItem('fl_buybox_v1::uuid-a'), null, 'a fresh page load clears the ended account\'s copies');
    eq(reloaded.FLState.local('fl_buybox_v1'), null, 'and shows nothing');
  }

  section('4. a session that ends on a failed refresh (fl_auth_ended) clears the copies too');
  {
    const w = makeWorld();
    w.acts.signIn('uuid-a', 'a@example.test');
    w.FLState.setLocal('fl_jurisdiction_v1', { state: 'Texas' });
    w.acts.sessionEnds('a@example.test');
    eq(keysOf(w, 'uuid-a').length, 0, 'fl:auth-ended clears A\'s copies');
  }

  section('5. an edit typed as A is never sent under B\'s token');
  {
    const w = makeWorld();
    w.acts.signIn('uuid-a', 'a@example.test');
    w.FLState.save('business_plan', PLAN, { sections: { exec: 'A LAST WORDS' } });   // PUT debounced, pending
    w.acts.signOut(); w.acts.signIn('uuid-b', 'b@example.test');
    w.FLState.flush(); await tick();
    eq(w.server.rows['uuid-b'], undefined, 'flush after the switch sends nothing under B');
    eq(w.server.puts.length, 0, 'no PUT went out at all');

    const w2 = makeWorld();
    w2.acts.signIn('uuid-a', 'a@example.test');
    w2.FLState.save('business_plan', PLAN, { sections: { exec: 'A LAST WORDS' } });
    w2.acts.signOutSilently(); w2.localStorage.setItem('fl_auth_token', jwt('uuid-b', 'b@example.test'));   // unheard switch
    await sleep(900);   // the debounce timer fires
    eq(w2.server.puts.length, 0, 'the debounced PUT is dropped when the account changed underneath it');
  }

  section('6. the signed-out bucket is nobody\'s: separate from every account, under no plain name');
  {
    const w = makeWorld();
    w.FLState.setLocal('fl_buybox_v1', { target: 90000 });
    eq(w.FLState.local('fl_buybox_v1').target, 90000, 'signed out, the device copy round-trips');
    ok(w.localStorage.getItem('fl_buybox_v1::anon') != null, 'under the anon bucket');
    eq(w.localStorage.getItem('fl_buybox_v1'), null, 'never under the plain name');
    w.acts.signIn('uuid-b', 'b@example.test');
    eq(w.FLState.local('fl_buybox_v1'), null, 'a signed-in person does not see the signed-out copy');
    w.FLState.setLocal('fl_buybox_v1', { target: 1 });
    w.acts.signOut();
    eq(w.FLState.local('fl_buybox_v1').target, 90000, 'the signed-out copy is still the signed-out copy');
  }

  section('7. the account id: the token\'s sub, else the lower-cased email; the suffix follows it');
  {
    const w = makeWorld();
    eq(w.FLState.account(), null, 'nobody signed in');
    eq(w.FLState.suffix(), '::anon', 'anon suffix');
    w.acts.signIn('uuid-a', 'A@Example.TEST');
    eq(w.FLState.account(), 'uuid-a', 'the JWT sub');
    eq(w.FLState.suffix(), '::uuid-a', 'suffix is the sub');
    eq(w.FLState.storageKey('tcc_tile_settings::financials::ech'), 'tcc_tile_settings::financials::ech::uuid-a', 'storageKey appends the suffix');
    w.localStorage.setItem('fl_auth_token', 'not.a-jwt.at-all');
    eq(w.FLState.account(), 'a@example.test', 'an undecodable token falls back to the email, lower-cased');
  }

  section('8. a server answer that arrives after the person changed is not painted or mirrored as the newcomer\'s');
  {
    const w = makeWorld();
    w.acts.signIn('uuid-a', 'a@example.test');
    let release = null;
    w.win.flTileState.get = () => new Promise(r => { release = r; });
    const p = w.FLState.load('business_plan', PLAN);
    w.acts.signOut(); w.acts.signIn('uuid-b', 'b@example.test');
    release({ ok: true, status: 200, data: { state: { sections: { exec: 'A SERVER TEXT' } } } });
    const r = await p;
    eq(r.value, null, 'A\'s late answer is not handed to B');
    eq(w.localStorage.getItem(PLAN + '::uuid-b'), null, 'and not mirrored into B\'s bucket');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
