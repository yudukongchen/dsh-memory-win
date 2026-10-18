// Regression seam: real installed Cordis lifecycle + real HTTP request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hostCordis } from './host-cordis.mjs';
import * as memory from '../index.js';

const runtime = await hostCordis();
if (!runtime) { console.log('SKIP: installed DSH not found; set DSH_APP_ASAR'); process.exit(0); }
const { Context } = runtime;
const ctx = new Context();
const routes = new Map();
const webServer = { register(route) {
  routes.set(route.path, route);
  return () => routes.delete(route.path);
} };
const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (route) void route.handler(req, res);
  else { res.writeHead(404); res.end(); }
});
try {
  await ctx.plugin(c => {
    c.provide('systemPrompt', { section() { return () => {}; } });
    c.provide('tools', { register() { return () => {}; }, guard() { return () => {}; } });
  });
  const plugin = ctx.plugin(memory, { cleanupEnabled: false });
  try { await plugin; } catch (error) { console.log(`Plugin startup failed: ${error.message}`); }
  // The browserless host remains functional without webServer.
  assert.equal(routes.size, 0);
  const provider = ctx.plugin(c => c.provide('webServer', webServer));
  await provider;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-memory-win/layers`, {
    headers: { 'x-dsh-memory-win': '1' },
  });
  console.log(`Late webServer: GET /api/dsh-memory-win/layers -> HTTP ${response.status}`);
  const status = response.status;
  await response.body.cancel();
  assert.equal(status, 200, 'Memory View must mount when webServer becomes ready after the plugin');
  await provider.dispose();
  assert.equal(routes.size, 0, 'service removal must dispose both routes');
  await ctx.plugin(c => c.provide('webServer', webServer));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(routes.size, 2, 'service reappearance must remount exactly two routes');
  await plugin.dispose();
  assert.equal(routes.size, 0, 'plugin disposal must remove routes');
  console.log('PASS: late service, service removal/reappearance, plugin disposal');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await ctx.fiber.dispose();
}
