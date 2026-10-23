/**
 * An in-process SSH server, so the plugin's four tools can be exercised end to end.
 *
 * A test that stubs the transport would prove nothing worth proving here: the
 * failures this plugin can actually ship are "the password never reaches the
 * server", "the host key is not verified", "SFTP copies the wrong bytes" and
 * "the exit code is lost" — every one of them is a fact about a real handshake,
 * not about a function call. `ssh2` can be both halves, so the server below
 * speaks the real protocol over a loopback socket.
 *
 * Deliberately minimal, and minimal on purpose: password authentication only,
 * `exec` through a caller-supplied handler, and an in-memory SFTP tree. Anything
 * the plugin does not use (pty, shell, port forwarding) is not implemented, so a
 * test cannot accidentally pass by leaning on it.
 *
 * @module tests/support/server
 */
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const SFTP = utils.sftp;

/**
 * Start a server on an ephemeral loopback port.
 *
 * @param options.password - the password that authenticates.
 * @param options.username - the username that authenticates; defaults to `demo`.
 * @param options.hostKey - a private key to present; generated when omitted.
 * @param options.exec - `(command) => {stdout, stderr, code}`; defaults to echoing.
 * @param options.files - initial remote tree, `{path: string|Buffer}`.
 * @param options.sftp - whether to offer the SFTP subsystem; defaults to true.
 *   A server without it is a real case (OpenWrt, minimal containers) and the
 *   plugin has to say so rather than surface ssh2's exit code.
 * @returns the server handle: `{host, port, publicKey, files, setExec, close}`.
 */
export async function startServer(options = {}) {
  const hostKey = options.hostKey ?? utils.generateKeyPairSync('ed25519').private;
  // The fingerprint a client sees is over the PUBLIC key blob, so the handle
  // exposes that rather than the private key a test would otherwise fingerprint
  // by mistake.
  const publicKey = utils.parseKey(hostKey).getPublicSSH();
  const username = options.username ?? 'demo';
  const password = options.password ?? 'pw';
  const files = new Map(
    Object.entries(options.files ?? {}).map(([path, content]) => [path, Buffer.from(content)]),
  );
  let execHandler =
    options.exec ??
    ((command) => ({ stdout: `ran:${command}\n`, stderr: '', code: 0 }));

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // A client that refuses the host key aborts mid-handshake, which surfaces
    // here as KEY_EXCHANGE_FAILED. That is the outcome under test, not a test
    // failure, so it must not escape as an unhandled 'error' event.
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        ctx.accept();
        return;
      }
      // `['password']` rather than `['publickey', 'password']`: the plugin asks
      // for password first, and a server that offers only that is the shape that
      // would break if the auth handler ever regressed.
      ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          const result = execHandler(info.command) ?? { stdout: '', stderr: '', code: 0 };
          // `hold: true` models the command the plugin must give up on: the
          // channel opens and then never ends, which is exactly what an
          // interactive prompt or a stuck mount looks like from the client.
          if (result.hold === true) return;
          if (result.stdout) stream.write(result.stdout);
          if (result.stderr) stream.stderr.write(result.stderr);
          stream.exit(result.code ?? 0);
          stream.end();
        });

        session.on('sftp', (acceptSftp) => {
          // A server that does not offer SFTP exits the subsystem request with
          // 127, which is what the plugin has to translate.
          if (options.sftp === false) return acceptSftp().exit(127);
          const sftp = acceptSftp();
          const handles = new Map();
          let nextHandle = 1;

          const openHandle = (path, write) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(nextHandle++);
            handles.set(handle.readUInt32BE(0), { path, write });
            return handle;
          };

          sftp.on('OPEN', (reqid, filename, flags) => {
            const mode = SFTP.flagsToString(flags) ?? 'r';
            const write = mode.includes('w') || mode.includes('+');
            if (!write && !files.has(filename)) return sftp.status(reqid, SFTP.STATUS_CODE.NO_SUCH_FILE);
            if (write) files.set(filename, Buffer.alloc(0));
            sftp.handle(reqid, openHandle(filename, write));
          });

          sftp.on('READ', (reqid, handle, offset, length) => {
            const entry = handles.get(handle.readUInt32BE(0));
            const data = files.get(entry?.path) ?? Buffer.alloc(0);
            if (entry === undefined) return sftp.status(reqid, SFTP.STATUS_CODE.FAILURE);
            // A positioned read, which is what the plugin uses: `offset` is the
            // file position and `length` the most bytes to return. `fastGet`
            // passes position 0 and tracks its own progress, so both clients are
            // served by honouring the arguments rather than a cursor here.
            const start = typeof offset === 'number' ? offset : 0;
            if (start >= data.length) return sftp.status(reqid, SFTP.STATUS_CODE.EOF);
            const wanted = typeof length === 'number' && length > 0 ? length : data.length - start;
            sftp.data(reqid, data.subarray(start, start + wanted));
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const entry = handles.get(handle.readUInt32BE(0));
            if (entry === undefined) return sftp.status(reqid, SFTP.STATUS_CODE.FAILURE);
            const previous = files.get(entry.path) ?? Buffer.alloc(0);
            const buffer = Buffer.alloc(Math.max(previous.length, offset + data.length));
            previous.copy(buffer);
            data.copy(buffer, offset);
            files.set(entry.path, buffer);
            sftp.status(reqid, SFTP.STATUS_CODE.OK);
          });

          sftp.on('CLOSE', (reqid, handle) => {
            handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, SFTP.STATUS_CODE.OK);
          });

          sftp.on('REALPATH', (reqid, path) => {
            sftp.name(reqid, [{ filename: path === '' ? '/' : path, longname: path === '' ? '/' : path, attrs: {} }]);
          });

          sftp.on('STAT', (reqid, path) => {
            const data = files.get(path);
            if (data !== undefined) {
              sftp.attrs(reqid, { mode: 0o100644, size: data.length, uid: 0, gid: 0, atime: 0, mtime: 0 });
              return;
            }
            // A directory is any path some file lives under, so the plugin's
            // "this is a directory, not a file" branch has a real case to hit.
            if (isDirectory(path)) {
              sftp.attrs(reqid, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 });
              return;
            }
            sftp.status(reqid, SFTP.STATUS_CODE.NO_SUCH_FILE);
          });

          /** Whether any tracked file lives under `path`. */
          function isDirectory(path) {
            const prefix = path.endsWith('/') ? path : `${path}/`;
            for (const known of files.keys()) if (known.startsWith(prefix)) return true;
            return false;
          }
        });
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    host: '127.0.0.1',
    publicKey,
    files,
    setExec(handler) {
      execHandler = handler;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
