/**
 * End-to-end tests of the transport, against a real SSH handshake on loopback.
 *
 * Each case here is a failure the plugin can ship: a password that never reaches
 * the server, a host key accepted without verification, an exit code lost, a
 * changed host key silently trusted, a stuck command holding the call forever.
 * A stubbed client would let every one of them through, so the server is real
 * (see `tests/support/server.js`) and the assertions go through the exported
 * surface only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_STREAM_CHARS,
  connect,
  describeConnectError,
  downloadFile,
  runCommand,
  truncateStream,
  uploadFile,
} from '../src/connection.js';
import { fingerprint, judgeHostKey } from '../src/known-hosts.js';
import { startServer } from './support/server.js';

/**
 * A host row as the config normalizer produces it.
 *
 * @param server - the running test server.
 * @param overrides - fields to replace.
 * @returns the host row.
 */
function hostRow(server, overrides = {}) {
  return {
    alias: 'nas',
    host: server.host,
    port: server.port,
    username: 'demo',
    passwordRef: 'SSH_PASSWORD_NAS',
    ...overrides,
  };
}

/**
 * Connect with first-use trust, recording what the verifier accepted.
 *
 * @param server - the running test server.
 * @param overrides - host row overrides.
 * @param entries - pre-recorded known hosts.
 * @returns `{client, fingerprint, recorded}`.
 */
async function open(server, overrides = {}, entries = {}) {
  const recorded = [];
  const result = await connect({
    host: hostRow(server, overrides),
    password: 'pw',
    knownHosts: { entries },
    recordHostKey: (entry) => recorded.push(entry),
  });
  return { ...result, recorded };
}

test('a correct password connects, and the host key is verified and recorded once', async () => {
  const server = await startServer({});
  try {
    const { client, fingerprint: seen, recorded } = await open(server);
    try {
      assert.equal(seen, fingerprint(server.publicKey));
      assert.equal(recorded.length, 1, 'first use must record exactly one entry');
      assert.equal(recorded[0].address, `127.0.0.1:${server.port}`);
      assert.equal(recorded[0].fingerprint, seen);
    } finally {
      client.end();
    }
  } finally {
    await server.close();
  }
});

