/**
 * jest 在 test 目录下运行两类用例，环境变量由 setup-env 注入 .env.test：
 * - *.e2e-spec.ts：端到端用例（起完整 Nest 应用）
 * - *.spec.ts（unit/ 目录）：纯逻辑单元用例（不起应用，毫秒级）
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.(e2e-)?spec\\.ts$',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
