# 千问办公 Web Device-Flow 登录研究（无需 App 的凭据自举）

> 研究日期：2026-09-30 | 工具：app.asar 静态逆向（grep）+ 在线探活（curl）| 目标：彻底脱离千问办公 App 的凭据自举

## 1. 背景

插件对 App 的唯一硬依赖是首次登录：第一个 `ory_rt_` 必须由 App 写入 `auth-v2.dat`（safeStorage）才能解密。续期（`POST /api/v1/deviceToken/refresh`）早已独立。QwenWorkCN 1.2.5 的 `app.asar` 中 `startDeviceFlow()` 暴露了 App 自身登录的实际路径——此次逆向并实证该流程可完全脱离 App。

## 2. 协议常量（asar 提取 + 探活确认）

| 项 | 值 | 来源 |
|---|---|---|
| `CLIENT_ID`（`e883ade2-…`） | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | asar `QWENWORK_CN_CLIENT_ID`，全局唯一命中 |
| `redirectUri` | `qwenwork-cn://` | asar `getRedirectUri()`，App 自定义协议（网页登录无需监听） |
| `machineId` | 随机 UUID，本地持久化一次 | asar `getMachineId$1()`，`crypto.randomUUID()` |
| PKCE charset | `A-Za-z0-9-._~` | asar `generatePKCE$1()` |
| PKCE verifier length | `43 + Math.floor(Math.random()*86)`（43..128） | asar 原文 |
| PKCE challenge | `base64url(sha256(verifier))`，无填充 | asar |
| poll interval | 1000ms | asar `POLL_INTERVAL_MS$1` |
| poll timeout | 300s（`POLL_TIMEOUT_MS`） | asar |

## 3. 登录跳转链（探活实证，2026-09-30）

### 3.1 selectAccounts 挂在网关上

```
GET https://gateway.qwenwork.cn/device/selectAccounts
    ?challenge=<base64url(sha256(verifier))>
    &challenge_method=S256
    &nonce=<randomUUID()>
    &machine_id=<uuid>
    &client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
    &redirect_uri=qwenwork-cn%3A%2F%2F
```

**关键发现**：`selectAccounts` 挂在 **gateway.qwenwork.cn**，而非网站域 `qwenwork.cn`。

- **网站域**（`qwenwork.cn/device/selectAccounts`）→ **HTTP 404**（虽然根路径 200）
- **www 域**（`www.qwenwork.cn/device/selectAccounts`）→ **301** 回裸域再 404
- **网关域**（`gateway.qwenwork.cn/device/selectAccounts`，参数齐全）→ **302** 到授权页

### 3.2 302 跳转到 Ory Hydra 授权页

```
HTTP 302
Location: https://qwenwork.cn/oauth2/auth
  ?client_id=qwenwork-desktop-app
  &code_challenge=<服务端自生成 S256>
  &code_challenge_method=S256
  &redirect_uri=https://gateway.qwenwork.cn/oauth/callback
  &response_type=code
  &scope=openid profile email offline_access qwen_work
  &state=<服务端生成，绑定游客的 nonce+challenge>
```

关键行为：

- `client_id` 被服务端替换为 `qwenwork-desktop-app`（非我们传的 `e883ade2-…`，那是 selectAccounts 层的参数）
- 我们的 `challenge`、`nonce` 被服务端绑定进 `state`
- 服务端自生成一个新的 `code_challenge`（授权页 S256）
- **没有在 Location 重定向的查询串中携带我们传的参数**——编号绑定全部在 state 内部完成

### 3.3 授权后回跳 → 服务端绑定

```
钉钉扫码 → 授权完成 → 302 → gateway.qwenwork.cn/oauth/callback
  ?code=<authorization_code>
  &state=<原 state>
→ 服务端兑换 code，凭据绑定到我们的 nonce/challenge
```

### 3.4 poll 轮询取回凭据

```
GET https://gateway.qwenwork.cn/api/v1/deviceToken/poll
    ?nonce=<nonce>
    &verifier=<verifier（PKCE verifier）>
    &challenge_method=S256
Headers:
    Accept: application/json
    X-Request-Id: <randomUUID()>
    X-QwenWork-Version: 1.2.5          # 防御性，探活实证非必需
    X-QwenWork-Release-Version: 1.2.5
    X-QwenWork-Platform: win32
    X-QwenWork-Arch: x64
    X-QwenWork-Channel: release
```

成功响应（需做完绑定校验方采纳）：

```json
{
  "token": "<OAuth JWT，~1h>",
  "refresh_token": "ory_rt_...",
  "nonce": "...",
  "code_challenge": "...",
  "code_challenge_method": "S256",
  "expires_at": "...",           // ISO，可选
  "expires_in": 3600,           // 秒，可选
  "refresh_token_expires_at": "...", // ISO，可选（新字段）
  "refresh_token_expires_in": 5184000 // 秒，可选
}
```

## 4. poll 端点语义（探活实证）

`404` 未完成是 asar 源码描述；**2026-09-30 探活发现 `400` + `errorCode: INVALID_DEVICE_FLOW` 也是「进行中」**——未知 nonce 即此响应。推理：nonce 在用户打开 selectAccounts 后才被服务端登记，在那之前属于未知设备流，服务端也返回 INVALID_DEVICE_FLOW。两种状态均应视为「继续轮询」。

### 探活记录

| nonce/verifier | 响应 | 含义 |
|---------------|------|------|
| 未知 nonce，无意义 verifier | 400 `INVALID_DEVICE_FLOW` | 进行中（nonce 未登记） |
| 未知 nonce，合法 verifier（纯 A） | 400 `INVALID_DEVICE_FLOW` | 同上 |
| 未知 nonce，合法 verifier（含 `-._~`） | 400 `INVALID_DEVICE_FLOW` | 同上 |
| 合法 nonce（登录完成前） | 实际取决于 nonce 登记时序 | 推测为 400/404 |
| 合法 nonce（登录完成后） | 2xx `{token, refresh_token, …}` | 成功 |

