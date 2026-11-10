import { safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * cookie 只落在 userData 下的加密文件里。不能放 dataDir：
 * 那里可能是只读的打包资源，而且索引目录会被用户拷给别人，登录态不能跟着走。
 */
export class CookieStore {
  private path: string;
  private cookie = '';

  constructor(dir: string) {
    this.path = join(dir, 'quark-cookie.enc');
    if (!existsSync(this.path)) return;
    try {
      const buf = readFileSync(this.path);
      this.cookie = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch {
      this.cookie = '';
    }
  }

  get(): string { return this.cookie; }
  has(): boolean { return this.cookie.length > 0; }

  set(raw: string): void {
    const clean = raw.replace(/\s*[;\n]\s*/g, '; ').replace(/;+$/, '').trim();
    if (!clean.includes('=')) throw new Error('格式不对，应形如 a=1; b=2');
    this.cookie = clean;
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(clean) : Buffer.from(clean, 'utf8');
    writeFileSync(this.path, buf);
  }

  clear(): void {
    this.cookie = '';
    if (existsSync(this.path)) rmSync(this.path);
  }

  /** 渲染进程只配知道有哪些 cookie 名，值一个字节都不出去。 */
  describe(): { has: boolean; names: string[]; bytes: number } {
    return {
      has: this.has(),
      names: this.cookie ? this.cookie.split('; ').map((kv) => kv.split('=')[0] ?? '').filter(Boolean) : [],
      bytes: this.cookie.length,
    };
  }
}
