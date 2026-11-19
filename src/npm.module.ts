import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { RegistryNpmController } from './registry-npm/registry-npm.controller';

/** npm registry 进程：只承载 /npm/* 协议入口，客户端直连本进程端口 */
@Module({
  imports: [CoreModule],
  controllers: [RegistryNpmController],
})
export class NpmModule {}