### valueSummary.length 的排障意义

404/400 不返回 HTML 页面（即使 Accept=text/html），JSON 中 `details.valueSummary.length` 是 **整个 query 串长度**（而非单个字段）。曾误读为「verifier 长度 53」——实际是 Windows `cmd /c start` 在 `&` 处截断了 URL，浏览器只收到 `challenge=xxx` 这段（约 53 字符）。详见第 6 节。

## 5. 关键端点索引

| URL | 方法 | 用途 | 探活结果 |
|-----|------|------|----------|
| `https://gateway.qwenwork.cn/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id&redirect_uri` | GET | 登录入口 | 302 → qwenwork.cn/oauth2/auth |
| `https://qwenwork.cn/device/selectAccounts?...` | GET | （错误入口） | **404** |
| `https://www.qwenwork.cn/device/selectAccounts?...` | GET | （错误入口） | 301 → 裸域 → 404 |
| `https://qwenwork.cn/oauth2/auth?client_id=qwenwork-desktop-app&code_challenge&code_challenge_method=S256&redirect_uri&response_type=code&scope&state` | GET | Ory Hydra 钉钉授权页 | 200 text/html（需浏览器渲染扫码） |
| `https://gateway.qwenwork.cn/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | GET | 轮询登录完成态 | 400/404=进行中；2xx=成功 |
| `https://gateway.qwenwork.cn/api/v1/deviceToken/refresh` | POST | 续期（已有实现） | 200 `{device_token, refresh_token, expires_at, refresh_token_expires_at?}` |

### 不与 OAEP/RSAPKCS1 混淆

注意：`deviceToken/refresh` 和 `deviceToken/poll` 是纯 HTTP API（`Content-Type: application/json`，无 Cosy 签名）——与推理端点的 `RSA_PKCS1 + AES + MD5` 签名体系完全隔离。这也是为什么续期链路可以脱离 App 独立工作的原因。

### 与标准 OAuth 的关系

asar 包含 `registration_endpoint`（OAuth 动态客户端注册）、浏览器 PKCE 授权码流（client_id `e883ade2-…`），但走 standard `/auth/oauth/token` 的 `grant_type=refresh_token` 被 `invalid_client` 拒。device flow 是**专用**于获取凭据的流，标准 OAuth 仅用于 selectAccounts → 302 Hydra 这个浏览器环节。

## 6. 踩坑记录

### 坑 1：authBase 域名

**表象**：浏览器打开 `qwenwork.cn/device/selectAccounts` → 404。

**根因**：asar 里 `getAuthBaseUrl()` 返回 `resolveWebsiteDomain()` 的结果拼接 `https://`，但其被截断的上下文暗示结果可能与 `openApiBase` 一致。实测 `gateway.qwenwork.cn`（同 `qwenBaseUrl`）才是正确入口。

**修复**：`QWEN_AUTH_BASE` 默认值改为 `https://gateway.qwenwork.cn`。

### 坑 2：Windows cmd /c start URL 截断

**表象**：浏览器收到残缺 query，服务端返回 `INVALID_DEVICE_FLOW`，`details.valueSummary.length: 53`。

**根因**：`cmd /c start "" <url>` 中 `&` 是命令分隔符，URL 在第一个 `&` 处截断。`challenge=xxx` 段长度恰好 ≈ 53，残缺 query 被当作完整的「不合法 device flow 请求」。之前的测试中 `_method=S256` 被当作命令执行（stderr 有乱码报错）。

**修复**：URL 加引号 + `windowsVerbatimArguments: true`：
```ts
spawn('cmd.exe', ['/c', 'start', '', `"${url}"`], {
  detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
});
```

### 坑 3：pnpm login 被内建命令遮蔽

**表象**：`pnpm login` 触发的是 pnpm registry login（npmmirror 授权 URL），从不执行 `scripts.login`。

**根因**：`login` 是 pnpm 内建命令，优先级高于同名 script。

**修复**：人类入口改为 `pnpm log-in`；`scripts.login` 保留供 `pnpm run login` / Router 生命周期调用。

## 7. 与 App 链路的关系

- 网页登录的 refresh token 与 App 链同构（`ory_rt_` 前缀），共享同一续期端点（`deviceToken/refresh`）
- 两条链在服务端**互不失效**（轮换只发生在链内）
- 网页登录**永不写回** `auth-v2.dat`（poll 响应不含 App 所需的 `loginDeviceId` 等字段），与 App 链路完全独立
- serve 的三源 fallback 不变：缓存 → auth-v2.dat → `.env QWEN_KEYS`。装不装 App 都能跑
- 曾担心的「服务端可能拒绝无 App 客户端头」——探活证实 `X-QwenWork-*` 头非必需，device flow 仅需 `Accept` + `X-Request-Id`

## 8. 未来关注

- 服务端若开始校验 `X-QwenWork-*` 头：bump `APP_CLIENT_HEADERS` 常量匹配最新 App 版本号
- selectAccounts 若变更路由/参数：从 asar 重新 grep `startDeviceFlow`/`pollDeviceToken`
- refresh token 绝对过期（`refresh_token_expires_at`）：现已跟踪，<24h 告警。缺失时恢复期未知，重跑 `pnpm log-in` 即可
- `deviceToken/poll` 的「进行中」判定：当前取 404 + 400(`INVALID_DEVICE_FLOW`) 并集；若服务端引入新的「进行中」错误形态需跟进