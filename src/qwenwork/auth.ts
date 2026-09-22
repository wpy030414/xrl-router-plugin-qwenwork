/**
 * qwenwork/auth.ts — Token 管理（网页登录版）。
 *
 * Token 来源（按优先级）：
 *   ① 内存缓存（有效期内直接返回）
 *   ② .env QWEN_KEYS（pnpm login 写入的 refresh token）
 *
 * 刷新链路：deviceToken/refresh（轮换式，写回 .env）。
 * 不再依赖千问办公 App 的 auth-v2.dat / safeStorage。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { settings } from '../config';

export interface QwenUserInfo {
  uid: string;
  name?: string;
  email?: string;
}

export interface QwenTokenState {
  /** OAuth access token（JWT，~1h 有效，作为 encryptUserInfo 的 security_oauth_token） */
  token: string;
  /** ory_rt_ 刷新令牌（deviceToken/refresh 轮换） */
  refreshToken: string;
  user: QwenUserInfo;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
}

/** 从 OAuth access token（JWT）payload 解出 uid */
function extractUidFromToken(token: string): string {
  try {
    const part = token.split('.')[1] || '';
    const json = JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return json.sub || json.uid || json.user_id || '';
  } catch {
    return '';
  }
}

/** deviceToken/refresh：换取新 token + 轮换 refresh token + 写回 .env */
export async function refreshDeviceToken(refreshToken: string): Promise<QwenTokenState> {
  const url = `${settings.qwenBaseUrl}${settings.qwenDeviceRefreshPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, target: settings.qwenTarget }),
  });
  if (!res.ok) {
    throw new Error(`deviceToken/refresh 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as any;
  const token = j.device_token ?? j.token;
  const rt = j.refresh_token;
  if (typeof token !== 'string' || typeof rt !== 'string') {
    throw new Error('deviceToken/refresh 响应缺 device_token/refresh_token');
  }
  const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : Date.now() + 3_600_000;

  // 写回 .env（轮换后的新 refresh token）
  syncEnvRefreshToken(rt);

  const uid = extractUidFromToken(token);
  return {
    token,
    refreshToken: rt,
    user: { uid, name: cached?.user.name, email: cached?.user.email },
    expiresAt,
  };
}

/** 从 .env 读 QWEN_KEYS（pnpm login 写入的 refresh token） */
function loadRefreshTokenFromEnv(): string | null {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    const v = parsed.QWEN_KEYS?.trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 同步 .env 的 QWEN_KEYS */
function syncEnvRefreshToken(refreshToken: string): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));
    if (idx >= 0) lines[idx] = `QWEN_KEYS=${refreshToken}`;
    else lines.push(`QWEN_KEYS=${refreshToken}`);
    fs.writeFileSync(
      envPath,
      lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n',
      { mode: 0o600 },
    );
  } catch (e: any) {
    console.warn(`[qwenwork] QWEN_KEYS 同步失败（不影响运行）: ${e.message}`);
  }
}

// —— token 缓存 ——
let cached: QwenTokenState | null = null;
let refreshing: Promise<QwenTokenState> | null = null;

/** 获取当前有效 token（缓存 + 临近过期自动刷新，单飞防并发） */
export async function getToken(): Promise<QwenTokenState> {
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) {
    return cached;
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    // 源①：内存缓存里的 refresh token（有就刷新）
    if (cached?.refreshToken) {
      try {
        const next = await refreshDeviceToken(cached.refreshToken);
        next.user = cached.user;
        cached = next;
        console.log(`[qwenwork] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qwenwork] token 刷新失败（${e.message}），尝试从 .env 重新加载…`);
      }
    }
    // 源②：.env QWEN_KEYS（pnpm login 写入的 refresh token）
    const rt = loadRefreshTokenFromEnv();
    if (rt) {
      try {
        const next = await refreshDeviceToken(rt);
        cached = next;
        console.log(`[qwenwork] 已用 QWEN_KEYS 刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qwenwork] QWEN_KEYS 刷新失败: ${e.message}`);
      }
    }
    throw new Error('无可用 token 源（请运行 pnpm login 重新登录）');
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/** 初始化 token 管理（启动时调用：尝试从 .env 预加载 token） */
export function initTokenManager(): void {
  const rt = loadRefreshTokenFromEnv();
  if (rt) {
    console.log('[qwenwork] .env QWEN_KEYS 已加载，token 将按需刷新');
  } else {
    console.warn('[qwenwork] .env QWEN_KEYS 为空，请先运行 pnpm login');
  }
}

/** 强制刷新一次（capture-key 用：验证刷新链 + 拿到新 token） */
export async function forceRefresh(): Promise<QwenTokenState> {
  const cur = await getToken();
  const next = await refreshDeviceToken(cur.refreshToken);
  next.user = cur.user;
  cached = next;
  return next;
}
