/* ════════════════════════════════════════════════════════════════
   TCC — Platform v1 · CORE
   Generic. Reads config/tenant.json + config/layers.json and renders
   the home from the registry. ZERO tenant specifics live in this file —
   everything ECH-flavored is in the config + the /layers folders.

   Add a layer = drop a folder in /layers/ + add one entry to
   config/layers.json. No edit here. (See /layers/_TEMPLATE/README.md.)
   ════════════════════════════════════════════════════════════════ */

/* ── PWA ──
   Register the offline-shell service worker in production. On localhost we
   SKIP it (and unregister any prior dev SW) so local edits are never served
   stale from the cache-first SW. */
if ('serviceWorker' in navigator) {
  const isLocal = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
  if (isLocal) {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  } else {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}

/* ── tiny helpers ── */
const $ = (id) => document.getElementById(id);
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pct(v){ if (v==null||isNaN(v)) return '—'; const r = Math.round(Number(v)*100)/100; return (Number.isInteger(r) ? r : parseFloat(r.toFixed(2))) + '%'; }
function fmtMoney(n){
  if (n===null||n===undefined||n===''||isNaN(n)) return '—';
  n = Number(n); const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toLocaleString('en-US');
}
function fmtTs(iso){
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return String(iso);
  return dt.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}) ;
}
function isStale(ts, hours){ if(!ts) return false; const t=new Date(ts).getTime(); if(isNaN(t)) return false; return (Date.now()-t) > (hours||48)*3600*1000; }
function timeOfDay(){ const h=new Date().getHours(); return h<12?'morning':h<17?'afternoon':'evening'; }

/* ── runtime state ── */
const STATE = {
  tenant: null,
  registry: null,
  county: null,
  data:   { fl:null, reventure:null, census:null, dealcheck:null, fred:null },
  status: { fl:'pending' },         // 'pending' | 'ok' | 'down'
  lastGoodKey: 'tcc_fl_last_success'
};

/* ════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════ */
async function boot(){
  try {
    const [tenant, registry] = await Promise.all([
      fetch('./config/tenant.json', {cache:'no-store'}).then(r=>r.json()),
      fetch('./config/layers.json', {cache:'no-store'}).then(r=>r.json())
    ]);
    STATE.tenant = tenant;
    STATE.registry = registry;
  } catch(e){
    $('home').innerHTML = '<div class="note" style="color:var(--red)">Could not load the layer registry (config/*.json). The home renders from these files — check they are present.</div>';
    return;
  }
  applyBranding();
  // Login gates the app (productized). If no session, show the light sign-in.
  if (!Auth.session()) { renderLoginGate(); return; }
  startApp();
}

function startApp(){
  const s = Auth.session();
  STATE.user = s;
  STATE.role = s.role || 'owner';
  STATE.scope = s.scope || null;                 // field role → a single layer id
  if (STATE.tenant) STATE.tenant.current_role = STATE.role;
  if (window.Agents) Agents.init(STATE);         // global TARS + per-layer employees + memory store
  renderChrome();
  renderHome();
  fetchAll();
  wireGlobalControls();
}

function applyBranding(){
  const b = (STATE.tenant.branding)||{};
  if (b.accent) document.documentElement.style.setProperty('--accent', b.accent);
  document.title = (b.title? b.title+' ' : '') + 'Command Center';
}

/* ════════════════════════════════════════════════════════════════
   AUTH (light, plug-and-play — magic-link / simple sign-in).
   Honest: this is a CLIENT-SIDE demo gate for the static build; real
   verification wires to Foundation Layer Supabase / a magic-link backend
   at production. Session is per-browser.
   ════════════════════════════════════════════════════════════════ */
const AUTH_KEY = 'tcc_session';
const Auth = {
  session(){ try { return JSON.parse(localStorage.getItem(AUTH_KEY)||'null'); } catch(e){ return null; } },
  signIn(sess){ try { localStorage.setItem(AUTH_KEY, JSON.stringify(sess)); } catch(e){} },
  signOut(){ try { localStorage.removeItem(AUTH_KEY); } catch(e){} }
};

/* ── entitlement: registry flag OR a tenant purchase override (Plans & Billing) ── */
const ENT_KEY = 'tcc_entitlements';
const Entitlement = {
  overrides(){ try { return JSON.parse(localStorage.getItem(ENT_KEY)||'{}'); } catch(e){ return {}; } },
  has(id){ return this.overrides()[id] === true; },
  grant(id){ const o=this.overrides(); o[id]=true; try{ localStorage.setItem(ENT_KEY, JSON.stringify(o)); }catch(e){} },
  isEntitled(l){ return l.entitled !== false || this.has(l.id); }
};

