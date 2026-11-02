import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  format: "iife",
  target: "firefox115",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
});
cpSync("static", "dist", { recursive: true });
