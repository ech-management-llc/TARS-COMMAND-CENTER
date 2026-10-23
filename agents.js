/* ════════════════════════════════════════════════════════════════
   TCC — Platform v1 · AI EMPLOYEES + MEMORY STORE
   - Global "TARS" employee (sees all layers) + per-layer employees.
   - Pluggable memory-store abstraction (local | cloud | drive) driven
     by config/tenant.json — agent code does NOT change per provider.
   - The conversational backend is an HONEST stub: it reports its scope,
     surfaces REAL data it can actually read, and states plainly that
     free-form answers arrive when a live model is connected. It does
     NOT fabricate figures.
   ════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

let TENANT = null;
let STATE  = null;
// Lane 4b: the live conversation thread id per scope ('all' = global TARS | a layer id).
// The agent service persists each turn to FL Postgres and returns the thread id; we keep it
// to continue the thread and to reload history on a fresh page load.
const convByScope = {};

/* ════════════════════════════════════════════════════════════════
   MEMORY STORE — pluggable abstraction (the anti-relearning substrate)
   Source-of-truth layering (locked): PRIMARY = the storage folder;
   the Document Navigator is the indexed VIEW of that same folder;
   BACKUP = a scheduled mirror. This module is the single seam through
   which every agent reads/appends memory, regardless of provider.
   ════════════════════════════════════════════════════════════════ */
const Memory = {
  cfg(){ return (TENANT && TENANT.memory_store) || { provider:'local', label:'memory store', status:'unconfigured' }; },
  describe(){
    const c = this.cfg();
    const where = c.label ? c.label : (c.location||'memory store');
    return where + ' (' + (c.provider||'local') + ')';
  },
  // load context for an agent scope ('all' = global TARS; or a layer id)
  load(scope){
    const c = this.cfg();
    // v1: the real read happens once the store is wired to the agent model.
    // We honestly report the configured target + status — never invented content.
    return { connected:false, scope:scope, provider:c.provider, label:c.label, status:c.status||'configured' };
  },
  // append a learning back to the store (consent-gated by writeback_mode)
  append(scope, entry){
    const c = this.cfg();
    const mode = c.writeback_mode || 'draft-for-approval';
    try {
      const q = JSON.parse(localStorage.getItem('tcc_mem_queue')||'[]');
      q.push({ scope:scope, entry:entry, mode:mode, at:new Date().toISOString() });
      localStorage.setItem('tcc_mem_queue', JSON.stringify(q.slice(-200)));
    } catch(e){}
    return { queued:true, mode:mode };
  }
};

/* ════════════════════════════════════════════════════════════════
   AGENT BACKEND — honest stub. Returns HTML strings.
   Surfaces real, live facts it can actually read from STATE; otherwise
   says it doesn't have that wired yet. Never fabricates numbers.
   ════════════════════════════════════════════════════════════════ */
const pendingNote = 'I’m the chat surface for this layer — wired to its data and your memory store. Free-form answers turn on when I’m connected to a live model (next step). I won’t make numbers up in the meantime.';

function liveFinanceFacts(){
  const fl = STATE && STATE.data && STATE.data.fl;
  if (!fl) return null;
  const cr = fl.capital_rules || {};
  const liq = cr.liquidity;
  const bits = [];
  if (liq && liq.value!=null) bits.push('Liquidity reads <b>'+window.TCC.fmtMoney(liq.value)+'</b> ('+(liq.status||'—')+(liq.headroom!=null?', '+window.TCC.fmtMoney(liq.headroom)+' over the floor':'')+')');
  const pend = ['ltv','dscr','per_door'].filter(k=>cr[k]&&cr[k].status==='UNKNOWN');
  if (pend.length) bits.push(pend.map(k=>k.toUpperCase().replace('PER_DOOR','PER-DOOR')).join(', ')+' read pending (ledger still on sandbox)');
  return bits.length ? bits.join('. ')+'.' : null;
}

function liveMarketFacts(){
  const s = STATE, k = s && s.county;
  const rev = s && s.data && s.data.reventure, cen = s && s.data && s.data.census;
  if (!k || !rev || !rev.counties[k]) return null;
  const c = rev.counties[k];
  const label = c.label || k;
  let out = label + ': cap rate <b>'+(c.cap_rate?c.cap_rate.value+'%':'—')+'</b>, total vacancy '+(c.vacancy_rate?c.vacancy_rate.value+'%':'—')+' (incl. seasonal)';
  if (cen && cen.counties[k]) out += ', rental vacancy '+cen.counties[k].rental_vacancy_rate_pct+'% (Census ACS)';
  return out + '.';
}

// reply for a per-layer employee
function layerReply(layer, emp, text){
  const t = (text||'').toLowerCase();
  let live = null;
  if (layer.id === 'financials' || layer.id === 'capital-rules') live = liveFinanceFacts();
  else if (layer.group === 'market' || layer.id==='portfolio') live = liveMarketFacts();
  let head = 'I’m '+esc(emp.name)+', the '+esc(emp.role)+' for <b>'+esc(layer.title)+'</b>.';
  if (live) return head+' Here’s what I can read live right now — '+live+' <span style="color:var(--dim)">('+pendingNote+')</span>';
  return head+' '+pendingNote;
}

// honest stub reply for the global TARS employee (used when not signed in / agent offline)
function globalStubReply(text){
  const fin = liveFinanceFacts(), mkt = liveMarketFacts();
  const parts = [];
  if (fin) parts.push('💰 '+fin);
  if (mkt) parts.push('📊 '+mkt);
  const g = (TENANT && TENANT.global_agent) || {};
  let head = 'I’m '+esc(g.name||'TARS')+'. I can see every layer and I load your '+esc(Memory.describe())+' each session.';
  if (parts.length) return head+'<br><br>Live right now:<br>'+parts.join('<br>')+'<br><br><span style="color:var(--dim)">'+pendingNote+'</span>';
  return head+' '+pendingNote;
}

// LIVE global TARS reply (Lane 4a) — hosted read-only advisor when signed in; honest stub otherwise.
// Never fabricates: if the agent isn't reachable or returns nothing, we fall back to the stub.
async function globalReply(text){
  if (window.flAgent && window.flAgent.authed && window.flAgent.authed()){
    let res = null;
    try { res = await flChat('all', text, liveContextHint()); } catch(e){ res = null; }
    if (res && res.answer) return renderAgentAnswer(res);
    // session died mid-use (token expired + refresh failed) -> prompt re-sign-in, not the stub
    if (window.flApi && flApi.authExpired && flApi.authExpired()){
      return 'Your session expired (sign-ins last about an hour). Sign in to the Command Center again to use the live advisor. <span style="color:var(--dim)">I won’t answer from stale data in the meantime.</span>';
    }
    // not signed in to FL / API error / empty -> honest stub (no fabrication)
  }
  return globalStubReply(text);
}
function formatAnswer(s){ return escd(s).replace(/\n/g,'<br>'); }
function liveContextHint(){ try { if (STATE && STATE.openLayer) return 'viewing the '+STATE.openLayer+' tile'; } catch(e){} return ''; }

// Lane 4b: call the live advisor threading the per-scope conversation id; remember the id it
// returns so the next turn continues the same thread (and it survives a reload via hydrateHistory).
async function flChat(scope, text, hint){
  const opts = { scope: scope, conversation_id: convByScope[scope] || null };
  const res = await window.flAgent.chat(text, { scope: scope, hint: hint }, opts);
  if (res && res.conversation_id) convByScope[scope] = res.conversation_id;
  return res;
}

