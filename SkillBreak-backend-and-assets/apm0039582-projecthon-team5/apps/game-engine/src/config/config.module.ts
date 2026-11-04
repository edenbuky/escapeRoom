import { Global, Module } from '@nestjs/common';
import { ENGINE_CONFIG, loadEngineConfig } from './config';

@Global()
@Module({
  providers: [{ provide: ENGINE_CONFIG, useFactory: loadEngineConfig }],
  exports: [ENGINE_CONFIG],
})
export class ConfigModule {}
