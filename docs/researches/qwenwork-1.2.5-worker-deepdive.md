# 千问办公 1.2.5 worker 深度逆向记录（2026-10-01 会话）

> 承接 [`qwenwork-1.2.5-update.md`](./qwenwork-1.2.5-update.md)（2026-09-30：新挡位体系、WASM 签名链、503 卡点）。
> 本会话通过 **`--inspect-brk` + CDP 运行时注入** 手段，彻底揭示了 **worker 的运行形态、通信协议全貌、job token 真实性**，
> 并把 503 的根因收窄到「服务端侧状态判定」。**推理转发尚未打通**，未解点见 §6。

## 0. 一句话结论

1. **worker 不是独立进程**——其 pid **等于 App 主进程 pid**（`role="main"` 自述），以「主进程内的隔离运行时」形态存在；
2. **worker ↔ 主进程通信 = `MessagePort` 封装的 stdio 协议**（`stdioPayload` / `stdioWantsMoreData`）——本会话**完整捕获**了 `initialize → get_models → fetch_job_token → 用户消息 → control 流` 全链；
3. **job token ≡ access token**（与 `auth-v2.dat` 解密出的 token **逐字节相同**，583 字节，零差异）；
4. **每次用户发消息，主进程都会「动态 import `@qoder-ai/qoder-agent-sdk`」**（ESM resolve 序列为证）；
5. worker 的 HTTP 栈为 **undici**（bundle 自带副本）+ 自定义 Agent + **HTTPDNS**（`networkMode=httpdns`）；
6. 推理前固定调用序列：**`GET /api/v1/userinfo` → `GET /api/v3/user/status` → `GET /api/v2/user/plan` → 推理**；
7. 网关具备**反重放**：相同签名重发 → `{"code":"103","message":"Duplicate request"}`；
8. **503 行为已收窄**：带 `Encode=1` 时服务端**成功解码请求体**、进入推理管线，卡在「查模型目录」——即**服务端侧对『本会话的模型目录』的判定**（App 可用 / 探针不可用，差异仍未知）。

## 1. 重大发现详解

### 1.1 worker 的 pid = App 主进程 pid

**证据**（`~/.qwenworkcn/logs/runs/<run>/qodercli.log` 首行与多处）：

```
process.started run_id="2026-10-01T00-07-13-…-p2340" pid=2340 role="main"
[startup.phase] started phase=config.initialize pid=2340 …
[Config] Initial resource snapshot completed { …, pid: 2340, … }
```

配合进程树（主进程 2340 拥有 GPU/renderer/utility 等全部子进程）与 run 目录命名 `…-p2340`，
**「worker 的 pid」自述等于主进程 pid** 成为铁证。

**推论**：worker 运行在**主进程内部**（隔离运行时），而非子进程/常规 `worker_threads` 创建路径：
- `child_process` 全路径 patch（spawn/fork/execFile + `ChildProcess.prototype.spawn`）**实测有效**（捕获到其它子进程），但**从未捕获 worker**；
- `worker_threads.Worker` 类替换 + 原型 patch 生效（`workerClass=QwWorker`），**也从未捕获 worker 创建**；
- 系统级进程监控（WMI 轮询 250ms + 事件订阅）**完全没有 worker 的创建记录**——而 worker 明显在跑。
- **结论**：worker 的诞生不经过任何「可见的进程/线程创建 API」——它是**主进程内的隔离运行环境**（细节未完全解剖，见 §6）。

### 1.2 通信协议全貌（MessagePort 封装 stdio）

对 `worker_threads.MessagePort.prototype.postMessage` / `.on` / `.addEventListener` 注入 patch 后，
**完整捕获**了 worker ↔ 主进程的线程间消息（`worker-msg-capture.log`）：

**消息信封**（双向）：
```json
{"type":"stdioPayload","stream":"stdin|stdout|stderr","chunks":[{"chunk":"<原始文本行>","encoding":"utf8"}]}
{"type":"stdioWantsMoreData","stream":"stdout"}
```

**完整消息链（一次会话，实测顺序）**：

