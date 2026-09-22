/**
 * PluginClient — 连接 xrl-router 的 WebSocket 客户端（V24 契约）。
 *
 * 功能：
 * - 启动时连接 xrl-router 并注册为插件（不带 keys，V24 起 Router 不再管理密钥）
 * - 每 30s 发送心跳保持连接
 * - 断线自动重连（指数退避，最大间隔 60s）
 * - 容忍 Router 未就绪：WS 连接失败时退避重试
 */

import { WebSocket } from 'ws';
import { settings } from './config';
import { displayName as qwenDisplayName } from './qwenwork/client';

const PLUGIN_ID = 'plugin-qwenwork';
const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.connect();
  }

  /**
   * 连接 xrl-router
   */
  private connect(): void {
    const wsUrl = settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[PluginClient] Connected to xrl-router');
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('[PluginClient] Disconnected from xrl-router');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[PluginClient] WebSocket error:', error.message);
    });
  }

  /**
   * 发送注册消息（V24 契约：无 keys，kind=chat_completions，带 workdir）
   */
  private sendRegister(): void {
    const models = settings.availableModels.map(id => ({
      model_id: id,
      display_name: qwenDisplayName(id),
      tier: 'custom',
    }));

    const message = {
      type: 'register',
      plugin_id: PLUGIN_ID,
      provider: {
        kind: 'chat_completions',
        base_url: `http://localhost:${settings.port}`,
        api_path: '/v1/chat/completions',
      },
      models,
      workdir: process.cwd(),
    };

    this.send(message);
  }

  /**
   * 处理 xrl-router 返回的消息
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'error') {
        console.error(`[PluginClient] Router error: ${msg.reason}`);
      }
      // registered / reconnected / deleted 均无需额外动作
    } catch {
      // 无法解析的消息静默忽略
    }
  }

  /**
   * 发送消息
   */
  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 启动心跳（V24：不带 timestamp）
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 计划重连（指数退避，容忍 Router 未就绪）
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    console.log(`[PluginClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * 关闭客户端
   */
  public close(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
