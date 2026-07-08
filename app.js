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
function pct(v){ if (v==null||isNaN(v)) return '—'; return (Math.round(Number(v)*10)/10).toFixed(1) + '%'; }
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
  briefRouter: null,                // TARS cross-section brief items, computed from stubs by shared/fl-brief-router.js
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
  checkNewOperator();   // real signed-in + zero grants -> "Create your first company" (find #1)
  wireGlobalControls();
  loadBriefRouter();
  if (window.flAuth && flAuth.mountReportButton) flAuth.mountReportButton();  // "Report an issue" (bug-capture)
}

// TARS as router: compute the cross-section brief from the reference stubs, then repaint so it shows in the Daily Brief.
function loadBriefRouter(){
  if (!(window.FLBriefRouter && FLBriefRouter.build)) return;
  FLBriefRouter.build().then(function(r){
    if (!r) return;
    STATE.briefRouter = r;
    if (STATE.registry) renderHome();
  }).catch(function(){});
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

// First-run gates (Phase 2 + polish). Two DISTINCT states so "explore" is never a one-way door:
//  - explored: the user chose to roam ("explore on my own") — unlocks the board, but setup is NOT done.
//  - setupComplete: setup is genuinely finished (Phase 3 sets it). The persistent "Set up with TARS"
//    entry shows until THIS is true, so the user can always return to setup after exploring.
function setupComplete(){ try { return localStorage.getItem('fl_setup_complete') === 'true'; } catch(e){ return false; } }
function explored(){ try { return localStorage.getItem('fl_explored') === 'true'; } catch(e){ return false; } }
// Demo/sandbox accounts (seed_demo.py). The demo login exists to SHOW the full board on labeled
// sample data, so it lands unlocked (no setup gate) and surfaces the SAMPLE-DATA banner.
const DEMO_ACCOUNTS = ['demo@foundationlayerhq.com'];
// The demo login + the pre-bash synthetic tenants (*@prebash.foundationlayerhq.com) are all
// sample/sandbox accounts — treated identically for the SAMPLE banner + unlocked board + funnel suppression.
function isDemoAccount(){
  try{
    const em = ((STATE.user && STATE.user.contact) ||
                (window.flAuth && flAuth.email && flAuth.email()) || '').toLowerCase();
    return !!em && (DEMO_ACCOUNTS.indexOf(em) !== -1 || /@prebash\.foundationlayerhq\.com$/.test(em));
  }catch(e){ return false; }
}
function boardUnlocked(){ return explored() || setupComplete() || isDemoAccount(); }

// ── Phase 3 dual-mode setup engine ─────────────────────────────────────────────
// Per-area "active" + per-area employee hire/skip. BOTH modes — manual (click an area → "Set up"
// panel → one-click activate) and TARS-assisted (chips that execute via window.FLSetup) — write
// these SAME keys, so the board state is identical however setup is done. Progressive unlock: an
// area lights up the instant it's active, with NO data required up front (fill it in later).
const AREA_EMPLOYEE = {
  brief:    { name:'TARS',   role:'Company-wide',        avatar:'T', always:true },
  overview: { name:'TARS',   role:'Company-wide',        avatar:'T', always:true },
  market:   { name:'Scout',  role:'Market & Deals lead', avatar:'S' },
  portfolio:{ name:'Reed',   role:'Portfolio lead',      avatar:'R' },
  financial:{ name:'Margo',  role:'Financials lead',     avatar:'M' },
  build:    { name:'Jordan', role:'Operations lead',     avatar:'J' },
  legal:    { name:'Dean',   role:'Legal lead',          avatar:'D' },
  it:       { name:'Iris',   role:'IT & Marketing lead', avatar:'I' },
  admin:    { name:'Quinn',  role:'Admin lead',          avatar:'Q' }
};
function areaEmployee(g){ return AREA_EMPLOYEE[g] || null; }
function areaActive(g){ try { return localStorage.getItem('fl_area_active_'+g) === 'true'; } catch(e){ return false; } }
function setAreaActiveFlag(g,on){ try { if(on) localStorage.setItem('fl_area_active_'+g,'true'); else localStorage.removeItem('fl_area_active_'+g); } catch(e){} }
function areaHire(g){ try { return localStorage.getItem('fl_area_hire_'+g) || null; } catch(e){ return null; } }   // 'hire' | 'skip' | null
function setAreaHireFlag(g,val){ try { if(val) localStorage.setItem('fl_area_hire_'+g,val); else localStorage.removeItem('fl_area_hire_'+g); } catch(e){} }

function refreshBoard(){ if (typeof renderChrome==='function') renderChrome(); if (typeof renderHome==='function') renderHome(); }
function activateArea(g){ setAreaActiveFlag(g,true); refreshBoard(); }
function hireArea(g,val){ setAreaHireFlag(g,val); refreshBoard(); }
function completeSetup(){ try{ localStorage.setItem('fl_setup_complete','true'); }catch(e){} refreshBoard(); }

// Files gathered setup info into Administration → Document Navigator (the canonical record).
// These are NAME-ONLY reference notes (no file bytes). Real-Data Foundation Part B/C: for a
// signed-in user they persist to the server 'docnav_notes' tile-state ledger (survives browsers
// and cache clears, admin-visible); the fl_documents_overlay_v1 localStorage write remains as
// the offline cache + signed-out fallback. Real FILES go through FLDocDrop -> /api/documents.
function fileToDocNav(name, folder, sourceTile){
  var entry = { name:name, folder:folder||'entity', source_tile:sourceTile||'document-navigator',
                added:(new Date()).toISOString().slice(0,10) };
  try {
    var ov = JSON.parse(localStorage.getItem('fl_documents_overlay_v1')||'{"added":[]}');
    if (!ov.added) ov.added = [];
    ov.added.push(entry);
    localStorage.setItem('fl_documents_overlay_v1', JSON.stringify(ov));
  } catch(e){}
  try {
    if (window.FLState && window.flApi && flApi.authed()){
      FLState.load('docnav_notes', 'fl_documents_overlay_v1').then(function(r){
        var v = r.value || {added:[]};
        if (!v.added) v.added = [];
        var dup = v.added.some(function(d){ return d.name===entry.name && d.folder===entry.folder &&
                                                   d.source_tile===entry.source_tile && d.added===entry.added; });
        if (!dup) v.added.push(entry);
        FLState.save('docnav_notes', 'fl_documents_overlay_v1', v);
      });
    }
  } catch(e){}
}

function restartSetup(){
  if (!window.confirm('Restart setup? This resets which areas are switched on and the first-run walkthrough. Your saved records, entities, and documents are NOT deleted.')) return;
  try {
    var rm = [];
    for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if (k && (k.indexOf('fl_area_active_')===0 || k.indexOf('fl_area_hire_')===0)) rm.push(k); }
    rm.forEach(function(k){ localStorage.removeItem(k); });
    localStorage.removeItem('fl_explored'); localStorage.removeItem('fl_setup_complete');
  } catch(e){}
  closeSetupModal(); refreshBoard();
  if (window.Agents && Agents.openSetup) Agents.openSetup();
}

function bindSetupClicks(){
  document.querySelectorAll('[data-setup-area]').forEach(function(el){
    if (el.__setupBound) return; el.__setupBound = true;
    el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openAreaSetup(el.getAttribute('data-setup-area')); });
  });
}

// ── setup modal (manual mode + Employees manager) ──
function showSetupModal(html){
  var m = $('setup-modal');
  if (!m){
    m = document.createElement('div'); m.id='setup-modal'; m.className='setup-modal';
    m.innerHTML='<div class="setup-modal-card" id="setup-modal-card"></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function(e){ if (e.target===m) closeSetupModal(); });
  }
  $('setup-modal-card').innerHTML = html;
  m.classList.add('on'); document.body.style.overflow='hidden';
}
function closeSetupModal(){ var m=$('setup-modal'); if(m) m.classList.remove('on'); document.body.style.overflow=''; }