| # | 方向 | 内容 |
|---|------|------|
| 1 | 主→worker | `control_request` `{"subtype":"initialize","initializeTimeoutMs":120000,…}` |
| 2 | worker→主 | `control_response` success：`commands/agents/skills/models/account` + **capabilities 列表**（`interrupt_receipt_v1 / msg_lifecycle_v1 / session_rewind_v1 / background_tasks_v1 / plan_mode_v1 / host_action / commands_changed_v1 / …`）+ `pid:2340` |
| 3 | 主→worker | `control_request` `{"subtype":"get_models","fetchStrategy":"cache","uid":"<uid>"}` |
| 4 | worker→主 | `control_response` success：**完整模型目录**（flash/pro/… 全字段，含 `serverModel` 原文） |
| 5 | worker→主 | **`control_request` `{"subtype":"fetch_job_token","reason":"initial","session_id":"<uuid>"}`** |
| 6 | 主→worker | **`control_response` success：`{"token":"<JWT>","…"}`** ← ★ job token 本尊 |
| 7 | 主→worker | `{"type":"user","session_id":"…","message":{"role":"user","content":[{"type":"text","text":"<用户输入>"}]},…}` |
| 8+ | 双向 | `get_model_policy` / `get_context_usage` 等控制流；推理流式输出 |

### 1.3 job token ≡ access token（逐字节验证）

- 从消息 #6 提取的 token 与 `auth-v2.dat` 解密得到的 access token：
  - 长度均为 **583**；
  - `local === caught` → **true（逐字节完全相同）**；
- JWT payload（节选）：`app_id=qwenwork-desktop-app`、`iss=qwenwork.cn`、`exp−iat=7 天`、`scope=openid profile email offline_access qwen_work`。
- **意义**：**「App 用专属 job token」的假设被彻底否定**——探针手里的 token 就是 App 推理所用的凭证。

### 1.4 每次消息 → 主进程动态 import SDK

对主进程 inspector 注入 `Worker`/ESM 相关捕获后，观察到**每次用户发消息**都会出现：

```
[send>w] {"method":"resolve","args":["@qoder-ai/qoder-agent-sdk","file:///…/app.asar/out/main/main.js",{}]}
[send>w] {"method":"resolve","args":["drizzle-orm", …]}   × N
```

**即**：主进程对 SDK **按需动态解析/加载**，「用户消息 → 主进程 import SDK → SDK 驱动 worker」的链路每次重演。

### 1.5 worker 网络栈：undici + HTTPDNS

从 worker 日志（`qodercli.log`）：

```
[fetch] Direct Agent created: headersTimeout=300000ms, bodyTimeout=300000ms,
        keepAliveTimeout=55000ms, allowH2=undici-default, tcpKeepAlive=true, tcpKeepAliveDelay=15000ms
[httpdns-config] HTTPDNS enabled networkMode=httpdns httpdnsConfigured=true
```

- **HTTP 栈 = undici**（`allowH2=undici-default`），带自定义 Agent；
- **网络模式 = HTTPDNS**（自解析域名 → IP 直连）；
- **为什么主进程侧的 HTTP patch 全灭**：worker 运行在隔离环境，**bundle 自带依赖副本**（其 undici/net 与主进程 `Module._cache` 中的不是同一实例）——对主进程 `net.Socket` / `globalThis.fetch` / `undici.Client.prototype.dispatch` 的 patch **均无法覆盖它**。

### 1.6 catalog 本地缓存机制

- 目录缓存文件：`~/.qwenworkcn/.models/<uid>/catalog-v6`（**AES 加密的 base64 密文**，约 3.7KB；不同 uid 各一份）；
- 当前模型选择：`~/.qwenworkcn/.models/default` —— `{"key":"flash","uid":"<uid>","scene":"qwork","updatedAt":<ms>}`；
- worker 启动日志：`[catalog] Loaded 3 models from fresh disk cache (age 4s)`；
- 会话阶段日志：`phase="qoder_runtime.ready" … wait_catalog=true … reconcile_model=true` → `catalog_ready=true`。
- **意义**：worker 的「模型目录」来自**本地缓存**（App 同步维护），不是每次推理实时拉取。

### 1.7 推理前接口序列（实测）

