// app.js — dashboard client entry (ES module, no build). Imports the core +
// the 8 tab modules, registers them, and boots. See ARCHITECTURE.md §3/§4.
import { registerTab, boot } from './core.js';
import overview from './tabs/overview.js';
import sessions from './tabs/sessions.js';
import ratelimits from './tabs/ratelimits.js';
import oauth from './tabs/oauth.js';
import vault from './tabs/vault.js';
import retrieval from './tabs/retrieval.js';
import intelligence from './tabs/intelligence.js';
import graph from './tabs/graph.js';
import agents from './tabs/agents.js';
import code from './tabs/code.js';
import logs from './tabs/logs.js';

[overview, sessions, ratelimits, oauth, vault, retrieval, intelligence, graph, agents, code, logs].forEach(registerTab);
boot();
