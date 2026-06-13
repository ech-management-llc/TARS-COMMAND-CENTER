/* ════════════════════════════════════════════════════════════════
   fl-scope-select.js — SHARED multi-entity / multi-property scope selector
   Platform standard, generalized from the Financial entity scope (Change 39) and the
   Rent Roll property scope (Change 43) so every multi-axis tile reuses ONE implementation.

   Drop-in. In any tile artifact:
     <script src="../../../shared/fl-scope-select.js"></script>
     var scope = FLScope.create({
       items:      [{id, label, sub?, ...}],   // the things being scoped
       unit:       'entity',                    // or 'property' — noun for labels
       unitPlural: 'entities',                  // optional (defaults unit+'s')
       label:      'Financials for',            // bar prefix
       persistKey: 'tcc_fin_entity_sel',        // localStorage key
       quickPicks: [{label, ids:[...]}],        // optional (e.g. by owner/entity)
       groups:     [{label, match:fn(item)}],   // optional checklist grouping (e.g. SF/MF)
       host:       '#scopebar',                 // OPTIONAL — render the default bar+modal here.
                                                //   Omit it to drive your own UI via the API below.
       onChange:   function(ids, isAll){ ... }  // called on load + every change
     });
     scope.selected()  -> array of selected ids (all ids when "all")
     scope.isAll()     -> bool        scope.has(id) -> bool
     scope.toggle(id)  scope.set(ids)  scope.selectAll()  scope.openChooser()  scope.refresh()

   • State + persistence + onChange are always available; the default bar/modal is opt-in (host).
     Financial keeps its rows-as-toggles UX by using the API without a host; Rent Roll + new
     tiles use the default bar+modal for free.
   • "all" persists by clearing the key; a subset persists the id list; stale ids pruned on load.
   • Quote-safe: addEventListener + data-attributes — NO inline onclick / JSON.stringify (TD-096).
   ════════════════════════════════════════════════════════════════ */
