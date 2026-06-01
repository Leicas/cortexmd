// intelligence.js — Intelligence tab client module (ES module, no build).
// Revamped onto the new design system (REVAMP.md §5 TAB 5). Reads only from
// ctx.data (incl. ctx.data.derived). Action callbacks register into
// window.cortex so the server-rendered onclick="cortex.*" bridge resolves.
// Follows the overview.js reference: drawGauge/drawMulti charts, threshold pills
// mirrored from model/derive THRESHOLDS, setLive for the flash cue, and the
// shared pill/delta/empty markup. See ARCHITECTURE.md §3/§4.
//
// NOTE: real .js file, so unicode chars are written literally (—, ↔, ·, ✓, ↑↓→).

/** @typedef {import('../core.js').Ctx} Ctx */

// Threshold map mirrored from model/derive THRESHOLDS (kept in sync). The few
// Intelligence-specific signals (entityConfirmationRate, etc.) aren't yet in the
// server `derived` namespace, so this tab computes them client-side from raw
// payload fields and classifies them here. See blockers note in the revamp.
var THRESHOLDS = {
  healthScore: { good: 80, warn: 60, dir: 'higher' },
  entityConfirmationRate: { good: 0.6, warn: 0.3, dir: 'higher' }, // 0–1
  kgDensity: { good: 2, warn: 1, dir: 'higher' },                  // triples/entity
};

function stateFor(value, key) {
  var T = THRESHOLDS[key];
  if (!T) return 'ok';
  if (T.dir === 'lower') return value <= T.good ? 'ok' : value <= T.warn ? 'warn' : 'bad';
  return value >= T.good ? 'ok' : value >= T.warn ? 'warn' : 'bad';
}

function gradeClassOf(grade) {
  var g = String(grade || '').charAt(0).toUpperCase();
  if (g === 'A' || g === 'B') return 'ok';
  if (g === 'C' || g === 'D') return 'warn';
  if (g === 'F') return 'bad';
  return 'muted';
}

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

function deltaHtml(tr, invert) {
  if (!tr) return '';
  var dir = tr.dir || 'flat';
  var glyph = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  var pct = Math.abs(tr.pct || 0);
  return '<span class="kpi-delta ' + dir + (invert ? ' invert' : '') + '"><span aria-hidden="true">' + glyph + '</span>' + pct + '%</span>';
}

function emptyHtml(title, msg) {
  return '<div class="empty">'
    + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>'
    + '<div class="empty-title">' + title + '</div>'
    + (msg ? '<div class="empty-msg" style="padding:0">' + msg + '</div>' : '') + '</div>';
}

/** Average interval (ms) between consecutive dream-history timestamps. */
function avgInterval(history) {
  var ts = [];
  for (var i = 0; i < history.length; i++) {
    var t = history[i].timestamp;
    var n = typeof t === 'string' ? Date.parse(t) : t;
    if (isFinite(n)) ts.push(n);
  }
  ts.sort(function (a, b) { return a - b; });
  if (ts.length < 2) return 0;
  var sum = 0;
  for (var j = 1; j < ts.length; j++) sum += ts[j] - ts[j - 1];
  return sum / (ts.length - 1);
}

function fmtDuration(ms) {
  if (!ms || !isFinite(ms)) return '—';
  var h = ms / 3600000;
  if (h < 1) return Math.round(ms / 60000) + 'm';
  if (h < 48) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}

