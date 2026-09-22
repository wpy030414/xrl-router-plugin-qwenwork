# DECISIONS — 设计决策记录

> 本文件记录项目关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

版本：0.4.0 | 最后更新：2026-09-22

---

## D-1: 为什么从独立 Anthropic 代理重构为 xrl-router 插件？

**背景**：旧架构包含 `adapter.ts`（Anthropic ↔ OpenAI 格式翻译）和 `deapClient.ts`（DEAP 协议头构造），作为独立的 Anthropic Messages API 代理运行。

**问题**：
- 密钥管理与 xrl-router 重复，两套 key pool 同步困难喵～
- Anthropic `tools` / `tool_use` 格式翻译复杂且易出错，边界情况多
- 无法复用 xrl-router 已有的重试、限流、分发逻辑

**决策**：纯协议桥接插件。插件只做 OpenAI → 网关协议的转换，密钥管理、重试策略、请求分发全部交给 xrl-router 处理喵。

**证据**：commit `63eb217` 删除了 `adapter.ts`、`deapClient.ts`、`types.ts`、`search.ts`，仅保留协议桥接层喵～

---

## D-3: 为什么 serve 现在自行管理 token 而非只消费密钥池？

**背景**：最初设计是 `capture-key` 负责提取 refresh token 写入 `.env`，serve 只从 `Authorization` 头消费 xrl-router 下发的 token。每请求都 refresh 一次。

**问题**：
- 每请求 refresh → refresh token 轮换互踩 → 不到 1 小时就断链，需频繁重新登录
- 插件和千问 App 同时持有 refresh token，各自刷新会导致对方的 token 失效

**决策**：serve 自行管理 token 生命周期（`getToken()` 缓存 + 按需刷新 + auth-v2.dat 文件监听）。

**收益**：
- **按需刷新**：5 分钟缓冲期内零网络请求，平均 1 小时才刷新 1 次（之前每请求都刷）
- **双向同步**：refresh 后写回 auth-v2.dat，千问 App 下次读取时拿到新 token，不互踩
- **文件监听**：千问 App 自己刷新时，插件自动拾取新值，只要 App 在后台就几乎不用重新登录

**证据**：`src/qwenwork/auth.ts`（`getToken()` / `startAuthFileWatch()` / `encryptAuthFile()`）、`src/qwenwork/client.ts`（`forwardChatCompletions` 改用 `getToken()`）

---

## D-4: 为什么心跳 30s？

**背景**：插件通过 WebSocket 心跳维持与 xrl-router 的连接喵～

**决策**：`HEARTBEAT_INTERVAL_MS = 30000`。

**原因**：
- WebSocket 最佳实践，避免中间件空闲断连（典型超时 60s）
- V24 契约要求每 30s 心跳，Router 端 90s 无心跳标记离线

**证据**：`src/pluginClient.ts`

---

## D-5: 为什么 qwenwork 用 RSA_PKCS1 而不是 RSA_OAEP？

**背景**：qwenwork 通道需要用公钥加密 cosyKey 参数喵～

**决策**：使用 `RSA_PKCS1_PADDING` 而非 `RSA_OAEP_PADDING`。

**原因**：逆向工程发现 asar 代码中显式使用 PKCS1_PADDING。实验验证：OAEP 返回 `101 Signature invalid`，PKCS1 返回 HTTP 200喵。

**证据**：`src/qwenwork/signer.ts`（`crypto.constants.RSA_PKCS1_PADDING`，注释标注「PKCS1 非 OAEP」）

---

## D-7: 为什么 qwenwork 非流式需要聚合 chunk？

**背景**：qwenwork 网关无论 `stream` 参数如何，始终返回 SSE 流喵～

**决策**：当客户端请求非流式模式时，插件在本地聚合所有 chunk，返回完整的 JSON 响应。

**原因**：
- OpenAI 客户端在非流式模式下期望收到完整的 JSON 对象
- 插件需要聚合 `delta.content` + `delta.reasoning_content` + `delta.tool_calls` 等字段

**证据**：`src/qwenwork/client.ts`（chunk 聚合逻辑）

---

## D-8: 为什么现在写回 auth-v2.dat？（推翻旧决策）

**旧决策（已废弃）**：插件绝不写回 `auth-v2.dat`，只写 `.env QWEN_KEYS`。

**旧原因**：担心外部写入会污染千问 App 的登录态。

**问题**：
- refresh token 采用轮换（rotation）策略，每次刷新产生新 token 并作废旧 token
- 插件刷新后 `.env` 拿到新 token，但 `auth-v2.dat` 里的旧 token 已失效
- 千问 App 下次用旧 token 刷新 → 链断 → 用户被迫重新登录
- 实际测试：千问 App 不做文件完整性校验，写回加密格式正确即可

**决策**：refresh 成功后用 `encryptAuthFile()` 写回 `auth-v2.dat`（与解密完全对称的加密方式）。

**收益**：
- 插件和千问 App 持有相同的 refresh token，不再轮换互踩
- 只要 App 保持后台运行，token 链可以持续续命

**证据**：`src/qwenwork/auth.ts`（`encryptAuthFile()`、`refreshDeviceToken()` 写回逻辑）

