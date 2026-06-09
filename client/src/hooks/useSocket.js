import { useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

let _socket = null;

function getSocket() {
  if (!_socket) {
    _socket = io({ autoConnect: false });
  }
  return _socket;
}

export function useSocket(handlers) {
  const socket = getSocket();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const events = Object.keys(handlersRef.current);
    const wrapped = {};
    for (const ev of events) {
      wrapped[ev] = (...args) => handlersRef.current[ev]?.(...args);
      socket.on(ev, wrapped[ev]);
    }
    if (!socket.connected) socket.connect();
    return () => {
      for (const ev of events) socket.off(ev, wrapped[ev]);
    };
  }, []);

  const emit = useCallback((ev, data) => {
    getSocket().emit(ev, data);
  }, []);

  return { emit, socket };
}