// Manual "Set up [area]" panel: explains the area, hire/skip its employee, one-click activate.
function openAreaSetup(groupId){
  var grp = (STATE.registry.groups||[]).filter(function(g){ return g.id===groupId; })[0];
  if (!grp) return;
  var ls = layersInGroup(groupId);
  var emp = areaEmployee(groupId);
  function paint(){
    var active = areaActive(groupId), h = areaHire(groupId);
    var tiles = ls.map(function(l){ return '<span class="setup-tile-chip">'+esc(l.icon||'▫')+' '+esc(l.title)+'</span>'; }).join('') || '<span class="small muted">tiles coming</span>';
    var empBlock = '';
    if (emp && !emp.always){
      empBlock = '<div class="setup-sec"><div class="setup-sec-h">'+esc(emp.name)+' — '+esc(emp.role)+'</div>'+
        '<div class="small muted">Your optional AI employee for this area. Hire to command '+esc(emp.name)+' through TARS; skip and these tiles work fully by hand. Change anytime — billing soon.</div>'+
        '<div class="setup-btns">'+
          '<button type="button" class="btn'+(h==='hire'?' primary':'')+'" data-act="hire">'+(h==='hire'?'✓ '+esc(emp.name)+' hired':'🤝 Hire '+esc(emp.name))+'</button>'+
          '<button type="button" class="btn'+(h==='skip'?' primary':'')+'" data-act="skip">'+(h==='skip'?'✓ Manual':'Skip — do it manually')+'</button>'+
        '</div></div>';
    } else if (emp && emp.always){
      empBlock = '<div class="setup-sec"><div class="small muted"><b>'+esc(emp.name)+'</b> runs this area company-wide — always on, nothing to hire.</div></div>';
    }
    var actBlock = '<div class="setup-sec">'+
      (active
        ? '<div class="ok" style="font-weight:800">✓ This area is live on your board.</div><div class="small muted">Fill in its data anytime — nothing is required up front.</div>'
        : '<div class="small muted">Turning it on adds this area to your board now. <b>Data is optional</b> — add it later from the tiles or with TARS.</div>')+
      '<div class="setup-btns">'+
        (active ? '<button type="button" class="btn" data-act="off">Turn back off</button>'
                : '<button type="button" class="btn primary" data-act="on">⚡ Turn on '+esc(grp.label||groupId)+'</button>')+
        '<button type="button" class="btn" data-act="close">Done</button>'+
      '</div></div>';
    showSetupModal(
      '<div class="setup-modal-top"><span class="setup-modal-title">Set up '+esc(grp.label||groupId)+'</span>'+
        '<button type="button" class="setup-x" data-act="close" aria-label="Close">✕</button></div>'+
      '<div class="small muted" style="margin:2px 0 6px">What’s inside this area:</div>'+
      '<div class="setup-tiles">'+tiles+'</div>'+ empBlock + actBlock);
    var card = $('setup-modal-card');
    card.querySelectorAll('[data-act]').forEach(function(b){
      b.onclick = function(){
        var a = b.getAttribute('data-act');
        if (a==='on'){ setAreaActiveFlag(groupId,true); refreshBoard(); paint(); }
        else if (a==='off'){ setAreaActiveFlag(groupId,false); refreshBoard(); paint(); }
        else if (a==='hire'){ setAreaHireFlag(groupId, h==='hire'?null:'hire'); refreshBoard(); paint(); }
        else if (a==='skip'){ setAreaHireFlag(groupId, h==='skip'?null:'skip'); refreshBoard(); paint(); }
        else if (a==='close'){ closeSetupModal(); }
      };
    });
  }
  paint();
}

// Central Employees manager (Administration) — hire/skip any area's employee anytime + Restart setup.
function openEmployeesManager(){
  var groups = STATE.registry.groups || [];
  function paint(){
    var rows = groups.filter(function(g){ var e=areaEmployee(g.id); return e && !e.always && layersInGroup(g.id).length; })
      .map(function(g){
        var e=areaEmployee(g.id), h=areaHire(g.id), active=areaActive(g.id);
        return '<div class="emp-row"><div class="emp-row-l"><span class="empav">'+esc(e.avatar)+'</span>'+
          '<div><div class="emp-row-nm">'+esc(e.name)+' <span class="small muted">· '+esc(g.label)+'</span></div>'+
          '<div class="small muted">'+esc(e.role)+(active?' · area live':'')+'</div></div></div>'+
          '<div class="emp-row-r">'+
            '<button type="button" class="btn sm'+(h==='hire'?' primary':'')+'" data-hire="'+esc(g.id)+'">'+(h==='hire'?'✓ Hired':'Hire')+'</button>'+
            '<button type="button" class="btn sm'+(h==='skip'?' primary':'')+'" data-skip="'+esc(g.id)+'">'+(h==='skip'?'✓ Manual':'Skip')+'</button>'+
          '</div></div>';
      }).join('');
    showSetupModal(
      '<div class="setup-modal-top"><span class="setup-modal-title">👔 Employees</span>'+
        '<button type="button" class="setup-x" data-act="close" aria-label="Close">✕</button></div>'+
      '<div class="small muted" style="margin-bottom:10px">Each area has one optional AI employee. <b>Hire</b> to command it through TARS; <b>skip</b> and the tiles work by hand. Change anytime — independent of setup. Billing soon.</div>'+
      '<div class="emp-list">'+rows+'</div>'+
      '<div class="emp-row" style="border:0;padding-top:8px"><span class="small muted">TARS runs your overview &amp; daily brief company-wide — always on.</span></div>'+
      '<div class="setup-btns" style="margin-top:12px;border-top:1px solid var(--ln,#26263a);padding-top:12px">'+
        '<button type="button" class="btn" data-act="restart">↻ Restart setup</button>'+
        '<button type="button" class="btn primary" data-act="close">Done</button>'+
      '</div>');
    var card=$('setup-modal-card');
    card.querySelectorAll('[data-hire]').forEach(function(b){ b.onclick=function(){ var g=b.getAttribute('data-hire'); setAreaHireFlag(g, areaHire(g)==='hire'?null:'hire'); refreshBoard(); paint(); }; });
    card.querySelectorAll('[data-skip]').forEach(function(b){ b.onclick=function(){ var g=b.getAttribute('data-skip'); setAreaHireFlag(g, areaHire(g)==='skip'?null:'skip'); refreshBoard(); paint(); }; });
    var rb=card.querySelector('[data-act=restart]'); if(rb) rb.onclick=restartSetup;
    card.querySelectorAll('[data-act=close]').forEach(function(b){ b.onclick=closeSetupModal; });
  }
  paint();
}

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
  // Member role: UI-scoped to granted sections (section_lead) + tiles + baseline (Inbox/Calendar).
  // NOTE: UX only — a determined user can unhide; real access control is server-side at the auth phase (TD-101).
  else if (STATE.role === 'member' && STATE.user && STATE.user.access) {
    const a = STATE.user.access, base = ['inbox','calendar'];
    ls = ls.filter(l => base.indexOf(l.id) >= 0 || (a.sections||[]).indexOf(l.section_lead) >= 0 || (a.tiles||[]).indexOf(l.id) >= 0);
  }
  return ls;
}
function layersInGroup(g){ return visibleLayers().filter(l => l.group === g); }
function layerById(id){ return (STATE.registry.layers||[]).find(l => l.id === id); }

/* ════════════════════════════════════════════════════════════════
   CHROME (verbar, global TARS button, header, AI summary, footer)
   ════════════════════════════════════════════════════════════════ */
