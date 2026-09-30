# qwenwork-forward: 千问办公通道转发

## 目标

将标准 OpenAI Chat Completions 请求转发到 gateway.qwenwork.cn 推理网关，完成 Cosy 签名、OAuth token 刷新、SSE 双层解包，使上游千问办公网关对调用方表现为标准 OpenAI 兼容端点喵～

## 输入输出

**输入：**
- HTTP POST `/v1/chat/completions`
- Body：标准 OpenAI Chat Completions JSON（含 `messages`、`model`、`stream` 等）
- Header：`Authorization: Bearer <ory_rt_...>`（xrl-router 密钥池透传的 refresh token）

**输出：**
- 流式（`stream: true`）：标准 OpenAI SSE 流，`data: <chunk JSON>` + `data: [DONE]`
- 非流式：标准 OpenAI `chat.completion` JSON（聚合 delta 后的完整 message）

## 关键约束

1. **Token 来源**：`getToken()` 三源 fallback（内存缓存 → auth-v2.dat → .env QWEN_KEYS）；灾备从 `Authorization` 头取 `ory_rt_` 前缀 refresh token喵
2. **Token 刷新链路**：`getToken()` 缓存有效（> 5min）→ 直接返回；过期 → 内存 refresh token → `refreshDeviceToken(rt)` 换取 access token + 新 refresh token → 写回 auth-v2.dat + .env → `extractUidFromToken(JWT payload)` 从 JWT 解出 uid
3. **模型默认（2026-09 新版）**：客户端未指定 `model` 时使用 `flash`；指定了什么就透传什么（无别名映射）。默认挡位列表：`flash`、`pro`、`qwen3.8-max-preview`（云端权威目录见 `GET /api/v2/model/list`，插件可用 `fetchModelCatalog()` 拉取）
4. **Body 清洗**：`delete forwardBody.encode`、`delete forwardBody.extra_body`（qwenwork 网关明文即可，不需要 Encode=1）
5. **自动填充**：`request_id` 和 `session_id` 缺失时用 `randomUUID()` 补全
6. **Cosy 静态头**：12 个头（`Cosy-Business-Product: qoder_work`、`Cosy-Scene: qwork`、`Cosy-Version: 1.1.59`、`Cosy-MachineOs: ${arch}_${platform}` 按平台生成 等；其中 `Login-Version`、`x-model-source` 非 `Cosy-*` 前缀）
7. **推理路径**：`/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common`（2026-09 新版官方客户端另带 `&Encode=1`，body 为 WASM 流加密体——待适配，见「已知边界」）
8. **挡位头（2026-09 新版）**：挡位经 `x-model-key` 请求头传递（值 = 目录 key，如 `flash`），body.model 不再用于服务端路由

**SSE 双层解包：**
- 外层格式：`data:{"headers":{...},"body":"<内层 OpenAI chunk JSON>","statusCodeValue":200}`
- 内层格式：标准 OpenAI SSE chunk JSON
- `flushLine` 解析外层 → 取 `outer.body` → `emitChunk` 写出内层

**流式 tool_calls 标准化（适配 xrl-router）：**
- 每个 index 的首 chunk 发 `id`/`type`/`name` + 空 `arguments`（触发 `content_block_start`）
- 所有 arguments 片段（含首 chunk 的 `"{"`）原样发出，保证 `partial_json` 拼接为完整 JSON
- 用 `seenToolCallIndex` 集合跟踪

**非流式聚合：**
- 收集所有 chunk 的 `choices[0]`（含 `delta` 和 `finish_reason`）
- 拼接 `delta.content` + `delta.reasoning_content`（空值时字段不存在）
- `delta.tool_calls` 按 `index` 分组，拼接 `arguments`，保留首个 chunk 的 `id`/`name`/`type`
- `finish_reason` 从上游最后一个 chunk 透传（默认 `stop`）
- 组装为 `chat.completion` 对象返回

## 验收标准

- [ ] 传入 `ory_rt_` token，返回 200 + 标准 OpenAI 流式/非流式响应
- [ ] 不传 Authorization 头 → 401 + 错误信息
- [ ] 传入非 `ory_rt_` 前缀 token → 401
- [ ] 流式响应：客户端收到标准 `data: <OpenAI chunk>` + 末尾 `data: [DONE]`
- [ ] 非流式响应：返回完整 `chat.completion` JSON，`message.content` 为所有 delta 拼接
- [ ] `model` 字段透传：客户端指定什么就发什么，缺省时默认 `flash`
- [ ] body 中 `encode` / `extra_body` 字段被删除，不透传
- [ ] 缺失 `request_id` / `session_id` 自动补全 UUID

## 已知边界

- **2026-09-30 上游大版本更新（App 1.2.5）**：旧四挡下线，新挡位为 `flash`/`pro`/`qwen3.8-max-preview`（`GET /api/v2/model/list` 下发）；推理协议改为 `x-model-key` 请求头 + `Encode=1`（官方 WASM 流加密 body）。**当前推理转发仍为旧明文签名链，会被服务端 503「Model catalog unavailable」拒绝——推理适配未完成**（目录接口已可用）。完整逆向见 [`docs/researches/qwenwork-1.2.5-update.md`](../researches/qwenwork-1.2.5-update.md)
- 上游 qwenwork 网关自身会发 `[DONE]` 和空 `{}`，流式路径 `emitChunk` 和非流式路径均显式跳过这两类，流式由本服务发出唯一的 `[DONE]` 喵
- `extractUidFromToken` 容错：JWT payload 中尝试 `sub` → `uid` → `user_id`，都无则返回空字符串
- 上游非 2xx：直接透传 status code + body 文本（不做二次包装）
- 非流式聚合失败：若 headers 未发送则返回 502，已发送则只能 `console.error`
- 流读取异常：`console.error` 后 `res.end()`，不重试
