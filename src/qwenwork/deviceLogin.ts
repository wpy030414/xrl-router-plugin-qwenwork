/**
 * qwenwork/deviceLogin.ts — 网页 device-flow 登录（无千问办公 App 的凭据自举）。
 *
 * 来源：对 QwenWorkCN 1.2.5（win）app.asar 的逆向 + 2026-09-30 在线探活：
 * - 登录页：{qwenAuthBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id&redirect_uri
 *   用户在浏览器完成钉钉扫码，完成态登记在服务端 —— 无需本地回调监听
 *   （redirect_uri=qwenwork-cn:// 是 App 深链回跳参数，对纯网页登录无意义）
 * - 轮询：GET {qwenBaseUrl}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
 *   · 404 或 400{errorCode:INVALID_DEVICE_FLOW} = 进行中，继续轮询（探活实证未知 nonce → 400）
 *   · 成功返回 {token, refresh_token, nonce, code_challenge, code_challenge_method, expires_at?, …}
 *   · 必须校验 nonce + code_challenge + method 三连绑定（防串号采纳他人凭据）
 * - 拿到的 refresh_token 与 App 链路同构（ory_rt_ 前缀），直接交给 auth.ts 的
 *   deviceToken/refresh 续期；与 App 已有链路服务端互不失效（两条独立链）
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { settings } from '../config';
import { readEnvValue, writeEnvValue } from './envStore';

const PKCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const REDIRECT_URI = 'qwenwork-cn://';
const POLL_INTERVAL_MS = 1_000;
const POLL_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;

/** 仿千问办公 1.2.5 客户端头（探活实证非必需，防御性携带以贴近真实流量） */
const APP_CLIENT_HEADERS: Record<string, string> = {
  'X-QwenWork-Version': '1.2.5',
  'X-QwenWork-Release-Version': '1.2.5',
  'X-QwenWork-Platform': process.platform,
  'X-QwenWork-Arch': process.arch,
  'X-QwenWork-Channel': 'release',
};

export interface DeviceLoginHandles {
  verifier: string;
  challenge: string;
  nonce: string;
  machineId: string;
}

export interface DeviceFlowCredential {
  /** OAuth access token（JWT，~1h） */
  token: string;
  /** ory_rt_ refresh token（与 App 链路同构） */
  refreshToken: string;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  /** refresh token 过期时间（ms epoch，响应可能不返回） */
  refreshTokenExpiresAt?: number;
  nonce: string;
  challenge: string;
}

export class DeviceFlowError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

/** PKCE verifier：字符集与长度分布对齐 App（43 + rand(0..85) → 43..128，CSPRNG） */
function makeVerifier(): string {
  const len = 43 + crypto.randomInt(0, 86);
  let s = '';
  while (s.length < len) s += PKCE_CHARS[crypto.randomInt(0, PKCE_CHARS.length)];
  return s;
}

/** machineId 解析：env 显式覆盖 > .env QWEN_MACHINE_ID > 首次生成并持久化 */
export function resolveMachineId(repoRoot?: string): { id: string; source: 'env' | 'file' | 'generated' } {
  if (settings.qwenMachineId) return { id: settings.qwenMachineId, source: 'env' };
  const saved = readEnvValue('QWEN_MACHINE_ID', repoRoot);
  if (saved) return { id: saved, source: 'file' };
  const id = crypto.randomUUID();
  if (writeEnvValue('QWEN_MACHINE_ID', id, repoRoot)) {
    console.log('[qwenwork] 已生成并持久化设备标识（.env QWEN_MACHINE_ID）');
  } else {
    console.warn('[qwenwork] QWEN_MACHINE_ID 未能持久化（.env 未 git-ignored？），本次会话使用内存值');
  }
  return { id, source: 'generated' };
}

/** 生成一组登录参数（PKCE + nonce + machineId） */
export function buildDeviceLoginParams(repoRoot?: string): DeviceLoginHandles {
  const verifier = makeVerifier();
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    nonce: crypto.randomUUID(),
    machineId: resolveMachineId(repoRoot).id,
  };
}

