# ARCHITECTURE.md — xrl-router-plugin-qwenwork 架构地图

> Version: 0.3.0 | Last updated: 2026-09-22
>
> 本文档描述稳定的结构关系，半年至一年不变。代码改动若偏离此处描述，需同步更新。

---

## 1. 架构概览

```
┌────────────┐     OpenAI API      ┌──────────────┐    WS register    ┌──────────────────────────┐
│  Client    │ ──────────────────> │  xrl-router  │ ────────────────> │ xrl-router-plugin-       │
│ (Claude    │  /v1/chat/          │  (路由/密钥/  │  (V24 契约，      │ qwenwork (Hono 网关)     │
│  Code etc) │  completions        │   重试)       │   占位凭证)       │                          │
└────────────┘                     └──────────────┘                   └───────────┬──────────────┘
                                                                                  │
                                                                     OAuth+Cosy签名
                                                                     SSE 外层解包
                                                                                  │
                                                                     ┌────────────▼────────────┐
                                                                     │ gateway.qwenwork.cn     │
                                                                     │ → 智谱 GLM-5.2          │
                                                                     │   Qwen3.7-plus          │
                                                                     │   DeepSeek-V4-flash     │
                                                                     │   Qwen3.8-max           │
                                                                     └─────────────────────────┘
```

### 设计原则

| 原则 | 说明 |
|------|------|
| **纯翻译层** | 只做 OpenAI ↔ 上游协议转换，不引入业务逻辑、不做 prompt engineering |
| **凭证自持** | V24 起 Router 不再管理密钥，插件用自身 OAuth token 访问上游；Router 发占位凭证 `Bearer xrl-router`，插件必须忽略 |
| **无状态** | 每个请求独立签名（Cosy），无 session 存储（token 缓存是性能优化，非业务状态） |
| **字节透传** | 仅解包外层 SSE wrapper（`{"body":"..."}`），内层 chunk 原样转发 |
| **自动恢复** | WS 断线指数退避重连（max 60s）；token 过期按需刷新 + auth-v2.dat 文件监听自动拾取；端口占用自动 kill |

---

## 2. 源码结构

```
src/
├── index.ts              # Hono 入口：路由 + 端口释放 + 优雅退出
├── config.ts             # 配置单例：env 读取
├── pluginClient.ts       # WebSocket 客户端：V24 注册（无 keys）/ 心跳 / 重连
└── qwenwork/
    ├── client.ts         # qwenwork 通道转发：签名 + SSE 解包 + tool_calls 标准化
    ├── auth.ts           # token 管理：safeStorage 解密/加密（Keychain/DPAPI）/ refresh / 文件监听 / 三源 fallback
    └── signer.ts         # 请求签名：AES-128-CBC + RSA_PKCS1 + MD5
```

### 依赖图

```
index.ts (Hono)
├── config.ts
├── pluginClient.ts ← config.ts
│   └── qwenwork/client.ts (displayName)
├── qwenwork/client.ts ← config.ts, qwenwork/auth.ts, qwenwork/signer.ts
│   ├── auth.ts ← config.ts
│   └── signer.ts ← config.ts, auth.ts (types)
└── qwenwork/auth.ts ← config.ts
```

---

## 3. 模块设计

### 3.1 config.ts — 配置单例

导出 `settings: Settings` 单例，进程启动时一次性从 `process.env` 读取，此后不再重新加载。

**Settings 接口**包含 qwenwork 通道的全部字段：

| 分组 | 字段 | 说明 |
|------|------|------|
| 通用 | `port`, `availableModels` | 监听端口（默认 19067）、可用模型列表 |
| qwenwork | `qwenBaseUrl`, `qwenOauthTokenPath`, `qwenUserDataDir`, `qwenKeychainService`, `qwenKeychainAccount`, `qwenDeviceRefreshPath`, `qwenRsaPublicKeyPath`, `qwenRefreshIntervalMs`, `qwenTarget` | 推理网关地址 + OAuth/签名参数 |
| xrl-router | `xrlRouterUrl` | WS 连接地址 |

### 3.2 pluginClient.ts — WS 客户端（V24 契约）

`PluginClient` 类，构造时立即连接 `ws://{host}/ws/plugin`。

#### 注册消息格式（V24）

```json
{
  "type": "register",
  "plugin_id": "plugin-qwenwork",
  "provider": {
    "kind": "chat_completions",
    "base_url": "http://localhost:19067",
    "api_path": "/v1/chat/completions"
  },
  "models": [
    { "model_id": "qwork-advanced", "display_name": "glm-5.2", "tier": "custom" },
    { "model_id": "qwork-auto", "display_name": "qwen3.7-plus", "tier": "custom" },
    { "model_id": "qwork-lite", "display_name": "deepseek-v4-flash", "tier": "custom" },
    { "model_id": "qmodel_latest", "display_name": "qwen3.8-max", "tier": "custom" }
  ],
  "workdir": "C:/Users/me/plugins/qwenwork"
}
```

