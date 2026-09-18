/**
 * m-sync-crypto：同步快照 sections 载荷加密/解密（测试夹具）。
 *
 * 产品语义已不含加密快照：同步通道恒为明文，SyncEngine 遇到 manifest.encrypted=true
 * 的快照会明确拒绝。本模块仅供测试构造「旧版加密快照」样本，用于验证拒绝路径
 * 与传输层对密文载荷的字节保真——生产代码不得 import 本模块。
 *
 * 复用 security/encryption.ts 的底层原语（scrypt KDF + AES-256-GCM，salt/iv 全随机）。
 */
import { decryptCredentials, encryptCredentials } from '../security/encryption.ts';
import type { SectionData, SectionId } from '../schema/types.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { sectionsFromJsonSafe, sectionsToJsonSafe } from './snapshot-json.ts';
import type { EncryptedSections } from './transport.ts';

/** 加密整个明文 sections Record → 密文载荷（info 进 manifest 非秘密参数；data 为 base64 密文）。 */
export async function encryptSectionsPayload(
  sections: Partial<Record<SectionId, SectionData>>,
  password: string,
): Promise<EncryptedSections> {
  if (password === '') throw new Error('加密密码不能为空');
  const { blob, info } = await encryptCredentials(stringifyJsonSafe(sectionsToJsonSafe(sections)), password);
  return { encrypted: { info, data: Buffer.from(blob).toString('base64') } };
}

/** 解密密文载荷 → 明文 sections Record（密码错误 / 密文被篡改 → SecurityError）。 */
export async function decryptSectionsPayload(
  payload: EncryptedSections['encrypted'],
  password: string,
): Promise<Partial<Record<SectionId, SectionData>>> {
  if (password === '') throw new Error('解密密码不能为空');
  const plain = await decryptCredentials(Buffer.from(payload.data, 'base64'), payload.info, password);
  const parsed = parseJsonSafe(plain);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('加密快照内容损坏：解密后不是有效的分区对象');
  }
  return sectionsFromJsonSafe(parsed) as Partial<Record<SectionId, SectionData>>;
}
