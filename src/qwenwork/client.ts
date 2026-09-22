/**
 * qwenwork/client.ts — qwenwork 通道转发：OpenAI Chat Completions → gateway.qwenwork.cn。
 *
 * 对每个请求：
 *  1. 取 OAuth token（自动刷新）
 *  2. encryptUserInfo → cosy-key / info（每请求新 16B AES key）
 *  3. generateAuthToken → authorization（md5 绑定 body/path/时间戳，天然防重放）
 *  4. body 明文透传（去 Encode=1；必需 request_id/session_id 自动补）
 *  5. 流式/非流式透传
 */

import { randomUUID } from 'node:crypto';
import { settings } from '../config';
import { getToken, refreshDeviceToken } from './auth';
import { buildSignMaterial, buildAuthHeaders } from './signer';

/**
 * qwenwork 应用层模型 → 展示名（注册时给 xrl-router 展示用）。
 *
 * 逆向发现（v1.2.0 asar）：
 * - 客户端通过 Qoder CLI SDK `getAvailableModels()` 从服务端动态拉取模型列表（120s 缓存）
 * - 客户端只发 `x-model-key` header，**服务端做负载均衡和轮换**
 * - 默认模型 = `qwork-advanced`（constants$3.D）
 * - 模型列表通过 `resolveLegacyStandardModelKey()` 解析别名：
 *   "qwork-auto" / "auto" / "flash" → 映射到实际模型 key
 */
const DISPLAY_NAMES: Record<string, string> = {
  'qwork-advanced': 'glm-5.2',
  'qwork-auto': 'qwen3.7-plus',
  'qwork-lite': 'deepseek-v4-flash',
  'qmodel_latest': 'qwen3.8-max',
};

/** 模型别名 → 标准 key（逆向自 resolveLegacyStandardModelKey） */
const MODEL_ALIASES: Record<string, string> = {
  'auto': 'qwork-auto',
  'flash': 'qwork-lite',
  'advanced': 'qwork-advanced',
  'glm': 'qwork-advanced',
  'qwen': 'qwork-auto',
  'deepseek': 'qwork-lite',
};

/** 解析模型 key（支持别名 + 展示名反查） */
export function resolveModelKey(input: string): string {
  // 直接命中
  if (DISPLAY_NAMES[input] || input.startsWith('qwork-') || input.startsWith('qmodel')) return input;
  // 别名
  if (MODEL_ALIASES[input]) return MODEL_ALIASES[input];
  // 展示名反查
  for (const [key, display] of Object.entries(DISPLAY_NAMES)) {
    if (display === input) return key;
  }
  return input; // 原样透传，让服务端决定
}

/** 获取所有可用模型（含别名），给 /v1/models 用 */
export function getAvailableModelList(): Array<{ id: string; name: string; aliases: string[] }> {
  return Object.entries(DISPLAY_NAMES).map(([id, name]) => {
    const aliases = Object.entries(MODEL_ALIASES)
      .filter(([, v]) => v === id)
      .map(([k]) => k);
    return { id, name, aliases };
  });
}

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] || modelId;
}

/** 从 Authorization 头取出 refresh token（xrl-router 密钥池 QWEN_KEYS 的透传） */
function extractRefreshToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const t = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  return t.startsWith('ory_rt_') ? t : null;
}

/** 从 OAuth access token（JWT）payload 解出 uid（deviceToken/refresh 响应无 user 字段） */
function extractUidFromToken(token: string): string {
  try {
    const part = token.split('.')[1] || '';
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json.sub || json.uid || json.user_id || '';
  } catch { return ''; }
}

const COSY_STATIC_HEADERS: Record<string, string> = {
  'Cosy-Business-Product': 'qoder_work',
  'Cosy-Business-Type': 'agent',
  'Cosy-ClientType': '6',
  'Cosy-Data-Policy': 'disagree',
  'Cosy-MachineId': 'unknown',
  'Cosy-MachineToken': 'unknown',
  'Cosy-MachineType': '5',
  'Cosy-Scene': 'qwork',
  'Cosy-MachineOs': 'aarch64_darwin',
  'Cosy-Version': '1.0.47',
  'Login-Version': 'v2',
  'x-model-source': 'system',
};

const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common';

/**
 * 转发 OpenAI Chat Completions 请求到 qwenwork 推理网关。
 *
 * token 策略（方案 A）：
 * - 使用 getToken() 缓存管理（5min 缓冲，过期才刷新）
 * - 不再每请求都 refresh（避免轮换互踩导致 refresh token 失效）
 * - auth-v2.dat 文件监听自动拾取千问 App 的刷新
 * - Authorization header 透传的 refresh token 仅作灾备源
 */
