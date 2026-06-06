/* ════════════════════════════════════════════════════════════════
   TCC — Platform v1 · CORE
   Generic. Reads config/tenant.json + config/layers.json and renders
   the home from the registry. ZERO tenant specifics live in this file —
   everything ECH-flavored is in the config + the /layers folders.

   Add a layer = drop a folder in /layers/ + add one entry to
   config/layers.json. No edit here. (See /layers/_TEMPLATE/README.md.)
   ════════════════════════════════════════════════════════════════ */

/* ── PWA ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
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
  if (window.Agents) Agents.init(STATE);   // global TARS + per-layer employees + memory store
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

/* ── entitlement + enabled filter (the licensing boundary lives here) ── */
function visibleLayers(){
  return (STATE.registry.layers||[]).filter(l => l.enabled !== false && l.entitled !== false);
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

  // global TARS button
  const g = STATE.tenant.global_agent || {};
  $('tars-btn').innerHTML =
    '<span class="tarsav">'+tarsSvg(26)+'</span>'+
    '<span class="tarstxt"><b>Ask '+esc(g.name||'TARS')+'</b><span>'+esc(g.tagline||'your on-call AI employee')+'</span></span>'+
    '<span style="margin-left:auto;color:var(--purple);font-size:18px">▸</span>';

  // header
  const op = (STATE.tenant.operator)||{};
  const b = (STATE.tenant.branding)||{};
  const now = new Date();
  $('head').innerHTML =
    '<h1>'+esc(b.title||STATE.tenant.name||'')+(b.title_accent?' <span>'+esc(b.title_accent)+'</span>':'')+'</h1>'+
    '<div class="when"><b>'+now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+'</b>'+
    timeOfDay()+(op.greeting_name?' · '+esc(op.greeting_name):'')+'</div>';

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

function tarsSvg(s){
  return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="7" r="3.6" fill="#0a0a0b"/><path d="M4.5 21c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" fill="#0a0a0b"/><circle cx="12" cy="7" r="3.6" stroke="#0a0a0b"/></svg>';
}

/* ════════════════════════════════════════════════════════════════
   HOME — groups + tiles
   ════════════════════════════════════════════════════════════════ */
function renderHome(){
  const groups = STATE.registry.groups || [];
  let html = '';
  groups.forEach(grp => {
    const ls = layersInGroup(grp.id);
    if (!ls.length) return;
    if (grp.label) html += '<div class="sect">'+esc(grp.label)+'</div>';
    if (grp.id === 'status')    html += '<div class="grid2">'+ls.map(tileShell).join('')+'</div>';
    else if (grp.id === 'portfolio') html += ls.map(tileShell).join('');
    else if (grp.id === 'market')    html += renderMarketGroup(ls);
    else if (grp.id === 'artifact')  html += renderArtifactGroup(ls);
    else html += ls.map(tileShell).join('');
  });
  $('home').innerHTML = html;
  // initial paint of data-bound tiles (skeleton → fills when data lands)
  refreshDataTiles();
  bindTileClicks();
  bindMarketPicker();
}

// a stable container for each tile so data can refresh it in place.
// (data-tile lives on the inner button rendered by renderTile, not the shell,
//  so a click binds/fires exactly once.)
function tileShell(l){ return '<div id="tile-'+esc(l.id)+'" class="tile-shell"></div>'; }

function renderArtifactGroup(ls){
  const cap = '<div class="empcap">👤 Every layer has an on-call employee — open any tile and tap “Ask” to have it find something or answer for you.</div>';
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

/* ── MARKET group: county picker + tiles ── */
function renderMarketGroup(ls){
  const picker = '<div class="pickrow"><select class="picker" id="county-picker"></select></div>';
  // split: first 4 in a grid4, remainder in grid2 (mirrors the visual target)
  const top = ls.slice(0,4), rest = ls.slice(4);
  let h = picker + '<div class="grid4">'+top.map(tileShell).join('')+'</div>';
  if (rest.length) h += '<div class="grid2" style="margin-top:10px">'+rest.map(tileShell).join('')+'</div>';
  // gap explanation note (from the gap layer's note, if present)
  const gap = ls.find(l => l.data && l.data.source==='vacancy_gap');
  if (gap && gap.note) h += '<div class="note" id="market-note"><b>Why two vacancy numbers?</b> '+esc(gap.note)+'</div>';
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
    if (l.group === 'artifact') return;            // artifact tiles are static (rendered once)
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

function openDrill(l){
  const panel = $('panel');
  panel.innerHTML = pbar(l) +
    '<iframe class="drillframe" src="'+esc(l.drilldown)+'" title="'+esc(l.title)+'" loading="lazy"></iframe>';
  // per-layer employee chat (core-rendered into the overlay chrome)
  if (window.Agents) Agents.injectLayerEmployee(panel, l);
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

function openAddLayer(){
  const panel = $('panel');
  panel.innerHTML =
    '<div class="pbar"><div class="pbar-l"><button class="back" type="button" id="drill-back">← Back</button><div class="ptitle">➕ Add a layer</div></div></div>'+
    '<div class="card" style="background:var(--surf);border:1px solid var(--line);border-radius:var(--radius);padding:16px">'+
    '<p style="font-size:14px;line-height:1.6;color:var(--txt)">A <b>layer</b> is a department of your business — Financials, Documents, Rent Roll, and so on. Each layer is a tile with a drill-in and its own on-call employee.</p>'+
    '<p style="font-size:13px;line-height:1.6;color:var(--mut);margin-top:10px">Two ways to add one, no assembly required:</p>'+
    '<div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">'+
    '<div style="background:var(--surf2);border:1px solid var(--line);border-radius:10px;padding:12px"><b>Built for you</b><div style="font-size:12.5px;color:var(--mut);margin-top:3px">Tell us what you need; we build the layer and turn it on.</div></div>'+
    '<div style="background:var(--surf2);border:1px solid var(--line);border-radius:10px;padding:12px"><b>Architect agent</b> <span class="badge b-gray">coming soon</span><div style="font-size:12.5px;color:var(--mut);margin-top:3px">A guided agent walks you through creating your own layer, step by step.</div></div>'+
    '</div>'+
    '<div class="src-note" style="font-size:11px;color:var(--dim);margin-top:14px">Under the hood: a layer = a folder in <code>/layers/</code> + one entry in <code>config/layers.json</code>. The core never changes. See <code>/layers/_TEMPLATE/</code>.</div>'+
    '</div>';
  $('drill-back').onclick = closeDrill;
  showOverlay('ov');
}

function showOverlay(id){ $(id).classList.add('on'); window.scrollTo(0,0); document.body.style.overflow='hidden'; }
function hideOverlay(id){ $(id).classList.remove('on'); document.body.style.overflow=''; }
function closeDrill(){ hideOverlay('ov'); $('panel').innerHTML=''; }

/* ── global controls ── */
function wireGlobalControls(){
  $('refresh-btn').onclick = forceRefresh;
  $('tars-btn').onclick = () => { if (window.Agents) Agents.openGlobal(); };
  // close overlays on backdrop click / Esc
  ['ov','gov'].forEach(id => $(id).addEventListener('click', e => { if (e.target.id===id){ hideOverlay(id); if(id==='ov') $('panel').innerHTML=''; } }));
  document.addEventListener('keydown', e => { if (e.key==='Escape'){ hideOverlay('ov'); hideOverlay('gov'); } });
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
