import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'local-content-policy',
    transformIndexHtml(html) {
      const scripts = command === 'serve' ? "'self' 'unsafe-inline'" : "'self'";
      return html.replace('__APP_CSP__', `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173;`);
    }
  }],
  base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true }
}));