/* ── enabled + entitlement + role-scope filter (the licensing/role boundary) ── */
function visibleLayers(){
  let ls = (STATE.registry.layers||[]).filter(l => l.enabled !== false && Entitlement.isEntitled(l));
  // Field role: scoped to ONE layer/job. Read-only/Owner/Admin see all entitled layers.
  if (STATE.role === 'field' && STATE.scope) ls = ls.filter(l => l.id === STATE.scope);
  return ls;
}
function layersInGroup(g){ return visibleLayers().filter(l => l.group === g); }
function layerById(id){ return (STATE.registry.layers||[]).find(l => l.id === id); }

/* ════════════════════════════════════════════════════════════════
   CHROME (verbar, global TARS button, header, AI summary, footer)
   ════════════════════════════════════════════════════════════════ */
function renderChrome(){
  // source ribbon — distinct source tags present in the registry
  const tags = [];
  visibleLayers().forEach(l => { if (l.source_tag && !tags.includes(l.source_tag)) tags.push(l.source_tag); });
  if (!tags.includes('FL')) tags.unshift('FL');
  const pillCls = { FRED:'src-fred', REV:'src-rev', CEN:'src-cen', DEALCHECK:'src-dc', FL:'src-fl' };
  $('verbar').innerHTML = '<b>PLATFORM v1</b>' +
    tags.map(t => '<span class="srcpill '+(pillCls[t]||'src-fl')+'">'+esc(t)+'</span>').join('');

  // global TARS button — pinned at top; hidden for the scoped Field role
  const g = STATE.tenant.global_agent || {};
  const tarsBtn = $('tars-btn');
  if (STATE.role === 'field'){
    tarsBtn.style.display = 'none';
  } else {
    tarsBtn.style.display = '';
    tarsBtn.innerHTML =
      '<span class="tarsav">'+tarsSvg(26)+'</span>'+
      '<span class="tarstxt"><b>Ask '+esc(g.name||'TARS')+'</b><span>'+esc(g.tagline||'your on-call AI employee')+'</span></span>'+
      '<span style="margin-left:auto;color:var(--purple);font-size:18px">▸</span>';
  }

  // header + account chip (name · role · sign out)
  const op = (STATE.tenant.operator)||{};
  const b = (STATE.tenant.branding)||{};
  const u = STATE.user || {};
  const roleLabel = { owner:'Owner', admin:'Admin', staff:'Staff', viewer:'Read-only', tenant:'Tenant', field:'Field' }[STATE.role] || STATE.role;
  const now = new Date();
  $('head').innerHTML =
    '<h1>'+esc(b.title||STATE.tenant.name||'')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h1>'+
    '<div class="when"><b>'+now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+'</b>'+
    timeOfDay()+(u.name?' · '+esc(u.name):'')+
    '<div class="acct">'+esc(roleLabel)+(STATE.role==='field'&&STATE.scope?' · '+esc((layerById(STATE.scope)||{}).title||STATE.scope):'')+
    ' · <button type="button" id="signout-btn">sign out</button></div></div>';
  $('signout-btn').onclick = () => { Auth.signOut(); location.reload(); };

  // AI summary (static for v1 — honest)
  const ai = STATE.tenant.ai_summary || {};
  if (ai.enabled){
    $('ai-summary').innerHTML =
      '<div class="ttl"><div class="l"><span class="dot"></span> STATE · AI SUMMARY</div>'+
      '<button class="toggle" id="ai-toggle" type="button">AI: ON</button></div>'+
      '<p id="aitxt">'+esc(ai.text||'')+'</p>'+
      (ai.live ? '' : '<div class="src-note">'+esc(ai.note||'Static for v1 — not a live model call.')+'</div>');
    $('ai-toggle').onclick = () => { const p=$('aitxt'); p.style.display = p.style.display==='none'?'block':'none'; };
  } else { $('ai-summary').style.display='none'; }

  // footer
  $('foot').innerHTML = 'TCC · PLATFORM v1 · tenant: '+esc(STATE.tenant.name||'')+
    (STATE.tenant.reference_install?' (reference install)':'')+'<br>layers render from the registry · honest display always';
}

/* ════════════════════════════════════════════════════════════════
   LOGIN GATE — light, plug-and-play. Default path = magic link.
   "Advanced / demo roles" lets you sign in as Admin / Read-only / Field
   (Field picks a single layer/job it is scoped to).
   ════════════════════════════════════════════════════════════════ */
