/* FL CC platform standard — file-drop / search-and-add → Document Navigator (pass #7).
   One component every tile reuses for file intake — now SERVER-BACKED (Real-Data Foundation
   Part C): a signed-in user's dropped/picked files upload to the FL API document store
   (POST /api/documents → private bucket; kind = the folder slug, e.g. 'Permits & Codes' →
   'permits_codes') and typed names become REFERENCE notes (name-only, no file) in the shared
   /api/tile-state 'docnav_notes' ledger — both survive browsers and cache clears and show in
   the admin view. Signed OUT falls back to the legacy fl_documents_overlay_v1 breadcrumb with
   an honest "sign in to store files" note. FLState no longer auto-migrates that overlay up (an
   empty tenant must read 0); only an explicit add writes the server ledger. NO file content is
   ever kept front-end.
   Usage unchanged: FLDocDrop.mount(el, {folder:'Permits & Codes', source_tile:'compliance',
                                         label:'Drop reference docs', sub:'…', onAdd:fn}); */
(function(){
  var KEY = 'fl_documents_overlay_v1';   // legacy browser cache (still the signed-out fallback)
  var NOTES_KEY = 'docnav_notes';        // server tile-state ledger for name-only references

  function loadOv(){ try{ return JSON.parse(localStorage.getItem(KEY)) || {added:[]}; }catch(e){ return {added:[]}; } }
  function saveOv(ov){ try{ localStorage.setItem(KEY, JSON.stringify(ov)); }catch(e){} }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function authed(){ return !!(window.flApi && flApi.authed && flApi.authed()); }
  function kindOf(folder){
    return String(folder||'general').toLowerCase().replace(/[^a-z0-9]+/g,'_')
      .replace(/^_+|_+$/g,'').slice(0,40) || 'general';
  }

  // Legacy reference write (always caches locally; mirrors to the server ledger when signed in).
  function register(doc, opts){
    var entry = { name:doc, folder:opts.folder, source_tile:opts.source_tile,
                  added:new Date().toISOString().slice(0,10) };
    var ov = loadOv(); ov.added.push(entry); saveOv(ov);
    if (authed() && window.FLState){
      FLState.load(NOTES_KEY, KEY).then(function(r){
        var v = r.value || {added:[]};
        if (!v.added) v.added = [];
        // the LS write above may already be in the migrated copy — dedupe by identity fields
        var dup = v.added.some(function(d){ return d.name===entry.name && d.folder===entry.folder &&
                                                   d.source_tile===entry.source_tile && d.added===entry.added; });
        if (!dup) v.added.push(entry);
        FLState.save(NOTES_KEY, KEY, v);
      });
    }
    return entry;
  }

  function queued(opts){ // legacy sync read (local cache view) — mount() paints the merged live list
    return loadOv().added.filter(function(d){ return d.source_tile===opts.source_tile && d.folder===opts.folder; });
  }

  function mount(el, opts){
    el.classList.add('dropwrap');
    var LIST = null;                     // merged view: real uploads + reference notes
    var MSG = '';

    function refresh(){
      if (!authed() || !window.flDocuments){ LIST = null; paint(); return; }
      Promise.all([
        flDocuments.list({ kind: kindOf(opts.folder) }),
        (window.FLState ? FLState.load(NOTES_KEY, KEY) : Promise.resolve({value:null}))
      ]).then(function(res){
        var docs = (res[0] && res[0].ok ? res[0].data : []) || [];
        var notes = ((res[1].value||{}).added||[]).filter(function(d){
          return d.source_tile===opts.source_tile && d.folder===opts.folder; });
        LIST = docs.map(function(d){ return { name:d.name, added:String(d.uploaded_at||'').slice(0,10), real:true, id:d.id }; })
               .concat(notes.map(function(d){ return { name:d.name, added:d.added, real:false }; }));
        paint();
      });
    }

    function upload(files){
      var todo = Array.prototype.slice.call(files||[]).filter(Boolean);
      if (!todo.length) return;
      MSG = 'Uploading…'; paint();
      Promise.all(todo.map(function(f){
        return flDocuments.upload(f, { kind: kindOf(opts.folder), notes: 'via '+opts.source_tile });
      })).then(function(results){
        var okN = results.filter(function(r){ return r && r.ok; }).length;
        var bad = results.find(function(r){ return r && !r.ok; });
        MSG = okN === todo.length ? ('✓ '+okN+' file'+(okN===1?'':'s')+' stored')
          : bad && bad.status === 413 ? 'A file is over the 25 MB limit — smaller files stored.'
          : bad && bad.status === 0 ? 'Upload failed — service unreachable; nothing was lost, retry.'
          : 'Some uploads failed (HTTP '+((bad&&bad.status)||'?')+') — the rest stored.';
        if (okN && opts.onAdd) opts.onAdd({ uploaded: okN });
        refresh();
      });
    }

    function paint(){
      var live = authed() && window.flDocuments;
      var q = LIST != null ? LIST : queued(opts);
      el.innerHTML =
        '<div class="drop" data-dz><b>⬇ '+esc(opts.label||'Drop files')+'</b>'+
          esc(opts.sub||'filed into Document Navigator')+
          (live ? '' : ' <i class="muted">(sign in to store files — names are only noted locally until then)</i>')+
          '<div class="droprow"><input type="text" data-dq placeholder="🔎 type a reference name… (real files: drop or Attach)">'+
          (live ? '<button class="dadd" type="button" data-dp>📎 Attach file</button>' : '')+
          '<button class="dadd" type="button" data-da>+ Note</button></div>'+
          (live ? '<input type="file" data-df multiple style="display:none">' : '')+
          (MSG ? '<div class="small" style="margin-top:6px">'+esc(MSG)+'</div>' : '')+
        '</div>'+
        (q.length ? '<div class="dropq">'+q.map(function(d){
          return '<span class="dqi">'+(d.real?'📄':'📝')+' '+esc(d.name)+' <i>'+esc(d.added||'')+(d.real?'':' · reference')+'</i></span>';
        }).join('')+'</div>' : '');
      var dz = el.querySelector('[data-dz]'), inp = el.querySelector('[data-dq]'),
          btn = el.querySelector('[data-da]'), pick = el.querySelector('[data-dp]'),
          fileIn = el.querySelector('[data-df]');
      function addNote(name){
        if(!name) return;
        var doc = register(name, opts);
        MSG = '📝 noted (name only — attach the file to store it)';
        if (LIST != null) LIST.push({ name:doc.name, added:doc.added, real:false });
        paint();
        if(opts.onAdd) opts.onAdd(doc);
      }
      btn.onclick = function(e){ e.stopPropagation(); addNote(inp.value.trim()); };
      if (pick){ pick.onclick = function(e){ e.stopPropagation(); fileIn.click(); }; }
      if (fileIn){ fileIn.onchange = function(){ upload(fileIn.files); }; }
      inp.onclick = function(e){ e.stopPropagation(); };
      inp.onkeydown = function(e){ if(e.key==='Enter') addNote(inp.value.trim()); };
      dz.ondragover = function(e){ e.preventDefault(); dz.classList.add('hot'); };
      dz.ondragleave = function(){ dz.classList.remove('hot'); };
      dz.ondrop = function(e){
        e.preventDefault(); dz.classList.remove('hot');
        var files = (e.dataTransfer&&e.dataTransfer.files)||[];
        if (live && files.length){ upload(files); }
        else { for(var i=0;i<files.length;i++) addNote(files[i].name); } // signed-out: name note only
      };
    }
    paint();
    refresh();
  }

  window.FLDocDrop = { mount: mount, register: register, queued: queued };
})();
