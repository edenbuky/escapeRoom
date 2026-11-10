import { defineConfig, mergeConfig } from 'vite';
import localConfig from './vite.local.config';

export default mergeConfig(localConfig, defineConfig({
  root: decodeURIComponent(new URL('./standalone', import.meta.url).pathname),
}));
