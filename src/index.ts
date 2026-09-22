/**
 * qwenwork 插件入口（V24 契约）：
 *   Hono 网关 + WebSocket 插件注册（connect ws://127.0.0.1:19068/ws/plugin）。
 *
 * 职责：
 * - HTTP 网关：OpenAI Chat Completions 兼容（POST /v1/chat/completions）
 * - WS 插件：注册 / 心跳 / 重连（V24 契约：无 keys）
 * - 幂等：若已有实例在监听（端口占用），干净退出
 * - 容忍 Router 未就绪：WS 连接失败时退避重试
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { spawn } from 'child_process';
import { settings } from './config';
import { PluginClient } from './pluginClient';
import { forwardChatCompletions } from './qwenwork/client';
import { initTokenManager } from './qwenwork/auth';

const PLUGIN_ID = 'plugin-qwenwork';

const app = new Hono();

// 中间件
app.use('*', cors());

// ============================================================================
// 路由
// ============================================================================

// 根路径（健康探针）
app.get('/', (c) => {
  return c.json({
    version: '0.2.0',
    service: PLUGIN_ID,
    status: 'running',
    mode: 'plugin',
    backend: 'qwenwork',
    endpoints: { chat: '/v1/chat/completions', health: '/health' },
  });
});

// 健康检查
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    backend: 'qwenwork',
    plugin_mode: true,
    base_url: settings.qwenBaseUrl,
  });
});

// OpenAI Chat Completions → qwenwork 转发
app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json();
  const authHeader = c.req.header('authorization');

  // Hono 的 res 不直接暴露 Node.js ServerResponse，需要用 stream 方式处理 SSE
  // 使用 c.body() 配合 ReadableStream 或直接用 c.res
  return new Promise<Response>((resolve) => {
    // 构造一个仿 Response 写入器，桥接 Hono 和 qwenwork/client 的 res.write/res.end 模式
    const chunks: (string | Buffer)[] = [];
    let statusCode = 200;
    const headers = new Map<string, string>();
    let headersSent = false;
    let ended = false;

    const mockRes: any = {
      writableEnded: false,
      headersSent: false,
      socket: null,
      on(event: string, _cb: () => void) {
        // Hono 场景下 close 事件由 AbortController 处理
        if (event === 'close') {
          // 暂存，后续由 abort 触发
        }
      },
      removeListener(_event: string, _cb: () => void) {},
      status(code: number) {
        statusCode = code;
        return mockRes;
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      type(contentType: string) {
        headers.set('content-type', contentType);
        return mockRes;
      },
      json(data: any) {
        if (ended) return;
        headers.set('content-type', 'application/json');
        const body = JSON.stringify(data);
        headersSent = true;
        mockRes.headersSent = true;
        ended = true;
        mockRes.writableEnded = true;
        resolve(new Response(body, {
          status: statusCode,
          headers: Object.fromEntries(headers),
        }));
      },
      send(data: string) {
        if (ended) return;
        headersSent = true;
        mockRes.headersSent = true;
        ended = true;
        mockRes.writableEnded = true;
        resolve(new Response(data, {
          status: statusCode,
          headers: Object.fromEntries(headers),
        }));
      },
      write(chunk: string | Buffer) {
        if (ended) return;
        chunks.push(chunk);
      },
      end() {
        if (ended) return;
        headersSent = true;
        mockRes.headersSent = true;
        ended = true;
        mockRes.writableEnded = true;
        const bodyStr = chunks.join('');
        resolve(new Response(bodyStr, {
          status: statusCode,
          headers: Object.fromEntries(headers),
        }));
      },
      flush() {
        // no-op for Hono (no Express compression middleware)
      },
    };

    forwardChatCompletions(body, mockRes, authHeader);
  });
});

// ============================================================================
// 端口释放
// ============================================================================

/**
 * 检测并释放指定端口（跨平台支持）
 * 排除自身 PID（process.pid）：端口被本进程占用时（如热重启/重复启动），不自杀喵～
 */
async function killPortProcess(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  const selfPid = String(process.pid);
  return new Promise((resolve) => {
    if (isWindows) {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (data) => { output += data.toString(); });
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== selfPid && !pids.includes(pid)) pids.push(pid);
          }
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('close', () => resolve());
      });
    } else {
      const lsof = spawn('lsof', ['-ti', `:${port}`]);
      let pids = '';
      lsof.stdout.on('data', (data) => { pids += data.toString(); });
      lsof.stderr.on('data', () => {});
      lsof.on('close', (code) => {
        if (code === 0 && pids.trim()) {
          const pidList = pids.trim().split('\n').filter((p) => p.trim() && p.trim() !== selfPid);
          if (pidList.length === 0) return resolve();
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
    }
  });
}

// ============================================================================
// 启动
// ============================================================================

async function startServer() {
  const port = settings.port;

  // 启动 token 管理器（auth-v2.dat 文件监听 + 自动拾取）
  initTokenManager();

  await killPortProcess(port);

  serve({
    fetch: app.fetch,
    port,
    hostname: '0.0.0.0',
  }, (info) => {
    console.log(`[qwenwork] listening on http://localhost:${info.port} (pid ${process.pid})`);

    // 启动 PluginClient（自动连接 xrl-router 并注册）
    const pluginClient = new PluginClient();

    // 优雅退出
    process.on('SIGTERM', () => {
      pluginClient.close();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      pluginClient.close();
      process.exit(0);
    });
  });
}

startServer();

export default app;
