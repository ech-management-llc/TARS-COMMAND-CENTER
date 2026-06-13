/* ════════════════════════════════════════════════════════════════
   fl-tile-settings.js — SHARED tunable per-owner tile settings + employee-first setup
   Platform standard, extracted from the Rent Roll proof (Change 42) so every tile
   reuses ONE implementation instead of reinventing it.

   Drop-in. In any tile artifact:
     <script src="../../../shared/fl-tile-settings.js"></script>
     var settings = FLSettings.mount({
       tileId:  'rent-roll',            // key into data/STUB_TILE_SETTINGS.json tiles{}
       host:    '#setbar',              // element or selector to render the setbar into
       onChange: function(eff){ ... }   // called with effective params on load + every change
       // optional: dataUrl, owner, greet:false, title
     });
     settings.get()    -> effective params for the current owner   { key: value, ... }
     settings.owner()  -> current owner name
     settings.refresh()-> re-render the setbar

   • Self-contained: injects its own CSS + modal; fetches STUB_TILE_SETTINGS.json once (shared).
   • Per-owner: ECH may manage for different owners, each with their own thresholds.
     Resolution order: per-owner localStorage answer -> file owner override -> tile default.
   • Employee-first: the tile's AI employee greets and asks; Manual form is the no-plug-in fallback.
   • Honest stub: persists answers to localStorage per owner; backend replaces this at connector phase.
   • Quote-safe: addEventListener + data-attributes — NO inline onclick / JSON.stringify (TD-096).
   ════════════════════════════════════════════════════════════════ */