// SAMPLE-DATA banner — shown ONLY when the demo/sandbox account is signed in (isDemoAccount), so
// seeded sample figures can never be mistaken for real ECH financials (Jerry's #1 honesty doctrine).
// Self-styled — the shell doesn't load artifact.css, so we inline an amber notice (no shared CSS).
function sampleDataBanner(){
  try{
    if (!isDemoAccount()) return '';
    return '<div class="fl-sample-banner" role="note" style="margin:10px 0 0;padding:9px 13px;'+
      'border-radius:10px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.45);'+
      'color:#f6c453;font-size:12.5px;line-height:1.5;font-weight:600">'+
      '🧪 <b>SAMPLE DATA</b> — this is the demo account. Every figure shown is sandbox/sample data '+
      'for walkthrough purposes, <b>not real ECH financials</b>.</div>';
  }catch(e){ return ''; }
}
function renderChrome(){
  const b = (STATE.tenant.branding)||{};
  const u = STATE.user || {};
  const roleLabel = { owner:'Owner', admin:'Admin', staff:'Staff', viewer:'Read-only', tenant:'Tenant', field:'Field', member:'Member' }[STATE.role] || STATE.role;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const scopeStr = (STATE.role==='field'&&STATE.scope) ? ' · '+esc((layerById(STATE.scope)||{}).title||STATE.scope) : '';

  // TOP RIBBON — brand · who/when · live + refresh + sign out.
  // (Source chips moved DOWN onto each group's header — see groupChipsInner.)
  $('verbar').innerHTML =
    '<div class="vb-brand">'+flMark(24)+'<b>FL&nbsp;CC</b></div>'+
    '<div class="vb-meta"><b>'+dateStr+'</b><span>'+timeOfDay()+(u.name && u.name!==roleLabel ? ' · '+esc(u.name) : '')+' · '+esc(roleLabel)+scopeStr+'</span></div>'+
    '<div class="vb-status">'+
      '<span class="live" id="live-wrap"><span class="pulse"></span> <span id="live-label">Live</span></span>'+
      '<button class="aibtn" id="refresh-btn" type="button">↻ REFRESH</button>'+
      '<button type="button" id="signout-btn" class="vb-signout">sign out</button>'+
    '</div>';
  $('signout-btn').onclick = () => { Auth.signOut(); if(window.flAuth) flAuth.signOut(); location.reload(); };

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

  // Phase 2 (+ polish) — setup entry. Shows until setup is COMPLETE (not merely explored), so
  // "explore on my own" is never a one-way door: a persistent path back to setup always remains.
  // First run = the prominent flashing CTA on the locked board; after exploring = a compact resume bar.
  // Phase 3 swaps the click target from the global TARS chat to the TARS-led onboarding engine.
  (function(){
    var host = $('tars-btn'); if(!host) return;
    var old = document.getElementById('tars-firstrun'); if(old) old.remove();
    if (STATE.role === 'field') return;            // scoped field role: no setup entry
    if (setupComplete()) return;                   // setup finished -> no entry at all
    if (isDemoAccount()) return;                   // demo/synthetic tenant: no setup funnel
    var name = esc(g.name||'TARS');
    var firstRun = !boardUnlocked();               // locked board, hasn't explored yet
    var el = document.createElement('div');
    el.id = 'tars-firstrun';
    var goSetup = function(){ try{ if(window.Agents && Agents.openSetup) Agents.openSetup(); else if(window.Agents && Agents.openGlobal) Agents.openGlobal(); }catch(e){} };
    if (firstRun){
      el.className = 'setup-cta';
      el.innerHTML =
        '<div class="setup-cta-row">'+
          '<span style="flex:0 0 auto">'+tarsSvg(28)+'</span>'+
          '<div style="flex:1">'+
            '<b>Welcome to Foundation Layer.</b> Your areas are locked until they’re set up. '+
            name+' will walk you through it — your business, your entities, and which areas to turn on — '+
            'and file everything as you go. Prefer hands-on? Explore on your own; you can come back to setup anytime.'+
          '</div>'+
        '</div>'+
        '<div class="setup-cta-btns">'+
          '<button type="button" class="btn primary setup-cta-go" id="tfr-go">🚀 Set up with '+name+'</button>'+
          '<button type="button" class="btn" id="tfr-later">I’ll explore on my own →</button>'+
        '</div>';
    } else {
      el.className = 'setup-resume';
      el.innerHTML =
        '<span style="flex:0 0 auto">'+tarsSvg(20)+'</span>'+
        '<span class="setup-resume-tx"><b>Setup isn’t finished.</b> '+name+' can pick up where you left off and turn on the rest.</span>'+
        '<button type="button" class="btn primary" id="tfr-go">Set up with '+name+'</button>';
    }
    host.parentNode.insertBefore(el, host.nextSibling);
    var go=document.getElementById('tfr-go'), later=document.getElementById('tfr-later');
    if(go) go.onclick=goSetup;
    if(later) later.onclick=function(){
      try{ localStorage.setItem('fl_explored','true'); }catch(e){}   // explore != setup complete
      if (typeof renderChrome === 'function') renderChrome();        // swap CTA -> persistent resume bar
      if (typeof renderHome === 'function') renderHome();            // unlock the board for roaming
    };
  })();

  // header — tenant title only (date / role / sign-out moved up into the ribbon)
  $('head').innerHTML =
    '<h1>'+esc(b.title||STATE.tenant.name||'')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h1>'+
    sampleDataBanner();

  // Daily Brief now renders as its own lasso (renderBriefGroup); hide the legacy summary block.
  $('ai-summary').style.display = 'none';

  // footer
  $('foot').innerHTML = 'Foundation Layer · Command Center · tenant: '+esc(STATE.tenant.name||'')+
    (STATE.tenant.reference_install?' (reference install)':'')+'<br>layers render from the registry · honest display always';
}

/* ════════════════════════════════════════════════════════════════
   LOGIN GATE — light, plug-and-play. Primary path = email + password
   (Supabase Auth when configured). "Try the demo →" drops into the seeded
   sandbox account in one click; "Continue without an account" opens the
   advanced local demo roles (Admin / Read-only / Field). Magic-link / SMS
   OTP is the team-phase upgrade (needs an email/SMS provider — not wired).
   ════════════════════════════════════════════════════════════════ */
