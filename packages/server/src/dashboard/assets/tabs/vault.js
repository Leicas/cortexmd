// vault.js — Vault & Memory tab client module (ES module, no build).
// Migrated verbatim from the legacy `renderVault` + source-vault CRUD
// (loadSourceVaults / addSourceVault / removeSourceVault) + `runMigrationAction`.
// Reads payload data only from ctx.data. Source-vault listing + migration are
// extra fetches/actions wired in init() and exposed via window.cortex so the
// server-rendered onclick handlers reach them. See ARCHITECTURE.md §3/§4.
//
// NOTE: real .js files use single-backslash unicode escapes (—, ✓), unlike the
// legacy template literal which doubled them.

/** @typedef {import('../core.js').Ctx} Ctx */

export default {
  id: 'vault',

  /** One-time: register cortex.* actions, then load the source-vault table
   *  (mirrors the legacy switchTab('vault') → loadSourceVaults() behavior). */
  init(el, ctx) {
    var esc = ctx.esc, escAttr = ctx.escAttr, fmt = ctx.fmt, toast = ctx.toast;

    // ── Read-only source vaults (Component C) ──
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
              ? esc(v.includeGlobs.join(', '))
              : '<span style="color:var(--text-dim)">all</span>';
            var badge = v.source === 'env'
              ? '<span class="badge badge--warn">env</span>'
              : '<span class="badge badge--ok">persisted</span>';
            var indexed = (v.indexedDocs != null) ? fmt.fmt(v.indexedDocs) : '—';
            var statusColor = v.status === 'ok' ? 'var(--green)'
              : (v.status === 'degraded' ? 'var(--red)' : 'var(--text-dim)');
            var action = v.source === 'env'
              ? '<span style="color:var(--text-dim);font-size:.7rem">immutable</span>'
              : '<button class="btn btn-danger" onclick="cortex.removeSourceVault(\'' + escAttr(v.name) + '\')">Remove</button>';
            return '<tr>'
              + '<td>' + esc(v.name) + '</td>'
              + '<td title="' + escAttr(v.path) + '">' + esc(v.path) + '</td>'
              + '<td>' + globs + '</td>'
              + '<td>' + badge + '</td>'
              + '<td>' + indexed + '</td>'
              + '<td style="color:' + statusColor + '">' + esc(v.status || '') + '</td>'
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
        fb.style.color = 'var(--red)';
        fb.textContent = 'Folder path is required.';
        return;
      }
      var includeGlobs = globsRaw.split(/[,\n]/).map(function (g) { return g.trim(); }).filter(Boolean);
      var payload = { path: path };
      if (name) payload.name = name;
      if (includeGlobs.length) payload.includeGlobs = includeGlobs;
      btn.disabled = true;
      fb.style.color = 'var(--text-dim)';
      fb.textContent = 'Adding...';
      fetch('/dashboard/api/source-vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (res.ok) {
            fb.style.color = 'var(--green)';
            fb.textContent = 'Added "' + (res.d.name || name || path) + '". Reindexing...';
            ctx.$('svPath').value = '';
            ctx.$('svName').value = '';
            ctx.$('svGlobs').value = '';
            loadSourceVaults();
          } else {
            fb.style.color = 'var(--red)';
            fb.textContent = (res.d && res.d.error) || 'Failed to add vault.';
          }
        })
        .catch(function (e) {
          btn.disabled = false;
          fb.style.color = 'var(--red)';
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
            fb.style.color = 'var(--green)';
            fb.textContent = 'Removed "' + name + '". Reindexing...';
            loadSourceVaults();
          } else {
            fb.style.color = 'var(--red)';
            fb.textContent = (res.d && res.d.error) || 'Failed to remove vault.';
          }
        })
        .catch(function (e) {
          fb.style.color = 'var(--red)';
          fb.textContent = 'Request failed: ' + e.message;
        });
    }

    // ── Vault migration ──
    function runMigrationAction(dryRun) {
      var url = dryRun ? '/dashboard/api/migrate/dry-run' : '/dashboard/api/migrate/run';
      var resultEl = ctx.$('migrationResult');
      if (!dryRun && !confirm('This will move files in the vault. Originals are backed up as .migrated.md. Proceed?')) return;
      resultEl.innerHTML = '<span style="color:var(--text-dim)">Running ' + (dryRun ? 'dry run' : 'migration') + '...</span>';
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok && d.error) { resultEl.innerHTML = '<span style="color:var(--red)">' + d.error + '</span>'; return; }
          var prefix = d.dryRun ? '<strong style="color:var(--blue)">[DRY RUN]</strong> ' : '<strong style="color:var(--green)">[DONE]</strong> ';
          var lines = [
            prefix + 'Migration ' + d.status,
            'Memories moved: <strong>' + d.memoriesMoved + '</strong>',
            'Insights merged: <strong>' + d.insightsMerged + '</strong>',
            'Journal entries split: <strong>' + d.journalEntriesSplit + '</strong>',
            'Diary files split: <strong>' + d.diaryFilesSplit + '</strong>',
          ];
          if (d.errors && d.errors.length > 0) {
            lines.push('<span style="color:var(--red)">Errors (' + d.errors.length + '):</span>');
            d.errors.forEach(function (e) { lines.push('&nbsp;&nbsp;' + e); });
          }
          resultEl.innerHTML = lines.join('<br>');
          if (!d.dryRun && d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit > 0) {
            toast('Migration complete: ' + (d.memoriesMoved + d.journalEntriesSplit + d.diaryFilesSplit) + ' items moved', 'success');
          }
        })
        .catch(function (e) { resultEl.innerHTML = '<span style="color:var(--red)">Request failed: ' + e.message + '</span>'; });
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
    var fmt = ctx.fmt, esc = ctx.esc, escAttr = ctx.escAttr, $ = ctx.$;
    var fmtMs = fmt.fmtMs, fmtTime = fmt.fmtTime, fmtAgo = fmt.fmtAgo, fmtDate = fmt.fmtDate, latClass = fmt.latClass;
    var fmtN = fmt.fmt;
    var data = ctx.data;

    $('vaultNotes').textContent = fmtN(data.indexedNotes);
    var rb = data.lastIndexRebuild;
    $('vaultRebuild').textContent = rb ? 'Last rebuilt ' + fmtAgo(rb) : 'Never rebuilt';

    // Index health diagnostics
    var ih = data.indexHealth || [];
    var ihEl = $('indexHealthInfo');
    if (ih.length) {
      ihEl.innerHTML = ih.map(function (v) {
        var parts = ['<strong>' + esc(v.vault.split('/').pop() || v.vault) + '</strong>: ' + v.indexed + '/' + v.fileCount + ' indexed'];
        if (v.enoent > 0) {
          parts.push('<span style="color:var(--yellow)">' + v.enoent + ' missing (ENOENT)</span>');
          if (v.enoentSamples && v.enoentSamples.length) {
            parts.push('<span style="color:var(--text-dim);font-size:.65rem"> e.g. ' + v.enoentSamples.slice(0, 3).map(function (s) { return esc(s.split('/').pop() || s); }).join(', ') + '</span>');
          }
        }
        if (v.permissionErrors > 0) {
          parts.push('<span style="color:var(--red)">' + v.permissionErrors + ' permission denied (EACCES/EPERM)</span>');
          if (v.permissionSamples && v.permissionSamples.length) {
            parts.push('<span style="color:var(--text-dim);font-size:.65rem"> e.g. ' + v.permissionSamples.slice(0, 3).map(function (s) { return esc(s.split('/').pop() || s); }).join(', ') + '</span>');
          }
        }
        if (v.otherErrors > 0) {
          parts.push('<span style="color:var(--red)">' + v.otherErrors + ' other errors</span>');
        }
        if (v.enoent === 0 && v.permissionErrors === 0 && v.otherErrors === 0) {
          parts.push('<span style="color:var(--green)">✓ clean</span>');
        }
        return '<div style="margin-bottom:.25rem">' + parts.join(' · ') + '</div>';
      }).join('');
    } else {
      ihEl.innerHTML = '';
    }

    // Memory temperature from real docMeta counts
    var mt = data.memoryTemperature || { hot: 0, warm: 0, cold: 0 };
    $('memHot').textContent = 'Hot: ' + fmtN(mt.hot);
    $('memWarm').textContent = 'Warm: ' + fmtN(mt.warm);
    $('memCold').textContent = 'Cold: ' + fmtN(mt.cold);

    // Stacked bar
    var total = mt.hot + mt.warm + mt.cold;
    var bar = $('memBar');
    if (total > 0) {
      var hPct = ((mt.hot / total) * 100).toFixed(1);
      var wPct = ((mt.warm / total) * 100).toFixed(1);
      var cPct = ((mt.cold / total) * 100).toFixed(1);
      bar.innerHTML = '<div class="seg seg-hot" style="width:' + hPct + '%">' + mt.hot + '</div>'
        + '<div class="seg seg-warm" style="width:' + wPct + '%">' + mt.warm + '</div>'
        + '<div class="seg seg-cold" style="width:' + cPct + '%">' + mt.cold + '</div>';
    } else {
      bar.innerHTML = '';
    }

    // ── Temperature time-series (stacked area chart) ──
    var th = data.temperatureHistory || [];
    if (th.length >= 2) {
      var svg = $('chartTempHistory');
      var w = 600, h = 160, pad = 4;
      var maxVal = 1;
      for (var i = 0; i < th.length; i++) {
        var sSum = th[i].hot + th[i].warm + th[i].cold;
        if (sSum > maxVal) maxVal = sSum;
      }
      var step = w / (th.length - 1);
      var yPos = function (v) { return h - pad - (v / maxVal) * (h - 2 * pad); };

      // Build stacked areas: cold on bottom, warm in middle, hot on top
      var coldPts = [], warmPts = [], hotPts = [];
      for (var j = 0; j < th.length; j++) {
        var x = (j * step).toFixed(1);
        var yCold = yPos(th[j].cold);
        var yWarm = yPos(th[j].cold + th[j].warm);
        var yHot = yPos(th[j].cold + th[j].warm + th[j].hot);
        coldPts.push(x + ',' + yCold.toFixed(1));
        warmPts.push(x + ',' + yWarm.toFixed(1));
        hotPts.push(x + ',' + yHot.toFixed(1));
      }
      var baseline = ' ' + ((th.length - 1) * step).toFixed(1) + ',' + h + ' 0,' + h;

      svg.innerHTML =
        '<polygon points="' + coldPts.join(' ') + baseline + '" fill="#58a6ff" opacity="0.2"/>'
        + '<polyline points="' + coldPts.join(' ') + '" fill="none" stroke="#58a6ff" stroke-width="1.2"/>'
        + '<polygon points="' + warmPts.join(' ') + baseline + '" fill="#d29922" opacity="0.2"/>'
        + '<polyline points="' + warmPts.join(' ') + '" fill="none" stroke="#d29922" stroke-width="1.2"/>'
        + '<polygon points="' + hotPts.join(' ') + baseline + '" fill="#f85149" opacity="0.2"/>'
        + '<polyline points="' + hotPts.join(' ') + '" fill="none" stroke="#f85149" stroke-width="1.2"/>';
    }

    // ── Heat score histogram ──
    var hist = data.heatHistogram || [0, 0, 0, 0];
    var histMax = Math.max.apply(null, hist.concat([1]));
    var histColors = ['#58a6ff', '#3fb950', '#d29922', '#f85149'];
    var histEl = $('heatHistogram');
    histEl.innerHTML = hist.map(function (count, i) {
      var pct = (count / histMax * 100).toFixed(0);
      return '<div class="hist-bar" style="height:' + Math.max(pct, 4) + '%;background:' + histColors[i] + '">' + (count || '') + '</div>';
    }).join('');

    // ── Embedding stats ──
    var embStats = data.embeddingStats || {};
    var embBadge = $('embeddingBadge');
    if (embStats.ready) {
      embBadge.textContent = 'Active';
      embBadge.style.background = 'rgba(63,185,80,.15)';
      embBadge.style.color = 'var(--green)';
    } else {
      embBadge.textContent = 'Disabled';
      embBadge.style.background = 'rgba(248,81,73,.15)';
      embBadge.style.color = 'var(--red)';
    }
    $('embModel').textContent = embStats.model || '—';
    $('embVectors').textContent = fmtN(embStats.indexSize);
    $('embAvgTime').textContent = embStats.avgEmbedTimeMs ? embStats.avgEmbedTimeMs + ' ms' : '—';

    // ── Top 10 hottest notes ──
    var topNotes = data.topNotes || [];
    var tnBody = $('topNotesBody');
    if (!topNotes.length) {
      tnBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No notes indexed</td></tr>';
    } else {
      tnBody.innerHTML = topNotes.map(function (n) {
        var tempBadge = '<span class="badge badge-' + (n.temperature || 'warm') + '">' + esc(n.temperature || '?') + '</span>';
        return '<tr>'
          + '<td title="' + esc(n.path) + '" style="cursor:help;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.title) + '</td>'
          + '<td class="' + latClass(16 - (n.heat_score || 0)) + '">' + fmtN(n.heat_score) + '</td>'
          + '<td>' + tempBadge + '</td>'
          + '<td>' + esc(n.category || '—') + '</td>'
          + '<td>' + esc(n.last_accessed || '—') + '</td>'
          + '</tr>';
      }).join('');
    }

    // ── Memory categories breakdown ──
    var cats = data.categoryBreakdown || {};
    var catEntries = [];
    for (var k in cats) { if (Object.prototype.hasOwnProperty.call(cats, k)) catEntries.push([k, cats[k]]); }
    catEntries.sort(function (a, b) { return b[1] - a[1]; });
    var catMax = catEntries.length > 0 ? catEntries[0][1] : 1;
    var catColors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#79c0ff', '#56d364', '#e3b341', '#ff7b72'];
    var catEl = $('categoryBars');
    if (!catEntries.length) {
      catEl.innerHTML = '<div class="empty-msg">No categories found</div>';
    } else {
      catEl.innerHTML = catEntries.map(function (e, i) {
        var pct = (e[1] / catMax * 100).toFixed(0);
        var color = catColors[i % catColors.length];
        return '<div class="cat-row">'
          + '<span class="cat-label">' + esc(e[0]) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + '">' + e[1] + '</div></div>'
          + '<span class="cat-count">' + e[1] + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Search quality indicators ──
    var sq = data.searchStats || {};
    $('sqTotal').textContent = fmtN(sq.totalSearches);
    $('sqAvgResults').textContent = fmtN(sq.avgResultCount);
    $('sqAvgLatency').textContent = sq.avgLatencyMs ? sq.avgLatencyMs + ' ms' : '—';
    var zeroRate = sq.totalSearches > 0 ? ((sq.zeroResultCount / sq.totalSearches) * 100).toFixed(1) : '0';
    var zrEl = $('sqZeroRate');
    zrEl.textContent = zeroRate + '%';
    zrEl.style.color = parseFloat(zeroRate) > 20 ? 'var(--red)' : parseFloat(zeroRate) > 10 ? 'var(--yellow)' : 'var(--green)';

    // ── Recent searches feed ──
    var rs = data.recentSearches || [];
    var rsEl = $('recentSearchesFeed');
    if (!rs.length) {
      rsEl.innerHTML = '<div class="empty-msg">No searches recorded.</div>';
    } else {
      rsEl.innerHTML = rs.slice().reverse().map(function (s) {
        return '<div class="search-item">'
          + '<span class="s-ts">' + fmtTime(s.timestamp) + '</span>'
          + '<span class="s-query" title="' + esc(s.query) + '">' + esc(s.query) + '</span>'
          + '<span class="s-count">' + s.resultCount + ' hits</span>'
          + '<span class="s-lat">' + s.latencyMs + ' ms</span>'
          + '</div>';
      }).join('');
    }

    // ── Vault Health ──
    var vh = data.vaultHealth;
    if (vh) {
      $('vhTotal').textContent = fmtN(vh.totalFiles);
      $('vhArchived').textContent = fmtN(vh.archivedNotes);
      var vhStaleEl = $('vhStale');
      vhStaleEl.textContent = fmtN(vh.staleNotes);
      vhStaleEl.style.color = vh.staleNotes > 10 ? 'var(--yellow)' : 'var(--green)';
      var ftEntries = [];
      for (var ftk in vh.fileCountByType) { if (Object.prototype.hasOwnProperty.call(vh.fileCountByType, ftk)) ftEntries.push(ftk + ':' + vh.fileCountByType[ftk]); }
      $('vhFileTypes').textContent = ftEntries.join(' · ') || '—';
    }

    // ── Link Density ──
    var ld = data.linkDensity;
    if (ld) {
      $('ldTotal').textContent = fmtN(ld.totalLinks);
      $('ldAvg').textContent = ld.avgLinksPerNote.toFixed(1);
      var ldOrpEl = $('ldOrphans');
      ldOrpEl.textContent = fmtN(ld.orphanNotes);
      ldOrpEl.style.color = ld.orphanNotes > 20 ? 'var(--red)' : ld.orphanNotes > 5 ? 'var(--yellow)' : 'var(--green)';
      var mlEl = $('ldMostLinked');
      if (ld.mostLinked && ld.mostLinked.length) {
        mlEl.innerHTML = ld.mostLinked.slice(0, 5).map(function (m) {
          var short = m.path.split('/').pop() || m.path;
          return '<div title="' + esc(m.path) + '">' + esc(short) + ' <span style="color:var(--blue)">' + m.inbound + '</span></div>';
        }).join('');
      } else {
        mlEl.textContent = '—';
      }
    }

    // ── Search Analytics ──
    var sa = data.searchTypeStats || {};
    $('saLexOnly').textContent = fmtN(sa.lexicalOnlyHits);
    $('saSemOnly').textContent = fmtN(sa.semanticOnlyHits);
    $('saBoth').textContent = fmtN(sa.bothHits);

    var avgLex = sa.avgLexicalContribution || 0;
    var avgSem = sa.avgSemanticContribution || 0;
    var saBar = $('saContribBar');
    if (avgLex + avgSem > 0) {
      var lexPctSa = (avgLex / (avgLex + avgSem) * 100).toFixed(0);
      var semPctSa = (100 - parseFloat(lexPctSa)).toFixed(0);
      saBar.innerHTML = '<div class="seg" style="width:' + lexPctSa + '%;background:var(--blue)">' + lexPctSa + '%</div>'
        + '<div class="seg" style="width:' + semPctSa + '%;background:var(--green)">' + semPctSa + '%</div>';
    } else {
      saBar.innerHTML = '<div class="seg" style="width:100%;background:var(--border);color:var(--text-dim)">No data</div>';
    }

    // ── Memory Lifecycle ──
    var ml = data.memoryLifecycle || {};
    $('mlArchived').textContent = fmtN(ml.totalArchived);
    $('mlConsolidated').textContent = fmtN(ml.totalConsolidated);

    var td = ml.temperatureDistribution || { hot: 0, warm: 0, cold: 0, unset: 0 };
    var tdTotal = td.hot + td.warm + td.cold + td.unset;
    var mlBar = $('mlTempBar');
    if (tdTotal > 0) {
      var tdHotPct = (td.hot / tdTotal * 100).toFixed(1);
      var tdWarmPct = (td.warm / tdTotal * 100).toFixed(1);
      var tdColdPct = (td.cold / tdTotal * 100).toFixed(1);
      var tdUnsetPct = (td.unset / tdTotal * 100).toFixed(1);
      mlBar.innerHTML = '<div class="seg seg-hot" style="width:' + tdHotPct + '%">' + (td.hot || '') + '</div>'
        + '<div class="seg seg-warm" style="width:' + tdWarmPct + '%">' + (td.warm || '') + '</div>'
        + '<div class="seg seg-cold" style="width:' + tdColdPct + '%">' + (td.cold || '') + '</div>'
        + '<div class="seg" style="width:' + tdUnsetPct + '%;background:var(--border);color:var(--text-dim)">' + (td.unset || '') + '</div>';
    } else {
      mlBar.innerHTML = '';
    }

    var mlOpsEl = $('mlRecentOps');
    var recentArchives = ml.recentArchives || [];
    var recentConsols = ml.recentConsolidations || [];
    var allLifecycleOps = [];
    for (var ai = 0; ai < recentArchives.length; ai++) {
      allLifecycleOps.push({ ts: recentArchives[ai].timestamp, text: 'Archived ' + esc((recentArchives[ai].path || '').split('/').pop() || recentArchives[ai].path), type: 'archive' });
    }
    for (var cci = 0; cci < recentConsols.length; cci++) {
      allLifecycleOps.push({ ts: recentConsols[cci].timestamp, text: 'Consolidated ' + recentConsols[cci].count + ' notes', type: 'consolidate' });
    }
    allLifecycleOps.sort(function (a, b) { return b.ts - a.ts; });
    if (!allLifecycleOps.length) {
      mlOpsEl.innerHTML = '<div class="empty-msg">No recent lifecycle events.</div>';
    } else {
      mlOpsEl.innerHTML = allLifecycleOps.slice(0, 10).map(function (op) {
        var color = op.type === 'archive' ? 'var(--yellow)' : 'var(--green)';
        return '<div style="padding:.2rem 0;border-bottom:1px solid var(--border);display:flex;gap:.5rem">'
          + '<span style="color:var(--text-dim);font-family:var(--mono);width:60px;flex-shrink:0">' + fmtTime(op.ts) + '</span>'
          + '<span style="color:' + color + '">' + op.text + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Recent memory operations ──
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
          + (c.detail ? '<span style="width:100%;font-size:.72rem;color:var(--text-dim);margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(c.detail) + '">' + esc(c.detail) + '</span>' : '')
          + '</div>';
      }).join('');
    }

    // ── Recent notes accessed ──
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
            + '<span style="flex:1;color:var(--text);font-size:.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(c.detail || '') + '">' + esc(c.detail || c.tool) + '</span>'
            + '<span class="feed-dur">' + fmtMs(c.durationMs) + '</span>'
            + '</div>';
        }).join('');
      }
    }

    // ── Collection distribution ──
    var colDist = data.collectionDistribution || {};
    var colEntries = [];
    for (var ck in colDist) { if (Object.prototype.hasOwnProperty.call(colDist, ck)) colEntries.push([ck, colDist[ck]]); }
    colEntries.sort(function (a, b) { return b[1] - a[1]; });
    var colMax = colEntries.length > 0 ? colEntries[0][1] : 1;
    var colColors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#79c0ff'];
    var colEl = $('collectionBars');
    if (!colEntries.length) {
      colEl.innerHTML = '<div class="empty-msg">No collection data</div>';
    } else {
      colEl.innerHTML = colEntries.map(function (e, i) {
        var pct = (e[1] / colMax * 100).toFixed(0);
        var color = colColors[i % colColors.length];
        return '<div class="cat-row">'
          + '<span class="cat-label">' + esc(e[0]) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:' + color + '">' + e[1] + '</div></div>'
          + '<span class="cat-count">' + e[1] + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Score breakdown (recent searches) ──
    var ssb = data.searchScoreBreakdowns || [];
    var sbEl = $('scoreBreakdowns');
    if (!ssb.length) {
      sbEl.innerHTML = '<div class="empty-msg">No searches with score data.</div>';
    } else {
      sbEl.innerHTML = ssb.slice().reverse().map(function (s) {
        var rows = s.results.map(function (r) {
          var rTotal = r.lexical + r.semantic;
          if (rTotal === 0) rTotal = 1;
          var lexPct = (r.lexical / rTotal * 100).toFixed(0);
          var semPct = (r.semantic / rTotal * 100).toFixed(0);
          var pathShort = r.path.split('/').pop() || r.path;
          return '<div class="score-row">'
            + '<span class="sr-path" title="' + esc(r.path) + '">' + esc(pathShort) + '</span>'
            + '<div class="sr-bar-wrap"><div class="sr-bar">'
            + '<div class="sr-seg lex" style="width:' + lexPct + '%" title="Lexical: ' + r.lexical.toFixed(4) + '">' + (parseInt(lexPct, 10) > 15 ? lexPct + '%' : '') + '</div>'
            + '<div class="sr-seg sem" style="width:' + semPct + '%" title="Semantic: ' + r.semantic.toFixed(4) + '">' + (parseInt(semPct, 10) > 15 ? semPct + '%' : '') + '</div>'
            + '</div></div>'
            + '</div>';
        }).join('');
        return '<div style="margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)">'
          + '<div style="font-size:.75rem;margin-bottom:.3rem"><span style="color:var(--blue)">' + esc(s.query) + '</span> <span style="color:var(--text-dim)">' + fmtTime(s.timestamp) + '</span></div>'
          + rows
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
    if (l0 && l0.content) {
      msIdEl.textContent = l0.content;
    } else {
      msIdEl.innerHTML = '<span class="empty-msg">No identity loaded yet.</span>';
    }
    var msNarrEl = $('msNarrative');
    if (l1 && l1.content) {
      msNarrEl.textContent = l1.content;
    } else {
      msNarrEl.innerHTML = '<span class="empty-msg">No narrative loaded yet.</span>';
    }
    var msTotalTokens = 0;
    for (var ti = 0; ti < ms.length; ti++) msTotalTokens += (ms[ti].tokens || 0);
    $('msTokenCount').textContent = fmtN(msTotalTokens);

    // ── Search Quality Benchmarks summary ──
    var sqBench = data.benchmarkSummary;
    if (sqBench) {
      var sqbR5El = $('sqbRecall5');
      var sqbNdcgEl = $('sqbNdcg10');
      var sqbLatEl = $('sqbAvgLat');
      var sqbRunEl = $('sqbLastRun');
      var r5Val = sqBench.avgRecallAt5;
      var ndcgVal = sqBench.avgNdcgAt10;
      var avgLatVal = sqBench.totalQueries > 0 ? Math.round(sqBench.totalLatencyMs / sqBench.totalQueries) : 0;
      var sqbColor = function (v) { if (v < 0) return 'var(--text-dim)'; if (v >= 0.7) return 'var(--green)'; if (v >= 0.4) return 'var(--yellow)'; return 'var(--red)'; };
      sqbR5El.textContent = r5Val >= 0 ? (r5Val * 100).toFixed(0) + '%' : '—';
      sqbR5El.style.color = sqbColor(r5Val);
      sqbNdcgEl.textContent = ndcgVal >= 0 ? (ndcgVal * 100).toFixed(0) + '%' : '—';
      sqbNdcgEl.style.color = sqbColor(ndcgVal);
      sqbLatEl.textContent = avgLatVal + ' ms';
      sqbLatEl.style.color = avgLatVal < 100 ? 'var(--green)' : avgLatVal < 500 ? 'var(--yellow)' : 'var(--red)';
      sqbRunEl.textContent = fmtAgo(sqBench.timestamp);
    }

    // ── Retrieval benchmark ──
    var bench = data.benchmarkSummary;
    var bgEl = $('benchmarkGauges');
    var btBody = $('benchmarkTableBody');
    var btTs = $('benchmarkTimestamp');
    var btnSave = $('btnSaveGroundTruth');
    if (!bench) {
      bgEl.innerHTML = '';
      btBody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="text-align:center">No benchmark run yet. Click "Run Benchmark" to start.</td></tr>';
      if (btnSave) btnSave.style.display = 'none';
    } else {
      if (btnSave) btnSave.style.display = '';
      btTs.textContent = 'Last run: ' + fmtDate(bench.timestamp) + ' · ' + bench.totalQueries + ' queries · ' + bench.totalLatencyMs + ' ms total';

      var gaugeClass = function (v) { if (v < 0) return 'bg-na'; if (v >= 0.7) return 'bg-good'; if (v >= 0.4) return 'bg-mid'; return 'bg-low'; };
      var gaugeVal = function (v) { return v < 0 ? 'N/A' : (v * 100).toFixed(0) + '%'; };

      // Show avg latency and avg results as the first two gauges when no ground truth
      var hasGroundTruth = bench.avgPrecisionAt5 >= 0;

      var gauges = [
        ['P@5', bench.avgPrecisionAt5],
        ['P@10', bench.avgPrecisionAt10],
        ['R@5', bench.avgRecallAt5],
        ['R@10', bench.avgRecallAt10],
        ['NDCG@10', bench.avgNdcgAt10],
      ];
      bgEl.innerHTML = gauges.map(function (g) {
        return '<div class="bench-gauge">'
          + '<div class="bg-label">' + g[0] + '</div>'
          + '<div class="bg-value ' + gaugeClass(g[1]) + '">' + gaugeVal(g[1]) + '</div>'
          + '</div>';
      }).join('');
      if (!hasGroundTruth) {
        bgEl.innerHTML += '<div style="grid-column:1/-1;font-size:.72rem;color:var(--text-dim);text-align:center;padding:.25rem">No ground truth set. Click "Save as Ground Truth" to use current results as baseline, then re-run to compare.</div>';
      }

      btBody.innerHTML = bench.results.map(function (r) {
        var topPaths = (r.retrievedPaths || []).slice(0, 5).map(function (p) {
          var short = p.path.split('/').pop() || p.path;
          return '<div style="font-size:.65rem;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.path) + ' (' + p.score + ')">' + esc(short) + '</div>';
        }).join('');
        return '<tr>'
          + '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(r.query) + (r.description ? ' — ' + esc(r.description) : '') + '">' + esc(r.query) + '</td>'
          + '<td>' + r.retrievedCount + (r.expectedCount ? '/' + r.expectedCount : '') + '</td>'
          + '<td class="' + gaugeClass(r.precisionAt5) + '">' + gaugeVal(r.precisionAt5) + '</td>'
          + '<td class="' + gaugeClass(r.precisionAt10) + '">' + gaugeVal(r.precisionAt10) + '</td>'
          + '<td class="' + gaugeClass(r.ndcgAt10) + '">' + gaugeVal(r.ndcgAt10) + '</td>'
          + '<td class="' + latClass(r.latencyMs) + '">' + fmtMs(r.latencyMs) + '</td>'
          + '<td style="max-width:200px">' + topPaths + '</td>'
          + '</tr>';
      }).join('');
    }
  },
};
