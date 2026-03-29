#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist");

mkdirSync(outDir, { recursive: true });

await build({
  absWorkingDir: rootDir,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  packages: "external",
  sourcemap: false,
  minify: false,
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __PACKAGE_NAME__: JSON.stringify("ctx-switch"),
    __PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
});
