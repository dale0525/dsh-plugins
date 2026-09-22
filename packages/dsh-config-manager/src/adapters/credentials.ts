/**
 * credentialsStatus 分区 adapter（设计 §3.3/§7.1）：
 * 数据源 = ctx.credentials.describe(ref) 的状态（configured/source/writable），
 * 以及 settings secrets 标记 / llm apiKeyEnv 中引用的凭据 ref 名。
 *
 * 值语义：
 *  - includeSecrets=false（普通备份）：永不导出值，hasValue 恒 false；
 *  - includeSecrets=true（同步快照）：携带 .credentials.yaml 里的凭据明文
 *    （refs 段，含仅在该文件登记、未被 settings 引用的 ref），跨机拉取时直接写回。
 * 导入：快照带值即直接 credentials.set()；无值（旧快照/普通备份）回退
 * ctx.secretInputs / decryptedCredentials 补录。
 */
import * as yaml from 'js-yaml';
import type { CredentialStatus, CredentialsSection } from '../schema/types.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { resolveNamespaces, type NamespaceProvider } from './settings.ts';

export type CredentialRefsProvider = (ctx: HostContext) => Promise<string[]>;

/** 凭据文件相对 $DSH_HOME 的路径（整文件即秘密；refs 段是「名字 → 明文值」映射） */
export const CREDENTIALS_FILE_REL = '.credentials.yaml';

/**
 * 读取 .credentials.yaml 的 refs 段（名字 → 明文值）。
 * 只认 refs（顶层映射）；records 段是内部不透明载荷，不参与导入导出。
 * 文件不存在 / 非对象 / 段缺失 → 空映射（无凭据可携带不是错误）。
 */
async function readCredentialValues(ctx: HostContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(await ctx.fs.exists(CREDENTIALS_FILE_REL))) return out;
  const doc = yaml.load(Buffer.from(await ctx.fs.readFile(CREDENTIALS_FILE_REL)).toString('utf8'));
  if (doc === null || typeof doc !== 'object') return out;
  const refs = (doc as { refs?: unknown }).refs;
  if (refs === null || typeof refs !== 'object') return out;
  for (const [ref, value] of Object.entries(refs as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out.set(ref, value);
  }
  return out;
}

/** 缺省 ref 收集：遍历 settings namespace，收集 llm apiKeyEnv / providers[].apiKeyEnv，
 * 以及 secrets 标记中「引用类字段」（apiKeyEnv/tokenEnv…）的字段值。
 * 注意 secrets[].path[0] 是 settings 文档内的字段路径（如 ['apiKey']），本身不是凭据 ref（设计 §4.2），
 * 只有指向 env 名的引用字段才值得收集。 */
export function defaultCredentialRefs(namespaces: string[] | NamespaceProvider): CredentialRefsProvider {
  return async (ctx: HostContext): Promise<string[]> => {
    const refs = new Set<string>();
    for (const ns of await resolveNamespaces(namespaces, ctx)) {
      try {
        const info = await ctx.settings.describe(ns, { redactSecrets: true });
        const value = (info.value ?? {}) as Record<string, unknown>;
        // 引用类字段名（值 = env/凭据引用名，非秘密本身）
        const REFERENCE_REF_FIELDS = new Set([
          'apikeyenv', 'api_key_env', 'apikeyname', 'tokenenv', 'accesstokenenv',
          'refreshtokenenv', 'clientsecretenv', 'passwordenv',
        ]);
        for (const s of info.secrets) {
          const first = s.path?.[0];
          if (typeof first !== 'string' || first === '') continue;
          const norm = first.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!REFERENCE_REF_FIELDS.has(norm)) continue;
          const val = value[first];
          if (typeof val === 'string' && val !== '') refs.add(val);
        }
        if (typeof value['apiKeyEnv'] === 'string' && value['apiKeyEnv'] !== '') refs.add(value['apiKeyEnv'] as string);
        const providers = value['providers'];
        if (providers !== null && typeof providers === 'object') {
          for (const pv of Object.values(providers as Record<string, { apiKeyEnv?: unknown }>)) {
            if (pv !== null && typeof pv === 'object' && typeof pv.apiKeyEnv === 'string' && pv.apiKeyEnv !== '') {
              refs.add(pv.apiKeyEnv);
            }
          }
        }
      } catch {
        // namespace 不存在则跳过
      }
    }
    return [...refs];
  };
}