**注意**：
- **不带 `keys` 字段** — Router V24 起严格拒绝带 keys 的 register，回 `{"type":"error","reason":"keys_not_supported"}` 并断开
- `kind` 为 `chat_completions`（不是 `openai`）
- `plugin_id` 为 `plugin-qwenwork`
- `workdir` 为伴生启动 cwd（COALESCE 语义）

#### 定时任务

| 任务 | 间隔 | 说明 |
|------|------|------|
| 心跳 | 30s | `{"type": "heartbeat"}`（不带 timestamp） |

#### 重连策略

指数退避：`delay = min(1000ms * 2^attempts, 60000ms)`。每次 `open` 事件重置 `reconnectAttempts = 0`。

### 3.3 qwenwork/client.ts — 签名转发

`forwardChatCompletions(body, res, authHeader)` 处理流程：

```
  getToken()              ← 缓存管理（5min 缓冲，按需刷新 + 文件监听自动拾取）
        │
        │ 缓存全失效？灾备 ↓
  extractRefreshToken(authHeader) ← 从占位凭证 Bearer xrl-router 中取（占位凭证本身不可用，仅作灾备触发）
        │
        ▼
  extractUidFromToken(jwt)  ← 解 JWT payload.sub / .uid / .user_id
        │
        ▼
  buildSignMaterial(token)  ← 随机 16B AES key → Cosy-Key + info
        │
        ▼
  buildAuthHeaders(m, url, body) ← MD5 签名 → Authorization: Bearer COSY.xxx.sig
        │
        ▼
  fetch(gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation)
        │
        ▼
  ┌─ stream=true:  外层 SSE 解包 → 内层 OpenAI chunk 透传
  └─ stream=false: delta 聚合 → 完整 chat.completion JSON
```

**Token 策略（方案 A）**：不再每请求都 refresh（避免插件与千问 App 轮换互踩导致 refresh token 快速失效）。`getToken()` 维护内存缓存，access token 剩余 > 5 分钟时直接返回，零网络开销。refresh 成功后写回 `auth-v2.dat`（双向同步），千问 App 下次读取时拿到同一个 refresh token，避免轮换互踩。

**静态头**：12 个固定值（`Cosy-Business-Product: qoder_work`, `Cosy-Scene: qwork`, `Cosy-Version: 1.0.47` 等）。

**展示名映射**：`qwork-advanced` → `glm-5.2`、`qwork-auto` → `qwen3.7-plus`、`qwork-lite` → `deepseek-v4-flash`、`qmodel_latest` → `qwen3.8-max`（注册给 xrl-router 的 display_name）。请求方向无别名映射——客户端发送什么 `model` 就透传什么，缺省时默认 `qwork-advanced`。

**流式 tool_calls 标准化**（适配 xrl-router 的转换逻辑）：
- xrl-router 把「某 index 的首个 chunk」解析为 `content_block_start`（input 字段），其余分片作为 `input_json_delta` 处理
- 因此首 chunk 必须发空 `arguments`（避免 `"{"` 被提前消耗），所有 arguments 片段（含首 chunk 的 `"{"`）原样发出
- 用 `seenToolCallIndex` 集合跟踪每个 index 的首 chunk

**非流式聚合**：读取所有 SSE chunk，拼接 `choices[0].delta` 的 `content` / `reasoning_content`（空值时字段不存在），`tool_calls` 按 `index` 分组拼接 `arguments`。

### 3.4 qwenwork/auth.ts — token 管理

#### decryptAuthFile — safeStorage 解密（按平台分派）

```
macOS（Keychain）                      Windows（DPAPI → AES-256-GCM）
Keychain ("QwenWorkCN Safe Storage" /  Local State 的 os_crypt.encrypted_key
 "QwenWorkCN Key")                     → base64 解码 → 去 "DPAPI\0" 前缀
    ▼ password (去尾换行)                → CryptUnprotectData(entropy=NULL)
PBKDF2(password, "saltysalt", 1003, 16, sha1)   ▼ 32B AES key
    ▼ aesKey (16 bytes)                v10 头后 = 12B nonce + 密文 + 16B tag
AES-128-CBC(key=aesKey, iv=0x20×16)    aes-256-gcm 解密
    ▼ 解密 auth-v2.dat (跳过 "v10" 3字节头)
JSON → QwenTokenState { token, refreshToken, user, expiresAt, raw }
```

