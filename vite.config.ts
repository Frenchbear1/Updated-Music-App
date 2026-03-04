import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const artworkProxyPlugin = (): Plugin => ({
  name: "pulsedeck-artwork-proxy",
  configureServer(server) {
    server.middlewares.use("/api/artwork-proxy", async (req, res, next) => {
      try {
        const parsed = new URL(req.url ?? "", "http://localhost");
        const target = parsed.searchParams.get("url")?.trim();
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url query parameter");
          return;
        }

        let remoteUrl: URL;
        try {
          remoteUrl = new URL(target);
        } catch {
          res.statusCode = 400;
          res.end("Invalid url");
          return;
        }

        if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
          res.statusCode = 400;
          res.end("Unsupported protocol");
          return;
        }

        const upstream = await fetch(remoteUrl.toString(), {
          headers: {
            "user-agent": "PulseDeck-DevProxy/1.0"
          }
        });

        res.statusCode = upstream.status;
        const contentType = upstream.headers.get("content-type");
        if (contentType) {
          res.setHeader("content-type", contentType);
        }
        res.setHeader("cache-control", "public, max-age=300");

        const body = await upstream.arrayBuffer();
        res.end(Buffer.from(body));
      } catch (error) {
        next(error as Error);
      }
    });
  }
});

export default defineConfig({
  plugins: [react(), artworkProxyPlugin()],
  server: {
    proxy: {
      "/api/musixmatch": {
        target: "https://apic-desktop.musixmatch.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/musixmatch/, "")
      },
      "/api/itunes": {
        target: "https://itunes.apple.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/itunes/, "")
      },
      "/api/deezer": {
        target: "https://api.deezer.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/deezer/, "")
      }
    }
  }
});
