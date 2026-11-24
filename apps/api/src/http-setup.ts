// The HTTP settings, shared by the server and the tests so the tests run what production runs.
import type { NestExpressApplication } from '@nestjs/platform-express';

export function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix('api');
  // Behind Caddy (section 12) the client's address is the last one not on a private network;
  // an address the client adds in front is ignored (the per-computer login limit, section 11).
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
}
