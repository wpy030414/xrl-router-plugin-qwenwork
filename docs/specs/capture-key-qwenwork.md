# capture-key-qwenwork: 千问办公 Token 验证

## 目标

验证千问办公登录态有效性 + 刷新链完整性，并将新 refresh token 备份到 `.env` 的 `QWEN_KEYS`。

**定位变更**：改造后 token 管理由 `serve` 自动完成（`getToken()` 缓存 + 文件监听自动拾取 + 双向同步），`capture-key` 退化为**诊断工具**，日常使用只需 `pnpm serve`（千问 App 后台运行即可）喵～

## 输入输出

**输入：**
- macOS 或 Windows 环境
- 千问办公 App 已登录（`auth-v2.dat` 存在）
- macOS：Keychain 中存有 safeStorage 密码；Windows：`Local State` 的 `os_crypt.encrypted_key` 可 DPAPI 解包（同一 Windows 用户）

**输出：**
- 终端打印：登录用户信息、access token（脱敏）、refresh token（脱敏）、有效期
- `.env` 文件：`QWEN_KEYS=<ory_rt_...>` 行（新建或替换）

## 关键约束

### 主流程

1. **文件检查**：`settings.qwenOauthTokenPath` 必须存在
   - macOS 默认 `~/Library/Application Support/QwenWorkCN/auth-v2.dat`
   - Windows 默认 `%APPDATA%/QwenWorkCN/auth-v2.dat`
2. **解密 auth-v2.dat**：调用 `getToken()` → 触发 safeStorage 解密链路（macOS 弹 Keychain 授权；Windows 走 DPAPI→AES-256-GCM，无弹窗）
   - 打印用户名、邮箱、access token 脱敏值、有效期
3. **强制刷新**：调用 `forceRefresh()` → `refreshDeviceToken(cached.refreshToken)`
   - 验证刷新链可用（refresh token 未过期）
   - 打印新 access token + 新 refresh token（已轮换）
   - refresh 成功后自动写回 auth-v2.dat（双向同步）
4. **备份到 .env**：`writeEnvRefreshToken(next.refreshToken)`
   - 前置：`git check-ignore .env` 必须通过
   - 替换或追加 `QWEN_KEYS=` 行
   - 文件 mode 600 + `chmodSync(0o600)`

### 使用场景

| 场景 | 是否需要 capture-key |
|------|---------------------|
| 首次部署 / 换机器 | 是（验证解密 + 刷新链能跑通） |
| 日常使用 | 否（`pnpm serve` 自动管理） |
| token 全挂做诊断 | 是（看哪一步断了） |
| 千问 App 重新登录后 | 否（文件监听自动拾取） |

### 无网络拦截

纯本地密码学操作 + 一次 API 调用喵。

### .env 安全检查

```typescript
execSync(`cd "${REPO_ROOT}" && git check-ignore .env`, { stdio: 'ignore' });
```
- 未通过 → 中止，打印「.env 未被 git 忽略」
- 防止 refresh token 泄露到 git 历史

### 脱敏输出

`mask(s)` 函数：长度 > 12 → 显示前 12 + `…` + 后 4；否则显示 `(无效)`

## 验收标准

- [ ] macOS + 千问办公已登录 → 成功打印用户信息 + 刷新成功 + QWEN_KEYS 写入
- [ ] Windows + 千问办公已登录 → 同上（DPAPI 解密，无弹窗）
- [ ] auth-v2.dat 不存在 → 报错「请先在千问办公 App 登录」
- [ ] macOS Keychain 拒绝授权 → 解密失败 → 报错 + 排查提示
- [ ] Windows powershell 不可用 → 解密失败 → 报错「DPAPI 解密失败」
- [ ] refresh token 已过期 → 刷新失败 → 报错「token 可能已失效」
- [ ] .env 未被 git 忽略 → 中止，不写入
- [ ] .env 写入后 mode 为 600
- [ ] 刷新成功后 auth-v2.dat 已写回（双向同步）

## 已知边界

- **macOS**：safeStorage 走 Keychain；首次弹窗用户必须点「允许」，否则 `security find-generic-password` 报错
- **Windows**：safeStorage 走 DPAPI→AES-256-GCM；AES key 绑定当前 Windows 用户，auth-v2.dat + Local State 不可跨机器/账户解密
- **Windows**：`encrypted_key` 需为 `DPAPI\0` 格式（App-Bound `APPB` 格式暂不支持）
- `forceRefresh` 会轮换 refresh token — 旧的 ory_rt_ 立即失效，新值必须备份到 QWEN_KEYS
- 如果 auth-v2.dat 被千问办公 App 重新登录覆盖，其中的 refresh token 也会变
- `writeEnvRefreshToken` 会清理多余空行（`replace(/\n{3,}/g, '\n\n')`）

## 与 serve 的协作

改造后的完整 token 生命周期：

```
capture-key（首次/诊断）
    │
    ▼ 验证 + 备份 QWEN_KEYS
    │
    ▼
  serve 启动
    │
    ├─ initTokenManager() → 启动 auth-v2.dat 文件监听
    │
    ├─ 请求到来 → getToken()
    │   ├─ 缓存有效（> 5min）→ 直接返回
    │   └─ 过期 → refresh → 写回 auth-v2.dat + .env
    │
    └─ 千问 App 刷新 auth-v2.dat → 文件监听自动拾取 → 更新缓存
```

**日常流程**：千问 App 后台运行 → `pnpm serve` → 自动续命喵～
