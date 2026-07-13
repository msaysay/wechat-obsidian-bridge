/**
 * 微信 iLink 协议客户端（官方个人号 Bot API，域名 ilinkai.weixin.qq.com）
 * 独立实现，不依赖 OpenClaw。请求格式对齐 @tencent-weixin/openclaw-weixin 1.0.2。
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";
const POLL_TIMEOUT_MS = 40_000;
const API_TIMEOUT_MS = 15_000;

export class ILinkClient {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.tokenFile = path.join(dataDir, "bot_token.json");
    this.stateFile = path.join(dataDir, "state.json");
    this.tokenData = null;
    this.cursor = this.#loadState().cursor || "";
    this.typingTickets = new Map();
  }

  // ---------- 底层 ----------

  #baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  /** X-WECHAT-UIN：random uint32 → 十进制字符串 → base64，每请求随机 */
  #randomUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), "utf-8").toString("base64");
  }

  #headers(bodyStr) {
    const h = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": this.#randomUin(),
    };
    if (bodyStr) h["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));
    if (this.tokenData?.bot_token) h["Authorization"] = `Bearer ${this.tokenData.bot_token}`;
    return h;
  }

  async #post(endpoint, payload, timeoutMs = API_TIMEOUT_MS) {
    const base = this.tokenData?.baseurl || ILINK_BASE;
    const url = new URL(endpoint, base.endsWith("/") ? base : base + "/");
    const bodyStr = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: this.#headers(bodyStr),
        body: bodyStr,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  #loadState() {
    try { return JSON.parse(readFileSync(this.stateFile, "utf-8")); } catch { return {}; }
  }

  #saveState() {
    writeFileSync(this.stateFile, JSON.stringify({ cursor: this.cursor }, null, 2));
  }

  // ---------- 登录 ----------

  loadToken() {
    if (!existsSync(this.tokenFile)) return null;
    try {
      const data = JSON.parse(readFileSync(this.tokenFile, "utf-8"));
      if (data.bot_token) { this.tokenData = data; return data; }
    } catch {}
    return null;
  }

  /**
   * 扫码登录。断开后 token 仍保留（loadToken 复用），过期才需重扫。
   * onQrcode(url) 回调负责展示二维码。
   */
  async login(onQrcode) {
    if (this.loadToken()) return this.tokenData;

    const qrRes = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      headers: this.#headers(),
    });
    const qrData = await qrRes.json();
    if (!qrData.qrcode_img_content) {
      throw new Error("获取二维码失败: " + JSON.stringify(qrData));
    }
    await onQrcode(qrData.qrcode_img_content);

    while (true) {
      await sleep(2000);
      let statusData;
      try {
        const res = await fetch(
          `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrData.qrcode)}`,
          { headers: this.#headers() }
        );
        statusData = await res.json();
      } catch { continue; }

      if (statusData.status === "confirmed" || statusData.bot_token) {
        this.tokenData = {
          bot_token: statusData.bot_token,
          baseurl: statusData.baseurl || ILINK_BASE,
          bot_id: statusData.bot_id || "",
          login_time: new Date().toISOString(),
        };
        writeFileSync(this.tokenFile, JSON.stringify(this.tokenData, null, 2));
        return this.tokenData;
      }
      if (statusData.status === "expired") throw new Error("二维码已过期，请重新启动");
      process.stdout.write(statusData.status === "scanned" ? "\r已扫码，等待手机确认..." : "\r等待扫码...");
    }
  }

  // ---------- 收消息（长轮询） ----------

  /**
   * 持续长轮询。onMessage(msg) 逐条回调（已过滤 bot 自己的消息）。
   * ret=-14 等 session 失效时抛 SessionExpiredError。
   */
  async pollLoop(onMessage) {
    let failStreak = 0;
    while (true) {
      let data;
      try {
        data = await this.#post(
          "ilink/bot/getupdates",
          { get_updates_buf: this.cursor, base_info: this.#baseInfo() },
          POLL_TIMEOUT_MS
        );
        if (failStreak) {
          console.log(`[ilink] 连接已恢复（此前失败 ${failStreak} 次）`);
          failStreak = 0;
        }
      } catch (err) {
        if (err.name === "AbortError") continue; // 长轮询自然超时
        failStreak++;
        // 连续失败时退避 + 只在首次/每10次打日志，避免刷屏（常见于切网/VPN波动）
        if (failStreak === 1 || failStreak % 10 === 0) {
          console.error(`[ilink] 收消息连接中断（第 ${failStreak} 次，多为网络/VPN波动）: ${err.message}`);
        }
        await sleep(Math.min(3000 * failStreak, 15000));
        continue;
      }

      if (data.ret && data.ret !== 0) {
        if (data.errcode === -14) {
          const e = new Error("session 失效，需要重新扫码");
          e.code = "SESSION_EXPIRED";
          throw e;
        }
        console.error(`[ilink] getupdates ret=${data.ret} errmsg=${data.errmsg || ""}`);
        await sleep(3000);
        continue;
      }

      if (data.get_updates_buf) {
        this.cursor = data.get_updates_buf;
        this.#saveState();
      }

      for (const msg of data.msgs || []) {
        if (msg.message_type === 2) continue; // bot 自己发的
        if (msg.from_user_id?.endsWith("@im.bot")) continue;
        try {
          await onMessage(msg);
        } catch (err) {
          console.error("[ilink] 消息处理异常:", err.message);
        }
      }
    }
  }

  // ---------- 发消息 ----------

  /**
   * 发送文本。state: 1=GENERATING(流式中,同 client_id 反复更新) 2=FINISH(定稿)
   * 流式用法: 多次 state=1(同 clientId) → 最后一次 state=2 收口
   */
  async sendTextMessage(toUserId, contextToken, text, { clientId, state = 2 } = {}) {
    return this.#post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId || `bridge-${crypto.randomUUID()}`,
        message_type: 2, // BOT
        message_state: state,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: this.#baseInfo(),
    });
  }

  async sendText(toUserId, contextToken, text) {
    return this.sendTextMessage(toUserId, contextToken, text);
  }

  /** 下载 CDN 媒体时用的鉴权头（部分资源需要 bot token） */
  mediaHeaders() {
    const h = { "X-WECHAT-UIN": this.#randomUin() };
    if (this.tokenData?.bot_token) h["Authorization"] = `Bearer ${this.tokenData.bot_token}`;
    return h;
  }

  // ---------- typing 指示器 ----------

  async #typingTicket(userId, contextToken) {
    if (!this.typingTickets.has(userId)) {
      const config = await this.#post("ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: this.#baseInfo(),
      });
      if (config.typing_ticket) this.typingTickets.set(userId, config.typing_ticket);
    }
    return this.typingTickets.get(userId);
  }

  async startTyping(userId, contextToken) {
    try {
      const ticket = await this.#typingTicket(userId, contextToken);
      if (ticket) await this.#sendTyping(userId, ticket, 1);
    } catch (err) {
      console.log("[ilink] typing 失败(不影响主流程):", err.message);
    }
  }

  async stopTyping(userId) {
    try {
      const ticket = this.typingTickets.get(userId);
      if (ticket) await this.#sendTyping(userId, ticket, 2);
    } catch {}
  }

  async #sendTyping(userId, ticket, status) {
    return this.#post("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status, // 1=typing 2=cancel
      base_info: this.#baseInfo(),
    });
  }
}

/** 提取消息里的纯文本（type=1） */
export function extractText(msg) {
  return (msg.item_list || [])
    .filter((i) => i.type === 1 && i.text_item)
    .map((i) => i.text_item.text)
    .join("");
}

/** 提取被引用消息的文本（长按引用场景） */
export function extractQuotedText(msg) {
  for (const item of msg.item_list || []) {
    if (item.ref_msg?.message_item?.text_item?.text) {
      return item.ref_msg.message_item.text_item.text;
    }
  }
  return null;
}

/** 取出消息里的所有图片 item（type=2） */
export function extractImageItems(msg) {
  return (msg.item_list || [])
    .filter((i) => i.type === 2 && i.image_item)
    .map((i) => i.image_item);
}

/** 语音消息若带官方转写文本则取出（不做本地 ASR，用户用输入法语音为主） */
export function extractVoiceText(msg) {
  for (const item of msg.item_list || []) {
    if (item.type === 3 && item.voice_item) {
      const v = item.voice_item;
      const t = v.voice_text || v.transcript || v.text || v.voice_to_text || "";
      if (t) return String(t);
    }
  }
  return null;
}

export const MSG_TYPES = { 1: "文本", 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
