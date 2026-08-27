import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { APP_CONFIG, loadConfiguration } from './configuration';

@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  providers: [{ provide: APP_CONFIG, useFactory: loadConfiguration }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