export async function forwardChatCompletions(
  body: any,
  res: any,
  authHeader?: string,
): Promise<void> {
  // 解析模型别名（如 "auto" → "qwork-auto", "glm" → "qwork-advanced"）
  const rawModel = body.model || 'qwork-advanced';
  const model = resolveModelKey(rawModel);
  const isStream = body.stream === true;

  // 客户端断开时取消上游请求，避免无谓消耗 + 写已关闭的 res
  // 注意：Node.js 24 下 req.on('close') 在请求体消费完就触发（不等连接关闭）
  // 所以必须监听 res.on('close')（连接真正关闭时才触发）
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.on('close', onClientClose);

  // token 来源：优先用 getToken() 缓存管理（按需刷新 + 文件监听自动拾取）
  let token;
  try {
    token = await getToken();
  } catch (_e: any) {
    // 缓存全失效 → 灾备：尝试 xrl-router 透传的 refresh token
    const rt = extractRefreshToken(authHeader);
    if (rt) {
      try {
        token = await refreshDeviceToken(rt);
        token.user = { uid: extractUidFromToken(token.token) };
        console.log('[qwenwork] 用密钥池 refresh token 灾备成功');
      } catch (e2: any) {
        res.status(401).json({ error: { message: `所有 token 源均失效: ${e2.message}` } });
        return;
      }
    } else {
      res.status(401).json({ error: { message: '无可用 token 源（请确保千问办公 App 已登录）' } });
      return;
    }
  }
  // 确保有 uid（从 JWT 解出）
  if (!token.user?.uid) {
    token.user = { ...token.user, uid: extractUidFromToken(token.token) };
  }

  // body：明文透传 + 补 request_id/session_id
  const forwardBody: any = {
    ...body,
    model,
    request_id: body.request_id || randomUUID(),
    session_id: body.session_id || randomUUID(),
  };

  // 去掉可能带入的 Encode=1 相关字段（qwenwork 网关明文即可）
  delete forwardBody.encode;
  delete forwardBody.extra_body;

  const bodyStr = JSON.stringify(forwardBody);
  const material = buildSignMaterial(token);
  const url = `${settings.qwenBaseUrl}${INFER_PATH}${INFER_QUERY}`;
  const auth = buildAuthHeaders(material, { url, body: bodyStr });

  const headers: Record<string, string> = {
    ...COSY_STATIC_HEADERS,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': auth.authorization,
    'Cosy-Key': auth.cosyKey,
    'Cosy-Date': auth.cosyDate,
    'Cosy-User': auth.cosyUser,
    'x-model-key': model,
  };

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      if (!res.headersSent) {
        res.status(upstream.status).type('application/json')
          .send(text || JSON.stringify({ error: { message: `qwenwork upstream ${upstream.status}` } }));
      }
      return;
    }

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sentDone = false;

    const emitChunk = (inner: string): void => {
      // 去重：上游本身会发 [DONE]（chunk 数最后一行 data:{}），我们自己只发一次
      if (inner === '{}' || /\[DONE\]/.test(inner)) return;
      res.write(`data: ${inner}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    };

    // tool_calls 分片标准化（适配 xrl-router 的转换逻辑）：
    // xrl-router 把「该 index 的首个 chunk」解析进 content_block_start 的 input（其余分片发 input_json_delta）。
    // 因此：首 chunk 必须发空 arguments（避免 "{" 被消耗），所有 arguments 片段（含首 chunk 的）原样发出，
    // 保证 partial_json 序列以 "{" 开头、拼接后是完整 JSON。
    const seenToolCallIndex = new Set<number>();

    const flushLine = (line: string): void => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      try {
        const outer = JSON.parse(t.slice(5));
        // body 字段可能是 SSE 格式（"data: {...}"）或裸 JSON，统一剥层
        let inner = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? {});
        const innerTrim = inner.trim();
        if (innerTrim.startsWith('data:')) {
          inner = innerTrim.slice(5).trim();
          if (inner === '[DONE]' || inner === '{}') return;
        }
        const raw = JSON.parse(inner);
        const choice = raw.choices?.[0];
        const delta = choice?.delta;

        if (delta?.tool_calls) {
          const out: any[] = [];
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!seenToolCallIndex.has(i)) {
              seenToolCallIndex.add(i);
              // 首 chunk：只带 id/type/name，arguments 置空（触发 content_block_start）
              out.push({
                id: tc.id || '',
                type: tc.type || 'function',
                index: i,
                function: { name: tc.function?.name || '', arguments: '' },
              });
            }
            // arguments 片段原样发出（含首 chunk 的 "{"），作为 input_json_delta 续片
            if (tc.function?.arguments) {
              out.push({ index: i, function: { arguments: tc.function.arguments } });
            }
          }
          emitChunk(JSON.stringify({ ...raw, choices: [{ ...choice, delta: { tool_calls: out } }] }));
        } else {
          emitChunk(inner);
        }
      } catch { /* 忽略无法解析的行 */ }
    };

    // —— 非流式：聚合所有 chunk 为完整 OpenAI JSON ——
    if (!isStream) {
      const parts: any[] = [];
      const usage: any = {};
      let innerId = '';
      let finishReason = 'stop';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const t = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (t.startsWith('data:')) {
              const payload = t.slice(5);
              if (payload === '[DONE]' || payload === '{}') continue;
              try {
                const outer = JSON.parse(payload);
                // body 字段可能是 SSE 格式（"data: {...}"）或裸 JSON，统一剥层
                let bodyStr = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? {});
                const bodyTrim = bodyStr.trim();
                if (bodyTrim.startsWith('data:')) {
                  bodyStr = bodyTrim.slice(5).trim();
                  if (bodyStr === '[DONE]' || bodyStr === '{}') continue;
                }
                const inner = JSON.parse(bodyStr);
                if (inner.id) innerId = inner.id;
                if (inner.choices?.[0]) {
                  const choice = inner.choices[0];
                  if (choice.delta) parts.push(choice.delta);
                  if (choice.finish_reason) finishReason = choice.finish_reason;
                }
                if (inner.usage) Object.assign(usage, inner.usage);
              } catch { /* 跳过无法解析的行 */ }
            }
          }
        }
        // 合并 delta：content/reasoning_content 拼接，tool_calls 按 index 合并
        const content = parts.map(d => d.content).filter(Boolean).join('');
        const reasoning = parts.map(d => d.reasoning_content).filter(Boolean).join('');

        // tool_calls：按 index 分组，拼接 arguments，保留首个 chunk 的 id/name/type
        const toolCallMap = new Map<number, any>();
        for (const d of parts) {
          if (!d.tool_calls) continue;
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCallMap.has(i)) {
              toolCallMap.set(i, {
                id: tc.id || '',
                type: tc.type || 'function',
                index: i,
                function: { name: tc.function?.name || '', arguments: '' },
              });
            }
            const merged = toolCallMap.get(i);
            if (tc.id) merged.id = tc.id;
            if (tc.type) merged.type = tc.type;
            if (tc.function?.name) merged.function.name = tc.function.name;
            if (tc.function?.arguments) merged.function.arguments += tc.function.arguments;
          }
        }

        const msg: any = { role: 'assistant' };
        if (content) msg.content = content;
        if (reasoning) msg.reasoning_content = reasoning;
        if (toolCallMap.size > 0) {
          msg.tool_calls = [...toolCallMap.values()].sort((a, b) => a.index - b.index);
        }

        if (!res.headersSent) {
          res.json({
            id: innerId || `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, message: msg, finish_reason: finishReason }],
            usage: Object.keys(usage).length ? usage : undefined,
          });
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        console.error('[qwenwork] 非流式聚合失败:', e.message);
        if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${e.message}` } });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // —— 流式：解包透传 ——
    // qwenwork 响应是外层 SSE：data:{"headers":{...},"body":"<内层OpenAI chunk JSON>","statusCodeValue":200}
    // 解包成标准 OpenAI SSE 透传
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          flushLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
      if (buf.trim()) flushLine(buf);
      if (!sentDone && !res.writableEnded) { res.write('data: [DONE]\n\n'); sentDone = true; }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error('[qwenwork] 流读取失败:', e.message);
    } finally {
      if (!res.writableEnded) res.end();
    }
  } catch (error: any) {
    // 客户端主动断开 → 正常终止
    if (error.name === 'AbortError') {
      if (!res.writableEnded) res.end();
      return;
    }
    // 已发过头 → 只能静默结束
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(502).json({ error: { message: `Upstream error: ${error.message}` } });
  } finally {
    res.removeListener('close', onClientClose);
  }
}
