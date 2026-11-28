#!/usr/bin/env node
/* tests/td267_refresh.test.js — TD-267: one REFRESH click with an expired token sent two token-refresh
   requests. The fix is ONE shared in-flight refresh in shared/fl-auth.js, and a 401 path in shared/fl-api.js
   that does not refresh again when a refresh already replaced the token while the request was out.

   Plain node, no framework, no network:   node tests/td267_refresh.test.js     (exit 1 on any failure)

   The two real scripts are loaded into a fake window (vm) with a fake localStorage and a fake fetch that
   counts every refresh POST and every API call, and answers them on demand so concurrency is deterministic.
   Nothing here touches the real sign-in service or the real API; every key and token below is made up. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'fl-auth.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'fl-api.js'), 'utf8');

const AUTH_URL = 'https://auth.example.test';          // fake sign-in service
const API_URL = 'https://api.example.test';            // fake FL API
const REFRESH_PATH = AUTH_URL + '/auth/v1/token?grant_type=refresh_token';

/* ── one fresh window per scenario ── */
function makeWindow() {
  const store = new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
  const net = {
    refreshes: 0,            // refresh POSTs sent to the sign-in service
    refreshBodies: [],       // their JSON bodies ({ refresh_token })
    apiCalls: [],            // every API request: { path, token }
    refreshMode: 'ok',       // 'ok' = answer at once · 'defer' = hold until release() · 'fail-500' = server error · 'refuse-401' = session over
    nextToken: 'T2',         // what the next successful refresh mints
    deferred: [],            // held answers; release() lets them all through
    // (call) => { status, body, defer? } — how the API answers a request carrying call.token
    api: () => ({ status: 200, body: { ok: true } }),
    release() { this.deferred.splice(0).forEach((fn) => fn()); },
  };
  function response(status, body) {
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  }
  function fetch(url, opts) {
    opts = opts || {};
    if (url === REFRESH_PATH) {
      net.refreshes += 1;
      net.refreshBodies.push(JSON.parse(opts.body));
      const answer = () => (net.refreshMode === 'fail-500' ? response(500, {})
        : net.refreshMode === 'refuse-401' ? response(401, { error: 'invalid_grant' })
        : response(200, { access_token: net.nextToken, refresh_token: 'R-' + net.nextToken, expires_in: 3600 }));
      if (net.refreshMode === 'defer') return new Promise((res) => net.deferred.push(() => res(answer())));
      return Promise.resolve(answer());
    }
    // The fake API answers only requests whose parsed origin IS the API origin (a substring test would
    // also match 'https://api.example.test.evil' — CodeQL js/incomplete-url-substring-sanitization).
    if (new URL(url).origin === new URL(API_URL).origin) {
      const auth = String((opts.headers || {}).Authorization || '');
      const call = { path: url.slice(API_URL.length), token: auth.replace(/^Bearer /, '') };
      net.apiCalls.push(call);
      const a = net.api(call);
      if (a.defer) return new Promise((res) => net.deferred.push(() => res(response(a.status, a.body))));
      return Promise.resolve(response(a.status, a.body));
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  }
  // the tiniest FormData the upload path needs
  class FormData { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } }

  // real timers and AbortController by default (the refresh timeout arms one per request and clears it on settle);
  // the timeout scenario swaps in fake timers it fires by hand
  const w = { localStorage, fetch, FormData, console, setTimeout, clearTimeout, AbortController,
              FL_SUPABASE: { url: AUTH_URL, anon: 'anon-test-key' }, FL_API_BASE: API_URL };
  w.window = w;                                        // the scripts read window.* and bare globals alike
  vm.createContext(w);
  vm.runInContext(AUTH_SRC, w, { filename: 'shared/fl-auth.js' });
  vm.runInContext(API_SRC, w, { filename: 'shared/fl-api.js' });
  return { w, store, net };
}
// a signed-in session whose access token is T1; expired = past its hour (needsRefresh() true)
function seedSession(store, { expired }) {
  store.set('fl_auth_token', 'T1');
  store.set('fl_auth_refresh', 'R1');
  store.set('fl_auth_exp', String(Date.now() + (expired ? -1000 : 3600 * 1000)));
  store.set('fl_auth_email', 'someone@example.test');
}
const tick = () => new Promise((r) => setImmediate(r));