function deriveName(contact, role){
  if (role==='owner') return (STATE.tenant.operator && STATE.tenant.operator.greeting_name) || 'Owner';
  if (contact && contact.indexOf('@')>0) return contact.split('@')[0];
  return ({admin:'Staff', viewer:'Viewer', field:'Field user', tenant:'Tenant'})[role] || 'User';
}
function renderLoginGate(){
  const b = (STATE.tenant.branding)||{};
  const scopeOpts = (STATE.registry.layers||[]).filter(l => l.drilldown)
    .map(l => '<option value="'+esc(l.id)+'">'+esc(l.title)+'</option>').join('');
  const el = document.createElement('div');
  el.className = 'gate'; el.id = 'login-gate';
  el.innerHTML =
    '<div class="gate-card">'+
      '<div class="gate-logo"><span class="tarsav" style="width:54px;height:54px">'+tarsSvg(32)+'</span></div>'+
      '<h2>'+esc(b.title||STATE.tenant.name||'TARS')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h2>'+
      '<p class="gate-sub">Sign in to your command center.</p>'+
      '<label>Email or phone</label>'+
      '<input id="gate-id" placeholder="you@company.com  ·  or  +1 555…" autocomplete="username">'+
      '<button class="gate-btn primary" type="button" id="gate-send">Send magic link</button>'+
      '<div id="gate-sent" style="display:none">'+
        '<div class="gate-note ok" id="gate-sent-msg">✓ Magic link sent (demo — no real email/SMS). Tap continue to sign in.</div>'+
        '<button class="gate-btn primary" type="button" id="gate-continue">Continue →</button>'+
      '</div>'+
      '<button class="gate-link" type="button" id="gate-adv-toggle">Advanced / demo roles</button>'+
      '<div id="gate-adv" style="display:none">'+
        '<label>Role</label>'+
        '<select id="gate-role"><option value="owner">Owner (full)</option><option value="admin">Admin / Staff</option><option value="viewer">Read-only / Viewer</option><option value="field">Field (one job)</option></select>'+
        '<div id="gate-scope-wrap" style="display:none"><label>Field scope — one layer/job</label><select id="gate-scope">'+scopeOpts+'</select></div>'+
      '</div>'+
      '<a class="gate-link" href="./onboarding/" style="display:inline-block;margin-top:6px">New here? Get set up →</a>'+
      '<div class="gate-note">Light, plug-and-play sign-in. Real verification (Supabase / magic-link) wires at production — this build uses a local demo session.</div>'+
    '</div>';
  document.body.appendChild(el);

  const idInput = el.querySelector('#gate-id');
  const role = el.querySelector('#gate-role');
  el.querySelector('#gate-adv-toggle').onclick = () => { const a=el.querySelector('#gate-adv'); a.style.display = a.style.display==='none'?'block':'none'; };
  role.onchange = () => { el.querySelector('#gate-scope-wrap').style.display = role.value==='field'?'block':'none'; };
  function doSignIn(){
    const contact = (idInput.value||'').trim();
    const r = role.value || 'owner';
    const sess = {
      name: deriveName(contact, r), role: r,
      tenant: STATE.tenant.tenant_id || 'ech',
      contact: contact || null,
      scope: r==='field' ? (el.querySelector('#gate-scope').value || null) : null,
      at: new Date().toISOString()
    };
    Auth.signIn(sess);
    el.remove();
    startApp();
  }
  el.querySelector('#gate-send').onclick = () => {
    const r = role.value;
    el.querySelector('#gate-sent-msg').innerHTML = r==='field'
      ? '✓ Sign-in code sent to your phone/email (demo). Tap continue — you’ll land scoped to one job.'
      : '✓ Magic link sent (demo — no real email/SMS). Tap continue to sign in.';
    el.querySelector('#gate-sent').style.display='block';
  };
  el.querySelector('#gate-continue').onclick = doSignIn;
  idInput.addEventListener('keydown', e => { if (e.key==='Enter') el.querySelector('#gate-send').click(); });
}

function tarsSvg(s){
  return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="7" r="3.6" fill="#0a0a0b"/><path d="M4.5 21c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" fill="#0a0a0b"/><circle cx="12" cy="7" r="3.6" stroke="#0a0a0b"/></svg>';
}

/* ════════════════════════════════════════════════════════════════
   HOME — groups + tiles
   ════════════════════════════════════════════════════════════════ */
function groupDef(id){ return (STATE.registry.groups||[]).find(g => g.id === id) || { id, render:'card' }; }
function collapsedSet(){ try { return new Set(JSON.parse(localStorage.getItem('tcc_collapsed')||'[]')); } catch(e){ return new Set(); } }

