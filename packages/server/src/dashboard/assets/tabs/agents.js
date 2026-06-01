// agents.js — Agents tab client module (ES module, no build).
//
// Revamped to the design system (REVAMP.md §5 TAB 6). Behavior preserved:
// agents/teams/skills are fetched ONCE via /dashboard/api/{agents,teams,skills}
// (guarded by `agentsLoaded`); the diary agent dropdown is sourced from the SSE
// payload (`ctx.data.agentDiaries`) and entries load on demand from
// /dashboard/api/agent-diary/:name. See ARCHITECTURE.md §3/§4.
//
// NEW (visual/IA only, no data change): the activity-summary strip + "most
// active agents" ranking + so-what are derived CLIENT-SIDE from
// `ctx.data.agentDiaries` (the only agents data in the SSE payload) joined with
// the fetched roster — model/derive.ts is a shared file and is not extended.

/** @typedef {import('../core.js').Ctx} Ctx */

// Module-cached agent data (fetched once; never re-fetched per SSE tick).
var agentsData = { agents: [], teams: [], skills: [] };
var agentsLoaded = false;

var DAY_MS = 86400000;

export default {
  id: 'agents',

  /** One-time: kick the one-shot fetch + wire diary select listeners. */
  init(el, ctx) {
    fetchAgentsData(el, ctx);

    var sel = el.querySelector('#diaryAgentSelect');
    var limitSel = el.querySelector('#diaryLimitSelect');
    var load = function () { loadDiary(el, ctx); };
    if (sel && !sel.dataset.listener) {
      sel.addEventListener('change', load);
      sel.dataset.listener = '1';
    }
    if (limitSel && !limitSel.dataset.listener) {
      limitSel.addEventListener('change', load);
      limitSel.dataset.listener = '1';
    }
  },

  /** Idempotent: activity strip (every tick) + rosters (once loaded) + dropdown. */
  refresh(el, ctx) {
    // The activity strip reads agentDiaries from the SSE payload, so refresh it
    // every tick regardless of roster-fetch state.
    renderActivity(el, ctx);
    renderDiaryDropdown(el, ctx);
    if (!agentsLoaded) { fetchAgentsData(el, ctx); return; }
    renderRosters(el, ctx);
  },
};

function fetchAgentsData(el, ctx) {
  Promise.all([
    ctx.fetchJson('/dashboard/api/agents'),
    ctx.fetchJson('/dashboard/api/teams'),
    ctx.fetchJson('/dashboard/api/skills'),
  ]).then(function (res) {
    agentsData.agents = res[0].agents || [];
    agentsData.teams = res[1].teams || [];
    agentsData.skills = res[2].skills || [];
    agentsLoaded = true;
    renderRosters(el, ctx);
    renderActivity(el, ctx);
  }).catch(function () {
    // Roster fetch failed — surface an error row instead of an endless skeleton.
    ['agentsTableBody', 'teamsTableBody', 'skillsTableBody'].forEach(function (id, i) {
      var body = el.querySelector('#' + id);
      var cols = i === 1 ? 5 : 6;
      if (body) body.innerHTML = '<tr><td colspan="' + cols + '" class="empty-msg" style="text-align:center">Failed to load.</td></tr>';
    });
  });
}

// ── Activity summary strip + ranking + so-what (derived client-side) ─────────

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

function tsOf(v) {
  if (!v) return 0;
  var t = typeof v === 'string' ? new Date(v).getTime() : v;
  return isFinite(t) ? t : 0;
}

