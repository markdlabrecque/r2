import type { Server, Socket } from 'node:net';

/** Register before listen(), so even TCP peers that never complete TLS are owned. */
export function createServerCleanup(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // Test teardown is not a graceful drain. Browsers can leave speculative
      // connections without an HTTP request, which server.close() waits for.
      for (const socket of sockets) socket.destroy();
    });
  };
}
