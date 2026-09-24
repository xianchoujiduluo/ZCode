#!/usr/bin/env node
// 把 build:zcode 的发行产物加工成可发布到 npm 的包。
//
// 为什么不直接改 build-zcode.mjs：那条链路服务于 Release 的 install.sh 分发
// （带 releases/<version>/ 目录层级与 latest.json 索引），npm 只需要一个能
// `npm i -g` 后直接运行的包。两套分发语义不同，这里做二次加工，互不影响。
//
// 主要动作：
//   1. 剥离 source map —— 实测 web/assets 里 87MB 是 .map（2281 个），纯调试用。
//      只删文件不够：JS 末尾的 //# sourceMappingURL= 注释会让 DevTools 去请求
//      已不存在的 map 并报 404，所以同时剥掉注释。
//   2. 改写 package.json —— 产物里那份是 {"private":true} 的占位，不能发布。
//      补 bin / files / engines，并去掉 private。
//   3. npm pack —— 在目标目录生成 tgz，供后续 npm publish 使用。
//
// 用法：
//   node scripts/build-npm-package.mjs --source dist/zcode --out build/npm --name zcode-web-agent [--version 3.14.1]

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommandAndReadStdout } from "./spawn-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const usage = `用法:
  node scripts/build-npm-package.mjs --source <dist/zcode> --out <dir> [--name <pkg>] [--version <v>] [--keep-sourcemap]

参数:
  --source <path>         build:zcode 的输出目录（含 latest.json / install.sh / releases/）。
                          脚本会自动定位其中的产物根：优先 <source>/zcode，
                          不存在时把 <source> 本身当产物根。
                          两种形态都支持的原因是 CI 下载 artifact 后拿到的是
                          产物内容本身（无 zcode/ 前缀），而本地 dist 是 <dist>/zcode。
  --out <path>            加工后的包输出目录。默认 build/npm
  --name <pkg>            npm 包名。默认 zcode-web-agent
  --version <v>           包版本。默认取根 package.json 的 version
  --keep-sourcemap        保留 source map（默认剥离）
  --no-pack               只产出目录，不执行 npm pack
  --help, -h              显示帮助`;

function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return { nextIndex: index, value: arg.slice(arg.indexOf("=") + 1) };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`缺参数值: ${arg}`);
  }
  return { nextIndex: index + 1, value };
}

function parseArgs(argv) {
  const options = {
    source: resolve(root, "dist/zcode"),
    out: resolve(root, "build/npm"),
    name: "zcode-web-agent",
    version: undefined,
    keepSourcemap: false,
    pack: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--keep-sourcemap") {
      options.keepSourcemap = true;
      continue;
    }
    if (arg === "--no-pack") {
      options.pack = false;
      continue;
    }
    if (arg === "--source" || arg.startsWith("--source=")) {
      const parsed = readArgValue(argv, arg, index);
      options.source = resolve(root, parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const parsed = readArgValue(argv, arg, index);
      options.out = resolve(root, parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--name" || arg.startsWith("--name=")) {
      const parsed = readArgValue(argv, arg, index);
      options.name = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=")) {
      const parsed = readArgValue(argv, arg, index);
      options.version = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`未知参数 "${arg}"。\n${usage}`);
  }

  return options;
}

// 与 packaged-sourcemap-cleanup.mjs 同口径：sourcemap 注释总是单独成行。
// 不能贪心匹配到行尾，否则会把同一行的正常代码一起吞掉，产出语法损坏的文件。
const SOURCE_MAP_COMMENT_PATTERN = /^\/\/[#@]\s*sourceMappingURL=.*$/gm;
const SOURCE_MAP_BLOCK_PATTERN = /^\/\*[#@]\s*sourceMappingURL=.*?\*\/\s*$/gm;
const INLINE_SOURCE_MAP_PREFIX = "sourceMappingURL=data:";

async function* walkFiles(directory, skipNames) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, skipNames);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

async function stripSourceMaps(packageRoot) {
  let removedMaps = 0;
  let rewritten = 0;
  let removedBytes = 0;
  // node_modules 里的第三方包也带 map，但改动它们会破坏完整性校验，
  // 且体积占比很小；这里只处理自建的 web/ server/ agent/ 产物。
  const skipNames = new Set(["node_modules", ".git"]);
  const stripRoots = ["web", "server", "agent", "bin"];

  for (const relativeRoot of stripRoots) {
    const targetRoot = resolve(packageRoot, relativeRoot);
    try {
      await stat(targetRoot);
    } catch {
      continue;
    }

    for await (const filePath of walkFiles(targetRoot, skipNames)) {
      if (extname(filePath) === ".map") {
        const before = await stat(filePath);
        await rm(filePath, { force: true });
        removedMaps += 1;
        removedBytes += before.size;
        continue;
      }
      // 只重写可能是 JS/CSS 的文本文件，跳过图片、字体、wasm 等二进制
      if (!/\.(?:js|mjs|cjs|css|jsx|tsx|ts)$/i.test(filePath)) continue;

      let source;
      try {
        source = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      if (!source.includes("sourceMappingURL=")) continue;
      // 内联 base64 map 不属于本次剥离目标（删注释即丢失调试信息但文件仍自洽，这里保留）
      if (source.includes(INLINE_SOURCE_MAP_PREFIX)) continue;

      const next = source
        .replace(SOURCE_MAP_COMMENT_PATTERN, "")
        .replace(SOURCE_MAP_BLOCK_PATTERN, "");
      if (next !== source) {
        await writeFile(filePath, next);
        rewritten += 1;
      }
    }
  }

  return { removedMaps, rewritten, removedBytes };
}

async function directorySize(directory) {
  let total = 0;
  for await (const filePath of walkFiles(directory, new Set([".git"]))) {
    total += (await stat(filePath)).size;
  }
  return total;
}

function buildPackageManifest({ name, version, enginesNode, bundledDependencies }) {
  return {
    name,
    version,
    type: "module",
    // 产物不自带 Node：bin/zcode.mjs 以 `#!/usr/bin/env node` 启动，
    // 内部还会用 process.execPath 拉起 server 与 agent 子进程。
    // 不声明 engines 会让用户在低版本 Node 上装完才在运行期失败。
    engines: { node: enginesNode },
    bin: { zcode: "bin/zcode.mjs" },
    // node_modules 必须出现在 files 里，否则 npm 不会把它收进 tarball。
    files: ["bin", "web", "server", "agent", "node_modules"],
    // 关键：dependencies 与 bundleDependencies 必须成对出现。
    // 实测（本地最小复现）：只写 bundleDependencies + files 时，tarball 里
    // 不会包含 node_modules；补上 dependencies 后才真正打进包。
    // 而日志显示过 `npm i -g` 会丢弃未声明的嵌套 node_modules，
    // 导致 server/entry-http.js 启动即抛 "Cannot find package 'yaml'"。
    // 版本用产物内实际安装的精确版本（见 collectBundledDependencies）。
    dependencies: bundledDependencies,
    bundleDependencies: Object.keys(bundledDependencies),
    private: false,
    description: "ZCode Web + Agent runtime: browser UI with a local agent backend.",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/xianchoujiduluo/ZCode.git",
    },
    scripts: {},
  };
}

