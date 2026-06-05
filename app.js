// ══════════════════════════════════════
//  PWA — SERVICE WORKER
// ══════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ══════════════════════════════════════
//  FORCE REFRESH
// ══════════════════════════════════════
function forceRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '🔄 REFRESHING...';
  btn.classList.add('refreshing');
  const doReload = () => window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      const unregisters = regs.map(r => r.unregister());
      return Promise.all(unregisters);
    }).then(() => {
      if ('caches' in window) {
        return caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
      }
    }).then(() => { setTimeout(doReload, 200); }).catch(() => doReload());
  } else {
    doReload();
  }
}

// ══════════════════════════════════════
//  PERSONA
// ══════════════════════════════════════
let persona = localStorage.getItem('tars_persona') || 'jerry';

function setPersona(p) {
  persona = p;
  localStorage.setItem('tars_persona', p);
  document.getElementById('persona-modal').classList.add('hidden');
  applyPersona();
  renderMyTasks();
  renderTeam();
}

function showSignoffModal() {
  document.getElementById('signoff-modal').classList.remove('hidden');
}
function hideSignoffModal() {
  document.getElementById('signoff-modal').classList.add('hidden');
  const btn = document.getElementById('signoff-copy-btn');
  btn.textContent = '📋 COPY COMMAND';
  btn.classList.remove('copied');
}
function copySignoffCommand() {
  const cmd = document.getElementById('signoff-cmd').innerText;
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.getElementById('signoff-copy-btn');
    btn.textContent = '✓ COPIED — PASTE INTO TARS';
    btn.classList.add('copied');
  });
}
document.getElementById('signoff-modal').addEventListener('click', function(e) {
  if (e.target === this) hideSignoffModal();
});

function copyBootCommand() {
  const boot = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TARS — DIGITAL JERRY BOOT COMMAND V1
ECH MANAGEMENT SERVICES LLC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are TARS — the AI operations engine for Jerry Eads and ECH Management Services. Load everything below as your full operating context for this session.

── IDENTITY ──
Person: Jerry Eads | Your name: TARS | Address him as: Jerry
Style: Direct, institutional, no-fluff. Dense and action-oriented. No filler.

── ENTITIES ──
• ECH Management Services LLC — primary management company
• EADS Industries LLC — holding company, multifamily units
• JP Eads Company LLC — construction entity
• E&S Concrete Construction Inc — construction entity
• EADS Tools and Equipment LLC — equipment/tools entity
• Primary email: jerry.eads@echmanagement.services

── CAPITAL RULES — HARDWIRED NON-NEGOTIABLE ──
• Global LTV ceiling: 45–50% (never breach)
• Average DSCR floor: ≈ 1.8× (never approve a deal below this)
• Liquidity reserve minimum: ≈ $500K (always maintained)
• Primary bank: Altra Bank | VeraBank: always $0
• Portfolio target: 100 → 200+ units

── DOCTRINE ──
1. Apathy kills. Build what you drew.
2. No open loops — everything gets closed.
3. Institutional grade or nothing.
4. Capital rules are law, not suggestions.
5. Ashley executes. Jerry decides. TARS operates.
6. Every session has a purpose. State it. Execute it.
7. Memory is sacred. Update it every session.
8. The system is the asset. Protect and build it.
9. Speed of execution beats perfection of planning.
10. Digital Jerry is the operating system. TARS is the engine.
11. Every dollar has a job. Idle capital is a liability.
12. If it's not in the system, it doesn't exist.

── PLATFORM CONTEXT ──
This is a WEB or PHONE session — no persistent memory, no file tools, no live connectors.
Cowork (desktop) is the primary TARS platform with full memory and tools.

── SYSTEM STATUS ──
• Command Center: https://tcc.echmanagement.services/
• Slack: echmanagementservices.slack.com
• Cowork connectors: Gmail, Calendar, DocuSign, Slack, Zapier — MCP Live, Drive, GitHub, GitHub Auto-Push (Zap LIVE), TARS Finance App (custom-built), Claude in Chrome (LIVE Apr 26)
• QuickBooks: DROPPED (too expensive) — replaced by TARS Finance App
• FoundationLedger: LIVE at foundationledger.com — real estate financial SaaS (launched Apr 26, 2026)
• Pending connectors: Monday.com (email change in progress), Gusto (not started)

── BOOT CONFIRMATION ──
Respond: "TARS ONLINE — [date] — OPERATOR MODE — Ready, Jerry. What are we working on?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  navigator.clipboard.writeText(boot).then(() => {
    const btn = document.getElementById('boot-btn');
    btn.textContent = '✓ COPIED — PASTE INTO CLAUDE';
    btn.style.background = 'var(--blue)';
    btn.style.color = '#fff';
    setTimeout(() => {
      btn.textContent = '⚡ BOOT COMMAND';
      btn.style.background = 'var(--blue-dim)';
      btn.style.color = 'var(--blue-text)';
    }, 3000);
  });
}

