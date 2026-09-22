# PRD — xrl-router qwenwork 插件

> **产品需求文档** — qwenwork（千问办公 → 智谱 GLM / Qwen3.7-plus / DeepSeek-V4-flash / Qwen3.8-max）

| 字段 | 内容 |
|------|------|
| 产品名称 | xrl-router-plugin-qwenwork |
| 版本 | 0.3.0 |
| 状态 | V24 契约迁移完成 |
| 最后更新 | 2026-09-22 |

---

## 1. 背景与目标

### 1.1 背景

国内 AI 网关对外暴露的能力很强，但协议壁垒也很高，普通 OpenAI 客户端无法直接调用喵～

**QwenWorkCN 网关**（gateway.qwenwork.cn）：使用 Cosy 签名体系（RSA+AES+MD5），每个请求需要 `Cosy-Key`（RSA 加密的随机 AES key）、`Authorization`（MD5 签名绑定 body/path/时间戳）、`Cosy-User` 等头。签名算法逆向自 asar，普通客户端无法自行签名喵～

**xrl-router** 是统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑，通过 WebSocket 插件协议（V24 契约）扩展对不同后端的支持喵～

### 1.2 目标

让任何能调 OpenAI API 的客户端（Claude Code、Cursor、各类 IDE 插件）通过 xrl-router 无缝访问 qwenwork 网关，无需感知 Cosy 签名协议细节喵～

### 1.3 非目标

- 不实现 Anthropic Messages API 协议（旧版架构，已删除）
- 不管理密钥轮转逻辑（由 xrl-router 负责）
- 不运行任何本地模型
- 不发送 `keys` / `keys_update` 给 Router（V24 契约严格禁止）

---

## 2. 用户画像

| 角色 | 描述 | 核心诉求 |
|------|------|----------|
| 开发者 | 使用 Claude Code / Cursor 等工具 | 无缝调用模型，无需改客户端代码 |
| 运维 | 负责密钥管理和部署 | 一键验证 token、自动刷新、长期稳定运行 |
| 终端用户 | 通过上层应用使用 AI 能力 | 稳定、低延迟 |
| 逆向工程师 | 分析 QwenWorkCN 协议 | 离线独立调用验证（不依赖官方 App） |

---

## 3. 用户故事

### US-1：开发者接入 GLM-5.2

**作为** 使用 Cursor 的开发者，
**我希望** 通过 qwenwork 插件访问智谱 GLM-5.2 模型，
**以便** 我可以使用国产大模型而无需担心密钥过期喵～

**验收标准：**
- 客户端发送标准 OpenAI Chat Completions 请求
- 插件自动完成 Cosy 签名（RSA 加密 AES key → `Cosy-Key`，MD5 签名 → `Authorization`）
- 流式响应：解包外层 SSE（`data:{"body":"<内层chunk>"}`）为标准 OpenAI SSE 透传
- 非流式响应：聚合所有 delta chunk 为完整 `chat.completion` JSON

### US-2：Token 自动刷新

**作为** 运维人员，
**我希望** OAuth token 能自动刷新，
**以便** 服务可以长期运行而无需人工干预喵～

**验收标准：**
- access token 临近过期（提前 5 分钟）时自动调用 `deviceToken/refresh` 刷新
- refresh token 刷新后自动同步到 `.env` 的 `QWEN_KEYS`（灾备源）
- 三源回退：内存缓存 → `auth-v2.dat`（macOS Keychain / Windows DPAPI 解密）→ `.env QWEN_KEYS`（自举）
- 单飞防并发（同一时刻只有一个刷新请求）

### US-3：离线独立调用验证

**作为** 逆向工程师，
**我希望** 运行 `pnpm capture-key` 验证 token 解密和刷新链路，
**以便** 确认离线独立调用的可行性喵～

**验收标准：**
- 解密 `auth-v2.dat`（macOS Keychain → PBKDF2 → AES-128-CBC；Windows Local State DPAPI 密钥 → AES-256-GCM）
- 强制刷新 token（验证刷新链 + refresh token 轮换）
- 备份新 refresh token 到 `.env QWEN_KEYS`（mode 600）
- 全程不依赖千问办公 App 运行（仅需 `auth-v2.dat` 文件存在）

### US-4：故障自动恢复（WebSocket 重连）

**作为** 运维人员，
**我希望** 插件与 xrl-router 断线后能自动重连，
**以便** 我不需要手动重启服务喵～

**验收标准：**
- WebSocket 断线后自动重连（指数退避：1s → 2s → 4s → … → 最大 60s）
- 心跳保活（每 30s 发送 `heartbeat` 消息）
- 容忍 Router 未就绪：连接失败时退避重试
- 重连成功后自动重新注册

---

## 4. 功能需求

### 4.1 核心功能（P0）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-1 | Cosy 签名桥接 | 每请求生成随机 16B AES key → RSA 加密为 `Cosy-Key` → AES 加密 userInfo → MD5 签名 `Authorization`，转发到 `gateway.qwenwork.cn` |
| F-2 | 流式支持 | 解包外层 SSE `{"body":"..."}` 为标准 OpenAI SSE |
| F-3 | 非流式支持 | 聚合所有 delta chunk 为完整 `chat.completion` JSON |
| F-4 | WebSocket 注册/心跳/重连（V24） | 启动时 `register`（plugin_id + 模型列表 + workdir，**无 keys**），心跳 30s（**无 timestamp**），断线指数退避重连 |