/**
 * 收集产物 node_modules 下的顶层依赖及其实际安装版本。
 *
 * 为什么不写 range：产物里的原生预编译（node-pty 等）与各包版本是构建时固定的，
 * 写 range 会让用户在安装时解析到不同版本，与 `npm check` 校验过的组合不一致，
 * 也可能装到没有对应平台预编译件的版本。用 `=x.y.z` 钉死实际版本。
 */
async function collectBundledDependencies(packageRoot) {
  const nodeModulesDir = resolve(packageRoot, "node_modules");
  const entries = await readdir(nodeModulesDir, { withFileTypes: true });
  const dependencies = {};

  const readManifest = async (packageName, manifestPath) => {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.version) dependencies[packageName] = `=${manifest.version}`;
    } catch {
      // 拿不到版本就不声明：宁可漏带（运行期报错可见）也不要写错版本。
    }
  };

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      // scope 目录：bundleDependencies 不接受裸 @scope，要逐个列子包
      const scopeDir = resolve(nodeModulesDir, entry.name);
      const scoped = await readdir(scopeDir, { withFileTypes: true });
      for (const child of scoped) {
        if (!child.isDirectory()) continue;
        await readManifest(
          `${entry.name}/${child.name}`,
          resolve(scopeDir, child.name, "package.json"),
        );
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    await readManifest(entry.name, resolve(nodeModulesDir, entry.name, "package.json"));
  }

  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 定位产物根目录。
 *
 * 支持两种形态，因为产物在不同链路里的布局不同：
 *  - 本地 dist/zcode/zcode（build:zcode 的 .work 结构）
 *  - CI 下载的 artifact 根（upload-artifact 会把单个 path 当根，丢掉了 zcode/ 前缀）
 *
 * 判定依据是产物特征文件 bin/zcode.mjs：存在即为产物根。
 */
