/**
 * 导入向导步骤条纯渲染模型（2026-09 UX 重构）：框架无关，node 可测。
 *
 * 把向导内部步骤（ImportStep 九态）与 UI 流程阶段（FlowPhase）映射为用户视角的
 * 6 个阶段（选择 → 分析 → 预览与决策 → 确认 → 执行 → 完成），供 Stepper 组件
 * 渲染「我在第几步 / 还剩几步」。
 *
 * 只前进纪律（与 flow.ts 一致）：向导流程不回退，Stepper 的 state 判定也只依据
 * 当前阶段索引——之前的阶段恒为 done，之后恒为 todo，不做任何反向推断。
 */
import type { ImportStep } from './types.ts'
import type { FlowPhase } from './flow.ts'

/** 用户视角阶段 key（UI 用 `import.stage.<key>` 渲染标签）。 */
export type ImportStageKey = 'select' | 'analyze' | 'decide' | 'confirm' | 'execute' | 'done'

/** 阶段有序表（顺序即向导前进方向）。 */
export const IMPORT_STAGES: readonly ImportStageKey[] = [
  'select', 'analyze', 'decide', 'confirm', 'execute', 'done',
] as const

/** 单个阶段渲染模型。 */
export interface ImportStepperStep {
  key: ImportStageKey
  /** UI 渲染 key（`import.stage.<key>`）。 */
  labelKey: string
  state: 'done' | 'current' | 'todo'
}

export interface ImportStepperModel {
  /** 当前阶段索引（0-5）。 */
  index: number
  steps: ImportStepperStep[]
}

/** 向导步骤/流程阶段 → 用户视角阶段。 */
export function stageOf(step: ImportStep | FlowPhase): ImportStageKey {
  switch (step) {
    case 'select':
    case 'decrypt-archive':
      return 'select'
    case 'analyzing':
    case 'compatibility':
      return 'analyze'
    case 'preview':
    case 'conflicts':
    case 'path-mapping':
    case 'secrets':
      return 'decide'
    case 'confirm':
      return 'confirm'
    case 'importing':
      return 'execute'
    case 'result':
      return 'done'
    default:
      return 'select'
  }
}

/** 构建步骤条模型（线性向导：index 之前 done，当前 current，之后 todo）。 */
export function importStepperModel(step: ImportStep | FlowPhase): ImportStepperModel {
  const current = stageOf(step)
  const index = IMPORT_STAGES.indexOf(current)
  return {
    index,
    steps: IMPORT_STAGES.map((key, i) => ({
      key,
      labelKey: `import.stage.${key}`,
      state: i < index ? 'done' : i === index ? 'current' : 'todo',
    })),
  }
}
