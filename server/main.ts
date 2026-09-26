import { createApp } from './app.js';
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid port number');
const origins = process.env.ALLOWED_ORIGINS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const { app, close } = createApp({ allowedOrigins: origins });
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
if (existsSync(path.join(dist, 'index.html'))) {
  app.use(
    express.static(dist, {
      index: false,
      setHeaders(response, filePath) {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (filePath.includes(`${path.sep}assets${path.sep}`))
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get('/{*path}', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(dist, 'index.html'));
  });
}
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Telegram Chat API is listening on port ${port}`);
});

function shutdown() {
  close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
