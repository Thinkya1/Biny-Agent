import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: path.join(root, "src/desktop/electron/main/index.ts")
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: path.join(root, "src/desktop/electron/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: path.join(root, "src/desktop/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: path.join(root, "src/desktop/renderer/index.html")
        }
      }
    }
  }
});
