import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { RegistryPypiController } from './registry-pypi/registry-pypi.controller';

/** PyPI 进程：只承载 /pypi/* 协议入口（simple 索引、下载与 twine 上传） */
@Module({
  imports: [CoreModule],
  controllers: [RegistryPypiController],
})
export class PypiModule {}