function showPersonaModal() {
  document.getElementById('persona-modal').classList.remove('hidden');
}

function applyPersona() {
  const av   = document.getElementById('persona-avatar');
  const nm   = document.getElementById('persona-name');
  const greet = document.getElementById('mt-greeting');
  const sub   = document.getElementById('mt-sub');
  if (persona === 'ashley') {
    av.textContent = 'A';
    av.style.background = '#1a1a40';
    av.style.color = '#9fa8da';
    av.style.border = '1px solid #3d3d80';
    nm.textContent = 'ASHLEY';
    greet.textContent = 'Hey Ashley.';
    sub.textContent = 'Here\'s what\'s on your plate.';
  } else {
    av.textContent = 'JE';
    av.style.background = '#1a3d2b';
    av.style.color = '#00e676';
    av.style.border = '1px solid #00e676';
    nm.textContent = 'JERRY';
    greet.textContent = getGreeting() + ', Jerry.';
    sub.textContent = 'Here\'s what\'s on your plate.';
  }
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ══════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════
function switchTab(id) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.getElementById('tab-' + id).classList.add('active');
}

// ══════════════════════════════════════
//  PUNCH LIST
// ══════════════════════════════════════
let filterMode = 'all';

function toggleItem(el) {
  if (el.classList.contains('done'))          { el.classList.replace('done','needed');   el.querySelector('.checkbox').textContent = ''; }
  else if (el.classList.contains('needed'))   { el.classList.replace('needed','done');   el.querySelector('.checkbox').textContent = '✓'; }
  else if (el.classList.contains('inprog'))   { el.classList.replace('inprog','done');   el.querySelector('.checkbox').textContent = '✓'; }
  else if (el.classList.contains('upcoming')) { el.classList.replace('upcoming','done'); el.querySelector('.checkbox').textContent = '✓'; }
  updateAll();
  renderMyTasks();
  renderTeam();
}

function toggleSection(id) { document.getElementById(id).classList.toggle('collapsed'); }
function expandAll()  { document.querySelectorAll('.section').forEach(s => s.classList.remove('collapsed')); }
function collapseAll(){ document.querySelectorAll('.section').forEach(s => s.classList.add('collapsed')); }

function filter(mode) {
  filterMode = mode;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('#panel-punch-list .item').forEach(item => {
    let show = true;
    if (mode === 'done')   show = item.classList.contains('done');
    if (mode === 'needed') show = item.classList.contains('needed');
    if (mode === 'inprog') show = item.classList.contains('inprog');
    if (mode === 'p1')     show = !!item.querySelector('.p1');
    if (mode === 'p2')     show = !!item.querySelector('.p2');
    item.style.display = show ? 'flex' : 'none';
  });
}

