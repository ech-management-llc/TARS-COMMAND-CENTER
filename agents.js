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

// reply for the global TARS employee
function globalReply(text){
  const fin = liveFinanceFacts(), mkt = liveMarketFacts();
  const parts = [];
  if (fin) parts.push('💰 '+fin);
  if (mkt) parts.push('📊 '+mkt);
  const g = (TENANT && TENANT.global_agent) || {};
  let head = 'I’m '+esc(g.name||'TARS')+'. I can see every layer and I load your '+esc(Memory.describe())+' each session.';
  if (parts.length) return head+'<br><br>Live right now:<br>'+parts.join('<br>')+'<br><br><span style="color:var(--dim)">'+pendingNote+'</span>';
  return head+' '+pendingNote;
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
    setTimeout(()=>{ msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+layerReply(layer, emp, v)+'</div>'); msgs.scrollTop=msgs.scrollHeight; }, 220);
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
    '<div class="ptitle" style="display:flex;align-items:center;gap:9px"><span class="empav" style="width:26px;height:26px">'+esc(g.avatar||'T')+'</span> '+esc(g.name||'TARS')+' — AI employee</div></div></div>'+
    memLine(false)+
    '<div class="empchat">'+
      '<div class="eh"><span class="empav">'+esc(g.avatar||'T')+'</span><div><div class="nm">'+esc(g.name||'TARS')+'</div><div class="ro">'+esc(g.role||'')+'</div></div></div>'+
      '<div class="emsgs" id="gmsgs"><div class="emsg a">'+esc(g.intro||'Hi — I’m your company-wide employee. What do you need?')+'</div></div>'+
      '<div class="echips" id="gchips"></div>'+
      '<div class="einput"><input id="ginput" placeholder="Talk to '+esc(g.name||'TARS')+'…"><button type="button" id="gsend">Send</button></div>'+
    '</div>';
  const msgs = $('gmsgs'), input = $('ginput');
  const send = () => {
    const v = input.value; if (!v || !v.trim()) return; input.value='';
    msgs.insertAdjacentHTML('beforeend','<div class="emsg u">'+escd(v)+'</div>');
    setTimeout(()=>{ msgs.insertAdjacentHTML('beforeend','<div class="emsg a">'+globalReply(v)+'</div>'); msgs.scrollTop=msgs.scrollHeight; }, 220);
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
  init(state){ STATE = state; TENANT = state.tenant; Memory.load('all'); },
  openGlobal: openGlobal,
  injectLayerEmployee: injectLayerEmployee,
  memory: Memory
};

})();
