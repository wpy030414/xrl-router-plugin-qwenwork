#!/usr/bin/env tsx
/**
 * login-web.ts — qwenwork 网页登录（device flow，无需千问办公 App）。
 *
 * 1. 生成 PKCE + nonce + machineId → 拼 selectAccounts 登录 URL
 * 2. 打开系统浏览器 → 用户钉钉扫码（完成态登记在服务端，无需本地回调）
 * 3. 本地每秒轮询 deviceToken/poll → 拿到 {token, refresh_token}
 * 4. adoptCredential + forceRefresh 验证刷新链 → 备份 QWEN_KEYS 到 .env
 *
 * 对应 pnpm log-in（App 链路的旧抓取工具为 pnpm capture-key / pnpm log-in:app）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/config';
import { adoptCredential, forceRefresh } from '../src/auth';
import { extractUidFromToken } from '../src/client';
import { buildAuthUrl, buildDeviceLoginParams, DeviceFlowError, openInBrowser, pollDeviceFlow } from '../src/deviceLogin';
import { assertEnvGitIgnored, writeEnvValue } from '../src/envStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../');

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 12)}…${s.slice(-4)}` : '(无效)');

export async function main(): Promise<void> {
  console.log('🔑 xrl-router-plugin-qwenwork · 网页登录（device flow，无需千问办公 App）\n');

  // 0. 安全守卫必须最先：后续 forceRefresh 会经 syncEnvRefreshToken 无守卫写 .env
  if (!assertEnvGitIgnored(REPO_ROOT)) {
    process.exitCode = 1;
    return;
  }

  // 1. 登录参数 + URL（首跑会生成并持久化 QWEN_MACHINE_ID）
  const handles = buildDeviceLoginParams(REPO_ROOT);
  const url = buildAuthUrl(handles);
  const bar = '─'.repeat(78);
  console.log('▶ 请在浏览器完成钉钉登录（扫码）：');
  console.log(`\n${bar}\n${url}\n${bar}\n`);
  if (!process.argv.includes('--no-open')) {
    const opened = openInBrowser(url);
    console.log(opened ? '✅ 已尝试打开系统浏览器（未自动打开请手动复制上方 URL）' : '⚠️ 自动打开浏览器失败，请手动复制上方 URL 到浏览器');
  }

  // 2. 轮询等待登录完成
  console.log('▶ 等待登录完成（每秒轮询，最长 %d 秒）…', Math.round(settings.qwenLoginTimeoutMs / 1000));
  let lastPrint = -1;
  let cred;
  try {
    cred = await pollDeviceFlow(handles, {
      onWait: (elapsed) => {
        const sec = Math.floor(elapsed / 1000);
        if (sec - lastPrint >= 15) {
          lastPrint = sec;
          console.log(`   …已等待 ${sec}s`);
        }
      },
    });
  } catch (e: any) {
    fail(e instanceof Error ? e.message : String(e));
    if (!(e instanceof DeviceFlowError)) console.error(`   (${e.constructor?.name})`);
    process.exitCode = 1;
    return;
  }
  ok('登录成功！');
  console.log(`   access token：${mask(cred.token)}（有效期至 ${new Date(cred.expiresAt).toISOString()}）`);
  console.log(`   refresh token：${mask(cred.refreshToken)}`);
  if (cred.refreshTokenExpiresAt) {
    console.log(`   refresh token 有效期至：${new Date(cred.refreshTokenExpiresAt).toISOString()}`);
  }

  // 3. 采纳凭据 + 验证刷新链（forceRefresh 内部会轮换 refresh token 并同步 .env）
  adoptCredential({
    token: cred.token,
    refreshToken: cred.refreshToken,
    user: { uid: extractUidFromToken(cred.token) },
    expiresAt: cred.expiresAt,
    refreshTokenExpiresAt: cred.refreshTokenExpiresAt,
  });
  let finalRefreshToken = cred.refreshToken;
  let verified = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const next = await forceRefresh();
      finalRefreshToken = next.refreshToken;
      verified = true;
      ok(`刷新链验证成功：新 access token ${mask(next.token)}（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
      break;
    } catch (e: any) {
      console.warn(`⚠️ 刷新链验证第 ${attempt} 次失败：${e.message}`);
    }
  }
  if (!verified) {
    console.warn('⚠️ 刷新链未验证通过 —— 已备份登录返回的原始 refresh token；若 serve 报 401 请重跑 pnpm log-in');
  }

  // 4. 备份 QWEN_KEYS（轮换后的值；未验证成功则回退原始值）
  if (!writeEnvValue('QWEN_KEYS', finalRefreshToken, REPO_ROOT)) {
    process.exitCode = 1;
    return;
  }
  ok(`refresh token 已备份到 ${path.join(REPO_ROOT, '.env')} 的 QWEN_KEYS（mode 600，git-ignored）`);

  // 5. App 共存提示（检测到 App 登录态时保持不动：两条链独立，互不影响）
  if (fs.existsSync(settings.qwenOauthTokenPath)) {
    console.log(`ℹ️ 检测到千问办公 App 登录态（${settings.qwenOauthTokenPath}），已保持不动。`);
  }

  console.log('\n🎉 完成！pnpm serve 即可使用（无需千问办公 App）。');
}

// 直接运行（pnpm log-in）时执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
}