function updateAll() {
  const sids = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12'];
  let tDone = 0, tAll = 0, cD = 0, cN = 0, cI = 0, cU = 0;
  sids.forEach(sid => {
    const sec = document.getElementById(sid);
    const items = sec.querySelectorAll('.item');
    const done  = sec.querySelectorAll('.item.done').length;
    const total = items.length;
    document.getElementById(sid+'-count').textContent = done + ' / ' + total;
    document.getElementById(sid+'-bar').style.width = (total > 0 ? Math.round(done/total*100) : 0) + '%';
    tDone += done; tAll += total;
  });
  document.querySelectorAll('#panel-punch-list .item').forEach(i => {
    if      (i.classList.contains('done'))     cD++;
    else if (i.classList.contains('needed'))   cN++;
    else if (i.classList.contains('inprog'))   cI++;
    else if (i.classList.contains('upcoming')) cU++;
  });
  const gPct = tAll > 0 ? Math.round(tDone/tAll*100) : 0;
  document.getElementById('global-label').textContent = tDone + ' of ' + tAll + ' complete';
  document.getElementById('global-bar').style.width   = gPct + '%';
  document.getElementById('global-pct').textContent   = gPct + '%';
  document.getElementById('count-done').textContent     = cD;
  document.getElementById('count-needed').textContent   = cN;
  document.getElementById('count-inprog').textContent   = cI;
  document.getElementById('count-upcoming').textContent = cU;
  document.getElementById('tab-punch-count').textContent = tDone + '/' + tAll;
}

// ══════════════════════════════════════
//  MY TASKS — RENDER
// ══════════════════════════════════════
function isAshleyItem(item) { return !!item.querySelector('.ashley-tag'); }

function getStatusClass(item) {
  if (item.classList.contains('done'))     return 'done';
  if (item.classList.contains('inprog'))   return 'inprog';
  if (item.classList.contains('upcoming')) return 'upcoming';
  return 'needed';
}

function renderMyTasks() {
  const allItems = Array.from(document.querySelectorAll('#panel-punch-list .item'));
  let myItems;
  if (persona === 'ashley') {
    myItems = allItems.filter(i => isAshleyItem(i));
  } else {
    // Jerry sees all non-Ashley items (he owns everything else)
    myItems = allItems.filter(i => !isAshleyItem(i));
  }

  const p1list   = document.getElementById('mt-p1-list');
  const openlist = document.getElementById('mt-open-list');
  const inplist  = document.getElementById('mt-inprog-list');
  const donelist = document.getElementById('mt-done-list');
  p1list.innerHTML = openlist.innerHTML = inplist.innerHTML = donelist.innerHTML = '';

  let done = 0, open = 0, inprog = 0, p1count = 0;

  myItems.forEach(src => {
    const status = getStatusClass(src);
    const text   = src.querySelector('.item-text').textContent;
    const hasP1  = !!src.querySelector('.p1');
    const clone  = document.createElement('div');
    clone.className = 'mytask-item ' + status;
    const cbText = status === 'done' ? '✓' : (status === 'inprog' ? '~' : (status === 'upcoming' ? '→' : ''));
    clone.innerHTML = `<div class="checkbox" style="${status==='done'?'background:var(--green);border-color:var(--green);color:#000;font-weight:900;':''}${status==='inprog'?'border-color:var(--yellow);background:var(--yellow-dim);':''}">${cbText}</div><div class="item-content"><div class="item-text">${text}</div></div>`;
    clone.onclick = () => { src.click(); };

    if (status === 'done') { donelist.appendChild(clone); done++; }
    else if (status === 'inprog') { inplist.appendChild(clone); inprog++; }
    else if (status === 'upcoming') { /* skip from counts but show in open */ openlist.appendChild(clone); }
    else { // needed
      open++;
      if (hasP1) { p1count++; const p1clone = clone.cloneNode(true); p1clone.onclick = () => { src.click(); }; p1list.appendChild(p1clone); }
      openlist.appendChild(clone);
    }
  });

  const total = myItems.length;
  document.getElementById('mt-done').textContent   = done;
  document.getElementById('mt-open').textContent   = open;
  document.getElementById('mt-inprog').textContent = inprog;
  document.getElementById('mt-p1').textContent     = p1count;
  document.getElementById('mt-bar-label').textContent = done + ' of ' + total + ' complete';
  document.getElementById('mt-bar').style.width = (total > 0 ? Math.round(done/total*100) : 0) + '%';

  // Hide empty sections
  document.getElementById('mt-p1-section').style.display  = p1list.children.length  ? '' : 'none';
  document.getElementById('mt-inprog-section').style.display = inplist.children.length ? '' : 'none';
  document.getElementById('mt-done-section').style.display  = donelist.children.length ? '' : 'none';
}

