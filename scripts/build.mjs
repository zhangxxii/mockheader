import { watch } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectRoot, "dist");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  absWorkingDir: projectRoot,
  entryPoints: {
    popup: "src/popup/main.tsx",
    background: "src/background/index.ts",
  },
  outdir: "dist/assets",
  entryNames: "[name]",
  chunkNames: "chunk-[name]-[hash]",
  assetNames: "[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "chrome145",
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

async function copyStaticFiles() {
  await mkdir(distDir, { recursive: true });
  await rm(resolve(distDir, "icons"), { recursive: true, force: true });
  await rm(resolve(distDir, "manifest.json"), { force: true });
  await cp(resolve(projectRoot, "public"), distDir, { recursive: true });
  for (const page of ["popup.html"]) {
    const contents = await readFile(resolve(projectRoot, page), "utf8");
    await writeFile(resolve(distDir, page), contents);
  }
}

await rm(distDir, { recursive: true, force: true });
await copyStaticFiles();

if (watchMode) {
  const context = await esbuild.context(buildOptions);
  await context.watch();

  let copyTimer;
  const scheduleStaticCopy = () => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      void copyStaticFiles()
        .then(() => console.log("Static extension files updated."))
        .catch((error) => console.error("Failed to update static extension files.", error));
    }, 80);
  };

  for (const path of [
    resolve(projectRoot, "public"),
    resolve(projectRoot, "public/icons"),
    resolve(projectRoot, "popup.html"),
  ]) {
    watch(path, scheduleStaticCopy);
  }

  console.log("Watching extension sources and static files. Reload dist/ in Chrome after a rebuild.");
} else {
  await esbuild.build(buildOptions);
}
