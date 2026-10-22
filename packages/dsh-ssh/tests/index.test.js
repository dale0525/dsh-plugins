/**
 * Tests for the host half's wiring, against a fake cordis context.
 *
 * Two classes of failure live here, and neither is visible from a schema test:
 *
 *  - **Registration-time**: the runtime validates each tool's `output.schema`
 *    when it is registered, and an unsupported schema throws before any tool
 *    exists. A plugin that waits on a service its host does not provide never
 *    activates at all, which reads as "this plugin does nothing".
 *  - **Addressing-time**: the alias is the only handle the tools accept, so the
 *    error for an unknown alias has to name what *is* configured, or the model
 *    has nothing to correct itself with.
 *
 * The last group runs the registered executors for real, against the in-process
 * SSH server, with `DSH_HOME` pointed at a temporary directory — that is the only
 * way to see that the password comes from the credential store, the host key is
 * recorded where the plugin says it is, and a relative upload path resolves
 * against the session directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name } from '../src/index.js';
import { startServer } from './support/server.js';

/**
 * A minimal cordis-shaped context.
 *
 * `inject` runs its callback immediately once every dependency is present,
 * which is what the real runtime does; a missing dependency skips it entirely,
 * also as the real runtime does. Services that were not requested are genuinely
 * absent, because `ctx.get` returning something the host would not provide is
 * exactly the bug this file exists to catch.
 *
 * @param options.hosts - the live host table the config reference reports.
 * @param options.passwords - credential reference → value.
 * @param options.systemPrompt - provide the system-prompt service.
 * @param options.credentials - provide the credential provider; defaults to true.
 * @returns `{ctx, registered, sections}`.
 */
function fakeContext(options = {}) {
  const registered = [];
  const sections = [];
  const services = {};
  const passwords = options.passwords ?? {};

  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (key) => services[key],
    inject(deps, callback) {
      for (const dep of deps) if (services[dep] === undefined) return;
      callback(ctx);
    },
    effect(factory) {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  services.tools = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  };
  if (options.credentials !== false) {
    services.credentials = {
      async resolve(ref) {
        return passwords[ref] === undefined ? undefined : { value: passwords[ref] };
      },
      async describe(ref) {
        return { configured: passwords[ref] !== undefined };
      },
    };
  }
  if (options.systemPrompt === true) {
    services.systemPrompt = {
      section(entry) {
        sections.push(entry);
        return () => {};
      },
    };
  }

  const hosts = options.hosts ?? [];
  return { ctx, registered, sections, config: { get: () => ({ hosts }) } };
}

/**
 * Mount the plugin over a fake context.
 *
 * @param options - see {@link fakeContext}.
 * @returns the context and what the plugin registered.
 */
function mount(options) {
  const built = fakeContext(options);
  apply(built.ctx, built.config);
  return built;
}

/**
 * Find one registered tool by name.
 *
 * @param registered - the registration log.
 * @param toolName - the public tool name.
 * @returns the definition.
 */
function tool(registered, toolName) {
  const found = registered.find((definition) => definition.name === toolName);
  assert.notEqual(found, undefined, `${toolName} was not registered`);
  return found;
}

test('the row id equals the host half name, which nothing automated checks', () => {
  assert.equal(name, 'dsh-ssh');
});

test('a full host gets four tools, each with an executor and a unique name', () => {
  const { registered } = mount({ hosts: [], systemPrompt: true });
  assert.deepEqual(
    registered.map((definition) => definition.name),
    ['ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download'],
  );
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function', `${definition.name} has no executor`);
  }
});

test('a host without a credential provider registers nothing instead of crashing', () => {
  // `credentials` is a required dependency of the tool block: without it no
  // password can be resolved, so registering nothing is the correct outcome.
  // What must NOT happen is an exception out of `apply`.
  const { registered, sections } = mount({ hosts: [], credentials: false, systemPrompt: true });
  assert.deepEqual(registered, []);
  // Announcing a route whose tools were never registered would be worse than
  // silence, so the section is gated on the same dependency.
  assert.deepEqual(sections, []);
});

test('a host without a system prompt still gets the tools', () => {
  // Read through `get` rather than `inject` precisely for this case: a declared
  // dependency would let a missing prompt take the tools with it.
  const { registered, sections } = mount({ hosts: [] });
  assert.equal(registered.length, 4);
  assert.deepEqual(sections, []);
});

test('the announced section is unique, ordered, and states the alias and password rules', () => {
  const { sections } = mount({ hosts: [], systemPrompt: true });
  const [section] = sections;
  assert.equal(section.name, 'plugin:dsh-ssh');
  assert.equal(section.order, 170);
  assert.match(section.text, /ssh_list/);
  assert.match(section.text, /alias/);
  assert.match(section.text, /密码/);
  assert.match(section.text, /不是交互式/);
});

