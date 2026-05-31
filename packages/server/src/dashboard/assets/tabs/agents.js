// agents.js — Agents tab client module (ES module, no build).
// Migrated verbatim (behavior-preserving) from the legacy `renderAgents` +
// `fetchAgentsData` + `loadDiary`. Agents/teams/skills are fetched once via
// `/dashboard/api/agents|teams|skills` (guarded by `agentsLoaded`); the diary
// agent dropdown is sourced from the SSE payload (`ctx.data.agentDiaries`) and
// entries are loaded on demand from `/dashboard/api/agent-diary/:name`.
// See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

// Module-cached agent data (fetched once; never re-fetched per SSE tick).
var agentsData = { agents: [], teams: [], skills: [] };
var agentsLoaded = false;

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

  /** Idempotent: render counts/tables (if loaded) + sync the diary dropdown. */
  refresh(el, ctx) {
    if (!agentsLoaded) { fetchAgentsData(el, ctx); return; }
    renderAgents(el, ctx);
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
    renderAgents(el, ctx);
  }).catch(function () { /* leave Loading... */ });
}

function renderAgents(el, ctx) {
  var esc = ctx.esc, escAttr = ctx.escAttr, fmt = ctx.fmt;

  el.querySelector('#agCountAgents').textContent = agentsData.agents.length;
  el.querySelector('#agCountTeams').textContent = agentsData.teams.length;
  el.querySelector('#agCountSkills').textContent = agentsData.skills.length;

  var agentsBody = el.querySelector('#agentsTableBody');
  if (!agentsData.agents.length) {
    agentsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No agents.</td></tr>';
  } else {
    agentsBody.innerHTML = agentsData.agents.map(function (a) {
      return '<tr>'
        + '<td class="mono">' + esc(a.name) + '</td>'
        + '<td>' + esc(a.display_name) + '</td>'
        + '<td>' + esc(a.role) + '</td>'
        + '<td class="mono">' + esc(a.model) + '</td>'
        + '<td>' + esc((a.tags || []).join(' · ')) + '</td>'
        + '<td class="mono">' + esc(a.path) + '</td>'
        + '</tr>';
    }).join('');
  }

  var teamsBody = el.querySelector('#teamsTableBody');
  if (!agentsData.teams.length) {
    teamsBody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No teams.</td></tr>';
  } else {
    teamsBody.innerHTML = agentsData.teams.map(function (t) {
      return '<tr>'
        + '<td class="mono">' + esc(t.name) + '</td>'
        + '<td>' + esc(t.display_name) + '</td>'
        + '<td>' + esc(t.coordination) + '</td>'
        + '<td class="mono">' + fmt.fmt(t.member_count) + '</td>'
        + '<td class="mono">' + esc(t.path) + '</td>'
        + '</tr>';
    }).join('');
  }

  var skillsBody = el.querySelector('#skillsTableBody');
  if (!agentsData.skills.length) {
    skillsBody.innerHTML = '<tr><td colspan="6" class="empty-msg" style="text-align:center">No skills.</td></tr>';
  } else {
    skillsBody.innerHTML = agentsData.skills.map(function (s) {
      return '<tr>'
        + '<td class="mono">' + esc(s.name) + '</td>'
        + '<td>' + esc(s.display_name) + '</td>'
        + '<td class="mono">' + esc(s.trigger) + '</td>'
        + '<td>' + esc(s.description) + '</td>'
        + '<td>' + esc((s.tags || []).join(' · ')) + '</td>'
        + '<td class="mono">' + esc(s.path) + '</td>'
        + '</tr>';
    }).join('');
  }

  // Diary agent dropdown — sourced from the SSE payload.
  var sel = el.querySelector('#diaryAgentSelect');
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
  if (!agent) {
    body.innerHTML = '<span class="empty-msg">Select an agent to view recent diary entries.</span>';
    return;
  }
  body.innerHTML = '<span class="empty-msg">Loading…</span>';
  ctx.fetchJson('/dashboard/api/agent-diary/' + encodeURIComponent(agent) + '?limit=' + encodeURIComponent(limit))
    .then(function (d) {
      var entries = d.entries || [];
      if (!entries.length) {
        body.innerHTML = '<span class="empty-msg">No diary entries.</span>';
        return;
      }
      body.innerHTML = entries.map(function (e) {
        var text = e.text || '';
        var badges = '';
        if (text.indexOf('_(silent)_') !== -1) {
          badges += '<span class="badge badge-warm" style="margin-right:.3rem">silent</span>';
          text = text.replace(/^_\(silent\)_\s*/, '');
        }
        var srcMatch = text.match(/_via\s+([^_]+)_\s*$/);
        if (srcMatch) {
          badges += '<span class="badge badge-cold" style="margin-right:.3rem">via ' + esc(srcMatch[1].trim()) + '</span>';
          text = text.replace(/\s*_via\s+[^_]+_\s*$/, '');
        }
        return '<div class="feed-item">'
          + '<span class="mono" style="color:var(--text-dim);flex-shrink:0">' + esc(e.date) + ' ' + esc(e.time) + '</span>'
          + '<span>' + badges + esc(text.trim()) + '</span>'
          + '</div>';
      }).join('');
    })
    .catch(function () {
      body.innerHTML = '<span class="empty-msg">Failed to load diary.</span>';
    });
}
