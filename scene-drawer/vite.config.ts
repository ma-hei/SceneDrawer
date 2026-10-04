import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Development only: where the object server (../object-server) runs.
// The built app (npm run build) doesn't use this proxy: it calls VITE_OBJECT_SERVER_URL directly.
const OBJECT_SERVER = 'http://localhost:8091'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The page calls "/api/scene/..." on its own address; Vite forwards it to the object server.
    proxy: {
      '/api/scene': OBJECT_SERVER,
    },
  },
})