// ══════════════════════════════════════
//  TEAM — RENDER
// ══════════════════════════════════════
function renderTeam() {
  const allItems = Array.from(document.querySelectorAll('#panel-punch-list .item'));
  const jerryItems  = allItems.filter(i => !isAshleyItem(i));
  const ashleyItems = allItems.filter(i => isAshleyItem(i));

  function buildList(container, items) {
    container.innerHTML = '';
    let done = 0, open = 0;
    items.forEach(src => {
      const status = getStatusClass(src);
      const text   = src.querySelector('.item-text').textContent;
      const hasP1  = !!src.querySelector('.p1');
      const row = document.createElement('div');
      row.className = 'team-item-row ' + status;
      const dotColor = status === 'done' ? 'var(--green)' : status === 'inprog' ? 'var(--yellow)' : status === 'upcoming' ? 'var(--blue)' : 'var(--red)';
      row.innerHTML = `<div class="team-item-dot ${status}" style="background:${dotColor}"></div><div class="team-item-text">${text}${hasP1 ? ' <span class="team-badge p1">P1</span>' : ''}</div>`;
      container.appendChild(row);
      if (status === 'done') done++;
      else if (status !== 'upcoming') open++;
    });
    return { done, open, total: items.length };
  }

  const jStats = buildList(document.getElementById('jerry-task-list'), jerryItems);
  const aStats = buildList(document.getElementById('ashley-task-list'), ashleyItems);

  document.getElementById('jerry-done').textContent  = jStats.done;
  document.getElementById('jerry-open').textContent  = jStats.open;
  document.getElementById('jerry-total').textContent = jStats.total;
  document.getElementById('jerry-bar').style.width   = jStats.total > 0 ? Math.round(jStats.done/jStats.total*100)+'%' : '0%';

  document.getElementById('ashley-done').textContent  = aStats.done;
  document.getElementById('ashley-open').textContent  = aStats.open;
  document.getElementById('ashley-total').textContent = aStats.total;
  document.getElementById('ashley-bar').style.width   = aStats.total > 0 ? Math.round(aStats.done/aStats.total*100)+'%' : '0%';

  document.getElementById('team-count').textContent = (jStats.open + aStats.open) + ' open';
}

// ══════════════════════════════════════
//  RECURRING TAB
// ══════════════════════════════════════
function toggleDay(id) {
  document.getElementById(id).classList.toggle('collapsed');
  updateDayCounts();
}

function toggleRecur(el) {
  if (el.classList.contains('done')) {
    el.classList.replace('done','needed');
    el.querySelector('.checkbox').textContent = '';
  } else {
    el.classList.replace('needed','done');
    el.querySelector('.checkbox').textContent = '✓';
  }
  updateDayCounts();
}

