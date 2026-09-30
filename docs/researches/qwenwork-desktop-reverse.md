# 千问办公桌面 App 逆向分析（QwenWorkCN Desktop，safeStorage/Cosy/签名）

> **状态**：✅ **完全离线独立调用已实现**（自造 authorization/cosy-key + 明文 body，验证 200 + glm-5.2 推理成功）
> **最后更新**：2026-08-02
> **目标应用**：`QwenWorkCN.app` v0.1.3（BundleID `cn.qwenwork.desktop.mac`）
>
> **姊妹篇**：[qwenwork-web-login-research.md](./qwenwork-web-login-research.md) — Web device-flow 登录（2026-09-30，无需 App 的凭据自举）

---

## 0. 一句话结论

千问办公是**钉钉出品的 Qoder 系 Electron 应用**，登录走钉钉账号，推理请求经 `gateway.qwenwork.cn` 路由到**智谱 `glm-5.2`**（`maas-glm`）。其鉴权由**阿里 SecurityGuard SDK** 双层签名保护——账户层（`x-sign`/`x-umt`/`x-mini-wua`）已被黑盒突破，但推理专用签名 `cosy-key` 藏在 `qoderclicn` 内嵌 wasm 中，尚未攻破。

---

## 1. 应用真身与架构

### 1.1 真身

| 维度 | 值 |
|------|-----|
| 应用 | `/Applications/QwenWorkCN.app`，纯 Electron 壳 |
| 内部代号 | **Qoder**（`Qoder_welcomemotion.riv`、`qoder-auth-wasm`）|
| 出品方 | `author: DingTalk`（`package.json`），更新源 `static.qoder.com.cn/qwen-work-cn/releases` |
| 登录体系 | **钉钉账号**（`dingtalk_uid`、`@dingtalk.local` 邮箱）|
| 与悟空关系 | 复用悟空的 `~/.real` agent 运行时（bun/node/python/playwright/uv/dws），但 UI、网关、协议全新 |

### 1.2 进程架构

```
QwenWorkCN (Electron 主进程, pid)
  ├─ Chromium 渲染层（账户/配置类请求，走系统代理）
  ├─ @qoder/security-guard (native addon, 阿里 SecurityGuard)
  └─ spawn qoderclicn（100MB bun-compile 二进制，推理真正发起者）
        └─ 内嵌 wasm 版 SecurityGuard（生成 cosy-key + 加密 body）
              ↓ HTTPS
        gateway.qwenwork.cn  →  智谱 MaaS (maas-glm)  →  glm-5.2
```

关键二进制：
- `Resources/bin/qoderclicn` — 100MB，bun compile，推理 agent CLI
- `app.asar.unpacked/node_modules/@qoder/security-guard/` — 阿里 SecurityGuard SDK
  - `build/Release/qoderwork_security_guard.node` — Node-API addon（728KB，arm64 Mach-O）
  - `vendor/mac/SecurityGuardSDKMac.framework` — 阿里 SecurityGuard 动态库
  - `vendor/mac/.../Resources/ps/*` — 动态策略文件（AVMP/算法下发，二进制加密）

---

## 2. 网关与推理协议

### 2.1 网关发现

- Electron 主进程硬编码默认网关 `dingtalk-gw.qoder.com.cn`（`getGatewayUrl()`，**实际幌子**）
- 真实推理网关 **`gateway.qwenwork.cn`**，启动时经 `/algo/api/v3/service/region/endpoints` **动态发现**
- 网关 IP：`106.15.232.147` / `47.103.56.249`（阿里云上海 NLB `cn-shanghai.nlb.aliyuncsslb.com`，纯国内）

### 2.2 推理端点

```
POST https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

- `Encode=1`：请求体经加密 + base91 编码（见 §5.3）
- 响应 `text/event-stream`（SSE），每个 `data:` 帧是 JSON

### 2.3 推理响应（暴露后端模型）

响应头：
```
x-model-name: glm-5.2              ← 智谱 GLM-5.2
x-provider-name: maas-glm          ← 智谱 MaaS 平台
```
响应体（OpenAI 兼容 chunk）：
```json
{"choices":[{"delta":{"content":"","reasoning_content":"The","role":"assistant"},"index":0}],
 "model":"qwork-advanced","object":"chat.completion.chunk"}
