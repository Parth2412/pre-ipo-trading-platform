import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/swagger';

loadEnv({ quiet: true });

/**
 * Emits `docs/openapi.json` from the live decorator metadata.
 *
 * Generated rather than hand-written so the specification cannot drift from the
 * controllers: if a route or DTO changes, re-running this is the whole update.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();

  const document = buildOpenApiDocument(app);
  const target = join(process.cwd(), 'docs', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

  const routes = Object.values(document.paths).reduce(
    (total, path) => total + Object.keys(path as object).length,
    0,
  );
  console.log(
    `[openapi] wrote ${target} — ${Object.keys(document.paths).length} paths, ${routes} operations`,
  );

  await app.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('[openapi] failed:', error);
  process.exit(1);
});