worker 每次「用户轮次」的标准调用序列：

```
1. GET  /api/v1/userinfo            （用户信息）
2. GET  /api/v3/user/status         （用户状态）
3. GET  /api/v2/user/plan           （用户套餐）
4. POST /algo/api/v2/service/pro/sse/agent_chat_generation
        ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1   （推理）
5. POST /algo/api/v2/service/business/finish
6. POST /api/v1/tracking
```

推理条目附带契约参数：`requestClass=infer-sse`、`contractConnectTimeoutMs=10000`、`contractBodyIdleTimeoutMs=300000`、`networkMode=httpdns`。

### 1.8 网关反重放

对同一签名材料**原样重发** → 网关返回：

```json
{"code":"103","message":"Duplicate request"}
```

（与 AGENTS.md「不复用抓到的 JWT / cosy-key，会被反重放」的警告一致。）

## 2. 关键实验记录

### 2.1 URL 变体对照实验

以「拦截改写 URL」的方式（**每次运行探针都会生成新鲜签名**，规避反重放）：

| 变体 | 结果 | 解读 |
|---|---|---|
| **原样**（`&Encode=1` + WASM 加密体） | **503** `Model catalog unavailable` | 请求体被成功解码，进入推理管线，卡在「查目录」 |
| **去掉 `&Encode=1`**（体仍是加密体） | **400** `Invalid agent chat JSON body` | 无 `Encode=1` 时服务端按明文 JSON 解析 → 失败 |
| **无查询串** | 400 同上 | 查询串本身不影响判定 |

**结论**：`Encode=1` 与加密体是**配套开关**；503 是**「服务端在处理推理时『查模型目录』失败」**——而非「请求格式问题」。

### 2.2 patch 矩阵（注入点 → 效果）

| 注入点 | 实测效果 |
|---|---|
| `ChildProcess.prototype.spawn` + `spawn/fork/execFile` | **有效**（捕获到 `dws-core`、`bash`、`runtime-info` 等）——但**无 worker** |
| `net.Socket.prototype.write`（含 `agent_chat_generation` 关键词过滤） | **有效**（自身测试验证）——**零命中**（worker 不走主进程 net） |
| `globalThis.fetch` 包装 | 生效但零命中 |
| `undici.Client.prototype.dispatch` + `Dispatcher.prototype.request` | 生效但零命中（worker 的 undici 是 bundle 副本） |
| `worker_threads.Worker` 类替换 + `postMessage/on` 原型 patch | **捕获到 ESM loader 协议消息**；worker 本身未经过此路径 |
| **`MessagePort.prototype.postMessage/on/addEventListener`** | ✅ **全量命中**（worker 通信的真正载体） |
| `Module._load`（CJS 关键词） | 生效，无 SDK 命中（SDK 走 ESM 路径） |

### 2.3 进程监控（WMI）与「worker 不见之谜」

- 手段：`Win32_ProcessStartTrace` 事件订阅（权限不足被拒）+ 250ms 全量轮询（**可用**）；
- 结果：**worker 从未出现在任何进程快照中**——反向印证「worker 不是独立进程」（§1.1）；
- 副产品：捕获到 `dws-core-windows-amd64.exe`（qwenwork 沙箱执行组件）在部分时刻被主进程拉起，与 worker 活动**时间相近但无因果**（已排除）。

## 3. 方法论与工具（qw-dec 临时工具链）

> 位置：`C:/Users/xrl/AppData/Local/Temp/qw-dec/`（**不在仓库**；敏感材料见 §5）