/* ── the tiniest test runner ── */
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok    ' + name); }
  else { failed += 1; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
async function scenario(title, fn) {
  console.log(title);
  try { await fn(); }
  catch (e) { failed += 1; console.log('  FAIL  threw: ' + (e && e.stack || e)); }
}

(async () => {
  await scenario('(1) five concurrent refresh() calls -> exactly one refresh request', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.refreshMode = 'defer';
    const ps = [1, 2, 3, 4, 5].map(() => w.flAuth.refresh());
    check('one refresh POST went out while five calls are pending', net.refreshes === 1, 'sent ' + net.refreshes);
    check('all five callers hold the same promise', ps.every((p) => p === ps[0]));
    net.release();
    const results = await Promise.all(ps);
    check('all five resolve true', results.every((r) => r === true), JSON.stringify(results));
    check('still exactly one refresh request after they settle', net.refreshes === 1, 'sent ' + net.refreshes);
    check('the stored token is the refreshed one', store.get('fl_auth_token') === 'T2');
    check('the refresh token sent was the stored one', net.refreshBodies[0].refresh_token === 'R1');
    // the slot is emptied when the request settles: the next ask starts a fresh one
    net.refreshMode = 'ok'; net.nextToken = 'T3';
    check('a later refresh() starts a new request', (await w.flAuth.refresh()) === true && net.refreshes === 2, 'sent ' + net.refreshes);
    check('and stores its token', store.get('fl_auth_token') === 'T3');
  });

  await scenario('(2) one authedCallX with an expired token -> one refresh, one API call (with the new token)', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.api = (c) => (c.token === 'T2' ? { status: 200, body: { figures: 1 } } : { status: 401, body: {} });
    const r = await w.flApi.callX('GET', '/api/dashboard/scoped');
    check('exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('exactly one API request', net.apiCalls.length === 1, 'sent ' + net.apiCalls.length);
    check('it carried the refreshed token', net.apiCalls[0] && net.apiCalls[0].token === 'T2', JSON.stringify(net.apiCalls));
    check('and the call succeeded', r.ok === true && r.status === 200 && r.data && r.data.figures === 1, JSON.stringify(r));
  });

  await scenario('(2b) the REFRESH click: two concurrent reads with an expired token -> one refresh, two API calls', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.api = (c) => (c.token === 'T2' ? { status: 200, body: { ok: 1 } } : { status: 401, body: {} });
    // forceRefresh(): fetchAll() reads the figures and recheckAccess() reads the access, in the same tick
    const [a, b] = await Promise.all([
      w.flApi.callX('GET', '/api/dashboard/scoped'),
      w.flApi.callX('GET', '/api/entities'),
    ]);
    check('exactly one refresh request for the click', net.refreshes === 1, 'sent ' + net.refreshes);
    check('two API requests, one per read', net.apiCalls.length === 2, 'sent ' + net.apiCalls.length);
    check('both carried the refreshed token', net.apiCalls.every((c) => c.token === 'T2'), JSON.stringify(net.apiCalls));
    check('both reads succeeded', a.ok && b.ok);
  });

  await scenario('(3) a plain 401 with a fresh token -> exactly one refresh, then one retry', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: false });
    net.api = (c) => (c.token === 'T1' ? { status: 401, body: {} } : { status: 200, body: { ok: 1 } });
    const r = await w.flApi.callX('GET', '/api/team');
    check('exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('two API requests: the 401 and one retry', net.apiCalls.length === 2, 'sent ' + net.apiCalls.length);
    check('the retry carried the refreshed token', net.apiCalls[1] && net.apiCalls[1].token === 'T2', JSON.stringify(net.apiCalls));
    check('and the call succeeded', r.ok === true && r.status === 200);
  });

  await scenario('(4) a 401 on a token a refresh has already replaced -> retry with the new token, NO second refresh', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: false });
    // the request carrying T1 is held; meanwhile someone else's refresh lands and the stored token becomes T2
    net.api = (c) => (c.token === 'T1' ? { status: 401, body: {}, defer: true } : { status: 200, body: { ok: 1 } });
    const p = w.flApi.callX('GET', '/api/records');
    await tick();
    check('the request went out with T1', net.apiCalls.length === 1 && net.apiCalls[0].token === 'T1');
    check('another caller refreshes meanwhile', (await w.flAuth.refresh()) === true && store.get('fl_auth_token') === 'T2');
    net.release();                                        // now the 401 for T1 arrives
    const r = await p;
    check('no second refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('one retry, carrying T2', net.apiCalls.length === 2 && net.apiCalls[1].token === 'T2', JSON.stringify(net.apiCalls));
    check('and the call succeeded', r.ok === true && r.status === 200);
  });

  await scenario('(5) the upload path shares the same seam', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.api = (c) => (c.token === 'T2' ? { status: 200, body: { id: 'doc1' } } : { status: 401, body: {} });
    const r = await w.flDocuments.upload({ name: 'a.pdf' }, { kind: 'loan' });
    check('exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('one upload request, carrying the refreshed token', net.apiCalls.length === 1 && net.apiCalls[0].token === 'T2', JSON.stringify(net.apiCalls));
    check('and it succeeded', r.ok === true && r.data && r.data.id === 'doc1');
  });

  await scenario('(6) the "refresh token changed meanwhile" guard still holds', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.refreshMode = 'defer';
    const p = w.flAuth.refresh();
    // another window signed in / refreshed: storage now holds a different session
    store.set('fl_auth_token', 'T-other'); store.set('fl_auth_refresh', 'R-other');
    net.release();
    const ok = await p;
    check('the stale answer is not written over the newer session', store.get('fl_auth_token') === 'T-other' && store.get('fl_auth_refresh') === 'R-other');
    check('and refresh() reports the live token', ok === true);
  });

  await scenario('(7) a failed refresh empties the slot and keeps the session', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.refreshMode = 'fail-500';
    const first = await w.flAuth.refresh();
    const second = await w.flAuth.refresh();
    check('both answer false', first === false && second === false);
    check('the second ask sent its own request', net.refreshes === 2, 'sent ' + net.refreshes);
    check('a 500 is not a verdict: the session is kept', store.get('fl_auth_token') === 'T1' && store.get('fl_auth_refresh') === 'R1');
    check('and it is not marked ended', w.flAuth.expired() === false);
  });

  await scenario('(8) a refused proactive refresh (401) ends the session once, through the shared request', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.refreshMode = 'refuse-401';                       // the sign-in service refuses the refresh token
    const [a, b] = await Promise.all([w.flApi.callX('GET', '/api/dashboard/scoped'), w.flApi.callX('GET', '/api/entities')]);
    check('exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('no API request went out without a token', net.apiCalls.length === 0, JSON.stringify(net.apiCalls));
    check('both reads report no session', a.status === 0 && b.status === 0 && !a.ok && !b.ok);
    check('the session is cleared and marked ended', !store.has('fl_auth_token') && w.flAuth.expired() === true);
  });

  await scenario('(9) a refused reactive refresh: fresh token, API 401, sign-in service 401 -> the 401 is returned', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: false });
    net.api = () => ({ status: 401, body: { detail: 'token revoked' } });
    net.refreshMode = 'refuse-401';
    const r = await w.flApi.callX('GET', '/api/team');
    check('exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('one API request, no retry (nothing to retry with)', net.apiCalls.length === 1, 'sent ' + net.apiCalls.length);
    check('the 401 is returned as it is', r.ok === false && r.status === 401 && r.data && r.data.detail === 'token revoked', JSON.stringify(r));
    check('the session is cleared and marked ended', !store.has('fl_auth_token') && w.flAuth.expired() === true);
  });

  await scenario('(10) five waiters on a refresh the sign-in service refuses all get false', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    net.refreshMode = 'defer';
    const ps = [1, 2, 3, 4, 5].map(() => w.flAuth.refresh());
    check('one refresh request for five waiters', net.refreshes === 1, 'sent ' + net.refreshes);
    net.refreshMode = 'refuse-401';
    net.release();
    const results = await Promise.all(ps);
    check('all five resolve false', results.every((r) => r === false), JSON.stringify(results));
    check('still exactly one refresh request', net.refreshes === 1, 'sent ' + net.refreshes);
    check('the session is cleared and marked ended once', !store.has('fl_auth_token') && !store.has('fl_auth_refresh') && w.flAuth.expired() === true);
  });

  await scenario('(11) a refresh that never answers times out: false, slot emptied, the next ask sends a new request', async () => {
    const { w, store, net } = makeWindow();
    seedSession(store, { expired: true });
    // fake timers the scenario fires by hand, so the 15 s timeout costs no wall-clock time
    const timers = [];
    w.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
    w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
    const fire = () => { const t = timers.find((x) => x.live); t.live = false; t.fn(); };
    // a sign-in service that never answers: the request settles only when its signal aborts
    w.fetch = (url, opts) => {
      if (url !== REFRESH_PATH) return Promise.reject(new Error('unexpected fetch ' + url));
      net.refreshes += 1;
      return new Promise((_, rej) => {
        opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    };
    const p = w.flAuth.refresh();
    const q = w.flAuth.refresh();
    check('one request went out, shared by both asks', net.refreshes === 1 && p === q, 'sent ' + net.refreshes);
    check('a timeout of at most 15 s is armed', timers.length === 1 && timers[0].live && timers[0].ms <= 15000, JSON.stringify(timers.map((t) => t.ms)));
    fire();
    const raced = await Promise.race([p, new Promise((r) => setTimeout(() => r('still hung'), 2000))]);
    check('refresh() resolves false once the timeout fires', raced === false, String(raced));
    check('the timeout is a verdict on nothing: the session is kept', store.get('fl_auth_token') === 'T1' && store.get('fl_auth_refresh') === 'R1' && w.flAuth.expired() === false);
    const again = w.flAuth.refresh();
    check('a second refresh() afterwards sends a new request', net.refreshes === 2 && again !== p, 'sent ' + net.refreshes);
    fire();
    check('and it too resolves false on its own timeout', (await again) === false);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