function updateDayCounts() {
  const days = ['mon','tue','wed','thu','fri','wknd'];
  const dayIds = {'mon':'day-mon','tue':'day-tue','wed':'day-wed','thu':'day-thu','fri':'day-fri','wknd':'day-wknd'};
  days.forEach(d => {
    const block = document.getElementById(dayIds[d]);
    if (!block) return;
    const items = block.querySelectorAll('.recur-item');
    const done  = block.querySelectorAll('.recur-item.done').length;
    const el = document.getElementById('count-' + d);
    if (el) el.textContent = items.length > 0 ? done + '/' + items.length : '—';
  });
}

function resetWeek() {
  document.querySelectorAll('.recur-item').forEach(el => {
    el.classList.remove('done');
    el.classList.add('needed');
    el.querySelector('.checkbox').textContent = '';
  });
  updateDayCounts();
}

function initRecurring() {
  // Highlight today's day block
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const dayMap = {1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',0:'wknd',6:'wknd'};
  const todayKey = dayMap[dayOfWeek];
  const todayBlock = document.getElementById('day-' + todayKey);
  if (todayBlock) {
    todayBlock.classList.add('today');
    const badge = document.getElementById('badge-' + todayKey);
    if (badge) badge.style.display = 'inline-block';
    // Expand today, collapse others
    ['mon','tue','wed','thu','fri','wknd'].forEach(d => {
      const b = document.getElementById('day-' + d);
      if (b) {
        if (d === todayKey) b.classList.remove('collapsed');
        else if (d !== 'mon' && d !== 'fri') b.classList.add('collapsed');
      }
    });
  }

  // Set week label
  const monday = new Date(now);
  monday.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
  const opts = {month:'short', day:'numeric', year:'numeric'};
  const lbl = document.getElementById('week-label');
  if (lbl) lbl.textContent = 'WEEK OF ' + monday.toLocaleDateString('en-US', opts).toUpperCase();

  updateDayCounts();
}

// ══════════════════════════════════════
//  INIT
// ══════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  updateAll();
  applyPersona();
  renderMyTasks();
  renderTeam();
  initRecurring();
});
updateAll();
applyPersona();
renderMyTasks();
renderTeam();
initRecurring();

// ══════════════════════════════════════
//  LAST UPDATED — DYNAMIC FROM GITHUB
// ══════════════════════════════════════
(function fetchLastUpdated() {
  const el = document.getElementById('last-updated-ts');
  if (!el) return;
  // Private repo — read .last-deployed from same origin (updated by Actions workflow)
  fetch('https://api.github.com/repos/ech-management-llc/TARS-COMMAND-CENTER/commits?per_page=1')
    .then(r => r.json())
    .then(data => {
      if (data && data[0] && data[0].commit) {
        const d = new Date(data[0].commit.committer.date);
        const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago' };
        el.textContent = d.toLocaleString('en-US', opts) + ' CT';
      } else {
        el.textContent = 'unavailable';
      }
    })
    .catch(() => { el.textContent = 'check network'; });
})();

// ══════════════════════════════════════
//  FINANCIALS — Foundation Layer API (Phase 1d cutover payload)
//  Public endpoint (TD-087). Honest display per Jerry's doctrine:
//  zeros + LIVE WIRE while the ledger is pre-flow; never fake, never blank.
// ══════════════════════════════════════
const FL_API = 'https://api.foundationlayerhq.com/api/dashboard/latest';
const FL_LS_KEY = 'tcc_fin_last_success';

function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function _fmtMoney(n){
  if (n===null || n===undefined || n==='' || isNaN(n)) return '—';
  n = Number(n);
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toLocaleString('en-US');
}
function _ruleColor(s){ return s==='RED'?'var(--red)':s==='YELLOW'?'var(--yellow)':'var(--green)'; }
function _fmtTs(iso){
  if (!iso) return '—';
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/Chicago'}) + ' CT';
  } catch(e){ return iso; }
}

function renderFinancials(){
  fetch(FL_API, { cache:'no-store' })
    .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d => {
      try { localStorage.setItem(FL_LS_KEY, JSON.stringify({ ts: d.generated_at })); } catch(e){}
      renderFinancialPayload(d);
    })
    .catch(err => renderFinancialError(err));
}

