/**
 * 导入向导步骤条映射测试（node:test，零依赖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { IMPORT_STAGES, importStepperModel, stageOf } from './import-stepper.ts'

test('stageOf: 九个 ImportStep + FlowPhase 全部映射到 6 阶段', () => {
  assert.equal(stageOf('select'), 'select')
  assert.equal(stageOf('decrypt-archive'), 'select')
  assert.equal(stageOf('analyzing'), 'analyze')
  assert.equal(stageOf('compatibility'), 'analyze')
  assert.equal(stageOf('preview'), 'decide')
  assert.equal(stageOf('conflicts'), 'decide')
  assert.equal(stageOf('path-mapping'), 'decide')
  assert.equal(stageOf('secrets'), 'decide')
  assert.equal(stageOf('confirm'), 'confirm')
  assert.equal(stageOf('importing'), 'execute')
  assert.equal(stageOf('result'), 'done')
})

test('importStepperModel: select → 第 0 阶段 current，其余 todo', () => {
  const m = importStepperModel('select')
  assert.equal(m.index, 0)
  assert.equal(m.steps.length, 6)
  assert.equal(m.steps[0]!.state, 'current')
  assert.equal(m.steps[0]!.labelKey, 'import.stage.select')
  for (const s of m.steps.slice(1)) assert.equal(s.state, 'todo')
})

test('importStepperModel: preview（决策链中段）→ 之前 done 之后 todo', () => {
  const m = importStepperModel('conflicts')
  assert.equal(m.index, 2)
  assert.equal(m.steps[0]!.state, 'done')
  assert.equal(m.steps[1]!.state, 'done')
  assert.equal(m.steps[2]!.state, 'current')
  assert.equal(m.steps[3]!.state, 'todo')
})

test('importStepperModel: result → 最后一阶段 current（全部走完）', () => {
  const m = importStepperModel('result')
  assert.equal(m.index, IMPORT_STAGES.length - 1)
  for (const s of m.steps.slice(0, 5)) assert.equal(s.state, 'done')
  assert.equal(m.steps[5]!.state, 'current')
})

test('importStepperModel: importing 阶段映射正确（执行中）', () => {
  const m = importStepperModel('importing')
  assert.equal(m.index, 4)
  assert.equal(m.steps[4]!.state, 'current')
})