```
- `x-model-key: qwork-advanced` / `lite` 是**应用层档位名**，实际路由到 `glm-5.2`
- `lite` 档位对当前账号返回 `403 Model is not available for this user`

### 2.4 协议定义文件

`qoderclicn` 内嵌 `chat.proto`（gRPC protobuf，OpenAI 兼容 schema）：
```protobuf
package model.chat;  // java_package = "com.qoder.grpc.model.chat"
message ChatCompletionRequest {
  string model = 1;  repeated ChatMessage messages = 2;
  google.protobuf.DoubleValue temperature = 3;
  google.protobuf.Int32Value max_tokens = 5;
  bool stream = 6;  repeated Tool tools = 16;
  ResponseFormat response_format = 18;  StreamOptions stream_options = 20;
  map<string, ChatPatchList> patches = 21;  ChatMetadata metadata = 22;
  // ...含 multimodal(ContentPart/ImageUrl/InputAudio)、ReasoningItem(encrypted_content)
}
enum ReasoningEffort { ..._LOW=2; ..._MEDIUM=3; ..._HIGH=4; ..._XHIGH=5; ..._MAX=6; }
```

---

## 3. 鉴权体系

### 3.1 推理请求头（完整实测）

```
accept: text/event-stream
authorization: Bearer COSY.<JWT>            ← 推理密钥（见 §3.2）
content-type: application/json
cosy-business-product: qoder_work
cosy-business-type: agent
cosy-clienttype: 6
cosy-data-policy: disagree
cosy-date: <unix秒>                          ← 时间戳
cosy-key: <base64 签名>                      ← 推理专用签名（见 §6，未攻破）
cosy-machineid: unknown
cosy-machinetoken: unknown
cosy-machinetype: 5
cosy-scene: qwork
cosy-user: <user_id>
cosy-version: 1.0.47
login-version: v2
x-model-key: qwork-advanced                  ← 模型档位
x-model-source: system
cosy-machineos: aarch64_darwin
traceparent: 00-<traceId>-<spanId>-01        ← OpenTelemetry
user-agent: node                             ← qoderclicn(bun) 发出
```

> 注：`cosy-clienttype` / `cosy-machineos` / `cosy-version` 由 qoderclicn JS 构造；
> `cosy-key` / `cosy-user` / `cosy-date` / `cosy-business-*` / `cosy-scene` / `cosy-machinetoken`
> 由 **security-guard 在 native 层注入**（asar 中无这些字面量）。

### 3.2 密钥：`Bearer COSY.<JWT>`

- 格式：`COSY.` 前缀 + JWT（约 1565 字符）
- JWT header（明文）：`{version:"v1", requestId, info:<加密会话段>, cosyVersion:"1.0.0", ideVersion:"0.1.3"}`
- **动态短期签发**：由 `IdpAuthTokenProvider` 用 PAT/OAuth 换取，`refreshTokenIfNeeded()` 自动刷新
- 与悟空静态 `sk-` key（29 天有效）本质不同
- PAT 环境变量：`PERSONAL_ACCESS_TOKEN`（Electron 端 `QODER_PAT`，存于 `auth.dat`，macOS safeStorage `v10` 加密）

### 3.3 直连重放验证

用抓到的完整 headers + body（含原 cosy-key）直连重放：
```
HTTP 403 {"code":"101","message":"Signature invalid"}
```
→ COSY token 被接受（非 401），但 `cosy-key` 签名校验失败 → **防重放/防独立复用**。

### 3.4 设备风控（账户类请求）

`qwenwork.cn` 账户 API（userinfo/balance/identities）用 cookie（`ory_hydra_session`）+ `state` 参数：
```json
state = base64({"v":1,"umid_token":"P1gAtDgiptQdv1dx3Ehf...",
                "x_mini_wua":"<阿里wua签名>","ip":"10.0.0.134","user_agent":"..."})