function deriveName(contact, role){
  if (role==='owner') return (STATE.tenant.operator && STATE.tenant.operator.greeting_name) || 'Owner';
  if (contact && contact.indexOf('@')>0) return contact.split('@')[0];
  return ({admin:'Staff', viewer:'Viewer', field:'Field user', tenant:'Tenant'})[role] || 'User';
}
function renderLoginGate(){
  const b = (STATE.tenant.branding)||{};
  const real = !!(window.flAuth && flAuth.configured());
  const scopeOpts = (STATE.registry.layers||[]).filter(l => l.drilldown)
    .map(l => '<option value="'+esc(l.id)+'">'+esc(l.title)+'</option>').join('');
  const el = document.createElement('div');
  el.className = 'gate'; el.id = 'login-gate';
  el.innerHTML =
    '<div class="gate-card">'+
      '<div class="gate-logo">'+flMark(58)+'</div>'+
      '<h2>'+esc(b.title||STATE.tenant.name||'Foundation Layer')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h2>'+
      '<p class="gate-sub">Your real-estate investing co-pilot.</p>'+
      '<label>Email</label>'+
      '<input id="gate-email" type="email" placeholder="you@company.com" autocomplete="username">'+
      '<label>Password</label>'+
      '<input id="gate-pass" type="password" placeholder="••••••••" autocomplete="current-password">'+
      '<button class="gate-btn primary" type="button" id="gate-signin">Sign in</button>'+
      (real ? '<button class="gate-link" type="button" id="gate-forgot" style="margin-top:4px">Forgot password?</button>' : '')+
      '<div class="gate-note" id="gate-err" style="display:none;color:var(--red)"></div>'+
      (real ? '<button class="gate-link" type="button" id="gate-create-toggle">Create an account ▾</button>'+
        '<div id="gate-create" style="display:none">'+
          '<label>Access code</label>'+
          '<input id="gate-code" type="text" placeholder="invitation code" autocomplete="one-time-code">'+
          '<button class="gate-btn primary" type="button" id="gate-create-btn">Create account &amp; sign in</button>'+
          '<div class="gate-note">Invite-only. Uses the email + password above, plus the access code you were given. Creates your own empty workspace.</div>'+
        '</div>' : '')+
      '<button class="gate-btn" type="button" id="gate-try-demo">Try the demo →</button>'+
      '<div class="gate-note">One click into a sandbox account with labeled sample data — no signup.</div>'+
      '<button class="gate-link" type="button" id="gate-adv-toggle">Continue without an account (demo) ▾</button>'+
      '<div id="gate-adv" style="display:none">'+
        '<label>Role</label>'+
        '<select id="gate-role"><option value="owner">Owner (full)</option><option value="admin">Admin / Staff</option><option value="viewer">Read-only / Viewer</option><option value="field">Field (one job)</option></select>'+
        '<div id="gate-scope-wrap" style="display:none"><label>Field scope — one layer/job</label><select id="gate-scope">'+scopeOpts+'</select></div>'+
        '<button class="gate-btn" type="button" id="gate-demo">Enter demo (local, this browser)</button>'+
      '</div>'+
      '<a class="gate-link" href="./onboarding/">New here? Get set up →</a>'+
      '<div class="gate-note">'+(real
        ? 'Sign in with your Foundation Layer account (Supabase Auth) — your session syncs deals + scoped data to the backend. No account yet? Use demo.'
        : 'Auth not configured — demo session only (local, this browser).')+'</div>'+
    '</div>';
  document.body.appendChild(el);

  const role = el.querySelector('#gate-role');
  el.querySelector('#gate-adv-toggle').onclick = () => { const a=el.querySelector('#gate-adv'); a.style.display = a.style.display==='none'?'block':'none'; };
  role.onchange = () => { el.querySelector('#gate-scope-wrap').style.display = role.value==='field'?'block':'none'; };

  // "Try the demo" — prefill the seeded demo account + focus the password so it's one field, not two.
  // (A real JWT is required for the seeded server data to render, so we route through the real sign-in
  // rather than a JWT-less local session — which would land on an unlocked-but-empty board. Shipping
  // the sample password for a zero-typing one-click is a Jerry call — kept out of the repo per the brief.)
  el.querySelector('#gate-try-demo').onclick = () => {
    el.querySelector('#gate-email').value = 'demo@foundationlayerhq.com';
    const err = el.querySelector('#gate-err');
    err.style.display = 'block'; err.style.color = 'var(--mut)';
    err.textContent = 'Demo account prefilled — enter the sample password (in the demo run sheet), then Sign in.';
    el.querySelector('#gate-pass').focus();
  };

  // Demo path — cosmetic local session (no JWT). The no-lockout fallback.
  el.querySelector('#gate-demo').onclick = () => {
    const r = role.value || 'owner';
    Auth.signIn({
      name: deriveName(el.querySelector('#gate-email').value||'', r), role: r,
      tenant: STATE.tenant.tenant_id || 'ech',
      contact: (el.querySelector('#gate-email').value||'').trim() || null,
      scope: r==='field' ? (el.querySelector('#gate-scope').value || null) : null,
      demo: true, at: new Date().toISOString()
    });
    el.remove(); startApp();
  };

  // Real path — Supabase email+password -> JWT (stored by flAuth for the API) + a session.
  async function realSignIn(){
    const email = (el.querySelector('#gate-email').value||'').trim();
    const pass = el.querySelector('#gate-pass').value||'';
    const err = el.querySelector('#gate-err');
    err.style.color = 'var(--red)';   // a prior "Forgot password?"/demo note muted it; sign-in errors are red
    if(!email || !pass){ err.style.display='block'; err.textContent='Enter your email and password.'; return; }
    const btn = el.querySelector('#gate-signin'); btn.disabled=true; btn.textContent='Signing in…';
    const res = await flAuth.signIn(email, pass);
    btn.disabled=false; btn.textContent='Sign in';
    if(res && res.error){ err.style.display='block'; err.textContent=res.error; return; }
    Auth.signIn({ name: email.split('@')[0], role:'owner', tenant: STATE.tenant.tenant_id||'ech',
      contact: email, supabase: true, at: new Date().toISOString() });
    el.remove(); startApp();
  }
  const signinBtn = el.querySelector('#gate-signin');
  signinBtn.onclick = real ? realSignIn : () => {
    const err = el.querySelector('#gate-err'); err.style.display='block';
    err.textContent = 'Auth not configured — use “Continue without an account (demo)”.';
  };
  el.querySelector('#gate-pass').addEventListener('keydown', e => { if (e.key==='Enter') signinBtn.click(); });

  // "Forgot password?" — email a recovery link to the /reset-password/ handler. Enumeration-safe:
  // GoTrue returns 200 whether or not the address has an account, and the confirmation below never
  // confirms existence. Needs the email field filled (reuses it); focuses it if empty.
  const forgotBtn = el.querySelector('#gate-forgot');
  if (forgotBtn) forgotBtn.onclick = async () => {
    const email = (el.querySelector('#gate-email').value||'').trim();
    const err = el.querySelector('#gate-err'); err.style.display='block';
    if(!email){ err.style.color='var(--mut)';
      err.textContent='Enter your email above first — we’ll send a password-reset link there.';
      el.querySelector('#gate-email').focus(); return; }
    forgotBtn.disabled=true; const _t=forgotBtn.textContent; forgotBtn.textContent='Sending…';
    const res = await flAuth.requestPasswordReset(email);
    forgotBtn.disabled=false; forgotBtn.textContent=_t;
    if(res && res.ok){ err.style.color='var(--mut)';
      err.textContent='If an account exists for '+email+', a password-reset link is on its way. Check your email (and spam). If it doesn’t arrive in a few minutes, contact your administrator.';
    } else if(res && res.error==='rate_limited'){ err.style.color='var(--red)';
      err.textContent='Too many requests — wait a minute and try again.';
    } else { err.style.color='var(--red)';
      err.textContent='Couldn’t send a reset link just now. Try again in a moment.'; }
  };

  // Create-account (access-code-gated → /api/signup). Reuses the email + password fields above and
  // adds the invitation code. On 201 it signs in through the SAME Supabase path (no token minted
  // here) and lands the new operator in their own empty workspace (self-serve entity next).
  const createToggle = el.querySelector('#gate-create-toggle');
  if (createToggle) createToggle.onclick = () => {
    const c = el.querySelector('#gate-create');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
    if (c.style.display === 'block') el.querySelector('#gate-code').focus();
  };
  async function createAccount(){
    const email = (el.querySelector('#gate-email').value||'').trim();
    const pass  = el.querySelector('#gate-pass').value||'';
    const code  = (el.querySelector('#gate-code').value||'').trim();
    const err = el.querySelector('#gate-err'); err.style.color = 'var(--red)';
    if(!email || !pass){ err.style.display='block'; err.textContent='Enter your email and password above, then the access code.'; return; }
    if(pass.length < 8){ err.style.display='block'; err.textContent='Choose a password of at least 8 characters.'; return; }
    if(!code){ err.style.display='block'; err.textContent='Enter your invitation access code.'; return; }
    if(!window.flSignup){ err.style.display='block'; err.textContent='Sign-up is unavailable right now.'; return; }
    const btn = el.querySelector('#gate-create-btn'); btn.disabled=true; btn.textContent='Creating…';
    const r = await flSignup.create(email, pass, code);
    if(r && r.ok){
      btn.textContent='Signing in…';
      const s = await flAuth.signIn(email, pass);   // normal JWT path; no token minted client-side
      btn.disabled=false; btn.textContent='Create account & sign in';
      if(s && s.error){ err.style.display='block'; err.textContent='Account created — sign-in failed: '+s.error+'. Try Sign in.'; return; }
      Auth.signIn({ name: email.split('@')[0], role:'owner', tenant: STATE.tenant.tenant_id||'ech',
        contact: email, supabase:true, at:new Date().toISOString() });
      el.remove(); startApp();   // lands in their own empty workspace — create your first entity next
      return;
    }
    btn.disabled=false; btn.textContent='Create account & sign in';
    err.style.display='block';
    const st = r ? r.status : 0;
    err.textContent = st===403 ? 'That access code isn’t valid. Check it and try again.'
      : st===409 ? 'An account with that email already exists — try Sign in.'
      : st===429 ? 'Too many attempts. Wait a few minutes and try again.'
      : st===503 ? 'Sign-up isn’t enabled yet. Ask your administrator for an invite.'
      : 'Couldn’t create the account just now. Please try again.';
  }
  const createBtn = el.querySelector('#gate-create-btn');
  if (createBtn) createBtn.onclick = createAccount;
}

function tarsSvg(s){
  return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="7" r="3.6" fill="#0a0a0b"/><path d="M4.5 21c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" fill="#0a0a0b"/><circle cx="12" cy="7" r="3.6" stroke="#0a0a0b"/></svg>';
}

/* Foundation Layer product mark — stacked strata bars + orange foundation underline
   (on-dark lockup form; bars light, base bar = brand orange). Used for FL CC product
   branding (ribbon + login). TARS (tarsSvg) stays the on-call ASSISTANT avatar. */
function flMark(s, bar){
  bar = bar || '#f4f4f5';
  return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Foundation Layer">'+
    '<rect x="8" y="8"  width="14" height="4.4" rx="1.4" fill="'+bar+'"/>'+
    '<rect x="8" y="15" width="20" height="4.4" rx="1.4" fill="'+bar+'"/>'+
    '<rect x="8" y="22" width="26" height="4.4" rx="1.4" fill="'+bar+'"/>'+
    '<rect x="8" y="29.5" width="20" height="3.6" rx="1.8" fill="#f59e0b"/>'+
  '</svg>';
}

/* ════════════════════════════════════════════════════════════════
   HOME — groups + tiles
   ════════════════════════════════════════════════════════════════ */
function groupDef(id){ return (STATE.registry.groups||[]).find(g => g.id === id) || { id, render:'card' }; }

// Per-group visual identity — distinct accent + faint tint + icon, so each lasso
// reads as its own area without flood-coloring (status green/yellow/red keep their meaning).
const GROUP_STYLE = {
  brief:       { a:'#8b7ff0', bg:'rgba(139,127,240,.06)', ico:'🗞️' },
  overview:    { a:'#22d3ee', bg:'rgba(34,211,238,.05)',  ico:'🧭' },
  market:      { a:'#f59e0b', bg:'rgba(245,158,11,.06)',  ico:'📊' },
  portfolio:   { a:'#10b981', bg:'rgba(16,185,129,.06)',  ico:'🏠' },
  financial:   { a:'#3b82f6', bg:'rgba(59,130,246,.06)',  ico:'💰' },
  build:       { a:'#2dd4bf', bg:'rgba(45,212,191,.06)',  ico:'🏗️' },
  it:          { a:'#ec4899', bg:'rgba(236,72,153,.06)',  ico:'🌐' },
  admin:       { a:'#94a3b8', bg:'rgba(148,163,184,.06)', ico:'🗂️' },
  legal:       { a:'#c8a24a', bg:'rgba(200,162,74,.06)',  ico:'⚖️' }
};
function collapsedSet(){ try { return new Set(JSON.parse(localStorage.getItem('tcc_collapsed')||'[]')); } catch(e){ return new Set(); } }

/* ── source connection chips (per-group; GREEN = connected/live, RED = not connected) ──
   The chips sit on the header of the group whose tiles the source actually feeds:
   MARKET → REV/CEN/FRED/DEALCHECK · OVERVIEW → FL (Capital Rules + System). */
