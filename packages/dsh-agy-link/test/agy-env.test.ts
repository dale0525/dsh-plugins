import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { GENERATED_HEADER, adaptAgentsMd, agyHomeFor, seedAgyHome, syncAgyEnv } from '../src/host/agy-env.ts'
import { defaultPoolDir } from '../src/host/pool.ts'
import type { ManagedAccount } from '../src/common/pool-types.ts'
import type { McpBridge } from '../src/host/mcp-bridge.ts'

const BT = String.fromCharCode(96)
const NL = '\n'

function account(patch: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc_test',
    alias: 'test',
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {},
    ...patch,
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Runs fn with DSH_HOME / DSH_STATE_DIR pointed at throwaway dirs. */
function withDshDirs(root: string, fn: (dsh: string) => void): void {
  const prevHome = process.env.DSH_HOME
  const prevState = process.env.DSH_STATE_DIR
  process.env.DSH_HOME = join(root, 'dsh')
  process.env.DSH_STATE_DIR = join(root, 'state')
  try {
    fn(join(root, 'dsh'))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevState === undefined) delete process.env.DSH_STATE_DIR
    else process.env.DSH_STATE_DIR = prevState
  }
}

const bridge: McpBridge = {
  bridgeScript: '/tmp/bridge.mjs',
  token: 'test-token',
  url: 'http://127.0.0.1:1',
  port: 1,
  close: async () => undefined,
}

test('adaptAgentsMd drops DSH-only tool references and keeps the discipline', () => {
  const source = [
    '## 0. 核心原则',
    '',
    '1. **最小充分**：只解决已确认的问题。',
    '2. 用 ' + BT + 'run_code' + BT + ' 提交程序。',
    '3. 维护 ' + BT + 'todo_write' + BT + ' 清单。',
    '4. 路径一律用 ' + BT + 'skill' + BT + ' 工具加载。',
    '5. 生成图片走 dsh-imagegen 插件。',
    '6. 需要时启停 DSH Web。',
    '7. 用 create_goal 管理会话目标。',
    '8. **测试先行**：先写测试再实现。',
    '',
  ].join(NL)
  const out = adaptAgentsMd(source)
  assert.equal(out.split(NL)[0], GENERATED_HEADER)
  assert.ok(out.includes('**最小充分**'))
  assert.ok(out.includes('**测试先行**'))
  for (const gone of ['run_code', 'todo_write', BT + 'skill' + BT, 'dsh-imagegen', 'DSH Web', 'create_goal', '会话目标']) {
    assert.ok(!out.includes(gone), gone + ' must be stripped')
  }
})

test('adaptAgentsMd drops a DSH-only section together with its body', () => {
  const source = [
    '## 1. 沟通与边界',
    '- 简洁直接。',
    '## 4. 按需加载（路径一律用 ' + BT + 'skill' + BT + ' 工具加载）',
    '| 触发 | 加载 |',
    '| --- | --- |',
    '| 写文档 | doc-governance |',
    '## 5. 其他',
    '- 保留这一行。',
    '',
  ].join(NL)
  const out = adaptAgentsMd(source)
  assert.ok(out.includes('## 1. 沟通与边界'))
  assert.ok(out.includes('简洁直接'))
  assert.ok(!out.includes('按需加载'))
  assert.ok(!out.includes('doc-governance'))
  assert.ok(out.includes('## 5. 其他'))
  assert.ok(out.includes('保留这一行'))
})

