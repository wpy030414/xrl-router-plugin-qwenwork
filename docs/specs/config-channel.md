# config-channel: 配置单例

## 目标

加载环境变量生成全局 `settings` 对象，为所有模块提供统一配置源喵～

## 输入输出

**输入：**
- `process.env`：环境变量（`.env` 文件通过 `dotenv.config()` 加载）

**输出：**
- `settings`：`Settings` 对象，含所有配置项

## 关键约束

### config.ts — Settings 接口

`dotenv.config()` 在模块顶层调用，加载 `.env` 到 `process.env` 喵。

#### 环境变量

| 环境变量 | 字段 | 默认值 |
|---|---|---|
| `QWEN_PORT` | `port` | `19067` |
| `AVAILABLE_MODELS` | `availableModels` | `qwork-advanced,qwork-auto,qwork-lite,qmodel_latest` |
| `XRL_ROUTER_URL` | `xrlRouterUrl` | `http://localhost:19068` |
| `QWEN_KEYS` | （auth.ts 读取） | — |
| `QWEN_OAUTH_TOKEN_PATH` | `qwenOauthTokenPath` | Windows: `%APPDATA%/QwenWorkCN/auth-v2.dat`；macOS: `~/Library/Application Support/QwenWorkCN/auth-v2.dat` |
| `QWEN_USER_DATA_DIR` | `qwenUserDataDir` | Windows: `%APPDATA%/QwenWorkCN`；macOS: `~/Library/Application Support/QwenWorkCN`（Windows 读 Local State 的 os_crypt 密钥） |
| `QWEN_KEYCHAIN_SERVICE` | `qwenKeychainService` | `QwenWorkCN Safe Storage`（仅 macOS 使用） |
| `QWEN_KEYCHAIN_ACCOUNT` | `qwenKeychainAccount` | `QwenWorkCN Key`（仅 macOS 使用） |
| `QWEN_BASE_URL` | `qwenBaseUrl` | `https://gateway.qwenwork.cn` |
| `QWEN_DEVICE_REFRESH_PATH` | `qwenDeviceRefreshPath` | `/api/v1/deviceToken/refresh` |
| `QWEN_REFRESH_INTERVAL_MS` | `qwenRefreshIntervalMs` | `600000`（10min） |
| `QWEN_RSA_PUBLIC_KEY_PATH` | `qwenRsaPublicKeyPath` | `''`（空 = 用内嵌） |
| `QWEN_TARGET` | `qwenTarget` | `c` |

### env() 工具函数

```typescript
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}
```

空字符串视为未设置 → 使用 fallback 喵。

## 验收标准

- [ ] `settings.port` 为数字类型（`parseInt`）
- [ ] 未设端口变量 → 默认 `19067`
- [ ] 设 `QWEN_PORT=19070` → 端口 `19070`
- [ ] `settings.availableModels` 为去空格的字符串数组
- [ ] 设置 `QWEN_BASE_URL=https://custom.api` → `settings.qwenBaseUrl` 为该值
- [ ] 未设 `QWEN_BASE_URL` → 默认 `https://gateway.qwenwork.cn`

## 已知边界

- `AVAILABLE_MODELS` split 后 `filter(Boolean)` 去掉空项（尾部逗号不会产空元素）
- `QWEN_OAUTH_TOKEN_PATH` 默认用 `os.homedir()` 拼接，依赖运行用户 HOME 正确
- `env()` 不区分 `undefined` 和空字符串 — 两者都走 fallback
