/* fl-linked-docs.js — reusable "linked documents strip" (patch 030 / Construction Files).
 *
 * ONE component, dropped on any record card, that renders the documents linked to that record
 * and (optionally) lets the operator attach/upload more. "Store once, surface everywhere": the
 * FL API returns exactly the docs the caller may see for that target, cost-tiered server-side —
 * this component NEVER decides visibility, it just renders what the cage returns and is honest
 * about auth/empty/error states.
 *
 *   flLinkedDocs.mountStrip(el, { target: "property:<uuid>", canManage: true });
 *   flLinkedDocs.mountCategory(el, { category: "construction", canUpload: true, entity_code });
 *
 * Depends on window.flApi + window.flDocuments (fl-api.js). Read-only-safe: if not signed in it
 * says so; every list/download/link result carries {ok,status} and is rendered per-status.
 */
(function () {
  if (window.flLinkedDocs) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function authed() { return !!(window.flApi && flApi.authed && flApi.authed()); }
  function kindLabel(k) {
    return String(k || 'document').replace(/_/g, ' ');
  }
  function isCost(k) {
    return k === 'quote' || k === 'takeoff' || k === 'change_order';
  }

  async function openDownload(id, btn) {
    var prev = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      var r = await flDocuments.downloadUrl(id);
      if (r && r.ok && r.data && r.data.url) {
        window.open(r.data.url, '_blank', 'noopener');
      } else if (r && r.status === 404) {
        btn.textContent = 'unavailable';
        return;
      } else {
        btn.textContent = 'retry';
        return;
      }
    } catch (e) {
      btn.textContent = 'retry';
      return;
    } finally {
      if (btn.textContent === '…') btn.textContent = prev;
    }
    btn.disabled = false; btn.textContent = prev;
  }

  function row(doc, opts) {
    var wrap = document.createElement('div');
    wrap.className = 'fl-ldoc-row';
    var cost = isCost(doc.kind);
    wrap.innerHTML =
      '<span class="fl-ldoc-kind' + (cost ? ' fl-ldoc-cost' : '') + '">'
        + esc(kindLabel(doc.kind)) + '</span>'
      + '<span class="fl-ldoc-name">' + esc(doc.name) + '</span>'
      + '<button type="button" class="fl-ldoc-dl">Download</button>';
    wrap.querySelector('.fl-ldoc-dl').addEventListener('click', function (e) {
      openDownload(doc.id, e.currentTarget);
    });
    return wrap;
  }

  function styleOnce() {
    if (document.getElementById('fl-ldoc-style')) return;
    var s = document.createElement('style');
    s.id = 'fl-ldoc-style';
    s.textContent =
      '.fl-ldoc{font:13px system-ui,sans-serif;margin:8px 0}'
      + '.fl-ldoc-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.15)}'
      + '.fl-ldoc-kind{font-size:11px;text-transform:uppercase;letter-spacing:.03em;opacity:.7;min-width:96px}'
      + '.fl-ldoc-cost{color:#b26a00;font-weight:600}'
      + '.fl-ldoc-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.fl-ldoc-dl{font-size:12px;cursor:pointer}'
      + '.fl-ldoc-empty,.fl-ldoc-msg{opacity:.7;padding:6px 0}'
      + '.fl-ldoc-err{color:#b00020;padding:6px 0}';
    document.head.appendChild(s);
  }

  function render(el, state, opts) {
    styleOnce();
    el.classList.add('fl-ldoc');
    el.innerHTML = '';
    if (!authed()) {
      el.innerHTML = '<div class="fl-ldoc-msg">Sign in to see linked documents.</div>';
      return;
    }
    if (state.loading) { el.innerHTML = '<div class="fl-ldoc-msg">Loading…</div>'; return; }
    if (state.error) {
      el.innerHTML = '<div class="fl-ldoc-err">Couldn’t load documents — reload to retry.</div>';
      return;
    }
    var docs = state.docs || [];
    if (!docs.length) {
      el.innerHTML = '<div class="fl-ldoc-empty">'
        + esc(opts.emptyText || 'No documents yet.') + '</div>';
    } else {
      docs.forEach(function (d) { el.appendChild(row(d, opts)); });
    }
    if (opts.canUpload) el.appendChild(uploadControl(el, state, opts));
  }

  function uploadControl(el, state, opts) {
    var bar = document.createElement('div');
    bar.className = 'fl-ldoc-upload';
    bar.style.marginTop = '8px';
    var input = document.createElement('input');
    input.type = 'file';
    input.style.fontSize = '12px';
    var msg = document.createElement('span');
    msg.className = 'fl-ldoc-msg';
    msg.style.marginLeft = '8px';
    input.addEventListener('change', async function () {
      var f = input.files && input.files[0];
      if (!f) return;
      input.disabled = true; msg.textContent = 'Uploading…';
      try {
        var meta = { kind: opts.uploadKind || 'general', notes: 'via ' + (opts.source || 'strip') };
        if (opts.entity_code) meta.entity_code = opts.entity_code;
        var up = await flDocuments.upload(f, meta);
        if (!up || !up.ok || !up.data || !up.data.id) {
          msg.textContent = up && up.status === 403
            ? 'That document type needs financial clearance.'
            : 'Upload failed (HTTP ' + ((up && up.status) || '?') + ').';
          input.disabled = false; return;
        }
        // if this strip is a link target, auto-link the fresh upload to it
        if (opts.target) {
          var t = opts.target.split(':');
          await flDocuments.link(up.data.id, t[0], t.slice(1).join(':'));
        }
        msg.textContent = 'Saved.';
        await load(el, opts);
      } catch (e) {
        msg.textContent = 'Upload failed.';
        input.disabled = false;
      }
    });
    bar.appendChild(input); bar.appendChild(msg);
    return bar;
  }

  async function load(el, opts) {
    render(el, { loading: true }, opts);
    try {
      var filters = {};
      if (opts.target) filters.target = opts.target;
      if (opts.category) filters.category = opts.category;
      if (opts.entity_code && !opts.target) filters.entity_code = opts.entity_code;
      var r = await flDocuments.list(filters);
      if (r && r.ok && Array.isArray(r.data)) {
        render(el, { docs: r.data }, opts);
      } else if (r && r.status === 404 && opts.target) {
        // target not accessible to this caller — honest empty, not an error
        render(el, { docs: [] }, opts);
      } else {
        render(el, { error: true }, opts);
      }
    } catch (e) {
      render(el, { error: true }, opts);
    }
  }

  window.flLinkedDocs = {
    // strip for a record card: shows docs linked to opts.target ("<type>:<id>")
    mountStrip: function (el, opts) {
      opts = opts || {};
      load(el, opts);
      return { reload: function () { return load(el, opts); } };
    },
    // the Construction Files tile: a category view (all construction docs the caller can see)
    mountCategory: function (el, opts) {
      opts = Object.assign({ category: 'construction', emptyText:
        'No construction files yet. Upload blueprints, drawings, renderings, or permits.' },
        opts || {});
      load(el, opts);
      return { reload: function () { return load(el, opts); } };
    },
  };
})();