async function resolvePackageSource(sourceDir) {
  const candidates = [resolve(sourceDir, "zcode"), sourceDir];
  for (const candidate of candidates) {
    try {
      await stat(resolve(candidate, "bin", "zcode.mjs"));
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `在 ${sourceDir} 及其 zcode/ 子目录下都找不到 bin/zcode.mjs，` +
      `请确认 --source 指向 build:zcode 的输出目录或其产物根。`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const sourcePackageRoot = await resolvePackageSource(options.source);
  console.log(`[npm] 产物根: ${sourcePackageRoot}`);

  const rootPackageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = options.version ?? rootPackageJson.version;
  if (!version) throw new Error("无法确定版本号，请传 --version。");
  const enginesNode = rootPackageJson.engines?.node ?? ">=24.0.0";

  const outRoot = options.out;
  const packageRoot = resolve(outRoot, "package");
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  console.log(`[npm] 复制产物: ${sourcePackageRoot} → ${packageRoot}`);
  await cp(sourcePackageRoot, packageRoot, { recursive: true, verbatimSymlinks: true });

  if (!options.keepSourcemap) {
    const result = await stripSourceMaps(packageRoot);
    console.log(
      `[npm] 剥离 source map: 删除 ${result.removedMaps} 个 .map (${(result.removedBytes / 1048576).toFixed(1)}MB)，` +
        `清理 ${result.rewritten} 个文件的 map 注释`,
    );
  } else {
    console.log("[npm] 保留 source map（--keep-sourcemap）");
  }

  // 覆盖产物里的占位 manifest。原内容是 {"name":"zcode-runtime","private":true}。
  const bundledDependencies = await collectBundledDependencies(packageRoot);
  console.log(`[npm] 随包携带的顶层依赖: ${Object.keys(bundledDependencies).length} 个`);
  const manifest = buildPackageManifest({
    name: options.name,
    version,
    enginesNode,
    bundledDependencies,
  });
  await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const unpackedBytes = await directorySize(packageRoot);
  console.log(`[npm] 解压后体积: ${(unpackedBytes / 1048576).toFixed(1)}MB`);

  if (!options.pack) {
    console.log(`[npm] 已完成（--no-pack），包目录: ${packageRoot}`);
    return;
  }

  console.log("[npm] 执行 npm pack");
  // 不用 --json：它会把包内每个文件的清单都打到 stdout，255MB 产物有数千文件，
  // 既占几 MB 内存又需要 64MB 级别的 maxBuffer。直接 pack 后自己找 tgz，
  // 文件名规则是 <name>-<version>.tgz（scoped 包会把 / 换成 -）。
  const expectedFilename = `${options.name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
  runCommandAndReadStdout("npm", ["pack", "--pack-destination", outRoot], {
    cwd: packageRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const tarballPath = resolve(outRoot, expectedFilename);
  const tarballStat = await stat(tarballPath).catch(() => null);
  if (!tarballStat) {
    const produced = await readdir(outRoot);
    throw new Error(`npm pack 未产出预期的 ${expectedFilename}。目录内容: ${produced.join(", ")}`);
  }
  const tarballBytes = tarballStat.size;
  const sha256 = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");

  console.log(`[npm] tarball: ${tarballPath}`);
  console.log(`[npm] tarball 体积: ${(tarballBytes / 1048576).toFixed(1)}MB`);
  console.log(`[npm] sha256: ${sha256}`);

  // npm registry 对单包 tarball 有 100MB 上限。提前卡住，避免白跑一次发布。
  const npmTarballLimit = 100 * 1024 * 1024;
  if (tarballBytes > npmTarballLimit) {
    throw new Error(
      `tarball ${(tarballBytes / 1048576).toFixed(1)}MB 超过 npm 单包 100MB 上限，发布会失败。`,
    );
  }

  const relativeTarball = relative(root, tarballPath).split(sep).join("/");
  await writeFile(
    resolve(outRoot, "npm-pack.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        filename: expectedFilename,
        tarball: relativeTarball,
        sizeBytes: tarballBytes,
        unpackedBytes,
        sha256,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[npm] 汇总: ${relative(root, resolve(outRoot, "npm-pack.json"))}`);
}

// 用 pathToFileURL 而不是手工拼 `file://${path}`：Windows 盘符路径（E:\...）
// 手工拼接会得到非法的 file://E:\... 而永远匹配不上 import.meta.url。
const entryPath = process.argv[1];
const isDirectRun = entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
if (isDirectRun) {
  await main().catch((error) => {
    console.error(`[npm] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
