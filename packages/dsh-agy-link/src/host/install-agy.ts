// Auto-install of the Antigravity CLI (B3). agy ships an official installer
// per platform; when no binary can be resolved the plugin runs that installer
// once and re-resolves, so a machine without Antigravity needs no manual step.
//
// Planning is separated from execution on purpose: planInstall() is pure and
// carries the whole platform decision, which is the part worth testing. Only
// installAgy() touches the network and the file system.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginConfig } from '../common/types.ts'
import { resolveAgyBin } from './runner.ts'

/** Official POSIX installer (macOS + Linux); supports `-d/--dir <path>`. */
export const INSTALL_SH_URL = 'https://antigravity.google/cli/install.sh'
/** Official Windows installer. */
export const INSTALL_PS1_URL = 'https://antigravity.google/cli/install.ps1'

/** Where the POSIX installer puts the binary when no `-d` directory is given. */
export function defaultInstallDir(home: string = homedir()): string {
  return join(home, '.local', 'bin')
}

/** POSIX single-quote quoting: the path is our own, but it may contain spaces. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

export interface InstallPlan {
  command: string
  args: string[]
}

/**
 * The command that installs agy on `platform`. Pure: the caller decides
 * whether to run it. `dir` only applies on POSIX, where the official shell
 * installer accepts `-d`; the Windows script has no equivalent and picks its
 * own location, so the command is built without it there.
 */
export function planInstall(platform: string, dir: string): InstallPlan {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${INSTALL_PS1_URL} | iex`],
    }
  }
  return {
    command: 'sh',
    args: ['-c', `curl -fsSL ${INSTALL_SH_URL} | sh -s -- -d ${shellQuote(dir)}`],
  }
}

export interface InstallResult {
  ok: boolean
  /** Tail of the installer's stderr, surfaced when the install fails. */
  stderrTail: string
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** Run the platform installer. A real network + file-system boundary. */
export async function installAgy(): Promise<InstallResult> {
  const platform = process.platform
  const plan = planInstall(platform, defaultInstallDir())
  const timeoutMs = INSTALL_TIMEOUT_MS
  return await new Promise<InstallResult>((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({ ok: false, stderrTail: err.message })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stderrTail: stderr.slice(-2000) })
    })
  })
}

/**
 * Resolve the agy binary, installing it first when nothing is on disk. Returns
 * null only when the install itself failed — the caller reports that instead
 * of silently degrading to "not installed".
 */
export async function ensureAgyBin(cfg: PluginConfig): Promise<{ bin: string | null; stderrTail: string }> {
  const found = resolveAgyBin(cfg)
  if (found !== null) return { bin: found, stderrTail: '' }
  const result = await installAgy()
  if (!result.ok) return { bin: null, stderrTail: result.stderrTail }
  return { bin: resolveAgyBin(cfg), stderrTail: '' }
}
