/**
 * 剪贴板写入统一入口。
 *
 * 背景：`navigator.clipboard` 与 `crypto.subtle`、`crypto.randomUUID` 一样受
 * Secure Context 限制，只在 HTTPS 或 localhost 暴露。本仓库存在「内网 http +
 * 局域网 IP」部署形态（例如 http://10.0.0.2:5173），实测该环境下：
 *
 *   { isSecureContext: false, navigator.clipboard: undefined,
 *     document.execCommand: "function" }
 *
 * 原代码普遍写作 `if (!navigator.clipboard?.writeText) return;` —— 在这种环境下
 * 守卫直接成立并静默返回，表现为「点击复制没有任何反应，也不报错」。
 *
 * 因此统一到这里，并在原生 API 不可用时降级到 `document.execCommand("copy")`
 * （该 API 不受 Secure Context 限制，是实现复制降级的通行做法）。
 *
 * 返回值约定：成功 true / 失败 false，**不抛异常**。调用方原有的
 * `.then(onSuccess)` 形态可直接迁移为 `.then((ok) => { if (ok) onSuccess(); })`。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;

  // 1) 原生异步 API（Secure Context / localhost）
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或非聚焦文档等情况下继续尝试降级路径，不要把「能复制」升级成失败。
    }
  }

  // 2) 降级：临时 textarea + execCommand("copy")
  return writeClipboardTextFallback(text);
}

/**
 * 是否具备「任何一条」可用的写入路径。
 * 供 UI 决定是否展示复制入口使用；不要再用 `Boolean(navigator.clipboard)` 判断，
 * 那会在 http + 局域网 IP 下把可用的降级路径一起挡掉。
 */
export function canWriteClipboard(): boolean {
  if (typeof globalThis.navigator?.clipboard?.writeText === "function") return true;
  return typeof globalThis.document?.execCommand === "function";
}

function writeClipboardTextFallback(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== "function") return false;

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  // 必须留在文档流内且可被 select()：display:none 与 visibility:hidden 都会让
  // execCommand("copy") 拿到空选区。用固定定位 + 零透明度把它藏起来。
  textarea.setAttribute("readonly", "");
  textarea.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0";
  doc.body.appendChild(textarea);

  // 记住原选区：降级路径会改变焦点与选择范围，结束后应尽量还原，避免打断
  // 正在编辑的输入框（复制按钮常见于聊天输入区附近）。
  const active = doc.activeElement;
  const selection = doc.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    textarea.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (selection && savedRange) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    if (active instanceof HTMLElement && typeof active.focus === "function") {
      active.focus({ preventScroll: true });
    }
  }
}