function srcConnected(tag){
  switch(tag){
    case 'FL':        return STATE.status.fl === 'ok';   // FL ledger API answered
    case 'REV':       return !!STATE.data.reventure;      // Reventure snapshot present
    case 'CEN':       return !!STATE.data.census;         // Census snapshot present
    case 'FRED':      return !!STATE.data.fred;           // FRED snapshot present
    case 'DEALCHECK': return !!STATE.data.dealcheck;      // DealCheck snapshot present
    default:          return false;
  }
}
function groupSrcTags(grpId){
  const tags = [];
  layersInGroup(grpId).forEach(l => { if (l.source_tag && !tags.includes(l.source_tag)) tags.push(l.source_tag); });
  if (grpId === 'overview' && !tags.includes('FL')) tags.unshift('FL');   // FL feeds Capital Rules + System
  return tags;
}
// Where each source goes to (re)connect — so if a feed drops, the chip is the way back in.
const SRC_CONNECT = {
  FL:'https://api.foundationlayerhq.com/api/dashboard/scoped',
  FRED:'https://fredaccount.stlouisfed.org/apikeys',
  REV:'https://www.reventure.app/',
  CEN:'https://api.census.gov/data/key_signup.html',
  DEALCHECK:'https://app.dealcheck.io/'
};
function srcChip(tag){
  const on = srcConnected(tag);
  const url = SRC_CONNECT[tag] || '#';
  return '<a class="srcpill conn-'+(on?'on':'off')+'" href="'+url+'" target="_blank" rel="noopener" '+
    'title="'+(on?'Connected · live — open '+esc(tag)+' ↗':'Not connected — open '+esc(tag)+' to connect ↗')+'" '+
    'onclick="event.stopPropagation()"><span class="cdot"></span>'+esc(tag)+' ↗</a>';
}
function groupChipsInner(grpId){ return groupSrcTags(grpId).map(srcChip).join(''); }
function refreshGroupChips(){
  document.querySelectorAll('[data-srcgrp]').forEach(el => {
    el.innerHTML = groupChipsInner(el.getAttribute('data-srcgrp'));
  });
}

// ── New-operator first run (Ashley proving-run find #1) ─────────────────────
// A REAL signed-in account with ZERO entity grants gets 403 from GET /api/entities
// (require_entity_scope) while POST /api/entities is exactly the self-serve create it is
// supposed to use (TD-086). That 403 must read as "new operator — create your first company",
// never as a read-only app or an outage. FE-only: detection + a form; authorization stays
// entirely server-side (the server namespaces member codes + grants ownership atomically).
function checkNewOperator(){
  if (!(window.flApi && flApi.authed && flApi.authed() && flApi.callX)) return;   // demo/local: skip
  flApi.callX('GET', '/api/entities').then(r => {
    if (!r) return;
    const isNew = r.status === 403 || (r.ok && Array.isArray(r.data) && r.data.length === 0);
    // !! so the initial undefined doesn't force a redundant full home re-render for granted users
    if (!!STATE.newOperator !== isNew){ STATE.newOperator = isNew; renderHome(); }
  }).catch(()=>{});
}

function newOperatorCard(){
  const inSty = 'background:#0f1520;border:1.5px solid #2a3446;color:#e5e7eb;border-radius:8px;'+
                'padding:9px 11px;font-size:13px;font-family:inherit;min-width:210px';
  return '<section class="grp" id="newop-card" style="border:1.5px solid var(--accent,#10b981);'+
      'border-radius:12px;padding:16px 18px;margin-bottom:14px">'+
    '<div style="font-size:16px;font-weight:800;margin-bottom:4px">🏢 Create your first company</div>'+
    '<div class="note" style="margin-bottom:12px">Welcome! Your account is live, but it has no companies yet. '+
      'Add your first one below — <b>you own it</b>, and the whole board builds from there. '+
      'Prefer a guided walk-through? <a href="./onboarding/" style="color:var(--accent,#10b981)">Get set up →</a></div>'+
    '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">'+
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600">LEGAL NAME'+
        '<input id="newop-name" placeholder="e.g. MY COMPANY LLC" style="'+inSty+'"></label>'+
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600">SHORT CODE'+
        '<input id="newop-code" placeholder="auto-suggested" style="'+inSty+';min-width:130px"></label>'+
      '<button type="button" id="newop-create" style="background:var(--accent,#10b981);color:#04110b;'+
        'border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:800;cursor:pointer;'+
        'font-family:inherit">Create company</button>'+
    '</div>'+
    '<div id="newop-msg" class="note" style="min-height:16px;margin-top:8px"></div></section>';
}

function newOperatorCreate(){
  const name = ($('newop-name').value||'').trim(), code = ($('newop-code').value||'').trim();
  const msg = $('newop-msg'), btn = $('newop-create');
  if (!name || !code){ msg.innerHTML = '<b style="color:#ef4444">Name and code are both required.</b>'; return; }
  btn.disabled = true; msg.textContent = 'Creating…';
  flApi.callX('POST', '/api/entities', { code: code, name: name, legal_form: 'LLC', primary_bank: 'Altra' })
    .then(r => {
      btn.disabled = false;
      if (!r.ok){
        // Honest per-status copy — a policy refusal is never blamed on the network, and vice versa.
        const why = r.status === 409 ? 'That code already exists — pick another.'
          : r.status === 403 ? esc((r.data && r.data.detail) || 'That code prefix is reserved — pick another.')
          : r.status === 422 ? 'Check the fields — name and code are required.'
          : r.status ? 'Create failed (HTTP '+r.status+') — try again.'
          : 'Service unreachable — nothing was saved; your entries are still here, retry in a moment.';
        msg.innerHTML = '<b style="color:#ef4444">'+why+'</b>';
        return;
      }
      msg.innerHTML = '<b style="color:var(--accent,#10b981)">✓ '+esc(r.data.name||name)+' created — you own it.</b> Opening your board…';
      setTimeout(() => { STATE.newOperator = false; renderHome(); fetchAll(); }, 900);
    });
}

// Delegated (survives every home re-render): create click + code auto-suggest from the name.
document.addEventListener('click', e => {
  if (e.target && e.target.id === 'newop-create') newOperatorCreate();
});
document.addEventListener('input', e => {
  if (!e.target) return;
  if (e.target.id === 'newop-code') e.target.dataset.touched = e.target.value.trim() ? '1' : '';
  if (e.target.id === 'newop-name'){
    const c = $('newop-code');
    if (c && !c.dataset.touched){
      c.value = e.target.value.toUpperCase().replace(/\b(LLC|INC|L\.L\.C\.|CORP)\b\.?/g,'')
        .replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,12);
    }
  }
});

