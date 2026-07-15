import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectRoot, "dist");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertFile(relativePath) {
  await access(resolve(distDir, relativePath));
}

const manifest = JSON.parse(await readFile(resolve(distDir, "manifest.json"), "utf8"));
assert(manifest.manifest_version === 3, "manifest_version 必须是 3");
assert(Number(manifest.minimum_chrome_version) >= 145, "页面域名规则要求 Chrome 145+");
assert(
  manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
  "缺少 declarativeNetRequestWithHostAccess 权限",
);
assert(manifest.host_permissions.includes("<all_urls>"), "缺少 <all_urls> 主机权限");

const manifestFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
await Promise.all([...new Set(manifestFiles)].map(assertFile));

for (const page of [manifest.action.default_popup]) {
  const html = await readFile(resolve(distDir, page), "utf8");
  const references = [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(
    (match) => match[1],
  );
  assert(references.length >= 2, `${page} 缺少本地 JS/CSS 引用`);
  assert(!html.includes("/src/"), `${page} 仍引用源码路径`);
  await Promise.all(references.map(assertFile));
}

console.log(`Verified ${new Set(manifestFiles).size} manifest files and the Popup page.`);