### 4.2 重要功能（P1）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-5 | Token 验证与刷新 | `pnpm login` / `pnpm capture-key`：解密 `auth-v2.dat` + 强制刷新 + 备份 `QWEN_KEYS`，验证离线独立调用链路 |

### 4.3 辅助功能（P2）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-6 | 健康检查 | `GET /health` 返回 `{status, backend, base_url}` |
| F-7 | 服务信息 | `GET /` 返回 `{version, service, backend, endpoints}` |
| F-8 | 端口释放 | 启动前自动检测并 kill 占用目标端口的进程（macOS lsof / Windows netstat+taskkill） |

---

## 5. 非功能需求

### 5.1 性能

- 请求延迟：插件层增加延迟 < 10ms（不含网络传输和签名计算）
- 内存占用：单实例 < 100MB
- 并发能力：单实例支持 100+ 并发请求

### 5.2 可用性

- 断线自动重连（指数退避，最大间隔 60s）
- 心跳保活（每 30s 一次）
- 优雅退出（SIGTERM/SIGINT 时关闭 WebSocket 连接、停止心跳）

### 5.3 安全性

- `.env` 与密钥永不进 git（`.gitignore` 强制，`capture-key` 脚本预检）
- `.env` 文件权限 600（仅属主可读写）
- 仅对本机、本人已登录的 App 抓密钥（授权的本地分析）

### 5.4 兼容性

- Node.js >= 20
- 跨平台：macOS（Keychain）+ Windows（DPAPI）
- HTTP 框架：Hono（V24 契约要求）
- 协议兼容：OpenAI Chat Completions API（流式 + 非流式）

---

## 6. 约束与依赖

### 6.1 约束

- 本插件不管理密钥轮转逻辑（由 xrl-router 负责）
- 本插件不运行任何本地模型（全部能力来自远端网关）
- 本插件凭证自持（V24 契约），Router 发占位凭证 `Bearer xrl-router`
- qwenwork 通道 token 解密支持 macOS（Keychain）与 Windows（Local State DPAPI 密钥 → AES-256-GCM）

### 6.2 依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| xrl-router | 上游路由层 | 必须运行在 `http://localhost:19068` |
| gateway.qwenwork.cn | 后端推理网关 | `https://gateway.qwenwork.cn` |
| 千问办公 App | token 来源 | 仅需 `auth-v2.dat` 文件（登录后生成） |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| xrl-router 断线 | 插件无法注册 | 自动重连（指数退避 1s~60s）+ 心跳保活 30s |
| OAuth token 刷新失败 | 通道不可用 | 三源回退：内存缓存 → `auth-v2.dat`（Keychain / DPAPI）→ `.env QWEN_KEYS`（自举） |
| Keychain 授权拒绝（macOS） | token 解密失败 | 脚本提示用户点「允许」 |
| Windows DPAPI 解密失败 | token 解密失败 | 检查 auth-v2.dat 是否来自同一 Windows 用户 |

---

## 8. 验收标准

- [ ] `pnpm login` / `pnpm capture-key` 能解密 `auth-v2.dat` 并验证 token 刷新链
- [ ] `pnpm serve` 启动后 `/health` 返回 `backend: "qwenwork"`
- [ ] 插件成功连接 xrl-router 并注册（plugin_id: `plugin-qwenwork`，V24 契约无 keys）
- [ ] 客户端通过 xrl-router 能正常调用 GLM-5.2（流式 + 非流式）
- [ ] Cosy 签名正确（`Cosy-Key`、`Authorization`、`Cosy-Date`、`Cosy-User`）
- [ ] Token 临近过期时自动刷新，refresh token 轮换后同步 `.env`
- [ ] 优雅退出：SIGTERM/SIGINT 关闭 WebSocket + 停止心跳

---

## 9. 附录

### 9.1 术语表

| 术语 | 含义 |
|------|------|
| xrl-router | 统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑 |
| gateway.qwenwork.cn | 千问办公推理网关 |
| Cosy | 千问办公网关的签名体系：RSA 加密随机 AES key + AES 加密 userInfo + MD5 请求签名 |
| safeStorage | Electron 的加密 API，macOS 走 Keychain + PBKDF2 + AES-128-CBC，Windows 走 DPAPI |
| auth-v2.dat | 千问办公的登录态文件，safeStorage 加密存储 OAuth token + refresh token |
| refresh token | `ory_rt_` 前缀的令牌，用于 `deviceToken/refresh` 换取新 access token（轮换式） |
| V24 契约 | xrl-router 插件系统 V24 版本，废除 keys 字段、要求 Hono 框架 |
| plugin_id | 插件在 xrl-router 中的注册标识：`plugin-qwenwork` |
| 占位凭证 | Router 恒发的 `Bearer xrl-router`，插件必须忽略并用自身 OAuth token |

### 9.2 快速启动

```bash
pnpm install              # 安装依赖
pnpm login                # 验证 token（需千问办公 App 已登录）
pnpm serve                # 启动插件网关
```

---

*版本 0.3.0 · 最后更新 2026-09-22*