| 工具 | 用途 |
|---|---|
| `worker.decoded.mjs` | 官方 worker bundle 的字符串解码版（`_$d1` = base64 + XOR `YwXnXr8xjW5k`） |
| `probe.mjs` | 协议预言机：加载官方 WASM，生成官方同款请求（目录 + 推理） |
| `host-sim.mjs` | 宿主模拟器：以 SDK 模式 spawn 官方 worker、应答 `fetch_job_token`、驱动推理 |
| `capture-inspector.mjs` | **本次核心**：连接 `--inspect` 的主进程 CDP，注入 stdio 捕获 patch |
| `inject-*.mjs`（多版本） | 各类运行时注入器：`inject-patch`（child_process）、`inject-workers`（worker_threads）、`inject-ports`（MessagePort）、`inject-http`（net/fetch）、`inject-undici2`、`inject-loader`（模块加载） |
| `probe-variant.mjs` | 变体实验：拦截改写推理 URL（`MODE=orig|noencode|noquery`） |
| `variant-test.mjs` | 捕获探针请求材料 + 变体重发对照 |
| `monitor-procs.ps1` | 系统级进程创建监控（WMI 轮询 + 事件） |
| `asar-extract.cjs` | app.asar 提取（list / cat） |
| `dump-token.ts` | 导出真实 token 材料（在仓库目录跑 `pnpm tsx`） |

**关键技术要点（踩坑记录）**：

1. **`--inspect-brk` 启动 Electron 主进程**（`Start-Process -ArgumentList "--inspect-brk=9333"`，或直接命令行传参）——主进程暂停等调试器；
2. **暂停态下 `Runtime.evaluate` 的死锁陷阱**：`await import(...)` 等异步操作在 **brk 暂停状态下永不 resolve**——注入代码必须**纯同步**（require 用 `process.mainModule.require`）；
3. **patch 生效三原则**：
   - 类替换（`exports.X = class …`）**对已快照的 ESM 具名导入无效**；
   - **原型方法 patch 有效**（`X.prototype.method` 运行时查找）；
   - **对「隔离运行时/自带 bundle」的进程内环境完全无效**（本次 worker 的核心特征）；
4. **反重放规避**：变体实验必须用「每次新鲜签名」的方式（改写 URL 放行），不能拿旧材料重发。

## 4. 503 状态的最终理解

**已排除**（硬证据）：

- ❌ token 差异（逐字节相同）
- ❌ URL/查询串差异（变体实验）
- ❌ 请求体编码格式（带 `Encode=1` 时被服务端成功解码）

**当前认知**：

- 503 `Model catalog unavailable` = **服务端在推理管线中「查本会话的模型目录」失败**；
- **App 的推理 200**（同为该 token、该机器、该网络）——**差异必然在「服务端可见的某个维度」**；
- 候选（未验证）：
  1. **前置接口状态**（userinfo → status → plan 的调用结果影响服务端目录判定）；
  2. **HTTPDNS 路径**（自解析 IP 直连 vs 常规 DNS）；
  3. **WASM 签名链中某个尚未对齐的字段**（如 `idVersion`、`Cosy-Key` 封装一致性）。

## 5. 安全与清理提醒

- **敏感材料**（均在临时目录，勿提交/勿外传）：`token.json`（真实 access token）、`payload.json`、各 `*-capture.log`（含真实 uid/machine-id/token 片段）；
- App 安装目录**未被修改**（本会话全部为**运行时注入**，重启 App 即完全复原）；
- 主进程调试端口（`--inspect-brk=9333`）**仅本机监听**；App 当前仍带该参数运行，**普通重启即恢复默认启动方式**。

## 6. 未解点与下一步（研究暂停于此处）

1. **worker 的「隔离运行时」具体实现**——既非 child_process、亦非常规 worker_threads，其创建点仍未被捕获（可能为主进程内自实现的 VM/沙箱级隔离）；
2. **503 的最后一层**——「服务端凭什么判定目录可用」；建议实验路径：
   - 以官方 worker（`host-sim` 驱动）**端到端复现**一次推理，确认「官方代码 + 探针宿主」是否 200，可二分锁定「宿主侧差异」；
   - 对 `userinfo/status/plan` 前置序列做**补调对照**；
   - 对官方 WASM 的 `prepareInferRequest` 输入**逐字段消融**。
3. **对插件的意义**：token 与签名链均无问题，**若最终确认 503 依赖「服务端目录注册状态」**，则插件侧需在推理前**补齐对应前置调用**（或适配 Encode=1 链）。

---

*会话时间：2026-09-30 夜 ～ 2026-10-01 凌晨（UTC+8）。全程未修改任何 App 文件；所有注入均为进程内、随重启失效。*
