const packageDirName = "zcode";

/**
 * 生成发行包安装脚本。
 *
 * 脚本必须同时支持两种资产布局，因为项目确实会走两条分发路径：
 *
 *   1. 自建站点 / CDN：dist/zcode 整棵目录上传，保持 releases/<version>/ 层级
 *      → <base>/releases/<version>/<tarball>
 *   2. GitHub Release：资产是扁平的，没有 releases/<version>/ 这一层
 *      → <base>/<tarball>
 *
 * 之前脚本硬编码了形态 1，导致从 GitHub Release 安装时必然 404（已实测）。
 * 现在按顺序探测，命中即用；两种布局的 tarball 内容完全一致，所以无需区分后续步骤。
 */
export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ZCODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${ZCODE_DIST_HOME:-$HOME/.zcode/runtime}"
BIN_DIR="\${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "zcode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

# 从 latest.json 读字段。baseUrl 可能指向与实际资产不同的位置（例如把索引放在
# CDN、把 tarball 放 Release），所以优先采用清单里的 baseUrl，缺失才回退到脚本内置值。
read_json_field() {
  printf '%s' "$1" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const v=JSON.parse(data)[process.argv[1]];process.stdout.write(v==null?'':String(v))})" "$2"
}

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(read_json_field "$LATEST_JSON" version)"
TARBALL="$(read_json_field "$LATEST_JSON" tarball)"
MANIFEST_BASE_URL="$(read_json_field "$LATEST_JSON" baseUrl)"

if [ -z "$VERSION" ] || [ -z "$TARBALL" ]; then
  echo "zcode install: latest.json 缺少 version/tarball 字段" >&2
  exit 1
fi

# 候选下载地址，按顺序尝试：
#   1) 清单里的 baseUrl + releases/<version>/  —— 自建站点（层级布局）
#   2) 清单里的 baseUrl + 裸 tarball           —— GitHub Release（扁平布局）
#   3) 脚本内置 baseUrl + releases/<version>/  —— 清单 baseUrl 失效时的兜底
#   4) 脚本内置 baseUrl + 裸 tarball
CANDIDATES=""
add_candidate() {
  [ -n "$1" ] || return 0
  case " $CANDIDATES " in
    *" $1 "*) ;;
    *) CANDIDATES="\${CANDIDATES} $1" ;;
  esac
}
if [ -n "$MANIFEST_BASE_URL" ]; then
  add_candidate "\${MANIFEST_BASE_URL%/}/releases/$VERSION/$TARBALL"
  add_candidate "\${MANIFEST_BASE_URL%/}/$TARBALL"
fi
add_candidate "\${BASE_URL%/}/releases/$VERSION/$TARBALL"
add_candidate "\${BASE_URL%/}/$TARBALL"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
DOWNLOADED=""
for url in $CANDIDATES; do
  echo "zcode install: downloading $url"
  if curl -fL --connect-timeout 20 --retry 2 --retry-delay 2 "$url" -o "$ARCHIVE"; then
    DOWNLOADED="$url"
    break
  fi
  rm -f "$ARCHIVE"
done

if [ -z "$DOWNLOADED" ]; then
  echo "zcode install: 所有候选地址都下载失败。请检查网络，或用 ZCODE_DIST_BASE_URL 指定正确的下载根地址。" >&2
  echo "已尝试:" >&2
  for url in $CANDIDATES; do echo "  - $url" >&2; done
  exit 1
fi

# 校验完整性：清单提供了 sha256 就必须匹配，避免下载到被截断或篡改的包。
EXPECTED_SHA="$(read_json_field "$LATEST_JSON" sha256)"
if [ -n "$EXPECTED_SHA" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
  else
    echo "zcode install: 未找到 sha256sum/shasum，跳过校验" >&2
    ACTUAL_SHA=""
  fi
  if [ -n "$ACTUAL_SHA" ] && [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "zcode install: sha256 校验失败" >&2
    echo "  期望: $EXPECTED_SHA" >&2
    echo "  实际: $ACTUAL_SHA" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
# 先解到临时目录再原子替换：中途失败时旧版本仍然可用。
if ! tar -xzf "$ARCHIVE" -C "$TARGET.new"; then
  echo "zcode install: 解压失败" >&2
  rm -rf "$TARGET.new"
  exit 1
fi
if [ ! -d "$TARGET.new/${packageDirName}" ]; then
  echo "zcode install: 压缩包结构异常，缺少 ${packageDirName}/ 目录" >&2
  rm -rf "$TARGET.new"
  exit 1
fi
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/zcode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/zcode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/zcode"

echo "ZCode $VERSION installed."
echo "Run: zcode (TUI) or zcode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