// Load + render a scope's persisted history into a messages container (best-effort, honest).
// Signed-out or hub-unreachable -> leaves the fresh greeting in place (ephemeral session); never
// crashes, never fabricates a turn. Returns true if it rendered prior turns.
async function hydrateHistory(scope, msgsEl){
  if (!msgsEl) return false;
  if (!(window.flAiMemory && window.flApi && flApi.authed && flApi.authed())) return false;
  try {
    const convs = await window.flAiMemory.conversations(scope);
    if (!convs || !convs.length) return false;        // no prior thread -> fresh session
    const conv = convs[0];                            // newest (server orders by updated_at desc)
    const msgs = await window.flAiMemory.messages(conv.id, 50);
    if (!msgs || !msgs.length) return false;
    convByScope[scope] = conv.id;                     // continue this thread on the next send
    let html = '<div class="memline"><span class="pulse"></span> '+esc('Loaded your saved conversation from memory.')+'</div>';
    msgs.forEach(function(m){
      if (m.role === 'user') html += '<div class="emsg u">'+escd(m.content||'')+'</div>';
      else if (m.role === 'assistant') html += '<div class="emsg a">'+formatAnswer(m.content||'')+'</div>';
    });
    msgsEl.insertAdjacentHTML('beforeend', html);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return true;
  } catch(e){ return false; }                          // ephemeral fallback — keep the greeting
}

// shared renderer for a live agent answer (tools_called + truncation note)
function renderAgentAnswer(res){
  let out = formatAnswer(res.answer);
  const names = (res.tools_called||[]).map(function(t){return t.tool;})
    .filter(function(v,i,a){return a.indexOf(v)===i;});
  if (names.length) out += '<div class="memline" style="margin-top:8px"><span class="pulse"></span> read live: '+esc(names.join(', '))+'</div>';
  if (res.truncated) out += '<div style="color:var(--dim);margin-top:6px;font-size:.85em">(Stopped at this request\'s budget — ask something narrower and I\'ll finish.)</div>';
  return out;
}

// hint that focuses a per-layer employee on its area (scope itself is RLS-enforced server-side)
function layerHint(layer, emp){
  return 'The user is working in the '+ (layer.title||layer.id) +' area (layer id: '+layer.id+'). '+
    'Focus your answer on '+ (layer.title||layer.id) +'. You are '+ ((emp&&emp.name)||'the area assistant') +
    ', the '+ ((emp&&emp.role)||'advisor') +' for this area.';
}

// LIVE per-layer employee reply (Lane 4a) — same hosted advisor, scoped to this area; honest
// fallback to the layer stub when signed out / agent unreachable. Never fabricates.
async function layerAgentReply(layer, emp, text){
  if (window.flAgent && window.flAgent.authed && window.flAgent.authed()){
    let res = null;
    try { res = await flChat(layer.id, text, layerHint(layer, emp)); } catch(e){ res = null; }
    if (res && res.answer) return renderAgentAnswer(res);
    if (window.flApi && flApi.authExpired && flApi.authExpired())
      return 'Your session expired (sign-ins last about an hour). Sign in to the Command Center again to use the live advisor. <span style="color:var(--dim)">I won’t answer from stale data in the meantime.</span>';
    // not signed in / API error / empty -> honest stub (no fabrication)
  }
  return layerReply(layer, emp, text);
}

/* ════════════════════════════════════════════════════════════════
   IN-TILE VIEW CONFIG — the per-layer employee reshapes the tile in
   plain language ("add a late-fee column", "drop the trend chart").
   - Edits the layer's VIEW config only (columns/sections/widgets);
     never the underlying data.
   - Persisted via the memory store so it sticks across sessions/devices.
   - Supports undo. Scoped to the layer. Gated by role (canEdit).
   ════════════════════════════════════════════════════════════════ */
const ViewConfig = {
  key(layerId){ return 'tcc_viewcfg_' + layerId; },
  get(layerId){ try { return JSON.parse(localStorage.getItem(this.key(layerId)) || '{"ops":[]}'); } catch(e){ return { ops:[] }; } },
  save(layerId, cfg){
    try { localStorage.setItem(this.key(layerId), JSON.stringify(cfg)); } catch(e){}
    // also persist the change to the tenant's memory store (per-layer scope)
    Memory.append(layerId, { kind:'view-config', ops: cfg.ops });
  },
  apply(layerId, op){ const c = this.get(layerId); c.ops.push(op); this.save(layerId, c); return c; },
  undo(layerId){ const c = this.get(layerId); const removed = c.ops.pop(); this.save(layerId, c); return { cfg:c, removed:removed }; },
  // role gate (stub until auth lands): Owner/Admin may edit the view; Read-only may not.
  canEdit(){ const role = (TENANT && TENANT.current_role) || 'owner'; return role === 'owner' || role === 'admin' || role === 'staff'; }
};

// natural-language → a view op (or null)
function parseViewCommand(text){
  const t = (text||'').trim().toLowerCase();
  if (/^(undo|revert)\b/.test(t)) return { type:'undo' };
  const m = t.match(/\b(add|show|include|remove|drop|hide|delete|take out)\b\s+(?:a |an |the |my )?(.+?)(?:\s+(column|columns|section|sections|field|fields|widget|chart|graph|tab|panel))?[.?!]*$/);
  if (!m) return null;
  const verb = m[1];
  const noun = m[3] || 'column';
  const target_type = /(section|tab|panel)/.test(noun) ? 'section' : /(widget|chart|graph)/.test(noun) ? 'widget' : 'col';
  const label = m[2].trim().replace(/\b(column|section|field|widget|chart|graph|tab|panel)s?\b/g,'').trim() || m[2].trim();
  const target = label.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  const type = /^(add|show|include)$/.test(verb) ? 'add' : 'remove';
  return { type, target_type, target, label };
}

// push the saved view config into the open drill-in iframe
function pushViewConfig(layerId){
  const fr = document.getElementById('drill-iframe');
  if (!fr || !fr.contentWindow) return;
  const cfg = ViewConfig.get(layerId);
  try { fr.contentWindow.postMessage({ type:'tcc:viewcfg', layer:layerId, ops: cfg.ops }, '*'); } catch(e){}
}

// route a layer-chat message: view-edit command first, else a normal reply
function handleLayerMessage(layer, emp, text){
  const cmd = parseViewCommand(text);
  if (!cmd) return layerReply(layer, emp, text);
  if (!ViewConfig.canEdit())
    return 'You have view-only access on this tile, so I can’t change its layout — an Owner or Admin can.';
  if (cmd.type === 'undo'){
    const { removed } = ViewConfig.undo(layer.id);
    pushViewConfig(layer.id);
    if (!removed) return 'Nothing to undo on the ' + esc(layer.title) + ' view.';
    const back = removed.type === 'add' ? 'removed' : 'restored';
    return 'Reverted — ' + back + ' the <b>' + esc(removed.label) + '</b> ' + removed.target_type + '.';
  }
  ViewConfig.apply(layer.id, cmd);
  pushViewConfig(layer.id);
  const did = cmd.type === 'add' ? 'Added' : 'Removed';
  return did + ' the <b>' + esc(cmd.label) + '</b> ' + cmd.target_type + ' on your ' + esc(layer.title) +
    ' view. It sticks across sessions and devices (saved to your ' + esc(Memory.describe()) +
    '), changes only the view — never the underlying data — and you can say “undo” to revert.' +
    ' <span style="color:var(--dim)">(If a field has no data yet it shows blank until it does.)</span>';
}

/* ════════════════════════════════════════════════════════════════
   CHAT UI
   ════════════════════════════════════════════════════════════════ */
