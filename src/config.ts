import dotenv from 'dotenv';

dotenv.config();

export interface Settings {
  port: number;
  availableModels: string[];

  // —— qwenwork 通道（gateway.qwenwork.cn / 智谱 GLM）——
  qwenBaseUrl: string;              // 推理网关 base
  qwenOauthBaseUrl: string;         // OAuth 基础 URL（https://qwenwork.cn）
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
  qwenOauthBaseUrl: env('QWEN_OAUTH_BASE_URL', 'https://qwenwork.cn'),
  qwenDeviceRefreshPath: env('QWEN_DEVICE_REFRESH_PATH', '/api/v1/deviceToken/refresh'),
  qwenRsaPublicKeyPath: env('QWEN_RSA_PUBLIC_KEY_PATH', ''),
  qwenRefreshIntervalMs: parseInt(env('QWEN_REFRESH_INTERVAL_MS', '600000'), 10), // 10min
  qwenTarget: env('QWEN_TARGET', 'c'),

  // xrl-router 集成
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
