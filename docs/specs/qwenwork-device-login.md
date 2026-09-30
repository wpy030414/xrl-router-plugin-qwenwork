# qwenwork-device-login: 网页 Device-Flow 登录（无 App 自举）

## 目标

不依赖千问办公桌面 App，通过「浏览器扫码 + 本地轮询」的 device flow 直接获取第一份 qwenwork 凭据（access token + refresh token），写入 `.env QWEN_KEYS` 后交由 [qwenwork-token](./qwenwork-token.md) 的刷新链自动续期喵～

**入口**：`pnpm log-in`（`scripts/log-in.ts`）。App 链路的旧工具为 `pnpm log-in:app`（`scripts/log-in-app.ts`），两者可共存。

## 协议来源

QwenWorkCN 1.2.5（win，`app.asar`）逆向 + 2026-09-30 在线探活。千问 App 自身的登录就是这个 flow：`startDeviceFlow()` 生成 PKCE + nonce → 打开系统浏览器 → `pollDeviceToken()` 每秒轮询。完成态登记在**服务端**（浏览器侧完成钉钉 OAuth），客户端只需持 verifier 轮询即可拿到凭据 —— 因此无需 App、无需本地回调监听喵。

## 输入输出

**输入：**
- `buildDeviceLoginParams(repoRoot?)`：生成 `{ verifier, challenge, nonce, machineId }`
- `buildAuthUrl(handles, loginHint?)`：拼登录页 URL
- `openInBrowser(url)`：best-effort 打开系统浏览器
- `pollDeviceFlow(handles, opts?)`：轮询 poll 端点直到登录完成 / 超时
- `runDeviceLogin(opts?)`：组合流

**输出：**
- `DeviceFlowCredential`：`{ token, refreshToken, expiresAt, refreshTokenExpiresAt?, nonce, challenge }`
- refresh token 与 App 链路同构（`ory_rt_` 前缀），直接进 auth.ts 的 deviceToken/refresh 续期链

## 关键约束

### 登录 URL

```
{qwenAuthBase}/device/selectAccounts          # 默认 https://gateway.qwenwork.cn（挂在网关上）
  ?challenge=<base64url(sha256(verifier))>   # PKCE S256（43 字符）
  &challenge_method=S256
  &nonce=<randomUUID()>
  &machine_id=<uuid>                          # .env QWEN_MACHINE_ID 持久化
  &client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
  &redirect_uri=qwenwork-cn://                # App 深链回跳参数，网页登录无需监听
  [&login_hint=...]                           # 可选
```

**浏览器实际跳转链**（2026-09-30 探活实证，参数齐全时）：

```
GET gateway.qwenwork.cn/device/selectAccounts?…
  → 302 https://qwenwork.cn/oauth2/auth            ← Ory Hydra 授权页（网站域）
      ?client_id=qwenwork-desktop-app              ← 服务端换上自己的 OAuth client（非 e883ade2）
      &code_challenge=<服务端自生成 S256>           ← 我们传的 challenge/nonce 被绑定进 state
      &code_challenge_method=S256
      &redirect_uri=https://gateway.qwenwork.cn/oauth/callback
      &response_type=code&scope=openid profile email offline_access qwen_work
      &state=<服务端生成，绑定我们的 nonce+challenge>
  → 用户钉钉扫码授权
  → 回跳 gateway.qwenwork.cn/oauth/callback?code&state → 服务端兑换 code 并绑定到我们的 nonce/challenge
```

- **PKCE**：字符集 `A-Za-z0-9-._~`，长度 `43 + rand(0..85)`（对齐 App 的 `43 + Math.floor(Math.random()*86)`），`crypto.randomInt` 取字符（CSPRNG、无模偏）；challenge 为 `base64url` 无填充（恒 43 字符）
- **machineId**：优先级 env `QWEN_MACHINE_ID` > `.env QWEN_MACHINE_ID` > 首次生成 UUID 并持久化（复用即稳定，服务端视其为设备标识）
- `redirect_uri` 仅为服务端终态展示给 App 用的深链，对纯网页登录无意义
- 参数不合法时 selectAccounts 返回 400 `INVALID_DEVICE_FLOW`，`details.valueSummary.length` 为**整个 query 串长度**（排障时注意：它指向的是 query 总长而非单字段长度）

### 轮询 deviceToken/poll

```
GET {qwenBaseUrl}/api/v1/deviceToken/poll?nonce=..&verifier=..&challenge_method=S256
Headers: Accept: application/json          # 必需
         X-Request-Id: <randomUUID()>      # 必需
         X-QwenWork-Version: 1.2.5 等      # 仿 App 客户端头，探活实证非必需（防御性携带）
```

**轮询语义**：

