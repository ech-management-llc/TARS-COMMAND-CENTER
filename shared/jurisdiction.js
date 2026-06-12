/* FL CC platform standard — shared jurisdiction picker (pass #6).
   One control: State → County/Parish → Municipality. Selection persists in
   localStorage (fl_jurisdiction_v1) and is SHARED across every consuming tile
   (Legal, Compliance/Permits, Taxes later) — pick it once, every tile follows.
   Usage (from an artifact at /layers/<id>/artifact/):
     <div id="jur"></div>
     <script src="../../../shared/jurisdiction.js"></script>
     FLJur.mount(document.getElementById('jur'), function(sel){ ...re-pull... });
   sel = {state, state_code, county_label, county, municipality}.            */
(function(){
  var KEY = 'fl_jurisdiction_v1';
  var DATA = null;

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)); }catch(e){ return null; } }
  function save(sel){ try{ localStorage.setItem(KEY, JSON.stringify(sel)); }catch(e){} }

  function current(){
    var saved = load();
    if(saved && DATA && DATA.states.some(function(s){ return s.name===saved.state; })) return saved;
    var s = DATA.states[0], c = s.counties[0];
    return { state:s.name, state_code:s.code, county_label:s.county_label, county:c.name, municipality:c.municipalities[0] };
  }

  function mount(el, onChange){
    fetch('../../../data/STUB_JURISDICTIONS.json',{cache:'no-store'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(d){ DATA = d; render(el, onChange); })
      .catch(function(){ el.innerHTML = '<span class="small dim">jurisdiction source not reachable</span>'; });
  }

  function render(el, onChange){
    var sel = current();
    var st = DATA.states.filter(function(s){ return s.name===sel.state; })[0] || DATA.states[0];
    var co = st.counties.filter(function(c){ return c.name===sel.county; })[0] || st.counties[0];
    el.innerHTML =
      '<span class="jl">JURISDICTION</span>'+
      '<select data-j="state">'+DATA.states.map(function(s){ return '<option'+(s.name===sel.state?' selected':'')+'>'+s.name+'</option>'; }).join('')+'</select>'+
      '<select data-j="county" title="'+st.county_label+'">'+st.counties.map(function(c){ return '<option'+(c.name===sel.county?' selected':'')+'>'+c.name+'</option>'; }).join('')+'</select>'+
      '<select data-j="muni">'+co.municipalities.map(function(m){ return '<option'+(m===sel.municipality?' selected':'')+'>'+m+'</option>'; }).join('')+'</select>'+
      '<span class="small dim">shared across tiles · persists</span>';
    el.querySelectorAll('select').forEach(function(s){
      s.onchange = function(){
        var stEl = el.querySelector('[data-j=state]'), coEl = el.querySelector('[data-j=county]'), muEl = el.querySelector('[data-j=muni]');
        var newSt = DATA.states.filter(function(x){ return x.name===stEl.value; })[0];
        var newCo = newSt.counties.filter(function(x){ return x.name===coEl.value; })[0] || newSt.counties[0];
        var out = { state:newSt.name, state_code:newSt.code, county_label:newSt.county_label,
                    county:newCo.name, municipality: (s.getAttribute('data-j')==='muni') ? muEl.value : newCo.municipalities[0] };
        save(out); render(el, onChange);
        if(onChange) onChange(out);
      };
    });
    if(onChange) onChange(current());
  }

  window.FLJur = { mount: mount, current: function(){ return DATA ? current() : load(); } };
})();