(function(){
  if (window.FLScope) return;                            // singleton guard
  var cssDone=false, modalEl=null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function injectCss(){
    if(cssDone) return; cssDone=true;
    var css=
      '.flsc-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--surf);border:1px solid var(--line);border-radius:var(--radius-sm);padding:9px 12px;margin-bottom:12px;font-size:13px}'+
      '.flsc-si{font-weight:600}'+
      '.flsc-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:18px;z-index:60}'+
      '.flsc-modal.on{display:flex}'+
      '.flsc-card{background:var(--bg,#0d0f14);border:1px solid var(--line);border-radius:var(--radius);max-width:460px;width:100%;padding:18px;max-height:85vh;overflow:auto}'+
      '.flsc-card h3{margin:0 0 4px;font-size:16px}'+
      '.flsc-x{float:right;cursor:pointer;color:var(--mut);font-size:20px;line-height:1;border:0;background:none}'+
      '.flsc-qp{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}'+
      '.flsc-sub{font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--mut);margin:12px 0 6px}'+
      '.flsc-pick{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:6px;cursor:pointer}'+
      '.flsc-pick:hover{background:var(--surf2)}.flsc-pick.on{background:var(--greenbg);border-color:var(--greenln)}'+
      '.flsc-ck{display:inline-block;width:16px;color:var(--green);font-weight:800}'+
      '.flsc-act{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--surf2);border:1px solid var(--line);color:var(--fg,#e8e8ea);border-radius:var(--radius-sm);padding:11px 13px;margin-top:8px;cursor:pointer;font-size:14px;font-weight:600}'+
      '.flsc-act:hover{border-color:var(--green)}.flsc-act .ico{font-size:17px}';
    var st=document.createElement('style'); st.id='flsc-css'; st.textContent=css; document.head.appendChild(st);
  }
  function ensureModal(){
    if(modalEl) return modalEl;
    injectCss();
    modalEl=document.createElement('div'); modalEl.className='flsc-modal';
    modalEl.innerHTML='<div class="flsc-card" id="flsc-card"></div>';
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', function(e){ if(e.target===modalEl) closeModal(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });
    return modalEl;
  }
  function setCard(html){ ensureModal(); document.getElementById('flsc-card').innerHTML=html; modalEl.classList.add('on'); }
  function closeModal(){ if(modalEl) modalEl.classList.remove('on'); }

  function create(opts){
    opts=opts||{};
    var items=opts.items||[];
    var unitPlural=opts.unitPlural||((opts.unit||'item')+'s');
    var key=opts.persistKey;
    var quickPicks=opts.quickPicks||[];
    var groups=opts.groups||null;
    var hostEl=typeof opts.host==='string'?document.querySelector(opts.host):opts.host;
    var onChange=opts.onChange||function(){};
    var idOf=opts.idOf||function(it){ return it.id; };
    var labelOf=opts.labelOf||function(it){ return it.label||it.id; };
    var SEL=null;                                        // null = all

    function allIds(){ return items.map(idOf); }
    function isAll(){ return !SEL || SEL.length>=items.length; }
    function has(id){ return !SEL || SEL.indexOf(id)>=0; }
    function selected(){ return isAll()?allIds():SEL.slice(); }
    function count(){ return isAll()?items.length:SEL.length; }
    function load(){
      try{ var s=JSON.parse(localStorage.getItem(key)||'null');
        if(Array.isArray(s)&&s.length){ var valid=allIds(); SEL=s.filter(function(i){ return valid.indexOf(i)>=0; }); if(!SEL.length) SEL=null; }
      }catch(e){}
    }
    function save(){ try{ if(SEL&&SEL.length&&SEL.length<items.length) localStorage.setItem(key, JSON.stringify(SEL)); else localStorage.removeItem(key); }catch(e){} }
    function fire(){ save(); renderBar(); refreshChooser(); onChange(selected(), isAll()); }
    function setAll(){ SEL=null; fire(); }
    function set(ids){ var valid=allIds(); var f=(ids||[]).filter(function(i){return valid.indexOf(i)>=0;}); SEL=(f.length&&f.length<items.length)?f:null; fire(); }
    function toggle(id){ if(!SEL) SEL=allIds(); var i=SEL.indexOf(id); if(i>=0) SEL.splice(i,1); else SEL.push(id); if(!SEL.length) SEL=null; fire(); }

    function renderBar(){
      if(!hostEl) return;
      hostEl.className='flsc-bar';
      hostEl.innerHTML='<span class="flsc-si">'+esc(opts.label||'Showing')+':</span> '+
        '<span>'+(isAll()?('All '+esc(unitPlural)+' ('+items.length+')'):(count()+' of '+items.length+' '+esc(unitPlural)))+'</span>'+
        '<button class="btn sm" data-flsc="open" style="margin-left:6px">Choose '+esc(unitPlural)+'</button>'+
        (!isAll()?'<button class="btn sm" data-flsc="all">Show all</button>':'');
      hostEl.querySelectorAll('[data-flsc]').forEach(function(b){
        b.addEventListener('click', function(){ var a=b.getAttribute('data-flsc'); if(a==='open') openChooser(); else if(a==='all') setAll(); });
      });
    }

    function chooserBody(){
      var head='<button class="flsc-x" data-flsc="close">×</button><h3>📋 Choose '+esc(unitPlural)+'</h3>'+
        '<div class="small muted" style="margin-bottom:8px">Select one, several, or all. The whole tile follows your selection.</div>'+
        '<div class="flsc-qp"><button class="btn sm" data-flsc="all">All '+esc(unitPlural)+'</button>'+
          quickPicks.map(function(q,qi){ return '<button class="btn sm" data-flsc="qp" data-qpi="'+qi+'">'+esc(q.label)+'</button>'; }).join('')+'</div>';
      function row(it){ var id=idOf(it), on=has(id);
        return '<div class="flsc-pick'+(on?' on':'')+'" data-flsc="pick" data-id="'+esc(id)+'"><div><span class="flsc-ck">'+(on?'✓':'·')+'</span> '+esc(labelOf(it))+(it.sub?'<div class="small muted" style="margin-left:24px">'+esc(it.sub)+'</div>':'')+'</div></div>'; }
      var list;
      if(groups&&groups.length){
        list=groups.map(function(g){ var gi=items.filter(g.match); if(!gi.length) return ''; return '<div class="flsc-sub">'+esc(g.label)+'</div>'+gi.map(row).join(''); }).join('');
      } else { list=items.map(row).join(''); }
      return head+list+'<button class="flsc-act" data-flsc="close"><span class="ico">✅</span> Done <span class="small muted" style="margin-left:auto">'+count()+' selected</span></button>';
    }
    function openChooser(){ setCard(chooserBody()); wireChooser(); }
    function refreshChooser(){ if(modalEl && modalEl.classList.contains('on') && document.getElementById('flsc-card')){ setCard(chooserBody()); wireChooser(); } }
    function wireChooser(){
      var card=document.getElementById('flsc-card'); if(!card) return;
      card.querySelectorAll('[data-flsc]').forEach(function(el){
        var a=el.getAttribute('data-flsc');
        el.addEventListener('click', function(){
          if(a==='close') closeModal();
          else if(a==='all') setAll();
          else if(a==='qp'){ var q=quickPicks[+el.getAttribute('data-qpi')]; if(q) set(q.ids); }
          else if(a==='pick') toggle(el.getAttribute('data-id'));
        });
      });
    }

    load();
    renderBar();
    onChange(selected(), isAll());                       // initial paint
    return { selected:selected, isAll:isAll, has:has, count:count, set:set, toggle:toggle, selectAll:setAll, openChooser:openChooser, refresh:renderBar };
  }

  window.FLScope = { create: create };
})();
