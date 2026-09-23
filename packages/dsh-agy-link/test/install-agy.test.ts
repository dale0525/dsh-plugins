// B3: auto-install agy when it is missing (Windows + macOS/Linux parity).
// Only the pure planning surface is tested here — running the real installer
// would hit the network and the file system, which is exactly what
// planInstall() exists to keep out of the test.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INSTALL_PS1_URL, INSTALL_SH_URL, defaultInstallDir, planInstall, shellQuote } from '../src/host/install-agy.ts'

test('planInstall targets the POSIX installer on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = planInstall(platform, '/tmp/agy-bin')
    assert.equal(plan.command, 'sh')
    assert.equal(plan.args[0], '-c')
    const script = plan.args[1] ?? ''
    assert.ok(script.includes(INSTALL_SH_URL), 'downloads the official POSIX installer')
    assert.ok(script.includes('-d'), 'passes the target directory through')
    assert.ok(script.includes('/tmp/agy-bin'), 'names the configured directory')
  }
})

test('planInstall targets the PowerShell installer on Windows', () => {
  const plan = planInstall('win32', 'C:\\Users\\x\\.local\\bin')
  assert.equal(plan.command, 'powershell')
  const script = plan.args[plan.args.length - 1] ?? ''
  assert.ok(script.includes(INSTALL_PS1_URL), 'downloads the official PowerShell installer')
  assert.ok(plan.args.includes('-ExecutionPolicy'), 'bypasses the execution policy for the one-shot script')
})

test('planInstall quotes a directory containing spaces', () => {
  const plan = planInstall('darwin', '/tmp/with space/bin')
  const script = plan.args[1] ?? ''
  assert.ok(script.includes("'/tmp/with space/bin'"), 'single-quotes the path so sh keeps it one argument')
})

test('shellQuote wraps in single quotes and escapes embedded ones', () => {
  assert.equal(shellQuote('/plain/path'), "'/plain/path'")
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

test('defaultInstallDir is the POSIX installer default location', () => {
  assert.equal(defaultInstallDir('/Users/x'), '/Users/x/.local/bin')
  assert.equal(defaultInstallDir('/home/x'), '/home/x/.local/bin')
})
