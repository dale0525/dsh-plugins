/**
 * Tests for the one design convention that is enforced in code.
 *
 * "One code project owns exactly one Stitch project" is the only one of the
 * three with a computable predicate, so it is the only one with tests of this
 * kind. The other two are prose — see `guidance.test.js`.
 *
 * The rule is enforced rather than announced because a convention the model can
 * silently break is not a convention. Two properties carry that:
 *
 *  - the id is recorded in the code project's own `.stitch.json`, which is what
 *    lets a later session (or a teammate) find the project that already exists;
 *  - a second `create_project` from an already-bound directory is refused with
 *    the existing id, and the refusal happens before Stitch is asked to create
 *    anything.
 *
 * A record pointing at a project that no longer exists must not become a dead
 * end, so that path is covered too.
 *
 * Each test gets its own temp directory to act as the code project, so no test
 * can read another's binding. The plugin writes nothing outside the directory it
 * is handed, so there is no machine-local state to isolate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { BINDING_FILE, readBinding } = await import('../src/project.js');
const { createInvoker } = await import('../src/conventions.js');

/** Temp root holding one directory per test, so no test can read another's binding. */
const ROOT = await mkdtemp(join(tmpdir(), 'stitch-conventions-'));

let repo;
test.beforeEach(async () => {
  repo = await mkdtemp(join(ROOT, 'repo-'));
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** A Stitch client stub that records every call it receives. */
function stubStitch(handlers = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      const handler = handlers[name];
      return handler === undefined ? { content: [] } : handler(args);
    },
  };
}

/** The execution context the agent loop supplies, reduced to what is read here. */
function execIn(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

test('create_project records the id in the code project', async () => {
  const stitch = stubStitch({ create_project: () => ({ structuredContent: { name: 'projects/p7', title: 'Workbench' } }) });
  await createInvoker({ stitch })('create_project', { title: 'Workbench' }, execIn(repo));

  // Read back through the public reader: this is the "a later session finds the
  // same project" property, and it is why the record is a file in the project.
  // The title Stitch returns is deliberately NOT recorded — see the test below.
  assert.deepEqual(await readBinding(repo), { projectId: 'p7' });
  assert.deepEqual(JSON.parse(await readFile(join(repo, BINDING_FILE), 'utf8')), { projectId: 'p7' });
});

test('the binding keeps only the id, never the upstream title', async () => {
  // A stored title would be a second copy of a fact Stitch owns, going stale as
  // soon as the project is renamed upstream; the rule reads the id alone.
  const stitch = stubStitch({ create_project: () => ({ structuredContent: { name: 'projects/p7', title: 'Workbench' } }) });
  await createInvoker({ stitch })('create_project', {}, execIn(repo));

  const raw = JSON.parse(await readFile(join(repo, BINDING_FILE), 'utf8'));
  assert.deepEqual(Object.keys(raw), ['projectId']);
});

test('a second create_project from the same project is refused', async () => {
  const stitch = stubStitch({
    create_project: () => ({ structuredContent: { name: 'projects/p7' } }),
    get_project: () => ({ structuredContent: { name: 'projects/p7' } }),
  });
  const invoke = createInvoker({ stitch });
  await invoke('create_project', { title: 'Workbench' }, execIn(repo));

  await assert.rejects(
    () => invoke('create_project', { title: 'Workbench again' }, execIn(repo)),
    /already bound to Stitch project p7/,
  );
  // The refusal lands before Stitch is asked to create a second project.
  assert.deepEqual(
    stitch.calls.map((call) => call.name),
    ['create_project', 'get_project'],
  );
});

test('a recorded project that no longer exists does not block a new one', async () => {
  await writeFile(join(repo, BINDING_FILE), JSON.stringify({ projectId: 'p404', title: 'Gone' }));
  const stitch = stubStitch({
    create_project: () => ({ structuredContent: { name: 'projects/p8' } }),
    // Measured: Stitch answers an unknown project with this text and NO
    // structuredContent — it does not raise.
    get_project: () => ({ content: [{ type: 'text', text: 'Requested entity was not found.' }] }),
  });
  await createInvoker({ stitch })('create_project', {}, execIn(repo));

  assert.equal((await readBinding(repo)).projectId, 'p8');
});

test('a hand-broken binding file reads as unbound instead of failing every call', async () => {
  await writeFile(join(repo, BINDING_FILE), '{ not json');
  const stitch = stubStitch({ create_project: () => ({ structuredContent: { name: 'projects/p9' } }) });
  await createInvoker({ stitch })('create_project', {}, execIn(repo));

  assert.equal((await readBinding(repo)).projectId, 'p9');
});

test('a create_project with no session directory touches no files', async () => {
  const stitch = stubStitch({ create_project: () => ({ structuredContent: { name: 'projects/p7' } }) });
  await createInvoker({ stitch })('create_project', {}, { signal: new AbortController().signal });

  assert.equal(await readBinding(repo), undefined);
});

test('delete_project clears the record so the project can start over', async () => {
  await writeFile(join(repo, BINDING_FILE), JSON.stringify({ projectId: 'p7' }));
  const stitch = stubStitch({ delete_project: () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  await createInvoker({ stitch })('delete_project', { name: 'projects/p7' }, execIn(repo));

  assert.equal(await readBinding(repo), undefined);
});

test('deleting a different project leaves the record alone', async () => {
  await writeFile(join(repo, BINDING_FILE), JSON.stringify({ projectId: 'p7' }));
  const stitch = stubStitch({ delete_project: () => ({ content: [] }) });
  await createInvoker({ stitch })('delete_project', { name: 'projects/p9' }, execIn(repo));

  assert.equal((await readBinding(repo)).projectId, 'p7');
});

test('a non-project tool leaves the record untouched and is passed through', async () => {
  await writeFile(join(repo, BINDING_FILE), JSON.stringify({ projectId: 'p7' }));
  const stitch = stubStitch({ generate_screen_from_text: () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  const result = await createInvoker({ stitch })('generate_screen_from_text', { projectId: 'p7' }, execIn(repo));

  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
  assert.equal((await readBinding(repo)).projectId, 'p7');
});
