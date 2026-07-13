/**
 * 图片/媒体落库：下载微信 CDN 上的图片，必要时 AES-128-ECB 解密，存进 Obsidian 库附件夹。
 *
 * 协议不确定性较大(密钥 hex/base64、是否整文件加密、鉴权方式各源不一致)，
 * 因此采用「魔数自纠正」：下载后先看是不是已经是合法图片，不是再尝试解密(多种参数)，
 * 并把真实字段打进日志，方便用第一张真实图片校准。
 */
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// 常见图片魔数 → 扩展名
const MAGICS = [
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { ext: "webp", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { ext: "bmp", test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { ext: "heic", test: (b) => b.length >= 12 && b.toString("ascii", 4, 12) === "ftypheic" },
];

function detectImageExt(buf) {
  if (!buf || buf.length < 4) return null;
  for (const m of MAGICS) if (m.test(buf)) return m.ext;
  return null;
}

/** 把各种编码的 key 归一成 16 字节 Buffer（AES-128） */
function toKey16(k) {
  if (!k || typeof k !== "string") return [];
  const out = [];
  // hex 32 位
  if (/^[0-9a-fA-F]{32}$/.test(k)) out.push(Buffer.from(k, "hex"));
  // base64 → 恰好 16 字节
  try { const b = Buffer.from(k, "base64"); if (b.length === 16) out.push(b); } catch {}
  // 原始 16 字节
  if (Buffer.byteLength(k, "utf-8") === 16) out.push(Buffer.from(k, "utf-8"));
  return out;
}

/** AES-128-ECB 解密，padding 开/关都试 */
function tryDecrypt(buf, key) {
  for (const pad of [false, true]) {
    try {
      const d = crypto.createDecipheriv("aes-128-ecb", key, null);
      d.setAutoPadding(pad);
      const out = Buffer.concat([d.update(buf), d.final()]);
      if (out.length) return out;
    } catch {}
  }
  return null;
}

async function download(url, headers, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 从 CDNMedia / ImageItem 收集所有候选 (下载url, [key们]) */
function collectCandidates(imageItem) {
  const cands = [];
  const keys = [imageItem.aeskey, imageItem.aes_key].filter(Boolean);
  for (const media of [imageItem.media, imageItem.thumb_media]) {
    if (!media) continue;
    let url = media.full_url || media.url;
    if (!url) continue;
    if (media.encrypt_query_param && !url.includes("?")) {
      url += (media.encrypt_query_param.startsWith("?") ? "" : "?") + media.encrypt_query_param;
    }
    const mediaKeys = [media.aes_key, media.aeskey, ...keys].filter(Boolean);
    cands.push({ url, keys: mediaKeys });
  }
  // 兜底：ImageItem.url 直连
  if (imageItem.url) cands.push({ url: imageItem.url, keys });
  return cands;
}

/**
 * 下载并落库一张图片。
 * @returns {ok, relPath, absPath, ext} | {ok:false, reason}
 */
export async function saveImage(imageItem, { vaultPath, attachmentsDir, headers, stamp }) {
  // 把真实结构打进日志，作为校准依据（key 只打长度，不泄露）
  console.log("[media] 收到图片 image_item:", JSON.stringify(imageItem, (k, v) =>
    /aes_?key|query_param/i.test(k) && typeof v === "string" ? `<${v.length}字符>` : v));

  const cands = collectCandidates(imageItem);
  if (!cands.length) return { ok: false, reason: "图片消息里没有可用的下载地址(full_url/url 都为空)" };

  let lastErr = "";
  for (const cand of cands) {
    let raw;
    try {
      raw = await download(cand.url, headers);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    // 1) 下载的已经是合法图片？直接用
    let ext = detectImageExt(raw);
    let bytes = raw;
    // 2) 否则逐个 key 尝试解密
    if (!ext) {
      for (const kStr of cand.keys) {
        for (const key of toKey16(kStr)) {
          const dec = tryDecrypt(raw, key);
          const e2 = detectImageExt(dec);
          if (e2) { ext = e2; bytes = dec; break; }
        }
        if (ext) break;
      }
    }
    if (!ext) {
      lastErr = `下载到 ${raw.length} 字节，但既不是明文图片、解密也未得到合法图片(试了 ${cand.keys.length} 个key)`;
      continue;
    }

    // 落库
    const dir = path.join(vaultPath, attachmentsDir);
    mkdirSync(dir, { recursive: true });
    const name = `${stamp}.${ext}`;
    const abs = path.join(dir, name);
    writeFileSync(abs, bytes);
    const rel = path.join(attachmentsDir, name).replace(/\\/g, "/");
    console.log(`[media] 图片已存: ${rel} (${bytes.length} 字节, ${ext})`);
    return { ok: true, relPath: rel, absPath: abs, ext };
  }
  return { ok: false, reason: lastErr || "所有候选地址都下载/解密失败" };
}

export { detectImageExt };
