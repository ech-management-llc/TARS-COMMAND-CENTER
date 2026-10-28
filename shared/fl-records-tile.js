/* ════════════════════════════════════════════════════════════════
   fl-records-tile.js — shared renderer for the source-of-truth Admin
   record tiles (spine §2b): Personal Information, Accounts, Loans &
   Lenders, Vendors & Professionals.

   One FLRecordsTile.mount(cfg) builds an add-form + a list of existing
   records for a given `kind`, persisting to /api/admin-records (RLS-scoped)
   via window.flRecords. These are SOURCE-OF-TRUTH records, so — exactly
   like portfolio-facts — they're server-only: no localStorage fallback. If
   you're not signed in we show a sign-in card, never a fake local store.

   NULL-vs-0 honesty (the load-bearing rule): a blank field is OMITTED from
   `details` (absent key = "not provided" → UNKNOWN). A typed 0 is kept as a
   real zero (e.g. a paid-off loan balance = 0). Nothing is guessed.

   cfg = {
     kind, title, icon, blurb,
     labelLabel,                       // label for the record's primary name field
     entityLink: bool,                 // show an entity dropdown -> entity_code
     retentionDefault: '7yr'|'permanent'|'3yr'|null,
     fields: [ {key,label,type,ph,options?,suffix?,digits?,why?} ]   // type: text|number|date|select|textarea
   }

   digits (TD-216): a text field may declare a digits constraint — `digits: 4` (exactly four) or
   `digits: {min, max}` — the vocabulary FL's declared field schema uses (patch 041). The renderer
   enforces it IN THE BROWSER, before the request leaves: inputmode="numeric", pattern (no maxlength:
   it cuts an uncancellable insertion to the wrong digits silently — see fieldInputHtml), and handlers
   for typing, paste and drop that refuse anything else with a sentence under the box
   (`why` is the product-voice reason, e.g. "the full account number does not belong here"). A
   short entry is hinted live ("2 of 4 digits") and blocks the save; blank is legitimate (UNKNOWN).
   FL enforces the same rule server-side (measured 2026-10-24: 12 digits -> 422), so this is the
   half that explains, never the only guard.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.FLRecordsTile) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var CSS =
    '.rec-blurb b{color:var(--txt,#0f172a)}' +
    '.rec-form{margin:12px 0}' +
    '.rec-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-top:10px}' +
    '.rec-field{display:flex;flex-direction:column}.rec-field.full{grid-column:1/-1}' +
    '.rec-lab{font-size:11.5px;font-weight:600;color:var(--dim,#8a8a93);margin-bottom:4px}' +
    '.rec-in{width:100%;background:#fff;border:1.5px solid #cbd5e0;border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit;color:#0f172a}' +
    '.rec-in:focus{outline:none;border-color:#6366f1}' +
    '.rec-hint{font-size:10.5px;color:#94a3b8;margin-top:3px}' +
    '.rec-fieldmsg{font-size:11px;margin-top:3px;line-height:1.35}.rec-fieldmsg.err{color:#dc2626;font-weight:700}.rec-fieldmsg.mut{color:#94a3b8}' +
    '.rec-in[aria-invalid="true"]{border-color:#dc2626}' +
    '.rec-save{margin-top:12px;background:#4f46e5;color:#fff;border:none;border-radius:6px;padding:9px 18px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}' +
    '.rec-save:hover{filter:brightness(1.06)}.rec-save:disabled{opacity:.6;cursor:default}' +
    '.rec-msg{font-size:12px;margin-top:8px;min-height:16px}' +
    '.rec-card{margin-bottom:10px}' +
    '.rec-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
    '.rec-label{font-size:15px;font-weight:800;color:var(--txt,#0f172a)}' +
    '.rec-ent{font-size:10.5px;font-weight:800;letter-spacing:.4px;color:#475569;background:#eef2ff;padding:1px 7px;border-radius:10px}' +
    '.rec-ret{font-size:10.5px;font-weight:700;color:#92400e;background:#fef3c7;padding:1px 7px;border-radius:10px}' +
    '.rec-details{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;margin-top:8px}' +
    '.rec-dl{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;border-bottom:1px dotted var(--line,#e2e8f0);padding:2px 0}' +
    '.rec-dl span{color:var(--mut,#64748b)}.rec-dl b{color:var(--txt,#0f172a)}' +
    '.rec-notes{margin-top:8px;font-size:12px;color:var(--mut,#475569);font-style:italic}' +
    '.rec-docs{margin-top:8px;font-size:11.5px;color:var(--mut,#64748b)}' +
    '.rec-del{margin-left:auto;background:#fef2f2;border:1.5px solid #fca5a5;color:#dc2626;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;line-height:1.4}' +
    '.rec-del:hover{background:#fee2e2;border-color:#f87171}' +
    '.ok{color:#16a34a;font-weight:700}.err{color:#dc2626;font-weight:700}';

  // ── TD-216: declared digit constraints ─────────────────────────────────────────────────────
  function digitSpec(f) {
    if (f.digits == null) return null;
    var d = f.digits, min = typeof d === 'number' ? d : (d.min || 0), max = typeof d === 'number' ? d : (d.max || min);
    return { min: min, max: max, exact: min === max };
  }
  function digitCheck(v, spec) {
    var s = String(v == null ? '' : v), digits = s.replace(/[^0-9]/g, '');
    return { digits: digits, n: digits.length, nonDigits: digits.length !== s.length, over: digits.length > spec.max, short: digits.length > 0 && digits.length < spec.min };
  }
  // the sentence under the box: what the box is for, why the rest does not belong here, and what was (not) kept
  function digitWhy(f, spec, kind, n) {
    var lab = '<b>' + esc(f.label) + '</b>', why = f.why ? ' — ' + esc(f.why) : '';
    var count = spec.exact ? 'exactly ' + spec.max + ' digit' + (spec.max === 1 ? '' : 's') : spec.min + ' to ' + spec.max + ' digits';
    if (kind === 'over') return lab + ' takes ' + count + why + '. The box is full; the extra digit was not kept.';
    if (kind === 'paste') return 'That has ' + n + ' digits. ' + lab + ' takes ' + count + why + '. None of it was kept — type just the ' + (spec.exact ? 'last ' + spec.max : 'digits that belong here') + '.';
    if (kind === 'letters') return lab + ' is digits only' + why + '. What you entered was not kept.';
    if (kind === 'short') return lab + ' needs ' + count + ' — ' + n + ' entered. Nothing was saved.';
    return '';
  }
  function fieldMsg(f, html, cls) {
    var fm = document.getElementById('rec-fm-' + f.key), el = document.querySelector('#rec-form [data-k="' + f.key + '"]');
    if (fm) { fm.className = 'rec-fieldmsg' + (html ? ' ' + cls : ''); fm.innerHTML = html || ''; }
    if (el) { if (cls === 'err' && html) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
  }
  // typing, paste, drop and autofill all end in one of three states: accepted (digits within the limit), short (hinted,
  // the save blocks), or refused (the box keeps its last accepted value and says why). The cancellable paths are refused
  // before anything lands; whatever the browser inserts anyway is caught by the `input` backstop and put back.
  function wireDigitGuards(cfg) {
    cfg.fields.forEach(function (f) {
      var spec = digitSpec(f); if (!spec) return;
      var el = document.querySelector('#rec-form [data-k="' + f.key + '"]'); if (!el) return;
      el.dataset.ok = '';
      var settle = function (v) {                      // v is already clean digits within the limit
        el.value = v; el.dataset.ok = v;
        var c = digitCheck(v, spec);
        if (c.short) fieldMsg(f, c.n + ' of ' + spec.min + ' digits', 'mut'); else fieldMsg(f, '', '');
      };
      // a pasted or dropped chunk arrives with what the clipboard added — Excel's line end, a selected word's trailing space:
      // the browser strips line ends from a single-line box and the save trims, so the check does the same (round 1)
      var normChunk = function (text) { return String(text == null ? '' : text).replace(/[\r\n]/g, '').replace(/^\s+|\s+$/g, ''); };
      var tryInsert = function (text, kind, ev) {       // what the box WOULD hold if `text` replaced the selection
        if (kind !== 'type') { text = normChunk(text); if (text === '') return; }   // an image, a file, an empty clipboard: the browser's own default inserts nothing — never replace a selection with nothing (round 1)
        var a = el.selectionStart == null ? el.value.length : el.selectionStart, b = el.selectionEnd == null ? a : el.selectionEnd;
        var would = el.value.slice(0, a) + text + el.value.slice(b), c = digitCheck(would, spec);
        if (c.nonDigits) { ev.preventDefault(); fieldMsg(f, digitWhy(f, spec, 'letters', c.n), 'err'); return; }
        // one keystroke too many is "the box is full"; a longer chunk arriving at once (paste, drop, an autocorrect or
        // automation insert) is told by its size, because none of it was kept
        if (c.over) { ev.preventDefault(); fieldMsg(f, digitWhy(f, spec, (kind === 'type' && text.length === 1) ? 'over' : 'paste', digitCheck(text, spec).n), 'err'); return; }
        if (kind !== 'type') { ev.preventDefault(); settle(would); try { el.setSelectionRange(a + text.length, a + text.length); } catch (e) {} }
      };
      el.addEventListener('beforeinput', function (ev) {
        var t = ev.inputType || '';
        if (t.indexOf('insert') !== 0 || t === 'insertFromPaste' || t === 'insertFromDrop' || ev.data == null) return;   // paste/drop have their own handlers
        tryInsert(String(ev.data), 'type', ev);
      });
      el.addEventListener('paste', function (ev) {
        var cd = ev.clipboardData || window.clipboardData, text = cd ? String(cd.getData('text') || '') : '';
        if (!cd) return;                                 // no clipboard access: the input backstop below decides
        tryInsert(text, 'paste', ev);
      });
      el.addEventListener('drop', function (ev) {
        // the drop point is the browser's, not this box's old caret: refuse here only what can never fit; what fits lands where
        // it was dropped and the input backstop settles it, or puts the box back with a sentence (round 1)
        var dt = ev.dataTransfer; if (!dt) return;
        var text = normChunk(dt.getData('text') || ''); if (text === '') return;
        var t = digitCheck(text, spec);
        if (t.nonDigits) { ev.preventDefault(); fieldMsg(f, digitWhy(f, spec, 'letters', t.n), 'err'); return; }
        if (t.n > spec.max) { ev.preventDefault(); fieldMsg(f, digitWhy(f, spec, 'paste', t.n), 'err'); return; }
      });
      el.addEventListener('input', function () {        // backstop: autofill, IME, a drop, an uncancellable insertion, or a browser that skipped the handlers above
        var v = normChunk(el.value), c = digitCheck(v, spec);   // padding an insertion carried is not a refusal
        if (c.nonDigits || c.over) {
          var prev = el.dataset.ok || '', extra = c.n - digitCheck(prev, spec).n;   // the box goes back to its last accepted value
          el.value = prev;
          // the count the sentence gives is what the insertion carried (extra), not the box's would-be total (Jerry's ruling, 2026-10-28)
          fieldMsg(f, digitWhy(f, spec, c.nonDigits ? 'letters' : (extra === 1 ? 'over' : 'paste'), c.nonDigits ? c.n : extra), 'err');
          return;
        }
        settle(v);
      });
    });
  }

  function fieldInputHtml(f) {
    var attrs = 'class="rec-in" data-k="' + esc(f.key) + '"';
    var spec = digitSpec(f);
    if (spec) {                                          // TD-216: the native backstop + the right keyboard; the handlers say why
      // no maxlength, on purpose (measured 2026-10-24): an insertion the browser will not let a handler cancel — the
      // editing command extensions, text expanders and some password managers use — is cut by maxlength to its FIRST
      // four digits, silently; the wrong four of a full number would then save as the "last 4". Without it the `input`
      // backstop sees the whole value and refuses it with a sentence.
      attrs += ' inputmode="numeric" pattern="[0-9]{' + (spec.exact ? spec.max : spec.min + ',' + spec.max) + '}" autocomplete="off" aria-describedby="rec-fm-' + esc(f.key) + '"';
    }
    if (f.type === 'select') {
      return '<select ' + attrs + '><option value="">—</option>' +
        (f.options || []).map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select>';
    }
    if (f.type === 'textarea') {
      return '<textarea ' + attrs + ' rows="2" placeholder="' + esc(f.ph || '') + '"></textarea>';
    }
    var typeAttr = spec ? '' : (f.type === 'number' ? ' inputmode="decimal"' : (f.type === 'date' ? ' type="date"' : ''));
    var ph = f.ph != null ? f.ph : (f.type === 'number' ? 'blank = unknown' : '');
    return '<input ' + attrs + typeAttr + ' placeholder="' + esc(ph) + '">';
  }

  function formHtml(cfg, entities) {
    var entSel = '';
    if (cfg.entityLink) {
      entSel = '<div class="rec-field"><span class="rec-lab">Entity (optional)</span>' +
        '<select class="rec-in" id="rec-entity"><option value="">— not entity-specific —</option>' +
        (entities || []).map(function (e) { return '<option value="' + esc(e.code) + '">' + esc(e.name) + ' (' + esc(e.code) + ')</option>'; }).join('') +
        '</select></div>';
    }
    var fields = cfg.fields.map(function (f) {
      return '<div class="rec-field' + (f.full ? ' full' : '') + '"><span class="rec-lab">' + esc(f.label) + '</span>' +
        fieldInputHtml(f) + (f.hint ? '<span class="rec-hint">' + esc(f.hint) + '</span>' : '') +
        (digitSpec(f) ? '<span class="rec-fieldmsg" id="rec-fm-' + esc(f.key) + '" aria-live="polite"></span>' : '') + '</div>';
    }).join('');
    return '<div class="card rec-form" id="rec-form">' +
      '<div class="section-label">ADD A RECORD</div>' +
      '<div class="rec-grid">' +
        '<div class="rec-field full"><span class="rec-lab">' + esc(cfg.labelLabel || 'Name / label') + '</span>' +
          '<input class="rec-in" id="rec-label" placeholder="required"></div>' +
        entSel + fields +
        '<div class="rec-field full"><span class="rec-lab">Notes (optional)</span>' +
          '<textarea class="rec-in" id="rec-notes" rows="2" placeholder=""></textarea></div>' +
      '</div>' +
      (cfg.retentionDefault ? '<div class="rec-hint" style="margin-top:8px">Retention: <b>' + esc(cfg.retentionDefault) + '</b> · documents file into Administration → Document Navigator.</div>' : '') +
      '<button type="button" class="rec-save" id="rec-save">Save record</button>' +
      '<div class="rec-msg" id="rec-msg"></div>' +
    '</div>';
  }

  function detailRow(f, val) {
    if (val == null || val === '') return '';
    return '<div class="rec-dl"><span>' + esc(f.label) + '</span><b>' + esc(val) + esc(f.suffix || '') + '</b></div>';
  }

  function recordCardHtml(cfg, r) {
    var d = r.details || {};
    var rows = cfg.fields.map(function (f) { return detailRow(f, d[f.key]); }).join('');
    var ent = r.entity_code ? '<span class="rec-ent">' + esc(r.entity_code) + '</span>' : '';
    var ret = r.retention ? '<span class="rec-ret">retain: ' + esc(r.retention) + '</span>' : '';
    // Honest today: documents are NOT auto-linked to a specific record (admin_records.documents is
    // a static column nothing populates yet; uploads link by entity, not record). Say where files
    // live rather than implying they'll appear here. Real per-record linkage is a flagged build.
    var docs = (r.documents && r.documents.length)
      ? (r.documents.length + ' attached')
      : 'managed in Document Navigator';
    var del = r.id ? '<button type="button" class="rec-del" data-id="' + esc(r.id) + '" title="Delete this record">🗑 Delete</button>' : '';
    return '<div class="card rec-card">' +
      '<div class="rec-top"><span class="rec-label">' + esc(r.label || '(untitled)') + '</span>' + ent + ret + del + '</div>' +
      (rows ? '<div class="rec-details">' + rows + '</div>' : '<div class="small muted" style="margin-top:6px">No fields recorded yet — that\'s fine, you can fill them later.</div>') +
      (r.notes ? '<div class="rec-notes">' + esc(r.notes) + '</div>' : '') +
      '<div class="rec-docs">📎 Documents: ' + esc(docs) + '</div>' +
    '</div>';
  }

  function buildPayload(cfg) {
    var p = { kind: cfg.kind };
    var invalid = [];                                         // {label, msg}: a field that blocks the save (never save-and-drop)
    var labelEl = document.getElementById('rec-label');
    if (labelEl && labelEl.value.trim()) p.label = labelEl.value.trim();
    var details = {};
    cfg.fields.forEach(function (f) {
      var el = document.querySelector('#rec-form [data-k="' + f.key + '"]');
      if (!el) return;
      var v = el.value == null ? '' : ('' + el.value).trim();
      if (v === '') return;                                   // blank -> omit -> UNKNOWN
      var spec = digitSpec(f);
      if (spec) {
        // TD-216: the declared digit rule, checked once more at the save — the handlers keep the box clean while typing,
        // but a short entry is only wrong once the person is done, and nothing leaves the browser that FL would refuse
        var c = digitCheck(v, spec);
        if (c.nonDigits || c.over) { var m = digitWhy(f, spec, c.nonDigits ? 'letters' : 'paste', c.n); fieldMsg(f, m, 'err'); invalid.push({ label: f.label, msg: m }); }
        else if (c.short) { var sm = digitWhy(f, spec, 'short', c.n); fieldMsg(f, sm, 'err'); invalid.push({ label: f.label, msg: sm }); }
        else details[f.key] = c.digits;
      } else if (f.type === 'number') {
        // People type money/rates with $, commas, %, spaces. Tolerate those instead of SILENTLY
        // dropping the value on parse failure — the old `if (isFinite(+v))` turned "1,250" into a
        // dropped field while still reporting "✓ Saved" (silent data loss). Clean, then require a
        // real number; anything else BLOCKS the save (below) rather than vanishing.
        var cleaned = v.replace(/[$,\s%]/g, '');
        if (/^-?\d*\.?\d+$/.test(cleaned)) details[f.key] = parseFloat(cleaned);  // a typed 0 kept
        else invalid.push({ label: f.label, msg: 'Enter digits only for <b>' + esc(f.label) + '</b>. Use a plain number like 1250 or 3.75 — remove commas, $ and %.' });
      } else details[f.key] = v;
    });
    if (Object.keys(details).length) p.details = details;
    if (cfg.entityLink) { var e = document.getElementById('rec-entity'); if (e && e.value) p.entity_code = e.value; }
    if (cfg.retentionDefault) p.retention = cfg.retentionDefault;
    var notesEl = document.getElementById('rec-notes');
    if (notesEl && notesEl.value.trim()) p.notes = notesEl.value.trim();
    return { payload: p, invalid: invalid };
  }

  function renderList(cfg, records) {
    var host = document.getElementById('rec-list');
    if (!host) return;
    if (!records || !records.length) {
      host.innerHTML = '<div class="small muted" style="padding:6px 2px">No ' + esc(cfg.title.toLowerCase()) + ' records yet. Add one above — or let TARS gather them during setup.</div>';
      return;
    }
    host.innerHTML = '<div class="section-label">ON FILE (' + records.length + ')</div>' +
      records.map(function (r) { return recordCardHtml(cfg, r); }).join('');
  }

  function showAuth(cfg) {
    var expired = window.flApi && flApi.authExpired && flApi.authExpired();
    var box = document.getElementById('rec-auth');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML = '<div class="section-label">' + (expired ? 'SESSION EXPIRED' : 'SIGN IN REQUIRED') + '</div>' +
      '<div class="small">' + (expired
        ? 'Your session expired (sign-ins last about an hour). <b>Sign in to the Command Center again</b> to view and edit these records. <span class="muted">Your saved data is safe — this is only a re-login.</span>'
        : 'These are source-of-truth records, so they\'re saved to your account (not this browser). <b>Sign in to the Command Center</b> to view and edit them. Admins and members see only what they\'re granted.') +
      '</div>';
  }

  function mount(cfg) {
    var rootId = cfg.rootId || 'rec-root';
    var root = document.getElementById(rootId);
    if (!root) return;
    if (!document.getElementById('fl-rec-css')) {
      var st = document.createElement('style'); st.id = 'fl-rec-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    root.innerHTML =
      '<div class="art-head">' + esc(cfg.icon || '🗂️') + ' ' + esc(cfg.title) + '</div>' +
      (cfg.blurb ? '<div class="preview-banner rec-blurb">' + cfg.blurb + '</div>' : '') +
      '<div class="card" id="rec-auth" style="display:none"></div>' +
      '<div id="rec-form-host"></div>' +
      '<div id="rec-loading" class="small muted" style="padding:8px 2px">Loading…</div>' +
      '<div id="rec-list"></div>' +
      '<div class="wire-note" style="text-align:center;margin-top:14px">Saved to <code>/api/admin-records</code> (RLS-scoped, kind=' + esc(cfg.kind) + '). Blank = UNKNOWN · a typed 0 is a real zero.</div>';

    if (!(window.flApi && window.flApi.authed && window.flApi.authed())) {
      document.getElementById('rec-loading').style.display = 'none';
      showAuth(cfg);
      return;
    }

    var loaders = [window.flRecords.listX(cfg.kind)];
    loaders.push(cfg.entityLink && window.flEntities ? window.flEntities.list() : Promise.resolve(null));

    Promise.all(loaders).then(function (res) {
      document.getElementById('rec-loading').style.display = 'none';
      var rx = res[0], entities = res[1];             // rx = {ok, status, data} (status-carrying)
      if (!rx || !rx.ok) {
        // Honest per-status — NEVER a false-empty "no records yet" on a transient error:
        if (!rx || rx.status === 401 || rx.status === 403 || (window.flApi && !flApi.authed())) {
          showAuth(cfg); return;                      // signed-out / expired / no grant
        }
        var eh = document.getElementById('rec-list');
        if (eh) eh.innerHTML = '<div class="small err">Couldn\'t load your records just now (the ' +
          'service didn\'t answer). Reload in a moment — nothing was lost.</div>';
        return;
      }
      var list = rx.data || [];                       // one shared array: save + delete mutate it
      document.getElementById('rec-form-host').innerHTML = formHtml(cfg, entities || []);
      wireDigitGuards(cfg);                           // TD-216: declared digit constraints refuse in the browser, with a sentence
      renderList(cfg, list);
      var saveBtn = document.getElementById('rec-save');
      if (saveBtn) saveBtn.addEventListener('click', function () { save(cfg, list); });
      // Delete is wired by delegation so it survives every re-render of the list.
      var listHost = document.getElementById('rec-list');
      if (listHost) listHost.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.rec-del') : null;
        if (btn) remove(cfg, list, btn.getAttribute('data-id'));
      });
    }).catch(function () {
      document.getElementById('rec-loading').style.display = 'none';
      if (window.flApi && !flApi.authed()) showAuth(cfg);
      else { var h = document.getElementById('rec-list'); if (h) h.innerHTML = '<div class="small err">Could not load records. Confirm your access scope, then reload.</div>'; }
    });
  }

  function save(cfg, current) {
    var btn = document.getElementById('rec-save'), msg = document.getElementById('rec-msg');
    var built = buildPayload(cfg);
    var payload = built.payload;
    if (built.invalid.length) {                               // never save-and-drop a field: say which, and why
      msg.innerHTML = '<span class="err">Nothing was saved.</span> ' + built.invalid.map(function (i) { return i.msg; }).join(' ');
      return;
    }
    if (!payload.label) { msg.innerHTML = '<span class="err">A name/label is required.</span>'; return; }
    btn.disabled = true; msg.innerHTML = 'Saving…';
    window.flRecords.create(payload).then(function (res) {
      btn.disabled = false;
      if (!res) {
        if (window.flApi && !flApi.authed()) msg.innerHTML = '<span class="err">Session expired.</span> Sign in again, then re-save — your entries are still here.';
        else msg.innerHTML = '<span class="err">Save failed.</span> If you linked an entity, confirm it\'s in your scope, then retry.';
        return;
      }
      msg.innerHTML = '<span class="ok">✓ Saved.</span> Filed to your account' + (res.entity_code ? ' under ' + esc(res.entity_code) : '') + '.';
      current.unshift(res);
      renderList(cfg, current);
      // reset the add-form for the next entry
      var form = document.getElementById('rec-form');
      if (form) form.querySelectorAll('input,select,textarea').forEach(function (el) { if (el.tagName === 'SELECT') el.selectedIndex = 0; else { el.value = ''; if (el.dataset && 'ok' in el.dataset) el.dataset.ok = ''; } });
      cfg.fields.forEach(function (f) { if (digitSpec(f)) fieldMsg(f, '', ''); });
    });
  }

  function remove(cfg, current, id) {
    if (!id) return;
    var msg = document.getElementById('rec-msg');
    if (!window.confirm('Delete this record permanently? This can\'t be undone.')) return;
    window.flRecords.del(id).then(function (res) {
      if (!res) {
        if (msg) {
          if (window.flApi && !flApi.authed())
            msg.innerHTML = '<span class="err">Session expired.</span> Sign in again, then retry — nothing was deleted.';
          else
            msg.innerHTML = '<span class="err">Delete failed.</span> Only the record’s creator or an admin can delete it.';
        }
        return;
      }
      for (var i = 0; i < current.length; i++) {
        if (String(current[i].id) === String(id)) { current.splice(i, 1); break; }
      }
      renderList(cfg, current);
      if (msg) msg.innerHTML = '<span class="ok">✓ Deleted.</span> The record was removed from your account.';
    });
  }

  window.FLRecordsTile = { mount: mount };
})();
