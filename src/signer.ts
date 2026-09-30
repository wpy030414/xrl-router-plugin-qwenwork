/**
 * qwenwork/signer.ts — 千问办公请求签名（逆向自 asar，见 docs/QWENWORKCN_REVERSE.md §6.8）。
 *
 * encryptUserInfo：随机 16B AES key e → info=AES-128-CBC(key=e, iv=e, JSON(userInfo))，
 *                  cosy-key = base64(RSA_PKCS1(公钥, e))
 * generateAuthToken：authorization = "Bearer COSY." + base64(header) + "." + md5(o + cosy-key + ts + body + path)
 */

import crypto from 'node:crypto';
import { settings } from './config';
import type { QwenTokenState } from './auth';

/** asar 硬编码 RSA 公钥（QwenWorkCN 0.1.3；modulus 头 c0f223…，非 security-guard 内部公钥） */
const EMBEDDED_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

let rsaPublicKey: crypto.KeyObject | null = null;

function getRsaPublicKey(): crypto.KeyObject {
  if (!rsaPublicKey) {
    const pem = settings.qwenRsaPublicKeyPath && fsExists(settings.qwenRsaPublicKeyPath)
      ? require('node:fs').readFileSync(settings.qwenRsaPublicKeyPath, 'utf8')
      : EMBEDDED_RSA_PUBLIC_KEY;
    rsaPublicKey = crypto.createPublicKey(pem);
  }
  return rsaPublicKey;
}

function fsExists(p: string): boolean {
  try { require('node:fs').accessSync(p); return true; } catch { return false; }
}

/** AES-128-CBC，key=iv=e（16 字节字符串）→ base64 */
function aesEncrypt(plaintext: string, key: string): string {
  const n = Buffer.from(plaintext, 'utf8');
  const i = Buffer.from(key, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', i, i.slice(0, 16));
  return Buffer.concat([cipher.update(n), cipher.final()]).toString('base64');
}

export interface QwenSignMaterial {
  /** base64(RSA_PKCS1(公钥, e)) — Cosy-Key 头 */
  cosyKey: string;
  /** base64(AES(e, JSON(userInfo))) — COSY token 头的 info 字段 */
  info: string;
  uid: string;
  /** 16B AES key（本请求会话内用） */
  key: string;
}

/** encryptUserInfo 等价物 */
export function buildSignMaterial(token: QwenTokenState): QwenSignMaterial {
  const e = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
  const userInfo = {
    uid: token.user.uid,
    aid: '',
    name: token.user.name ?? '',
    email: token.user.email ?? '',
    security_oauth_token: token.token,
  };
  const pub = getRsaPublicKey();
  return {
    cosyKey: crypto.publicEncrypt({
      key: pub,
      padding: crypto.constants.RSA_PKCS1_PADDING, // 注意：PKCS1 非 OAEP
    }, Buffer.from(e, 'utf8')).toString('base64'),
    info: aesEncrypt(JSON.stringify(userInfo), e),
    uid: token.user.uid,
    key: e,
  };
}

export interface QwenAuthHeaders {
  authorization: string;
  cosyKey: string;
  cosyDate: string;
  cosyUser: string;
}

/** generateAuthToken 等价物：authorization + Cosy-Key/Cosy-Date/Cosy-User */
export function buildAuthHeaders(
  material: QwenSignMaterial,
  opts: { url: string; body: string; timestamp?: number },
): QwenAuthHeaders {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const header = {
    version: 'v1',
    requestId: crypto.randomUUID(),
    info: material.info,
    cosyVersion: '1.0.0',
    ideVersion: '1.0.0',
  };
  const o = Buffer.from(JSON.stringify(header), 'utf8').toString('base64');

  // path：url.pathname，去 query；/algo 前缀去掉
  let p = opts.url;
  try { p = new URL(opts.url).pathname; } catch { /* 保留原样 */ }
  const q = p.indexOf('?');
  if (q > 0) p = p.substring(0, q);
  if (p.startsWith('/algo')) p = p.slice(5);

  const signStr = `${o}\n${material.cosyKey}\n${ts}\n${opts.body}\n${p}`;
  const sig = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');

  return {
    authorization: `Bearer COSY.${o}.${sig}`,
    cosyKey: material.cosyKey,
    cosyDate: String(ts),
    cosyUser: material.uid,
  };
}