function renderHome(){
  const groups = STATE.registry.groups || [];
  const collapsed = collapsedSet();
  let html = '';
  if (STATE.newOperator) html += newOperatorCard();   // first-run: create form, never "read-only"
  let firstCard = true;
  const locked = !boardUnlocked();      // Phase 2: locked until explored or setup-complete
  const LIVE_AREA = 'admin';            // only Administration is live until setup completes
  groups.forEach(grp => {
    const ls = layersInGroup(grp.id);
    if (!ls.length) return;
    const gs = GROUP_STYLE[grp.id] || {};
    const ico = gs.ico ? '<span class="grp-ico">'+gs.ico+'</span>' : '';

    // Phase 3 progressive unlock: an area is LIVE when the board's unlocked, when it's the always-live
    // Administration area, or when this specific area has been activated (manual OR via TARS) — both
    // modes set fl_area_active_<group>. A dormant area is greyed but CLICKABLE: it opens "Set up [area]".
    const areaLive = !locked || grp.id === LIVE_AREA || areaActive(grp.id);
    if (!areaLive){
      html += '<section class="grp grp-locked" data-group="'+esc(grp.id)+'">'+
        '<button type="button" class="grp-head grp-setup-open" data-setup-area="'+esc(grp.id)+'">'+
          '<span class="grp-toggle-locked">'+ico+
            '<span class="grp-label">'+esc(grp.label||grp.id)+'</span>'+
            '<span class="grp-lock">🔒 click to set up</span>'+
          '</span></button></section>';
      return;
    }

    let body;
    const adminPartial = locked && grp.id === LIVE_AREA && !areaActive('admin');
    if (adminPartial){
      // First-run Admin: the source-of-truth tiles whose data the Document Navigator already shows
      // live (Personal Info / Accounts / Loans / Vendors) are reachable alongside it (TD-108 — the
      // Navigator showed the data while its edit tiles read "set up to unlock", which was backwards);
      // the rest stay locked until Admin is activated (manual or TARS).
      const ADMIN_LIVE = ['document-navigator', 'personal-information', 'accounts-banking',
                          'loans-lenders', 'vendors-professionals', 'feedback'];
      body = '<div class="gridA">'+ls.map(l => ADMIN_LIVE.indexOf(l.id) >= 0 ? artTile(l) : lockedTile(l)).join('')+'</div>';
    }
    else if (grp.id === 'brief')       body = renderBriefGroup(ls);
    else if (grp.id === 'market')      body = renderMarketGroup(ls);
    else if (grp.render === 'card')  { body = renderCardGroup(ls, firstCard); firstCard = false; }
    else {                             // glance (overview): data tiles as value tiles, static tiles as cards
      const dataT = ls.filter(l => !(l.data && l.data.type === 'static'));
      const cardT = ls.filter(l =>  (l.data && l.data.type === 'static'));
      body = '<div class="grid2">'+dataT.map(tileShell).join('')+'</div>';
      if (cardT.length) body += '<div class="gridA" style="margin-top:12px">'+cardT.map(artTile).join('')+'</div>';
    }
    // Per-area employee strip (hireable areas only) — shows hire/skip state + opens the setup panel.
    const emp = areaEmployee(grp.id);
    if (emp && !emp.always && !adminPartial && !isDemoAccount()){
      const h = areaHire(grp.id);
      const st = h==='hire' ? '<span class="emp-on">🤝 '+esc(emp.name)+' hired</span>'
               : h==='skip' ? '<span class="emp-off">'+esc(emp.name)+' · manual</span>'
               :              '<span class="emp-q">'+esc(emp.name)+' available to hire</span>';
      body = '<div class="area-emp">'+st+'<button type="button" class="area-emp-btn" data-setup-area="'+esc(grp.id)+'">⚙ Set up / employee</button></div>'+body;
    }
    const isCol = locked ? false : collapsed.has(grp.id);
    const styleAttr = gs.a ? ' style="--ga:'+gs.a+';--gabg:'+gs.bg+'"' : '';
    html += '<section class="grp'+(isCol?' collapsed':'')+'" data-group="'+esc(grp.id)+'"'+styleAttr+'>'+
      '<div class="grp-head">'+
        '<button type="button" class="grp-toggle" data-grp="'+esc(grp.id)+'">'+
          ico+'<span class="grp-label">'+esc(grp.label||grp.id)+'</span><span class="grp-chev">▾</span>'+
        '</button>'+
        '<span class="grp-srcs" data-srcgrp="'+esc(grp.id)+'">'+groupChipsInner(grp.id)+'</span>'+
      '</div>'+
      '<div class="grp-body">'+body+'</div></section>';
  });
  $('home').innerHTML = html;
  // initial paint of data-bound tiles (skeleton → fills when data lands)
  refreshDataTiles();
  bindTileClicks();
  bindSetupClicks();
  bindMarketPicker();
  bindGroupHeaders();
  bindBrief();
}

/* ── DAILY BRIEF lasso — bullet items (expand + discuss w/ TARS), a Needs-Attention
   section, and the Punch List + Recurring tiles docked at the bottom. ── */
function renderBriefGroup(ls){
  const ai = STATE.tenant.ai_summary || {};
  const r = STATE.briefRouter || { attn:[], brief:[] };
  // Honesty (TD-135): until the brief is LIVE (ai.live — wired to real feeds/a model), emit NOTHING
  // here. Both the router items (reference-stub-derived) and the static ai_summary lines are
  // placeholder figures, not this account's real data. When not live we show an honest note only
  // (below) and let the live tiles carry the real reads.
  const live = !!ai.live;
  let attn = live ? (r.attn || []).concat(ai.attention || []) : [];   // routed (red) first, then static
  let brief = live ? (r.brief || []).concat(ai.brief || []) : [];
  // Member scoping (UI only — TD-101): a scoped member only sees brief items routed to a tile they can see.
  if (STATE.role === 'member' && STATE.user && STATE.user.access) {
    const vis = {}; visibleLayers().forEach(l => { vis[l.id] = 1; });
    const ok = it => !it.open || vis[it.open];
    attn = attn.filter(ok); brief = brief.filter(ok);
  }
  let h = '';
  const emerg = attn.filter(it => it.emergency);
  const rest  = attn.filter(it => !it.emergency);
  if (emerg.length){
    h += '<div class="brief-h" style="color:#fff;background:#b91c1c;border-radius:8px;padding:6px 11px;margin:2px 0 7px;font-weight:800;letter-spacing:.04em">🚨 EMERGENCY — DISPATCH NOW</div>' + emerg.map((it,i)=>briefItem(it,'e'+i,true)).join('');
  }
  if (rest.length){
    h += '<div class="brief-h urg">⚠ NEEDS ATTENTION</div>' + rest.map((it,i)=>briefItem(it,'a'+i,true)).join('');
  }
  if (brief.length) h += '<div class="brief-h">TODAY’S BRIEF</div>' + brief.map((it,i)=>briefItem(it,'b'+i,false)).join('');
  if (!live) h += '<div class="src-note" style="margin:8px 2px 4px">'+esc(ai.note||'The daily brief goes live once TARS is wired to your feeds — until then, the tiles below read your live data directly.')+'</div>';
  // Punch List + Recurring docked at the bottom
  if (ls.length) h += '<div class="gridA" style="margin-top:12px">'+ls.map(artTile).join('')+'</div>';
  return h;
}
function briefItem(it, id, urgent){
  var avStyle='display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);color:var(--purple,#b9a7ff);font-size:9px;font-weight:800;margin-right:3px';
  function chip(l){ return l ? '<span class="bi-route" style="margin-left:6px;font-size:11px;color:var(--mut,#9aa3b2);font-weight:700;white-space:nowrap"><span style="'+avStyle+'">'+esc(l.avatar||'?')+'</span>'+esc(l.name)+'</span>' : ''; }
  var routed = chip(it.lead) + chip(it.co);
  var emStyle = it.emergency ? ' style="border-left:3px solid #ef4444;background:rgba(239,68,68,.08);border-radius:6px;padding-left:9px"' : '';
  var openBtn = it.open ? '<button type="button" class="bi-open" data-open="'+esc(it.open)+'" style="margin-right:8px;background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--fg,#e8e8ea);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer">Open '+esc(it.lead?it.lead.name:it.open)+' ↗</button>' : '';
  // Real tap-to-send affordance for items that carry recipients (e.g. the maintenance EMERGENCY alert).
  // Opens the device SMS/email app prefilled; automated dispatch is the backend lane.
  var alertBtns='';
  if (it.alert && (it.alert.sms || it.alert.email)){
    var _b=encodeURIComponent(it.alert.body||it.t||''), _s=encodeURIComponent(it.alert.subject||it.t||'');
    var _em=!!it.emergency, _base='display:inline-flex;align-items:center;gap:4px;margin-right:8px;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:700;text-decoration:none;';
    var _smsS=_base+(_em?'color:#fff;background:#b91c1c;border:1px solid #ef4444':'color:var(--fg,#e8e8ea);background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a)');
    var _emlS=_base+(_em?'color:#fff;background:#7f1d1d;border:1px solid #ef4444':'color:var(--fg,#e8e8ea);background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a)');
    var _lab=_em?' now':'';
    if (it.alert.sms) alertBtns += '<a class="bi-sms" href="sms:'+esc(it.alert.sms)+'?&amp;body='+_b+'" style="'+_smsS+'">📲 Text'+_lab+'</a>';
    if (it.alert.email) alertBtns += '<a class="bi-email" href="mailto:'+esc(it.alert.email)+'?subject='+_s+'&amp;body='+_b+'" style="'+_emlS+'">✉️ Email'+_lab+'</a>';
    alertBtns += '<span style="font-size:10.5px;color:var(--mut,#9aa3b2);margin-right:8px">opens your app, prefilled · auto-dispatch lands with the backend</span>';
  }
  return '<div class="brief-item'+(urgent?' urg':'')+'"'+emStyle+' data-briefkey="'+esc(id)+'">'+
    '<button type="button" class="bi-head">'+
      '<span class="bi-dot"></span>'+
      '<span class="bi-t">'+esc(it.t)+'</span>'+
      routed+
      '<span class="bi-chev">▾</span>'+
    '</button>'+
    '<div class="bi-body">'+
      '<p>'+esc(it.d||'')+'</p>'+
      alertBtns+
      openBtn+
      '<button type="button" class="bi-ask" data-ask="'+esc(it.t)+'">💬 Discuss with TARS</button>'+
    '</div>'+
  '</div>';
}
function bindBrief(){
  document.querySelectorAll('.brief-item .bi-head').forEach(b => {
    if (b.__b) return; b.__b = true;
    b.addEventListener('click', () => b.closest('.brief-item').classList.toggle('open'));
  });
  document.querySelectorAll('.brief-item .bi-ask').forEach(b => {
    if (b.__b) return; b.__b = true;
    b.addEventListener('click', e => { e.stopPropagation(); askTarsAbout(b.getAttribute('data-ask')); });
  });
  document.querySelectorAll('.brief-item .bi-open').forEach(b => {
    if (b.__b) return; b.__b = true;
    b.addEventListener('click', e => { e.stopPropagation(); var id=b.getAttribute('data-open'); if (id && typeof openLayer==='function') openLayer(id); });
  });
}
function askTarsAbout(topic){
  if (!window.Agents) return;
  Agents.openGlobal();
  const i = $('ginput'), s = $('gsend');
  if (i && s){ i.value = 'About the brief — “'+topic+'”: what do I need to know and what should I do?'; s.click(); }
}