function renderHome(){
  const groups = STATE.registry.groups || [];
  const collapsed = collapsedSet();
  let html = '';
  let firstCard = true;
  groups.forEach(grp => {
    const ls = layersInGroup(grp.id);
    if (!ls.length) return;
    let body;
    if (grp.id === 'market')           body = renderMarketGroup(ls);
    else if (grp.render === 'card')  { body = renderCardGroup(ls, firstCard); firstCard = false; }
    else                               body = '<div class="grid2">'+ls.map(tileShell).join('')+'</div>'; // glance (overview)
    const isCol = collapsed.has(grp.id);
    html += '<section class="grp'+(isCol?' collapsed':'')+'" data-group="'+esc(grp.id)+'">'+
      '<button type="button" class="grp-head" data-grp="'+esc(grp.id)+'">'+
      '<span class="grp-label">'+esc(grp.label||grp.id)+'</span><span class="grp-chev">▾</span></button>'+
      '<div class="grp-body">'+body+'</div></section>';
  });
  $('home').innerHTML = html;
  // initial paint of data-bound tiles (skeleton → fills when data lands)
  refreshDataTiles();
  bindTileClicks();
  bindMarketPicker();
  bindGroupHeaders();
}

function bindGroupHeaders(){
  document.querySelectorAll('.grp-head').forEach(h => {
    if (h.__bound) return; h.__bound = true;
    h.addEventListener('click', () => toggleGroup(h.getAttribute('data-grp')));
  });
}
function toggleGroup(id){
  const sec = document.querySelector('.grp[data-group="'+id+'"]'); if (!sec) return;
  sec.classList.toggle('collapsed');
  const set = collapsedSet();
  if (sec.classList.contains('collapsed')) set.add(id); else set.delete(id);
  try { localStorage.setItem('tcc_collapsed', JSON.stringify([...set])); } catch(e){}
}

// a stable container for each tile so data can refresh it in place.
// (data-tile lives on the inner button rendered by renderTile, not the shell,
//  so a click binds/fires exactly once.)
function tileShell(l){ return '<div id="tile-'+esc(l.id)+'" class="tile-shell"></div>'; }

function renderCardGroup(ls, withCaption){
  const cap = withCaption ? '<div class="empcap">👤 Every layer has an on-call employee — open any tile and tap “Ask” to have it find, answer, or reshape the tile for you.</div>' : '';
  return cap + '<div class="gridA">'+ls.map(artTile).join('')+'</div>';
}

function artTile(l){
  const soon = l.status_rules === 'soon';
  const add  = l.kind === 'add';
  const cls = 'art'+(l.featured?' feat':'')+(soon||add?' disabled':'')+(add?' add':'');
  const corner = soon ? '<span class="soon">SOON</span>' : add ? '<span class="soon">+ ADD</span>' : (l.tier?'<span class="L">'+esc(l.tier)+'</span>':'');
  return '<button type="button" class="'+cls+'" data-tile="'+esc(l.id)+'">'+corner+
    '<div class="ico">'+esc(l.icon||'▫')+'</div>'+
    '<div class="nm">'+esc(l.title)+'</div>'+
    '<div class="ds">'+esc(l.desc||'')+'</div></button>';
}

/* ── MARKET group: county picker + market tiles + full-width Portfolio ── */
function renderMarketGroup(ls){
  const portfolio = ls.find(l => l.id === 'portfolio');
  const market = ls.filter(l => l.id !== 'portfolio');
  const picker = '<div class="pickrow"><select class="picker" id="county-picker"></select></div>';
  // split market value tiles: first 4 in a grid4, remainder in grid2 (mirrors the visual target)
  const top = market.slice(0,4), rest = market.slice(4);
  let h = picker + '<div class="grid4">'+top.map(tileShell).join('')+'</div>';
  if (rest.length) h += '<div class="grid2" style="margin-top:10px">'+rest.map(tileShell).join('')+'</div>';
  // gap explanation note (from the gap layer's note, if present)
  const gap = market.find(l => l.data && l.data.source==='vacancy_gap');
  if (gap && gap.note) h += '<div class="note" id="market-note"><b>Why two vacancy numbers?</b> '+esc(gap.note)+'</div>';
  // Portfolio (DealCheck) renders full-width under the market tiles
  if (portfolio) h += '<div style="margin-top:12px">'+tileShell(portfolio)+'</div>';
  return h;
}

function countyOptions(){
  // union of counties present in BOTH market files, so every market tile has a value
  const rev = STATE.data.reventure && STATE.data.reventure.counties || {};
  const cen = STATE.data.census && STATE.data.census.counties || {};
  const keys = Object.keys(rev).filter(k => cen[k]);
  return keys.map(k => ({ key:k, label: (rev[k] && rev[k].label) || (cen[k] && cen[k].label) || k }));
}

