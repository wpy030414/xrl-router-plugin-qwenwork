#!/usr/bin/env tsx
/**
 * capture-qwenwork.ts — qwenwork 通道的「抓密钥」。
 *
 * qwenwork 无静态密钥，等价物是 auth-v2.dat（safeStorage 加密的 OAuth token）：
 *  1. 解密 auth-v2.dat（Keychain + PBKDF2 + AES）→ 验证登录态
 *  2. 强制刷新（deviceToken/refresh）→ 验证刷新链 + 轮换 refresh token
 *  3. 备份新 refresh token 到 .env 的 QWEN_KEYS（auth-v2.dat 损坏时可作灾备）
 *
 * 对应 pnpm capture-key / pnpm login。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../../src/config';
import { getToken, forceRefresh } from '../../src/qwenwork/auth';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 12)}…${s.slice(-4)}` : '(无效)');

/** 备份 refresh token 到 .env 的 QWEN_KEYS（不动其他变量） */
function writeEnvRefreshToken(refreshToken: string): boolean {
  let ignored = false;
  try {
    execSync(`cd "${REPO_ROOT}" && git check-ignore .env`, { stdio: 'ignore' });
    ignored = true;
  } catch { /* 未被 git 忽略 */ }
  if (!ignored) {
    fail('.env 未被 git 忽略！为防止泄露已中止。请先把 .env 加入 .gitignore');
    return false;
  }
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));

  if (idx >= 0) {
    lines[idx] = `QWEN_KEYS=${refreshToken}`;
  } else {
    lines.push(`QWEN_KEYS=${refreshToken}`);
  }
  const content = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ENV_PATH, content + '\n', { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  return true;
}

export async function main(): Promise<void> {
  console.log(`🔑 xrl-router-plugin · qwenwork 通道 token 验证（无需抓包，纯本机解密+刷新）\n`);

  // 1. 前置检查
  if (!fs.existsSync(settings.qwenOauthTokenPath)) {
    fail(`未找到 ${settings.qwenOauthTokenPath}`);
    console.error('   请先在千问办公 App 登录（生成 auth-v2.dat），再重跑。');
    return;
  }

  // 2. 解密 auth-v2.dat（macOS 弹 Keychain 授权；Windows 走 DPAPI，无弹窗）
  console.log(`▶ 解密 ${settings.qwenOauthTokenPath}（若弹钥匙串授权请点「允许」）…`);
  let state;
  try {
    state = await getToken();
  } catch (e: any) {
    fail(`解密失败：${e.message}`);
    console.error('   排查：已登录千问办公？Keychain 授权点了允许？');
    return;
  }
  ok(`登录用户：${state.user.name || state.user.uid}（${state.user.email || '无邮箱'}）`);
  ok(`access token：${mask(state.token)}（有效期至 ${new Date(state.expiresAt).toISOString()}）`);
  console.log(`   refresh token：${mask(state.refreshToken)}`);

  // 3. 强制刷新（验证刷新链）
  console.log('\n▶ 强制刷新 token（deviceToken/refresh）…');
  let next;
  try {
    next = await forceRefresh();
  } catch (e: any) {
    fail(`刷新失败：${e.message}`);
    console.error('   → token 可能已失效。重开千问办公让它重新登录刷新，再重跑。');
    return;
  }
  ok(`刷新成功：新 access token ${mask(next.token)}（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
  ok(`新 refresh token（已轮换）：${mask(next.refreshToken)}`);

  // 4. 备份 refresh token 到 QWEN_KEYS
  if (writeEnvRefreshToken(next.refreshToken)) {
    ok(`refresh token 已备份到 ${ENV_PATH} 的 QWEN_KEYS（mode 600，git-ignored）`);
  }

  console.log('\n🎉 完成！qwenwork 通道 token 有效且刷新链正常。直接 pnpm serve 即可使用。');
}

// 直接运行（pnpm capture-key）时执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
}
