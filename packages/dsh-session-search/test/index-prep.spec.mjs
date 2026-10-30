/**
 * The index file has to be born with `auto_vacuum = FULL`, because the setting
 * cannot be changed afterwards without a `VACUUM` the host may not be able to
 * run. These tests check the three things that makes true.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareIndex } from '../lib/index.js'

const temp = () => mkdtempSync(join(tmpdir(), 'session-search-prep-'))

test('a fresh index is created with auto_vacuum = FULL', () => {
  const dir = temp()
  try {
    const path = join(dir, 'session-search', 'index.db')
    assert.equal(prepareIndex(path), 'created')
    assert.ok(existsSync(path), 'the file must exist after preparation')
    const db = new DatabaseSync(path)
    assert.deepEqual({ ...db.prepare('PRAGMA auto_vacuum').get() }, { auto_vacuum: 1 },
      'FULL (1) is what makes the host\'s own DELETEs shrink the file')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an existing index is left alone', () => {
  const dir = temp()
  try {
    const path = join(dir, 'index.db')
    assert.equal(prepareIndex(path), 'created')
    assert.equal(prepareIndex(path), 'exists', 'a second call must not rewrite the file')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the host keeps auto_vacuum and its deletes shrink the file', () => {
  // Reproduces what the host does: open the prepared file, build its own schema,
  // write rows, delete them all. The file must end up smaller, with no help.
  const dir = temp()
  try {
    const path = join(dir, 'index.db')
    prepareIndex(path)
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE persisted_docs (id INTEGER PRIMARY KEY, session_id TEXT, body TEXT)')
    const insert = db.prepare('INSERT INTO persisted_docs (session_id, body) VALUES (?, ?)')
    const filler = 'x'.repeat(2000)
    db.exec('BEGIN')
    for (let s = 0; s < 60; s++) for (let i = 0; i < 50; i++) insert.run('s' + s, filler)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const full = db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get().n
    assert.deepEqual({ ...db.prepare('PRAGMA auto_vacuum').get() }, { auto_vacuum: 1 },
      'the host must still see FULL after building its schema')

    db.exec('DELETE FROM persisted_docs')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const after = db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get().n
    assert.ok(after < full / 10,
      `deleting every row must shrink the file: ${full} -> ${after}`)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('preparation never sets an application_id', () => {
  // The host validates application_id on open: its own id with no tables, or a
  // foreign id, is rejected. An empty file with id 0 is the shape it accepts.
  const dir = temp()
  try {
    const path = join(dir, 'index.db')
    prepareIndex(path)
    const db = new DatabaseSync(path)
    assert.deepEqual({ ...db.prepare('PRAGMA application_id').get() }, { application_id: 0 })
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
