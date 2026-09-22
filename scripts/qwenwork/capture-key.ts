#!/usr/bin/env node
/**
 * 验证 QWEN_KEYS refresh token 是否可用，并刷新获取新 token。
 *
 * 流程：
 * 1. 从 .env 读取 QWEN_KEYS
 * 2. 调用 deviceToken/refresh 验证 token 有效
 * 3. 写回新 token 到 .env
 *
 * 用法：
 *   pnpm capture-key
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../../src/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '../../.env');

console.log('🔑 验证 QWEN_KEYS refresh token...\n');

// 1. 读取 .env
if (!fs.existsSync(ENV_PATH)) {
  console.error('❌ .env 文件不存在，请先运行 pnpm login');
  process.exit(1);
}

const envContent = fs.readFileSync(ENV_PATH, 'utf8');
const envVars = dotenv.parse(envContent);
const refreshToken = envVars.QWEN_KEYS;

if (!refreshToken) {
  console.error('❌ .env 中未找到 QWEN_KEYS，请先运行 pnpm login');
  process.exit(1);
}

console.log(`📝 读取到 refresh token: ${refreshToken.slice(0, 20)}...`);

// 2. 验证 refresh token
console.log('\n🔄 调用 deviceToken/refresh 验证 token...');
const url = `${settings.qwenBaseUrl}${settings.qwenDeviceRefreshPath}`;

try {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      target: settings.qwenTarget,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`❌ 验证失败: HTTP ${resp.status}`);
    console.error(`   ${text.slice(0, 200)}`);
    console.error('\n💡 refresh token 已失效，请重新运行 pnpm login');
    process.exit(1);
  }

  const data = (await resp.json()) as any;
  const newToken = data.device_token ?? data.token;
  const newRefreshToken = data.refresh_token;

  if (!newToken || !newRefreshToken) {
    console.error('❌ 响应缺少 device_token 或 refresh_token');
    process.exit(1);
  }

  console.log('✅ Refresh token 验证成功');
  console.log(`   新 access token: ${newToken.slice(0, 30)}...`);
  console.log(`   新 refresh token: ${newRefreshToken.slice(0, 20)}...`);

  // 3. 写回 .env
  const lines = envContent.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));
  if (idx >= 0) {
    lines[idx] = `QWEN_KEYS=${newRefreshToken}`;
  } else {
    lines.push(`QWEN_KEYS=${newRefreshToken}`);
  }

  fs.writeFileSync(
    ENV_PATH,
    lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n',
    { mode: 0o600 },
  );

  console.log('\n✅ 已更新 .env 中的 QWEN_KEYS');
  console.log('\n🎉 验证完成！插件可以正常使用。');
} catch (err: any) {
  console.error(`❌ 验证失败: ${err.message}`);
  process.exit(1);
}