```
`umid_token` + `x_mini_wua` 由 `@qoder/security-guard` 生成（见 §5）。

---

## 4. 安全防护链：阿里 SecurityGuard SDK

`@qoder/security-guard` 底层是**阿里云 `SecurityGuardSDKMac.framework`**（商业级反逆向 SDK），提供设备指纹、白盒密码、请求签名、反调试。

### 4.1 native Obj-C 方法（framework 暴露）

| Obj-C 方法 | 作用 |
|-----------|------|
| `tokenSign:method:input:error:` / `17CDynamicTokenSign` | **请求签名（cosy-key 候选）** |
| `GenerateSignatureBaseString:input:error:` | 生成签名基串 |
| `encryptWithAppkey:input:method:error:` | **数据加密（body Encode）** |
| `decryptWithAppkey:input:method:error:` | 数据解密 |
| `getMiniWua:` | **生成 x-mini-wua 风控签名** |
| `getUmidToken` / `initUMID:` | umid 设备指纹 |
| `getSecurityFactors:error:` | **批量生成安全因子（x-sign/umt/wua）** |
| `getGeneralConfig:callback:error:` | 动态配置 |
| `bundleIdentifier` | **校验调用方 bundle id** |

### 4.2 JS 接口（`index.js` 导出）

`load / init / generateKey / encrypt / decrypt / getKey / shutdown / initUmid / getUmidToken / getSecurityFactors / getExtraData`

> ⚠️ **无 `sign` 接口** —— `cosy-key` 签名（tokenSign）未对 JS 暴露。

### 4.3 关键常量

| 常量 | 值 | 用途 | 出处 |
|------|-----|------|------|
| `BUSINESS_ID` | `"qwenwork"` | CryptoService 加解密 init | `main.js` |
| `constants$2.S` | `"35393215"`（darwin）| SecurityFactor 签名 appKey | `chunks/constants-DvYZdF2z.js`（= build 号 `Ln[platform]`）|
| `AUTH_CODE` | `"MK2c"` | 签名鉴权码 | `main.js` |
| `QWENWORK_CN_CLIENT_ID` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | OAuth client_id | `main.js` |

### 4.4 SgsCertError 错误码

```
0      SUCCESS
-1     INVALID_PARAM
-2     NOT_INIT
-3     ALREADY_INIT
-4     KEY_NOT_FOUND
-5/-6  ENCRYPTION/DECRYPTION_FAILED
-7     EXPORT_FORBIDDEN      ← 白盒密钥禁止导出
-8      INSUFFICIENT_MEMORY
-9      INTERNAL
-10    DEBUGGER_DETECTED     ← 反调试（frida/lldb）
-11    UNAUTHORIZED_CALLER   ← 进程身份校验失败（非千问办公进程）
-12    UNSUPPORTED_ALGORITHM
```

### 4.5 CryptoService / SecurityFactorService 契约（`main.js`）

```js
// CryptoService（对称加解密）
init()                       → native.init("qwenwork")
ensureKey(keyId)             → native.generateKey("qwenwork", keyId, false)
encryptBytes(keyId, data)    → native.encrypt("qwenwork", keyId, Buffer) → {code, data}

// SecurityFactorService（批量签名）
getFactors({api, data}) {
  return native.getSecurityFactors(JSON.stringify({
    appkey: "35393215", api, data, authCode: "MK2c"
  })) → { factors }   // 含 x-sign / x-umt / x-mini-wua
}

