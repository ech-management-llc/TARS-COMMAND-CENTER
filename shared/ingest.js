/* FL CC platform standard — the ONE ingestion/scrape layer (pass #6, seam).
   Every "pull/scrape" button in every tile calls FLIngest.request(source, query)
   → Promise<{rows, source, sources, fetched_at, never_faked:true, note}>.
   FRONT-END (this pass): serves canned sample rows from the data/ stubs, with the
   honest visible stamp (FLIngest.stamp). BACKEND (connector phase): swaps the
   transport behind this exact API — scraping, caching, rate limits, and ToS
   handling live HERE, in one place, never per-tile.
   GUARDRAILS (binding): ToS-aware per source (prefer official APIs/feeds);
   regulated data (FCRA consumer reports) NEVER flows through here — public
   lookups are informational-only and labeled; IBC/ICC code text is linked to
   official adopted-code pages, never redistributed.                          */
(function(){
  // source registry — per-source stub path + ToS posture (the one place it lives)
  var SOURCES = {
    'materials':      { stub:'../../../data/STUB_MATERIALS.json',   tos:'retailer ToS-aware; official price APIs/feeds preferred where they exist' },
    'legal-rules':    { stub:'../../../data/STUB_LEGAL_RULES.json', tos:'official statute/ordinance sites (statutes.capitol.texas.gov, municipal code pages)' },
    'caselaw':        { stub:'../../../data/STUB_CASELAW.json',     tos:'open case-law sources (CourtListener / Justia / Scholar); licensed DBs need paid access' },
    'permits':        { stub:'../../../data/STUB_PERMITS.json',     tos:'municipal/county sites generally OK; confirm per-site ToS; ICC/IBC text linked, never redistributed' },
    'public-records': { stub:'../../../data/STUB_PUBLIC_RECORDS.json', tos:'INFORMATIONAL ONLY — never a consumer report; FCRA-regulated checks go through the consent-based provider, not here' }
  };

  function request(source, query){
    var src = SOURCES[source];
    if(!src) return Promise.reject(new Error('unknown ingest source: '+source));
    return fetch(src.stub, {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(d){
        var rows = d.rows || d.items || [];
        // front-end filter seam: stubs may key rows by jurisdiction/query fields
        if(query && query.filter) rows = rows.filter(query.filter);
        return { rows: rows, source: source, sources: d.sources || [], query: query||null,
                 fetched_at: d.generated_at || new Date().toISOString().slice(0,10),
                 never_faked: true, tos_note: src.tos, sample: true };
      });
  }

  function stamp(res){ // the visible honesty stamp — REQUIRED next to every ingested table
    var s = (res.sources && res.sources.length) ? res.sources.join(' · ') : res.source;
    return '<span class="stamp">source: '+s+' · '+(res.sample?'sample data · ':'')+'pulled '+res.fetched_at+' · never faked</span>';
  }

  window.FLIngest = { request: request, stamp: stamp, SOURCES: SOURCES };
})();