test('ssh_list reports the configured hosts and which of them have a password', async () => {
  const { registered } = mount({
    hosts: [
      { alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' },
      { alias: 'vps', host: '10.0.0.3', username: 'deploy' },
    ],
    passwords: { SSH_PASSWORD_NAS: 'secret' },
  });
  const value = await tool(registered, 'ssh_list').execute({}, {});
  assert.deepEqual(value.hosts, [
    { alias: 'nas', host: '10.0.0.2', port: 22, username: 'root', has_password: true },
    { alias: 'vps', host: '10.0.0.3', port: 22, username: 'deploy', has_password: false },
  ]);
  assert.match(value.message, /2 台/);
  assert.match(value.message, /未设置密码：vps/);
});

test('an empty host table says so instead of listing nothing', async () => {
  const { registered } = mount({ hosts: [] });
  const value = await tool(registered, 'ssh_list').execute({}, {});
  assert.deepEqual(value.hosts, []);
  assert.match(value.message, /没有配置任何 SSH 主机/);
});

test('an unknown alias fails with the configured aliases, and an invalid row with its reason', async () => {
  const { registered } = mount({
    hosts: [
      { alias: 'nas', host: '10.0.0.2', username: 'root' },
      { alias: 'bad alias', host: '10.0.0.9', username: 'root' },
    ],
    passwords: { SSH_PASSWORD_NAS: 'secret' },
  });
  await assert.rejects(
    () => tool(registered, 'ssh_exec').execute({ alias: 'nope', command: 'true' }, {}),
    (error) => {
      assert.match(error.message, /没有 alias 为 "nope" 的主机/);
      assert.match(error.message, /已配置的主机：nas/);
      assert.match(error.message, /配置错误/);
      return true;
    },
  );
});

test('a host with no stored password fails by naming the reference to set', async () => {
  const { registered } = mount({ hosts: [{ alias: 'nas', host: '10.0.0.2', username: 'root' }] });
  await assert.rejects(
    () => tool(registered, 'ssh_exec').execute({ alias: 'nas', command: 'true' }, {}),
    (error) => {
      assert.match(error.message, /还没有设置密码/);
      assert.match(error.message, /SSH_PASSWORD_NAS/);
      return true;
    },
  );
});

test('exec runs on the configured host, records the host key, and returns the exit code', async () => {
  const server = await startServer({
    exec: (command) => ({ stdout: `ran ${command}\n`, stderr: '', code: 0 }),
  });
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { registered } = mount({
      hosts: [{ alias: 'nas', host: server.host, port: server.port, username: 'demo' }],
      passwords: { SSH_PASSWORD_NAS: 'pw' },
    });
    const value = await tool(registered, 'ssh_exec').execute({ alias: 'NAS', command: 'uptime' }, {});
    assert.equal(value.stdout, 'ran uptime\n');
    assert.equal(value.exit_code, 0);
    assert.equal(value.host, 'nas', 'the canonical alias is reported, not what the caller typed');
    assert.equal(value.address, `${server.host}:${server.port}`);
    assert.match(value.host_key, /^SHA256:/);

    // The key was pinned where the guidance says it is, so the next connection
    // to this address is verified rather than trusted again.
    const recorded = JSON.parse(await readFile(join(home, 'dsh-ssh', 'known-hosts.json'), 'utf8'));
    assert.equal(recorded.entries[`${server.host}:${server.port}`], value.host_key);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await server.close();
  }
});

test('a failed command still reports its output and its exit code', async () => {
  const server = await startServer({ exec: () => ({ stdout: '', stderr: 'no such file\n', code: 2 }) });
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { registered } = mount({
      hosts: [{ alias: 'nas', host: server.host, port: server.port, username: 'demo' }],
      passwords: { SSH_PASSWORD_NAS: 'pw' },
    });
    const value = await tool(registered, 'ssh_exec').execute({ alias: 'nas', command: 'cat /nope' }, {});
    assert.equal(value.exit_code, 2);
    assert.equal(value.stderr, 'no such file\n');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await server.close();
  }
});

test('a relative upload path resolves against the session working directory', async () => {
  const server = await startServer({});
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ssh-cwd-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  await writeFile(join(cwd, 'note.txt'), 'from the session\n');
  try {
    const { registered } = mount({
      hosts: [{ alias: 'nas', host: server.host, port: server.port, username: 'demo' }],
      passwords: { SSH_PASSWORD_NAS: 'pw' },
    });
    const value = await tool(registered, 'ssh_upload').execute(
      { alias: 'nas', local_path: 'note.txt', remote_path: '/srv/note.txt' },
      { agent: { session: { header: { cwd } } } },
    );
    assert.equal(value.local_path, join(cwd, 'note.txt'));
    assert.equal(server.files.get('/srv/note.txt')?.toString(), 'from the session\n');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await server.close();
  }
});

test('a relative path with no session directory is refused rather than guessed', async () => {
  const { registered } = mount({
    hosts: [{ alias: 'nas', host: '10.0.0.2', username: 'root' }],
    passwords: { SSH_PASSWORD_NAS: 'pw' },
  });
  await assert.rejects(
    () => tool(registered, 'ssh_upload').execute({ alias: 'nas', local_path: 'note.txt', remote_path: '/srv/note.txt' }, {}),
    /相对路径/,
  );
});
