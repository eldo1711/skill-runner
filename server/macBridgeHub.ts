import { WebSocket } from 'ws';

interface PendingRpc {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  payload: string;
}

class MacBridgeHub {
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRpc>();
  private onTabsPushCallback: ((tabs: any[]) => void) | null = null;
  private onConnectionChangeCallback: ((connected: boolean) => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public registerClient(ws: WebSocket) {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      try {
        this.client.send(JSON.stringify({ type: 'superseded' }));
        this.client.close(4001, 'Superseded by a newer Mac Bridge connection');
      } catch {
        // Ignore
      }
    }
    this.client = ws;
    if (this.onConnectionChangeCallback) {
      this.onConnectionChangeCallback(true);
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        try {
          this.client.ping();
          this.client.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore
        }
      }
    }, 20000);

    // Re-dispatch any in-flight RPCs if the bridge reconnected mid-operation
    for (const [, entry] of this.pending.entries()) {
      try {
        ws.send(entry.payload);
      } catch {
        // Ignore
      }
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }
        if (msg.type === 'rpc_response' && msg.id) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error));
            } else {
              entry.resolve(msg.result);
            }
          }
        } else if (msg.type === 'tabs_push' && Array.isArray(msg.tabs)) {
          if (this.onTabsPushCallback) {
            this.onTabsPushCallback(msg.tabs);
          }
        }
      } catch {
        // Ignore malformed frame
      }
    });

    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.onConnectionChangeCallback) {
          this.onConnectionChangeCallback(false);
        }
      }
    });
  }

  public onTabsPush(cb: (tabs: any[]) => void) {
    this.onTabsPushCallback = cb;
  }

  public onConnectionChange(cb: (connected: boolean) => void) {
    this.onConnectionChangeCallback = cb;
  }

  public isConnected(): boolean {
    return Boolean(this.client && this.client.readyState === WebSocket.OPEN);
  }

  public shutdownClient(): boolean {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.client.send(JSON.stringify({ type: 'shutdown' }));
      this.client.close();
      this.client = null;
      if (this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(false);
      }
      return true;
    } catch {
      return false;
    }
  }

  public async invoke<T = any>(
    method: string,
    params: Record<string, any> = {},
    timeoutMs = 25000
  ): Promise<T> {
    // Wait up to 12 seconds if the Mac Bridge is in the middle of a 3s auto-reconnect
    if (!this.isConnected()) {
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (this.isConnected()) break;
      }
    }
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('Mac Chrome Bridge is not connected.');
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ type: 'rpc_request', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Mac Bridge RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, payload });
      this.client!.send(payload);
    });
  }
}

export const macBridgeHub = new MacBridgeHub();
