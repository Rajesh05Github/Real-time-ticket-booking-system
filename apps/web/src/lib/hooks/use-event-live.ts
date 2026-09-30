'use client';

import { useEffect, useRef } from 'react';

import { wsUrl } from '../api/config';

import type { SeatStatus } from '../api/types';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/** Every message the `/events/:eventId/live` socket can deliver. The
 * server shares one Pub/Sub channel per event between presence and seat
 * updates (apps/worker's live-seat consumer), distinguished by `type`. */
export type EventLiveMessage =
  | { type: 'viewerCount'; count: number }
  | { type: 'seatStatus'; seats: { id: string; status: SeatStatus }[] }
  | { type: 'disconnected' };

type Listener = (message: EventLiveMessage) => void;

interface SharedConnection {
  listeners: Set<Listener>;
  socket?: WebSocket;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  attempt: number;
  closed: boolean;
}

/**
 * ONE WebSocket per event per tab, shared by every component that
 * subscribes (the viewer badge and the seat map both live on the event
 * page). Two sockets would count this tab as two viewers in the server's
 * presence set and double the connection load for no benefit.
 * Ref-counted: the socket opens with the first subscriber and closes with
 * the last. Reconnects with exponential backoff since a page can sit open
 * for a long time.
 */
const connections = new Map<string, SharedConnection>();

function broadcast(connection: SharedConnection, message: EventLiveMessage): void {
  for (const listener of connection.listeners) listener(message);
}

function connect(eventId: string, connection: SharedConnection): void {
  const socket = new WebSocket(wsUrl(`/events/${eventId}/live`));
  connection.socket = socket;

  socket.onopen = () => {
    connection.attempt = 0;
  };

  socket.onmessage = (event: MessageEvent<string>) => {
    try {
      broadcast(connection, JSON.parse(event.data) as EventLiveMessage);
    } catch {
      // Malformed frame -- ignore.
    }
  };

  socket.onclose = () => {
    broadcast(connection, { type: 'disconnected' });
    if (connection.closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** connection.attempt, RECONNECT_MAX_MS);
    connection.attempt += 1;
    connection.reconnectTimer = setTimeout(() => connect(eventId, connection), delay);
  };

  socket.onerror = () => {
    socket.close();
  };
}

function subscribe(eventId: string, listener: Listener): () => void {
  let connection = connections.get(eventId);
  if (!connection) {
    connection = { listeners: new Set(), attempt: 0, closed: false };
    connections.set(eventId, connection);
    connect(eventId, connection);
  }
  connection.listeners.add(listener);

  const current = connection;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.closed = true;
      clearTimeout(current.reconnectTimer);
      current.socket?.close();
      connections.delete(eventId);
    }
  };
}

/** Subscribes `onMessage` to this event's live channel for the lifetime
 * of the calling component. The latest callback is always used, so
 * callers don't need to memoize it. */
export function useEventLive(eventId: string, onMessage: Listener): void {
  const handlerRef = useRef(onMessage);

  useEffect(() => {
    handlerRef.current = onMessage;
  });

  useEffect(() => subscribe(eventId, (message) => handlerRef.current(message)), [eventId]);
}