macOS（Keychain + PBKDF2 + AES-128-CBC）与 Windows（Local State 取 key → DPAPI 解包 → AES-256-GCM）均支持；按 `process.platform` 分派，Windows 依赖系统自带 powershell.exe（零新依赖）。

#### refreshDeviceToken

`POST {qwenBaseUrl}/api/v1/deviceToken/refresh`，body `{ refresh_token, target: "c" }`。响应包含 `device_token`（新 access token）+ `refresh_token`（轮换后的新 refresh token）。刷新成功后：
1. `encryptAuthFile()` 写回 `auth-v2.dat`（双向同步）
2. `syncEnvRefreshToken()` 写回 `.env QWEN_KEYS`

写回 `auth-v2.dat` 使用与解密完全对称的加密方式（Windows: AES-256-GCM / macOS: AES-128-CBC），复用已有 AES key。

#### getToken — 三源 fallback

```
  缓存有效？（expiresAt > now + 5min）→ 直接返回，零网络请求
     │ 无效 ↓
  ① 内存缓存 refresh token → refreshDeviceToken()
     │ 失败 ↓ 重读 auth-v2.dat
  ② auth-v2.dat 解密 → token 有效直接用 / refresh token 刷新
     │ 失败 ↓
  ③ .env QWEN_KEYS → refreshDeviceToken()
     │ 失败 ↓
  throw Error
```

### 3.5 qwenwork/signer.ts — 请求签名

#### buildSignMaterial — encryptUserInfo 等价物

```
e = randomUUID().replace(/-/g, '').substring(0, 16)   // 随机 16 字节 AES key

userInfo = { uid, aid: "", name, email, security_oauth_token: accessToken }

info    = base64(AES-128-CBC(key=e, iv=e, JSON.stringify(userInfo)))
cosyKey = base64(RSA_PKCS1_PADDING(publicKey, e))
```

RSA 公钥：asar 硬编码（modulus 头 `c0f223…`），可通过 `QWEN_RSA_PUBLIC_KEY_PATH` 环境变量覆盖。注意使用 **PKCS1** 而非 OAEP padding。

#### buildAuthHeaders — generateAuthToken 等价物

```
header = { version: "v1", requestId: UUID, info, cosyVersion: "1.0.0", ideVersion: "1.0.0" }
o      = base64(JSON.stringify(header))

path   = URL.pathname（去掉 query string；若以 /algo 开头则去掉该前缀）
signStr = `${o}\n${cosyKey}\n${timestamp}\n${body}\n${path}`
sig    = md5(signStr)

Authorization = "Bearer COSY." + o + "." + sig
```

签名绑定 body + path + 时间戳，天然防重放。

### 3.6 index.ts — Hono 入口

#### 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 健康探针：返回 version / backend / endpoints |
| `GET` | `/health` | 健康检查：返回 status / backend / base_url |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions：调用 `forwardChatCompletions` |

#### killPortProcess — 跨平台端口释放

启动前自动释放目标端口，避免 `EADDRINUSE`：

- **macOS/Linux**：`lsof -ti :{port}` → `kill -9 {pids}`
- **Windows**：`netstat -ano` 过滤 `:{port}.*LISTENING` → `taskkill /F /PID {pids}`

#### 优雅退出

`SIGTERM` / `SIGINT` → `pluginClient.close()` → `process.exit(0)`。`close()` 清理心跳定时器、重连定时器、WS 连接。

---

## 4. 协议细节

### 4.1 OpenAI → qwenwork 映射

**请求头**：

```
Content-Type:  application/json
Accept:        text/event-stream
Authorization: Bearer COSY.{base64(header)}.{md5(sig)}
Cosy-Key:      {base64(RSA_PKCS1(pub, aesKey))}
Cosy-Date:     {unix_timestamp}
Cosy-User:     {uid}
x-model-key:   {model_id}
+ 12 个静态头（10 个 Cosy-* + Login-Version + x-model-source）
```

**请求体**：明文 JSON（**不**使用 `Encode=1`），自动补 `request_id` / `session_id`（UUID），删除 `encode` / `extra_body` 字段。

**响应**：

qwenwork 网关返回**双层 SSE**：
```
data: {"headers":{...},"body":"<内层 OpenAI chunk JSON>","statusCodeValue":200}
```

插件解包外层，取出 `body` 字段作为标准 OpenAI SSE chunk 透传：
```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"..."}}]}
```

非流式时聚合所有 delta 为完整 `chat.completion` 对象。

### 4.2 WebSocket 协议（V24 契约）