test('a wrong password fails with a message naming the host and what to do', async () => {
  const server = await startServer({});
  try {
    await assert.rejects(
      () =>
        connect({
          host: hostRow(server),
          password: 'wrong',
          knownHosts: { entries: {} },
        }),
      (error) => {
        assert.match(error.message, /认证失败/);
        assert.match(error.message, /nas/);
        assert.match(error.message, /设置/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('a host key that changed since it was recorded is refused, and no password is used', async () => {
  let first;
  let second;
  try {
    first = await startServer({});
    // A different key on the same address: the server a rebuilt host presents,
    // or an impostor. The address is recorded with the OLD key, which is what
    // the client would find there after connecting to it once before.
    second = await startServer({});
    const address = `127.0.0.1:${second.port}`;
    const entries = { [address]: fingerprint(first.publicKey) };
    await assert.rejects(
      () => connect({ host: { ...hostRow(second), port: second.port }, password: 'pw', knownHosts: { entries } }),
      (error) => {
        assert.match(error.message, /主机密钥校验失败/);
        assert.match(error.message, /known-hosts\.json/);
        return true;
      },
    );
    // The address was never re-recorded, so the refusal persists instead of
    // silently becoming the new trust anchor.
    const verdict = judgeHostKey({ entries, host: '127.0.0.1', port: second.port, key: second.publicKey });
    assert.equal(verdict.ok, false);
  } finally {
    if (first !== undefined) await first.close();
    if (second !== undefined) await second.close();
  }
});

test('a recorded key is accepted on the next connection without being re-recorded', async () => {
  const server = await startServer({});
  try {
    const entries = { [`127.0.0.1:${server.port}`]: fingerprint(server.publicKey) };
    const { client, recorded } = await open(server, {}, entries);
    client.end();
    assert.deepEqual(recorded, []);
  } finally {
    await server.close();
  }
});

test('runCommand returns stdout, stderr and the remote exit code', async () => {
  const server = await startServer({
    exec: (command) =>
      command === 'fail'
        ? { stdout: 'partial\n', stderr: 'boom\n', code: 42 }
        : { stdout: `ok:${command}\n`, stderr: '', code: 0 },
  });
  try {
    const { client } = await open(server);
    try {
      const ok = await runCommand({ client, command: 'uptime' });
      assert.deepEqual(ok, { stdout: 'ok:uptime\n', stderr: '', code: 0, signal: undefined });

      const failed = await runCommand({ client, command: 'fail' });
      assert.equal(failed.code, 42, 'the remote exit code must survive, not become 0');
      assert.equal(failed.stdout, 'partial\n');
      assert.equal(failed.stderr, 'boom\n');
    } finally {
      client.end();
    }
  } finally {
    await server.close();
  }
});

test('a command that never finishes is aborted at its budget instead of hanging', async () => {
  const server = await startServer({ exec: () => ({ hold: true }) });
  try {
    const { client } = await open(server);
    const started = Date.now();
    await assert.rejects(
      () => runCommand({ client, command: 'sleep 1000', timeoutMs: 300 }),
      (error) => {
        assert.match(error.message, /超过/);
        assert.match(error.message, /远端进程可能仍在运行/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000, 'the budget must end the call, not the server');
  } finally {
    await server.close();
  }
});

test('a caller cancellation aborts the command', async () => {
  const server = await startServer({ exec: () => ({ hold: true }) });
  try {
    const { client } = await open(server);
    const controller = new AbortController();
    const pending = runCommand({ client, command: 'sleep 1000', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /取消/);
  } finally {
    await server.close();
  }
});

test('upload then download round-trips the exact bytes', async () => {
  const server = await startServer({});
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-xfer-'));
  const local = join(dir, 'payload.txt');
  const back = join(dir, 'back.txt');
  const content = 'hello over sftp\n第二行\n';
  await writeFile(local, content);

  try {
    const { client } = await open(server);
    try {
      const uploaded = await uploadFile({ client, localPath: local, remotePath: '/remote/payload.txt' });
      assert.equal(uploaded.bytes, Buffer.byteLength(content));
      assert.equal(server.files.get('/remote/payload.txt')?.toString(), content);

      const downloaded = await downloadFile({ client, remotePath: '/remote/payload.txt', localPath: back });
      assert.equal(downloaded.bytes, Buffer.byteLength(content));
      assert.equal(await readFile(back, 'utf8'), content);
    } finally {
      client.end();
    }
  } finally {
    await server.close();
  }
});

test('downloading a missing remote file fails instead of leaving an empty local file', async () => {
  const server = await startServer({});
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-xfer-'));
  const local = join(dir, 'never.txt');
  try {
    const { client } = await open(server);
    try {
      await assert.rejects(() => downloadFile({ client, remotePath: '/nope.txt', localPath: local }));
    } finally {
      client.end();
    }
  } finally {
    await server.close();
  }
});

test('an over-long stream keeps its head and its tail, and says it was cut', () => {
  const long = 'A'.repeat(MAX_STREAM_CHARS) + 'TAIL';
  const cut = truncateStream(long);
  assert.ok(cut.length <= MAX_STREAM_CHARS + 64);
  assert.ok(cut.includes('[truncated]'));
  assert.ok(cut.startsWith('A'));
  assert.ok(cut.endsWith('TAIL'), 'the tail is what a caller needs after a failure');
  assert.equal(truncateStream('short'), 'short');
});

test('connect failures are translated into something a caller can act on', () => {
  const host = { alias: 'nas', host: '10.0.0.2', port: 22, username: 'root' };

  const refused = describeConnectError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), host);
  assert.match(refused.message, /连不上 nas/);
  assert.match(refused.message, /10\.0\.0\.2:22/);

  const timeout = describeConnectError(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }), host);
  assert.match(timeout.message, /连接超时/);

  const denied = describeConnectError(new Error('Host denied (verification failed)'), host);
  assert.match(denied.message, /主机密钥校验失败/);

  const auth = describeConnectError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }), host);
  assert.match(auth.message, /认证失败/);
});

test('a connection dropped mid-handshake cannot crash the process', async () => {
  // The regression this pins, seen in a real host: a socket that accepts the TCP
  // connection and then closes it makes ssh2 emit TWO errors — the socket-level
  // one first, then a fatal `Connection lost before handshake` from its own
  // teardown. With a `once` listener the second one is unhandled, and Node turns
  // it into an uncaught exception that kills the whole host process. The plugin
  // must contain that, because the hosts it exists to reach are often offline.
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const seen = [];
  const onUncaught = (error) => seen.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(
      connect({
        host: { alias: 'dead', host: '127.0.0.1', port, username: 'root' },
        password: 'pw',
        knownHosts: { entries: {} },
        recordHostKey: () => {},
      }),
      /连接 dead/,
    );
    // The second error arrives asynchronously, after the rejection settles.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    process.off('uncaughtException', onUncaught);
    server.close();
  }
  assert.deepEqual(seen, [], 'no error may escape to the process');
});