| 情形 | 处理 |
|------|------|
| `404` | 进行中 → 间隔 1s 继续（asar 语义） |
| `400` + `errorCode: INVALID_DEVICE_FLOW` | 进行中 → 继续（探活实证：未知 nonce 即此响应；nonce 在登录页打开/完成前未登记） |
| `400` 其他 errorCode | 协议错误 → 抛 `DeviceFlowError` |
| 其他非 2xx | 抛 `DeviceFlowError`（带 httpStatus） |
| 网络错误（含单请求 10s 超时） | 连续 ≥5 次才中止，成功响应后计数清零 |
| 2xx | 进入绑定校验 |

- 总超时：`QWEN_LOGIN_TIMEOUT_MS`（默认 300s）
- **绑定校验三连（防串号采纳他人凭据）**：响应 `nonce` / `code_challenge` / `code_challenge_method` 必须与本地逐字匹配（`S256`）

**成功响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | OAuth access token（JWT，~1h） |
| `refresh_token` | string | `ory_rt_` 刷新令牌（此后走 deviceToken/refresh 轮换） |
| `nonce` / `code_challenge` / `code_challenge_method` | string | 绑定回显，必须校验 |
| `expires_at` / `expires_in` | ISO / number | access token 过期（缺失兜底 `now + 1h`） |
| `refresh_token_expires_at` / `refresh_token_expires_in` | ISO / number | refresh token 过期（可能缺失；缺失不猜测） |

### 登录脚本主流程（scripts/log-in.ts）

```
0. assertEnvGitIgnored()          # 安全守卫必须最先（后续 forceRefresh 会无守卫写 .env）
1. buildDeviceLoginParams()       # 首跑持久化 QWEN_MACHINE_ID
2. 打印 + 尽力打开浏览器           # --no-open 可跳过；URL 恒打印兜底
3. pollDeviceFlow()               # 每 15s 打印等待进度
4. 打印脱敏 token / 有效期 / refresh token 有效期
5. adoptCredential()              # 写入 auth.ts 内存缓存（无 raw → 永不写回 auth-v2.dat）
6. forceRefresh() 验证刷新链      # 失败重试 1 次；仍失败回退备份原始 refresh token 并 warn
7. writeEnvValue('QWEN_KEYS', 轮换后 refresh token)
8. 检测到 auth-v2.dat → 提示「App 登态保持不动（两条独立链）」
```

### 与 App 链路的关系

- 网页登录创建的是**新会话链**；App 自己的 `auth-v2.dat` 链在服务端依旧有效，两条 `ory_rt_` 链互不失效（轮换只发生在链内）
- 登录脚本**永不写** `auth-v2.dat`：poll 响应不含 App 所需完整 raw JSON（`loginDeviceId` 等），且无必要；`refreshDeviceToken` 的写回条件 `cached?.raw && exists` 天然不成立
- serve 的三源 fallback（缓存 → auth-v2.dat → QWEN_KEYS）不变：装不装 App 都能跑

## 验收标准

- [ ] `pnpm log-in` → 浏览器打开 selectAccounts → 钉钉扫码 → 打印脱敏 token + 有效期
- [ ] 成功后 `.env` 有 `QWEN_KEYS`（轮换后值），且首跑出现 `QWEN_MACHINE_ID`
- [ ] `.env` 写入前 `git check-ignore .env` 守卫生效（未忽略则中止）
- [ ] 不扫码 → 超时后明确提示「N 秒内未完成登录，可重跑 pnpm log-in」
- [ ] poll 响应 nonce/challenge 不匹配 → 拒绝采纳并报错
- [ ] 登录后 `pnpm serve` 正常自举（QWEN_KEYS 刷新成功）→ `/v1/chat/completions` 可用
- [ ] 装有 App 的机器：登录后 App 不受影响；`pnpm log-in:app` 旧链路照常

## 已知边界

- **命令名**：`pnpm log-in`（网页）/ `pnpm log-in:app`（App 链路）——曾用名 `login` 被 pnpm 内建 registry login 遮蔽，已更名
- **Windows 开浏览器**：`cmd /c start` 中 `&` 是命令分隔符，URL 必须加引号并配合 `windowsVerbatimArguments`（否则 URL 在第一个 `&` 处截断，浏览器收到残缺 query → 400 `INVALID_DEVICE_FLOW`）
- poll 的「进行中」判定取 404 ∪ 400(INVALID_DEVICE_FLOW) 的并集：若服务端将来引入新的失败型 400，会以其他 errorCode 抛错；真失败流若表现为这两种状态之一，会空转到超时（超时文案含提示）
- `X-QwenWork-*` 仿 App 头当前不被服务端校验；若将来校验，需同步 bump `APP_CLIENT_HEADERS`（App 版本升级时留意）
- refresh token 绝对过期：poll/refresh 响应可能返回 `refresh_token_expires_at`（auth.ts 会跟踪并在 <24h 时告警）；缺失时未知不猜，过期后重跑 `pnpm log-in` 即可
- `machine_id` 丢失（删 .env）→ 下次生成新 UUID，服务端视为新设备，无害
- Windows 上 `.env` 的 mode 600 为尽力语义（NTFS 无完整 POSIX 位），macOS/Linux 为真 600