function esc(s){ return (window.TCC?window.TCC.esc:String)(s); }
function escd(s){ return String(s==null?'':s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function memLine(){
  // Lane 4b: when signed in, memory is LIVE — conversations + facts persist in FL Postgres,
  // RLS-scoped to the user, and reload across sessions/devices. Signed out -> honest pending.
  const authed = !!(window.flApi && flApi.authed && flApi.authed());
  const cls = authed ? 'memline' : 'memline pending';
  const txt = authed
    ? 'Memory: live — this conversation saves to your Foundation Layer account and reloads across sessions and devices.'
    : 'Memory: '+Memory.describe()+' — sign in to save this conversation across sessions.';
  return '<div class="'+cls+'"><span class="pulse"></span> '+esc(txt)+'</div>';
}

/* ── per-layer employee (injected into the drill-in overlay chrome) ── */
function injectLayerEmployee(panel, layer){
  const emp = layer.employee;
  if (!emp) return;
  Memory.load(layer.id); // establish the memory scope for this layer's agent
  const bar = panel.querySelector('.pbar');
  if (!bar) return;
  // "Ask <name>" chip in the top bar
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'empchip';
  chip.innerHTML = '<span class="empav">'+esc(emp.avatar||emp.name[0])+'</span> Ask '+esc(emp.name);
  bar.appendChild(chip);

  // chat dock (hidden until the chip is tapped), inserted right after the bar
  const dock = document.createElement('div');
  dock.className = 'empchat'; dock.style.display = 'none';
  dock.innerHTML =
    '<div class="eh"><span class="empav">'+esc(emp.avatar||emp.name[0])+'</span><div><div class="nm">'+esc(emp.name)+'</div><div class="ro">'+esc(emp.role)+' · on-call employee</div></div></div>'+
    memLine(false)+
    '<div class="emsgs"><div class="emsg a">Hi, I’m '+esc(emp.name)+'. I’m on call for the '+esc(layer.title)+' layer.</div></div>'+
    '<div class="echips"></div>'+
    '<div class="einput"><input placeholder="Ask '+esc(emp.name)+'…"><button type="button">Send</button></div>';
  bar.parentNode.insertBefore(dock, bar.nextSibling);

  let hydrated = false;
  chip.onclick = () => {
    dock.style.display = dock.style.display==='none'?'block':'none';
    if (dock.style.display==='block'){
      dock.scrollIntoView({behavior:'smooth',block:'nearest'});
      // Lane 4b: load this area's saved conversation the first time it's opened (honest fallback).
      if (!hydrated){ hydrated = true; hydrateHistory(layer.id, dock.querySelector('.emsgs')); }
    }
  };

  const msgs = dock.querySelector('.emsgs');
  const input = dock.querySelector('.einput input');
  const send = async () => {
    const v = input.value; if (!v || !v.trim()) return; input.value='';
    msgs.insertAdjacentHTML('beforeend','<div class="emsg u">'+escd(v)+'</div>');
    // A view-edit command ("add a late-fee column", "undo") is handled locally + synchronously —
    // it reshapes the tile view, not a question for the advisor.
    if (parseViewCommand(v)){
      msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+handleLayerMessage(layer, emp, v)+'</div>');
      msgs.scrollTop=msgs.scrollHeight; return;
    }
    // Otherwise ask the live area advisor (falls back to the honest stub when signed out / offline).
    const pid = 'lpend-'+(new Date().getTime());
    msgs.insertAdjacentHTML('beforeend','<div class="emsg a" id="'+pid+'">&hellip;</div>');
    msgs.scrollTop=msgs.scrollHeight;
    let html; try { html = await layerAgentReply(layer, emp, v); } catch(e){ html = layerReply(layer, emp, v); }
    const el = document.getElementById(pid);
    if (el) el.innerHTML = html; else msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+html+'</div>');
    msgs.scrollTop=msgs.scrollHeight;
  };
  dock.querySelector('.einput button').onclick = send;
  input.addEventListener('keydown', e => { if (e.key==='Enter') send(); });

  const cw = dock.querySelector('.echips');
  (layer.chips||[]).forEach(c => {
    const b = document.createElement('button'); b.type='button'; b.className='echip'; b.textContent=c;
    b.onclick = () => { input.value=c; send(); };
    cw.appendChild(b);
  });
}

/* ── global TARS chat ── */
let gInit = false;
function buildGlobal(){
  const g = (TENANT && TENANT.global_agent) || { name:'TARS', role:'company-wide employee' };
  $('gpanel').innerHTML =
    '<div class="pbar"><div class="pbar-l"><button class="back" type="button" id="gclose">← Close</button>'+
    '<div class="ptitle" style="display:flex;align-items:center;gap:9px"><span class="empav" style="width:26px;height:26px">'+esc(g.avatar||'T')+'</span> '+esc(g.name||'TARS')+' — advisor (read-only)</div></div></div>'+
    memLine(false)+
    '<div class="empchat">'+
      '<div class="eh"><span class="empav">'+esc(g.avatar||'T')+'</span><div><div class="nm">'+esc(g.name||'TARS')+'</div><div class="ro">'+esc(g.role||'')+'</div></div></div>'+
      '<div class="emsgs" id="gmsgs"><div class="emsg a">'+esc(g.intro||'Hi — I’m your company-wide employee. What do you need?')+'</div></div>'+
      '<div class="echips" id="gchips"></div>'+
      '<div class="einput"><input id="ginput" placeholder="Talk to '+esc(g.name||'TARS')+'…"><button type="button" id="gsend">Send</button></div>'+
    '</div>';
  const msgs = $('gmsgs'), input = $('ginput');
  const send = async () => {
    const v = input.value; if (!v || !v.trim()) return; input.value='';
    msgs.insertAdjacentHTML('beforeend','<div class="emsg u">'+escd(v)+'</div>');
    if (handleSetup(v)) { msgs.scrollTop=msgs.scrollHeight; return; }   // Phase 3: setup runs as the user, not the read-only advisor
    const pid = 'gpend-'+(new Date().getTime());
    msgs.insertAdjacentHTML('beforeend','<div class="emsg a" id="'+pid+'">&hellip;</div>');
    msgs.scrollTop=msgs.scrollHeight;
    let html; try { html = await globalReply(v); } catch(e){ html = globalStubReply(v); }
    const el = document.getElementById(pid);
    if (el) el.innerHTML = html; else msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+html+'</div>');
    msgs.scrollTop=msgs.scrollHeight;
  };
  $('gsend').onclick = send;
  input.addEventListener('keydown', e => { if (e.key==='Enter') send(); });
  $('gclose').onclick = () => { $('gov').classList.remove('on'); document.body.style.overflow=''; };
  const cw = $('gchips');
  (g.chips||[]).forEach(c => { const b=document.createElement('button'); b.type='button'; b.className='echip'; b.textContent=c; b.onclick=()=>{ input.value=c; send(); }; cw.appendChild(b); });
  gInit = true;
  // Lane 4b: on a fresh build (i.e. a new page load), reload the global TARS thread from memory.
  hydrateHistory('all', $('gmsgs'));
}
function openGlobal(){ if (!gInit) buildGlobal(); $('gov').classList.add('on'); window.scrollTo(0,0); document.body.style.overflow='hidden'; }

