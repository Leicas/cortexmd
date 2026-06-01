// vault.js — Vault & Memory tab client module (ES module, no build).
// REVAMP.md §5 TAB 4. Reads payload data only from ctx.data; source-vault
// listing + migration are extra fetches/actions wired in init() and exposed via
// window.cortex so the server-rendered onclick handlers reach them.
//
// The refresh() pass fills the promoted KPI tiles (retrieval quality, hybrid
// balance, temperature-balance gauge, embedding coverage + stale/orphan ratios)
// and the three IA zones. Status pills are driven by a locally-mirrored copy of
// the model/derive THRESHOLDS (the same pattern overview.js uses): the client
// classifies a value with a key, never hard-coding a color. All viz goes through
// the shared chart helpers (drawBars / drawGauge / drawChart) — no inline SVG
// construction beyond the legacy stacked-area temp history.
//
// See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

// Threshold map mirrored from model/derive.ts THRESHOLDS (kept in sync). Clients
// classify value+key → 'ok'|'warn'|'bad' so good/warn/bad is consistent + never
// color-only (each consumer also renders a glyph/text label).
var THRESH = {
  zeroResultRate: { good: 0.1, warn: 0.25, dir: 'lower' },
  staleRatio: { good: 0.15, warn: 0.35, dir: 'lower' },
  orphanRatio: { good: 0.15, warn: 0.35, dir: 'lower' },
  embeddingCoverage: { good: 0.9, warn: 0.6, dir: 'higher' },
};
function pillState(value, key) {
  var t = THRESH[key];
  if (!t) return 'ok';
  if (t.dir === 'lower') return value <= t.good ? 'ok' : value <= t.warn ? 'warn' : 'bad';
  return value >= t.good ? 'ok' : value >= t.warn ? 'warn' : 'bad';
}
function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}
/** Set a status-pill host element's contents + ratio label. */
function setRatioPill(ctx, id, state, label) {
  var el = ctx.$(id);
  if (el) el.innerHTML = pillHtml(state, label);
}

