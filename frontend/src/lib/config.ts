/**
 * Where the API lives. Set VITE_API_URL at build time: an absolute URL
 * (https://api.example.com/api) or a same-origin path (/api) behind a reverse proxy.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '');

/** Absolute API base, resolving a same-origin path against the current page. */
export function absoluteApiUrl(): string {
  return new URL(API_URL, window.location.origin).toString().replace(/\/$/, '');
}

/** WebSocket endpoint for realtime events, derived from the API URL. */
export function websocketUrl(): string {
  return `${absoluteApiUrl().replace(/^http/, 'ws')}/ws`;
}
