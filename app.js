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
  wireGlobalControls();
  loadBriefRouter();
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
  $('signout-btn').onclick = () => { Auth.signOut(); location.reload(); };

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

  // first-run TARS concierge — top-level greeting + setup offer (once, dismissible).
  // Mirrors the per-tile employee setup, one level up: TARS offers to do it for you,
  // or points to manual / employee setup inside each tile.
  (function(){
    var host = $('tars-btn'); if(!host) return;
    var old = document.getElementById('tars-firstrun'); if(old) old.remove();
    if (STATE.role === 'field') return;            // scoped field role: no concierge
    var done=false; try{ done = localStorage.getItem('fl_tars_firstrun_v1')==='done'; }catch(e){}
    if(done) return;
    var name = esc(g.name||'TARS');
    var el = document.createElement('div');
    el.id = 'tars-firstrun';
    el.style.cssText = 'background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);border-radius:12px;padding:14px 16px;margin:10px 0 4px;line-height:1.55';
    el.innerHTML =
      '<div style="display:flex;gap:10px;align-items:flex-start">'+
        '<span style="flex:0 0 auto">'+tarsSvg(26)+'</span>'+
        '<div style="flex:1">'+
          '<b>'+name+' here — welcome to your Foundation Layer.</b><br>'+
          'When you’re ready to set things up, come to me and I’ll walk through it and do it for you. '+
          'Prefer hands-on? Open any tile and set it up <b>manually</b> — or, if you’ve hired that tile’s <b>employee</b>, let them ask you a few questions and set it up for you.'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:11px">'+
            '<button type="button" class="btn primary" id="tfr-go">Set up with '+name+'</button>'+
            '<button type="button" class="btn" id="tfr-later">I’ll explore first</button>'+
          '</div>'+
        '</div>'+
      '</div>';
    host.parentNode.insertBefore(el, host.nextSibling);
    var go=document.getElementById('tfr-go'), later=document.getElementById('tfr-later');
    if(go) go.onclick=function(){ try{ if(window.Agents && Agents.openGlobal) Agents.openGlobal(); }catch(e){} };
    if(later) later.onclick=function(){ try{ localStorage.setItem('fl_tars_firstrun_v1','done'); }catch(e){} el.remove(); };
  })();

  // header — tenant title only (date / role / sign-out moved up into the ribbon)
  $('head').innerHTML =
    '<h1>'+esc(b.title||STATE.tenant.name||'')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h1>';

  // Daily Brief now renders as its own lasso (renderBriefGroup); hide the legacy summary block.
  $('ai-summary').style.display = 'none';

  // footer
  $('foot').innerHTML = 'Foundation Layer · Command Center · tenant: '+esc(STATE.tenant.name||'')+
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
      '<div class="gate-logo">'+flMark(58)+'</div>'+
      '<h2>'+esc(b.title||STATE.tenant.name||'Foundation Layer')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h2>'+
      '<p class="gate-sub">Your real-estate investing co-pilot.</p>'+
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
      '<a class="gate-link" href="./onboarding/">New here? Get set up →</a>'+
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
  deals:       { a:'#2dd4bf', bg:'rgba(45,212,191,.06)',  ico:'🏗️' },
  it:          { a:'#ec4899', bg:'rgba(236,72,153,.06)',  ico:'🌐' },
  admin:       { a:'#94a3b8', bg:'rgba(148,163,184,.06)', ico:'🗂️' }
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
  FL:'https://api.foundationlayerhq.com/api/dashboard/latest',
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

