/**
 * qwenwork/login.ts — OAuth2 Device Authorization Grant 登录流程
 *
 * 逆向自千问办公 v1.2.0 asar：
 * - OAuth provider: Ory Hydra（https://qwenwork.cn/.well-known/openid-configuration）
 * - client_id: e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb（Electron 主进程硬编码）
 * - device auth endpoint: POST /oauth2/device/auth
 * - token endpoint: POST /auth/oauth/token
 *
 * 流程：动态注册客户端 → device auth → 浏览器验证 → 轮询 token → 持久化到 .env QWEN_KEYS
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../config';

const QWENWORK_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

interface TokenResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface UserInfo {
  uid: string;
  name?: string;
  email?: string;
}

// ── 工具 ──────────────────────────────────────────────────

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 浏览器打不开不影响
  }
}

function extractUserInfo(accessToken: string): UserInfo {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      uid: payload.sub || payload.uid || payload.user_id || '',
      name: payload.name,
      email: payload.email,
    };
  } catch {
    return { uid: '' };
  }
}

function persistToEnv(refreshToken: string): void {
  const envPath = path.resolve(process.cwd(), '.env');
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));
  if (idx >= 0) lines[idx] = `QWEN_KEYS=${refreshToken}`;
  else lines.push(`QWEN_KEYS=${refreshToken}`);
  fs.writeFileSync(envPath, lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n', { mode: 0o600 });
  console.log(`✅ Refresh token 已写入 .env (QWEN_KEYS)`);
}

// ── Device Authorization Grant ────────────────────────────

async function deviceFlow(): Promise<TokenResult> {
  // 尝试动态注册支持 device_code 的客户端
  let clientId: string;

  console.log('   尝试动态注册支持 device_code 的客户端...');
  try {
    const regResp = await fetch(`${settings.qwenOauthBaseUrl}/oauth2/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'xrl-router-plugin-qwenwork',
        redirect_uris: ['http://localhost/callback'],
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        response_types: ['none'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access',
      }),
    });

    if (regResp.ok) {
      const regData = await regResp.json() as any;
      clientId = regData.client_id;
      console.log(`   ✅ 动态注册成功: ${clientId}`);
    } else {
      console.log(`   ⚠️  动态注册失败，使用硬编码 client_id`);
      clientId = QWENWORK_CLIENT_ID;
    }
  } catch (err: any) {
    console.log(`   ⚠️  动态注册异常，使用硬编码 client_id`);
    clientId = QWENWORK_CLIENT_ID;
  }

  console.log(`\n   使用 client_id: ${clientId}`);

  const deviceAuthUrl = `${settings.qwenOauthBaseUrl}/oauth2/device/auth`;
  const resp = await fetch(deviceAuthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: 'openid',
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Device authorization 失败: ${resp.status}\n${text.substring(0, 200)}`);
  }

  const data = await resp.json() as any;
  console.log(`   ✅ Device authorization 成功`);

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in = 600,
    interval = 5,
  } = data;

  const verifyUrl = verification_uri_complete || verification_uri;
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (user_code) console.log(`📋 验证码: ${user_code}`);
  console.log(`🌐 验证地址: ${verifyUrl}`);
  console.log(`⏰ 有效期: ${Math.floor(expires_in / 60)} 分钟`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  openBrowser(verifyUrl);

  console.log('⏳ 等待验证...');
  const tokenUrl = `${settings.qwenOauthBaseUrl}/auth/oauth/token`;
  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));
    process.stdout.write('.');

    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id: clientId,
      }).toString(),
    });

    if (tokenResp.ok) {
      const tokenData = await tokenResp.json() as any;
      console.log('\n   ✅ Token 获取成功!');
      return {
        access_token: tokenData.access_token || '',
        refresh_token: tokenData.refresh_token || '',
        expires_in: tokenData.expires_in || 3600,
      };
    }

    const errorText = await tokenResp.text();
    let err: any = {};
    try {
      err = JSON.parse(errorText);
    } catch {}

    const errorCode = err.error || '';

    if (errorCode === 'authorization_pending') {
      continue;
    }
    if (errorCode === 'slow_down') {
      pollInterval += 5000;
      continue;
    }
    if (errorCode === 'expired_token') {
      throw new Error('验证码已过期');
    }
    if (errorCode === 'access_denied') {
      throw new Error('用户拒绝授权');
    }

    throw new Error(`Token 轮询失败: ${errorCode}\n${err.error_description || errorText.substring(0, 200)}`);
  }

  throw new Error('等待超时');
}

// ── 主流程 ────────────────────────────────────────────────

export async function webLogin(): Promise<{ refreshToken: string; user: UserInfo }> {
  console.log('🔐 开始 Device Authorization Grant 登录流程...\n');

  const result = await deviceFlow();

  if (!result.refresh_token && !result.access_token) {
    throw new Error('登录失败：未获取到 token');
  }

  // 验证 refresh token 并轮换
  if (result.refresh_token) {
    console.log('\n🔄 验证 refresh token...');
    try {
      const refreshResp = await fetch(`${settings.qwenBaseUrl}${settings.qwenDeviceRefreshPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: result.refresh_token, target: settings.qwenTarget }),
      });
      if (refreshResp.ok) {
        const data = (await refreshResp.json()) as any;
        if (data.refresh_token) {
          result.refresh_token = data.refresh_token;
          result.access_token = data.device_token || data.token || result.access_token;
          console.log('✅ Refresh 链验证成功');
        }
      }
    } catch {}
  }

  const user = result.access_token ? extractUserInfo(result.access_token) : { uid: '' };
  if (user.uid) console.log(`👤 用户: ${user.name || user.uid}`);

  persistToEnv(result.refresh_token);

  return { refreshToken: result.refresh_token, user };
}

// ── CLI 入口 ──────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('login.ts') ||
  process.argv[1].endsWith('login.js')
);

if (isMain) {
  webLogin()
    .then(() => {
      console.log('\n🎉 登录完成！现在可以运行 pnpm serve 启动插件。');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ 登录失败:', err.message);
      process.exit(1);
    });
}