---

## D-9: 为什么移除模型别名映射并精简默认模型列表？

**背景**：早期 `qwenwork/client.ts` 维护了 `MODEL_ALIASES`（`glm-5.2` → `qwork-advanced`）和 `resolveModel()`，`config.ts` 的默认 `AVAILABLE_MODELS` 包含 `claude-opus-4-8,gpt-4o`，注册消息中按 model_id 含 `opus` 判断 `tier`。

**问题**：
- qwenwork 通道实际上只有 `qwork-advanced` 一个可用模型，别名映射让客户端误以为可以发 `glm-5.2` 请求
- `claude-opus-4-8` 和 `gpt-4o` 从未在 qwenwork 通道真正可用，默认列出会误导用户
- `tier` 按 `opus` 关键字判断是脆弱的启发式逻辑

**决策**：
- 删除 `MODEL_ALIASES` 和 `resolveModel()`：客户端发什么 model 就透传什么，缺省默认 `qwork-advanced`
- `tier` 统一硬编码为 `'custom'`

**收益**：消除多模型假象，减少用户配置错误；插件注册信息与实际能力一致喵。

**证据**：`src/config.ts`（默认值）、`src/pluginClient.ts`（`tier: 'custom'`）、`src/qwenwork/client.ts`（无 MODEL_ALIASES）

---

## D-11: 为什么 qwenwork 重新引入多模型列表？（部分推翻 D-9）

**背景**：D-9 决策将 qwenwork 默认模型精简为仅 `qwork-advanced`，认为只有一个可用模型喵～

**问题**：
- 实际上 qwenwork 网关已支持多个模型：`qwork-auto`（Qwen3.7-plus）、`qwork-lite`（DeepSeek-V4-flash）、`qmodel_latest`（Qwen3.8-max）
- 只暴露一个模型限制了用户选择

**决策**：重新扩展默认模型列表为 4 个，同时保留 `DISPLAY_NAMES` 映射给 xrl-router 展示用。

**收益**：用户可以通过 xrl-router 选择不同的模型，灵活性更高喵。

**证据**：`src/config.ts`（默认模型列表）、`src/qwenwork/client.ts`（DISPLAY_NAMES）

---

## D-12: 为什么 serve 去掉了 tsx watch？

**背景**：`pnpm serve` 原先用 `tsx watch` 自动监听文件变更重启喵～

**问题**：
- `auth-v2.dat` 文件监听（`fs.watch`）已经覆盖了 token 自动拾取需求
- `tsx watch` 监听整个 `src/` 目录，开发时频繁重启反而干扰调试
- watch 模式的进程管理与 `fs.watch` 的 watcher 生命周期可能冲突

**决策**：`serve` 改为 `tsx`（无 watch），文件变更需手动重启。

**证据**：`package.json` scripts 字段

---

## D-14: 为什么迁移到 V24 契约 + Hono + 废除 wukong？

**背景**：xrl-router 插件系统升级到 V24 契约，要求：
1. register 不带 `keys` 字段（Router 不再为插件管理密钥，凭证由插件方自持）
2. 不发 `keys_update` 消息
3. `provider.kind` 改为 `chat_completions`
4. 心跳不带 timestamp
5. HTTP 框架必须用 Hono
6. register 带 `workdir`（Router 伴生启动 cwd）

同时 wukong 通道（钉钉悟空 DEAP）实际使用频率低，且密钥管理复杂（~29天过期、MITM 抓包、daemon 依赖），维护成本高。

**决策**：
- 废除所有 keys 相关逻辑（env 轮询、`loadCurrentKeys`、`keys_update` 推送）
- Express → Hono（`@hono/node-server`）
- 完全移除 wukong 通道（源码、脚本、文档）
- `plugin_id` 改为 `plugin-qwenwork`（符合 V24 命名约定）
- `provider.kind` 改为 `chat_completions`
- 新增 `login` 脚本（V24 契约要求的生命周期入口）→ 复用 `capture-key.ts`

**收益**：
- 对齐 Router V24 契约，避免 register 被拒绝
- 代码量减少 ~40%（移除 wukong 双通道逻辑、channel 分发、env 轮询）
- 单通道简化，降低维护负担
- Hono 更轻量，SSE 处理更灵活

**证据**：
- `src/pluginClient.ts`（无 keys、无 env 轮询）
- `src/index.ts`（Hono，无 channel 分发）
- `src/config.ts`（无 deap 配置、无 Channel 类型）
- `package.json`（无 express/cors，有 hono/@hono/node-server，有 login 脚本）
- 删除文件：`src/channel.ts`、`src/wukong/`、`scripts/wukong/`、相关 docs

---

## 已废弃的决策（历史参考）

以下决策涉及已移除的 wukong 通道，仅供历史参考：

- ~~**D-2**~~：wukong 流式直接透传字节流（wukong 通道已移除）
- ~~**D-6**~~：DEAP 流式不能带 Accept: text/event-stream（wukong 通道已移除）
- ~~**D-10**~~：wukong 流式改为按行拆分 + 逐行 flush（wukong 通道已移除）
- ~~**D-13**~~：双通道不同默认端口 19067/19066（wukong 通道已移除）