function renderFinancialPayload(d){
  const hm = d.headline_metrics || {};
  const allZero = ['total_revenue_ytd','total_noi_ytd','cash_position','total_debt'].every(k => !hm[k]);
  const bar = document.getElementById('fin-status-bar');
  if (bar){
    if (allZero){
      bar.className = 'fin-status-bar live-wire';
      bar.innerHTML = '🔌 LIVE WIRE — awaiting ledger flows (Phase 1d step 3). The Foundation Layer pipe is connected and verified; real figures populate when the ledger goes live.';
    } else {
      bar.className = 'fin-status-bar live-data';
      bar.innerHTML = '🟢 LIVE — Foundation Layer ledger data';
    }
  }

  const cr = d.capital_rules || {};
  const order = [['ltv','LTV'],['dscr','DSCR'],['liquidity','Liquidity'],['per_door','Per-door']];
  const grid = document.getElementById('capital-rules-grid');
  if (grid){
    grid.innerHTML = order.map(([key,fb]) => {
      const r = cr[key]; if(!r) return '';
      const status = r.status || 'GREEN';
      const fmt = key==='ltv' ? (v=>Math.round((v||0)*100)+'%')
                : key==='dscr' ? (v=>Number(v||0).toFixed(2)+'x')
                : (v=>_fmtMoney(v));
      return '<div class="cr-tile" style="border-left-color:'+_ruleColor(status)+'">'
        + '<div class="cr-label">'+_esc(r.label||fb)+'</div>'
        + '<div class="cr-status" style="background:'+_ruleColor(status)+'">'+_esc(status)+'</div>'
        + '<div class="cr-value">'+fmt(r.value)+'</div>'
        + '<div class="cr-meta">threshold '+fmt(r.threshold)+' · headroom '+fmt(r.headroom)+'</div>'
        + '</div>';
    }).join('');
  }

  const strip = document.getElementById('headline-metrics');
  if (strip){
    strip.innerHTML = [['Revenue YTD','total_revenue_ytd'],['NOI YTD','total_noi_ytd'],['Cash Position','cash_position'],['Total Debt','total_debt']]
      .map(([lbl,k]) => '<div class="hm-tile"><div class="hm-val">'+_fmtMoney(hm[k])+'</div><div class="hm-lbl">'+lbl+'</div></div>').join('');
  }

  const tbl = document.getElementById('entity-table');
  if (tbl){
    const ents = d.entities || [];
    tbl.innerHTML = '<thead><tr><th>Entity</th><th>Rev YTD</th><th>NOI YTD</th><th>Cash</th><th>Debt</th></tr></thead><tbody>'
      + ents.map(e => '<tr><td><span class="ent-code">'+_esc(e.code)+'</span><span class="ent-name">'+_esc(e.name)+'</span></td>'
        + '<td>'+_fmtMoney(e.revenue_ytd)+'</td><td>'+_fmtMoney(e.noi_ytd)+'</td><td>'+_fmtMoney(e.cash)+'</td><td>'+_fmtMoney(e.debt)+'</td></tr>').join('')
      + '</tbody>';
  }

  const foot = document.getElementById('fin-footer');
  if (foot){
    const fresh = d.data_freshness || {};
    const badges = Object.keys(fresh).map(k => {
      const f = fresh[k] || {};
      const st = String(f.status||'').toUpperCase();
      const cls = (st.includes('FRESH')||st.includes('OK')||st.includes('CURRENT')) ? 'fresh' : st.includes('STALE') ? 'stale' : '';
      return '<span class="fresh-badge '+cls+'">'+_esc(k.replace(/_/g,' '))+': '+_esc(f.last_export||f.status||'—')+'</span>';
    }).join('');
    foot.innerHTML = '<div class="fresh-row">'+badges+'</div>'
      + '<div class="fin-stamp">week of '+_esc(d.week_of)+' · generated '+_esc(_fmtTs(d.generated_at))+' · source '+_esc(d.data_source||'foundation-layer')+'</div>';
  }
}

