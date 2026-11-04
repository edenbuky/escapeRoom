import { defineConfig, mergeConfig } from 'vite';
import sharedConfig from '../../../vite.config';

export default mergeConfig(sharedConfig, defineConfig({
  server: {
    proxy: {
      '^/api/team5/sessions/[^/]+/stream': {
        target: 'http://127.0.0.1:3001', changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/team5/, ''), timeout: 0, proxyTimeout: 0,
      },
      '/api/team5': {
        target: 'http://127.0.0.1:3000', changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/team5/, '') || '/health',
      },
    },
  },
}));