/* ════════════════════════════════════════════════════════════════
   fl-brief-router.js — TARS as router: cross-section daily brief.
   Compute-only. Reads the reference stubs and returns {attn, brief}, each item
   routed to the owning SECTION LEAD with a one-line action and a tile to open:
       { sev:'red|amber|info', t, d, lead:{name,avatar}, co:{name,avatar}?, open:'<tileId>' }
   app.js feeds these into the existing renderBriefGroup (ai.attn / ai.brief).

   • Honest: an item is emitted ONLY when its source datum exists — no invented
     breaches, no fake counts. Anything Plaid-gated (live DSCR / liquidity PASS-FAIL)
     is NOT asserted here until it is real.
   • Thresholds follow Margo's Financials covenant knobs + Jordan's Maintenance knobs
     (localStorage), else doctrine defaults. Swap the stub fetches for live feeds at
     the connector phase (TD-100).
   ════════════════════════════════════════════════════════════════ */
(function(){
  if (window.FLBriefRouter) return;

  var LEAD = {
    Margo:{name:'Margo',avatar:'M'}, Reed:{name:'Reed',avatar:'R'}, Jordan:{name:'Jordan',avatar:'J'},
    Dean:{name:'Dean',avatar:'D'}, Scout:{name:'Scout',avatar:'S'}, TARS:{name:'TARS',avatar:'T'},
    Iris:{name:'Iris',avatar:'I'}, Quinn:{name:'Quinn',avatar:'Q'}
  };
  var DEADLINE_WINDOW = 60;   // days — a deadline within this window surfaces as amber

  function j(url){ return fetch(url,{cache:'no-store'}).then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; }); }
  function short(a){ return String(a||'').split(' · ')[0]; }
  function money(n){ return '$'+Number(n||0).toLocaleString('en-US'); }
  function daysUntil(ds){ if(!ds) return null; var d=new Date(ds+'T00:00:00'); if(isNaN(d)) return null; var n=new Date(); return Math.round((d - new Date(n.getFullYear(),n.getMonth(),n.getDate()))/864e5); }

  function lsValues(prefix){
    try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k && k.indexOf(prefix)===0){ var v=JSON.parse(localStorage.getItem(k)||'null'); if(v && v.values) return v.values; } } }catch(e){}
    return null;
  }
  function finThresholds(){ var v=lsValues('tcc_tile_settings::financials::')||{}; return { ltv:(v.ltv_max!=null?+v.ltv_max:65), pd:(v.per_door_floor!=null?+v.per_door_floor:300) }; }
  function maintThresholds(){ var v=lsValues('tcc_tile_settings::maintenance::')||{}; return { approval:(v.approval_threshold!=null?+v.approval_threshold:1000), escalate:(v.escalate_days!=null?+v.escalate_days:7) }; }

  function build(){
    return Promise.all([
      j('./data/STUB_PROPERTIES.json'),
      j('./data/STUB_DEADLINES.json'),
      j('./data/STUB_RENT_ROLL.json'),
      j('./data/STUB_WORKORDERS.json'),
      j('./data/STUB_CONNECTIONS.json')
    ]).then(function(res){
      var props=(res[0]&&res[0].properties)||[];
      var deads=(res[1]&&res[1].deadlines)||[];
      var rr   =(res[2]&&res[2].properties)||[];
      var wos  =(res[3]&&res[3].work_orders)||[];
      var conn =(res[4])||{};
      var ft=finThresholds(), mt=maintThresholds();
      var attn=[], brief=[];

      // 1 — Capital breaches (live: LTV, per-door). Margo owns; vacant make-ready co-routes Jordan.
      props.forEach(function(p){
        if (Number(p.ltv_pct) > ft.ltv){
          attn.push({ sev:'red', t:short(p.address)+' — LTV '+p.ltv_pct+'% over '+ft.ltv+'%',
            d:'Leverage is above the covenant ceiling. Refi or pay down to restore headroom.', lead:LEAD.Margo, open:'watchlist' });
        }
        if (Number(p.cash_flow_monthly) < ft.pd){
          var vac=/vacant/i.test(p.status||'');
          attn.push({ sev:'red', t:short(p.address)+' — per-door '+money(p.cash_flow_monthly)+' under '+money(ft.pd),
            d:(vac?'Vacant make-ready — no cash flow until leased; make-ready owned by Operations.':'Below the per-door floor — route to Financials.'),
            lead:LEAD.Margo, open:'watchlist', co:(vac?LEAD.Jordan:null) });
        }
      });

      // 2 — Deadlines within the window. Routed by source/kind; only emitted when we can name a real owner+tile.
      deads.forEach(function(dl){
        if (dl.type==='milestone') return;   // goal milestones live in Goals & Growth, not the deadline brief
        var du=daysUntil(dl.date); if (du==null || du<0 || du>DEADLINE_WINDOW) return;
        var from=(dl.from||'').toLowerCase(), item=dl.item||'', lead=null, open=null;
        if (/insurance/.test(from)||/insurance/i.test(item)) { lead=LEAD.Margo; open='insurance'; }
        else if (/tax/.test(from)||/tax/i.test(item))        { lead=LEAD.Margo; open='taxes'; }
        else if (/lease|rent roll/.test(from)||/lease/i.test(item)) { lead=LEAD.Reed; open='rent-roll'; }
        else if (/legal|sign/.test(from))                    { lead=LEAD.Dean;  open='legal'; }
        else if (/maintenance|permit/.test(from))            { lead=LEAD.Jordan;open='maintenance'; }
        else if (/vendor/.test(from))                        { lead=LEAD.Margo; open='vendors-payables'; }
        else if (/entities/.test(from))                      { lead=LEAD.Dean;  open='entities'; }
        else return;   // unrouteable (e.g. Inbox/Goals) — skip rather than mis-route
        brief.push({ sev:'amber', t:item+' — in '+du+'d', d:'Due '+dl.date+(dl.from?' (from '+dl.from+')':'')+'.', lead:lead, open:open });
      });

      // 3 — Late rent. Reed owns; ≥ 10 days late crosses to formal notice and co-routes Dean (Legal).
      rr.forEach(function(p){ (p.units||[]).forEach(function(u){
        if (u.status==='late'){
          var notice=(Number(u.days_late)||0) >= 10;
          attn.push({ sev:'red', t:short(p.address)+((u.unit&&u.unit!=='House')?(' · '+u.unit):'')+' — rent '+u.days_late+'d late',
            d:money(u.rent)+' rent, late fee '+money(u.late_fee||0)+'. '+(notice?'Past 10 days — start the formal notice with Legal.':'Follow up with the tenant.'),
            lead:LEAD.Reed, open:'rent-roll', co:(notice?LEAD.Dean:null) });
        }
      }); });

      // 4 — Deal flow (deal-in-research with a pending takeoff → Scout): no deals-in-research stub exists yet, so nothing is emitted (honest — no fake deal). Wire at the connector phase.

      // 5 — Work orders against Jordan's knobs (approval threshold, urgent, EMERGENCY).
      //  EMERGENCY = a LIVE urgent work order on a hazard system (electrical / plumbing / HVAC).
      //  It pins RED to the TOP of the brief and (backend lane) texts+emails management + the
      //  maintenance team. Dispatch is NOT faked here — the item states the alert honestly.
      var emerg=[];
      var HAZARD={ electrical:1, plumbing:1, hvac:1 };
      // EMERGENCY recipients resolved from the connections roster → real tap-to-text/email (sms:/mailto:).
      var TEAM=(conn.team||[]), MAINT=(conn.maintenance_personnel||[]);
      function isMgmt(m){ var r=String(m.role||'').toLowerCase(); return r==='owner'||r==='property manager'||r==='manager'; }
      function telDigits(p){ var d=String(p||'').replace(/[^0-9]/g,''); if(!d) return ''; if(d.length===10) d='1'+d; return '+'+d; }
      function emergencyAlert(w, sys, label){
        var mgmt=TEAM.filter(isMgmt);
        var vend=MAINT.filter(function(m){ return String(m.trade||'').toLowerCase()===sys; });
        if(!vend.length) vend=MAINT.filter(function(m){ return m.phone||m.email; });
        var rec=mgmt.concat(vend), phones=[], emails=[], names=[];
        rec.forEach(function(m){ var t=telDigits(m.phone); if(t)phones.push(t); if(m.email)emails.push(m.email); names.push(m.name); });
        var body='EMERGENCY - '+label+' at '+short(w.property)+': '+String(w.summary||'')+' ('+w.id+'). Please respond ASAP.';
        return { channels:['sms','email'], to:'management + maintenance', names:names.join(', '),
                 sms:phones.join(','), email:emails.join(','), body:body, subject:'EMERGENCY: '+label+' - '+short(w.property) };
      }
      function woSystem(w){
        if (w.system) return String(w.system).toLowerCase();
        var s=(w.summary||'').toLowerCase();
        if (/electric|sparking|no power|breaker|outlet|wiring|shock/.test(s)) return 'electrical';
        if (/plumb|leak|water|sewage|sewer|burst|flood|drain|pipe|overflow/.test(s)) return 'plumbing';
        if (/\bac\b|a\/c|air.?condition|hvac|furnace|\bheat\b|cooling/.test(s)) return 'hvac';
        return 'general';
      }
      wos.forEach(function(w){
        var live=(w.status!=='done'&&w.status!=='closed');
        var cost=(w.bill&&w.bill.amount!=null)?w.bill.amount:(w.est_cost!=null?w.est_cost:0);
        if (live && cost>mt.approval){
          brief.push({ sev:'amber', t:w.id+' '+short(w.property)+' — needs approval ('+money(cost)+')',
            d:'Over the '+money(mt.approval)+' approval threshold — sign off before dispatch.', lead:LEAD.Jordan, open:'maintenance' });
        }
        if (live && w.priority==='urgent'){
          var sys=woSystem(w);
          if (HAZARD[sys]){
            var label=(sys==='hvac')?'HVAC / A·C':sys.charAt(0).toUpperCase()+sys.slice(1);
            var al=emergencyAlert(w, sys, label);
            emerg.push({ sev:'red', emergency:true, system:sys,
              t:'EMERGENCY · '+label+' — '+short(w.property),
              d:String(w.summary||'')+' ('+w.id+'). '+(al.names?('Reaches '+al.names+'. '):'')+'Tap Text/Email to send now — opens your app, prefilled. Auto-dispatch wires at the backend (Rule 27 + email lane).',
              lead:LEAD.Jordan, co:LEAD.TARS, open:'maintenance', alert:al });
          } else {
            brief.push({ sev:'amber', t:w.id+' '+short(w.property)+' — urgent', d:String(w.summary||''), lead:LEAD.Jordan, open:'maintenance' });
          }
        }
      });

      // EMERGENCIES pin to the very top of Needs-Attention.
      return { attn:emerg.concat(attn), brief:brief };
    }).catch(function(){ return { attn:[], brief:[] }; });
  }

  window.FLBriefRouter = { build: build };
})();