function bindMarketPicker(){
  const sel = $('county-picker'); if (!sel) return;
  const opts = countyOptions();
  if (!opts.length){ sel.innerHTML = '<option>loading…</option>'; sel.disabled = true; return; }
  if (!STATE.county || !opts.find(o=>o.key===STATE.county)){
    const def = (STATE.tenant.market && STATE.tenant.market.default_county) || opts[0].key;
    STATE.county = opts.find(o=>o.key===def) ? def : opts[0].key;
  }
  sel.disabled = false;
  sel.innerHTML = opts.map(o => '<option value="'+esc(o.key)+'"'+(o.key===STATE.county?' selected':'')+'>📍 '+esc(o.label)+'</option>').join('');
  sel.onchange = () => { STATE.county = sel.value; refreshDataTiles(); };
}

/* ════════════════════════════════════════════════════════════════
   TILE RENDERERS (read STATE → HTML; called on every data refresh)
   ════════════════════════════════════════════════════════════════ */
function refreshDataTiles(){
  visibleLayers().forEach(l => {
    if (groupDef(l.group).render === 'card') return;   // card tiles are static (rendered once)
    const el = $('tile-'+l.id); if (!el) return;
    el.innerHTML = renderTile(l);
  });
  // market picker may need (re)populating once data arrives
  if (!$('county-picker') || $('county-picker').disabled) bindMarketPicker();
  bindTileClicks();
}

function renderTile(l){
  switch (l.data && l.data.type){
    case 'fl_api':   return tileCapitalRules(l);
    case 'json_file':return tileJsonFile(l);
    case 'computed': return l.data.source==='system_health' ? tileSystem(l) : tileGap(l);
    default:         return tileGeneric(l);
  }
}

function badge(cls, txt){ return '<span class="badge '+cls+'">'+esc(txt)+'</span>'; }
function tileOpen(l){ return ' data-tile="'+esc(l.id)+'"'; }
function tileWrap(l, inner, linkable){
  const cls = 'tile'+(linkable?'':' nolink')+(l.accent?' accent-'+l.accent:'');
  return '<button type="button" class="'+cls+'"'+tileOpen(l)+'>'+inner+'</button>';
}

/* SYSTEM — health roll-up */
function tileSystem(l){
  const flUp = STATE.status.fl === 'ok';
  const flDown = STATE.status.fl === 'down';
  const nLayers = visibleLayers().length;
  let bcls='b-green', btxt='ALL GREEN', big='All green';
  if (flDown){ bcls='b-red'; btxt='ATTENTION'; big='1 source down'; }
  else if (STATE.status.fl==='pending'){ bcls='b-gray'; btxt='CHECKING'; big='Checking…'; }
  // sparkline from FL trend if present, else flat
  const trend = (STATE.data.fl && STATE.data.fl.trend_12_weeks) || [];
  const bars = (trend.length?trend.slice(-7):[0,0,0,0,0,0,0]).map((t,i)=>{
    const h = 30 + i*7; return '<i style="height:'+h+'%"></i>';
  }).join('');
  const liveSources = [STATE.data.reventure, STATE.data.census, flUp?true:null].filter(Boolean).length;
  const inner =
    '<div class="top"><span class="lbl">SYSTEM</span>'+badge(bcls,btxt)+'</div>'+
    '<div class="big'+(flDown?'':'')+'">'+esc(big)+'</div>'+
    '<div class="sub">'+nLayers+' layers · '+liveSources+' live sources</div>'+
    '<div class="spark">'+bars+'</div>';
  return tileWrap(l, inner, !!l.drilldown);
}

/* CAPITAL RULES — FL API */
function tileCapitalRules(l){
  const fl = STATE.data.fl;
  if (STATE.status.fl === 'down'){
    const inner = '<div class="top"><span class="lbl">CAPITAL RULES</span>'+badge('b-red','API DOWN')+'</div>'+
      '<div class="big muted">unreachable</div><div class="sub">last-good held · never faked</div>';
    return tileWrap(l, inner, !!l.drilldown);
  }
  if (!fl){ return tileWrap(l, '<div class="top"><span class="lbl">CAPITAL RULES</span>'+badge('b-gray','…')+'</div><div class="big muted">loading…</div>', !!l.drilldown); }
  const cr = fl.capital_rules || {};
  const keys = ['ltv','dscr','liquidity','per_door'];
  const statuses = keys.map(k => (cr[k]&&cr[k].status)||'UNKNOWN');
  let bcls, btxt, big;
  if (statuses.includes('RED')){ bcls='b-red'; btxt='BREACH'; big='Breach'; }
  else if (statuses.includes('YELLOW')){ bcls='b-yellow'; btxt='ATTENTION'; big='Attention'; }
  else if (statuses.every(s=>s==='GREEN')){ bcls='b-green'; btxt='PASSING'; big='Passing'; }
  else { bcls='b-gray'; btxt='STRUCTURE LIVE'; big='Pending'; }   // some UNKNOWN
  const nPend = statuses.filter(s=>s==='UNKNOWN').length;
  const sub = nPend ? ('LTV · DSCR · Liq · /door ('+nPend+' pending)') : 'LTV · DSCR · Liq · /door';
  const inner = '<div class="top"><span class="lbl">CAPITAL RULES</span>'+badge(bcls,btxt)+'</div>'+
    '<div class="big">'+esc(big)+'</div><div class="sub">'+esc(sub)+'</div>'+
    '<div class="stamp">FL API · '+esc(fmtTs(fl.generated_at))+'</div>';
  return tileWrap(l, inner, !!l.drilldown);
}