export interface CredentialsAdapterOptions {
  /** 凭据 ref 名收集器（缺省从 settings 推断） */
  refs?: CredentialRefsProvider;
  /** 供缺省 refs 使用的 namespace 清单 */
  namespaces?: string[] | NamespaceProvider;
}

export class CredentialsAdapter implements ConfigAdapter<CredentialsSection> {
  readonly id = 'credentialsStatus' as const;
  readonly displayName = 'Credentials';
  readonly defaultIncluded = true;
  readonly portability = 'deviceSpecific' as const;
  private readonly refs: CredentialRefsProvider;

  constructor(options: CredentialsAdapterOptions = {}) {
    this.refs = options.refs ?? defaultCredentialRefs(options.namespaces ?? []);
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<CredentialsSection>> {
    const credentials: CredentialStatus[] = [];
    const warnings: string[] = [];
    // includeSecrets=true 才读凭据文件：普通备份绝不让明文进入内存导出数据。
    const values = options.includeSecrets ? await readCredentialValues(ctx) : new Map<string, string>();
    // refs 并集：settings 引用到的 + 凭据文件里登记的（后者可能未被任何 namespace 引用）
    const allRefs = new Set(await this.refs(ctx));
    for (const ref of values.keys()) allRefs.add(ref);
    for (const ref of allRefs) {
      const value = values.get(ref);
      try {
        const status = await ctx.credentials.describe(ref);
        credentials.push({
          ref,
          required: true,
          configured: status.configured,
          source: (status.source as CredentialStatus['source']) ?? 'file',
          hasValue: value !== undefined,
          ...(value === undefined ? {} : { value }),
        });
      } catch (err) {
        warnings.push(msgOf(ctx)('adapter.credStatusReadFailed', { ref, reason: err instanceof Error ? err.message : String(err) }));
      }
    }
    return {
      sectionId: 'credentialsStatus',
      data: { version: 1, credentials },
      counts: { credentials: credentials.length },
      warnings,
    };
  }

  async analyzeImport(data: CredentialsSection, _ctx: ImportContext): Promise<PlanItem[]> {
    // 快照自带明文 → 直接写回项；无值 → 交给引擎的 MissingSecret 兜底（用户补录）。
    return (data.credentials ?? [])
      .filter((c) => c.hasValue === true && typeof c.value === 'string' && c.value !== '')
      .map((c) => ({
        id: `cred:${c.ref}`,
        kind: 'Update' as const,
        adapter: 'credentialsStatus' as const,
        description: _ctx.msg('adapter.credentialWriteBack', { ref: c.ref }),
        severity: 'info' as const,
        target: { adapter: 'credentialsStatus' as const, ref: c.ref },
      }));
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    // 优先级：用户补录 > 快照明文 > 旧版解密通道
    const carried = (ctx.sections.get('credentialsStatus') as CredentialsSection | undefined)
      ?.credentials.find((c) => c.ref === ref)?.value;
    const value = ctx.secretInputs[ref] ?? carried ?? ctx.decryptedCredentials?.get(ref);
    if (value === undefined || value === '') return { ok: false, message: ctx.msg('adapter.credentialValueMissing') };
    await ctx.target.credentials.set(ref, value);
    return { ok: true };
  }

  async validate(data: CredentialsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'credentials' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.credentials)) {
      issues.push({ path: 'credentials', message: msg('adapter.validate.array', { subject: 'credentials' }), severity: 'error' });
    } else {
      for (const c of data.credentials) {
        if (c === null || typeof c !== 'object' || typeof c.ref !== 'string' || c.ref === '') {
          issues.push({ path: 'credentials[]', message: msg('adapter.validate.credentialRef'), severity: 'error' });
        }
        // hasValue 与 value 必须一致：声称有值却没带、或带了值却没标，都是结构异常
        const hasValue = c.hasValue === true;
        const hasLiteral = typeof c.value === 'string' && c.value !== '';
        if (hasValue !== hasLiteral) {
          issues.push({ path: `credentials.${c.ref}.hasValue`, message: msg('adapter.validate.hasValueMismatch'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
