import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unit:unit@127.0.0.1:5432/gateway_test',
      APPROVAL_HMAC_SECRET: process.env.APPROVAL_HMAC_SECRET || 'unit-only-secret-with-at-least-32-characters',
      APPROVAL_KEY_ID: process.env.APPROVAL_KEY_ID || 'unit',
      CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3000',
      API_KEY_AGENT: process.env.API_KEY_AGENT || 'unit-agent',
      API_KEY_ADAPTER_GOAT: process.env.API_KEY_ADAPTER_GOAT || 'unit-goat',
      API_KEY_ADAPTER_QATOM: process.env.API_KEY_ADAPTER_QATOM || 'unit-qatom',
      API_KEY_DASHBOARD: process.env.API_KEY_DASHBOARD || 'unit-dashboard',
      API_KEY_ADMIN: process.env.API_KEY_ADMIN || 'unit-admin',
      API_KEY_AGENT_OWNER_ID: 'owner_alice',
      API_KEY_ADAPTER_GOAT_OWNER_ID: 'owner_alice',
      API_KEY_ADAPTER_QATOM_OWNER_ID: 'owner_alice',
      API_KEY_DASHBOARD_OWNER_ID: 'owner_alice',
      API_KEY_ADMIN_OWNER_ID: 'owner_alice',
      TEST_SUITE: process.env.TEST_SUITE || 'unit',
    },
    include: process.env.TEST_SUITE === 'integration'
      ? ['test/**/*.integration.test.ts', 'test/{audit,consume,db,e2e,executions,intents,verify}.test.ts']
      : ['test/**/*.test.ts'],
    exclude: process.env.TEST_SUITE === 'integration' ? [] : ['test/**/*.integration.test.ts', 'test/{audit,consume,db,e2e,executions,intents,verify}.test.ts'],
    testTimeout: 10000,
    fileParallelism: false,
  },
});
