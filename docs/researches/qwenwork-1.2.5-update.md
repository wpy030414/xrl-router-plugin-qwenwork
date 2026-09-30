# 千问办公 1.2.5 更新逆向记录（2026-09-30）

> 上游大版本更新（App 0.1.3 → 1.2.5）的完整逆向记录：新挡位体系、推理协议变化、WASM 签名链，
> 以及可复现的调试方法论。本文承接 [`qwenwork-desktop-reverse.md`](./qwenwork-desktop-reverse.md)（0.1.3 基线）。

## 0. 一句话结论

App 从 0.1.3 升级到 **1.2.5（`1.2.5-26092902`，2026-09-29 构建）** 后：

1. **旧四挡（`qwork-advanced` / `qwork-auto` / `qwork-lite` / `qmodel_latest`）全部下线**（裸请 403）；
2. 新挡位经 **`GET /api/v2/model/list?Encode=1`** 按场景下发，qwork 场景为 **`flash`（标准/默认）、`pro`（高级）、`qwen3.8-max-preview`（Qwen3.8-Max）**；
3. **挡位改从 `x-model-key` 请求头传递**（body.model 不再用于路由）；
4. 推理请求带 **`&Encode=1`**，body 由**官方 Rust WASM 流加密**（非 base64、非明文）；
5. 签名材料由 **`qoder_auth_wasm_bg.wasm`**（`generate_runtime_auth_fields`）动态生成；
6. 旧 Cosy 签名链仍可过网关基础校验（**目录接口实测 200 可用**），但明文推理请求被服务端以
   **503「Model catalog unavailable」**拒绝——**推理转发待适配**（见 §7）。

## 1. 版本与安装

| 组件 | 位置 | 说明 |
|---|---|---|
| App 主程序 | `C:\Users\<user>\AppData\Local\Programs\QwenWorkCN\1.2.5-26092902\` | Electron（`QwenWorkCN.exe`，asar 230MB） |
| 推理 CLI | `resources/bin/qoderclicn.exe` | bun 打包 222MB（`qoderclicn`，CLI 版） |
| worker runtime | `resources/app.asar.unpacked/.../@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs` | 33MB，混淆 + 字符串 XOR 编码 |
| **认证 WASM** | `resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm` | 288KB，wasm-bindgen（Rust），签名/加密核心 |
| 运行配置 | `~/.qwenworkcn/` | `machine-id`、`.status.json`、`.models/`（目录缓存，AES 加密 `catalog-v6`）、`logs/runs/`（worker 日志） |

App 的 worker 由主进程直接 spawn（`QwenWorkCN.exe <obf.mjs> --print --input-format stream-json ...`），
通过 stdin/stdout 的 **control 协议**驱动；认证走 **host job token** 模式（主进程按需注入 token）。

## 2. 新挡位目录（权威接口）

`GET https://gateway.qwenwork.cn/api/v2/model/list?Encode=1` —— **响应为明文 JSON**（按 scene 分组：`chat`/`developer`/`assistant`/`qwork`/…），旧签名链即可调用。

qwork 场景（2026-09-30 实测，企业基础版与个人免费版同）:

| key | display_name | price_factor | 备注 |
|---|---|---|---|
| `flash` | 标准 / Standard | 0.1 | `is_default: true`，极速全能 |
| `pro` | 高级 / Pro | 1 | 性能均衡 |
| `qwen3.8-max-preview` | Qwen3.8-Max | 1.8 | `is_new: true` |

条目字段：`key`、`display_name`、`i18n`、`is_vl`、`is_reasoning`、`format: "openai"`、`source: "system"`、
`enable`、`is_default`、`price_factor`、`max_input_tokens`（1M）、`context_config`（200K/400K/1M）、
`thinking_config`、`feature_switches`、`strategies` 等。

插件的 `fetchModelCatalog()`（`src/client.ts`）已实现该接口的调用与解析。

## 3. 推理协议变化（实测）

### 3.1 挡位传递：`X-Model-Key` 请求头

