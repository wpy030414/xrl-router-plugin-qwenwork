/**
 * scripts/probe-models.ts — 诊断：探测各挡位在新版协议下的服务端反应。
 *
 * 2026-09 上游更新（千问办公 App 1.2.5）：旧挡位全部下线（全 403），新目录见 GET /api/v2/model/list。
 * 本脚本以「明文 body + `x-model-key` 头」逐挡位发极小的流式请求，打印响应头与首个 chunk 的内层
 * 状态，用于快速判断挡位可用性与上游协议状态。
 *
 * 注意：新版官方客户端请求带 `&Encode=1`（body 由官方 WASM 生成流加密体），本脚本发明文 body 探测，
 * 因此不带 Encode=1——用于观察服务端对明文请求的处理（403 挡位未知 / 503 目录不可用）。
 * 完整新协议逆向记录见 docs/researches/qwenwork-1.2.5-update.md。
 *
 * 用法：pnpm tsx scripts/probe-models.ts [model1 model2 ...]（缺省探测新三挡 + 旧挡位对照）
 */

import { randomUUID } from 'node:crypto';
import { settings } from '../src/config';
import { getToken } from '../src/auth';
import { buildSignMaterial, buildAuthHeaders } from '../src/signer';

const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common';

/** 与 src/client.ts COSY_STATIC_HEADERS 保持一致（诊断脚本，复制一份避免改生产代码） */
const MACHINE_OS = `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}_${process.platform}`;
const COSY_STATIC_HEADERS: Record<string, string> = {
  'Cosy-Business-Product': 'qoder_work',
  'Cosy-Business-Type': 'agent',
  'Cosy-ClientType': '6',
  'Cosy-Data-Policy': 'disagree',
  'Cosy-MachineId': 'unknown',
  'Cosy-MachineToken': 'unknown',
  'Cosy-MachineType': '5',
  'Cosy-Scene': 'qwork',
  'Cosy-MachineOs': MACHINE_OS,
  'Cosy-Version': '1.1.59',
  'Login-Version': 'v2',
  'x-model-source': 'system',
};

const DEFAULT_CANDIDATES = [
  // 2026-09 新版挡位（GET /api/v2/model/list 返回）
  'flash',
  'pro',
  'qwen3.8-max-preview',
  // 旧挡位（应全部 403 —— 仅作对照）
  'qwork-advanced',
  'qwork-auto',
];

async function probe(model: string): Promise<void> {
  const token = await getToken();
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 8,
    request_id: randomUUID(),
    session_id: randomUUID(),
  });

  const material = buildSignMaterial(token);
  const url = `${settings.qwenBaseUrl}${INFER_PATH}${INFER_QUERY}`;
  const auth = buildAuthHeaders(material, { url, body });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...COSY_STATIC_HEADERS,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'authorization': auth.authorization,
        'cosy-key': auth.cosyKey,
        'cosy-date': String(auth.cosyDate),
        'cosy-user': auth.cosyUser,
        'x-model-key': model,
      },
      body,
      signal: abort.signal,
    });

    // 响应头里的模型线索（2026-09 后上游不再返回 x-model-name，保留仅作诊断）
    const h = (name: string) => res.headers.get(name) ?? '—';
    console.log(`\n=== ${model} ===`);
    console.log(`  status          : ${res.status}`);
    console.log(`  x-model-name    : ${h('x-model-name')}`);

    // 非 2xx：读一小段错误体
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`  error body      : ${text.slice(0, 300)}`);
      return;
    }

    // 流式：读外层 chunk，解析内层 statusCode / model 字段
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let chunks = 0;
    let innerModel = '';
    let sawContent = false;
    while (chunks < 12 && !sawContent) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        chunks++;
        try {
          const outer = JSON.parse(t.slice(5));
          const inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer;
          if (outer.statusCodeValue && outer.statusCodeValue !== 200) {
            console.log(`  inner status    : ${outer.statusCodeValue} ${outer.statusCode ?? ''}`);
            console.log(`  inner error     : ${JSON.stringify(inner).slice(0, 250)}`);
            return;
          }
          if (inner?.model) innerModel = inner.model;
          const delta = inner?.choices?.[0]?.delta;
          if (delta?.content || delta?.reasoning_content) sawContent = true;
          if (inner?.code || inner?.message) {
            console.log(`  inner msg       : ${JSON.stringify({ code: inner.code, message: inner.message }).slice(0, 250)}`);
            return;
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    }
    console.log(`  inner model     : ${innerModel || '（未出现）'}`);
    console.log(`  ${sawContent ? '✅ 挡位可用（已收到推理内容）' : '⚠️ 未收到推理内容（可能挡位无效或 agent 未产出）'}`);
  } catch (e: any) {
    console.log(`\n=== ${model} ===`);
    console.log(`  请求失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
    abort.abort(); // 主动断流，最小化消耗
  }
}

async function main() {
  const candidates = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CANDIDATES;
  console.log(`探测 ${candidates.length} 个挡位 → ${settings.qwenBaseUrl}`);
  for (const m of candidates) {
    await probe(m);
    await new Promise((r) => setTimeout(r, 500)); // 温和间隔
  }
  console.log('\n探测完成喵。');
}

main().catch((e) => {
  console.error('探测脚本失败:', e);
  process.exit(1);
});
