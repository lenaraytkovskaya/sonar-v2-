import { afterEach, expect, it } from 'vitest';
import { createMissingKeyServer } from './missing-key.js';

const servers: ReturnType<typeof createMissingKeyServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

it('reports a missing key through status without starting desktop processes', async () => {
  const server = createMissingKeyServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('server_not_listening');

  const response = await fetch(`http://127.0.0.1:${address.port}/status`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    state: 'error',
    reason: 'bridge_key_missing',
  });
});
