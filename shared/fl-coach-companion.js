/* ════════════════════════════════════════════════════════════════
   fl-coach-companion.js — Coach, the small companion that rides with TARS.
   Docks a tiny Coach avatar next to TARS's name WHEREVER TARS appears
   (the "Ask TARS" lasso, the global TARS chat header). Scurries in and
   attaches. Self-contained: injects its own CSS, self-inits, and a
   MutationObserver re-attaches if the shell re-renders.

   Drop-in:  <script src="shared/fl-coach-companion.js" defer></script>
   Optional explicit anchor in markup:  <span data-coach-anchor></span>

   • addEventListener + data-attrs only — NO inline onclick / JSON.stringify (TD-096).
   • Purely additive: only ever APPENDS a <span>; never rewrites host markup.
   • Idempotent + guarded in try/catch so it can never break the shell.
   ════════════════════════════════════════════════════════════════ */
(function(){
  if (window.FLCoach) return;                       // singleton
  var COACH = { name:'Coach', avatar:'C', tip:'Coach rides with TARS — tap for a hand.' };
  var cssDone = false;

  function injectCss(){
    if(cssDone) return; cssDone = true;
    var css =
      '.fl-coach{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;'+
        'border-radius:50%;background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);'+
        'color:var(--purple,#b9a7ff);font-size:10px;font-weight:800;line-height:1;margin-left:5px;'+
        'cursor:pointer;vertical-align:middle;position:relative;flex:0 0 auto;'+
        'animation:fl-coach-scurry .5s cubic-bezier(.34,1.56,.64,1) both}'+
      '.fl-coach:hover{filter:brightness(1.2)}'+
      '.fl-coach[data-coach-on]{outline:2px solid var(--purple,#b9a7ff);outline-offset:1px}'+
      '@keyframes fl-coach-scurry{0%{opacity:0;transform:translateX(-14px) rotate(-25deg) scale(.6)}'+
        '60%{opacity:1;transform:translateX(3px) rotate(8deg) scale(1.05)}'+
        '100%{opacity:1;transform:translateX(0) rotate(0) scale(1)}}'+
      '@media (prefers-reduced-motion: reduce){.fl-coach{animation:none}}';
    var st=document.createElement('style'); st.id='fl-coach-css'; st.textContent=css;
    (document.head||document.documentElement).appendChild(st);
  }

  function makeChip(){
    var c=document.createElement('span');
    c.className='fl-coach';
    c.setAttribute('data-fl-coach','1');
    c.setAttribute('role','button');
    c.setAttribute('tabindex','0');
    c.setAttribute('aria-label',COACH.tip);
    c.title=COACH.tip;
    c.textContent=COACH.avatar;
    function open(e){
      if(e){ e.stopPropagation(); }
      try{ if(window.Agents && Agents.openGlobal) Agents.openGlobal(); }catch(_){}
    }
    c.addEventListener('click', open);
    c.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); open(e); } });
    return c;
  }

  // Anchors: explicit [data-coach-anchor], the "Ask TARS" lasso text, and the global chat name node.
  function anchors(root){
    root = root || document;
    var out=[];
    root.querySelectorAll('[data-coach-anchor]').forEach(function(n){ out.push(n); });
    root.querySelectorAll('.tarstxt b').forEach(function(n){ out.push(n); });   // home lasso
    root.querySelectorAll('#gpanel .eh .nm, #gpanel .ptitle').forEach(function(n){ out.push(n); }); // global TARS chat — scoped to #gpanel so Coach never docks onto a tile employee (Reed/Margo/etc.)
    return out;
  }

  function attach(root){
    try{
      injectCss();
      anchors(root).forEach(function(host){
        if(!host || host.querySelector(':scope > .fl-coach')) return;   // already companioned
        if(host.getAttribute('data-coach-done')==='1') return;
        host.setAttribute('data-coach-done','1');
        host.appendChild(makeChip());
      });
    }catch(_){ /* never break the shell */ }
  }

  var _t=null;
  function scheduleAttach(){ if(_t) return; _t=setTimeout(function(){ _t=null; attach(document); },120); }

  function init(){
    attach(document);
    try{
      var mo=new MutationObserver(function(){ scheduleAttach(); });
      mo.observe(document.body,{childList:true,subtree:true});
    }catch(_){}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.FLCoach = { attach:attach, refresh:function(){ attach(document); } };
})();
