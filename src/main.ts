import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
  );

  app.enableCors({ origin: true, credentials: true });

  // The trading console. `dist/public` when built, `public/` when run from source.
  const publicDir = [join(__dirname, 'public'), join(process.cwd(), 'public')].find(existsSync);
  if (publicDir) {
    app.useStaticAssets({ root: publicDir, prefix: '/' });
  }
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  setupSwagger(app);

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = new Logger('Bootstrap');

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      logger.error(
        `Port ${config.port} is already in use. Set PORT to a free port, ` +
          `for example: PORT=3001 pnpm start:dev`,
      );
      await app.close();
      process.exit(1);
    }
    throw error;
  }

  logger.log(`API listening on http://localhost:${config.port}`);
  logger.log(`OpenAPI docs on http://localhost:${config.port}/docs`);
}

void bootstrap();
