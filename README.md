# xrl-router-plugin-qwenwork

> xrl-router qwenwork 通道插件 — 把千问办公 AI 网关包装成 OpenAI Chat Completions 兼容的本地服务喵～

```
客户端 → xrl-router → 本插件 → gateway.qwenwork.cn → 智谱 GLM-5.2 / Qwen3.7-plus / DeepSeek-V4-flash / Qwen3.8-max
```

## 这是什么？
- 定位：xrl-router 的 qwenwork 通道插件，纯翻译层
- 解决的核心问题：把千问办公网关的 Cosy 签名协议桥接为标准 OpenAI Chat Completions API，让 Claude Code / Cursor 等客户端零改动接入

## 为什么存在？
- 背景 / 动机：国内 AI 网关（gateway.qwenwork.cn）协议壁垒高（RSA+AES+MD5 签名体系），普通 OpenAI 客户端无法直接调用；xrl-router 是统一 LLM 路由层，通过插件协议扩展对不同后端的支持

## 如何安装和运行？
- 前置要求：Node.js ≥ 20、pnpm、xrl-router 运行在 `http://localhost:19068`；千问办公 App **不再必需**（`pnpm log-in` 网页扫码即可自举凭据）
- 安装步骤：`pnpm install`
- 运行 / 启动：`pnpm log-in`（网页扫码获取凭据）→ `pnpm serve`（启动网关）

## 当前状态
- 阶段：开发中
- 已知限制：access token ~1h 过期（自动刷新）、refresh token 有服务端绝对过期时间（<24h 告警提示重登）、无自动化测试

## 核心技术
- 语言 / 框架 / 关键依赖：TypeScript 5 · Hono 4 · ws 8 · tsx 4 · pnpm
- 签名算法：AES-128-CBC + RSA_PKCS1 + MD5（逆向自 asar）
- OAuth：deviceToken/refresh 轮换式刷新 + PKCE device-flow 网页登录

## 验证

```bash
curl http://localhost:19067/health
# → {"status":"healthy","backend":"qwenwork","plugin_mode":true,"base_url":"https://gateway.qwenwork.cn"}
```

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Non Goals
- [docs/PRD.md](./docs/PRD.md) — 功能需求与存在的意义
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、协议、模块设计
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策的历史原因
- [docs/researches/qwenwork-desktop-reverse.md](./docs/researches/qwenwork-desktop-reverse.md) — 千问办公桌面 App 逆向分析
- [docs/specs/](./docs/specs/) — 核心功能规格文档
