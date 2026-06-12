/* FL CC platform standard — file-drop / search-and-add → Document Navigator (pass #6).
   One component every tile reuses for file intake. Registered files land in the
   Document Navigator data source as {name, folder, source_tile, added} via the
   localStorage overlay fl_documents_overlay_v1 {added:[doc…]} merged over
   data/STUB_DOCUMENTS.json — same honest overlay pattern as the calendar.
   Backend replaces the overlay with real vault writes; the component API stays.
   NO file CONTENT is stored front-end — name + metadata only (no secrets/PII).
   Usage: FLDocDrop.mount(el, {folder:'Permits & Codes', source_tile:'compliance',
                               label:'Drop reference docs', sub:'filed into Document Navigator',
                               onAdd:function(doc){...}});                     */
(function(){
  var KEY = 'fl_documents_overlay_v1';

  function loadOv(){ try{ return JSON.parse(localStorage.getItem(KEY)) || {added:[]}; }catch(e){ return {added:[]}; } }
  function saveOv(ov){ try{ localStorage.setItem(KEY, JSON.stringify(ov)); }catch(e){} }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function register(doc, opts){
    var ov = loadOv();
    ov.added.push({ name:doc, folder:opts.folder, source_tile:opts.source_tile, added:new Date().toISOString().slice(0,10) });
    saveOv(ov);
    return ov.added[ov.added.length-1];
  }

  function queued(opts){ // docs this tile has filed (its review/reference queue)
    return loadOv().added.filter(function(d){ return d.source_tile===opts.source_tile && d.folder===opts.folder; });
  }

  function mount(el, opts){
    el.classList.add('dropwrap');
    function paint(){
      var q = queued(opts);
      el.innerHTML =
        '<div class="drop" data-dz><b>⬇ '+esc(opts.label||'Drop files')+'</b>'+esc(opts.sub||'filed into Document Navigator')+
          '<div class="droprow"><input type="text" data-dq placeholder="🔎 or search the vault / type a file name…">'+
          '<button class="dadd" type="button" data-da>+ Add</button></div></div>'+
        (q.length ? '<div class="dropq">'+q.map(function(d){ return '<span class="dqi">📄 '+esc(d.name)+' <i>'+esc(d.added)+'</i></span>'; }).join('')+'</div>' : '');
      var dz = el.querySelector('[data-dz]'), inp = el.querySelector('[data-dq]'), btn = el.querySelector('[data-da]');
      function add(name){
        if(!name) return;
        var doc = register(name, opts);
        paint();
        if(opts.onAdd) opts.onAdd(doc);
      }
      btn.onclick = function(e){ e.stopPropagation(); add(inp.value.trim()); };
      inp.onclick = function(e){ e.stopPropagation(); };
      inp.onkeydown = function(e){ if(e.key==='Enter') add(inp.value.trim()); };
      dz.ondragover = function(e){ e.preventDefault(); dz.classList.add('hot'); };
      dz.ondragleave = function(){ dz.classList.remove('hot'); };
      dz.ondrop = function(e){
        e.preventDefault(); dz.classList.remove('hot');
        var files = (e.dataTransfer&&e.dataTransfer.files)||[];
        for(var i=0;i<files.length;i++) add(files[i].name); // metadata only — content never stored front-end
      };
    }
    paint();
  }

  window.FLDocDrop = { mount: mount, register: register, queued: queued };
})();
