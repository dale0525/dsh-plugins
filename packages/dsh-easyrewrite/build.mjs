/**
 * dsh-easyrewrite 构建脚本：
 * 1. 原样拷贝浏览器半边 src/client.src.js → lib/client.js；
 * 2. 原样拷贝宿主半边 src/index.js → lib/index.js（package.json 的 main/exports 指向它）。
 * 用法：npm run build（或 node build.mjs）。发布/安装（git 源）经 prepare 自动执行。
 *
 * 图标已改为内联 SVG（见 src/client.src.js 的 iconSvg），不再需要把 assets/*.png
 * 内联成 base64——那套白底位图在主题下只能靠 filter:invert 反色，边缘会糊。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, "lib");
const outClient = join(libDir, "client.js");
const outHost = join(libDir, "index.js");

const tpl = await readFile(join(root, "src", "client.src.js"), "utf8");

await mkdir(libDir, { recursive: true });
await writeFile(outClient, tpl);
console.log("[dsh-easyrewrite] built:", outClient, "(" + tpl.length + " bytes)");

const host = await readFile(join(root, "src", "index.js"), "utf8");
await writeFile(outHost, host);
console.log("[dsh-easyrewrite] built:", outHost, "(" + host.length + " bytes)");