(function(){
  if (window.FLSettings) return;                         // singleton guard

  var DEFAULT_URL = '../../../data/STUB_TILE_SETTINGS.json';
  var DEFAULT_OWNER = 'ECH Management (self-managed)';
  var cfgPromise = null;                                 // one shared fetch of the settings file
  var cssDone = false, modalEl = null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(n){ if(n==null||isNaN(n)) return '—'; return '$'+Number(n).toLocaleString('en-US'); }

  function loadCfg(url){
    if(!cfgPromise){
      cfgPromise = fetch(url||DEFAULT_URL,{cache:'no-store'})
        .then(function(r){ return r.ok?r.json():null; })
        .catch(function(){ return null; });
    }
    return cfgPromise;
  }

  function injectCss(){
    if(cssDone) return; cssDone = true;
    var css =
      '.fls-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surf);border:1px solid var(--line);border-radius:var(--radius-sm);padding:9px 12px;margin-bottom:12px;font-size:13px}'+
      '.fls-si{font-weight:600}.fls-mut{color:var(--mut)}'+
      '.fls-emp{display:inline-flex;align-items:center;gap:6px;font-weight:700}'+
      '.fls-av{width:22px;height:22px;border-radius:50%;background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}'+
      '.fls-link{background:none;border:0;color:var(--mut);font-weight:600;cursor:pointer;font-size:12px;margin-left:auto;text-decoration:underline}'+
      '.fls-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:18px;z-index:60}'+
      '.fls-modal.on{display:flex}'+
      '.fls-card{background:var(--bg,#0d0f14);border:1px solid var(--line);border-radius:var(--radius);max-width:460px;width:100%;padding:18px;max-height:85vh;overflow:auto}'+
      '.fls-card h3{margin:0 0 4px;font-size:16px}'+
      '.fls-x{float:right;cursor:pointer;color:var(--mut);font-size:20px;line-height:1;border:0;background:none}'+
      '.fls-q{margin-top:14px}.fls-q label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}'+
      '.fls-in{width:100%;background:var(--surf2);border:1px solid var(--line);color:var(--fg,#e8e8ea);border-radius:var(--radius-sm);padding:10px 12px;font-size:15px;box-sizing:border-box}'+
      '.fls-seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden}'+
      '.fls-seg button{background:var(--surf2);border:0;color:var(--mut);padding:5px 11px;font-size:11px;font-weight:700;cursor:pointer}'+
      '.fls-seg button.on{background:var(--green);color:#06150f}'+
      '.fls-act{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--surf2);border:1px solid var(--line);color:var(--fg,#e8e8ea);border-radius:var(--radius-sm);padding:11px 13px;margin-top:8px;cursor:pointer;font-size:14px;font-weight:600}'+
      '.fls-act:hover{border-color:var(--green)}.fls-act .ico{font-size:17px}'+
      '.fls-note{background:var(--surf);border:1px solid var(--line);border-radius:var(--radius-sm);padding:11px;margin-top:12px;font-size:12px;color:var(--mut);line-height:1.5}';
    var st = document.createElement('style'); st.id='fls-css'; st.textContent=css; document.head.appendChild(st);
  }

  function ensureModal(){
    if(modalEl) return modalEl;
    injectCss();
    modalEl = document.createElement('div');
    modalEl.className = 'fls-modal';
    modalEl.innerHTML = '<div class="fls-card" id="fls-card"></div>';
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', function(e){ if(e.target===modalEl) closeModal(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });
    return modalEl;
  }
  function setCard(html){ ensureModal(); document.getElementById('fls-card').innerHTML = html; modalEl.classList.add('on'); }
  function closeModal(){ if(modalEl) modalEl.classList.remove('on'); }

  /* ── one mounted instance per tile ── */
  function mount(opts){
    opts = opts || {};
    var tileId  = opts.tileId;
    var hostEl  = typeof opts.host==='string' ? document.querySelector(opts.host) : opts.host;
    if(!hostEl){                                   // no host given: auto-place the bar just under the tile heading
      hostEl=document.createElement('div');
      var _h=document.querySelector('.art-head');
      if(_h && _h.parentNode){ _h.parentNode.insertBefore(hostEl, _h.nextSibling); }
      else { var _w=document.querySelector('.art-wrap')||document.body; _w.insertBefore(hostEl, _w.firstChild); }
    }
    var onChange= opts.onChange || function(){};
    var SETCFG=null, OWNER=null, EMP=true, MODE='guided';

    function tileCfg(){ return (SETCFG && SETCFG.tiles && SETCFG.tiles[tileId]) || {params:[]}; }
    function params(){ return tileCfg().params || []; }
    function emp(){ return tileCfg().employee || {name:'your employee', avatar:'•', intro:''}; }
    function title(){ return opts.title || tileCfg().title || tileId; }
    function lsKey(owner){ return 'tcc_tile_settings::'+tileId+'::'+owner; }
    function savedFor(owner){ try{ return JSON.parse(localStorage.getItem(lsKey(owner))||'null'); }catch(e){ return null; } }
    function configured(owner){ return !!savedFor(owner); }
    function effective(owner){
      var out={}; params().forEach(function(p){ out[p.key]=p.default; });
      var fileOv=(tileCfg().owners||{})[owner]; if(fileOv){ for(var k in fileOv) out[k]=fileOv[k]; }
      var ls=savedFor(owner); if(ls&&ls.values){ for(var k2 in ls.values) out[k2]=ls.values[k2]; }
      return out;
    }
    function ownersList(){ var l=[OWNER]; var o=tileCfg().owners||{}; Object.keys(o).forEach(function(k){ if(l.indexOf(k)<0) l.push(k); }); return l; }

    function renderSetbar(){
      if(!hostEl) return;
      injectCss();                                 // ensure styles exist even before any modal opens
      hostEl.className='fls-bar';
      var e=emp(), hasParams=params().length>0;
      var demo='<button class="fls-link" data-fls="demo" title="demo only — simulates the employee plug-in on/off">demo: employee '+(EMP?'ON':'OFF')+'</button>';
      if(hasParams && configured(OWNER)){
        var saved=savedFor(OWNER), by=saved.by||(EMP?e.name:'manual'), eff=effective(OWNER);
        var summary=params().map(function(p){ return esc(p.label.split('(')[0].trim())+': '+(p.type==='money'?money(eff[p.key]):(esc(eff[p.key])+(p.unit?(' '+p.unit):''))); }).slice(0,3).join(' · ');
        hostEl.innerHTML='<span class="fls-si">⚙️ Tuned '+(by==='manual'?'manually':('by '+esc(by)))+' for '+esc(OWNER)+'</span>'+
          '<span class="fls-mut">'+summary+'</span>'+
          '<button class="btn sm" data-fls="adjust">Adjust</button>'+demo;
      } else if(EMP){
        hostEl.innerHTML='<span class="fls-emp"><span class="fls-av">'+esc(e.avatar)+'</span> '+esc(e.name)+(hasParams?' can set this tile up for you':' is set up and ready')+'</span>'+
          '<button class="btn sm primary" data-fls="guided">'+(hasParams?('Set up with '+esc(e.name)):('Meet '+esc(e.name)))+'</button>'+
          (hasParams?'<button class="btn sm" data-fls="manual">Manual setup</button>':'')+demo;
      } else {
        hostEl.innerHTML='<span class="fls-si">⚙️ '+(hasParams?'This tile isn’t set up':'No setup needed')+'</span>'+
          '<span class="fls-mut">'+(hasParams?'AI employee is a paid add-on — set the parameters manually':'Nothing to tune on this tile yet')+'</span>'+
          (hasParams?'<button class="btn sm primary" data-fls="manual">Manual settings</button>':'')+demo;
      }
      hostEl.querySelectorAll('[data-fls]').forEach(function(b){
        b.addEventListener('click', function(){
          var a=b.getAttribute('data-fls');
          if(a==='demo'){ EMP=!EMP; if(!EMP) MODE='manual'; renderSetbar(); }
          else if(a==='adjust') openSetup();
          else if(a==='guided') openSetup('guided');
          else if(a==='manual') openSetup('manual');
        });
      });
    }

    function setupBody(){
      var e=emp(), guided=(MODE==='guided'&&EMP), eff=effective(OWNER), hasParams=params().length>0;
      var head='<button class="fls-x" data-fls="close">×</button>';
      if(guided){ head+='<h3><span class="fls-emp"><span class="fls-av">'+esc(e.avatar)+'</span> '+(hasParams?('Set up with '+esc(e.name)):('Meet '+esc(e.name)))+'</span></h3><div class="small muted" style="margin-bottom:8px">'+esc(e.intro||'')+'</div>'; }
      else { head+='<h3>⚙️ Manual settings — '+esc(title())+'</h3><div class="small muted" style="margin-bottom:8px">Set each parameter for this owner. '+(EMP?'':'(The guided setup needs the AI employee add-on.)')+'</div>'; }
      // owner picker — who these settings apply to
      var owners=ownersList();
      var osel='<div class="fls-q"><label>These settings apply to</label><select class="fls-in" data-fls="owner">'+owners.map(function(o){return '<option'+(o===OWNER?' selected':'')+'>'+esc(o)+'</option>';}).join('')+'</select><div class="small muted" style="margin-top:4px">Each owner can have different rules — this is '+esc(OWNER)+'.</div></div>';
      // mode toggle (only when the employee is available)
      var toggle = EMP ? '<div style="margin-top:10px"><span class="fls-seg"><button class="'+(guided?'on':'')+'" data-fls="mode-guided">Ask '+esc(e.name)+'</button><button class="'+(!guided?'on':'')+'" data-fls="mode-manual">Manual</button></span></div>' : '';
      if(!hasParams){
        return head+toggle+'<div class="fls-note">Nothing to tune on this tile yet — '+esc(e.name)+' is ready. As this tile gains options, they’ll show up here for '+esc(OWNER)+'.</div>'+
          '<button class="fls-act" data-fls="close"><span class="ico">👍</span> Got it</button>';
      }
      var fields=params().map(function(p){
        var prompt=guided?esc(p.q||p.label):esc(p.label);
        var unit=p.unit?(' <span class="muted">('+esc(p.unit)+')</span>'):(p.type==='money'?' <span class="muted">($)</span>':'');
        return '<div class="fls-q"><label>'+prompt+unit+'</label><input class="fls-in" id="fls_set_'+esc(p.key)+'" type="number" value="'+esc(eff[p.key])+'"'+(p.min!=null?' min="'+p.min+'"':'')+(p.max!=null?' max="'+p.max+'"':'')+'></div>';
      }).join('');
      var note=guided
        ? '<div class="fls-note">'+esc(e.name)+' writes your answers to this tile’s settings for '+esc(OWNER)+'. Change them anytime. (Saved on this device for now; syncs to your account when wired.)</div>'
        : '<div class="fls-note">Manual settings save to this tile for '+esc(OWNER)+'. '+(EMP?'Prefer questions? Switch to “Ask '+esc(e.name)+'.”':'The AI employee add-on can do this for you with a few questions.')+'</div>';
      var actions='<button class="fls-act" data-fls="save"><span class="ico">✅</span> Save settings</button>'+
        '<button class="fls-act" data-fls="defaults"><span class="ico">↩️</span> Use the defaults</button>';
      return head+toggle+osel+fields+actions+note;
    }

    function showSetup(){ setCard(setupBody()); wireSetup(); }
    function openSetup(mode){ if(mode) MODE=mode; if(!EMP) MODE='manual'; showSetup(); }
    function wireSetup(){
      var card=document.getElementById('fls-card'); if(!card) return;
      card.querySelectorAll('[data-fls]').forEach(function(el){
        var a=el.getAttribute('data-fls');
        if(a==='owner'){ el.addEventListener('change', function(){ OWNER=el.value; renderSetbar(); onChange(effective(OWNER)); showSetup(); }); return; }
        el.addEventListener('click', function(){
          if(a==='close') closeModal();
          else if(a==='mode-guided'){ MODE='guided'; showSetup(); }
          else if(a==='mode-manual'){ MODE='manual'; showSetup(); }
          else if(a==='save') saveSetup();
          else if(a==='defaults') useDefaults();
        });
      });
    }
    function saveSetup(){
      var vals={}; params().forEach(function(p){ var el=document.getElementById('fls_set_'+p.key); if(el){ var n=Number(el.value); vals[p.key]=isNaN(n)?p.default:n; } });
      try{ localStorage.setItem(lsKey(OWNER), JSON.stringify({by:(MODE==='guided'&&EMP)?emp().name:'manual', values:vals, at:new Date().toISOString()})); }catch(e){}
      closeModal(); renderSetbar(); onChange(effective(OWNER));
    }
    function useDefaults(){ try{ localStorage.removeItem(lsKey(OWNER)); }catch(e){} closeModal(); renderSetbar(); onChange(effective(OWNER)); }

    var ctrl = {
      get:     function(){ return effective(OWNER); },
      owner:   function(){ return OWNER; },
      refresh: function(){ renderSetbar(); },
      openSetup: function(mode){ openSetup(mode); }
    };
    loadCfg(opts.dataUrl).then(function(cfg){
      SETCFG = cfg || {};
      OWNER  = opts.owner || SETCFG.default_owner || DEFAULT_OWNER;
      if(SETCFG.employee_plugin_enabled===false) EMP=false;
      MODE = EMP ? 'guided' : 'manual';
      renderSetbar();
      onChange(effective(OWNER));                                   // initial effective params
      if(opts.greet!==false && params().length && !configured(OWNER)) openSetup();  // employee greets first
      if(opts.onReady) opts.onReady(ctrl);
    });
    return ctrl;
  }

  window.FLSettings = { mount: mount };
})();
