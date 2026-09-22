# AGENTS.md — xrl-router-plugin-qwenwork

本文件为 AI Agent 划定项目边界。任何 Agent 在本仓库工作时，必须遵守以下约束。

## 项目定义

`xrl-router-plugin-qwenwork` 是一个 **qwenwork 通道的 xrl-router 插件**，将中国 AI 网关包装为 OpenAI Chat Completions 兼容的本地服务喵～

| 上游网关 | 后端模型 |
|---------|---------|
| `gateway.qwenwork.cn` | 智谱 GLM-5.2 / Qwen3.7-plus / DeepSeek-V4-flash / Qwen3.8-max |

协议边界：**只桥接 OpenAI Chat Completions（`/v1/chat/completions`）**，不做任何协议扩展喵。

## Non Goals（CRITICAL — 最重要的章节）

以下事项**明确不在本项目范围内**，Agent 遇到相关需求必须拒绝喵！

- **不实现 Anthropic Messages API** — 旧架构，已在 commit `63eb217` 中整体删除，不要加回来
- **不做密钥轮转 / 重试逻辑** — 这是 xrl-router 的职责，插件只管转发
- **不做本地模型推理** — 所有请求都走远端网关，插件是纯翻译层
- **不实现 `/v1/models` 端点** — 模型列表通过 WebSocket 注册推送，不通过 HTTP 暴露
- **不复用抓到的 JWT / cosy-key** — 网关有 anti-replay 检测，复用会被封
- **不做 tools / tool_use 翻译** — xrl-router 自己处理
- **不实现非 Chat Completions 端点** — `/v1/embeddings`、`/v1/completions` 等一律不加

## 源码地图

```
src/
├── index.ts          # Hono 入口：路由、端口释放、启动
├── config.ts         # Settings 单例：集中读取环境变量
├── pluginClient.ts   # WebSocket 客户端：注册（V24 无 keys）、心跳、重连
└── qwenwork/
    ├── client.ts     # 转发到 gateway.qwenwork.cn（签名 + SSE 解包）
    ├── auth.ts       # OAuth token 管理（safeStorage 解密 + 刷新）
    └── signer.ts     # RSA_PKCS1 + AES 签名（逆向自 asar）

scripts/
└── qwenwork/capture-key.ts  # 验证 token + 刷新链 + 备份 QWEN_KEYS

docs/
├── PRD.md
├── ARCHITECTURE.md
├── DECISIONS.md
├── reverse/
│   └── QWENWORKCN_REVERSE.md
└── specs/
    ├── qwenwork-forward.md
    ├── qwenwork-signing.md
    ├── qwenwork-token.md
    ├── capture-key-qwenwork.md
    ├── config-channel.md
    └── port-release.md
```

## 开发约定

- **包管理器：pnpm**（不是 npm — npm 会触发 arborist `Link.matches` 崩溃 bug，详见 MEMORY）
- **dev 模式：tsx**（已去掉 watch — 文件变更需手动重启）
- **HTTP 框架：Hono**（不是 Express — V24 契约要求）

## 构建与运行

```bash
pnpm install              # 安装依赖（再次强调：不要用 npm）
pnpm serve                # 启动插件网关
pnpm login                # 弹出登录流程（验证 token + 刷新链）
pnpm capture-key          # 同上（别名）
```

## 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| 密钥过期（~1h qwenwork access token） | 网关设计，自动刷新即可 |
| 无测试 | 当前阶段不需要，插件是纯翻译层 |
| qwenwork Windows 解密依赖 powershell.exe | Windows DPAPI 经 PowerShell `System.Security` 调用，Windows 自带无需安装；macOS 走 Keychain |

## 密钥安全边界

- `.env` 永不进 git — `git check-ignore .env` 必须通过喵！
- 只从自己登录的实例抓密钥，不要抓别人的

## V24 契约要点

- **register 不带 `keys` 字段** — 带了 Router 直接拒绝断开
- **不发 `keys_update` 消息** — 发了 Router 直接断开
- **`provider.kind` 为 `chat_completions`**（不是 `openai`）
- **心跳为 `{"type": "heartbeat"}`**（不带 timestamp）
- **register 带 `workdir`**（插件项目根目录，Router 伴生启动 cwd）
- **Router 发占位凭证** `Authorization: Bearer xrl-router`，插件用自身凭证访问上游

## 给 AI Agent 的指引

### 必须拒绝的任务

遇到以下需求，直接引用本 AGENTS.md 拒绝喵：

1. **「实现 Anthropic Messages API」** → Non Goal，已删除的旧架构
2. **「添加密钥轮转逻辑」** → xrl-router 的职责
3. **「实现本地模型推理」** → 纯桥接插件
4. **「复用抓到的 JWT / cosy-key」** → anti-replay 会封号

### 允许的任务方向

- 新增 DEAP / Cosy 业务 header
- 优化 WebSocket 重连策略
- 新增模型展示名（`DISPLAY_NAMES`）
