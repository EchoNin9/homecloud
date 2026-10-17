import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { mockApiPlugin } from './mock/mockApi';

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'mock' ? [mockApiPlugin()] : [])],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