function renderHome(){
  const groups = STATE.registry.groups || [];
  const collapsed = collapsedSet();
  let html = '';
  let firstCard = true;
  groups.forEach(grp => {
    const ls = layersInGroup(grp.id);
    if (!ls.length) return;
    let body;
    if (grp.id === 'brief')            body = renderBriefGroup(ls);
    else if (grp.id === 'market')      body = renderMarketGroup(ls);
    else if (grp.render === 'card')  { body = renderCardGroup(ls, firstCard); firstCard = false; }
    else {                             // glance (overview): data tiles as value tiles, static tiles as cards
      const dataT = ls.filter(l => !(l.data && l.data.type === 'static'));
      const cardT = ls.filter(l =>  (l.data && l.data.type === 'static'));
      body = '<div class="grid2">'+dataT.map(tileShell).join('')+'</div>';
      if (cardT.length) body += '<div class="gridA" style="margin-top:12px">'+cardT.map(artTile).join('')+'</div>';
    }
    const isCol = collapsed.has(grp.id);
    const gs = GROUP_STYLE[grp.id] || {};
    const styleAttr = gs.a ? ' style="--ga:'+gs.a+';--gabg:'+gs.bg+'"' : '';
    const ico = gs.ico ? '<span class="grp-ico">'+gs.ico+'</span>' : '';
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
  bindMarketPicker();
  bindGroupHeaders();
  bindBrief();
}

/* ── DAILY BRIEF lasso — bullet items (expand + discuss w/ TARS), a Needs-Attention
   section, and the Punch List + Recurring tiles docked at the bottom. ── */
function renderBriefGroup(ls){
  const ai = STATE.tenant.ai_summary || {};
  const r = STATE.briefRouter || { attn:[], brief:[] };
  let attn = (r.attn || []).concat(ai.attention || []);   // routed (red) items first, then any static summary
  let brief = (r.brief || []).concat(ai.brief || []);
  // Member scoping (UI only — TD-101): a scoped member only sees brief items routed to a tile they can see.
  if (STATE.role === 'member' && STATE.user && STATE.user.access) {
    const vis = {}; visibleLayers().forEach(l => { vis[l.id] = 1; });
    const ok = it => !it.open || vis[it.open];
    attn = attn.filter(ok); brief = brief.filter(ok);
  }
  let h = '';
  if (attn.length){
    h += '<div class="brief-h urg">⚠ NEEDS ATTENTION</div>' + attn.map((it,i)=>briefItem(it,'a'+i,true)).join('');
  }
  h += '<div class="brief-h">TODAY’S BRIEF</div>' + brief.map((it,i)=>briefItem(it,'b'+i,false)).join('');
  if (!ai.live) h += '<div class="src-note" style="margin:8px 2px 4px">'+esc(ai.note||'Static for v1.')+'</div>';
  // Punch List + Recurring docked at the bottom
  if (ls.length) h += '<div class="gridA" style="margin-top:12px">'+ls.map(artTile).join('')+'</div>';
  return h;
}
function briefItem(it, id, urgent){
  var avStyle='display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);color:var(--purple,#b9a7ff);font-size:9px;font-weight:800;margin-right:3px';
  function chip(l){ return l ? '<span class="bi-route" style="margin-left:6px;font-size:11px;color:var(--mut,#9aa3b2);font-weight:700;white-space:nowrap"><span style="'+avStyle+'">'+esc(l.avatar||'?')+'</span>'+esc(l.name)+'</span>' : ''; }
  var routed = chip(it.lead) + chip(it.co);
  var openBtn = it.open ? '<button type="button" class="bi-open" data-open="'+esc(it.open)+'" style="margin-right:8px;background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--fg,#e8e8ea);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer">Open '+esc(it.lead?it.lead.name:it.open)+' ↗</button>' : '';
  return '<div class="brief-item'+(urgent?' urg':'')+'" data-briefkey="'+esc(id)+'">'+
    '<button type="button" class="bi-head">'+
      '<span class="bi-dot"></span>'+
      '<span class="bi-t">'+esc(it.t)+'</span>'+
      routed+
      '<span class="bi-chev">▾</span>'+
    '</button>'+
    '<div class="bi-body">'+
      '<p>'+esc(it.d||'')+'</p>'+
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
    // cross-tile nav: a drill-in iframe asks the shell to open another tile
    // (front-end cross-reference only — artifacts post {type:'tcc:open-layer', layer:'<id>'})
    if (d && d.type === 'tcc:open-layer' && typeof d.layer === 'string') openLayer(d.layer);
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