// UmidService
initUmid(0) / getUmidToken(0) → { token }
```

---

## 5. 逆向突破

### 5.1 突破 `UNAUTHORIZED_CALLER`（进程身份锁）

独立 node `require()` addon 时 `init` 返回 `-11 UNAUTHORIZED_CALLER`（framework 校验调用进程签名/bundle 必须是 `cn.qwenwork.desktop.mac`）。

**绕过手法**：用千问办公二进制 + `ELECTRON_RUN_AS_NODE=1` 当 node 解释器跑脚本——进程映像仍是 QwenWorkCN，身份校验通过：

```bash
ELECTRON_RUN_AS_NODE=1 /Applications/QwenWorkCN.app/Contents/MacOS/QwenWorkCN your_script.js
```

验证：
```js
const MOD='/Applications/QwenWorkCN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder/security-guard';
require(MOD).load(MOD+'/vendor/x64/SecurityGuardSDK64.dll');  // → true
require(MOD).init('qwenwork');                                 // → 0 (SUCCESS)
```

### 5.2 黑盒生成签名三元组（账户层已突破）

```js
const sg = require(MOD); sg.load(...); sg.init('qwenwork');
const r = sg.getSecurityFactors(JSON.stringify({
  appkey: "35393215",
  api: "/api/v1/userinfo",
  data: "<请求体>",
  authCode: "MK2c"
}));
// r.factors（字符数组，join 后）=>
// {"x-sign":"mb00010010<48hex>","x-umt":"<umid>","x-mini-wua":"<wua>"}
```

- `x-sign` 随 `api`/`data` **动态变化**（已验证）→ 请求签名可独立生成
- `x-umt` 与抓包 `state.umid_token` **完全一致** → 设备指纹可复现
- **结论：千问办公的账户/通用类 API（`qwenwork.cn/*`）可独立签名调用**

### 5.3 body `Encode=1` 加密链路（已突破）

```
明文 JSON
  → security-guard encrypt("qwenwork", keyId, Buffer)   // 阿里白盒加密，输出 base64 文本
  → base91 编码                                          // qoderclicn 内 b91，字符集含 ,()#&^*@/+%
  → 放入请求体（Content-Type 仍 application/json）
```

加密层（`encrypt`）已黑盒可用；base91 为标准编码，可复现。

### 5.4 `generateKey` / `encrypt` 可用性

`generateKey("qwenwork", <任意keyId>, false)` 全部 SUCCESS；`encrypt` 输出 base64 加密数据。

---

## 6. 硬墙：`cosy-key` 会话密钥封装

### 6.1 本质（动态实证）

通过抓 5 次推理请求（跨多 turn、多对话、`cosy-date` 233→241、`x-model-key` advanced/lite 混用）对比，确认：

| 特征 | 实测 |
|------|------|
| 会话内取值 | **5 次完全相同**（唯一值=1）|
| 与 `cosy-date` 关系 | 无关（date 变，key 不变）|
| 与请求体关系 | 无关（body 长度 4K~235K 各异，key 不变）|
| 与 `x-model-key` 关系 | 无关（advanced/lite 都用同一 key）|
| 解码长度 | **base64 172 字符 → 128 字节**（高熵随机，无结构） |

→ **cosy-key 不是「每请求签名」，而是 RSA-1024 封装的会话对称密钥**（128 字节 = RSA-1024 密文长度，会话级固定）。

完整密钥协商模型推断：
```
会话开始：客户端生成随机对称密钥 K
cosy-key = RSA-1024-OAEP(服务端公钥, K)      ← 128 字节，会话内固定
body Encode=1 = AES(K, JSON) + base91         ← 不同 body 用同一 K 加密
服务端：用 RSA 私钥解 cosy-key 得 K，用 K 解 body
```

### 6.2 已穷尽的验证

| 验证 | 结果 |
|------|------|
| `.node` 11 个 JS 函数找 sign | **无 sign/RSA 接口**（`encrypt` 只做流密码，输出=输入长度）|
| `getKey(appKey, keyId)` | `EXPORT_FORBIDDEN(-7)` / `KEY_NOT_FOUND(-4)` |
| asar 全文（main + 全部 chunks）搜 `cosy-key` | **0 处** → 不在 Electron 主进程 |
| qoderclicn 二进制搜 `cosy-key` | **0 处**（仅有静态 `cosy-clienttype/machineos/version`）|
| `getSecurityFactors` 输出 | `x-sign`(hex)/`x-umt`/`x-mini-wua`，无 128 字节项 |
| RSA-1024 公钥明文搜索（framework 974KB + qoderclicn 97MB + .node） | **0 处**（仅 6 个 RSA-2048 公钥，尺寸不符）|
| framework 明文算法名 | **无**（阿里 SecurityGuard 混淆）|

### 6.3 定位：阿里 SecurityGuard 白盒密码（静态层面）

- `cosy-key` 由 security-guard native 的 `tokenSign` / `17CDynamicTokenSign`（RSA 操作）生成，`.node` 未对 JS 暴露
- 二进制静态搜索：RSA-1024 公钥**无明文 ASN.1**（framework 974KB + qoderclicn 97MB + .node 均 0 处），仅 6 个 RSA-2048
- framework 无明文算法名（实现混淆）
- 配套 `-10 DEBUGGER_DETECTED` 挡 frida/lldb **外部** attach；hardened runtime + SIP 挡 task_for_pid

→ 静态层面看似白盒硬墙。但见 §6.4 突破。

### 6.4 突破：RSA-1024 公钥运行时内存提取

**绕过链**（绕过 hardened runtime + SIP + 反调试全部拦截）：
- `ELECTRON_RUN_AS_NODE=1` 用千问办公二进制当 node 跑 → sg `init` SUCCESS（绕 `-11 UNAUTHORIZED_CALLER`，进程身份合法）
- 进程内用 **koffi（FFI）调 `mach_vm_region` + `mach_vm_read`** 读**自己**的内存（`mach_task_self()`，进程对自己内存有无限制访问，不经 task_for_pid → 绕过 SIP/hardened/反调试全部拦截）
- frida 全路径（attach / spawn / self-attach）均被 hardened 拒，但 `mach_vm_read(self)` 不受影响

扫描 0.58GB 内存（12424 区域），命中 **3 个 RSA-1024 公钥**（运行时解密到堆，二进制静态无）：

| # | modulus 头 | exp | SPKI PEM 长度 |
|---|-----------|-----|--------------|
| 1 | `f1944ac9eaba5a18...` | 65537 | 140B（MIGf...）|
| 2 | `950fa0b6f0509ce8...` | 65537 | 140B |
| 3 | `d236366a8bd7c25b...` | 65537 | 140B |

OpenSSL 验证：3 个公钥均为合法 RSA-1024（Public-Key: 1024 bit）。

→ **证明「RSA 公钥是公开信息、运行时内存可提取」**——完全离线的唯一硬卡被攻破。3 个公钥之一用于 cosy-key 封装（待端到端确认是哪个 + RSA padding：OAEP/PKCS1）。

### 6.5 端到端实验最终结论（防重放死锁）

**body 加密方向**：qoderclicn 二进制含 **ChaCha20 sigma "expand 32-byte k"**（3 命中）+ 标准 base91 字符表（94 字符）→ body 加密 = **ChaCha20(K, nonce, JSON) + base91**（流密码，K 与 cosy-key 共享，K=RSA-OAEP-SHA1 解出来的会话密钥）。

**端到端实验全部失败于防重放**（已穷尽验证）：

| 实验 | 结果 |
|------|------|
| 原样重放（原 JWT+原 cosy-key+原 body） | `103 Duplicate request` |
| 原样重放 + 全新 traceparent | `103 Duplicate request` |
| 抓 JWT + 自造 cosy-key(pub1/OAEP-SHA1) + sg/chacha20/aes body | `103 Duplicate`（偶发 `101 Signature invalid`）|

→ **Duplicate 基于 COSY JWT（或 JWT+requestId）请求级幂等**，非 cosy-key/traceparent/body 加密。抓的凭证一旦被千问办公原始请求用过，**任何复用（含原样重放）都 Duplicate**。

千问办公自己多次成功，是因为每次 body 内含新 requestId（加密在 body 内），服务端解 body 取 requestId 查重。**我自造 body 无法验证格式对错**——因 JWT 幂等在 body 解密前就拦截，到不了 body 验证阶段。

### 6.6 完全离线的真实卡（最终）

cosy-key 算法（pub1/OAEP-SHA1）、body 加密方向（ChaCha20+base91）、RSA-1024 公钥——**都已定位**。真正的卡是：

1. **COSY JWT 会话建立 + 防重放**（核心卡）：
   - 抓的 JWT 不可复用（防重放），必须**新生成** JWT
   - 需解 `auth.dat`(safeStorage) 拿 PAT → 逆向 OAuth/会话签发链 → 服务端签发新 JWT + 新 cosy-key
   - 可能还要匹配客户端 TLS 指纹（服务端或检测重放来源）
2. **body 内 requestId 结构**：解出 body 后才能确认（依赖新 JWT 验证）

→ 完全离线从「cosy-key/body 加密逆向」转化为「**JWT 会话建立 + 防重放绕过**」问题，工程量上升一个量级（涉及 safeStorage 解密、OAuth 逆向、可能 TLS 指纹模拟）。

### 6.8 ✅ 完全破解：离线独立调用算法（已验证 200 + glm-5.2 推理）

**完整密钥链**（全部客户端本地生成，无需服务端签发、无需千问办公运行）：

```js
// 1. 密钥材料：auth.dat(safeStorage) 解密 → OAuth access token
//    safeStorage: Keychain "QwenWorkCN Safe Storage"/"QwenWorkCN Key" → PBKDF2(pw,"saltysalt",1003,16,sha1) → AES-128-CBC(IV=0x20×16, v10头3B)

// 2. encryptUserInfo({uid,name,email,security_oauth_token}) → {info, key, uid}
e = randomUUID().substring(0,16)                       // 16B 随机 AES key
info = base64(AES-128-CBC(key=e, iv=e前16字节=e, JSON(userInfo)))
key  = base64(RSA_PKCS1(asar RSA_PUBLIC_KEY, e))       // ← cosy-key header！
//    RSA_PUBLIC_KEY = asar 硬编码 PEM（modulus 头 c0f223...，≠ 内存提取的 pub1）

// 3. generateAuthToken → authorization
o = base64(JSON({version:"v1", requestId:uuid, info, cosyVersion:"1.0.0", ideVersion:"1.0.0"}))
path = url.pathname; 去 query; 若 /algo 前缀则 slice(5)
md5签名 = md5(`${o}\n${cosy-key}\n${timestamp}\n${body}\n${path}`)
authorization = `Bearer COSY.${o}.${md5签名}`

// 4. body（关键：明文 JSON，不加 Encode=1！）
//    Encode=1 是千问办公的 base91 压缩优化，服务端也接受明文
//    必需字段：request_id、session_id（逐缺逐补，400 报错揭示）
//    可选：model=qwork-advanced(→glm-5.2)、messages、stream、max_tokens

// 5. headers
Cosy-User: uid    Cosy-Key: cosy-key    Cosy-Date: timestamp
Cosy-Business-Product: qoder_work    Cosy-Scene: qwork    ...
```

**验证结果**（本机直连 gateway.qwenwork.cn，无千问办公运行）：
```
HTTP 200 | x-model-name: glm-5.2 | x-provider-name: maas-glm
回复：「我是由Z.ai开发的GLM大语言模型，且当前为云端在线调用而非离线独立调用。」
```

**复盘此前的死锁**：端到端一直 Duplicate，是因为复用抓的 authorization（其 md5 签名绑定原 body/path/时间戳）。自造 authorization（每请求新 ts+body）即绕过全部防重放。

**关键修正**：cosy-key = RSA_PKCS1（**非 OAEP**，代码 `RSA_PKCS1_PADDING`）；公钥 = asar 硬编码 `c0f223...`（非内存 pub1 `f1944a...`，那是 security-guard 内部用的）。

### 6.9 token 自动刷新（已验证，闭环）

OAuth access token 约 1 小时过期，自动续期：

```js
// device token 刷新（refreshStrategy: device_token）
POST https://gateway.qwenwork.cn/api/v1/deviceToken/refresh
{"refresh_token": "<ory_rt_...>", "target": "c"}
→ {"device_token": "<新JWT>", "refresh_token": "<新ory_rt_（轮换）>", "expires_at": ...}
```

验证：新 token + 自造签名 → HTTP 200 + glm-5.2 推理成功。

> 备注：标准 OAuth `/auth/oauth/token`（grant_type=refresh_token）被 `invalid_client` 拒——client 是运行时动态注册的（registration_endpoint），且 `refreshStrategy=device_token` 走 deviceToken/refresh 专用端点。另：浏览器 OAuth 授权码流（PKCE + client_id `e883ade2-...`）不是 refresh 路径。

### 6.10 攻击面备忘（最终）

- ✅ **完全离线独立调用**（§6.8 算法 + §6.9 token 自动刷新，均已实测 200）
- ✅ `ELECTRON_RUN_AS_NODE + koffi + mach_vm_read(self)`：绕过 hardened 提取运行时密钥
- ✅ safeStorage 解密（Keychain + PBKDF2 + AES-CBC）
- ❌ frida（hardened+SIP 拒）、❌ 抓的凭证复用（防重放）、❌ 标准 OAuth refresh（client 动态注册）

---

## 7. 抓包方法（可复现）

千问办公的推理由 qoderclicn（bun 子进程）发出，**默认 `{proxy.mode:"system"}` 时 qoderclicn 直连、不走系统代理**（与悟空 daemon 行为相反）。抓包需：

1. **退出 Clash Verge**（释放系统代理 7897）
2. **改 `app_settings` 写入 manual 代理**：
   ```sql
   INSERT INTO app_settings(key,value,updated_at) VALUES('proxy',
     '{"mode":"manual","url":"http://127.0.0.1:8888"}',<ms>);
   -- 库：~/Library/Application Support/QwenWorkCN/data/agents.db
   ```
3. **注入 CA**（bun 不读 macOS keychain）：`launchctl setenv NODE_EXTRA_CA_CERTS ~/.mitmproxy/mitmproxy-ca-cert.pem`
4. **开系统代理 8888 + 重启千问办公**（让设置生效）
5. mitmdump 抓 `gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation`

> 设置默认值：`SETTING_DEFAULTS.proxy = {mode:"system"}`；`getManualSdkProxyDecisionFromQoderWorkSetting()` 仅 `mode==="manual"` 时返回代理，否则 `direct`。

---

## 8. 与钉钉悟空（DEAP）对比

| 维度 | 悟空 DEAP | 千问办公 |
|------|-----------|----------|
| 后端模型 | 通义千问/Claude/GPT（DEAP 多模型）| **智谱 glm-5.2**（maas-glm）|
| 网关 | `api-deap.dingtalk.com` | `gateway.qwenwork.cn`（动态发现）|
| 密钥 | 静态 `sk-`（29 天）| 动态 `COSY.JWT`（短期刷新）|
| 请求签名 | 无 | ~~`cosy-key`(wasm 白盒) + `x-sign`(SecurityGuard)~~ **已破解**：RSA_PKCS1(asar 公钥) + MD5 签名（见 §6.8）|
| 请求体 | 明文 JSON | ~~`Encode=1` 加密~~ **明文 JSON 即可**（网关接受，见 §6.8）|
| 设备风控 | 无 | `umid_token` + `x_mini_wua`（阿里 SecurityGuard，账户层；推理层不校验）|
| 独立复用难度 | 低（提取 sk- 即可）| ~~高~~ **已实现完全离线独立调用**（见 §6.8）|
| 抓包代理 | 认系统代理 | 认 `proxy.mode=manual` 设置（默认直连）|

---

## 9. 已知边界（已更新）

- ~~`cosy-key` 未破~~ → **已破解**（§6.8）：`cosy-key` = `base64(RSA_PKCS1(asar 硬编码公钥, random 16B AES key))`，完全离线独立生成
- ~~推理请求无法脱离千问办公独立复用~~ → **已实现完全离线独立调用**（§6.8 验证 HTTP 200 + glm-5.2 推理成功）
- COSY JWT 动态短期 → access token ~1h 有效，但已通过 `deviceToken/refresh` + safeStorage 解密实现自动刷新链（§6.9）
- `qoderclicn` wasm 签名逻辑**已被纯 Node.js 实现替代**（`src/signer.ts`），无需调用 wasm
- 账户层 `x-sign`/`x-umt`/`x-mini-wua`（SecurityGuard）：推理层**不校验**这些头，仅 Cosy 签名即可通过网关鉴权

---

## 10. 参考资料

- asar 解包：`npx @electron/asar extract app.asar /tmp/qwen_asar`
- 静态搜索辅助：`/tmp/g.py`（minified 大文件正则上下文）
- 原始抓包脚本：`/tmp/cap_qoder.py`（mitmproxy addon，已焚含密钥日志）
- 本项目悟空侧：[WUKONG_REVERSE.md](./WUKONG_REVERSE.md)
- 架构文档：[../ARCHITECTURE.md](../ARCHITECTURE.md)