// ── Phase 3 setup actions (TARS-assisted mode) ─────────────────────────────────
// The setup chips EXECUTE here, as the signed-in user, via window.FLSetup — they do NOT go to the
// read-only advisor (that "I can't run setup, I'm read-only" dead-end is the bug this fixes). Create
// entities · turn areas on · hire/skip employees · file to Document Navigator — the SAME engine
// manual mode uses (so the two modes are interchangeable). Free-form questions still fall through to
// the advisor (globalReply). This is the write-capable user-driven path; the advisor stays read-only.
function FL(){ return window.FLSetup || null; }
function aBubble(html){ var m=$('gmsgs'); if(!m) return null; m.insertAdjacentHTML('beforeend','<div class="emsg a">'+html+'</div>'); m.scrollTop=m.scrollHeight; return m.lastElementChild; }
function setGchips(arr){
  var c=$('gchips'); if(!c) return; c.innerHTML='';
  (arr||[]).forEach(function(t){ var b=document.createElement('button'); b.type='button'; b.className='echip'; b.textContent=t;
    b.onclick=function(){ var i=$('ginput'), s=$('gsend'); if(i&&s){ i.value=t; s.click(); } }; c.appendChild(b); });
}
function paintHire(b){
  var fl=FL(); if(!fl){ b.innerHTML='Sign in to the Command Center to manage employees.'; return; }
  var areas=fl.areas().filter(function(a){ return a.employee && !a.employee.always; });
  b.innerHTML='Hire or skip an area’s employee — change anytime, independent of setup:<div class="setup-emprows">'+
    areas.map(function(a){ var h=a.hire;
      return '<div class="setup-emprow"><span><b>'+escd(a.employee.name)+'</b> <span class="su-dim">· '+escd(a.label)+'</span></span>'+
        '<span class="setup-emprow-btns"><button type="button" class="echip'+(h==='hire'?' on':'')+'" data-hire="'+escd(a.id)+'">'+(h==='hire'?'✓ Hired':'Hire')+'</button> '+
        '<button type="button" class="echip'+(h==='skip'?' on':'')+'" data-skip="'+escd(a.id)+'">'+(h==='skip'?'✓ Manual':'Skip')+'</button></span></div>';
    }).join('')+
    '</div><div class="su-dim" style="margin-top:6px">Billing soon — hiring activates the area’s L0 advisor for now; the tiles always work by hand.</div>';
  b.querySelectorAll('[data-hire]').forEach(function(btn){ btn.onclick=function(){ var g=btn.getAttribute('data-hire'); fl.hireArea(g, fl.areaHire(g)==='hire'?null:'hire'); paintHire(b); }; });
  b.querySelectorAll('[data-skip]').forEach(function(btn){ btn.onclick=function(){ var g=btn.getAttribute('data-skip'); fl.hireArea(g, fl.areaHire(g)==='skip'?null:'skip'); paintHire(b); }; });
}
// The walkthrough derives each entity's CODE (the permanent natural key an FK web references) from the
// typed name; the server prefixes an owner's code with the account namespace (t<sha8>_). Shown BEFORE
// saving so a typo is caught while it is still a name, not a key (TD-239).
// owner profiles filed by ANY setup form in this page session, by normalised name — a re-opened chip never files the
// same person twice (the per-form ledger below covers retries inside one form)
var OWNER_FILED={};
function deriveCode(name, i){
  // cut to 40 FIRST, then trim edge underscores, so a long name never ends in '_' (review round 1)
  var c=String(name||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,40).replace(/^_+|_+$/g,'');
  if(c) return c;
  // no A–Z / 0–9 at all: a key derived from the NAME (FNV-1a), so a name keeps its key at any line position and two
  // names never share one by position (review round 4: a positional ENTITY_<n> made retries and edits collide)
  var s=String(name||'').trim().toLowerCase().replace(/\s+/g,' '), h=0x811c9dc5;   // the ledger's key: spacing never makes a second company
  for(var j=0;j<s.length;j++){ h^=s.charCodeAt(j); h=Math.imul(h,0x01000193)>>>0; }
  return 'ENTITY_'+('000000'+(h&0xFFFFFF).toString(16).toUpperCase()).slice(-6);
}
function codeIsFallback(name){ return !String(name||'').toUpperCase().replace(/[^A-Z0-9]+/g,''); }
function handleSetup(v){
  var t=(v||'').trim().toLowerCase().replace(/[’‘]/g,"'").replace(/[—–]/g,'-');
  var is=function(s){ return t === s.toLowerCase().replace(/[’‘]/g,"'").replace(/[—–]/g,'-'); };
  var fl=FL();

  if (is('I’ll set up manually') || /set up manually|do it manually/.test(t)){
    aBubble('👍 Click any area on your board to set it up — one click turns it on (data optional, fill it later). I’m here whenever you want me to take over.');
    return true;
  }
  if (is('Finish setup') || /finish setup|i'?m done|complete setup|done with setup/.test(t)){
    if (fl) fl.completeSetup();
    aBubble('🎉 <b>Setup complete</b> — your board is live. The areas you turned on are colored in; switch on any of the rest anytime by clicking them. What do you want to do first?');
    setGchips([]);
    return true;
  }
  if (is('Set up my business & entities') || /(set ?up|setup).*(business|entit)|business (and|&) entit/.test(t)){
    var b=aBubble('Let’s capture your business and people. Your business (an LLC) becomes an <b>entity</b>; the owner is filed under <b>Personal Information</b>. Add any other entities one per line.'+
      '<div class="setup-mini">'+
        '<label class="setup-mini-l">Business / primary entity name (LLC)</label><input class="setup-mini-in" id="su-biz" placeholder="e.g. ECH Management Services LLC">'+
        '<label class="setup-mini-l">Owner name (the person)</label><input class="setup-mini-in" id="su-owner" placeholder="e.g. Jerry Eads">'+
        '<label class="setup-mini-l">Other entities — one per line (optional)</label><textarea class="setup-mini-in" id="su-ents" rows="2" placeholder="ECH Mabank LLC&#10;ECH Athens LLC"></textarea>'+
        '<div class="su-dim" id="su-codes"></div>'+
        '<label class="su-dim" style="display:flex;gap:6px;align-items:flex-start;margin-top:4px"><input type="checkbox" id="su-subs" style="margin-top:2px" disabled><span>The other entities are subsidiaries of the primary business — sets their <b>Parent entity</b> to it. Their ownership % stays <b>not established</b> until you set it in Legal → Entities (only 100.00 consolidates). <span id="su-subs-note">Enter the primary business first.</span></span></label>'+
        '<button type="button" class="echip on" id="su-biz-go">Create &amp; file</button>'+
        '<div class="setup-mini-msg su-dim" id="su-biz-msg"></div>'+
      '</div>');
    var go=b.querySelector('#su-biz-go');
    var endingEl=null;   // the honest ending, one bubble per attempt (a retry replaces it)
    // live: the codes these names will become, before anything is saved
    var previewCodes=function(){
      var biz=(b.querySelector('#su-biz').value||'').trim();
      var ents=(b.querySelector('#su-ents').value||'').split('\n').map(function(x){return x.trim();}).filter(Boolean);
      var names=[]; if(biz) names.push(biz); ents.forEach(function(n){ names.push(n); });
      var cb=b.querySelector('#su-subs'), note=b.querySelector('#su-subs-note');
      if(cb){ cb.disabled=!biz; if(!biz) cb.checked=false; if(note) note.textContent=biz?'':'Enter the primary business first.'; }
      var box=b.querySelector('#su-codes'); if(!box) return;
      if(!names.length){ box.innerHTML=''; return; }
      var codes=names.map(function(n,i){ return deriveCode(n,i); });
      // a line this form already stored is permanent: say so, and that editing it adds a company (the ledger is the form's, declared below)
      var storedOf=function(n,i){ var L=(typeof resolveL==='function') ? resolveL(nkey(n), codes[i]) : null; return (L && L.row) ? L.row : null; };
      var counts={}; codes.forEach(function(c){ counts[c]=(counts[c]||0)+1; });
      var dups=Object.keys(counts).filter(function(c){ return counts[c]>1; });            // every duplicated code, not only the first pair
      var fallback=codes.filter(function(c,i){ return codeIsFallback(names[i]) && !storedOf(names[i],i); });   // a stored line is permanent: never ask to rename it
      var anyStored=names.some(function(n,i){ return !!storedOf(n,i); });
      box.innerHTML='Codes these names become — permanent keys (an owner account&rsquo;s prefix, t…_, is added on save; the summary shows the stored key):'+
        '<div>'+names.map(function(n,i){ var r=storedOf(n,i); return r ? esc(n)+' → <b>'+esc(r.code||codes[i])+'</b> <span class="su-dim">stored</span>' : esc(n)+' → <b>'+esc(codes[i])+'</b>'; }).join('<br>')+'</div>'+
        (anyStored ? 'Stored names and codes are permanent here — editing a stored line adds a new company. ' : 'The code is permanent — fix a typo here, before saving. ')+'Prefer to choose the code yourself? Add the company in Legal → Entities instead.'+
        (dups.length ? ' <span class="su-err">Names that make the same code: '+dups.map(function(c){ return esc(c)+' ×'+counts[c]; }).join(', ')+' — only the first of each will save.</span>' : '')+
        (fallback.length ? ' <span class="su-err">A name with no A–Z letters or 0–9 digits falls back to '+esc(fallback[0])+' — other characters are dropped from the code. Give it a Latin name, or choose the code yourself in Legal → Entities.</span>' : '');
    };
    ['#su-biz','#su-ents'].forEach(function(sel){ var el=b.querySelector(sel); if(el) el.addEventListener('input', previewCodes); });
    var busy=false, done=false;
    // ACROSS ATTEMPTS (review rounds 1-4): ONE ledger per typed name — stored / exists / refused / failed / unconfirmed —
    // indexed by name AND by derived code (a stored row by code wins over a row-less entry by name), so a retry never
    // re-sends what is settled, the owner is filed once, and every sentence below states what the server echoed
    var LEDGER={}, ORDER=[], BYCODE={}, ownerRec=null;
    var nkey=function(name){ return String(name||'').trim().toLowerCase().replace(/\s+/g,' '); };   // case, edge and internal whitespace never make a second key
    // the ledger entry for a typed name: its own entry if that one has a stored row, else the row this form stored under the
    // same code (another spelling), else its own entry (exists / refused / failed), else none
    var resolveL=function(k, code){
      var Lk=LEDGER[k], own=BYCODE[code];
      if(Lk && Lk.row) return Lk;
      // by code only when the code says something about the name: a symbol-only name's ENTITY_<hex> is a hash, and a
      // different name with the same hash is a different company (round 5)
      if(own && own.row && !(codeIsFallback(own.name) && nkey(own.name)!==k)) return own;
      return Lk||null;
    };
    var sameCompany=function(row, name){ return !!row && !(codeIsFallback(name) && nkey(row.name)!==nkey(name)); };   // a looked-up row for a hash code must carry the same name
    var lockForm=function(text){
      ['#su-biz','#su-owner','#su-ents','#su-subs'].forEach(function(sel){ var el=b.querySelector(sel); if(el) el.disabled=true; });
      var box=b.querySelector('#su-codes'); if(box) box.innerHTML=text;   // the preview no longer invites edits
    };
    var storedRows=function(){ var seen={}, out=[]; ORDER.forEach(function(k){ var r=LEDGER[k].row; if(r && !seen[r.id]){ seen[r.id]=1; out.push(r); } }); return out; };
    var knownRows=function(){ return ORDER.map(function(k){ return LEDGER[k].row||LEDGER[k].existing; }).filter(Boolean); };   // stored here, or looked up
    // the ONE company this caller can see whose code is CODE or t<sha8>_CODE; two candidates = not looked up (never guess)
    var findExisting=async function(code){
      try{
        if(!(window.flEntities && flEntities.listX)) return null;
        var r=await flEntities.listX(); var rows=(r && r.ok && Array.isArray(r.data)) ? r.data : [];
        var cands=rows.filter(function(x){ var c=String((x&&x.code)||''); return c===code || (/^t[0-9a-f]{8}_/.test(c) && c.slice(10)===code); });
        return (cands.length===1 && cands[0] && cands[0].id) ? cands[0] : null;
      }catch(e){ return null; }
    };
    var plural=function(k, one, many){ return k===1 ? one : many; };
    var namesOf=function(rows){ var nm=rows.map(function(r){ return '<b>'+esc((r && (r.name||r.code))||'a company')+'</b>'; }); return nm.length<=1 ? (nm[0]||'') : nm.slice(0,-1).join(', ')+' and '+nm[nm.length-1]; };
    go.onclick=async function(){
      if(busy || done) return;                                   // guard: one row set per submission, no double-write
      var biz=(b.querySelector('#su-biz').value||'').trim();
      var owner=(b.querySelector('#su-owner').value||'').trim();
      var ents=(b.querySelector('#su-ents').value||'').split('\n').map(function(s){return s.trim();}).filter(Boolean);
      var msg=b.querySelector('#su-biz-msg');
      if(!biz && !owner && !ents.length){ msg.innerHTML='<span class="su-err">Enter a business name, an owner, or at least one entity.</span>'; return; }
      if(!fl){ msg.innerHTML='<span class="su-err">Sign in to the Command Center to save these.</span>'; return; }
      busy=true; go.disabled=true; msg.textContent='Saving…';
      var authed = !!(window.flApi && flApi.authed && flApi.authed());
      // The business NAME is an entity, not a profile — it (plus any extras) goes to the entities table.
      var allEnts=[]; if(biz) allEnts.push(biz); ents.forEach(function(n){ allEnts.push(n); });
      var subs=!!(biz && b.querySelector('#su-subs') && b.querySelector('#su-subs').checked);   // Parent entity only — never ownership
      var rec=function(name, code){ var k=nkey(name); if(!LEDGER[k]){ LEDGER[k]={ name:name, code:code, row:null, state:'', st:0, existing:null, unverified:false }; ORDER.push(k); } return LEDGER[k]; };
      // THIS click's primary, resolved from the ledger by the name in the field now (never a row from an earlier name)
      var primary=null, primaryExisting=false, primaryStatus=0, primaryFailed=false, pk=biz?nkey(biz):null, pcode=biz?deriveCode(biz,0):null;
      var pr = pk ? resolveL(pk, pcode) : null;
      if(pr){
        if(pr.row){ primary=pr.row; }
        else if(pr.state==='exists'){ if(!pr.existing){ var px_=await findExisting(pr.code); pr.existing=sameCompany(px_, pr.name) ? px_ : null; } if(pr.existing){ primary=pr.existing; primaryExisting=true; } else { primaryStatus=409; if(subs) primaryFailed=true; } }
        else if(pr.state==='refused'){ primaryStatus=pr.st||403; if(subs) primaryFailed=true; }
        else if(pr.state==='unconfirmed'){ primaryStatus='unconfirmed'; if(subs) primaryFailed=true; }
      }
      var entCreated=0, failedNow=[], unconfirmedNow=[], skippedStored=0, skippedExists=0, skippedRefused=0, skippedUnconfirmed=0, dupInList=0, seenCodes={}, seenKeys={};
      for(var i=0;i<allEnts.length;i++){
        var name=allEnts[i], k=nkey(name), code=deriveCode(name,i);
        if(seenCodes[code] || seenKeys[k]){ dupInList++; continue; }       // a later line of THIS list repeating an earlier one (same name, or same code)
        seenCodes[code]=true; seenKeys[k]=true;
        var R=resolveL(k, code);                                            // by name, or by a code this form already stored
        if(R && R.row){ skippedStored++; if(i===0 && biz && !primary){ primary=R.row; primaryExisting=false; } continue; }   // stored by an earlier attempt: never sent again
        if(R && R.state==='exists'){ skippedExists++; continue; }           // the server said it exists: a retry cannot create it
        if(R && R.state==='refused'){ skippedRefused++; continue; }         // refused (403): a retry cannot change that
        if(R && R.state==='unconfirmed'){ skippedUnconfirmed++; continue; } // saved without a record in the reply: re-sending would duplicate or 409
        var payload={ code:code, name:name, legal_form:'LLC' };
        if(subs && i>0 && primary && primary.id) payload.parent_entity_id=primary.id;
        var res=null, st=0, okNoRecord=false;
        try{
          if(window.flEntities && flEntities.createX){ var r=await flEntities.createX(payload); st=(r && r.status)||0; res=(r && r.ok && r.data && typeof r.data==='object' && !Array.isArray(r.data)) ? r.data : null; okNoRecord=!!(r && r.ok && !res); }   // status-carrying: 409 exists · 403 refused · 0 no response
          else { res=await fl.createEntity(payload); }
        }catch(e){ res=null; }
        R=rec(name, code); R.code=code; R.st=st; BYCODE[code]=R;
        if(payload.parent_entity_id) R.askedParent=payload.parent_entity_id;   // sticky: a send WITH a parent whose reply was lost may have filed it
        if(res){
          R.row=res; R.state='stored'; R.unverified=!!(payload.parent_entity_id && !('parent_entity_id' in res));   // asked for a parent, echo did not say
          entCreated++;
          if(i===0 && biz){ primary=res; primaryExisting=false; }
          fl.fileToDocNav(name+' — entity formation','entity','entities');
        } else if(okNoRecord){
          R.state='unconfirmed'; unconfirmedNow.push({ name:name, code:code, status:st });
          if(i===0 && biz){ primaryStatus='unconfirmed'; if(subs) primaryFailed=true; }
        } else if(st===409){
          R.state='exists';
          var mine=null, ex=null;
          if(i===0 && biz){
            ex=await findExisting(code); if(!sameCompany(ex, name)) ex=null;
            mine=ex ? storedRows().filter(function(x){ return x.id===ex.id; })[0] : null;   // the "existing" row is one this form stored
            if(mine){ R.row=mine; R.state='stored'; primary=mine; primaryExisting=false; }
            else if(ex){ R.existing=ex; primary=ex; primaryExisting=true; primaryStatus=409; }
            else { primaryStatus=409; if(subs) primaryFailed=true; }
          }
          if(!mine) failedNow.push({ name:name, code:code, status:st });
        } else {
          failedNow.push({ name:name, code:code, status:st });
          if(st===403){ R.state='refused'; if(i===0 && biz){ primaryStatus=403; if(subs) primaryFailed=true; } }
          else { R.state='failed'; if(i===0 && biz){ primaryStatus=st; if(subs) primaryFailed=true; } }
        }
      }
      // The OWNER (a person) is the personal_info record — NOT the business name. Filed ONCE: per form, and across forms in
      // this page session by normalised name; a renamed owner is never a second record.
      var ownerSavedNow=false, ownerSkipped=false, ownerRenamed=false, ownerDup=null;
      if(owner){
        var ok_=nkey(owner);
        if(OWNER_FILED[ok_]){
          ownerSkipped=true;
          if(ownerRec && ownerRec.mine && nkey(ownerRec.label)!==ok_) ownerDup=ownerRec.label;   // this form filed another spelling before the right one was found filed
          if(!ownerRec) ownerRec={ label:OWNER_FILED[ok_].label, rec:OWNER_FILED[ok_].rec, mine:false };
        }
        else if(ownerRec && ownerRec.mine){ ownerRenamed=true; }                 // this form filed another spelling: never a second record
        else { var orec=null; try { orec=await fl.createRecord({ kind:'personal_info', label:owner, details:{ role:'Owner' }, retention:'7yr' }); } catch(e){ orec=null; }
          if(orec){ ownerRec={ label:owner, rec:orec, mine:true }; OWNER_FILED[ok_]={ label:owner, rec:orec }; ownerSavedNow=true; fl.fileToDocNav(owner+' — owner profile','personal-info','personal-information'); } }
      }
      var ownerSaved=!!(owner && (ownerSavedNow || ownerSkipped || ownerRenamed));
      if(entCreated) fl.activateArea('legal');   // Entities live in the Legal area
      var nowAuthed=!!(window.flApi && flApi.authed && flApi.authed());
      var exists=failedNow.filter(function(f){ return f.status===409; }), notAllowed=failedNow.filter(function(f){ return f.status===403; }), other=failedNow.filter(function(f){ return f.status!==409 && f.status!==403; });
      var expired=authed && !nowAuthed && (other.length>0 || (!!owner && !ownerSaved));   // a session that was alive at the click and is gone now (fl-auth cleared it)
      var stored=storedRows();
      var retryable=other.length + ((owner && !ownerSaved) ? 1 : 0);
      var ownerMine=!!(ownerRec && ownerRec.mine);
      // lock when this form stored a company and nothing is left to retry, or when it only ever filed the owner; a click that stored
      // no company stays open so a mistyped (existing) name can be corrected — the owner is not filed again (ownerRec / OWNER_FILED)
      done=(retryable===0 && !expired && (stored.length>0 || (!!ownerRec && allEnts.length===0)));
      busy=false;
      if(done){
        var clean=!failedNow.length && !unconfirmedNow.length && !ownerRenamed && !ownerDup && (entCreated>0 || ownerSavedNow);   // THIS click saved something and nothing went wrong
        go.textContent=clean ? '✓ Saved' : '✓ Done';
        lockForm(stored.length ? (clean ? 'Saved' : 'Done')+' — the stored keys are in the summary below.' : (ownerSavedNow ? 'Saved.' : (ownerRenamed || ownerDup) ? 'Done — see the summary below.' : 'Nothing new to save — already filed.'));
      }
      else { go.disabled=false; try{ previewCodes(); }catch(e){} }   // the form stays open: the preview now marks the lines that are stored
      var out=[];
      if(entCreated) out.push('✅ Created '+entCreated+' entit'+plural(entCreated,'y','ies')+' in the entities table');
      if(skippedStored) out.push(skippedStored+' already stored by an earlier attempt — not sent again');
      if(skippedExists) out.push(skippedExists+' already exist'+plural(skippedExists,'s','')+' — not sent again');
      if(skippedRefused) out.push(skippedRefused+' refused by the server earlier — not sent again');
      if(skippedUnconfirmed) out.push(skippedUnconfirmed+' saved earlier without a confirmation — not sent again; check Legal → Entities');
      if(dupInList) out.push(dupInList+' duplicate'+plural(dupInList,'','s')+' of an earlier line — skipped');
      if(ownerSavedNow) out.push('✅ Filed the owner under Personal Information');
      if(ownerSkipped) out.push('Owner already filed — not sent again'+(ownerDup ? '; this form also filed &ldquo;'+esc(ownerDup)+'&rdquo; — remove that duplicate in Personal Information' : ''));
      if(ownerRenamed) out.push('The owner was already filed as &ldquo;'+esc(ownerRec.label)+'&rdquo; — not filed again; rename it in Personal Information');
      // failures by what the server said (createX carries the status); an existing row's stored key when it was looked up
      if(exists.length) out.push('⚠️ '+exists.length+' already exist'+plural(exists.length,'s','')+' with the same code ('+exists.map(function(f){ var L=LEDGER[nkey(f.name)]; return esc((L && L.existing && L.existing.code) || f.code); }).join(', ')+') — not created again');
      if(notAllowed.length) out.push('⚠️ '+notAllowed.length+' refused by the server (not allowed) — '+notAllowed.map(function(f){ return esc(f.name); }).join(', '));
      if(unconfirmedNow.length) out.push('⚠️ '+unconfirmedNow.length+' saved without a confirmation (the reply carried no record) — check '+plural(unconfirmedNow.length,'it','them')+' in Legal → Entities');
      if(expired){
        var notSaved=other.map(function(f){ return esc(f.name); }); if(owner && !ownerSaved) notSaved.push('the owner');
        out.push('⚠️ Your session expired — sign in to the Command Center again, then retry. Not saved: '+notSaved.join(', '));
      } else {
        if(other.length) out.push('⚠️ '+other.length+' entit'+plural(other.length,'y','ies')+' '+(authed ? (other.every(function(f){ return !f.status; }) ? 'got no response — the service did not confirm; retry' : 'failed ('+other.map(function(f){ return f.status ? 'HTTP '+f.status : 'no response'; }).join(', ')+') — retry') : plural(other.length,'needs','need')+' sign-in to persist'));
        if(owner && !ownerSaved) out.push('⚠️ Owner '+(authed?'didn’t save — retry':'needs sign-in to persist'));
      }
      if(entCreated) out.push('Opened the <b>Legal</b> area (Entities lives there)');
      // the STORED keys, from the server's echoes, for every row this form stored — the account prefix is real and permanent; never the derived guess
      if(stored.length) out.push('Stored as '+stored.map(function(r){ return (r && r.code) ? '<code>'+esc(r.code)+'</code>' : '<span class="su-err">code not echoed — see Legal → Entities</span>'; }).join(' · '));
      msg.innerHTML=(out.join('. ')||'Nothing to save')+'.';
      // TD-239: this flow captures companies, not the structure between them — say so, in words, in its own bubble, and
      // point at the place that does (Parent, then Ownership %, in Legal → Entities). Every clause states a FACT about the
      // rows this form stored (under this primary · under an earlier parent · no parent yet) — never a guessed cause — plus
      // the rule the subsidiaries box follows. A retry REPLACES the ending and never erases it.
      var n=stored.length, pid=primary ? primary.id : null, pname=esc((primary&&primary.name)||biz||'');
      var unverifiedIds={}; ORDER.forEach(function(k){ var L=LEDGER[k]; if(L.row && L.unverified) unverifiedIds[L.row.id]=1; });
      var others=stored.filter(function(r){ return !(pid && r.id===pid); });                                 // stored rows other than the primary itself
      var underCurrent=pid ? others.filter(function(r){ return r.parent_entity_id===pid; }) : [];
      var underOther=others.filter(function(r){ return !!r.parent_entity_id && r.parent_entity_id!==pid; });
      var topLevel=others.filter(function(r){ return !r.parent_entity_id && !unverifiedIds[r.id]; });
      var unverifiedN=others.filter(function(r){ return !!unverifiedIds[r.id]; }).length;
      var primaryMentioned=primaryExisting || (subs && primaryFailed);
      // only names still in the typed list count: a line the user removed or renamed away is no longer theirs to act on
      // only names still in the typed list, and only names that do not resolve to a row this form stored (by code, another spelling)
      var unresolved=function(k){ var r=resolveL(k, LEDGER[k].code); return !(r && r.row); };
      var existsAll=ORDER.filter(function(k){ var L=LEDGER[k]; return L.state==='exists' && seenKeys[k] && unresolved(k) && !(primaryMentioned && (k===pk || L.code===pcode)); });
      var refusedAll=ORDER.filter(function(k){ return LEDGER[k].state==='refused' && seenKeys[k] && unresolved(k); }).length;
      var pReason=function(){
        if(primaryStatus===409) return 'already exists but could not be looked up';
        if(primaryStatus===403) return 'was refused by the server (not allowed) — this account cannot create it';
        if(primaryStatus==='unconfirmed') return 'was saved without a confirmation from the server';
        if(!authed) return 'was not sent — sign in to the Command Center first';
        if(expired && primaryStatus===401) return 'was rejected — your session expired';
        if(expired && !primaryStatus) return 'didn&rsquo;t save — your session expired';
        if(primaryStatus) return 'didn&rsquo;t save (HTTP '+primaryStatus+')';
        return 'didn&rsquo;t save — the service did not confirm it';
      };
      var pAdvice=function(){
        if(primaryStatus===409) return '';                                           // the clause below says: set its Parent to P
        if(primaryStatus===403) return ' Set the Parents in Legal → Entities once '+pname+' exists.';
        if(primaryStatus==='unconfirmed') return ' Check it in Legal → Entities, then set the Parents there.';
        if(!authed) return ' Sign in, then retry it.';
        if(expired) return ' Sign in again, then retry it.';
        return ' Retry it, then set the Parents in Legal → Entities.';
      };
      // the primary's OWN parent is a fact too (a row this form stored under an earlier primary, now typed as the primary)
      var pParentRow=(primary && primary.parent_entity_id) ? knownRows().filter(function(x){ return x.id===primary.parent_entity_id; })[0] : null;
      var pFact=(primary && primary.parent_entity_id && (pParentRow || !primaryExisting))
        ? '<b>'+pname+'</b> is filed under <b>'+esc(pParentRow ? (pParentRow.name||pParentRow.code) : 'another company')+'</b>'+(primaryExisting ? '' : ' from an earlier attempt')+'.' : null;
      // a parent the user can pick for the top-level rows — never while the primary itself has a parent (that advice could name its own ancestor: a cycle)
      var pL=pk ? (LEDGER[pk] || BYCODE[pcode]) : null;
      var target=(primary && primary.parent_entity_id) ? null : primary ? pname
        : ((subs && primaryFailed && primaryStatus===409 && !(pL && pL.askedParent)) ? pname : null);   // an unresolved primary this form once sent WITH a parent could sit under the advised row
      var boxRule=' The subsidiaries box only sets a parent on a company it creates while <b>'+pname+'</b> is saved or found; it does not change a company that is already stored.';
      // rows this click could not save: an HTTP error "didn't save"; no response means the form cannot know (the reply was lost, not the row)
      var notCountedNote=function(){
        var noResp=other.filter(function(f){ return !f.status; }).length, errs=other.length-noResp, t=[];
        if(errs) t.push('The '+errs+' that didn&rsquo;t save '+plural(errs,'isn&rsquo;t','aren&rsquo;t')+' counted.');
        if(noResp) t.push('The '+noResp+' the server did not confirm '+plural(noResp,'isn&rsquo;t','aren&rsquo;t')+' counted.');
        return ' <span class="su-dim">'+t.join(' ')+'</span>';
      };
      var ending=null;
      if(n){
        ending='You created '+n+' compan'+plural(n,'y','ies')+'. ';
        var parts=[];
        if(primaryExisting) parts.push('<b>'+pname+'</b> already existed, so it was not created again.');
        if(subs && primaryFailed) parts.push('<b>'+pname+'</b> '+pReason()+'. The subsidiaries box needs it, so nothing was filed under it.'+pAdvice());
        if(pFact) parts.push(pFact);
        if(underCurrent.length){
          var K=underCurrent.length;
          parts.push((others.length===1 ? namesOf(underCurrent)+' is' : K+' of them '+plural(K,'is','are'))+' filed under <b>'+pname+'</b> as its subsidiar'+plural(K,'y','ies')+' — '+plural(K,'its','their')+' Parent is set. '+plural(K,'Its','Their')+' ownership % is <b>not established</b>, so '+plural(K,'it does not consolidate','none of them consolidates')+' into '+pname+'&rsquo;s rollup yet — only 100.00 does. Set '+plural(K,'its','each one&rsquo;s')+' Ownership in Legal → Entities.');
        }
        if(underOther.length){
          var byParent={}, order=[]; underOther.forEach(function(r){ var p=knownRows().filter(function(x){ return x.id===r.parent_entity_id; })[0]; var nm=p ? (p.name||p.code) : 'another company'; if(!byParent[nm]){ byParent[nm]=[]; order.push(nm); } byParent[nm].push(r); });
          order.forEach(function(nm){ var rows=byParent[nm], M=rows.length; parts.push((M<=3 ? namesOf(rows) : M+' of them')+' '+plural(M,'is','are')+' filed under <b>'+esc(nm)+'</b> from an earlier attempt.'); });
        }
        if(topLevel.length){
          var T=topLevel.length, allTop=(T===others.length) && !underCurrent.length && !underOther.length && !unverifiedN && !pFact;
          var subj=(T<=3 ? namesOf(topLevel) : ((underCurrent.length || underOther.length || (pFact && !primaryExisting)) ? 'The other '+T : T+' of them'))+' '+plural(T,'has','have');   // "other" only after a clause that named a COUNTED company
          var rule=(subs && primary) ? boxRule : '';   // the box is on and the primary is resolved: say what the box does, whatever the advice
          if(allTop && !(subs && target)){
            if(n===1 && others.length===1){
              parts.push(parts.length || primaryExisting
                ? subj+' no parent'+(target ? ' — if '+target+' owns it, open it in Legal → Entities and set its Parent to '+target+', then the Ownership %.' : '. If one of your other companies owns it, or it owns one, open it in Legal → Entities and set its Parent, then the Ownership %.')
                : 'It has no parent. If one of your other companies owns it, or it owns one, open it in Legal → Entities and set its Parent, then the Ownership %.');
            } else {
              parts.push('None of them are related to '+(primaryExisting ? pname+' or to each other' : 'each other')+' yet — if one owns another, open it in Legal → Entities and set its Parent, then its Ownership % (only 100.00 consolidates into the parent&rsquo;s rollup).');
            }
            if(rule) parts[parts.length-1]+=rule;
          } else {
            parts.push(subj+' no parent yet — '+(target
              ? 'if '+target+' owns '+plural(T,'it','them')+', open '+plural(T,'it','each one')+' in Legal → Entities and set its Parent to '+target+'.'
              : 'if another company owns '+plural(T,'it','one')+', open it in Legal → Entities and set its Parent.')+
              rule);
          }
        }
        if(!parts.length && n===1) parts.push('It has no parent. If one of your other companies owns it, or it owns one, open it in Legal → Entities and set its Parent, then the Ownership %.');   // only the primary itself was stored
        ending+=parts.join(' ');
        if(other.length) ending+=notCountedNote();
        if(refusedAll) ending+=' <span class="su-dim">'+refusedAll+' '+plural(refusedAll,'was','were')+' refused by the server and '+plural(refusedAll,'is','are')+' not counted.</span>';
        if(existsAll.length) ending+=' <span class="su-dim">'+existsAll.length+' already existed and '+plural(existsAll.length,'is','are')+' not counted — check '+plural(existsAll.length,'its','their')+' Parent in Legal → Entities.</span>';
        if(unverifiedN) ending+=' <span class="su-dim">'+unverifiedN+' could not be verified — the server did not echo a parent; check '+plural(unverifiedN,'its','their')+' Parent in Legal → Entities.</span>';
      } else if(existsAll.length || (pr && pr.state==='exists') || (pk && LEDGER[pk] && LEDGER[pk].state==='exists')){
        // no company stored by this form, but the names exist: still end honestly — no relationship was touched
        var pkExists=!!(pk && ((LEDGER[pk] && LEDGER[pk].state==='exists') || (pr && pr.state==='exists')));
        var ex=existsAll.length + ((pkExists && primaryMentioned) ? 1 : 0);
        var exSubs=existsAll.filter(function(k){ return k!==pk && LEDGER[k].code!==pcode; });                // existing names other than the primary
        ending='No new company was created — '+ex+' compan'+plural(ex,'y','ies')+' already exist'+plural(ex,'s','')+'.'+
          ((subs && exSubs.length)
            ? ' The subsidiaries box only sets a parent on a company it creates, so it changed nothing: set '+(exSubs.length===1 ? '<b>'+esc(LEDGER[exSubs[0]].name)+'</b>&rsquo;s' : 'each one&rsquo;s')+' Parent in Legal → Entities.'
            : ' Parent and Ownership % are set in Legal → Entities.');
        if(other.length) ending+=notCountedNote();
        if(refusedAll) ending+=' <span class="su-dim">'+refusedAll+' '+plural(refusedAll,'was','were')+' refused by the server and '+plural(refusedAll,'is','are')+' not counted.</span>';
      }
      if(ending){
        if(endingEl){ try{ endingEl.remove(); }catch(e){} endingEl=null; }
        endingEl=aBubble(ending+'<div class="setup-chiprow" style="margin-top:6px"><button type="button" class="echip su-open-entities">Open Legal → Entities</button></div>');
        var openBtn=endingEl && endingEl.querySelector('.su-open-entities');
        if(openBtn) openBtn.onclick=function(){
          var opened=false;
          if(typeof window.openLayer==='function'){ try{ openLayer('entities'); opened=!!document.getElementById('drill-iframe'); }catch(e){ opened=false; } }   // land on the tile that sets Parent + Ownership
          if(opened){
            try{ if(window.hideOverlay) hideOverlay('gov'); }catch(e){}                                       // leave the chat only once the tile is open
            var ov=document.getElementById('ov'); if(ov && ov.classList.contains('on')) document.body.style.overflow='hidden';   // hideOverlay released the page scroll lock the drill had set
            return;
          }
          aBubble('Open the <b>Entities</b> tile in the Legal area on your board.');            // the chat is still open, so this is seen
        };
      }
    };
    return true;
  }
  if (is('Hire or skip an employee') || /hire (or|and|\/) ?skip|hire an employee|hire\/skip/.test(t)){
    var hb=aBubble(''); paintHire(hb);
    return true;
  }
  if (is('Turn on an area') || /turn on (an|a) area|activate an area|turn an area on/.test(t)){
    if(!fl){ aBubble('Sign in to the Command Center to turn areas on.'); return true; }
    var areas=fl.areas().filter(function(a){ return a.id!=='brief' && a.id!=='overview'; });
    var html='Which area do you want to turn on? One click — data optional, fill it later.<div class="setup-chiprow">';
    areas.forEach(function(a){ html+='<button type="button" class="echip'+(a.active?' on':'')+'" data-area="'+escd(a.id)+'">'+(a.active?'✓ ':'')+escd(a.label)+'</button>'; });
    html+='</div>';
    var ab=aBubble(html);
    ab.querySelectorAll('[data-area]').forEach(function(btn){
      btn.onclick=function(){
        var g=btn.getAttribute('data-area'); fl.activateArea(g);
        if(btn.textContent.indexOf('✓')===-1) btn.textContent='✓ '+btn.textContent;
        btn.classList.add('on');
        var emp=fl.areaEmployee(g);
        aBubble('✅ <b>'+escd(btn.textContent.replace('✓ ',''))+'</b> is live on your board'+(emp&&!emp.always?' — '+escd(emp.name)+' is available to hire for it':'')+'. Turn on another, or hire its employee?');
      };
    });
    return true;
  }
  if (is('Yes — start setup') || is('Yes') || /^(yes|start setup|begin|let's go|lets go)/.test(t)){
    aBubble('Great — here’s how this works. Tell me your <b>business &amp; entities</b>, turn on the <b>areas</b> you use, and <b>hire or skip</b> each area’s employee. Everything files into your Document Navigator. Pick any to start — or just click an area on the board to set it up yourself.');
    setGchips(['Set up my business & entities','Turn on an area','Hire or skip an employee','I’ll set up manually','Finish setup']);
    return true;
  }
  return false;
}

// Setup-flavored entry (Phase 2 polish; Phase 3 wires the chips to the real engine above): opens the
// global TARS chat with a SETUP opener + setup actions that EXECUTE (not the generic advisor greeting).
function openSetup(){
  openGlobal();
  var msgs = $('gmsgs'), chips = $('gchips');
  if (msgs){
    msgs.insertAdjacentHTML('beforeend',
      '<div class="emsg a"><b>Let’s set up your Foundation Layer — ready to start?</b><br>'+
      'I’ll walk you through your business and entities, turn on the areas you want (or turn any on yourself in one click), '+
      'hire or skip each area’s employee, and file everything into your Document Navigator as we go. '+
      'Text for now — voice conversation is coming soon.</div>');
    msgs.scrollTop = msgs.scrollHeight;
  }
  if (chips){
    chips.innerHTML = '';
    ['Yes — start setup','Set up my business & entities','Turn on an area','Hire or skip an employee','I’ll set up manually','Finish setup']
      .forEach(function(c){
        var b=document.createElement('button'); b.type='button'; b.className='echip'; b.textContent=c;
        b.onclick=function(){ var i=$('ginput'), s=$('gsend'); if(i&&s){ i.value=c; s.click(); } };
        chips.appendChild(b);
      });
  }
}

function $(id){ return document.getElementById(id); }

/* ── public API ── */
window.Agents = {
  init(state){
    STATE = state; TENANT = state.tenant; Memory.load('all');
    // answer a drill-in that asks for its saved view config on load
    window.addEventListener('message', function(e){
      const d = e.data || {};
      if (d && d.type === 'tcc:viewcfg:request' && STATE.openLayer) pushViewConfig(STATE.openLayer);
    });
  },
  openGlobal: openGlobal,
  openSetup: openSetup,
  injectLayerEmployee: injectLayerEmployee,
  pushViewConfig: pushViewConfig,
  memory: Memory,
  viewConfig: ViewConfig
};

})();
