/**
 * m-sync-crypto：同步快照 sections 载荷加密/解密（测试夹具，**自包含**）。
 *
 * 产品语义已不含加密快照：同步通道恒为明文，SyncEngine 遇到 manifest.encrypted=true
 * 的快照会明确拒绝。本模块仅供测试构造「旧版加密快照」样本，用于验证拒绝路径
 * 与传输层对密文载荷的字节保真——生产代码不得 import 本模块。
 *
 * 自包含：插件本体已删除加密层（src/security/encryption.ts 不复存在），本夹具因此
 * 自带最小的 scrypt + AES-256-GCM 原语，只求「密文形态正确、可往返、密码错误即失败」，
 * 不承诺与历史版本的字节兼容（历史产物只用于被拒绝，不需要能解开）。
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { EncryptionInfo, SectionData, SectionId } from '../../src/schema/types.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../../src/utils/json.ts';
import { sectionsFromJsonSafe, sectionsToJsonSafe } from '../../src/sync/snapshot-json.ts';
import type { EncryptedSections } from '../../src/sync/transport.ts';

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/** 加密整个明文 sections Record → 密文载荷（info 进 manifest 非秘密参数；data 为 base64 密文）。 */
export async function encryptSectionsPayload(
  sections: Partial<Record<SectionId, SectionData>>,
  password: string,
): Promise<EncryptedSections> {
  if (password === '') throw new Error('加密密码不能为空');
  const plaintext = stringifyJsonSafe(sectionsToJsonSafe(sections));
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = await scryptAsync(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const info: EncryptionInfo = {
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { ...SCRYPT_PARAMS },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    version: 1,
  };
  return { encrypted: { info, data: ciphertext.toString('base64') } };
}

/** 解密密文载荷 → 明文 sections Record（密码错误 / 密文被篡改 → 抛错）。 */
export async function decryptSectionsPayload(
  payload: EncryptedSections['encrypted'],
  password: string,
): Promise<Partial<Record<SectionId, SectionData>>> {
  if (password === '') throw new Error('解密密码不能为空');
  const key = await scryptAsync(password, Buffer.from(payload.info.salt, 'base64'), payload.info.kdfParams.keyLength, {
    N: payload.info.kdfParams.N, r: payload.info.kdfParams.r, p: payload.info.kdfParams.p,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.info.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.info.authTag, 'base64'));
  let plain: string;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('解密认证失败：密码错误或密文被篡改');
  }
  const parsed = parseJsonSafe(plain);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('加密快照内容损坏：解密后不是有效的分区对象');
  }
  return sectionsFromJsonSafe(parsed) as Partial<Record<SectionId, SectionData>>;
}
