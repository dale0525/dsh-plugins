/**
 * 可注入的最小 fs 门面（同步层核心逻辑经此访问磁盘）。
 * 默认实现包 node:fs/promises；测试/内存场景可注入自定义实现（零副作用、纯接口）。
 */
import fs from 'node:fs/promises';
import { atomicWriteFile } from '../utils/atomic-write.ts';

/** 同步层所需的文件系统操作最小集（路径均为宿主文件系统绝对路径） */
export interface SnapshotFs {
  readFile(p: string): Promise<Uint8Array>;
  /** 写文件。opts.atomic !== false → 同目录 tmp + fsync + rename（单文件配置写）；
   *  批量快照树（数百至数千文件）传 { atomic: false }：逐文件 fsync 并不提供目录级原子性，
   *  只把写入成本放大近 20 倍（实测 2155 文件 21.1s → 1.1s），而该树用「manifest.json 最后写」
   *  表达完成语义（见 layout.ts）。 */
  writeFile(p: string, data: Uint8Array, opts?: { atomic?: boolean }): Promise<void>;
  /** 递归创建目录（已存在则成功） */
  mkdir(p: string): Promise<void>;
  /** 直接子项名字（含目录名）；目录不存在 → [] */
  readdir(p: string): Promise<string[]>;
  isDir(p: string): Promise<boolean>;
  exists(p: string): Promise<boolean>;
  /** 递归删除（不存在则成功） */
  remove(p: string): Promise<void>;
}

/** 目录 + 正斜杠相对路径 → 宿主路径（正斜杠连接，Windows 下 Node fs 同样接受；
 * 两侧多余斜杠一律清除，避免产生 '//' 段与空路径段） */
export function joinFs(dir: string, rel: string): string {
  const base = dir.replace(/[\\/]+$/, '');
  const cleanRel = rel.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  return cleanRel === '' ? base : `${base}/${cleanRel}`;
}

/** 默认 node:fs/promises 适配器 */
export function createSnapshotFs(): SnapshotFs {
  return {
    async readFile(p) { return fs.readFile(p); },
    /** 原子写：同目录 tmp + fsync + rename（同步快照文件不半写；注入的 mem-fs 天然原子） */
    async writeFile(p, data, opts) {
      if (opts?.atomic === false) { await fs.writeFile(p, data); return; }
      await atomicWriteFile(p, data);
    },
    async mkdir(p) { await fs.mkdir(p, { recursive: true }); },
    async readdir(p) {
      try { return (await fs.readdir(p)).sort(); } catch { return []; }
    },
    async isDir(p) {
      try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
    },
    async exists(p) {
      try { await fs.access(p); return true; } catch { return false; }
    },
    async remove(p) { await fs.rm(p, { recursive: true, force: true }); },
  };
}
