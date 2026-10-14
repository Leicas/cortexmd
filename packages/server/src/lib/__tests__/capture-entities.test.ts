import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-capture-entities-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-capture-entities';
process.env.DASHBOARD_PASSWORD = 'test-capture-entities';
process.env.ENABLE_EMBEDDINGS = 'false';
// Auto-detect the people dir and infer the internal domain from the notes.
delete process.env.CRM_PEOPLE_DIR;
delete process.env.CRM_INTERNAL_DOMAINS;

const PEOPLE = '05 CRM/Entities/People';
mkdirSync(path.join(root, 'data'), { recursive: true });

function person(name: string, email: string): void {
  mkdirSync(path.join(root, PEOPLE), { recursive: true });
  writeFileSync(
    path.join(root, PEOPLE, `${name}.md`),
    `---\nentity: ${name}\nentity_type: person\nstatus: active\nwork_email: ${email}\nsource: odoo\n---\n# ${name}\n\n## Notes\n\n## Email Timeline\n\n## Open Threads\n`,
  );
}

// Three coworkers on one domain → acme.test is inferred as internal.
person('Ada Lovelace', 'ada@acme.test');
person('Grace Hopper', 'grace.hopper@acme.test');
person('Alan Turing', 'alan.turing@acme.test');

const {
  parseCaptureParticipants, nameFromEmail, isAutomatedAddress, detectCaptureKind,
  planCaptureEntityLinks, resolvePeopleDir, invalidatePersonIndex,
} = await import('../capture-entities.js');
const { appendLineToSection } = await import('../markdown.js');
const { storeMemoryFromApi } = await import('../store-memory-api.js');
const { readNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { parseFrontmatter } = await import('../frontmatter.js');
const { initKnowledgeGraph, kgSearch, shutdownKG } = await import('../knowledge-graph.js');

beforeAll(async () => {
  initKnowledgeGraph();
  await rebuildIndex();
  invalidatePersonIndex();
});
afterAll(() => {
  shutdownKG();
  rmSync(root, { recursive: true, force: true });
});

async function frontmatterOf(p: string): Promise<Record<string, any>> {
  return parseFrontmatter((await readNote(p)).content).data;
}

describe('parseCaptureParticipants', () => {
  it('reads the n8n email header block (From / To / Cc) with quoted names and lists', () => {
    const content = [
      '# Email - tech lead meeting',
      '',
      '**Account:** acme',
      '**From:** "Grace Hopper" <grace.hopper@acme.test>',
      '**To:** Ada Lovelace <ada@acme.test>, "Turing, Alan" <alan.turing@acme.test>',
      '**Cc:** <counsel@lawfirm.test>; notifications@github.test',
      '**Label:** 1: to respond',
      '**Entities:** -',
      '**Gmail ID:** 19ee30f966b3c7e5',
      '',
      'Body mentioning Someone Else <someone@else.test> is not a participant.',
    ].join('\n');
    const parts = parseCaptureParticipants(content);
    expect(parts).toEqual([
      { name: 'Grace Hopper', email: 'grace.hopper@acme.test', role: 'from' },
      { name: 'Ada Lovelace', email: 'ada@acme.test', role: 'to' },
      { name: 'Turing, Alan', email: 'alan.turing@acme.test', role: 'to' },
      { name: undefined, email: 'counsel@lawfirm.test', role: 'cc' },
      { name: undefined, email: 'notifications@github.test', role: 'cc' },
    ]);
  });

  it('reads chat-style headers and strips "via <service>" sender decorations', () => {
    const parts = parseCaptureParticipants('**User:** Ada Lovelace\n**From:** "Board Member via Miro" <noreply@miro.test>\n');
    expect(parts).toEqual([
      { name: 'Ada Lovelace', role: 'author' },
      { name: 'Board Member', email: 'noreply@miro.test', role: 'from' },
    ]);
  });

  it('derives a name from a dotted mailbox and flags automated senders', () => {
    expect(nameFromEmail('grace.hopper@acme.test')).toBe('Grace Hopper');
    expect(nameFromEmail('ada@acme.test')).toBeUndefined();
    expect(isAutomatedAddress('noreply@miro.test')).toBe(true);
    expect(isAutomatedAddress('subscriptioncenter@subscriptions.uspto.gov')).toBe(true);
    expect(isAutomatedAddress('grace.hopper@acme.test')).toBe(false);
  });

  it('classifies captures by tag/source', () => {
    expect(detectCaptureKind(['matrimail'], 'n8n')).toBe('email');
    expect(detectCaptureKind(['slack', 'auto'], 'n8n')).toBe('chat');
    expect(detectCaptureKind([], 'n8n:slack-digest')).toBe('chat');
    expect(detectCaptureKind(['build'], 'posttooluse')).toBeUndefined();
  });
});

describe('appendLineToSection', () => {
  it('appends inside the section, before the next heading, creating it when missing', () => {
    const note = '# Kevin\n\n## Notes\n\n## Email Timeline\n- old line\n\n## Open Threads\n';
    const out = appendLineToSection(note, 'Email Timeline', '- new line');
    expect(out).toBe('# Kevin\n\n## Notes\n\n## Email Timeline\n- old line\n- new line\n\n## Open Threads\n');
    const empty = appendLineToSection('# Kevin\n\n## Email Timeline\n\n## Open Threads\n', 'Email Timeline', '- first');
    expect(empty).toBe('# Kevin\n\n## Email Timeline\n- first\n\n## Open Threads\n');
    const missing = appendLineToSection('# Kevin\n\n## Notes\nx\n', 'Mentions (auto)', '- m');
    expect(missing).toBe('# Kevin\n\n## Notes\nx\n\n## Mentions (auto)\n- m\n');
  });
});

describe('planCaptureEntityLinks', () => {
  it('auto-detects the people dir and infers the internal domain', async () => {
    expect(resolvePeopleDir()).toBe(PEOPLE);
    const plan = await planCaptureEntityLinks('**From:** "Grace Hopper" <grace.hopper@acme.test>\n', 'email');
    expect(plan.people).toEqual([
      { name: 'Grace Hopper', path: `${PEOPLE}/Grace Hopper.md`, role: 'from', email: 'grace.hopper@acme.test', created: false },
    ]);
    expect(plan.links).toEqual([`[[${PEOPLE}/Grace Hopper|Grace Hopper]]`]);
  });

  it('matches by name when the header carries no email and ignores non-people notes', async () => {
    const plan = await planCaptureEntityLinks('**User:** Ada Lovelace\n', 'chat');
    expect(plan.people.map((p) => p.path)).toEqual([`${PEOPLE}/Ada Lovelace.md`]);
    const none = await planCaptureEntityLinks('**From:** "Totally Unknown" <someone@external.test>\n', 'email');
    expect(none.people).toEqual([]);
  });
});

describe('storeMemoryFromApi with capture entity linking', () => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const ym = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;

  it('links known people, creates a stub for an internal coworker, skips externals and bots', async () => {
    const res = await storeMemoryFromApi({
      title: 'Email - Platform sync notes',
      content: [
        '**Account:** acme',
        '**From:** "Grace Hopper" <grace.hopper@acme.test>',
        '**To:** Ada Lovelace <ada@acme.test>, "New Hire" <new.hire@acme.test>, "Outside Counsel" <counsel@lawfirm.test>',
        '**Cc:** notifications@github.test',
        '**Gmail ID:** 1a13b47f100d79d5',
        '',
        'Agenda for the platform sync.',
      ].join('\n'),
      tags: ['matrimail', 'msg:1a13b47f100d79d5'],
      source: 'n8n',
    });
    expect(res.stored).toBe(true);
    expect(res.path).toBe(`EmailLog/observation/${ym}/${today}-email-platform-sync-notes.md`);
    expect(res.entities).toEqual([
      `${PEOPLE}/Grace Hopper.md`,
      `${PEOPLE}/Ada Lovelace.md`,
      `${PEOPLE}/New Hire.md`,
    ]);

    // The capture carries the links in its body + frontmatter.
    const capture = await readNote(res.path!);
    expect(capture.content).toContain('## Entities (auto)');
    expect(capture.content).toContain(`- [[${PEOPLE}/Grace Hopper|Grace Hopper]] (from)`);
    expect(capture.content).toContain(`- [[${PEOPLE}/New Hire|New Hire]] (to)`);
    expect((await frontmatterOf(res.path!)).auto_entities).toEqual([
      `[[${PEOPLE}/Grace Hopper]]`, `[[${PEOPLE}/Ada Lovelace]]`, `[[${PEOPLE}/New Hire]]`,
    ]);

    // Stub for the coworker only; nothing for the external contact or the bot.
    const stub = await readNote(`${PEOPLE}/New Hire.md`);
    const stubFm = parseFrontmatter(stub.content).data;
    expect(stubFm).toMatchObject({ entity: 'New Hire', entity_type: 'person', work_email: 'new.hire@acme.test', source: 'capture:email' });
    await expect(readNote(`${PEOPLE}/Outside Counsel.md`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readNote(`${PEOPLE}/Notifications.md`)).rejects.toMatchObject({ code: 'ENOENT' });

    // Timeline backlink + last_contact on the sender's note.
    const joel = await readNote(`${PEOPLE}/Grace Hopper.md`);
    const capturePath = res.path!.replace(/\.md$/, '');
    expect(joel.content).toContain(`## Email Timeline\n- ${today} — Email - Platform sync notes ([[${capturePath}|email]]) [id:1a13b47f100d79d5]\n\n## Open Threads`);
    expect(parseFrontmatter(joel.content).data.last_contact).toBe(today);

    // KG: capture mentions each person, sender emailed recipients.
    const predicates = kgSearch('Grace Hopper', 50).map((t) => `${t.subject}|${t.predicate}|${t.object}`);
    expect(predicates).toContain('Email - Platform sync notes|mentions_person|Grace Hopper');
    expect(predicates).toContain('Grace Hopper|emailed|Ada Lovelace');
    expect(predicates).toContain('Grace Hopper|emailed|New Hire');
  });

  it('does not duplicate timeline lines or stubs when the same capture is retried', async () => {
    const body = {
      title: 'Email - Platform sync notes',
      content: '**From:** "Grace Hopper" <grace.hopper@acme.test>\n**To:** "New Hire" <new.hire@acme.test>\n\nAgenda.',
      tags: ['matrimail'],
      skipDedupe: true,
    };
    const again = await storeMemoryFromApi(body);
    expect(again).toMatchObject({ stored: false, reason: 'duplicate' });
    const joel = await readNote(`${PEOPLE}/Grace Hopper.md`);
    expect(joel.content.split('[[EmailLog/').length - 1).toBe(1);
  });

  it('links chat captures (slack tag) under Memories/ with a Mentions (auto) backlink', async () => {
    const res = await storeMemoryFromApi({
      content: '**User:** Ada Lovelace\n**Channel:** #ops\n\nShipped the new runner image today.',
      tags: ['slack'],
      source: 'n8n:slack-digest',
    });
    expect(res.stored).toBe(true);
    expect(res.path).toMatch(/^Memories\/observation\//);
    expect(res.entities).toEqual([`${PEOPLE}/Ada Lovelace.md`]);
    const kevin = await readNote(`${PEOPLE}/Ada Lovelace.md`);
    expect(kevin.content).toContain('## Mentions (auto)\n- ');
    expect(kevin.content).toContain(`[[${res.path!.replace(/\.md$/, '')}|chat]]`);
  });

  it('leaves plain hook captures untouched (no headers, no links)', async () => {
    const res = await storeMemoryFromApi({ content: 'Build cache stale after dependency bump. Seen twice.', source: 'posttooluse' });
    expect(res.stored).toBe(true);
    expect(res.entities).toBeUndefined();
    expect((await readNote(res.path!)).content).not.toContain('## Entities (auto)');
  });
});
