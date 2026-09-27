/**
 * 非 Secure Context 下也可用的随机标识工具。
 *
 * 背景：`crypto.randomUUID()` 与 `crypto.subtle` 一样受 Secure Context 限制，
 * 只在 HTTPS 或 localhost 可用。本仓库存在「内网 http + 局域网 IP」部署形态
 * （例如 http://10.0.0.2:5173），实测该环境下：
 *
 *   { isSecureContext: false, hasCrypto: true,
 *     hasRandomUUID: false, hasGetRandomValues: true, hasSubtle: false }
 *
 * 即 `crypto` 本身存在、`getRandomValues` 可用，但 `randomUUID` 是 undefined。
 * 直接调用 `crypto.randomUUID()` 会抛 "crypto.randomUUID is not a function"，
 * 表现为保存 Hook、新建注释、PPTX 引用等功能直接失败。
 *
 * 因此这里基于 `getRandomValues` 自建 UUID v4（RFC 4122），格式与原生实现一致；
 * 两者都不可用时回退到 Math.random —— 这些标识只用于前端本地去重/关联，
 * 不承担密码学用途，降级不会放大安全风险。
 */

/** 生成 UUID v4（RFC 4122），格式与 crypto.randomUUID() 一致。 */
export function randomUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // 仅当前两者都缺失时进入。这些 id 用于本地去重，不是安全凭证。
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 §4.4：version 4 与 variant 10xx 必须按位写入，不能沿用随机值。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成带前缀的标识。原代码普遍写作 `prefix-${crypto.randomUUID()}`，
 * 用这个保持既有格式不变。
 */
export function prefixedRandomUuid(prefix: string): string {
  return `${prefix}${randomUuid()}`;
}