A/B 对照实锤：**无该头 → 403「Model is not available for this user」；有该头（值=目录 key）→ 请求被放行到下一层**
（旧挡位名带头时表现为 503，新挡位名带头时同样 503——503 由后续协议层决定，见 §6）。

### 3.2 `Encode=1`：WASM 流加密 body

- 推理 URL 带 `&Encode=1`；官方客户端 body 形如 `L#Sw*lECYJ...`（可见 ASCII 范围的流加密体，**非 base64**）；
- 带 `Encode=1` 但发明文 body → `400 decode Encode=1 body: illegal base64 data at input byte N`（N 随机漂移——
  说明解码后还有解密层）；合法 base64 也被拒（同因）；
- 加密体只能由官方 WASM 生成（`QoderContext.prepareInferRequest` 返回 `{url, headers, body}`）。

### 3.3 Authorization 新格式

`Authorization: Bearer COSY.<base64(payload)>.<md5hex>`，payload 为：

```json
{"version":"v1","requestId":"<uuid>","info":"<encrypt_user_info>","cosyVersion":"1.1.59","idVersion":""}
```

### 3.4 完整头清单（官方 WASM + JS 层生成，实测输出）

```
Accept: text/event-stream
Authorization: Bearer COSY.<…>.<md5>
Content-Type: application/json
Cosy-Business-Product: qoder_work        ← CN 分支（QODER_WORK_INTEGRATION_MODE=1）
Cosy-Business-Type: agent
Cosy-ClientType: 6                       ← CN 分支（全球为 5/cli）
Cosy-Data-Policy: agree | disagree       ← 随 data_policy_agreed
Cosy-Date: <unix秒>
Cosy-Key: <RSA 封装的 AES key，base64>    ← 真材料时非空
Cosy-MachineId / Cosy-MachineToken: <本机 machine-id（UUID）>
Cosy-MachineType: 5
Cosy-MachineOS: x86_64_win32             ← ${arch}_${platform}
Cosy-MachineHostname: <os.hostname()>    ← 仅 infer-sse 时注入
Cosy-Organization-Id: <组织 UUID（存在时）>
Cosy-Scene: qwork
Cosy-User: <uid>
Cosy-Version: 1.1.59
Login-Version: v2
X-Model-Key: <挡位 key>
X-Model-Source: system
X-Request-ID / X-Session-ID              ← model-server 路径才要求
```

### 3.5 响应

仍为 SSE 双层包装：`data:{"headers":{…},"body":"<内层 JSON>","statusCodeValue":200}`。

## 4. 签名材料链（WASM 输入 → 请求）

```
① 材料生成（WASM generate_runtime_auth_fields）：
   JSON: {uid, security_oauth_token(=access token), organization_id, organization_tags, data_policy_agreed}
   →    {encrypt_user_info, key}

② 上下文构造：
   new QoderContext(machineId, cosyVersion, JSON.stringify({uid, encrypt_user_info, key, organization_id,
                    organization_tags, data_policy_agreed}), JSON.stringify(clientInfo))
   clientInfo = {client_type:"6", business_product:"qoder_work", business_type:"agent", scene:"qwork"}
   machineId  = ~/.qwenworkcn/machine-id（与 App 用户数据一致；由 main.log 交叉验证）
   cosyVersion = "1.1.59"

③ 请求构造：
   ctx.prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)
   → {url, headers, body}（headers 即 §3.4；body 为 Encode=1 加密体）

④ 环境变量（App spawn worker 时注入）：
   QODER_WORK_INTEGRATION_MODE=1、QODER_SCENE=qwork、QODERCN_SCENE=qwork、QODER_SITE=cn、
   QODER_CONFIG_DIR=~/.qwenworkcn
```

legacy body 结构（WASM 输入侧，非 OpenAI 格式）：

```json
{"model_config":{"key":"flash","display_name":"标准","model":"","format":"openai","is_vl":true,
  "is_reasoning":true,"api_key":"","url":"","source":"system","max_input_tokens":1000000},
 "messages":[…],"stream":true,"request_id":"…","request_set_id":"…","session_id":"…","parameters":{}}
```

## 5. 可复现工具与方法