function renderFinancialError(){
  let last = '';
  try { const s = JSON.parse(localStorage.getItem(FL_LS_KEY)||'null'); if (s && s.ts) last = ' · last success ' + _fmtTs(s.ts); } catch(e){}
  const bar = document.getElementById('fin-status-bar');
  if (bar){
    bar.className = 'fin-status-bar api-down';
    bar.innerHTML = '⚠ API unreachable — Foundation Layer dashboard is not responding'+last+'. No live figures shown (never fake).';
  }
  ['capital-rules-grid','headline-metrics','market-tiles'].forEach(id => { const el=document.getElementById(id); if(el && !el.innerHTML.trim()) el.innerHTML='<div class="fin-empty">— unavailable —</div>'; });
  const tbl = document.getElementById('entity-table'); if (tbl) tbl.innerHTML = '<tbody><tr><td class="fin-empty">— unavailable —</td></tr></tbody>';
}

// ══════════════════════════════════════
//  MARKET TILES — ./data/*.json snapshots (vault→repo push pipeline is a
//  TARS-side follow-up; design for graceful absence + >48h stale badge).
// ══════════════════════════════════════
const MARKET_SNAPSHOTS = [
  { file:'REVENTURE_LATEST.json',       title:'Reventure — Market',        render:m => 'cap rate + vacancy across ' + ((m.counties||m.markets||[]).length || '—') + ' counties' },
  { file:'CENSUS_VACANCY_LATEST.json',  title:'Census — Rental Vacancy',   render:m => 'gross rental vacancy (ACS 5-yr) across ' + ((m.counties||[]).length || '—') + ' counties' },
  { file:'DEALCHECK_PORTFOLIO.json',    title:'DealCheck — Portfolio',     render:m => ((m.properties||[]).length || '—') + ' properties tracked' },
];

function _isStale(ts){ if(!ts) return false; const t=new Date(ts).getTime(); if(isNaN(t)) return false; return (Date.now()-t) > 48*3600*1000; }
function _safe(fn,m){ try { return fn(m); } catch(e){ return 'snapshot present'; } }

function renderMarketTiles(){
  const wrap = document.getElementById('market-tiles');
  if (!wrap) return;
  wrap.innerHTML = '';
  MARKET_SNAPSHOTS.forEach(snap => {
    const tile = document.createElement('div');
    tile.className = 'market-tile';
    tile.innerHTML = '<div class="mt-title">'+_esc(snap.title)+'</div><div class="mt-body">loading…</div>';
    wrap.appendChild(tile);
    fetch('./data/'+snap.file, { cache:'no-store' })
      .then(r => { if(!r.ok) throw new Error('missing'); return r.json(); })
      .then(m => {
        const ts = m.scraped_at || m.generated_at || m.timestamp || m.last_updated;
        const stale = _isStale(ts);
        tile.innerHTML = '<div class="mt-title">'+_esc(snap.title)+(stale?' <span class="mt-stale">STALE &gt;48h</span>':'')+'</div>'
          + '<div class="mt-body">'+_esc(_safe(snap.render,m))+'</div>'
          + '<div class="mt-ts">'+(ts?'snapshot '+_esc(_fmtTs(ts)):'')+'</div>';
      })
      .catch(() => {
        tile.innerHTML = '<div class="mt-title">'+_esc(snap.title)+'</div><div class="mt-body awaiting">awaiting first snapshot push</div>';
      });
  });
}

// Init the financial + market render once the DOM is ready (containers live in
// #panel-financials). app.js is loaded with defer, so the DOM is parsed here.
(function initFinancialsTab(){
  function go(){ renderFinancials(); renderMarketTiles(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();

