/**
 * 浏览器可用的 SHA-256。
 *
 * 为什么需要这个：WebCrypto 的 `crypto.subtle` 只在 Secure Context（HTTPS 或
 * localhost）暴露。本项目还有一条常见的部署形态是「内网 http + 局域网 IP」
 * （例如 http://10.0.0.2:5173），此时 `crypto.subtle` 为 undefined。
 *
 * 附件上传会先用 SHA-256 算 checksum，服务端在 commitStaged 里用 Node 的
 * crypto.createHash("sha256") 重新计算并比对，格式要求严格为
 * `sha256:<64 位小写十六进制>`。因此这里不能降级成弱校验或伪造值——必须算出
 * 与服务端逐字节一致的摘要。做法是：能用 WebCrypto 就走原生（快），否则回退到
 * 下面的纯 JS 实现（FIPS 180-4 标准算法，任何环境结果一致）。
 */

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

// FIPS 180-4 的 SHA-256 初始哈希值与前 64 个轮常量。表驱动而非运行时计算，
// 避免每次调用重复做平方根/立方根运算。
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function sha256HexFallback(input: Uint8Array): string {
  const h = INITIAL_HASH.slice();
  const w = new Uint32Array(64);

  // 填充：0x80 + 若干个 0 + 64 位大端长度。总长必须是 64 字节的整数倍。
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  // JS 位运算只有 32 位，长度超 2^32 位（512MB）时必须分高低位写。
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, highBits);
  view.setUint32(paddedLength - 4, lowBits);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + sigma1 + ch + K[index]! + w[index]!) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}

/**
 * 计算 `sha256:<64 位小写十六进制>` 摘要，与服务端 createHash("sha256") 逐字节一致。
 *
 * 优先走 WebCrypto（原生实现，大文件更快）；在非 Secure Context 下自动回退到
 * 纯 JS 实现，使内网 http 部署也能上传附件。
 */
export async function sha256Digest(input: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      // WebCrypto 的 BufferSource 要求 ArrayBuffer；复制也避免调用期间底层 view 被复用。
      const digest = await subtle.digest("SHA-256", Uint8Array.from(input).buffer);
      let hex = "";
      for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
      return `sha256:${hex}`;
    } catch {
      // subtle 存在但调用失败（例如某些环境下算法被策略禁用）：继续走回退实现，
      // 不要把「环境不支持」升级成上传失败。
    }
  }
  return `sha256:${sha256HexFallback(input)}`;
}