| 工具 | 位置（临时/仓库） | 用途 |
|---|---|---|
| 字符串解码 | `worker.decoded.mjs` 生成脚本 | `_$d1` 编码 = base64 + 循环 XOR，key=`"YwXnXr8xjW5k"` |
| **协议预言机** | `probe.mjs`（由 obf.mjs 改造） | 加载官方 WASM，直接调用 `generate_runtime_auth_fields` / `QoderContext` 生成真请求 |
| **宿主模拟器** | `host-sim.mjs` | 以 SDK 模式 spawn 官方 worker，回应 `fetch_job_token`，驱动完整推理链 |
| 插桩版 | `worker.instr.mjs`（gen-instr.cjs 生成） | 在 `applyExternalToken` / `openApiJsonRequest` / `To()` 等关键路径打点 |
| 诊断脚本 | `scripts/probe-models.ts`（仓库内） | 逐挡位探测服务端反应（明文模式） |
| 目录拉取 | `src/client.ts` 的 `fetchModelCatalog()` | 新目录接口的正式实现 |

关键工程事实（逆向用）：

- worker 的 auth payload 文件格式：`{"type":"jobToken","jobTokenProvider":"host"}`（45 字节，可从日志 `first32Hex` 还原）；
- SDK 模式触发：`QODER_AGENT_SDK_ENTRYPOINT` 非空 + `--print --input-format stream-json --output-format stream-json`；
- 控制帧：`{type:"control_request", request_id, request:{subtype, …}}` ↔
  `{type:"control_response", response:{subtype:"success", request_id, response:{…}}}`（token 在此回传：`{token, expires_at}`）。

## 6. 实测矩阵与未解问题

| 场景 | 结果 |
|---|---|
| 旧挡位裸请（无 x-model-key） | 内层 403 `Model is not available for this user` |
| 旧/新挡位 + `x-model-key`（明文 body） | 内层 503 `Model catalog unavailable` |
| 完整官方 WASM 链（真材料 + 真 machineId + 正确 scene/org） | **仍 503**（body 为 WASM 加密体、头与官方全同） |
| 目录接口（GET /api/v2/model/list?Encode=1） | **200** ✓（旧签名链可用） |
| **App 真实推理**（主人 22:26 发"测试"） | **200 ✓**（`[QoderInferResponse] status=200`，flash 挡位，含会话标题生成） |
| worker 内 `GET /api/v1/userinfo`（applyExternalToken 验证） | **401** —— 而未解之谜：**同一进程、同一时刻、同一 token** 直接 fetch → **200** |

**未解点（401/503 卡点，下一步方向）**：

1. worker 的 401 与同 token 直发 200 并存——已排除：token 不同（逐字符比对）、UA、IP（多 IP 直连）、
   HTTP/1.1/2、头部差异（`To()` 插桩 dump 一致）。剩余嫌疑指向 undici 连接细节或服务端对
   「SDK 模式 worker 请求」的另一层校验；
2. 探针 503 的可能原因：服务端对推理鉴权要求 WASM 链中**尚未复刻的某个环节**（如 `idVersion`、
   key 的封装一致性），或需要 App 侧 `fetch_job_token` 交换出的**专用 token**（而非 access token 直传）。

## 7. 对插件的影响与当前状态

- ✅ **已适配**：新挡位默认值（`AVAILABLE_MODELS=flash,pro,qwen3.8-max-preview`）、`DISPLAY_NAMES`
  （Standard/Pro/Qwen3.8-Max）、静态头（`Cosy-Version: 1.1.59`、`Cosy-MachineOs` 按平台生成）、
  `x-model-key` 头、目录接口 `fetchModelCatalog()`、诊断脚本 `scripts/probe-models.ts`；
- ⏳ **待完成**：推理转发的新版 WASM 签名链（`Encode=1` 加密体）——完成前推理请求会被服务端 503；
- 适配路径建议（优先级序）：
  1. 用官方 WASM 作为「预言机」逐项补齐差异（对比 App 真实请求的完整字节）；
  2. 抓取一次 App 真实推理的完整请求（需临时对 worker 做流量观察）；
  3. 跟进 §6 未解点。
