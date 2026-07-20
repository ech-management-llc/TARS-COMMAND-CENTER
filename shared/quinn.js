/* ════════════════════════════════════════════════════════════════
   quinn.js — Quinn Auto-File drop box + proposal/ask cards (4c L1).

   FLQuinn.mount(el, {entities, onCommit}) renders, for a HIRED tenant only:
     · a drop box (optional pre-picked record kind + entity = the AFFIRMED target)
     · the draft queue: PROPOSAL cards (approve/edit/reject) and ASK cards
       (needs_input — operator affirms the target before anything is approvable)

   L1 contract surfaced in the UI (R10b):
     · the TARGET (kind + entity) is a foregrounded, affirmed control — not skimmable text
     · every extracted field is shown and editable; low-confidence fields are flagged
     · sensitive fields need explicit per-field check-offs before Approve unlocks
     · the AI's reasoning renders as a visually distinct advisory — "verify independently"
     · NOTHING commits without the operator's click; reject discards
   Requires fl-auth.js + fl-api.js (flQuinn, flDocuments) loaded first.
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (window.FLQuinn) return;

  var KIND_LABEL = {
    personal_info: 'Personal Information',
    bank_account: 'Accounts & Banking',
    loan: 'Loans & Lenders',
    vendor: 'Vendors & Professionals'
  };
  var KIND_TILE = {
    personal_info: 'personal-information',
    bank_account: 'accounts-banking',
    loan: 'loans-lenders',
    vendor: 'vendors-professionals'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function flOpen(id) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'tcc:open-layer', layer: id }, '*');
      }
    } catch (e) {}
  }

  function kindSelect(id, selected, allowAuto) {
    var h = '<select id="' + id + '" data-qkindsel="1" style="background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--txt,#e8e8ea);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px">';
    if (allowAuto) h += '<option value="">— let Quinn classify (you confirm after) —</option>';
    Object.keys(KIND_LABEL).forEach(function (k) {
      h += '<option value="' + k + '"' + (selected === k ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>';
    });
    return h + '</select>';
  }
  function entitySelect(id, entities, selected) {
    var h = '<select id="' + id + '" data-qent="1" style="background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--txt,#e8e8ea);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px">';
    h += '<option value="">— no entity (filed to you) —</option>';
    (entities || []).forEach(function (e) {
      h += '<option value="' + esc(e.code) + '"' + (selected === e.code ? ' selected' : '') + '>' + esc(e.name || e.code) + ' (' + esc(e.code) + ')</option>';
    });
    return h + '</select>';
  }

  function card(d, entities) {
    var conf = d.confidence || {};
    var args = d.args || {};
    var details = args.details || {};
    var ask = d.status === 'needs_input';
    var low = {}; (conf.low_fields || []).forEach(function (f) { low[f] = 1; });
    var problems = conf.problems || {};
    var sensitive = conf.sensitive_fields || [];
    var cid = 'q_' + d.id;

    var target =
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px">' +
      '<span style="font-weight:800;font-size:12px;letter-spacing:.4px;color:' + (ask ? '#fbbf24' : '#34d399') + '">' +
      (ask ? '❓ NEEDS YOUR CALL' : '📋 PROPOSAL') + '</span>' +
      '<span class="small">create a</span> ' +
      (ask ? kindSelect(cid + '_kind', args.kind, false)
           : '<b>' + esc(KIND_LABEL[args.kind] || args.kind) + '</b>') +
      '<span class="small">record →</span> ' +
      entitySelect(cid + '_ent', entities, args.entity_code || '') +
      '</div>';

    var fieldRows = '<div style="display:grid;grid-template-columns:130px 1fr;gap:6px 10px;align-items:center;margin:6px 0">' +
      '<span class="small dim">label</span>' +
      '<input data-qlabel="1" id="' + cid + '_label" value="' + esc(args.label || '') + '" style="background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--txt,#e8e8ea);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px">';
    Object.keys(details).forEach(function (k) {
      var flag = problems[k] ? ' <span style="color:#f87171;font-weight:700" title="' + esc(problems[k]) + '">✖ ' + esc(problems[k]) + '</span>'
        : (low[k] ? ' <span style="color:#fbbf24;font-weight:700" title="low confidence — verify">⚠ verify</span>' : '');
      fieldRows += '<span class="small dim">' + esc(k) + flag + '</span>' +
        '<input data-qfield="' + esc(k) + '" id="' + cid + '_f_' + esc(k) + '" value="' + esc(details[k] == null ? '' : details[k]) + '" style="background:var(--surf2,#1a1d27);border:1px solid var(--line,#2a2d3a);color:var(--txt,#e8e8ea);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px">';
    });
    fieldRows += '</div>';

    var acks = '';
    if (!ask && sensitive.length) {
      acks = '<div style="margin:6px 0;padding:8px 10px;border:1px solid #54470f;border-radius:8px;background:rgba(202,165,58,.07)">' +
        '<div class="small" style="font-weight:800;color:#fbbf24;margin-bottom:4px">SENSITIVE FIELDS — check each after you verify it against the document</div>' +
        sensitive.map(function (f) {
          return '<label class="small" style="display:inline-flex;gap:5px;align-items:center;margin-right:12px;cursor:pointer">' +
            '<input type="checkbox" data-qack="' + esc(f) + '"> ' + esc(f) + '</label>';
        }).join('') + '</div>';
    }

    var reasoning = d.gate_rationale
      ? '<div style="margin:6px 0;padding:7px 10px;border-left:3px solid var(--purpleln,#5b4b8a);background:rgba(139,127,240,.07);border-radius:0 8px 8px 0">' +
        '<div class="small" style="font-weight:800;color:var(--purple,#b9a7ff)">QUINN’S REASONING — verify independently, this is the AI’s claim, not a fact</div>' +
        '<div class="small muted">' + esc(d.gate_rationale) + '</div></div>'
      : '';

    var overall = (conf.overall != null) ? Math.round(conf.overall * 100) + '%' : '—';
    var srcline = '<div class="small dim">confidence ' + esc(overall) +
      (d.source_document_id ? ' · from your uploaded document' : '') + '</div>';

    var buttons = ask
      ? '<button data-qact="affirm" data-qid="' + esc(d.id) + '" style="background:#fbbf24;border:none;color:#1a1502;font-weight:800;border-radius:16px;padding:7px 14px;font-size:12px;cursor:pointer">Confirm target &amp; fields</button>'
      : '<button data-qact="approve" data-qid="' + esc(d.id) + '"' + (sensitive.length ? ' disabled' : '') + ' style="background:var(--green,#34d399);border:none;color:#06150f;font-weight:800;border-radius:16px;padding:7px 14px;font-size:12px;cursor:pointer">✓ Approve — create the record</button>';
    buttons += ' <button data-qact="reject" data-qid="' + esc(d.id) + '" style="background:var(--surf2,#1a1d27);border:1px solid #5a1f1f;color:#f87171;font-weight:700;border-radius:16px;padding:7px 14px;font-size:12px;cursor:pointer">Reject — save nothing</button>';

    return '<div class="qcard" id="' + cid + '" data-qcard="' + esc(d.id) + '" style="border:1px solid var(--line,#2a2d3a);border-radius:10px;padding:10px 12px;margin-bottom:9px;background:var(--surf,#12141c)">' +
      target + fieldRows + acks + reasoning + srcline +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">' + buttons +
      ' <span class="small" data-qmsg="' + esc(d.id) + '"></span></div></div>';
  }

  function collect(cardEl) {
    var edits = { details: {} };
    var label = cardEl.querySelector('[data-qlabel]');
    if (label) edits.label = label.value;
    cardEl.querySelectorAll('[data-qfield]').forEach(function (inp) {
      edits.details[inp.getAttribute('data-qfield')] = inp.value;
    });
    var ent = cardEl.querySelector('[data-qent]');
    if (ent) edits.entity_code = ent.value || null;
    var acks = [];
    cardEl.querySelectorAll('[data-qack]').forEach(function (cb) {
      if (cb.checked) acks.push(cb.getAttribute('data-qack'));
    });
    return { edits: edits, acks: acks };
  }

  function statusText(r, fallback) {
    if (!r) return fallback;
    if (r.status === 403) return (r.data && r.data.detail) || 'not allowed (owner/hire gate)';
    if (r.status === 409) return 'this draft was already decided — reload the queue';
    if (r.status === 422) return (r.data && r.data.detail) || 'validation failed — fix the flagged fields';
    if (r.status === 502 || r.status === 503) return (r.data && r.data.detail) || 'the document reader is unavailable';
    if (r.status === 0) return 'unreachable — check your session and retry';
    return fallback;
  }

  function mount(host, opts) {
    opts = opts || {};
    if (!window.flApi || !flApi.authed() || !window.flQuinn) { host.innerHTML = ''; return; }
    var state = { hired: null, entities: opts.entities || [], drafts: [] };

    function msgFor(id, html) {
      var el = host.querySelector('[data-qmsg="' + id + '"]');
      if (el) el.innerHTML = html;
    }

    function render() {
      if (state.hired === false) {
        host.innerHTML =
          '<div class="section-label">🤖 QUINN — AUTO-FILE (not hired)</div>' +
          '<div class="small muted" style="margin-bottom:8px">Hire Quinn and dropped documents become proposed records — Quinn reads, proposes, <b>you approve every write</b>. Nothing saves on its own.</div>' +
          '<button id="q_hire" style="background:var(--purplebg,#1c1830);border:1px solid var(--purpleln,#5b4b8a);color:var(--purple,#b9a7ff);font-weight:800;border-radius:16px;padding:7px 14px;font-size:12px;cursor:pointer">Hire Quinn (Tenant-Owner only)</button>' +
          '<span class="small" id="q_hiremsg" style="margin-left:8px"></span>';
        var hb = host.querySelector('#q_hire');
        if (hb) hb.addEventListener('click', function () {
          flQuinn.hire('quinn', true).then(function (r) {
            if (r && r.ok) { state.hired = true; render(); loadQueue(); }
            else document.getElementById('q_hiremsg').innerHTML =
              '<span class="err">' + esc(statusText(r, 'hire failed')) + '</span>';
          });
        });
        return;
      }
      if (state.hired !== true) { host.innerHTML = '<div class="small dim">Checking Quinn…</div>'; return; }

      host.innerHTML =
        '<div class="section-label">🤖 QUINN — DROP TO AUTO-FILE <span class="small dim" style="font-weight:400">(L1: Quinn proposes · you approve every write · audit-logged)</span></div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
        '<span class="small dim">file as</span>' + kindSelect('q_kind', '', true) +
        '<span class="small dim">entity</span>' + entitySelect('q_ent', state.entities, '') +
        '</div>' +
        '<div id="q_drop" style="border:2px dashed var(--purpleln,#5b4b8a);border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:rgba(139,127,240,.05)">' +
        '<div style="font-weight:700;font-size:13px">Drop a document here (or click) — W-9, bank statement, loan doc, contact sheet</div>' +
        '<div class="small dim" style="margin-top:3px">Quinn reads it and proposes the record. Unsure = it asks, never fills.</div>' +
        '<input type="file" id="q_file" style="display:none"></div>' +
        '<div class="small" id="q_dropmsg" style="min-height:15px;margin:6px 0"></div>' +
        '<div id="q_queue"></div>' +
        '<div class="small dim" style="margin-top:4px"><button id="q_pause" style="background:none;border:none;color:var(--dim,#8a8a93);font-size:11px;cursor:pointer;text-decoration:underline">Pause Quinn (owner) — cancels open drafts</button></div>';

      var drop = host.querySelector('#q_drop'), file = host.querySelector('#q_file');
      drop.addEventListener('click', function () { file.click(); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          intake(e.dataTransfer.files[0]);
        }
      });
      file.addEventListener('change', function () { if (file.files.length) intake(file.files[0]); });
      host.querySelector('#q_pause').addEventListener('click', function () {
        if (!window.confirm('Pause Quinn? Open drafts are cancelled (nothing was ever saved without approval).')) return;
        flQuinn.hire('quinn', false).then(function (r) {
          if (r && r.ok) { state.hired = false; render(); }
        });
      });
      renderQueue();
    }

    function renderQueue() {
      var q = host.querySelector('#q_queue');
      if (!q) return;
      var open = state.drafts.filter(function (d) {
        return d.status === 'pending' || d.status === 'needs_input';
      });
      q.innerHTML = open.length
        ? open.map(function (d) { return card(d, state.entities); }).join('')
        : '<div class="small dim">No open proposals. Drop a document above.</div>';
      wireCards(q);
    }

    function wireCards(q) {
      q.querySelectorAll('[data-qack]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var cardEl = cb.closest('[data-qcard]');
          var all = cardEl.querySelectorAll('[data-qack]');
          var checked = cardEl.querySelectorAll('[data-qack]:checked');
          var btn = cardEl.querySelector('[data-qact="approve"]');
          if (btn) btn.disabled = all.length !== checked.length;
        });
      });
      q.querySelectorAll('[data-qact]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-qid');
          var act = btn.getAttribute('data-qact');
          var cardEl = btn.closest('[data-qcard]');
          var got = collect(cardEl);
          btn.disabled = true;
          msgFor(id, '<span class="dim">working…</span>');
          if (act === 'approve') {
            flQuinn.approve(id, { edits: got.edits, acks: got.acks }).then(function (r) {
              if (r && r.ok) {
                var kind = (r.data && r.data.record && r.data.record.kind) || '';
                cardEl.innerHTML = '<div class="small" style="color:var(--green,#34d399);font-weight:700">✓ Filed — record created and audit-logged. ' +
                  (KIND_TILE[kind] ? '<button class="xref" type="button" data-qopen="' + esc(KIND_TILE[kind]) + '">Open ' + esc(KIND_LABEL[kind]) + '</button>' : '') + '</div>';
                var ob = cardEl.querySelector('[data-qopen]');
                if (ob) ob.addEventListener('click', function () { flOpen(ob.getAttribute('data-qopen')); });
                if (opts.onCommit) opts.onCommit(r.data);
              } else { btn.disabled = false; msgFor(id, '<span class="err">' + esc(statusText(r, 'approve failed')) + '</span>'); }
            });
          } else if (act === 'reject') {
            flQuinn.reject(id).then(function (r) {
              if (r && r.ok) { cardEl.innerHTML = '<div class="small dim">✕ Rejected — nothing was saved.</div>'; }
              else { btn.disabled = false; msgFor(id, '<span class="err">' + esc(statusText(r, 'reject failed')) + '</span>'); }
            });
          } else if (act === 'affirm') {
            var kindSel = cardEl.querySelector('[data-qkindsel]');
            flQuinn.affirm(id, {
              kind: kindSel ? kindSel.value : null,
              entity_code: got.edits.entity_code,
              edits: got.edits
            }).then(function (r) {
              if (r && r.ok) { loadQueue(); }
              else { btn.disabled = false; msgFor(id, '<span class="err">' + esc(statusText(r, 'confirm failed')) + '</span>'); }
            });
          }
        });
      });
    }

    function intake(f) {
      var dm = host.querySelector('#q_dropmsg');
      dm.innerHTML = '<span class="dim">Uploading ' + esc(f.name) + '…</span>';
      flDocuments.upload(f, { kind: 'quinn_intake', notes: 'via Quinn drop box' }).then(function (up) {
        if (!up || !up.ok || !up.data || !up.data.id) {
          dm.innerHTML = '<span class="err">upload failed' + (up && up.status ? ' (' + up.status + ')' : '') + ' — nothing was read or saved</span>';
          return;
        }
        dm.innerHTML = '<span class="dim">Quinn is reading ' + esc(f.name) + '… (nothing saves without your approval)</span>';
        var kind = host.querySelector('#q_kind').value || null;
        var ent = host.querySelector('#q_ent').value || null;
        flQuinn.intake(up.data.id, kind, ent).then(function (r) {
          if (r && r.ok) {
            dm.innerHTML = r.data.status === 'needs_input'
              ? '<span style="color:#fbbf24;font-weight:700">Quinn needs your call on this one — see the card below.</span>'
              : '<span class="ok">Proposal ready — review and approve below.</span>';
            loadQueue();
          } else {
            dm.innerHTML = '<span class="err">' + esc(statusText(r, 'Quinn could not read the document')) + '</span>';
          }
        });
      });
    }

    function loadQueue() {
      flQuinn.pending().then(function (r) {
        if (r && r.ok) { state.drafts = r.data || []; renderQueue(); }
      });
    }

    flQuinn.employees().then(function (r) {
      if (!(r && r.ok)) { host.innerHTML = ''; return; }
      var quinn = (r.data || []).filter(function (e) { return e.key === 'quinn'; })[0];
      state.hired = !!(quinn && quinn.hired);
      render();
      if (state.hired) loadQueue();
    });

    if (!state.entities.length && window.flEntities) {
      flEntities.list().then(function (rows) {
        if (rows && rows.length) { state.entities = rows; if (state.hired === true) render(); if (state.hired) loadQueue(); }
      });
    }
  }

  window.FLQuinn = { mount: mount };
})();