/** 拼登录页 URL（浏览器打开 → 钉钉扫码） */
export function buildAuthUrl(h: DeviceLoginHandles, loginHint?: string): string {
  const u = new URL('/device/selectAccounts', settings.qwenAuthBase);
  u.searchParams.set('challenge', h.challenge);
  u.searchParams.set('challenge_method', 'S256');
  u.searchParams.set('nonce', h.nonce);
  u.searchParams.set('machine_id', h.machineId);
  u.searchParams.set('client_id', settings.qwenClientId);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

/** 尽力打开系统浏览器（best-effort：失败返回 false，调用方应同时打印 URL 兜底） */
export function openInBrowser(url: string): boolean {
  try {
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 解析过期时间字段（expires_at ISO 串优先，其次 expires_in 秒数；都缺 → undefined） */
function parseExpiry(at: unknown, expiresIn: unknown): number | undefined {
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return Date.parse(at);
  if (typeof expiresIn === 'number') return Date.now() + expiresIn * 1000;
  return undefined;
}

/**
 * 轮询 deviceToken/poll 直到登录完成。
 * - 1s 间隔，总超时默认 settings.qwenLoginTimeoutMs（300s）
 * - 404 / 400(INVALID_DEVICE_FLOW) = 进行中；其余非 2xx 抛 DeviceFlowError
 * - 连续网络错误 ≥5 次中止；成功前校验 nonce/challenge/method 绑定
 */
export async function pollDeviceFlow(
  h: DeviceLoginHandles,
  opts: { timeoutMs?: number; intervalMs?: number; onWait?: (elapsedMs: number, lastStatus: number) => void } = {},
): Promise<DeviceFlowCredential> {
  const timeoutMs = opts.timeoutMs ?? settings.qwenLoginTimeoutMs;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let failures = 0;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    try {
      const url = new URL(settings.qwenDevicePollPath, settings.qwenBaseUrl);
      url.searchParams.set('nonce', h.nonce);
      url.searchParams.set('verifier', h.verifier);
      url.searchParams.set('challenge_method', 'S256');
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Request-Id': crypto.randomUUID(), ...APP_CLIENT_HEADERS },
        signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
      });
      lastStatus = res.status;

      if (res.status === 404 || res.status === 400) {
        // 400 需区分：INVALID_DEVICE_FLOW = nonce 尚未完成（或未登记），其余 400 是协议错误
        if (res.status === 400) {
          const j = await res.json().catch(() => null) as any;
          if (j?.errorCode !== 'INVALID_DEVICE_FLOW') {
            throw new DeviceFlowError(`deviceToken/poll 400: ${j?.errorMessage ?? '未知错误'}`, 400);
          }
        }
        failures = 0;
        opts.onWait?.(Date.now() - startedAt, lastStatus);
        await sleep(intervalMs);
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new DeviceFlowError(`deviceToken/poll 失败: HTTP ${res.status} ${detail}`, res.status);
      }

      const j = await res.json() as any;
      // 三连绑定校验（防串号）：nonce + challenge + method 必须逐字匹配
      if (j.nonce !== h.nonce || j.code_challenge !== h.challenge || j.code_challenge_method !== 'S256') {
        throw new DeviceFlowError('poll 响应绑定校验失败（nonce/challenge 不匹配），拒绝采纳');
      }
      if (typeof j.token !== 'string' || typeof j.refresh_token !== 'string' || !j.token || !j.refresh_token) {
        throw new DeviceFlowError('poll 响应缺少 token/refresh_token');
      }
      return {
        token: j.token,
        refreshToken: j.refresh_token,
        expiresAt: parseExpiry(j.expires_at, j.expires_in) ?? Date.now() + 3600_000,
        refreshTokenExpiresAt: parseExpiry(j.refresh_token_expires_at, j.refresh_token_expires_in),
        nonce: j.nonce,
        challenge: j.code_challenge,
      };
    } catch (e: any) {
      if (e instanceof DeviceFlowError) throw e; // 协议错误：致命
      failures += 1; // 网络错误（含单请求超时）：容忍至 MAX_CONSECUTIVE_FAILURES
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw new DeviceFlowError(`连续 ${failures} 次网络错误: ${e.message}`);
      }
      opts.onWait?.(Date.now() - startedAt, lastStatus);
      await sleep(intervalMs);
    }
  }
  const hint =
    lastStatus === 400 || lastStatus === 404
      ? '（全程未检测到登录完成——请确认浏览器已打开登录页并完成扫码）'
      : '';
  throw new DeviceFlowError(`${Math.round(timeoutMs / 1000)} 秒内未完成登录，可重跑 pnpm login${hint}`, lastStatus);
}

/** 组合流：生成参数 → 回调 authUrl（打印/开浏览器）→ 轮询 */
export async function runDeviceLogin(
  opts: {
    loginHint?: string;
    openBrowser?: boolean;
    timeoutMs?: number;
    repoRoot?: string;
    onAuthUrl?: (url: string) => void;
    onWait?: (elapsedMs: number, lastStatus: number) => void;
  } = {},
): Promise<DeviceFlowCredential> {
  const h = buildDeviceLoginParams(opts.repoRoot);
  const url = buildAuthUrl(h, opts.loginHint);
  opts.onAuthUrl?.(url);
  if (opts.openBrowser !== false) openInBrowser(url);
  return pollDeviceFlow(h, { timeoutMs: opts.timeoutMs, onWait: opts.onWait });
}