/* JSON-FILE tiles: portfolio (DealCheck), market (Reventure/Census/FRED) */
function tileJsonFile(l){
  const sel = l.data.select;
  // market county-keyed (Reventure / Census)
  if (l.data.county_keyed){
    const src = l.data.source.indexOf('REVENTURE')>-1 ? STATE.data.reventure
             : l.data.source.indexOf('CENSUS')>-1   ? STATE.data.census : null;
    return tileMarketValue(l, src);
  }
  // FRED (file absent for v1)
  if (l.data.source.indexOf('FRED')>-1){
    return tileMarketAbsent(l, 'FRED');
  }
  // Portfolio (DealCheck) — graceful awaiting
  if (l.id === 'portfolio'){ return tilePortfolio(l); }
  return tileGeneric(l);
}

function tileMarketValue(l, src){
  const tag = l.source_tag || '';
  const tagCls = {REV:'src-rev',CEN:'src-cen'}[tag]||'src-rev';
  const head = '<div class="top"><span class="lbl">'+esc(l.title)+'</span><span class="srcpill '+tagCls+'">'+esc(tag)+'</span></div>';
  if (!src || !src.counties || !STATE.county || !src.counties[STATE.county]){
    return tileWrap(l, head+'<div class="big muted">—</div><div class="sub">awaiting snapshot</div>', false);
  }
  const c = src.counties[STATE.county];
  let val='—', sub='';
  if (l.data.select==='cap_rate'){ val=pct(c.cap_rate&&c.cap_rate.value); sub='county blended · '+esc((c.cap_rate&&c.cap_rate.source_period)||''); }
  else if (l.data.select==='vacancy_rate'){ val=pct(c.vacancy_rate&&c.vacancy_rate.value); sub='incl. seasonal · '+esc((c.vacancy_rate&&c.vacancy_rate.source_period)||''); }
  else if (l.data.select==='rental_vacancy_rate_pct'){ val=pct(c.rental_vacancy_rate_pct); sub='ACS 5-yr · '+esc(src.data_year||''); }
  const stale = isStale(src.scraped_at, 48*30); // monthly data; only flag if very old
  return tileWrap(l, head+'<div class="big">'+esc(val)+'</div><div class="sub">'+sub+(stale?' · <span style="color:var(--yellow)">stale</span>':'')+'</div>', false);
}

function tileMarketAbsent(l, tag){
  const tagCls = {FRED:'src-fred'}[tag]||'src-fl';
  return tileWrap(l,
    '<div class="top"><span class="lbl">'+esc(l.title)+'</span><span class="srcpill '+tagCls+'">'+esc(tag)+'</span></div>'+
    '<div class="big muted">—</div><div class="sub">'+esc(tag)+' unavailable</div>', false);
}

/* CENSUS vs REV GAP — computed */
function tileGap(l){
  const rev = STATE.data.reventure, cen = STATE.data.census, k = STATE.county;
  const head = '<div class="top"><span class="lbl">'+esc(l.title)+'</span></div>';
  if (!rev||!cen||!k||!rev.counties[k]||!cen.counties[k]){
    return tileWrap(l, head+'<div class="big muted">—</div><div class="sub">awaiting snapshot</div>', false);
  }
  const total = rev.counties[k].vacancy_rate && rev.counties[k].vacancy_rate.value;
  const rental = cen.counties[k].rental_vacancy_rate_pct;
  if (total==null||rental==null) return tileWrap(l, head+'<div class="big muted">—</div>', false);
  const gap = Math.round((rental-total)*10)/10;
  const sign = gap>0?'+':'';
  return tileWrap(l, head+'<div class="big" style="color:var(--teal)">'+sign+gap+'pp</div><div class="sub">seasonal stock</div>', false);
}