function bindGroupHeaders(){
  document.querySelectorAll('.grp-toggle').forEach(h => {
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
  const step = l.step ? '<span class="stepb">'+esc(l.step)+'</span>' : '';
  return '<button type="button" class="'+cls+'" data-tile="'+esc(l.id)+'">'+corner+step+
    '<div class="ico">'+esc(l.icon||'▫')+'</div>'+
    '<div class="nm">'+esc(l.title)+'</div>'+
    '<div class="ds">'+esc(l.desc||'')+'</div></button>';
}

// A greyed, inert tile for the locked first-run board. No data-tile, so bindTileClicks skips it.
function lockedTile(l){
  return '<button type="button" class="art disabled locked-tile" disabled aria-disabled="true">'+
    '<span class="soon">🔒</span>'+
    '<div class="ico">'+esc(l.icon||'▫')+'</div>'+
    '<div class="nm">'+esc(l.title)+'</div>'+
    '<div class="ds">set up to unlock</div></button>';
}

/* ── MARKET group: county picker + market tiles + full-width Portfolio ── */
function renderMarketGroup(ls){
  const portfolio = ls.find(l => l.id === 'portfolio');
  // market-DATA tiles (FRED/REV/CEN/gap) vs DEAL card tiles (static, with employees)
  const dataTiles = ls.filter(l => l.id !== 'portfolio' && !(l.data && l.data.type === 'static'));
  const dealCards = ls.filter(l => (l.data && l.data.type === 'static'));
  // State + County/Parish cascade
  const picker = '<div class="pickrow">'+
    '<select class="picker" id="state-picker" aria-label="State"></select>'+
    '<select class="picker" id="county-picker" aria-label="County or parish"></select></div>';
  // split market value tiles: first 4 in a grid4, remainder in grid2 (mirrors the visual target)
  const top = dataTiles.slice(0,4), rest = dataTiles.slice(4);
  let h = '<div class="mkt-intro">Your area at a glance — context, not chores. Tap any tile to see what it means.</div>' +
    picker + '<div class="grid4">'+top.map(tileShell).join('')+'</div>';
  if (rest.length) h += '<div class="grid2" style="margin-top:10px">'+rest.map(tileShell).join('')+'</div>';
  // gap explanation note (from the gap layer's note, if present)
  const gap = dataTiles.find(l => l.data && l.data.source==='vacancy_gap');
  if (gap && gap.note) h += '<div class="note" id="market-note"><b>Why two vacancy numbers?</b> '+esc(gap.note)+'</div>';
  // "Information Tiles" — catalog of more market indicators you can add to this lasso
  h += '<button type="button" class="infotiles" data-tile="market-info-catalog">'+
    '<span class="it-l"><span class="it-ico">➕</span><span class="it-tx"><b>Information Tiles</b>'+
    '<span class="it-d">add more market indicators to this section</span></span></span>'+
    '<span class="it-arrow">▸</span></button>';
  // Portfolio (DealCheck) renders full-width under the market tiles
  if (portfolio) h += '<div style="margin-top:12px">'+tileShell(portfolio)+'</div>';
  // Deals — the deal-flow tiles (Finder → Analyzer → Decider) live in this lasso now
  if (dealCards.length) h += '<div class="subhead">DEALS</div><div class="gridA">'+dealCards.map(artTile).join('')+'</div>';
  return h;
}

const STATE_NAMES = { TX:'Texas', LA:'Louisiana', OK:'Oklahoma', AR:'Arkansas', NM:'New Mexico', MS:'Mississippi' };
function countyOptions(){
  // union of counties present in BOTH market files, so every market tile has a value
  const rev = STATE.data.reventure && STATE.data.reventure.counties || {};
  const cen = STATE.data.census && STATE.data.census.counties || {};
  const keys = Object.keys(rev).filter(k => cen[k]);
  return keys.map(k => ({ key:k, label: (rev[k] && rev[k].label) || (cen[k] && cen[k].label) || k, state: (rev[k] && rev[k].state) || 'TX' }));
}
function stateOptions(){ const seen={}, out=[]; countyOptions().forEach(o=>{ if(!seen[o.state]){ seen[o.state]=1; out.push(o.state); } }); return out; }

function bindMarketPicker(){
  const ssel = $('state-picker'), csel = $('county-picker');
  if (!csel) return;
  const opts = countyOptions();
  if (!opts.length){
    if (ssel){ ssel.innerHTML='<option>…</option>'; ssel.disabled=true; }
    csel.innerHTML='<option>loading…</option>'; csel.disabled=true; return;
  }
  const states = stateOptions();
  // default the State from the tenant's default county
  if (!STATE.stateSel || !states.includes(STATE.stateSel)){
    const defC = (STATE.tenant.market && STATE.tenant.market.default_county) || opts[0].key;
    STATE.stateSel = (opts.find(o=>o.key===defC) || opts[0]).state;
  }
  if (ssel){
    ssel.disabled = false;
    ssel.innerHTML = states.map(s => '<option value="'+esc(s)+'"'+(s===STATE.stateSel?' selected':'')+'>'+esc(STATE_NAMES[s]||s)+'</option>').join('');
    ssel.onchange = () => {
      STATE.stateSel = ssel.value;
      const inSt = opts.filter(o=>o.state===STATE.stateSel);
      STATE.county = inSt[0] ? inSt[0].key : null;
      bindMarketPicker(); refreshDataTiles();
    };
  }
  // counties for the selected state
  const inState = opts.filter(o => o.state === STATE.stateSel);
  if (!STATE.county || !inState.find(o=>o.key===STATE.county)){
    const defC = (STATE.tenant.market && STATE.tenant.market.default_county);
    STATE.county = (defC && inState.find(o=>o.key===defC)) ? defC : (inState[0] ? inState[0].key : null);
  }
  csel.disabled = false;
  csel.innerHTML = inState.map(o => '<option value="'+esc(o.key)+'"'+(o.key===STATE.county?' selected':'')+'>📍 '+esc(o.label)+'</option>').join('');
  csel.onchange = () => { STATE.county = csel.value; refreshDataTiles(); };
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
  refreshGroupChips();   // repaint source connection chips as live data lands
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

/* FINANCIAL HEALTH — FL API (plain-English read of the capital rules) */
function tileCapitalRules(l){
  const lbl = esc(l.title || 'FINANCIAL HEALTH');
  const fl = STATE.data.fl;
  if (STATE.status.fl === 'down'){
    const inner = '<div class="top"><span class="lbl">'+lbl+'</span>'+badge('b-red','OFFLINE')+'</div>'+
      '<div class="big muted">Can’t reach it</div><div class="sub">showing last known · never faked</div>';
    return tileWrap(l, inner, !!l.drilldown);
  }
  if (!fl){ return tileWrap(l, '<div class="top"><span class="lbl">'+lbl+'</span>'+badge('b-gray','…')+'</div><div class="big muted">Checking…</div>', !!l.drilldown); }
  const cr = fl.capital_rules || {};
  const keys = ['ltv','dscr','liquidity','per_door'];
  const statuses = keys.map(k => (cr[k]&&cr[k].status)||'UNKNOWN');
  let bcls, btxt, big;
  // roll-up colour: worst KNOWN status wins. red > yellow > green.
  // white (b-white) only when NOTHING is known yet (all UNKNOWN) = no info given.
  if (statuses.includes('RED')){ bcls='b-red'; btxt='ACTION NEEDED'; big='Needs action'; }
  else if (statuses.includes('YELLOW')){ bcls='b-yellow'; btxt='HEADS UP'; big='Worth a look'; }
  else if (statuses.includes('GREEN')){ bcls='b-green'; btxt='HEALTHY'; big='Healthy'; }
  else { bcls='b-white'; btxt='NO DATA YET'; big='No data yet'; }   // all UNKNOWN → white
  const nPend = statuses.filter(s=>s==='UNKNOWN').length;
  const sub = nPend ? ('Debt · loan coverage · cash cushion · per-door ('+nPend+' still setting up)') : 'Debt · loan coverage · cash cushion · per-door';
  const inner = '<div class="top"><span class="lbl">'+lbl+'</span>'+badge(bcls,btxt)+'</div>'+
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

// calm status pill (Version A): "In range" / "Just context" / "Healthy" etc.
function marketTag(l){
  if (!l.tag) return '';
  const tone = l.tag.tone || 'fyi';
  return '<span class="mtag t-'+esc(tone)+'"><span class="mtdot"></span>'+esc(l.tag.label)+'</span>';
}

function tileMarketValue(l, src){
  const stag = l.source_tag || '';
  const tagCls = {REV:'src-rev',CEN:'src-cen'}[stag]||'src-rev';
  const head = '<div class="top"><span class="lbl">'+esc(l.title)+'</span><span class="srcpill '+tagCls+'">'+esc(stag)+'</span></div>';
  if (!src || !src.counties || !STATE.county || !src.counties[STATE.county]){
    return tileWrap(l, head+'<div class="big muted">—</div><div class="mean">'+esc(l.plain||'awaiting snapshot')+'</div>'+marketTag(l), !!l.drilldown);
  }
  const c = src.counties[STATE.county];
  let val='—';
  if (l.data.select==='cap_rate'){ val=pct(c.cap_rate&&c.cap_rate.value); }
  else if (l.data.select==='vacancy_rate'){ val=pct(c.vacancy_rate&&c.vacancy_rate.value); }
  else if (l.data.select==='rental_vacancy_rate_pct'){ val=pct(c.rental_vacancy_rate_pct); }
  return tileWrap(l, head+'<div class="big">'+esc(val)+'</div><div class="mean">'+esc(l.plain||'')+'</div>'+marketTag(l), !!l.drilldown);
}

function tileMarketAbsent(l, tag){
  const tagCls = {FRED:'src-fred'}[tag]||'src-fl';
  return tileWrap(l,
    '<div class="top"><span class="lbl">'+esc(l.title)+'</span><span class="srcpill '+tagCls+'">'+esc(tag)+'</span></div>'+
    '<div class="big muted">—</div><div class="mean">'+esc(l.plain||'')+'</div>'+
    '<span class="mtag t-connect"><span class="mtdot"></span>Tap to connect</span>', !!l.drilldown);
}

/* CENSUS vs REV GAP — computed */
function tileGap(l){
  const rev = STATE.data.reventure, cen = STATE.data.census, k = STATE.county;
  const head = '<div class="top"><span class="lbl">'+esc(l.title)+'</span></div>';
  if (!rev||!cen||!k||!rev.counties[k]||!cen.counties[k]){
    return tileWrap(l, head+'<div class="big muted">—</div><div class="sub">awaiting snapshot</div>', !!l.drilldown);
  }
  const total = rev.counties[k].vacancy_rate && rev.counties[k].vacancy_rate.value;
  const rental = cen.counties[k].rental_vacancy_rate_pct;
  if (total==null||rental==null) return tileWrap(l, head+'<div class="big muted">—</div>', !!l.drilldown);
  const gap = Math.round((rental-total)*10)/10;
  const sign = gap>0?'+':'';
  return tileWrap(l, head+'<div class="big" style="color:var(--teal)">'+sign+gap+'pp</div><div class="mean">'+esc(l.plain||'seasonal stock')+'</div>'+marketTag(l), !!l.drilldown);
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
  if (flUrl && window.flApi && flApi.call){
    // H5: the Capital-Rules feed is the AUTHED, per-principal /api/dashboard/scoped (was the unauth
    // global /latest, now admin-only). flApi.call carries the JWT; null = no session/error -> down.
    flApi.call('GET', '/api/dashboard/scoped')
      .then(d=>{ if(!d){ STATE.status.fl='down'; refreshDataTiles(); updLiveBar(); return; }
        STATE.data.fl=d; STATE.status.fl='ok'; try{localStorage.setItem(STATE.lastGoodKey, JSON.stringify({ts:d.generated_at}));}catch(e){} refreshDataTiles(); updLiveBar(); })
      .catch(()=>{ STATE.status.fl='down'; refreshDataTiles(); updLiveBar(); });
  }
  // committed snapshots (graceful absence)
  loadSnapshot('./data/REVENTURE_LATEST.json',      d=>STATE.data.reventure=d);
  loadSnapshot('./data/CENSUS_VACANCY_LATEST.json', d=>STATE.data.census=d);
  // DealCheck + FRED snapshots are produced by their scraper skills and committed to data/ when they
  // first run — they're NOT in the repo yet. Fetching an absent optional snapshot logs an uncatchable
  // "404" console error on every board load (loadSnapshot already .catches it, so the chips correctly
  // show "not connected"); we just don't request it until it exists. Re-enable each line when its
  // scraper commits data/DEALCHECK_PORTFOLIO.json / data/FRED_LATEST.json (chips flip to connected then).
  if (window.FL_SNAPSHOTS_DEALCHECK) loadSnapshot('./data/DEALCHECK_PORTFOLIO.json', d=>STATE.data.dealcheck=d);
  if (window.FL_SNAPSHOTS_FRED)      loadSnapshot('./data/FRED_LATEST.json',         d=>STATE.data.fred=d);
}
function loadSnapshot(url, set){
  fetch(url, {cache:'no-store'})
    .then(r=>{ if(!r.ok) throw 0; return r.json(); })
    .then(d=>{ set(d); refreshDataTiles(); })
    .catch(()=>{ /* absent → tiles already show graceful state */ });
}

function updLiveBar(){
  const live = $('live-wrap');
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
  if (id === 'employees') return openEmployeesManager();   // central Employees manager (modal, not a drill-in)
  if (id === 'market-info-catalog') return openDrillURL('./layers/market-catalog/artifact/index.html','Information Tiles','➕');
  const l = layerById(id); if (!l) return;
  if (l.kind === 'add') return openAddLayer();
  if (l.status_rules === 'soon') return openSoon(l);
  if (!l.drilldown) return;                         // glance-only tile (market/system)
  openDrill(l);
}

// open an arbitrary drill-in URL (used by the Market "Information Tiles" catalog)
function openDrillURL(url, title, icon){
  const panel = $('panel');
  STATE.openLayer = null;
  panel.innerHTML =
    '<div class="pbar"><div class="pbar-l"><button class="back" type="button" id="drill-back">← Back</button><div class="ptitle">'+esc(icon||'')+' '+esc(title)+'</div></div></div>'+
    '<iframe class="drillframe" id="drill-iframe" src="'+esc(url)+'" title="'+esc(title)+'" loading="lazy"></iframe>';
  $('drill-back').onclick = closeDrill;
  showOverlay('ov');
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
  let src = l.drilldown;
  // market-indicator explainer: pass the currently-selected county so it highlights yours
  if (src.indexOf('market-info') > -1 && STATE.county) src += (src.indexOf('?')>-1?'&':'?') + 'c=' + encodeURIComponent(STATE.county);
  panel.innerHTML = pbar(l) +
    '<iframe class="drillframe" id="drill-iframe" src="'+esc(src)+'" title="'+esc(l.title)+'" loading="lazy"></iframe>';
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
  window.addEventListener('message', e => {
    const d = e.data || {};
    if (d && d.type === 'tcc:purchase') renderHome();
    // the Entities tile just created a first company for a new operator -> drop the hero card
    if (d && d.type === 'tcc:newop-created'){
      if (STATE.newOperator){ STATE.newOperator = false; renderHome(); }
      fetchAll();
    }
    // cross-tile nav: a drill-in iframe asks the shell to open another tile
    // (front-end cross-reference only — artifacts post {type:'tcc:open-layer', layer:'<id>'})
    if (d && d.type === 'tcc:open-layer' && typeof d.layer === 'string') openLayer(d.layer);
    // a tile hands a primed prompt to the global TARS chat (e.g. Strategy in Learn, Coach & Strategy)
    if (d && d.type === 'tcc:ask-tars' && typeof d.prompt === 'string' && window.Agents){
      Agents.openGlobal();
      const gi = $('ginput'), gs = $('gsend');
      if (gi && gs){ gi.value = d.prompt; gs.click(); }
    }
  });
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

/* Phase 3 dual-mode setup API — the TARS chips (agents.js) call THESE to execute setup AS THE
   SIGNED-IN USER (create entities, turn areas on, hire/skip employees, file to Document Navigator).
   This is the write-capable, user-driven path; the read-only advisor stays read-only. Both modes
   (manual board clicks + TARS chips) share this same engine, so they're fully interchangeable. */
window.FLSetup = {
  areas: function(){ return (STATE.registry.groups||[]).filter(function(g){ return layersInGroup(g.id).length; })
    .map(function(g){ return { id:g.id, label:g.label, employee:areaEmployee(g.id), active:areaActive(g.id), hire:areaHire(g.id) }; }); },
  areaEmployee: areaEmployee, areaActive: areaActive, areaHire: areaHire,
  activateArea: activateArea, hireArea: hireArea,
  openAreaSetup: openAreaSetup, openEmployeesManager: openEmployeesManager,
  restartSetup: restartSetup, completeSetup: completeSetup,
  fileToDocNav: fileToDocNav,
  createEntity: function(payload){ return (window.flEntities && flEntities.create) ? flEntities.create(payload) : Promise.resolve(null); },
  createRecord: function(payload){ return (window.flRecords && flRecords.create) ? flRecords.create(payload) : Promise.resolve(null); },
  refresh: refreshBoard
};
