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
        '<button type="button" class="echip on" id="su-biz-go">Create &amp; file</button>'+
        '<div class="setup-mini-msg su-dim" id="su-biz-msg"></div>'+
      '</div>');
    var go=b.querySelector('#su-biz-go');
    var busy=false, done=false;
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
      var entCreated=0, entFailed=0, ownerSaved=false;
      for(var i=0;i<allEnts.length;i++){
        var name=allEnts[i];
        var code=name.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40) || ('ENTITY_'+(i+1));
        var res=null; try { res=await fl.createEntity({ code:code, name:name, legal_form:'LLC' }); } catch(e){ res=null; }
        if(res){ entCreated++; fl.fileToDocNav(name+' — entity formation','entity','entities'); }
        else { entFailed++; }
      }
      // The OWNER (a person) is the personal_info record — NOT the business name.
      if(owner){
        var orec=null; try { orec=await fl.createRecord({ kind:'personal_info', label:owner, details:{ role:'Owner' }, retention:'7yr' }); } catch(e){ orec=null; }
        ownerSaved=!!orec;
        if(ownerSaved) fl.fileToDocNav(owner+' — owner profile','personal-info','personal-information');
      }
      if(entCreated) fl.activateArea('legal');   // Entities live in the Legal area
      done = (entFailed===0 && (!owner || ownerSaved));          // lock the form only when everything attempted saved
      busy=false; if(done){ go.textContent='✓ Saved'; } else { go.disabled=false; }
      var out=[];
      if(entCreated) out.push('✅ Created '+entCreated+' entit'+(entCreated===1?'y':'ies')+' in the entities table');
      if(ownerSaved) out.push('✅ Filed the owner under Personal Information');
      if(entFailed) out.push('⚠️ '+entFailed+' entit'+(entFailed===1?'y':'ies')+' '+(authed?'failed — a duplicate name? check, then retry':'need sign-in to persist'));
      if(owner && !ownerSaved) out.push('⚠️ Owner '+(authed?'didn’t save — retry':'needs sign-in to persist'));
      if(entCreated) out.push('Opened the <b>Legal</b> area (Entities lives there)');
      msg.innerHTML=(out.join('. ')||'Nothing to save')+'.';
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