function renderActivity(el, ctx) {
  var fmt = ctx.fmt, esc = ctx.esc, setLive = ctx.setLive, $ = ctx.$;
  var diaries = (ctx.data.agentDiaries || []).slice();
  var now = Date.now();

  var active24h = 0, busiest = null, dormant = 0;
  diaries.forEach(function (d) {
    var last = tsOf(d.lastActive);
    if (last && now - last < DAY_MS) active24h++;
    else if (last && now - last > 7 * DAY_MS) dormant++;
    if (!busiest || (d.entryCount || 0) > (busiest.entryCount || 0)) busiest = d;
  });

  // 1. Active agents (24h) — of those with any diary history.
  setLive('agActive24h', String(active24h));
  if ($('agActive24hSub')) {
    $('agActive24hSub').textContent = diaries.length
      ? (active24h + ' of ' + diaries.length + ' with activity')
      : 'no diary history yet';
  }
  if ($('agActivePill')) {
    if (!diaries.length) $('agActivePill').innerHTML = pillHtml('muted', 'idle');
    else if (active24h > 0) $('agActivePill').innerHTML = pillHtml('ok', 'live');
    else $('agActivePill').innerHTML = pillHtml('warn', 'quiet 24h');
  }

  // 2. Busiest agent — max entryCount.
  setLive('agBusiest', busiest && busiest.agentId ? busiest.agentId : '—');
  if ($('agBusiestSub')) {
    $('agBusiestSub').textContent = busiest
      ? (fmt.fmt(busiest.entryCount || 0) + ' entries · ' + fmt.fmtAgo(busiest.lastActive))
      : 'no activity recorded';
  }

  // 3. Never run — roster agents with no diary (set-difference). Needs roster.
  var neverRun = neverRunAgents(diaries);
  setLive('agNeverRun', agentsLoaded ? String(neverRun.length) : '—');
  if ($('agNeverRunSub')) {
    $('agNeverRunSub').textContent = !agentsLoaded
      ? 'loading roster…'
      : (dormant ? (dormant + ' dormant (>7d)') : (neverRun.length ? 'defined but no diary' : 'all agents have run'));
  }
  if ($('agNeverRunPill')) {
    if (!agentsLoaded) $('agNeverRunPill').innerHTML = pillHtml('muted', '…');
    else if (neverRun.length === 0) $('agNeverRunPill').innerHTML = pillHtml('ok', 'clean');
    else $('agNeverRunPill').innerHTML = pillHtml('warn', neverRun.length + ' to wire');
  }

  // Ranking bars — most active agents by entryCount.
  renderRanking(el, ctx, diaries);

  // So-what one-liner.
  var sw = $('agSoWhat');
  if (sw) {
    if (!diaries.length && !agentsLoaded) { sw.innerHTML = ''; }
    else {
      var parts = [];
      if (diaries.length) parts.push('<b>' + active24h + '</b> of <b>' + diaries.length + '</b> agents active in 24h');
      if (busiest && busiest.agentId) parts.push(esc(busiest.agentId) + ' busiest (<b>' + fmt.fmt(busiest.entryCount || 0) + '</b> entries)');
      if (agentsLoaded && neverRun.length) parts.push('<b>' + neverRun.length + '</b> defined but never run');
      sw.innerHTML = parts.join(' · ');
    }
  }
}

/** Roster agents (by `name`) that have no diary entry — config hygiene. */
function neverRunAgents(diaries) {
  if (!agentsLoaded) return [];
  var seen = {};
  // agentDiaries are keyed by agentId; roster agents keyed by name. Match both.
  (diaries || []).forEach(function (d) {
    if (d.agentId) seen[d.agentId] = 1;
  });
  return agentsData.agents.filter(function (a) {
    return !seen[a.name] && !seen[a.display_name];
  });
}

function renderRanking(el, ctx, diaries) {
  var box = el.querySelector('#agRankBars');
  if (!box) return;
  var esc = ctx.esc, fmt = ctx.fmt;
  if (!diaries.length) {
    box.innerHTML = '<span class="empty-msg">No agent activity recorded yet.</span>';
    return;
  }
  var ranked = diaries.slice().sort(function (a, b) {
    return (b.entryCount || 0) - (a.entryCount || 0);
  }).slice(0, 8);
  var max = Math.max(1, ranked[0].entryCount || 0);
  box.innerHTML = ranked.map(function (d) {
    var n = d.entryCount || 0;
    var pct = Math.max(2, (n / max) * 100);
    var last = tsOf(d.lastActive);
    var recent = last && Date.now() - last < DAY_MS;
    var col = recent ? 'var(--brand)' : 'var(--border-strong)';
    return '<div class="cat-row">'
      + '<span class="cat-label" title="' + ctx.escAttr(d.agentId || '') + '">' + esc(d.agentId || '') + '</span>'
      + '<span class="cat-bar-wrap"><span class="cat-bar" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></span></span>'
      + '<span class="cat-count">' + fmt.fmt(n) + '</span>'
      + '</div>';
  }).join('');
}

// ── Roster tables (reference data; ids preserved) ────────────────────────────

