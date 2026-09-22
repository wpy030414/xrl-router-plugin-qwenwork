import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

/** qwenwork 通道默认 auth-v2.dat 路径（按平台：Windows %APPDATA% / macOS ~/Library/Application Support） */
function detectQwenOauthTokenPath(): string {
  const envVal = process.env.QWEN_OAUTH_TOKEN_PATH;
  if (envVal) return envVal;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QwenWorkCN', 'auth-v2.dat');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'QwenWorkCN', 'auth-v2.dat');
}

/** qwenwork 通道默认 Electron userData 目录（Windows 取 Local State 的 os_crypt 密钥） */
function detectQwenUserDataDir(): string {
  const envVal = process.env.QWEN_USER_DATA_DIR;
  if (envVal) return envVal;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QwenWorkCN');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'QwenWorkCN');
}

export interface Settings {
  port: number;
  availableModels: string[];

  // —— qwenwork 通道（gateway.qwenwork.cn / 智谱 GLM）——
  qwenBaseUrl: string;              // 推理网关 base
  qwenOauthTokenPath: string;       // auth-v2.dat 路径（safeStorage 加密的 OAuth token）
  qwenUserDataDir: string;          // Electron userData 目录（Windows 取 Local State 的 os_crypt 密钥）
  qwenKeychainService: string;      // Keychain 中 Electron SafeStorage service 名（仅 macOS）
  qwenKeychainAccount: string;      // Keychain account 名（仅 macOS）
  qwenDeviceRefreshPath: string;    // deviceToken/refresh 相对路径
  qwenRsaPublicKeyPath: string;     // asar 硬编码 RSA 公钥 PEM（未提供则用内嵌）
  qwenRefreshIntervalMs: number;    // token 自动刷新检查间隔
  qwenTarget: string;               // deviceToken/refresh 的 target 参数（"c" = 个人）

  // —— xrl-router 集成配置 ——
  xrlRouterUrl: string;
}

/** 按通道读 env 键（qwenwork 读 QWEN_*，跨通道通用读 * 无前缀） */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

/**
 * 解析监听端口：默认端口 19067，可分别同时启动。
 * 各通道只读专用键（QWEN_PORT），不再支持共用 PORT——避免两通道取到同一端口冲突喵。
 */
function resolvePort(): number {
  return parseInt(env('QWEN_PORT', '19067'), 10);
}

export const settings: Settings = {
  port: resolvePort(),
  availableModels: (process.env.AVAILABLE_MODELS || 'qwork-advanced,qwork-auto,qwork-lite,qmodel_latest')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // —— qwenwork 通道 ——
  qwenBaseUrl: env('QWEN_BASE_URL', 'https://gateway.qwenwork.cn'),
  qwenOauthTokenPath: detectQwenOauthTokenPath(),
  qwenUserDataDir: detectQwenUserDataDir(),
  qwenKeychainService: env('QWEN_KEYCHAIN_SERVICE', 'QwenWorkCN Safe Storage'), // 仅 macOS 使用
  qwenKeychainAccount: env('QWEN_KEYCHAIN_ACCOUNT', 'QwenWorkCN Key'),         // 仅 macOS 使用
  qwenDeviceRefreshPath: env('QWEN_DEVICE_REFRESH_PATH', '/api/v1/deviceToken/refresh'),
  qwenRsaPublicKeyPath: env('QWEN_RSA_PUBLIC_KEY_PATH', ''),
  qwenRefreshIntervalMs: parseInt(env('QWEN_REFRESH_INTERVAL_MS', '600000'), 10), // 10min
  qwenTarget: env('QWEN_TARGET', 'c'),

  // xrl-router 集成
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
