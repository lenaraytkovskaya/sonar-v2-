import { createServer } from 'node:http';

export function createMissingKeyServer() {
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/status') {
      response
        .writeHead(200)
        .end(JSON.stringify({ state: 'error', reason: 'bridge_key_missing' }));
      return;
    }
    response
      .writeHead(503)
      .end(JSON.stringify({ error: 'bridge_key_missing' }));
  });
}