/* PORTFOLIO — DealCheck (file absent for v1 → graceful) */
function tilePortfolio(l){
  const d = STATE.data.dealcheck;
  const head = '<div class="top"><span class="lbl" style="color:var(--green)">DEALCHECK · PORTFOLIO</span>'+
    (d?'<span class="stamp">'+esc(fmtTs(d.scraped_at))+'</span>':'<span class="srcpill src-dc">DEALCHECK</span>')+'</div>';
  if (!d || !d.properties){
    return '<button type="button" class="tile accent-green"'+tileOpen(l)+' style="width:100%">'+head+
      '<div class="big muted" style="margin-top:6px">Awaiting first snapshot</div>'+
      '<div class="sub">DealCheck portfolio push not wired yet — opens the Deal Analyzer.</div></button>';
  }
  const props = d.properties||[];
  const doors = props.length;
  const cf = props.reduce((s,p)=>s+(Number(p.cash_flow_monthly)||0),0);
  const caps = props.map(p=>Number(p.cap_rate)).filter(n=>!isNaN(n));
  const avgCap = caps.length ? (caps.reduce((a,b)=>a+b,0)/caps.length) : null;
  return '<button type="button" class="tile accent-green"'+tileOpen(l)+' style="width:100%">'+head+
    '<div style="display:flex; gap:26px; margin:6px 0 2px">'+
    '<div><div class="big">'+doors+'</div><div class="sub">DOORS</div></div>'+
    '<div><div class="big">'+fmtMoney(cf)+'</div><div class="sub">CF/MO</div></div>'+
    '<div><div class="big">'+pct(avgCap)+'</div><div class="sub">AVG CAP</div></div></div></button>';
}

function tileGeneric(l){
  return tileWrap(l, '<div class="top"><span class="lbl">'+esc(l.title)+'</span></div><div class="big muted">—</div>', !!l.drilldown);
}

/* ════════════════════════════════════════════════════════════════
   DATA FETCH — honest states, last-good fallback, graceful absence
   ════════════════════════════════════════════════════════════════ */
function fetchAll(){
  // FL API
  const flUrl = (STATE.tenant.data_sources && STATE.tenant.data_sources.fl_api);
  if (flUrl){
    fetch(flUrl, {cache:'no-store'})
      .then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(d=>{ STATE.data.fl=d; STATE.status.fl='ok'; try{localStorage.setItem(STATE.lastGoodKey, JSON.stringify({ts:d.generated_at}));}catch(e){} refreshDataTiles(); updLiveBar(); })
      .catch(()=>{ STATE.status.fl='down'; refreshDataTiles(); updLiveBar(); });
  }
  // committed snapshots (graceful absence)
  loadSnapshot('./data/REVENTURE_LATEST.json',      d=>STATE.data.reventure=d);
  loadSnapshot('./data/CENSUS_VACANCY_LATEST.json', d=>STATE.data.census=d);
  loadSnapshot('./data/DEALCHECK_PORTFOLIO.json',   d=>STATE.data.dealcheck=d);
  loadSnapshot('./data/FRED_LATEST.json',           d=>STATE.data.fred=d);
}
function loadSnapshot(url, set){
  fetch(url, {cache:'no-store'})
    .then(r=>{ if(!r.ok) throw 0; return r.json(); })
    .then(d=>{ set(d); refreshDataTiles(); })
    .catch(()=>{ /* absent → tiles already show graceful state */ });
}

function updLiveBar(){
  const live = document.querySelector('#updbar .live');
  const lbl = $('live-label');
  if (STATE.status.fl === 'down'){
    let last='';
    try{ const s=JSON.parse(localStorage.getItem(STATE.lastGoodKey)||'null'); if(s&&s.ts) last=' · last good '+fmtTs(s.ts); }catch(e){}
    if (live) live.classList.add('down');
    if (lbl) lbl.textContent = 'API unreachable'+last;
  } else if (STATE.status.fl === 'ok'){
    if (live) live.classList.remove('down');
    if (lbl) lbl.textContent = 'Live · updated '+ (STATE.data.fl ? fmtTs(STATE.data.fl.generated_at) : fmtTs(new Date().toISOString()));
  }
}

/* ════════════════════════════════════════════════════════════════
   ROUTING — tap a tile → open the drill-in of the same name
   ════════════════════════════════════════════════════════════════ */
function bindTileClicks(){
  document.querySelectorAll('[data-tile]').forEach(el => {
    if (el.__bound) return; el.__bound = true;
    el.addEventListener('click', () => openLayer(el.getAttribute('data-tile')));
  });
}

function openLayer(id){
  const l = layerById(id); if (!l) return;
  if (l.kind === 'add') return openAddLayer();
  if (l.status_rules === 'soon') return openSoon(l);
  if (!l.drilldown) return;                         // glance-only tile (market/system)
  openDrill(l);
}

function pbar(l){
  return '<div class="pbar"><div class="pbar-l"><button class="back" type="button" id="drill-back">← Back</button>'+
    '<div class="ptitle">'+esc(l.icon||'')+' '+esc(l.title)+'</div></div></div>';
}

