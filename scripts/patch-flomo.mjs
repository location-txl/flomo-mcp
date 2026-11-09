#!/usr/bin/env node
/**
 * flomo ASAR 注入：让 flomo 双击启动即带 --remote-debugging-port=9222 调试口。
 *
 * 原理：flomo 的 Electron fuses 关闭了 ASAR 完整性校验（EnableEmbeddedAsarIntegrityValidation=disabled），
 * 解包 app.asar → 在 background.js 顶部注入 app.commandLine.appendSwitch → 重打包 → ad-hoc 重签名。
 *
 * 幂等：重复运行自动跳过已注入的包。flomo 自动更新会覆盖 app.asar，届时重跑本脚本即可。
 * 恢复：cp "<app>/Contents/Resources/app.asar.orig" "<app>/Contents/Resources/app.asar" && 重新签名
 *
 * 用法：node scripts/patch-flomo.mjs [flomo.app 路径，默认 /Applications/flomo.app]
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractAll, createPackageWithOptions } from "@electron/asar";

const exec = promisify(execFileCb);
const APP = process.argv[2] ?? "/Applications/flomo.app";
const RESOURCES = path.join(APP, "Contents/Resources");
const ASAR = path.join(RESOURCES, "app.asar");
const BACKUP = ASAR + ".orig";
const MARK = "__flomoMcpPatched";
const INJECT = `;try{if(!globalThis.${MARK}){globalThis.${MARK}=1;require('electron').app.commandLine.appendSwitch('remote-debugging-port','9222');}}catch(e){};\n`;

async function main() {
  if (!existsSync(ASAR)) throw new Error(`未找到 ${ASAR}`);
  console.log(`[1/6] 目标: ${ASAR}`);

  if (!existsSync(BACKUP)) {
    await exec("cp", [ASAR, BACKUP]);
    console.log(`[2/6] 已备份 → ${BACKUP}`);
  } else {
    console.log("[2/6] 备份已存在，跳过");
  }

  const work = await mkdtemp(path.join(tmpdir(), "flomo-patch-"));
  console.log(`[3/6] 解包 → ${work}`);
  extractAll(ASAR, work);

  const bg = path.join(work, "background.js");
  const src = await readFile(bg, "utf8");
  let needPack = true;
  if (src.includes(MARK)) {
    console.log("[4/6] 已注入过，跳过注入");
    needPack = false;
  } else {
    await writeFile(bg, INJECT + src);
    console.log("[4/6] 已注入 remote-debugging-port=9222 到 background.js");
  }

  if (needPack) {
    const newAsar = path.join(work, "app.asar.new");
    console.log("[5/6] 重打包 asar…");
    // 原有的 app.asar.unpacked（keytar 原生模块）内容未变，保持不动
    await createPackageWithOptions(work, newAsar, { unpackDir: "node_modules/keytar" });
    await exec("cp", [newAsar, ASAR]);
  } else {
    console.log("[5/6] asar 已是注入版，跳过重打包");
  }

  console.log("[6/6] ad-hoc 重新签名…");
  await exec("codesign", ["--force", "--deep", "--sign", "-", APP]);

  console.log("\n✅ 注入完成。验证：");
  console.log("  1. 完全退出 flomo（右键托盘图标 → 退出）");
  console.log("  2. 双击启动 flomo");
  console.log("  3. curl http://127.0.0.1:9222/json/version 应返回版本信息");
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
