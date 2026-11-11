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
    // 只接受系统密钥解密后的内容。旧版在密钥服务不可用时可能写过明文，
    // 这里不再回退读取，避免把不安全的旧文件继续当成有效登录态。
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      this.cookie = safeStorage.decryptString(readFileSync(this.path));
    } catch {
      this.cookie = '';
    }
  }

  get(): string { return this.cookie; }
  has(): boolean { return this.cookie.length > 0; }
  encryptionAvailable(): boolean { return safeStorage.isEncryptionAvailable(); }

  set(raw: string): void {
    const clean = raw.replace(/\s*[;\n]\s*/g, '; ').replace(/;+$/, '').trim();
    if (!clean.includes('=')) throw new Error('格式不对，应形如 a=1; b=2');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥服务不可用，出于安全考虑不会保存 cookie；请先启用系统密钥环');
    }
    this.cookie = clean;
    writeFileSync(this.path, safeStorage.encryptString(clean));
  }

  clear(): void {
    this.cookie = '';
    if (existsSync(this.path)) rmSync(this.path);
  }

  /** 渲染进程只配知道有哪些 cookie 名，值一个字节都不出去。 */
  describe(): { has: boolean; names: string[]; bytes: number; encryptionAvailable: boolean } {
    return {
      has: this.has(),
      names: this.cookie ? this.cookie.split('; ').map((kv) => kv.split('=')[0] ?? '').filter(Boolean) : [],
      bytes: this.cookie.length,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }
}