export default {
  id: 'intelligence',

  /** One-time: register the action callbacks the server fragment calls. */
  init(el, ctx) {
    var self = this;

    // Rebuild the entity registry: scan the indexed corpus, run heuristic entity
    // detection, and (re)populate the persistent registry (+ KG mentions_* triples).
    window.cortex.rebuildEntities = function () {
      var btn = ctx.$('btnEntityRebuild');
      if (btn) { btn.disabled = true; btn.textContent = 'Rebuilding...'; }
      fetch('/dashboard/api/entities/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (btn) { btn.disabled = false; btn.textContent = 'Rebuild entities'; }
          if (d.ok) {
            ctx.toast('Entity rebuild complete: ' + (d.uniqueEntities || 0) + ' entities from ' + (d.scanned || 0) + ' notes', 'success');
            var panel = ctx.$('tab-intelligence');
            if (panel && self.refresh) self.refresh(panel, ctx);
          } else {
            ctx.toast(d.error || 'Entity rebuild failed', 'error');
          }
        })
        .catch(function (e) {
          if (btn) { btn.disabled = false; btn.textContent = 'Rebuild entities'; }
          ctx.toast('Entity rebuild failed: ' + e.message, 'error');
        });
    };

    // Run a dream cycle (optionally with LLM consolidation).
    window.cortex.runDreamCycle = function (withLlm) {
      var btn = ctx.$('btnDreamRun');
      var llmBtn = ctx.$('btnDreamLlm');
      if (btn) btn.disabled = true;
      if (llmBtn) llmBtn.disabled = true;
      var label = withLlm ? 'LLM Dreaming...' : 'Dreaming...';
      var activeBtn = withLlm ? llmBtn : btn;
      if (activeBtn) activeBtn.textContent = label;
      if (btn) btn.classList.add('dream-running');
      fetch('/dashboard/api/dream/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack: 7, autoDecay: true, autoArchive: false, llmConsolidate: !!withLlm }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (btn) { btn.disabled = false; btn.textContent = 'Run Dream'; btn.classList.remove('dream-running'); }
          if (llmBtn) { llmBtn.disabled = false; llmBtn.textContent = 'LLM Dream'; }
          if (d.ok) {
            var msg = 'Dream cycle complete';
            if (withLlm && d.llmResult) {
              var lr = d.llmResult;
              if (!lr.attempted && lr.reason) msg += ' — LLM skipped: ' + lr.reason;
              else if (lr.generated > 0) msg += ' — LLM generated ' + lr.generated + ' suggestions';
              else if (lr.errors.length > 0) msg += ' — LLM failed: ' + lr.errors[0];
            }
            ctx.toast(msg, d.llmResult && d.llmResult.errors && d.llmResult.errors.length ? 'error' : 'success');
          } else ctx.toast(d.error || 'Dream cycle failed', 'error');
        })
        .catch(function (e) {
          if (btn) { btn.disabled = false; btn.textContent = 'Run Dream'; btn.classList.remove('dream-running'); }
          if (llmBtn) { llmBtn.disabled = false; llmBtn.textContent = 'LLM Dream'; }
          ctx.toast('Dream cycle failed: ' + e.message, 'error');
        });
    };

    // Dismiss an AI recommendation by key.
    window.cortex.dismissRec = function (key) {
      fetch('/dashboard/api/dream/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok) ctx.toast('Dismissed', 'success');
        })
        .catch(function () { /* ignore */ });
    };
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var $ = ctx.$, esc = ctx.esc, escAttr = ctx.escAttr, setLive = ctx.setLive;
    var fmt = ctx.fmt.fmt, fmtAgo = ctx.fmt.fmtAgo;
    var data = ctx.data;
    var dv = data.derived || {};
    var dream = data.lastDream;

    var hs = data.healthScore || {};
    var es = data.entityStats || { tierCounts: {}, typeCounts: {}, total: 0 };
    var kgData = data.knowledgeGraph || { entities: 0, triples: 0, predicates: [] };
    var dh = data.dreamHistory || [];

    // ── Band A — KPI scorecards ──────────────────────────────────────────────
    // 1. Vault Health (grade + score + trend).
    setLive('kpiHealthVal', hs.grade != null ? String(hs.grade) : '—');
    if ($('kpiHealthSub')) $('kpiHealthSub').textContent = hs.score != null ? 'score ' + Math.round(hs.score) + '/100' : 'no health data';
    if ($('kpiHealthPill')) $('kpiHealthPill').innerHTML = pillHtml(gradeClassOf(hs.grade), 'grade');
    if ($('kpiHealthDelta')) $('kpiHealthDelta').innerHTML = deltaHtml(dv.healthTrend, false);
    ctx.charts.drawChart('kpiHealthSpark', dh.map(function (x) { return { y: x.healthScore }; }), 'var(--brand-2)');

    // 2. Entity Confirmation Rate (confirmed / total).
    var confirmed = es.tierCounts.confirmed || 0;
    var ecr = es.total > 0 ? confirmed / es.total : 0;
    setLive('kpiEntityVal', es.total > 0 ? Math.round(ecr * 100) + '%' : '—');
    if ($('kpiEntitySub')) $('kpiEntitySub').textContent = fmt(confirmed) + ' confirmed / ' + fmt(es.total) + ' total';
    if ($('kpiEntityPill')) $('kpiEntityPill').innerHTML = pillHtml(es.total > 0 ? stateFor(ecr, 'entityConfirmationRate') : 'muted', ecr >= 0.6 ? 'clean' : ecr >= 0.3 ? 'mixed' : 'noisy');

    // 3. KG Density (triples / entities).
    var kgEnt = kgData.entities || 0, kgTri = kgData.triples || 0;
    var kgDensity = kgEnt > 0 ? kgTri / kgEnt : 0;
    setLive('kpiKgVal', kgEnt > 0 ? kgDensity.toFixed(1) : '—');
    if ($('kpiKgSub')) $('kpiKgSub').textContent = fmt(kgTri) + ' triples · ' + fmt(kgEnt) + ' entities';
    if ($('kpiKgPill')) $('kpiKgPill').innerHTML = pillHtml(kgEnt > 0 ? stateFor(kgDensity, 'kgDensity') : 'muted', kgEnt > 0 ? (kgDensity >= 2 ? 'rich' : kgDensity >= 1 ? 'sparse' : 'thin') : 'empty');

    // 4. Dream Cadence (avg interval between dreams + freshness).
    var interval = avgInterval(dh);
    setLive('kpiDreamVal', dh.length >= 2 ? fmtDuration(interval) : (dh.length ? '1 run' : '—'));
    var lastTs = dream ? dream.timestamp : (dh.length ? dh[dh.length - 1].timestamp : 0);
    var lastMs = lastTs ? (typeof lastTs === 'string' ? Date.parse(lastTs) : lastTs) : 0;
    var ageMs = lastMs ? Date.now() - lastMs : Infinity;
    if ($('kpiDreamSub')) $('kpiDreamSub').textContent = lastMs ? 'last ' + fmtAgo(lastTs) + ' · ' + dh.length + ' cycles' : 'never run';
    // Stale when the last dream is older than 3x the typical cadence (or >7d with no cadence).
    var staleLimit = interval > 0 ? interval * 3 : 7 * 86400000;
    var dreamState = !lastMs ? 'muted' : ageMs <= staleLimit ? 'ok' : ageMs <= staleLimit * 2 ? 'warn' : 'bad';
    if ($('kpiDreamPill')) $('kpiDreamPill').innerHTML = pillHtml(dreamState, !lastMs ? 'idle' : dreamState === 'ok' ? 'running' : 'stale');

    // ── So-what strip ────────────────────────────────────────────────────────
    var sw = $('intelSoWhat');
    if (sw) {
      var parts = [];
      if (hs.grade != null) {
        parts.push('Health <b>' + esc(String(hs.grade)) + '</b>'
          + (hs.score != null ? ' (' + Math.round(hs.score) + ')' : '')
          + (dv.healthTrend && dv.healthTrend.dir !== 'flat' ? ' ' + (dv.healthTrend.dir === 'up' ? '↑' : '↓') + Math.abs(dv.healthTrend.pct) + '%' : ''));
      }
      if (es.total > 0) parts.push('entity confirmation <b>' + Math.round(ecr * 100) + '%</b>');
      if (kgEnt > 0) parts.push('KG density <b>' + kgDensity.toFixed(1) + '</b>');
      if (lastMs) parts.push('last dream <b>' + esc(fmtAgo(lastTs)) + '</b>');
      sw.innerHTML = parts.length ? parts.join(' · ') : 'Run a dream cycle to populate vault intelligence.';
    }

    // ── Band B — Health gauge + factor waterfall ─────────────────────────────
    if (hs.score != null) {
      ctx.charts.drawGauge('healthGauge', hs.score / 100, {
        label: String(Math.round(hs.score)),
        good: 0.8, warn: 0.6,
      });
      var scoreColor = hs.score >= 80 ? 'var(--ok)' : hs.score >= 60 ? 'var(--warn)' : 'var(--err)';
      setLive('healthScoreValue', String(Math.round(hs.score)));
      $('healthScoreValue').style.color = scoreColor;
      setLive('healthGradeValue', 'Grade ' + (hs.grade != null ? hs.grade : '—'));
    } else {
      ctx.charts.drawGauge('healthGauge', 0, { label: '—', color: 'var(--text-mute)' });
    }

    // Factor waterfall: contribution vs gap-to-potential (weight*100 - contribution).
    var hfEl = $('healthFactors');
    if (hfEl) {
      var factors = hs.factors || [];
      if (!factors.length) {
        hfEl.innerHTML = '<span class="empty-msg">Awaiting health data…</span>';
      } else {
        // Determine each factor's points + potential. Factor `value` is 0–1; if a
        // `weight` is present, points = value*weight*100 and potential = weight*100.
        var rows = factors.map(function (f) {
          var v = typeof f.value === 'number' ? f.value : 0;
          var weight = typeof f.weight === 'number' ? f.weight : null;
          var potential = weight != null ? weight * 100 : 100;
          var pts = weight != null ? v * weight * 100 : v * 100;
          var gap = Math.max(0, potential - pts);
          return { name: f.name, pts: pts, gap: gap, potential: potential, value: v };
        });
        var maxPot = 1;
        rows.forEach(function (r) { if (r.potential > maxPot) maxPot = r.potential; });
        // Biggest lever = factor with the largest gap.
        var leverIdx = 0;
        rows.forEach(function (r, i) { if (r.gap > rows[leverIdx].gap) leverIdx = i; });
        hfEl.innerHTML = rows.map(function (r, i) {
          var fillPct = (r.pts / maxPot) * 100;
          var gapPct = (r.gap / maxPot) * 100;
          var color = r.value >= 0.7 ? 'var(--ok)' : r.value >= 0.4 ? 'var(--warn)' : 'var(--err)';
          var lever = i === leverIdx && r.gap > 0.5
            ? '<span class="pill pill--warn" style="margin-left:.4rem"><span class="dot" aria-hidden="true"></span>biggest lever</span>'
            : '';
          return '<div class="health-factor" style="margin-bottom:.45rem">'
            + '<span class="hf-label" title="' + escAttr(r.name) + '">' + esc(r.name) + '</span>'
            + '<div class="hf-bar-wrap" style="height:14px;display:flex">'
            + '<div class="hf-bar" style="width:' + fillPct.toFixed(1) + '%;background:' + color + '"></div>'
            + '<div style="width:' + gapPct.toFixed(1) + '%;background:repeating-linear-gradient(45deg,var(--line-faint),var(--line-faint) 4px,transparent 4px,transparent 8px)"></div>'
            + '</div>'
            + '<span class="mono" style="width:48px;text-align:right;color:' + color + ';font-size:var(--fs-xs)">' + Math.round(r.pts) + '/' + Math.round(r.potential) + '</span>'
            + lever
            + '</div>';
        }).join('');
      }
    }

    // ── Band C — Dream insights + Local LLM ──────────────────────────────────
    var dreamBtn = $('btnDreamRun');
    if (dreamBtn) {
      if (data.dreamRunning) {
        dreamBtn.disabled = true;
        dreamBtn.textContent = 'Running...';
        dreamBtn.classList.add('dream-running');
      } else {
        dreamBtn.disabled = false;
        dreamBtn.textContent = 'Run Dream';
        dreamBtn.classList.remove('dream-running');
      }
    }

    if (dream) {
      $('dreamStatus').textContent = 'Last: ' + fmtAgo(dream.timestamp) + ' (' + dream.durationMs + 'ms)';
      $('dreamNarrative').textContent = dream.narrative;

      var act = dream.activity || {};
      var decayed = dream.lifecycle ? dream.lifecycle.decayed : 0;
      function actTile(label, value, color) {
        return '<div style="text-align:center">'
          + '<div class="card-label" style="justify-content:center">' + label + '</div>'
          + '<div class="card-value" style="font-size:var(--fs-xl)' + (color ? ';color:' + color : '') + '">' + value + '</div></div>';
      }
      $('dreamActivity').innerHTML = actTile('Notes', fmt(act.totalNotes), '')
        + actTile('Recently Active', fmt(act.recentlyAccessed), 'var(--ok)')
        + actTile('Decayed', fmt(decayed), 'var(--warn)');
    }

    // Local LLM status pill.
    var llm = data.llmStatus || {};
    var llmPillEl = $('llmPill');
    if (llmPillEl) {
      if (!llm.configured) llmPillEl.innerHTML = pillHtml('muted', 'not configured');
      else if (llm.available) llmPillEl.innerHTML = pillHtml('ok', 'online');
      else llmPillEl.innerHTML = pillHtml('bad', 'offline');
    }
    $('llmModel').textContent = llm.model || '—';
    var llmUrlEl = $('llmUrl');
    if (llmUrlEl) llmUrlEl.textContent = llm.baseUrl ? llm.baseUrl + '/v1/...' : '';
    var llmErrEl = $('llmError');
    if (llmErrEl) {
      if (llm.lastError && !llm.available) {
        llmErrEl.innerHTML = '<svg class="state-error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg><div>' + esc(llm.lastError) + '</div>';
        llmErrEl.style.display = '';
      } else {
        llmErrEl.style.display = 'none';
      }
    }

    var llmSugEl = $('llmSuggestions');
    var suggestions = llm.recentSuggestions || [];
    if (!suggestions.length) {
      llmSugEl.innerHTML = '<span class="empty-msg">No LLM suggestions yet. Run a dream cycle with LLM consolidation.</span>';
    } else {
      llmSugEl.innerHTML = suggestions.slice().reverse().map(function (s) {
        return '<div class="llm-suggestion">'
          + '<div class="llm-group">' + esc(s.group) + '</div>'
          + '<div class="llm-text">' + esc(s.summary) + '</div>'
          + '<div class="llm-ts">' + fmtAgo(s.timestamp) + '</div></div>';
      }).join('');
    }

    // ── Band D — Theme Clusters ──────────────────────────────────────────────
    var tcEl = $('themeClusters');
    if (dream && dream.themes && dream.themes.length) {
      var tempState = { hot: 'bad', warm: 'warn', cold: 'info' };
      tcEl.innerHTML = dream.themes.map(function (t) {
        var st = tempState[t.temperature] || 'muted';
        return '<div class="theme-card">'
          + '<div class="theme-name">' + esc(t.name) + '</div>'
          + '<div class="theme-meta">'
          + '<span>' + t.memoryPaths.length + ' memories</span>'
          + '<span class="badge badge--' + st + '"><span class="dot" aria-hidden="true"></span>' + esc(t.temperature) + '</span>'
          + '</div>'
          + '<div style="font-size:var(--fs-sm);color:var(--text);margin-top:.25rem;line-height:1.4">' + esc(t.summary) + '</div>'
          + '<div class="theme-tags">' + t.tags.map(function (tag) { return '<span class="theme-tag">#' + esc(tag) + '</span>'; }).join('') + '</div>'
          + '</div>';
      }).join('');
    } else {
      tcEl.innerHTML = emptyHtml('No themes yet', 'Run a dream cycle to detect recurring themes across your memories.');
    }

    // ── Band D — AI Recommendations ──────────────────────────────────────────
    var recsEl = $('aiRecommendations');
    var recCards = [];
    if (dream) {
      var conns = dream.connectionSuggestions || [];
      for (var ci = 0; ci < conns.length; ci++) {
        var c = conns[ci];
        var srcShort = c.sourcePath.split('/').pop() || c.sourcePath;
        var tgtShort = c.targetPath.split('/').pop() || c.targetPath;
        var dismissKey = 'conn:' + c.sourcePath + ':' + c.targetPath;
        recCards.push('<div class="rec-card rec-connection">'
          + '<div class="rec-body">'
          + '<div class="rec-type type-connection">Connection Suggestion</div>'
          + '<div class="rec-text"><strong>' + esc(srcShort.replace(/\.md$/, '')) + '</strong> ↔ <strong>' + esc(tgtShort.replace(/\.md$/, '')) + '</strong></div>'
          + '<div class="rec-confidence">' + esc(c.reason) + ' · ' + (c.confidence * 100).toFixed(0) + '% confidence</div>'
          + '</div>'
          + '<div class="rec-actions"><button class="btn btn--sm" onclick="cortex.dismissRec(\'' + escAttr(dismissKey) + '\')">Dismiss</button></div>'
          + '</div>');
      }
      var groups = dream.consolidationGroups || [];
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var dismissKeyG = 'cons:' + g.suggestedTitle;
        recCards.push('<div class="rec-card rec-consolidation">'
          + '<div class="rec-body">'
          + '<div class="rec-type type-consolidation">Consolidation Group</div>'
          + '<div class="rec-text"><strong>' + esc(g.suggestedTitle) + '</strong> — ' + g.paths.length + ' notes</div>'
          + '<div class="rec-confidence">Tags: ' + g.commonTags.map(function (t) { return '#' + t; }).join(', ') + ' · avg heat: ' + (g.avgHeatScore || 0).toFixed(1) + '</div>'
          + '</div>'
          + '<div class="rec-actions"><button class="btn btn--sm" onclick="cortex.dismissRec(\'' + escAttr(dismissKeyG) + '\')">Dismiss</button></div>'
          + '</div>');
      }
    }
    var recsCountEl = $('recsCount');
    if (recCards.length) {
      recsEl.innerHTML = recCards.join('');
      if (recsCountEl) recsCountEl.textContent = recCards.length + ' recommendations';
    } else {
      recsEl.innerHTML = emptyHtml('Nothing to act on', 'Run a dream cycle to generate connection suggestions and consolidation opportunities.');
      if (recsCountEl) recsCountEl.textContent = '';
    }

    // ── Band E — Orphan Memories ─────────────────────────────────────────────
    var orphans = dream ? dream.orphans || [] : [];
    var orphanBody = $('orphanTableBody');
    var orphanSummary = $('orphanSummary');
    if (!orphans.length) {
      orphanBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>';
      if (orphanSummary) orphanSummary.innerHTML = '';
    } else {
      var actionCounts = {};
      orphans.forEach(function (o) { actionCounts[o.suggestedAction] = (actionCounts[o.suggestedAction] || 0) + 1; });
      var summaryParts = [];
      if (actionCounts.link) summaryParts.push('<span class="action-badge action-link">' + actionCounts.link + ' link</span>');
      if (actionCounts.review) summaryParts.push('<span class="action-badge action-review">' + actionCounts.review + ' review</span>');
      if (actionCounts.consolidate) summaryParts.push('<span class="action-badge action-consolidate">' + actionCounts.consolidate + ' consolidate</span>');
      if (actionCounts.archive) summaryParts.push('<span class="action-badge action-archive">' + actionCounts.archive + ' archive</span>');
      if (orphanSummary) orphanSummary.innerHTML = summaryParts.join('');

      orphanBody.innerHTML = orphans.map(function (o) {
        var actionClass = 'action-' + o.suggestedAction;
        var tempBadge = '<span class="badge badge-' + (o.temperature || 'cold') + '">' + esc(o.temperature || '?') + '</span>';
        var daysTxt = o.daysSinceAccess < 0 ? 'never' : o.daysSinceAccess + 'd ago';
        return '<tr>'
          + '<td title="' + escAttr(o.path) + '" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help">' + esc(o.title) + '</td>'
          + '<td>' + tempBadge + '</td>'
          + '<td class="num">' + (o.heat_score || 0).toFixed(1) + '</td>'
          + '<td class="num" style="color:var(--text-dim)">' + daysTxt + '</td>'
          + '<td><span class="action-badge ' + actionClass + '">' + esc(o.suggestedAction) + '</span></td>'
          + '</tr>';
      }).join('');
    }

    // ── Band F — Entity Intelligence ─────────────────────────────────────────
    setLive('eiTotal', fmt(es.total));
    setLive('eiConfirmed', fmt(confirmed));
    setLive('eiDetected', fmt(es.tierCounts.detected || 0));

    var tierTotal = es.total || 1;
    var tierBar = $('entityTierBar');
    if (es.total > 0) {
      function seg(n, cls) {
        var p = (n / tierTotal * 100).toFixed(1);
        return '<div class="seg" style="width:' + p + '%;background:var(' + cls + ')">' + (n || '') + '</div>';
      }
      tierBar.innerHTML = seg(es.tierCounts.confirmed || 0, '--ok')
        + seg(es.tierCounts.detected || 0, '--warn')
        + seg(es.tierCounts.suggested || 0, '--info');
    } else {
      tierBar.innerHTML = '<div class="seg" style="width:100%;background:var(--line-faint);color:var(--text-dim)">No entities</div>';
    }

    // Type breakdown bars.
    var typeEntries = [];
    for (var tk in es.typeCounts) { if (Object.prototype.hasOwnProperty.call(es.typeCounts, tk)) typeEntries.push([tk, es.typeCounts[tk]]); }
    typeEntries.sort(function (a, b) { return b[1] - a[1]; });
    var typeMax = typeEntries.length > 0 ? typeEntries[0][1] : 1;
    var typeColors = { person: 'var(--info)', project: 'var(--ok)', organization: 'var(--warn)' };
    var typeEl = $('entityTypeBars');
    if (!typeEntries.length) {
      typeEl.innerHTML = '<span class="empty-msg">No entities</span>';
    } else {
      typeEl.innerHTML = typeEntries.map(function (e) {
        var pct = (e[1] / typeMax * 100).toFixed(0);
        var color = typeColors[e[0]] || 'var(--brand)';
        return '<div class="cat-row">'
          + '<span class="cat-label">' + esc(e[0]) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + '">' + e[1] + '</div></div>'
          + '<span class="cat-count">' + e[1] + '</span>'
          + '</div>';
      }).join('');
    }

    // Entity registry table.
    var entities = data.entityRegistry || [];
    var erBody = $('entityRegistryBody');
    if (!entities.length) {
      erBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>';
    } else {
      erBody.innerHTML = entities.map(function (e) {
        var confColor = e.confidence >= 0.8 ? 'var(--ok)' : e.confidence >= 0.5 ? 'var(--warn)' : 'var(--err)';
        var statusLabel = e.confirmed
          ? '<span class="badge badge--ok"><span class="dot" aria-hidden="true"></span>confirmed</span>'
          : '<span class="badge badge--muted">detected</span>';
        return '<tr>'
          + '<td>' + esc(e.name) + '</td>'
          + '<td>' + esc(e.type) + '</td>'
          + '<td class="num" style="color:' + confColor + '">' + (e.confidence * 100).toFixed(0) + '%</td>'
          + '<td>' + statusLabel + '</td>'
          + '</tr>';
      }).join('');
    }

    // ── Band F — Knowledge Graph ─────────────────────────────────────────────
    setLive('kgEntities', fmt(kgEnt));
    setLive('kgTriples', fmt(kgTri));
    var kgPredEl = $('kgPredicates');
    if (kgData.predicates && kgData.predicates.length) {
      var predMax = 1;
      kgData.predicates.forEach(function (p) { if (p.count > predMax) predMax = p.count; });
      kgPredEl.innerHTML = kgData.predicates.map(function (p) {
        var pct = (p.count / predMax * 100).toFixed(0);
        return '<div class="cat-row">'
          + '<span class="cat-label" title="' + escAttr(p.name) + '">' + esc(p.name) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:var(--brand)"></div></div>'
          + '<span class="cat-count">' + fmt(p.count) + '</span>'
          + '</div>';
      }).join('');
    } else {
      kgPredEl.innerHTML = emptyHtml('Graph empty', 'Knowledge graph empty or not enabled (set KG_ENABLED=true).');
    }

    // ── Band G — Dream History (overlaid sparklines) ─────────────────────────
    if (dh.length >= 2) {
      ctx.charts.drawMulti('chartDreamHealth', [
        { points: dh.map(function (d) { return { y: d.healthScore }; }), color: 'var(--ok)' },
        { points: dh.map(function (d) { return { y: d.themes }; }), color: 'var(--warn)' },
        { points: dh.map(function (d) { return { y: d.orphans }; }), color: 'var(--err)' },
        { points: dh.map(function (d) { return { y: d.decayed || 0 }; }), color: 'var(--info)' },
      ], { normalize: true });
    } else {
      ctx.charts.drawMulti('chartDreamHealth', [], {});
    }

    var dhTableEl = $('dreamHistoryTable');
    if (!dh.length) {
      dhTableEl.innerHTML = '<span class="empty-msg">No dream cycles recorded yet.</span>';
    } else {
      dhTableEl.innerHTML = dh.slice().reverse().slice(0, 20).map(function (d) {
        var scoreColor = d.healthScore >= 70 ? 'var(--ok)' : d.healthScore >= 40 ? 'var(--warn)' : 'var(--err)';
        return '<div class="dh-row">'
          + '<span class="dh-ts">' + fmtAgo(d.timestamp) + '</span>'
          + '<span class="dh-score" style="color:' + scoreColor + '">' + d.healthScore + '</span>'
          + '<span class="dh-metrics">' + d.themes + 'T ' + d.orphans + 'O ' + d.connections + 'C' + (d.decayed ? ' ' + d.decayed + 'D' : '') + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Band G — Agent Awareness ─────────────────────────────────────────────
    var agents = data.agentDiaries || [];
    var adBody = $('agentDiariesBody');
    if (!agents.length) {
      adBody.innerHTML = '<tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>';
    } else {
      adBody.innerHTML = agents.map(function (a) {
        return '<tr>'
          + '<td style="font-weight:500">' + esc(a.agentId) + '</td>'
          + '<td>' + fmtAgo(a.lastActive) + '</td>'
          + '<td class="num">' + fmt(a.entryCount) + '</td>'
          + '</tr>';
      }).join('');
    }

    var activityEl = $('agentRecentActivity');
    var thinkingParts = [];
    if (dream && dream.themes && dream.themes.length) {
      thinkingParts.push('<div class="card-sub" style="margin:0 0 .4rem">Based on recent dream analysis and agent activity:</div>');
      var activeThemes = dream.themes.filter(function (t) { return t.temperature === 'hot' || t.temperature === 'warm'; });
      if (activeThemes.length) {
        thinkingParts.push('<div style="margin-bottom:.35rem;font-size:var(--fs-sm)"><strong style="color:var(--brand)">Active focus areas:</strong> ' + esc(activeThemes.map(function (t) { return t.name + ' (' + t.memoryPaths.length + ')'; }).join(', ')) + '</div>');
      }
      if (dream.lifecycle && dream.lifecycle.decayed > 0) {
        thinkingParts.push('<div style="font-size:var(--fs-sm);color:var(--warn)">Pruned ' + dream.lifecycle.decayed + ' stale memories during last dream cycle.</div>');
      }
      if (dream.connectionSuggestions && dream.connectionSuggestions.length > 0) {
        thinkingParts.push('<div style="font-size:var(--fs-sm);color:var(--ok)">Discovered ' + dream.connectionSuggestions.length + ' potential connections between notes.</div>');
      }
    }
    if (thinkingParts.length) {
      activityEl.innerHTML = thinkingParts.join('');
    } else if (!agents.length) {
      activityEl.innerHTML = '';
    } else {
      activityEl.innerHTML = '<div class="card-sub" style="margin:0">Run a dream cycle to see what the AI has been thinking about.</div>';
    }
  },
};