// "Explain this" — the Learn & Coach copilot affordance on every tile (§2.7).
// Routes to the Learn & Coach layer so the user can get a plain-English read of
// whatever they're looking at. Omitted on Learn & Coach itself.
function injectExplainThis(panel, l){
  if (l.id === 'learn-coach') return;
  const learn = layerById('learn-coach');
  if (!learn || !Entitlement.isEntitled(learn) || learn.enabled === false) return;
  const bar = panel.querySelector('.pbar'); if (!bar) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'empchip explain-chip';
  b.style.background = 'var(--greenbg)'; b.style.borderColor = 'var(--greenln)'; b.style.color = 'var(--green)';
  b.innerHTML = '💡 Explain this';
  b.title = 'Open Learn & Coach for a plain-English explanation';
  b.addEventListener('click', () => openLayer('learn-coach'));
  bar.appendChild(b);
}

function openDrill(l){
  const panel = $('panel');
  STATE.openLayer = l.id;
  panel.innerHTML = pbar(l) +
    '<iframe class="drillframe" id="drill-iframe" src="'+esc(l.drilldown)+'" title="'+esc(l.title)+'" loading="lazy"></iframe>';
  // "Explain this" copilot affordance (routes to Learn & Coach), then the per-layer
  // employee chat (both core-rendered into the overlay chrome).
  injectExplainThis(panel, l);
  if (window.Agents) Agents.injectLayerEmployee(panel, l);
  // push any saved in-tile view edits once the drill-in loads
  const fr = $('drill-iframe');
  if (fr) fr.addEventListener('load', () => { if (window.Agents) Agents.pushViewConfig(l.id); });
  $('drill-back').onclick = closeDrill;
  showOverlay('ov');
}

function openSoon(l){
  const panel = $('panel');
  panel.innerHTML = pbar(l) +
    '<div class="drill-soon"><div class="ico">'+esc(l.icon||'🧩')+'</div>'+
    '<h3>'+esc(l.title)+' — coming soon</h3>'+
    '<p>This layer is on the roadmap. When it ships it drops in here with its own drill-in and on-call employee — no rebuild.</p></div>';
  $('drill-back').onclick = closeDrill;
  showOverlay('ov');
}

// "+ Add a layer" → the Plans & Billing marketplace (buying flips entitlement ON)
function openAddLayer(){
  const pb = layerById('plans-billing');
  const url = (pb && pb.drilldown) ? pb.drilldown + '#marketplace' : null;
  if (!url){ openSoon({ title:'Add a layer', icon:'➕' }); return; }
  const panel = $('panel');
  STATE.openLayer = 'plans-billing';
  panel.innerHTML =
    '<div class="pbar"><div class="pbar-l"><button class="back" type="button" id="drill-back">← Back</button><div class="ptitle">➕ Add a layer</div></div></div>'+
    '<iframe class="drillframe" id="drill-iframe" src="'+esc(url)+'" title="Add a layer" loading="lazy"></iframe>';
  if (window.Agents && pb) Agents.injectLayerEmployee(panel, pb);
  $('drill-back').onclick = closeDrill;
  showOverlay('ov');
}

function showOverlay(id){ $(id).classList.add('on'); window.scrollTo(0,0); document.body.style.overflow='hidden'; }
function hideOverlay(id){ $(id).classList.remove('on'); document.body.style.overflow=''; }
function closeDrill(){ hideOverlay('ov'); $('panel').innerHTML=''; STATE.openLayer=null; }

/* ── global controls ── */
function wireGlobalControls(){
  $('refresh-btn').onclick = forceRefresh;
  $('tars-btn').onclick = () => { if (window.Agents) Agents.openGlobal(); };
  // close overlays on backdrop click / Esc
  ['ov','gov'].forEach(id => $(id).addEventListener('click', e => { if (e.target.id===id){ hideOverlay(id); if(id==='ov') $('panel').innerHTML=''; } }));
  document.addEventListener('keydown', e => { if (e.key==='Escape'){ hideOverlay('ov'); hideOverlay('gov'); } });
  // a Plans & Billing purchase flips entitlement → re-render the home so the new tile appears
  window.addEventListener('message', e => { const d = e.data || {}; if (d && d.type === 'tcc:purchase') renderHome(); });
}

function forceRefresh(){
  const btn = $('refresh-btn');
  btn.textContent = '↻ REFRESHING…'; btn.classList.add('refreshing');
  // re-pull live sources without nuking the SW cache (honest, fast)
  STATE.status.fl='pending'; refreshDataTiles();
  fetchAll();
  setTimeout(()=>{ btn.textContent='↻ REFRESH'; btn.classList.remove('refreshing'); }, 900);
}

/* go */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* expose a few internals for the agents module */
window.TCC = { STATE, layerById, visibleLayers, fmtMoney, fmtTs, esc };