export default {
  id: 'vault',

  /** One-time: register cortex.* actions, then load the source-vault table
   *  (mirrors the legacy switchTab('vault') → loadSourceVaults() behavior). */
  init(el, ctx) {
    var esc = ctx.esc, escAttr = ctx.escAttr, fmt = ctx.fmt, toast = ctx.toast;

    // ── Read-only source vaults ──
    function loadSourceVaults() {
      var body = ctx.$('sourceVaultsBody');
      if (!body) return;
      fetch('/dashboard/api/source-vaults', { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' — not authorized' : ''));
          return r.json();
        })
        .then(function (d) {
          var vaults = (d && d.vaults) || [];
          if (!vaults.length) {
            body.innerHTML = '<tr><td colspan="7" class="empty-msg">No read-only vaults configured.</td></tr>';
            return;
          }
          body.innerHTML = vaults.map(function (v) {
            var globs = (v.includeGlobs && v.includeGlobs.length)
              ? '<span class="mono">' + esc(v.includeGlobs.join(', ')) + '</span>'
              : '<span style="color:var(--text-dim)">all</span>';
            var badge = v.source === 'env'
              ? '<span class="badge badge--warn">env</span>'
              : '<span class="badge badge--ok">persisted</span>';
            var indexed = (v.indexedDocs != null) ? fmt.fmt(v.indexedDocs) : '—';
            var stState = v.status === 'ok' ? 'ok' : (v.status === 'degraded' ? 'bad' : 'muted');
            var statusBadge = '<span class="badge badge--' + stState + '">'
              + '<span class="dot" aria-hidden="true"></span>' + esc(v.status || 'unknown') + '</span>';
            var action = v.source === 'env'
              ? '<span style="color:var(--text-dim);font-size:var(--fs-xs)">immutable</span>'
              : '<button class="btn btn-danger btn--sm" onclick="cortex.removeSourceVault(\'' + escAttr(v.name) + '\')">Remove</button>';
            return '<tr>'
              + '<td>' + esc(v.name) + '</td>'
              + '<td class="mono" title="' + escAttr(v.path) + '" style="font-size:var(--fs-xs)">' + esc(v.path) + '</td>'
              + '<td>' + globs + '</td>'
              + '<td>' + badge + '</td>'
              + '<td class="num">' + indexed + '</td>'
              + '<td>' + statusBadge + '</td>'
              + '<td>' + action + '</td>'
              + '</tr>';
          }).join('');
        })
        .catch(function (e) {
          body.innerHTML = '<tr><td colspan="7" class="empty-msg">Failed to load: ' + esc(e.message) + '</td></tr>';
        });
    }

    function addSourceVault() {
      var fb = ctx.$('svFeedback');
      var btn = ctx.$('svAddBtn');
      var path = (ctx.$('svPath').value || '').trim();
      var name = (ctx.$('svName').value || '').trim();
      var globsRaw = (ctx.$('svGlobs').value || '');
      if (!path) {
        fb.style.color = 'var(--err)';
        fb.textContent = 'Folder path is required.';
        return;
      }
      var includeGlobs = globsRaw.split(/[,\n]/).map(function (g) { return g.trim(); }).filter(Boolean);
      var payload = { path: path };
      if (name) payload.name = name;
      if (includeGlobs.length) payload.includeGlobs = includeGlobs;
      btn.disabled = true;
      fb.style.color = 'var(--text-dim)';
      fb.textContent = 'Adding…';
      fetch('/dashboard/api/source-vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (res.ok) {
            fb.style.color = 'var(--ok)';
            fb.textContent = 'Added "' + (res.d.name || name || path) + '". Reindexing…';
            ctx.$('svPath').value = '';
            ctx.$('svName').value = '';
            ctx.$('svGlobs').value = '';
            loadSourceVaults();
          } else {
            fb.style.color = 'var(--err)';
            fb.textContent = (res.d && res.d.error) || 'Failed to add vault.';
          }
        })
        .catch(function (e) {
          btn.disabled = false;
          fb.style.color = 'var(--err)';
          fb.textContent = 'Request failed: ' + e.message;
        });
    }

    function removeSourceVault(name) {
      if (!confirm('Remove read-only vault "' + name + '"? It will be dropped from the index.')) return;
      var fb = ctx.$('svFeedback');
      fetch('/dashboard/api/source-vaults/' + encodeURIComponent(name), {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok) {
            fb.style.color = 'var(--ok)';
            fb.textContent = 'Removed "' + name + '". Reindexing…';
            loadSourceVaults();
          } else {
            fb.style.color = 'var(--err)';
            fb.textContent = (res.d && res.d.error) || 'Failed to remove vault.';
          }
        })
        .catch(function (e) {
          fb.style.color = 'var(--err)';
          fb.textContent = 'Request failed: ' + e.message;
        });
    }

    // ── Vault migration ──
    function runMigrationAction(dryRun) {
      var url = dryRun ? '/dashboard/api/migrate/dry-run' : '/dashboard/api/migrate/run';
      var resultEl = ctx.$('migrationResult');
      if (!dryRun && !confirm('This will move files in the vault. Originals are backed up as .migrated.md. Proceed?')) return;
      resultEl.innerHTML = '<span style="color:var(--text-dim)">Running ' + (dryRun ? 'dry run' : 'migration') + '…</span>';
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok && d.error) { resultEl.innerHTML = '<span style="color:var(--err)">' + esc(d.error) + '</span>'; return; }
          var prefix = d.dryRun
            ? '<strong style="color:var(--info)">[DRY RUN]</strong> '
            : '<strong style="color:var(--ok)">[DONE]</strong> ';
          var lines = [
            prefix + 'Migration ' + d.status,
            'Memories moved: <strong>' + d.memoriesMoved + '</strong>',
            'Insights merged: <strong>' + d.insightsMerged + '</strong>',
            'Journal entries split: <strong>' + d.journalEntriesSplit + '</strong>',
            'Diary files split: <strong>' + d.diaryFilesSplit + '</strong>',
          ];
          if (d.errors && d.errors.length > 0) {
            lines.push('<span style="color:var(--err)">Errors (' + d.errors.length + '):</span>');
            d.errors.forEach(function (e) { lines.push('&nbsp;&nbsp;' + esc(e)); });
          }
          resultEl.innerHTML = lines.join('<br>');
          if (!d.dryRun && d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit > 0) {
            toast('Migration complete: ' + (d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit) + ' items moved', 'success');
          }
        })
        .catch(function (e) { resultEl.innerHTML = '<span style="color:var(--err)">Request failed: ' + e.message + '</span>'; });
    }

    // Expose the action callbacks the server-rendered onclick handlers call.
    window.cortex.loadSourceVaults = loadSourceVaults;
    window.cortex.addSourceVault = addSourceVault;
    window.cortex.removeSourceVault = removeSourceVault;
    window.cortex.runMigrationAction = runMigrationAction;

    // Initial source-vault load (legacy switchTab('vault') behavior).
    loadSourceVaults();
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var fmt = ctx.fmt, esc = ctx.esc, escAttr = ctx.escAttr, $ = ctx.$, setLive = ctx.setLive;
    var charts = ctx.charts;
    var fmtMs = fmt.fmtMs, fmtTime = fmt.fmtTime, fmtAgo = fmt.fmtAgo, fmtDate = fmt.fmtDate, latClass = fmt.latClass;
    var fmtN = fmt.fmt;
    var data = ctx.data;

    // ── Index / rebuild + health diagnostics ──
    setLive('vaultNotes', fmtN(data.indexedNotes));
    var rb = data.lastIndexRebuild;
    $('vaultRebuild').textContent = rb ? 'Last rebuilt ' + fmtAgo(rb) : 'Never rebuilt';

    var ih = data.indexHealth || [];
    var ihEl = $('indexHealthInfo');
    var idxErrTotal = 0;
    if (ih.length) {
      ihEl.innerHTML = ih.map(function (v) {
        var clean = v.enoent === 0 && v.permissionErrors === 0 && v.otherErrors === 0;
        if (!clean) idxErrTotal += (v.enoent || 0) + (v.permissionErrors || 0) + (v.otherErrors || 0);
        var name = esc(v.vault.split('/').pop() || v.vault);
        var parts = ['<span class="mono">' + name + '</span> ' + v.indexed + '/' + v.fileCount];
        if (v.enoent > 0) {
          parts.push('<span class="pill pill--warn">' + v.enoent + ' missing</span>');
        }
        if (v.permissionErrors > 0) {
          parts.push('<span class="pill pill--bad">' + v.permissionErrors + ' denied</span>');
        }
        if (v.otherErrors > 0) {
          parts.push('<span class="pill pill--bad">' + v.otherErrors + ' errors</span>');
        }
        if (clean) parts.push('<span class="pill pill--ok"><span class="dot" aria-hidden="true"></span>clean</span>');
        return '<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.3rem">' + parts.join(' ') + '</div>';
      }).join('');
    } else {
      ihEl.innerHTML = '';
    }

    // ── Memory temperature ──
    var mt = data.memoryTemperature || { hot: 0, warm: 0, cold: 0 };
    $('memHot').textContent = 'Hot: ' + fmtN(mt.hot);
    $('memWarm').textContent = 'Warm: ' + fmtN(mt.warm);
    $('memCold').textContent = 'Cold: ' + fmtN(mt.cold);
    var total = mt.hot + mt.warm + mt.cold;
    var bar = $('memBar');
    if (total > 0) {
      bar.innerHTML = stackedSeg('seg-hot', mt.hot, total) + stackedSeg('seg-warm', mt.warm, total) + stackedSeg('seg-cold', mt.cold, total);
    } else {
      bar.innerHTML = '';
    }

    // ── Temperature-balance gauge (KPI) ──
    // Balance index: 1 = perfectly even hot/warm/cold split, 0 = all in one bucket.
    var tempBalance = computeTempBalance(mt);
    charts.drawGauge('kpiTempGauge', tempBalance, {
      good: 0.66, warn: 0.4,
      label: total > 0 ? Math.round(tempBalance * 100) + '' : '—',
      sub: total > 0 ? 'balance' : 'no data',
    });
    var thBal = data.temperatureHistory || [];
    var balPrev = thBal.length >= 2 ? computeTempBalance(thBal[0]) : null;
    var balDelta = balPrev != null ? Math.round((tempBalance - balPrev) * 100) : 0;
    $('kpiTempSub').textContent = total > 0
      ? (balDelta > 0 ? '↑' : balDelta < 0 ? '↓' : '→') + ' ' + Math.abs(balDelta) + ' pts vs start'
      : 'no memories yet';

    // ── Embedding stats + coverage KPI ──
    var embStats = data.embeddingStats || {};
    var embBadge = $('embeddingBadge');
    if (embStats.ready) {
      embBadge.className = 'badge badge--ok';
      embBadge.innerHTML = '<span class="dot" aria-hidden="true"></span>Active';
    } else {
      embBadge.className = 'badge badge--err';
      embBadge.innerHTML = '<span class="dot" aria-hidden="true"></span>Disabled';
    }
    $('embModel').textContent = embStats.model || '—';
    var vectors = embStats.vectors != null ? embStats.vectors : (embStats.indexSize || 0);
    $('embVectors').textContent = fmtN(vectors);
    $('embAvgTime').textContent = embStats.avgEmbedTimeMs ? embStats.avgEmbedTimeMs + ' ms' : '—';

    var dv = data.derived || {};
    var coverage = dv.embeddingCoverage != null
      ? dv.embeddingCoverage
      : (data.indexedNotes > 0 ? Math.min(1, vectors / data.indexedNotes) : 0);
    setLive('kpiCoverageVal', Math.round(coverage * 100) + '%');
    var uncovered = Math.max(0, (data.indexedNotes || 0) - vectors);
    $('kpiCoverageSub').textContent = fmtN(uncovered) + ' notes unembedded';
    setRatioPill(ctx, 'kpiCoveragePill', pillState(coverage, 'embeddingCoverage'),
      coverage >= 0.9 ? 'covered' : coverage >= 0.6 ? 'partial' : 'sparse');

    // ── Stale / orphan ratio chips (foot of coverage KPI) ──
    var vh = data.vaultHealth;
    var ld = data.linkDensity;
    var ratioFoot = $('kpiRatioFoot');
    if (ratioFoot) {
      var chips = [];
      if (vh && vh.totalFiles) {
        var staleRatio = vh.staleNotes / vh.totalFiles;
        chips.push(ratioChip(pillState(staleRatio, 'staleRatio'), 'stale ' + Math.round(staleRatio * 100) + '%'));
      }
      if (ld && (ld.totalMdFiles || ld.totalLinks != null)) {
        var denom = ld.totalMdFiles || (ld.orphanNotes + (vh ? vh.totalFiles : 0)) || 1;
        var orphanRatio = ld.orphanNotes / denom;
        chips.push(ratioChip(pillState(orphanRatio, 'orphanRatio'), 'orphan ' + Math.round(orphanRatio * 100) + '%'));
      }
      ratioFoot.innerHTML = chips.join('');
    }

    // ── Retrieval-quality KPI (zero-result rate + latency percentiles) ──
    var sq = data.searchStats || {};
    var zeroRate = sq.totalSearches > 0 ? sq.zeroResultCount / sq.totalSearches : 0;
    setLive('kpiZeroRate', (zeroRate * 100).toFixed(1) + '%');
    var rsForLat = data.recentSearches || [];
    var lats = rsForLat.map(function (s) { return s.latencyMs; }).filter(function (n) { return typeof n === 'number'; });
    var p50 = percentile(lats, 0.5), p95 = percentile(lats, 0.95);
    $('kpiZeroSub').textContent = lats.length
      ? 'p50 ' + Math.round(p50) + 'ms · p95 ' + Math.round(p95) + 'ms'
      : fmtN(sq.totalSearches) + ' searches';
    setRatioPill(ctx, 'kpiZeroPill', pillState(zeroRate, 'zeroResultRate'),
      zeroRate <= 0.1 ? 'healthy' : zeroRate <= 0.25 ? 'leaky' : 'poor');

    // ── Hybrid-balance KPI ──
    var sa = data.searchTypeStats || {};
    var avgLex = sa.avgLexicalContribution || 0;
    var avgSem = sa.avgSemanticContribution || 0;
    var hybridBar = $('kpiHybridBar');
    if (avgLex + avgSem > 0) {
      var lexPct = Math.round(avgLex / (avgLex + avgSem) * 100);
      var semPct = 100 - lexPct;
      setLive('kpiHybridVal', lexPct + '/' + semPct);
      $('kpiHybridSub').textContent = 'lexical / semantic';
      hybridBar.innerHTML = '<div class="seg" style="width:' + lexPct + '%;background:var(--info)"></div>'
        + '<div class="seg" style="width:' + semPct + '%;background:var(--ok)"></div>';
    } else {
      setLive('kpiHybridVal', '—');
      var bothHits = sa.bothHits || 0;
      var hitTot = (sa.lexicalOnlyHits || 0) + (sa.semanticOnlyHits || 0) + bothHits;
      $('kpiHybridSub').textContent = hitTot ? Math.round(bothHits / hitTot * 100) + '% both-retriever hits' : 'no fusion data';
      hybridBar.innerHTML = '';
    }

    // ── Search Quality detail card ──
    setLive('sqTotal', fmtN(sq.totalSearches));
    setLive('sqAvgResults', fmtN(sq.avgResultCount));
    $('sqAvgLatency').textContent = sq.avgLatencyMs ? sq.avgLatencyMs + ' ms' : '—';
    var zrEl = $('sqZeroRate');
    zrEl.textContent = (zeroRate * 100).toFixed(1) + '%';
    zrEl.style.color = zeroRate > 0.25 ? 'var(--err)' : zeroRate > 0.1 ? 'var(--warn)' : 'var(--ok)';

    // ── Recent searches feed ──
    var rs = data.recentSearches || [];
    var rsEl = $('recentSearchesFeed');
    if (!rs.length) {
      rsEl.innerHTML = '<div class="empty-msg">No searches recorded.</div>';
    } else {
      rsEl.innerHTML = rs.slice().reverse().map(function (s) {
        return '<div class="search-item">'
          + '<span class="s-ts">' + fmtTime(s.timestamp) + '</span>'
          + '<span class="s-query" title="' + escAttr(s.query) + '">' + esc(s.query) + '</span>'
          + '<span class="s-count">' + s.resultCount + ' hits</span>'
          + '<span class="s-lat">' + s.latencyMs + ' ms</span>'
          + '</div>';
      }).join('');
    }

    // ── Memory Stack (L0 + L1) ──
    var ms = data.memoryStack || [];
    var l0 = null, l1 = null;
    for (var mi = 0; mi < ms.length; mi++) {
      if (ms[mi].level === 0) l0 = ms[mi];
      if (ms[mi].level === 1) l1 = ms[mi];
    }
    var msIdEl = $('msIdentity');
    if (l0 && l0.content) msIdEl.textContent = l0.content;
    else msIdEl.innerHTML = '<span class="empty-msg">No identity loaded yet.</span>';
    var msNarrEl = $('msNarrative');
    if (l1 && l1.content) msNarrEl.textContent = l1.content;
    else msNarrEl.innerHTML = '<span class="empty-msg">No narrative loaded yet.</span>';
    var msTotalTokens = 0;
    for (var ti = 0; ti < ms.length; ti++) msTotalTokens += (ms[ti].tokens || 0);
    $('msTokenCount').textContent = fmtN(msTotalTokens);

    // ── So-what strip ──
    var sw = $('vaultSoWhat');
    if (sw) {
      var bits = [fmtN(data.indexedNotes) + ' notes indexed'];
      bits.push('zero-result <b>' + (zeroRate * 100).toFixed(0) + '%</b>');
      bits.push('coverage <b>' + Math.round(coverage * 100) + '%</b>');
      if (uncovered > 0) bits.push('<b>' + fmtN(uncovered) + '</b> unembedded');
      if (idxErrTotal > 0) bits.push('<b style="color:var(--warn)">' + idxErrTotal + '</b> index issues');
      sw.innerHTML = bits.join(' · ');
    }

    // ════════ Analytics zone (deep) ════════
    // Only build the heavy viz when the collapsible section is open (cheap guard;
    // SSE still updates KPIs/live cards above every tick regardless).
    var details = $('vaultAnalytics');
    if (details && !details.open) return;

    // ── Temperature time-series (stacked area) ──
    var th = data.temperatureHistory || [];
    var svg = $('chartTempHistory');
    if (svg && th.length >= 2) {
      var w = 600, h = 160, pad = 4;
      var maxVal = 1;
      for (var i = 0; i < th.length; i++) {
        var sSum = th[i].hot + th[i].warm + th[i].cold;
        if (sSum > maxVal) maxVal = sSum;
      }
      var step = w / (th.length - 1);
      var yPos = function (v) { return h - pad - (v / maxVal) * (h - 2 * pad); };
      var coldPts = [], warmPts = [], hotPts = [];
      for (var j = 0; j < th.length; j++) {
        var x = (j * step).toFixed(1);
        coldPts.push(x + ',' + yPos(th[j].cold).toFixed(1));
        warmPts.push(x + ',' + yPos(th[j].cold + th[j].warm).toFixed(1));
        hotPts.push(x + ',' + yPos(th[j].cold + th[j].warm + th[j].hot).toFixed(1));
      }
      var baseline = ' ' + ((th.length - 1) * step).toFixed(1) + ',' + h + ' 0,' + h;
      svg.innerHTML =
        areaLayer(coldPts, baseline, 'var(--info)')
        + areaLayer(warmPts, baseline, 'var(--warn)')
        + areaLayer(hotPts, baseline, 'var(--err)');
    } else if (svg) {
      svg.innerHTML = '';
    }

    // ── Heat score histogram (drawBars + median marker) ──
    var hist = data.heatHistogram || [0, 0, 0, 0];
    charts.drawBars('heatHistogram', hist.map(function (n) { return n || 0; }), 'var(--brand)', { median: true });

    // ── Top 10 hottest notes ──
    var topNotes = data.topNotes || [];
    var tnBody = $('topNotesBody');
    if (!topNotes.length) {
      tnBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No notes indexed</td></tr>';
    } else {
      tnBody.innerHTML = topNotes.map(function (n) {
        var tState = n.temperature === 'hot' ? 'hot' : n.temperature === 'cold' ? 'cold' : 'warm';
        var tempBadge = '<span class="badge badge-' + tState + '">' + esc(n.temperature || '?') + '</span>';
        return '<tr>'
          + '<td title="' + escAttr(n.path) + '" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.title) + '</td>'
          + '<td class="num ' + latClass(16 - (n.heat_score || 0)) + '">' + fmtN(n.heat_score) + '</td>'
          + '<td>' + tempBadge + '</td>'
          + '<td>' + esc(n.category || '—') + '</td>'
          + '<td class="mono" style="font-size:var(--fs-xs)">' + esc(n.last_accessed || '—') + '</td>'
          + '</tr>';
      }).join('');
    }

    // ── Memory categories ──
    renderCatBars(ctx, 'categoryBars', data.categoryBreakdown || {}, 'No categories found');

    // ── Vault Health ──
    if (vh) {
      setLive('vhTotal', fmtN(vh.totalFiles));
      setLive('vhArchived', fmtN(vh.archivedNotes));
      var vhStaleEl = $('vhStale');
      vhStaleEl.textContent = fmtN(vh.staleNotes);
      vhStaleEl.style.color = vh.staleNotes > 10 ? 'var(--warn)' : 'var(--ok)';
      var ftEntries = [];
      for (var ftk in vh.fileCountByType) {
        if (Object.prototype.hasOwnProperty.call(vh.fileCountByType, ftk)) ftEntries.push(ftk + ':' + vh.fileCountByType[ftk]);
      }
      $('vhFileTypes').textContent = ftEntries.join(' · ') || '—';
    }

    // ── Link Density ──
    if (ld) {
      setLive('ldTotal', fmtN(ld.totalLinks));
      $('ldAvg').textContent = ld.avgLinksPerNote.toFixed(1);
      var ldOrpEl = $('ldOrphans');
      ldOrpEl.textContent = fmtN(ld.orphanNotes);
      ldOrpEl.style.color = ld.orphanNotes > 20 ? 'var(--err)' : ld.orphanNotes > 5 ? 'var(--warn)' : 'var(--ok)';
      var mlEl = $('ldMostLinked');
      if (ld.mostLinked && ld.mostLinked.length) {
        mlEl.innerHTML = ld.mostLinked.slice(0, 5).map(function (m) {
          var short = m.path.split('/').pop() || m.path;
          return '<div title="' + escAttr(m.path) + '">' + esc(short) + ' <span style="color:var(--info)">' + m.inbound + '</span></div>';
        }).join('');
      } else {
        mlEl.textContent = '—';
      }
    }

    // ── Search Analytics ──
    setLive('saLexOnly', fmtN(sa.lexicalOnlyHits));
    setLive('saSemOnly', fmtN(sa.semanticOnlyHits));
    setLive('saBoth', fmtN(sa.bothHits));
    var saBar = $('saContribBar');
    if (avgLex + avgSem > 0) {
      var lexPctSa = Math.round(avgLex / (avgLex + avgSem) * 100);
      var semPctSa = 100 - lexPctSa;
      saBar.innerHTML = '<div class="seg" style="width:' + lexPctSa + '%;background:var(--info)">' + lexPctSa + '%</div>'
        + '<div class="seg" style="width:' + semPctSa + '%;background:var(--ok)">' + semPctSa + '%</div>';
    } else {
      saBar.innerHTML = '<div class="seg" style="width:100%;background:var(--border);color:var(--text-dim)">No data</div>';
    }

    // ── Memory Lifecycle ──
    var ml = data.memoryLifecycle || {};
    setLive('mlArchived', fmtN(ml.totalArchived));
    setLive('mlConsolidated', fmtN(ml.totalConsolidated));
    var tdist = ml.temperatureDistribution || { hot: 0, warm: 0, cold: 0, unset: 0 };
    var tdTotal = tdist.hot + tdist.warm + tdist.cold + tdist.unset;
    var mlBar = $('mlTempBar');
    if (tdTotal > 0) {
      mlBar.innerHTML = stackedSeg('seg-hot', tdist.hot, tdTotal, true)
        + stackedSeg('seg-warm', tdist.warm, tdTotal, true)
        + stackedSeg('seg-cold', tdist.cold, tdTotal, true)
        + '<div class="seg" style="width:' + (tdist.unset / tdTotal * 100).toFixed(1) + '%;background:var(--border-strong);color:var(--text-dim)">' + (tdist.unset || '') + '</div>';
    } else {
      mlBar.innerHTML = '';
    }
    var mlOpsEl = $('mlRecentOps');
    var recentArchives = ml.recentArchives || [];
    var recentConsols = ml.recentConsolidations || [];
    var ops = [];
    for (var ai = 0; ai < recentArchives.length; ai++) {
      ops.push({ ts: recentArchives[ai].timestamp, text: 'Archived ' + esc((recentArchives[ai].path || '').split('/').pop() || recentArchives[ai].path), type: 'archive' });
    }
    for (var cci = 0; cci < recentConsols.length; cci++) {
      ops.push({ ts: recentConsols[cci].timestamp, text: 'Consolidated ' + recentConsols[cci].count + ' notes', type: 'consolidate' });
    }
    ops.sort(function (a, b) { return b.ts - a.ts; });
    if (!ops.length) {
      mlOpsEl.innerHTML = '<div class="empty-msg">No recent lifecycle events.</div>';
    } else {
      mlOpsEl.innerHTML = ops.slice(0, 10).map(function (op) {
        var color = op.type === 'archive' ? 'var(--warn)' : 'var(--ok)';
        return '<div style="display:flex;gap:.5rem;padding:.2rem 0;border-bottom:1px solid var(--line-faint)">'
          + '<span class="mono" style="color:var(--text-dim);width:60px;flex-shrink:0">' + fmtTime(op.ts) + '</span>'
          + '<span style="color:' + color + '">' + op.text + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Recent memory operations / notes accessed ──
    var allCalls = data.recentToolCalls || [];
    var memOps = allCalls.filter(function (c) { return c.tool && c.tool.indexOf('memory_') === 0; });
    var moEl = $('memoryOpsFeed');
    if (!memOps.length) {
      moEl.innerHTML = '<div class="empty-msg">No memory operations recorded.</div>';
    } else {
      moEl.innerHTML = memOps.slice().reverse().map(function (c) {
        return '<div class="feed-item" style="flex-wrap:wrap">'
          + '<span class="feed-ts">' + fmtTime(c.timestamp) + '</span>'
          + '<span class="feed-tool">' + esc(c.tool) + '</span>'
          + '<span class="feed-status ' + (c.status === 'ok' ? 'ok' : 'error') + '">' + (c.status === 'ok' ? '✓' : '✗') + '</span>'
          + '<span class="feed-dur">' + fmtMs(c.durationMs) + '</span>'
          + (c.detail ? '<span style="width:100%;font-size:var(--fs-xs);color:var(--text-dim);margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(c.detail) + '">' + esc(c.detail) + '</span>' : '')
          + '</div>';
      }).join('');
    }
    var noteOps = allCalls.filter(function (c) { return c.tool === 'notes_get'; });
    var naEl = $('notesAccessFeed');
    if (naEl) {
      if (!noteOps.length) {
        naEl.innerHTML = '<div class="empty-msg">No notes accessed yet.</div>';
      } else {
        naEl.innerHTML = noteOps.slice().reverse().map(function (c) {
          return '<div class="feed-item">'
            + '<span class="feed-ts">' + fmtTime(c.timestamp) + '</span>'
            + '<span class="feed-status ' + (c.status === 'ok' ? 'ok' : 'error') + '">' + (c.status === 'ok' ? '✓' : '✗') + '</span>'
            + '<span style="flex:1;color:var(--text);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(c.detail || '') + '">' + esc(c.detail || c.tool) + '</span>'
            + '<span class="feed-dur">' + fmtMs(c.durationMs) + '</span>'
            + '</div>';
        }).join('');
      }
    }

    // ── Collections ──
    renderCatBars(ctx, 'collectionBars', data.collectionDistribution || {}, 'No collection data');

    // ── Score breakdown ──
    var ssb = data.searchScoreBreakdowns || [];
    var sbEl = $('scoreBreakdowns');
    if (!ssb.length) {
      sbEl.innerHTML = '<div class="empty-msg">No searches with score data.</div>';
    } else {
      sbEl.innerHTML = ssb.slice().reverse().map(function (s) {
        var rows = s.results.map(function (r) {
          var rTotal = r.lexical + r.semantic;
          if (rTotal === 0) rTotal = 1;
          var lexPct = Math.round(r.lexical / rTotal * 100);
          var semPct = 100 - lexPct;
          var pathShort = r.path.split('/').pop() || r.path;
          return '<div class="score-row">'
            + '<span class="sr-path" title="' + escAttr(r.path) + '">' + esc(pathShort) + '</span>'
            + '<div class="sr-bar-wrap"><div class="sr-bar">'
            + '<div class="sr-seg lex" style="width:' + lexPct + '%" title="Lexical: ' + r.lexical.toFixed(4) + '">' + (lexPct > 15 ? lexPct + '%' : '') + '</div>'
            + '<div class="sr-seg sem" style="width:' + semPct + '%" title="Semantic: ' + r.semantic.toFixed(4) + '">' + (semPct > 15 ? semPct + '%' : '') + '</div>'
            + '</div></div>'
            + '</div>';
        }).join('');
        return '<div style="margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--line-faint)">'
          + '<div style="font-size:var(--fs-sm);margin-bottom:.3rem"><span style="color:var(--info)">' + esc(s.query) + '</span> <span class="mono" style="color:var(--text-dim)">' + fmtTime(s.timestamp) + '</span></div>'
          + rows
          + '</div>';
      }).join('');
    }

    // ── Benchmark summary card ──
    var bench = data.benchmarkSummary;
    if (bench) {
      var r5Val = bench.avgRecallAt5;
      var ndcgVal = bench.avgNdcgAt10;
      var avgLatVal = bench.totalQueries > 0 ? Math.round(bench.totalLatencyMs / bench.totalQueries) : 0;
      var graded = function (v) { if (v < 0) return 'var(--text-dim)'; if (v >= 0.7) return 'var(--ok)'; if (v >= 0.4) return 'var(--warn)'; return 'var(--err)'; };
      var sqbR5 = $('sqbRecall5'), sqbNdcg = $('sqbNdcg10'), sqbLat = $('sqbAvgLat'), sqbRun = $('sqbLastRun');
      sqbR5.textContent = r5Val >= 0 ? (r5Val * 100).toFixed(0) + '%' : '—';
      sqbR5.style.color = graded(r5Val);
      sqbNdcg.textContent = ndcgVal >= 0 ? (ndcgVal * 100).toFixed(0) + '%' : '—';
      sqbNdcg.style.color = graded(ndcgVal);
      sqbLat.textContent = avgLatVal + ' ms';
      sqbLat.style.color = avgLatVal < 100 ? 'var(--ok)' : avgLatVal < 500 ? 'var(--warn)' : 'var(--err)';
      sqbRun.textContent = fmtAgo(bench.timestamp);
    }

    // ── Retrieval benchmark table + gauges + dot-plot ──
    var bgEl = $('benchmarkGauges');
    var btBody = $('benchmarkTableBody');
    var btTs = $('benchmarkTimestamp');
    var btnSave = $('btnSaveGroundTruth');
    if (!bench) {
      bgEl.innerHTML = '';
      btBody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="text-align:center">No benchmark run yet. Click "Run Benchmark" to start.</td></tr>';
      if (btnSave) btnSave.style.display = 'none';
      charts.drawChart('benchmarkDotPlot', [], 'var(--brand)');
    } else {
      if (btnSave) btnSave.style.display = '';
      btTs.textContent = 'Last run: ' + fmtDate(bench.timestamp) + ' · ' + bench.totalQueries + ' queries · ' + bench.totalLatencyMs + ' ms total';

      var gaugeVal = function (v) { return v < 0 ? 'N/A' : (v * 100).toFixed(0) + '%'; };
      var gaugeColor = function (v) { if (v < 0) return 'var(--text-dim)'; if (v >= 0.7) return 'var(--ok)'; if (v >= 0.4) return 'var(--warn)'; return 'var(--err)'; };
      var hasGroundTruth = bench.avgPrecisionAt5 >= 0;
      var gauges = [
        ['P@5', bench.avgPrecisionAt5],
        ['NDCG@10', bench.avgNdcgAt10],
        ['R@5', bench.avgRecallAt5],
        ['R@10', bench.avgRecallAt10],
      ];
      bgEl.innerHTML = gauges.map(function (g) {
        return '<div class="card card--quiet card--pad-sm" style="text-align:center">'
          + '<div class="card-label" style="justify-content:center">' + g[0] + '</div>'
          + '<div class="card-value mono" style="font-size:var(--fs-xl);color:' + gaugeColor(g[1]) + '">' + gaugeVal(g[1]) + '</div>'
          + '</div>';
      }).join('');

      // Per-query NDCG@10 dot-plot (variance, not just the average).
      var results = bench.results || [];
      drawDotPlot(ctx, 'benchmarkDotPlot', results.map(function (r) { return r.ndcgAt10; }));

      btBody.innerHTML = results.map(function (r) {
        var topPaths = (r.retrievedPaths || []).slice(0, 5).map(function (p) {
          var short = p.path.split('/').pop() || p.path;
          return '<div class="mono" style="font-size:var(--fs-xs);color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(p.path) + ' (' + p.score + ')">' + esc(short) + '</div>';
        }).join('');
        return '<tr>'
          + '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(r.query) + (r.description ? ' — ' + escAttr(r.description) : '') + '">' + esc(r.query) + '</td>'
          + '<td class="num">' + r.retrievedCount + (r.expectedCount ? '/' + r.expectedCount : '') + '</td>'
          + '<td class="num" style="color:' + gaugeColor(r.precisionAt5) + '">' + gaugeVal(r.precisionAt5) + '</td>'
          + '<td class="num" style="color:' + gaugeColor(r.precisionAt10) + '">' + gaugeVal(r.precisionAt10) + '</td>'
          + '<td class="num" style="color:' + gaugeColor(r.ndcgAt10) + '">' + gaugeVal(r.ndcgAt10) + '</td>'
          + '<td class="num ' + latClass(r.latencyMs) + '">' + fmtMs(r.latencyMs) + '</td>'
          + '<td style="max-width:200px">' + topPaths + '</td>'
          + '</tr>';
      }).join('');
      if (!hasGroundTruth) {
        btTs.innerHTML += ' · <span style="color:var(--text-dim)">No ground truth set — save current results as baseline, then re-run to compare.</span>';
      }
    }
  },
};

// ── local helpers ─────────────────────────────────────────────────────────────

function stackedSeg(cls, n, total, hideLabel) {
  if (!n) return '';
  var pct = (n / total * 100).toFixed(1);
  return '<div class="seg ' + cls + '" style="width:' + pct + '%">' + (hideLabel ? (n || '') : n) + '</div>';
}

function ratioChip(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

/** Shannon-evenness balance index over the hot/warm/cold split → 0..1. */
function computeTempBalance(t) {
  var h = (t && t.hot) || 0, w = (t && t.warm) || 0, c = (t && t.cold) || 0;
  var total = h + w + c;
  if (total <= 0) return 0;
  var entropy = 0;
  [h, w, c].forEach(function (v) {
    if (v > 0) { var p = v / total; entropy -= p * Math.log(p); }
  });
  return entropy / Math.log(3); // normalise by max entropy of 3 buckets
}

function percentile(values, q) {
  if (!values.length) return 0;
  var s = values.slice().sort(function (a, b) { return a - b; });
  var idx = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[idx];
}

function areaLayer(pts, baseline, color) {
  var line = pts.join(' ');
  return '<polygon points="' + line + baseline + '" fill="' + color + '" opacity="0.18"/>'
    + '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.4" vector-effect="non-scaling-stroke"/>';
}

/** Shared category/collection horizontal-bar renderer (top-N, the rest folded into "other"). */
function renderCatBars(ctx, elId, dict, emptyMsg) {
  var esc = ctx.esc;
  var entries = [];
  for (var k in dict) { if (Object.prototype.hasOwnProperty.call(dict, k)) entries.push([k, dict[k]]); }
  entries.sort(function (a, b) { return b[1] - a[1]; });
  var elx = ctx.$(elId);
  if (!elx) return;
  if (!entries.length) { elx.innerHTML = '<div class="empty-msg">' + emptyMsg + '</div>'; return; }

  var TOP = 8;
  if (entries.length > TOP) {
    var other = 0;
    for (var oi = TOP; oi < entries.length; oi++) other += entries[oi][1];
    entries = entries.slice(0, TOP);
    if (other > 0) entries.push(['other', other]);
  }
  var max = entries[0][1] || 1;
  // Single spectral hue for the leader, semantic info-tint for the rest — keeps
  // the palette instrument-like rather than a rainbow.
  elx.innerHTML = entries.map(function (e, i) {
    var pct = (e[1] / max * 100).toFixed(0);
    var color = i === 0 ? 'var(--brand)' : 'var(--info)';
    return '<div class="cat-row">'
      + '<span class="cat-label" title="' + ctx.escAttr(String(e[0])) + '">' + esc(String(e[0])) + '</span>'
      + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + '">' + (parseInt(pct, 10) > 12 ? e[1] : '') + '</div></div>'
      + '<span class="cat-count">' + e[1] + '</span>'
      + '</div>';
  }).join('');
}

/** Per-query NDCG dot-plot: dots along x, colored by graded threshold. */
function drawDotPlot(ctx, svgId, values) {
  var svg = ctx.$(svgId);
  if (!svg) return;
  var vals = (values || []).filter(function (v) { return typeof v === 'number' && v >= 0; });
  if (!vals.length) { svg.innerHTML = ''; return; }
  var w = 600, h = 140, pad = 12;
  var n = vals.length;
  var grid = '<line x1="0" y1="' + (h * 0.5) + '" x2="' + w + '" y2="' + (h * 0.5) + '" stroke="rgba(255,255,255,.05)"/>'
    + '<line x1="0" y1="' + (h - pad) + '" x2="' + w + '" y2="' + (h - pad) + '" stroke="var(--line-faint)" vector-effect="non-scaling-stroke"/>';
  var col = function (v) { return v >= 0.7 ? 'var(--ok)' : v >= 0.4 ? 'var(--warn)' : 'var(--err)'; };
  var dots = vals.map(function (v, i) {
    var x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
    var y = (h - pad) - v * (h - 2 * pad);
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' + col(v) + '" opacity="0.9"/>';
  }).join('');
  svg.innerHTML = grid + dots;
}
