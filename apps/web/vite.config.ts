import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: "autoUpdate", includeAssets: ["favicon.svg"], manifest: {
    name: "ClimateShield Nexus", short_name: "ClimateShield", start_url: "/", display: "standalone",
    background_color: "#f2f4ee", theme_color: "#163b35", icons: []
  }, workbox: { navigateFallback: "/index.html", globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] } })],
  server: { proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, "") } } },
});