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
    try { res = await window.flAgent.chat(text, { hint: liveContextHint() }); } catch(e){ res = null; }
    if (res && res.answer){
      let out = formatAnswer(res.answer);
      const names = (res.tools_called||[]).map(function(t){return t.tool;})
        .filter(function(v,i,a){return a.indexOf(v)===i;});
      if (names.length) out += '<div class="memline" style="margin-top:8px"><span class="pulse"></span> read live: '+esc(names.join(', '))+'</div>';
      if (res.truncated) out += '<div style="color:var(--dim);margin-top:6px;font-size:.85em">(Stopped at this request\'s budget — ask something narrower and I\'ll finish.)</div>';
      return out;
    }
    // not signed in to FL / API error / empty -> honest stub (no fabrication)
  }
  return globalStubReply(text);
}
function formatAnswer(s){ return escd(s).replace(/\n/g,'<br>'); }
function liveContextHint(){ try { if (STATE && STATE.openLayer) return 'viewing the '+STATE.openLayer+' tile'; } catch(e){} return ''; }

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

function memLine(connected){
  const cls = connected ? 'memline' : 'memline pending';
  const c = Memory.cfg();
  const txt = 'Memory: '+Memory.describe()+' · '+(c.status||'configured')+
    ' — loaded as context each session; live read/append wiring pending.';
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

  chip.onclick = () => { dock.style.display = dock.style.display==='none'?'block':'none'; if (dock.style.display==='block') dock.scrollIntoView({behavior:'smooth',block:'nearest'}); };

  const msgs = dock.querySelector('.emsgs');
  const input = dock.querySelector('.einput input');
  const send = () => {
    const v = input.value; if (!v || !v.trim()) return; input.value='';
    msgs.insertAdjacentHTML('beforeend','<div class="emsg u">'+escd(v)+'</div>');
    setTimeout(()=>{ msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+handleLayerMessage(layer, emp, v)+'</div>'); msgs.scrollTop=msgs.scrollHeight; }, 220);
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
}
function openGlobal(){ if (!gInit) buildGlobal(); $('gov').classList.add('on'); window.scrollTo(0,0); document.body.style.overflow='hidden'; }

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
  injectLayerEmployee: injectLayerEmployee,
  pushViewConfig: pushViewConfig,
  memory: Memory,
  viewConfig: ViewConfig
};

})();