test('agyHomeFor keeps the managed HOME inside the pool directory', () => {
  const root = tempDir('agy-home-for-')
  try {
    withDshDirs(root, () => {
      const home = agyHomeFor(account({ id: 'acc_primary', systemHome: true, dir: '' }))
      assert.equal(home, join(defaultPoolDir(), 'env', 'acc_primary'))
      // pool.json, the isolated accounts and the managed HOMEs must share one
      // subtree: the config-manager sync covers it with a single directory
      // rule, and two sibling roots cannot be covered by one.
      assert.ok(home.startsWith(defaultPoolDir() + sep), 'managed HOME must live under the pool dir')
      assert.equal(agyHomeFor(account({ dir: join(root, 'agy-account-dir') })), join(root, 'agy-account-dir'))
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seedAgyHome copies the system credential once and never overwrites it', () => {
  const root = tempDir('agy-seed-')
  try {
    const sourceHome = join(root, 'real-home')
    const home = join(root, 'agy-home')
    const source = join(sourceHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    mkdirSync(join(sourceHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(source, '{"token":{"access_token":"seeded"}}')
    seedAgyHome(home, sourceHome)
    const target = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    assert.equal(readFileSync(target, 'utf8'), '{"token":{"access_token":"seeded"}}')
    // After a fresh login the managed copy is authoritative: seeding must not clobber it.
    writeFileSync(target, '{"token":{"access_token":"fresh"}}')
    seedAgyHome(home, sourceHome)
    assert.equal(readFileSync(target, 'utf8'), '{"token":{"access_token":"fresh"}}')
    // Nothing to seed is not an error.
    seedAgyHome(join(root, 'empty-home'), join(root, 'no-such-home'))
    assert.equal(existsSync(join(root, 'empty-home', '.gemini')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncAgyEnv writes rules, skills and the MCP config, then leaves them untouched', () => {
  const root = tempDir('agy-env-')
  const home = join(root, 'agy-home')
  try {
    withDshDirs(root, (dsh) => {
      mkdirSync(join(dsh, 'skills', 'alpha'), { recursive: true })
      mkdirSync(join(dsh, 'skills', 'not-a-skill'), { recursive: true })
      writeFileSync(join(dsh, 'AGENTS.md'), '# rules' + NL + NL + '1. keep this.' + NL + '2. use ' + BT + 'run_code' + BT + '.' + NL)
      writeFileSync(join(dsh, 'skills', 'alpha', 'SKILL.md'), '# alpha' + NL)
      writeFileSync(join(dsh, 'skills', 'not-a-skill', 'README.md'), 'not a skill' + NL)

      const acc = account({ dir: home })
      const opts = { bridge, sourceHome: join(root, 'no-such-home') }
      assert.equal(syncAgyEnv(acc, opts), home)

      const rulesFile = join(home, '.gemini', 'GEMINI.md')
      const skillFile = join(home, '.gemini', 'config', 'skills', 'alpha', 'SKILL.md')
      const mcpFile = join(home, '.gemini', 'config', 'mcp_config.json')
      const rules = readFileSync(rulesFile, 'utf8')
      assert.ok(rules.startsWith(GENERATED_HEADER))
      assert.ok(rules.includes('keep this.'))
      assert.ok(!rules.includes('run_code'))
      assert.equal(readFileSync(skillFile, 'utf8'), '# alpha' + NL)
      assert.equal(existsSync(join(home, '.gemini', 'config', 'skills', 'not-a-skill')), false)
      const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
        mcpServers: Record<string, { command?: string; env?: Record<string, string> }>
      }
      assert.equal(mcp.mcpServers['dsh-tools']?.env?.DSH_MCP_URL, bridge.url)
      // settings.json is agy's own file: never created by the plugin.
      assert.equal(existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json')), false)

      const stamps = [rulesFile, skillFile, mcpFile].map((f) => statSync(f).mtimeMs)
      syncAgyEnv(acc, opts)
      assert.deepEqual([rulesFile, skillFile, mcpFile].map((f) => statSync(f).mtimeMs), stamps)
      assert.equal(readFileSync(rulesFile, 'utf8'), rules)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncAgyEnv merges the bridge into existing agy config instead of replacing it', () => {
  const root = tempDir('agy-merge-')
  const home = join(root, 'agy-home')
  const mcpFile = join(home, '.gemini', 'config', 'mcp_config.json')
  const settingsFile = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  try {
    withDshDirs(root, () => {
      mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
      mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2))
      writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['read_file'] } }, null, 2))

      const acc = account({ dir: home })
      const opts = { bridge, sourceHome: join(root, 'no-such-home') }
      syncAgyEnv(acc, opts)

      const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
        mcpServers: Record<string, { command?: string; env?: Record<string, string> }>
      }
      assert.ok(mcp.mcpServers.other, 'foreign server preserved')
      assert.equal(mcp.mcpServers['dsh-tools']?.env?.DSH_MCP_URL, bridge.url)
      // Only plan mode reads permissions.allow; the rule is added to agy's own
      // file, and adding it twice must not duplicate it.
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { permissions: { allow: string[] } }
      assert.deepEqual(settings.permissions.allow, ['read_file', 'mcp(dsh-tools)'])
      const stamp = statSync(settingsFile).mtimeMs
      syncAgyEnv(acc, opts)
      assert.deepEqual(
        (JSON.parse(readFileSync(settingsFile, 'utf8')) as { permissions: { allow: string[] } }).permissions.allow,
        ['read_file', 'mcp(dsh-tools)'],
      )
      assert.equal(statSync(settingsFile).mtimeMs, stamp)

      // A document the plugin cannot parse belongs to agy: leave it alone
      // rather than flattening servers the user configured.
      const opaque = '{ "mcpServers": { /* keep me */ } }'
      writeFileSync(mcpFile, opaque)
      syncAgyEnv(acc, opts)
      assert.equal(readFileSync(mcpFile, 'utf8'), opaque)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