插件与 xrl-router 之间通过 WebSocket (`/ws/plugin`) 通信。

#### 消息类型

| 方向 | 类型 | 说明 |
|------|------|------|
| plugin → router | `register` | 启动时注册插件身份、模型列表、workdir（**无 keys**） |
| plugin → router | `heartbeat` | 每 30s 保活（无 timestamp） |
| router → plugin | `registered` | 注册确认（静默） |
| router → plugin | `reconnected` | 重连确认（静默） |
| router → plugin | `error` | 协议拒绝（`keys_not_supported` / `expected_register` / `empty_plugin_id` / `invalid_register`） |
| router → plugin | `deleted` | 插件已被用户删除（`plugin_ignored`） |

**废除的消息**：
- ~~`keys_update`~~ — V24 起发送即断开
- ~~register 带 `keys` 字段~~ — V24 起严格拒绝

#### 占位凭证

Router 对插件上游请求恒发占位值：`Authorization: Bearer xrl-router`。插件必须忽略，用自身凭证（OAuth token）访问上游。

---

## 5. 部署与运维

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_PORT` | `19067` | HTTP 监听端口 |
| `AVAILABLE_MODELS` | `qwork-advanced,qwork-auto,qwork-lite,qmodel_latest` | 逗号分隔的可用模型列表 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router WS 连接地址 |
| `QWEN_BASE_URL` | `https://gateway.qwenwork.cn` | 推理网关地址 |
| `QWEN_OAUTH_TOKEN_PATH` | `~/Library/Application Support/QwenWorkCN/auth-v2.dat` | OAuth token 的文件路径 |
| `QWEN_KEYCHAIN_SERVICE` | `QwenWorkCN Safe Storage` | macOS Keychain service 名 |
| `QWEN_KEYCHAIN_ACCOUNT` | `QwenWorkCN Key` | macOS Keychain account 名 |
| `QWEN_DEVICE_REFRESH_PATH` | `/api/v1/deviceToken/refresh` | token 刷新接口 |
| `QWEN_RSA_PUBLIC_KEY_PATH` | *(空，用内嵌公钥)* | RSA 公钥 PEM 文件路径（可选覆盖） |
| `QWEN_REFRESH_INTERVAL_MS` | `600000` | token 自动刷新检查间隔（10min） |
| `QWEN_TARGET` | `c` | deviceToken/refresh 的 target 参数 |
| `QWEN_KEYS` | *(空)* | 灾备 refresh token（逗号分隔） |

### 日志格式

所有日志输出到 stdout/stderr，前缀标识模块：

```
[PluginClient] Connected to xrl-router
[PluginClient] Reconnecting in 2000ms (attempt 2)
[qwenwork] token 已刷新（有效期至 2026-08-02T15:30:00.000Z）
[qwenwork] QWEN_KEYS 同步失败（不影响运行）: EACCES
[qwenwork] 流读取失败: network timeout
```

---

## 6. 故障排查

### 401 Unauthorized

- 原因：OAuth token 已失效或刷新失败
- 排查：确认 `auth-v2.dat` 存在且千问办公 App 已登录；或 `.env QWEN_KEYS` 有值
- 修复：重新运行 `pnpm login` 验证刷新链，或重开千问办公 App 触发文件更新

### 550 / 上游错误

- 原因：gateway.qwenwork.cn 后端繁忙
- 修复：由 xrl-router 层自动重试；若持续出现检查上游网关状态

### WebSocket 连接失败

- 表现：`[PluginClient] WebSocket error` + 指数退避重连日志
- 排查：
  1. 确认 `XRL_ROUTER_URL` 指向运行中的 xrl-router 实例
  2. 检查 xrl-router 的 `/ws/plugin` 端点是否可达
  3. 重连间隔最大 60s，连续失败时检查网络/firewall

### auth-v2.dat 解密失败 (macOS)

- 表现：`[qwenwork] auth-v2.dat 解密失败: auth 文件头不是 v10`
- 原因：千问办公 App 未登录（文件不存在）或文件格式变更
- 修复：打开千问办公 App 登录，触发 `auth-v2.dat` 重新生成；或依赖 `.env QWEN_KEYS` 自举

### token 所有源均失败

- 表现：`无可用 token 源（auth-v2.dat 缺失/失效且 QWEN_KEYS 为空）`
- 排查顺序：
  1. 千问办公 App 是否已登录（`auth-v2.dat` 存在？）
  2. `.env` 中 `QWEN_KEYS` 是否有值
  3. macOS Keychain 中 `QwenWorkCN Safe Storage` 条目是否存在（`security find-generic-password -s "QwenWorkCN Safe Storage" -a "QwenWorkCN Key"`）