function renderRosters(el, ctx) {
  var esc = ctx.esc, fmt = ctx.fmt;

  var agentsBody = el.querySelector('#agentsTableBody');
  if (agentsBody) {
    if (!agentsData.agents.length) {
      agentsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No agents defined.</td></tr>';
    } else {
      agentsBody.innerHTML = agentsData.agents.map(function (a) {
        return '<tr>'
          + '<td class="mono">' + esc(a.name) + '</td>'
          + '<td>' + esc(a.display_name) + '</td>'
          + '<td>' + esc(a.role) + '</td>'
          + '<td class="mono">' + esc(a.model) + '</td>'
          + '<td>' + tagChips(ctx, a.tags) + '</td>'
          + '<td class="mono">' + esc(a.path) + '</td>'
          + '</tr>';
      }).join('');
    }
  }

  var teamsBody = el.querySelector('#teamsTableBody');
  if (teamsBody) {
    if (!agentsData.teams.length) {
      teamsBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No teams defined.</td></tr>';
    } else {
      teamsBody.innerHTML = agentsData.teams.map(function (t) {
        return '<tr>'
          + '<td class="mono">' + esc(t.name) + '</td>'
          + '<td>' + esc(t.display_name) + '</td>'
          + '<td>' + esc(t.coordination) + '</td>'
          + '<td class="num">' + fmt.fmt(t.member_count) + '</td>'
          + '<td class="mono">' + esc(t.path) + '</td>'
          + '</tr>';
      }).join('');
    }
  }

  var skillsBody = el.querySelector('#skillsTableBody');
  if (skillsBody) {
    if (!agentsData.skills.length) {
      skillsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No skills defined.</td></tr>';
    } else {
      skillsBody.innerHTML = agentsData.skills.map(function (s) {
        return '<tr>'
          + '<td class="mono">' + esc(s.name) + '</td>'
          + '<td>' + esc(s.display_name) + '</td>'
          + '<td class="mono">' + esc(s.trigger) + '</td>'
          + '<td>' + esc(s.description) + '</td>'
          + '<td>' + tagChips(ctx, s.tags) + '</td>'
          + '<td class="mono">' + esc(s.path) + '</td>'
          + '</tr>';
      }).join('');
    }
  }
}

function tagChips(ctx, tags) {
  var list = tags || [];
  if (!list.length) return '<span style="color:var(--text-faint)">—</span>';
  return list.map(function (t) {
    return '<span class="badge badge--muted">' + ctx.esc(t) + '</span>';
  }).join(' ');
}

// ── Diary dropdown (sourced from SSE payload) ────────────────────────────────

function renderDiaryDropdown(el, ctx) {
  var sel = el.querySelector('#diaryAgentSelect');
  if (!sel) return;
  var esc = ctx.esc, escAttr = ctx.escAttr;
  var diaries = ctx.data.agentDiaries || [];
  var current = sel.value;
  var opts = '<option value="">Select agent…</option>' + diaries.map(function (d) {
    return '<option value="' + escAttr(d.agentId) + '">' + esc(d.agentId) + '</option>';
  }).join('');
  if (sel.innerHTML !== opts) {
    sel.innerHTML = opts;
    if (current) sel.value = current;
  }
}

function loadDiary(el, ctx) {
  var esc = ctx.esc;
  var agent = el.querySelector('#diaryAgentSelect').value;
  var limit = el.querySelector('#diaryLimitSelect').value;
  var body = el.querySelector('#diaryBody');
  if (!body) return;
  if (!agent) {
    body.innerHTML = emptyHtml('No agent selected', 'Choose an agent to view its recent diary entries.');
    return;
  }
  body.innerHTML = '<div class="skel skel--line" aria-hidden="true"></div>'
    + '<div class="skel skel--line" aria-hidden="true"></div>'
    + '<div class="skel skel--line" aria-hidden="true"></div>';
  ctx.fetchJson('/dashboard/api/agent-diary/' + encodeURIComponent(agent) + '?limit=' + encodeURIComponent(limit))
    .then(function (d) {
      var entries = d.entries || [];
      if (!entries.length) {
        body.innerHTML = emptyHtml('No diary entries', 'This agent has not written any diary entries.');
        return;
      }
      body.innerHTML = entries.map(function (e) {
        var text = e.text || '';
        var badges = '';
        if (text.indexOf('_(silent)_') !== -1) {
          badges += '<span class="badge badge--warn" style="margin-right:.3rem">silent</span>';
          text = text.replace(/^_\(silent\)_\s*/, '');
        }
        var srcMatch = text.match(/_via\s+([^_]+)_\s*$/);
        if (srcMatch) {
          badges += '<span class="badge badge--info" style="margin-right:.3rem">via ' + esc(srcMatch[1].trim()) + '</span>';
          text = text.replace(/\s*_via\s+[^_]+_\s*$/, '');
        }
        return '<div class="feed-item">'
          + '<span class="feed-ts">' + esc(e.date) + ' ' + esc(e.time) + '</span>'
          + '<span>' + badges + esc(text.trim()) + '</span>'
          + '</div>';
      }).join('');
    })
    .catch(function () {
      body.innerHTML = '<div class="state-error" role="alert">'
        + '<svg class="state-error-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>'
        + '<div>Failed to load diary.</div></div>';
    });
}

/** Inline empty-state block (mirrors components.emptyState markup). */
function emptyHtml(title, msg) {
  return '<div class="empty">'
    + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>'
    + '<div class="empty-title">' + title + '</div>'
    + '<div class="empty-msg" style="padding:0">' + msg + '</div></div>';
}
