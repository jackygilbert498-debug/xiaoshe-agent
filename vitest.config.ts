import { defineConfig } from 'vitest/config'

// runtime/ 携带两个可独立开发的上游工程。XS 门禁只验证本 Bundle；
// DSH 和旧小蛇由各自的锁定依赖与测试命令独立验收。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Profile integration files build and pack the same workspace artifacts.
    // Running test files in parallel can make one verifier observe another
    // verifier's transient build output, so the handoff gate is intentionally
    // deterministic at file level. Package-local suites remain parallel.
    fileParallelism: false,
  },
})
