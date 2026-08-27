import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Pre-IPO Trading Platform API')
    .setDescription(
      [
        'Trade tokenized shares of fictional pre-IPO companies against a stablecoin balance.',
        '',
        '**Money formatting** — prices, quantities and cash are returned as decimal *strings*',
        'to avoid IEEE-754 rounding on the client. Send them the same way.',
        '',
        '**Errors** — every failure returns',
        '`{ "error": { "code", "message", "details" }, "path", "timestamp" }`.',
        'Switch on `error.code`, never on the message.',
        '',
        '**Idempotency** — `POST /orders` requires an `Idempotency-Key` header. Replaying a key',
        'returns the original response instead of placing a second order.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addTag('Auth', 'Registration and token issuance')
    .addTag('Market Data', 'Assets, live prices and price history')
    .addTag('Calculator', 'Side-effect-free order sizing')
    .addTag('Orders', 'Order placement, cancellation and executions')
    .addTag('Portfolio', 'Holdings, cost basis, P&L and point-in-time reconstruction')
    .addTag('Admin', 'Market halt and resume controls')
    .addTag('System', 'Health checks')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    customSiteTitle: 'Pre-IPO Trading Platform API',
  });
}
