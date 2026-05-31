// intelligence.js — Intelligence tab client module (ES module, no build).
// Migrated from the legacy `renderIntelligence` + `runDreamCycle` + `dismissRec`.
// Reads only from ctx.data; action callbacks register into window.cortex so the
// server-rendered onclick="cortex.*" bridge resolves. See ARCHITECTURE.md §3/§4.
//
// NOTE: this is a real .js file, so unicode chars are written literally (—, ↔,
// ·, ✓, ⚠), unlike the legacy template-literal escapes (—, etc.).

/** @typedef {import('../core.js').Ctx} Ctx */

export default {
  id: 'intelligence',

  /** One-time: register the action callbacks the server fragment calls. */
  init(el, ctx) {
    var self = this;

    // Rebuild the entity registry: scan the indexed corpus, run heuristic entity
    // detection, and (re)populate the persistent registry (+ KG mentions_* triples).
    // POSTs to the dashboard-scoped endpoint, toggles the button, toasts the
    // summary, and re-renders the Entity Intelligence panel from the live registry.
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
            // Re-render the panel immediately from the now-populated live registry
            // (it also refreshes on the next SSE tick — no stale cache).
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

    // Run a dream cycle (optionally with LLM consolidation). Toggles the button
    // state and toasts the outcome — matches legacy window.runDreamCycle.
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

    // Dismiss an AI recommendation by key — matches legacy window.dismissRec.
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
    var $ = ctx.$, esc = ctx.esc, escAttr = ctx.escAttr;
    var fmt = ctx.fmt.fmt, fmtAgo = ctx.fmt.fmtAgo;
    var data = ctx.data;

    // ── 1. Health Score Gauge ──
    var hs = data.healthScore;
    if (hs) {
      var arc = $('healthArc');
      var offset = 314 - (hs.score / 100) * 314;
      arc.setAttribute('stroke-dashoffset', offset.toString());
      var scoreColor = hs.score >= 70 ? 'var(--green)' : hs.score >= 40 ? 'var(--yellow)' : 'var(--red)';
      arc.setAttribute('stroke', scoreColor);
      $('healthScoreValue').textContent = hs.score;
      $('healthScoreValue').style.color = scoreColor;
      $('healthGradeValue').textContent = 'Grade: ' + hs.grade;

      var hfEl = $('healthFactors');
      if (hs.factors) {
        hfEl.innerHTML = hs.factors.map(function (f) {
          var pct = Math.round(f.value * 100);
          var color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--red)';
          return '<div class="health-factor">'
            + '<span class="hf-label">' + esc(f.name) + '</span>'
            + '<div class="hf-bar-wrap"><div class="hf-bar" style="width:' + pct + '%;background:' + color + '"></div></div>'
            + '<span style="font-size:.6rem;font-family:var(--mono);color:' + color + ';width:28px;text-align:right">' + pct + '%</span>'
            + '</div>';
        }).join('');
      }
    }

    // ── 2. Dream Narrative & Activity ──
    var dream = data.lastDream;
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

      var actEl = $('dreamActivity');
      var act = dream.activity || {};
      actEl.innerHTML = '<div style="text-align:center"><div class="card-label">Notes</div><div class="mono" style="font-size:1.1rem;font-weight:600">' + fmt(act.totalNotes) + '</div></div>'
        + '<div style="text-align:center"><div class="card-label">Recently Active</div><div class="mono" style="font-size:1.1rem;font-weight:600;color:var(--green)">' + fmt(act.recentlyAccessed) + '</div></div>'
        + '<div style="text-align:center"><div class="card-label">Decayed</div><div class="mono" style="font-size:1.1rem;font-weight:600;color:var(--yellow)">' + fmt(dream.lifecycle ? dream.lifecycle.decayed : 0) + '</div></div>';
    }

    // ── 3. LLM Status ──
    var llm = data.llmStatus || {};
    var llmDot = $('llmDot');
    var llmText = $('llmStatusText');
    if (!llm.configured) {
      llmDot.style.background = 'var(--text-dim)';
      llmText.textContent = 'Not configured';
      llmText.style.color = 'var(--text-dim)';
    } else if (llm.available) {
      llmDot.style.background = 'var(--green)';
      llmDot.style.boxShadow = '0 0 6px var(--green)';
      llmText.textContent = 'Online';
      llmText.style.color = 'var(--green)';
    } else {
      llmDot.style.background = 'var(--red)';
      llmText.textContent = 'Offline';
      llmText.style.color = 'var(--red)';
    }
    $('llmModel').textContent = llm.model || '—';
    var llmUrlEl = $('llmUrl');
    if (llm.baseUrl) llmUrlEl.textContent = llm.baseUrl + '/v1/...';
    var llmErrEl = $('llmError');
    if (llm.lastError && !llm.available) {
      llmErrEl.textContent = '⚠ ' + llm.lastError;
      llmErrEl.style.display = '';
    } else {
      llmErrEl.style.display = 'none';
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
          + '<div class="llm-ts">' + fmtAgo(s.timestamp) + '</div>'
          + '</div>';
      }).join('');
    }

    // ── 4. Theme Clusters ──
    var tcEl = $('themeClusters');
    if (dream && dream.themes && dream.themes.length) {
      var tempIcons = { hot: '■', warm: '■', cold: '■' };
      var tempColors = { hot: 'var(--red)', warm: 'var(--yellow)', cold: 'var(--blue)' };
      tcEl.innerHTML = dream.themes.map(function (t) {
        var tempColor = tempColors[t.temperature] || 'var(--text-dim)';
        return '<div class="theme-card">'
          + '<div class="theme-name">' + esc(t.name) + '</div>'
          + '<div class="theme-meta">'
          + '<span>' + t.memoryPaths.length + ' memories</span>'
          + '<span style="color:' + tempColor + '">' + tempIcons[t.temperature] + ' ' + t.temperature + '</span>'
          + '</div>'
          + '<div style="font-size:.75rem;color:var(--text);margin-top:.2rem">' + esc(t.summary) + '</div>'
          + '<div class="theme-tags">' + t.tags.map(function (tag) { return '<span class="theme-tag">#' + esc(tag) + '</span>'; }).join('') + '</div>'
          + '</div>';
      }).join('');
    } else {
      tcEl.innerHTML = '<span class="empty-msg">Run a dream cycle to detect recurring themes across your memories.</span>';
    }

    // ── 5. AI Recommendations (connections + consolidations) ──
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
      recsCountEl.textContent = recCards.length + ' recommendations';
    } else {
      recsEl.innerHTML = '<span class="empty-msg">Run a dream cycle to generate connection suggestions and consolidation opportunities.</span>';
      recsCountEl.textContent = '';
    }

    // ── 6. Orphan Memories ──
    var orphans = dream ? dream.orphans || [] : [];
    var orphanBody = $('orphanTableBody');
    var orphanSummary = $('orphanSummary');
    if (!orphans.length) {
      orphanBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>';
      orphanSummary.innerHTML = '';
    } else {
      var actionCounts = {};
      orphans.forEach(function (o) { actionCounts[o.suggestedAction] = (actionCounts[o.suggestedAction] || 0) + 1; });
      var summaryParts = [];
      if (actionCounts.link) summaryParts.push('<span class="action-badge action-link">' + actionCounts.link + ' link</span>');
      if (actionCounts.review) summaryParts.push('<span class="action-badge action-review">' + actionCounts.review + ' review</span>');
      if (actionCounts.consolidate) summaryParts.push('<span class="action-badge action-consolidate">' + actionCounts.consolidate + ' consolidate</span>');
      if (actionCounts.archive) summaryParts.push('<span class="action-badge action-archive">' + actionCounts.archive + ' archive</span>');
      orphanSummary.innerHTML = summaryParts.join('');

      orphanBody.innerHTML = orphans.map(function (o) {
        var actionClass = 'action-' + o.suggestedAction;
        var tempBadge = '<span class="badge badge-' + (o.temperature || 'cold') + '">' + esc(o.temperature || '?') + '</span>';
        var daysTxt = o.daysSinceAccess < 0 ? 'never' : o.daysSinceAccess + 'd ago';
        return '<tr>'
          + '<td title="' + esc(o.path) + '" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help">' + esc(o.title) + '</td>'
          + '<td>' + tempBadge + '</td>'
          + '<td class="mono">' + (o.heat_score || 0).toFixed(1) + '</td>'
          + '<td class="mono" style="color:var(--text-dim)">' + daysTxt + '</td>'
          + '<td><span class="action-badge ' + actionClass + '">' + esc(o.suggestedAction) + '</span></td>'
          + '</tr>';
      }).join('');
    }

    // ── 7. Entity Intelligence ──
    var es = data.entityStats || { tierCounts: {}, typeCounts: {}, total: 0 };
    $('eiTotal').textContent = fmt(es.total);
    $('eiConfirmed').textContent = fmt(es.tierCounts.confirmed || 0);
    $('eiDetected').textContent = fmt(es.tierCounts.detected || 0);

    // Tier bar
    var tierTotal = es.total || 1;
    var confPct = ((es.tierCounts.confirmed || 0) / tierTotal * 100).toFixed(1);
    var detPct = ((es.tierCounts.detected || 0) / tierTotal * 100).toFixed(1);
    var sugPct = ((es.tierCounts.suggested || 0) / tierTotal * 100).toFixed(1);
    var tierBar = $('entityTierBar');
    if (es.total > 0) {
      tierBar.innerHTML = '<div class="seg" style="width:' + confPct + '%;background:var(--green);min-width:0">' + (es.tierCounts.confirmed || '') + '</div>'
        + '<div class="seg" style="width:' + detPct + '%;background:var(--yellow);min-width:0">' + (es.tierCounts.detected || '') + '</div>'
        + '<div class="seg" style="width:' + sugPct + '%;background:var(--border);color:var(--text-dim);min-width:0">' + (es.tierCounts.suggested || '') + '</div>';
    } else {
      tierBar.innerHTML = '<div class="seg" style="width:100%;background:var(--border);color:var(--text-dim)">No entities</div>';
    }

    // Type breakdown bars
    var typeEntries = [];
    for (var tk in es.typeCounts) { if (Object.prototype.hasOwnProperty.call(es.typeCounts, tk)) typeEntries.push([tk, es.typeCounts[tk]]); }
    typeEntries.sort(function (a, b) { return b[1] - a[1]; });
    var typeMax = typeEntries.length > 0 ? typeEntries[0][1] : 1;
    var typeColors = { person: '#58a6ff', project: '#3fb950', organization: '#d29922' };
    var typeEl = $('entityTypeBars');
    if (!typeEntries.length) {
      typeEl.innerHTML = '<span class="empty-msg">No entities</span>';
    } else {
      typeEl.innerHTML = typeEntries.map(function (e) {
        var pct = (e[1] / typeMax * 100).toFixed(0);
        var color = typeColors[e[0]] || 'var(--text-dim)';
        return '<div class="cat-row">'
          + '<span class="cat-label">' + esc(e[0]) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + '">' + e[1] + '</div></div>'
          + '<span class="cat-count">' + e[1] + '</span>'
          + '</div>';
      }).join('');
    }

    // Entity registry table
    var entities = data.entityRegistry || [];
    var erBody = $('entityRegistryBody');
    if (!entities.length) {
      erBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>';
    } else {
      erBody.innerHTML = entities.map(function (e) {
        var confColor = e.confidence >= 0.8 ? 'var(--green)' : e.confidence >= 0.5 ? 'var(--yellow)' : 'var(--red)';
        var statusLabel = e.confirmed ? '<span style="color:var(--green)">✓ confirmed</span>' : '<span style="color:var(--text-dim)">detected</span>';
        return '<tr>'
          + '<td>' + esc(e.name) + '</td>'
          + '<td>' + esc(e.type) + '</td>'
          + '<td style="color:' + confColor + '">' + (e.confidence * 100).toFixed(0) + '%</td>'
          + '<td>' + statusLabel + '</td>'
          + '</tr>';
      }).join('');
    }

    // ── 8. Knowledge Graph ──
    var kgData = data.knowledgeGraph || { entities: 0, triples: 0, predicates: [] };
    $('kgEntities').textContent = fmt(kgData.entities);
    $('kgTriples').textContent = fmt(kgData.triples);
    var kgPredEl = $('kgPredicates');
    if (kgData.predicates && kgData.predicates.length) {
      kgPredEl.innerHTML = kgData.predicates.map(function (p) {
        return '<div style="display:flex;justify-content:space-between;padding:.15rem 0;border-bottom:1px solid var(--border)">'
          + '<span style="color:var(--blue)">' + esc(p.name) + '</span>'
          + '<span class="mono" style="color:var(--text-dim)">' + fmt(p.count) + '</span>'
          + '</div>';
      }).join('');
    } else {
      kgPredEl.innerHTML = '<span class="empty-msg">Knowledge graph empty or not enabled (set KG_ENABLED=true).</span>';
    }

    // ── 9. Dream History ──
    var dh = data.dreamHistory || [];
    if (dh.length >= 2) {
      var svg = $('chartDreamHealth');
      var w = 600, h = 120, pad = 4;
      var maxScore = 100;
      var maxThemes = 1, maxOrphans = 1;
      for (var di = 0; di < dh.length; di++) {
        if (dh[di].themes > maxThemes) maxThemes = dh[di].themes;
        if (dh[di].orphans > maxOrphans) maxOrphans = dh[di].orphans;
      }
      var step = w / (dh.length - 1);
      var dhY = function (v, maxV) { return h - pad - (v / maxV) * (h - 2 * pad); };

      var healthPts = [], themePts = [], orphanPts = [];
      for (var di2 = 0; di2 < dh.length; di2++) {
        var x = (di2 * step).toFixed(1);
        healthPts.push(x + ',' + dhY(dh[di2].healthScore, maxScore).toFixed(1));
        themePts.push(x + ',' + dhY(dh[di2].themes, maxThemes).toFixed(1));
        orphanPts.push(x + ',' + dhY(dh[di2].orphans, maxOrphans).toFixed(1));
      }
      svg.innerHTML =
        '<polyline points="' + healthPts.join(' ') + '" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round"/>'
        + '<polyline points="' + themePts.join(' ') + '" fill="none" stroke="#d29922" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="4 2"/>'
        + '<polyline points="' + orphanPts.join(' ') + '" fill="none" stroke="#f85149" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="4 2"/>';
    }

    var dhTableEl = $('dreamHistoryTable');
    if (!dh.length) {
      dhTableEl.innerHTML = '<span class="empty-msg">No dream cycles recorded yet.</span>';
    } else {
      dhTableEl.innerHTML = dh.slice().reverse().slice(0, 20).map(function (d) {
        var scoreColor = d.healthScore >= 70 ? 'var(--green)' : d.healthScore >= 40 ? 'var(--yellow)' : 'var(--red)';
        return '<div class="dh-row">'
          + '<span class="dh-ts">' + fmtAgo(d.timestamp) + '</span>'
          + '<span class="dh-score" style="color:' + scoreColor + '">' + d.healthScore + '</span>'
          + '<span class="dh-metrics">' + d.themes + 'T ' + d.orphans + 'O ' + d.connections + 'C' + (d.decayed ? ' ' + d.decayed + 'D' : '') + '</span>'
          + '</div>';
      }).join('');
    }

    // ── 10. Agent Awareness ──
    var agents = data.agentDiaries || [];
    var adBody = $('agentDiariesBody');
    if (!agents.length) {
      adBody.innerHTML = '<tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>';
    } else {
      adBody.innerHTML = agents.map(function (a) {
        return '<tr>'
          + '<td style="color:var(--blue);font-weight:500">' + esc(a.agentId) + '</td>'
          + '<td>' + fmtAgo(a.lastActive) + '</td>'
          + '<td>' + fmt(a.entryCount) + '</td>'
          + '</tr>';
      }).join('');
    }

    // Cross-reference agent activity with dream themes for "thinking about" section
    var activityEl = $('agentRecentActivity');
    var thinkingParts = [];
    if (dream && dream.themes && dream.themes.length) {
      thinkingParts.push('<div style="font-size:.72rem;color:var(--text-dim);margin-bottom:.3rem;font-style:italic">Based on recent dream analysis and agent activity:</div>');
      var activeThemes = dream.themes.filter(function (t) { return t.temperature === 'hot' || t.temperature === 'warm'; });
      if (activeThemes.length) {
        thinkingParts.push('<div style="margin-bottom:.3rem;font-size:.75rem"><strong style="color:var(--blue)">Active focus areas:</strong> ' + activeThemes.map(function (t) { return t.name + ' (' + t.memoryPaths.length + ')'; }).join(', ') + '</div>');
      }
      if (dream.lifecycle && dream.lifecycle.decayed > 0) {
        thinkingParts.push('<div style="font-size:.72rem;color:var(--yellow)">Pruned ' + dream.lifecycle.decayed + ' stale memories during last dream cycle.</div>');
      }
      if (dream.connectionSuggestions && dream.connectionSuggestions.length > 0) {
        thinkingParts.push('<div style="font-size:.72rem;color:var(--green)">Discovered ' + dream.connectionSuggestions.length + ' potential connections between notes.</div>');
      }
    }
    if (thinkingParts.length) {
      activityEl.innerHTML = thinkingParts.join('');
    } else if (!agents.length) {
      activityEl.innerHTML = '';
    } else {
      activityEl.innerHTML = '<div style="font-size:.72rem;color:var(--text-dim);font-style:italic">Run a dream cycle to see what the AI has been thinking about.</div>';
    }
  },
};
