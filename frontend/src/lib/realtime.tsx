import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { getAccessToken, type Realm } from '../api/client';
import { websocketUrl } from './config';

export interface RealtimeEvent {
  type: string;
  data: Record<string, unknown>;
}

type Listener = (event: RealtimeEvent) => void;

const PING_INTERVAL_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One authenticated WebSocket per signed-in realm. Reconnects with backoff, re-authenticating
 * with a fresh access token each time (the server closes the socket when a token expires).
 */
class RealtimeConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private backoff = 1_000;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;
  private stopped = false;

  constructor(private readonly realm: Realm) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async connect(): Promise<void> {
    const token = await getAccessToken(this.realm);
    if (this.stopped || !token) return;
    const socket = new WebSocket(websocketUrl());
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as RealtimeEvent;
      if (event.type === 'ready') {
        this.backoff = 1_000;
        this.pingTimer = window.setInterval(
          () => socket.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'),
          PING_INTERVAL_MS,
        );
        return;
      }
      if (event.type === 'pong') return;
      this.listeners.forEach((listener) => listener(event));
    };
    socket.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.stopped || this.socket !== socket) return;
      this.retryTimer = window.setTimeout(() => void this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }
}

const RealtimeContext = createContext<RealtimeConnection | null>(null);

/** Opens the realtime connection for a signed-in realm while mounted. */
export function RealtimeProvider({ realm, children }: { realm: Realm; children: ReactNode }) {
  const connection = useRef<RealtimeConnection | null>(null);
  connection.current ??= new RealtimeConnection(realm);

  useEffect(() => {
    const current = connection.current!;
    current.start();
    return () => current.stop();
  }, []);

  return <RealtimeContext.Provider value={connection.current}>{children}</RealtimeContext.Provider>;
}

/** Run `handler` for realtime events whose type matches (a string, a prefix ending in '*', or a list). */
export function useRealtimeEvent(types: string | string[], handler: (event: RealtimeEvent) => void): void {
  const connection = useContext(RealtimeContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = Array.isArray(types) ? types.join('|') : types;

  useEffect(() => {
    if (!connection) return;
    const patterns = key.split('|');
    const matches = (type: string) =>
      patterns.some((p) => (p.endsWith('*') ? type.startsWith(p.slice(0, -1)) : p === type));
    return connection.subscribe((event) => {
      if (matches(event.type)) handlerRef.current(event);
    });
  }, [connection, key]);
}
