import { Module, type Type } from '@nestjs/common';
import type { ProcessRole } from './config/config';
import { ConsoleModule } from './console.module';
import { NpmModule } from './npm.module';
import { PypiModule } from './pypi.module';

/**
 * 单进程形态（PROCESS_ROLE=all）：三个角色模块挂在一起，行为与拆分前完全一致。
 * e2e 与现有部署脚本都走这个入口，拆分能力通过 resolveAppModule 按角色选择。
 */
@Module({
  imports: [ConsoleModule, NpmModule, PypiModule],
})
export class AppModule {}

/** 按进程角色返回根模块：main.ts 与测试工厂共用，避免两处各自维护映射 */
export function resolveAppModule(role: ProcessRole): Type<unknown> {
  switch (role) {
    case 'console':
      return ConsoleModule;
    case 'npm':
      return NpmModule;
    case 'pypi':
      return PypiModule;
    default:
      return AppModule;
  }
}
