/**
 * wechat-obsidian-bridge v0.2 主程序
 * 微信(iLink 官方 Bot) → Claude Code Agent → Obsidian 库，随身第二大脑。
 * v0.2: 流式回复 / 工具过程可视化 / git后悔药(撤销) / 白名单自动锁定 /
 *        公众号链接自动入库 / 日报伪推送(24h窗口) / 单实例锁 / 文件日志
 */
import { readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { ILinkClient, extractText, extractQuotedText, extractVoiceText, MSG_TYPES, sleep } from "./src/ilink.mjs";
import { AgentBridge, splitMessage, TOOL_LABELS } from "./src/agent.mjs";
import { VaultSnapshot } from "./src/snapshot.mjs";
import { findWechatLinks, fetchWechatArticle, buildIngestPrompt, runProcess } from "./src/ingest.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(ROOT, "config.json");
if (!existsSync(configFile)) {
  console.error("缺少 config.json —— 先执行: copy config.example.json config.json 然后改成你自己的路径。");
  process.exit(1);
}
const config = JSON.parse(readFileSync(configFile, "utf-8"));
// persona.md 是你的私人人设(不入git)；没有就用通用模板
const personaFile = existsSync(path.join(ROOT, "persona.md"))
  ? path.join(ROOT, "persona.md")
  : path.join(ROOT, "persona.example.md");
const persona = readFileSync(personaFile, "utf-8");
const dataDir = path.join(ROOT, "data");
mkdirSync(dataDir, { recursive: true });

// ---------- 文件日志（后台运行时唯一的眼睛） ----------
const logFile = path.join(dataDir, "bridge.log");
for (const level of ["log", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    try {
      appendFileSync(logFile, `[${new Date().toLocaleString("zh-CN")}] ${a.map(String).join(" ")}\n`);
    } catch {}
  };
}

const ilink = new ILinkClient(dataDir);
const agent = new AgentBridge(config, persona, dataDir);
const snapshot = new VaultSnapshot(config.vaultPath, path.join(dataDir, "vault.git"));

// ---------- 运行状态（owner锁定 / 伪推送上下文） ----------
const appStateFile = path.join(dataDir, "app_state.json");
let appState = {};
try { appState = JSON.parse(readFileSync(appStateFile, "utf-8")); } catch {}
function saveAppState() {
  writeFileSync(appStateFile, JSON.stringify(appState, null, 2));
}

let queue = Promise.resolve();
const RESET_WORDS = new Set(["新话题", "/reset", "reset", "清空上下文"]);
const UNDO_WORDS = new Set(["撤销", "撤回", "/undo", "undo"]);

// ---------- 流式发送器：GENERATING 反复更新，FINISH 收口，失败自动降级 ----------
class StreamSender {
  constructor(to, contextToken) {
    this.to = to;
    this.ctx = contextToken;
    this.clientId = `bridge-${crypto.randomUUID()}`;
    this.text = "";
    this.tool = "";
    this.dirty = false;
    this.broken = !config.streaming;
    this.sending = false;
    this.timer = setInterval(() => this.#flush(), 1800);
  }

  onEvent(ev) {
    if (ev.kind === "text") {
      this.text += (this.text ? "\n\n" : "") + ev.text;
      this.tool = "";
      this.dirty = true;
    } else if (ev.kind === "tool" && config.toolStatus) {
      const label = TOOL_LABELS[ev.name] || ev.name;
      this.tool = label + (ev.detail ? " " + ev.detail : "");
      this.dirty = true;
    }
  }

  async #flush() {
    if (this.broken || !this.dirty || this.sending) return;
    this.dirty = false;
    this.sending = true;
    const body =
      this.text + (this.tool ? `${this.text ? "\n\n" : ""}⏳ ${this.tool}…` : "");
    if (body.trim()) {
      try {
        await ilink.sendTextMessage(this.to, this.ctx, body.slice(0, config.chunkSize), {
          clientId: this.clientId,
          state: 1, // GENERATING
        });
      } catch (err) {
        this.broken = true;
        console.log("[stream] 流式更新失败，本轮降级为整段发送:", err.message.slice(0, 120));
      }
    }
    this.sending = false;
  }

  async finish(finalText) {
    clearInterval(this.timer);
    while (this.sending) await sleep(100);
    const chunks = splitMessage(finalText || "(空回复)", config.chunkSize);
    try {
      await ilink.sendTextMessage(this.to, this.ctx, chunks[0], { clientId: this.clientId, state: 2 });
    } catch {
      await ilink.sendTextMessage(this.to, this.ctx, chunks[0]); // 换新消息兜底
    }
    for (const c of chunks.slice(1)) {
      await sleep(400);
      await ilink.sendTextMessage(this.to, this.ctx, c);
    }
  }

  async abort(errText) {
    clearInterval(this.timer);
    while (this.sending) await sleep(100);
    try {
      await ilink.sendTextMessage(this.to, this.ctx, errText, { clientId: this.clientId, state: 2 });
    } catch {}
  }
}

// ---------- 消息处理 ----------
async function handleMessage(msg) {
  const from = msg.from_user_id || "unknown";
  const contextToken = msg.context_token;
  let text = extractText(msg).trim();
  const voiceText = extractVoiceText(msg);
  if (!text && voiceText) {
    text = voiceText.trim();
    console.log(`  [语音转写] ${text.slice(0, 80)}`);
  }
  const quoted = extractQuotedText(msg);
  const types = (msg.item_list || []).map((i) => MSG_TYPES[i.type] || `?${i.type}`).join("+");

  console.log(`[收到 ${types}] ${from}: ${text.slice(0, 100)}`);
  if (!contextToken) {
    console.log("  [!] 无 context_token，无法回复，跳过");
    return;
  }

  // 白名单：优先 config.allowedUsers；否则首个来消息的用户自动成为 owner 并锁定
  if (config.allowedUsers.length) {
    if (!config.allowedUsers.includes(from)) {
      console.log(`  [拦截] ${from} 不在 allowedUsers 白名单`);
      return;
    }
  } else if (config.autoLockFirstUser) {
    if (!appState.owner) {
      appState.owner = from;
      saveAppState();
      console.log(`  [owner] 已锁定为首个用户: ${from}`);
    } else if (appState.owner !== from) {
      console.log(`  [拦截] ${from} 不是 owner(${appState.owner})`);
      return;
    }
  }

  // 记录最近上下文，供 24h 窗口内的日报伪推送
  appState.lastContext = { userId: from, contextToken, at: Date.now() };
  saveAppState();

  if (!text) {
    await ilink.sendText(from, contextToken, `收到你的${types}消息。目前只处理文字，图片先回电脑上弄。`);
    return;
  }

  if (RESET_WORDS.has(text)) {
    agent.resetSession(from);
    await ilink.sendText(from, contextToken, "好，上下文已清空，开新话题吧。");
    return;
  }

  if (UNDO_WORDS.has(text)) {
    const r = await snapshot.undoLastAgent();
    await ilink.sendText(
      from,
      contextToken,
      r.ok ? `已撤销上一次改动（${r.detail}）。回滚的文件：\n${r.files}` : r.reason
    );
    return;
  }

  await ilink.startTyping(from, contextToken);
  const typingTimer = setInterval(() => ilink.startTyping(from, contextToken), 9000);
  const stopIndicators = async () => {
    clearInterval(typingTimer);
    await ilink.stopTyping(from);
  };

  // 公众号链接 → 桥先预抓正文，Agent 只管按规范写笔记（未配置抓取脚本则当普通消息处理）
  let prompt = quoted ? `（我在微信里引用了这条内容：「${quoted}」）\n\n${text}` : text;
  let isIngest = false;
  const ingestEnabled = config.fetchPython && config.fetchScript;
  const links = ingestEnabled ? findWechatLinks(text) : [];
  if (links.length) {
    await ilink.sendText(from, contextToken, "识别到公众号文章，抓取正文中（约30-60秒）…");
    try {
      const article = await fetchWechatArticle(config, links[0]);
      if (article.ok && (article.content || "").length > 100) {
        const userNote = text.replace(links[0], "").trim();
        prompt = buildIngestPrompt(links[0], article, userNote, config.ingestInstructions);
        isIngest = true;
      } else {
        await stopIndicators();
        await ilink.sendText(from, contextToken, `抓取失败（${article.note || "可能是验证页/已删除/纯图文"}），回电脑上再处理吧。`);
        return;
      }
    } catch (err) {
      await stopIndicators();
      await ilink.sendText(from, contextToken, `抓取出错：${err.message.slice(0, 120)}`);
      return;
    }
  }

  const sender = new StreamSender(from, contextToken);
  try {
    await snapshot.commitAll(`snapshot: before ${text.slice(0, 60).replace(/\n/g, " ")}`);
    const reply = await agent.run(from, prompt, (ev) => sender.onEvent(ev));
    await stopIndicators();
    await sender.finish(reply);

    const committed = await snapshot.commitAll(`agent: ${text.slice(0, 60).replace(/\n/g, " ")}`);
    if (committed) console.log("[snapshot] 已记录本轮改动，微信发「撤销」可回滚");

    if (isIngest && config.updateIndexScript) {
      try {
        await runProcess("python", [config.updateIndexScript], 60_000);
        console.log("[ingest] 库索引已更新");
      } catch (e) {
        console.error("[ingest] 索引更新失败(不影响笔记):", e.message.slice(0, 150));
      }
    }
    console.log(`[回复] ${String(reply).slice(0, 120).replace(/\n/g, " ")}`);
  } catch (err) {
    await stopIndicators();
    console.error("[agent] 出错:", err.message);
    await sender.abort(`出错了：${err.message.slice(0, 150)}\n再发一次试试，连着失败就回电脑看 data/bridge.log。`);
  }
}

// ---------- 日报伪推送：iLink 不能主动发起，但收到消息后 24h 内可回 ----------
function startDailyPush() {
  const cfg = config.dailyPush;
  if (!cfg?.enabled) return;
  setInterval(async () => {
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (hhmm !== cfg.time || appState.lastPushDate === today) return;

      appState.lastPushDate = today; // 先标记，防止同一分钟内重复触发
      saveAppState();

      const lc = appState.lastContext;
      if (!lc || Date.now() - lc.at > 23.5 * 3600 * 1000) {
        console.log("[push] 最近 24h 没收到消息，超出回复窗口，跳过今日推送");
        return;
      }
      console.log("[push] 生成日报摘要…");
      const reply = await agent.run(lc.userId, cfg.prompt);
      for (const c of splitMessage(reply, config.chunkSize)) {
        await ilink.sendTextMessage(lc.userId, lc.contextToken, c);
        await sleep(400);
      }
      console.log("[push] 日报已推送到微信");
    } catch (err) {
      console.error("[push] 推送失败:", err.message.slice(0, 200));
    }
  }, 30_000);
}

// ---------- 启动 ----------
async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  微信 ↔ Obsidian 第二大脑桥 v0.2.0     ║");
  console.log("║  流式回复 · 后悔药 · 链接入库 · 伪推送 ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`库路径: ${config.vaultPath}`);

  // 单实例锁：第二个实例会抢消息游标，必须挡住
  await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      console.error("[✗] 已有一个桥实例在运行（端口锁 " + config.lockPort + "），本进程退出");
      process.exit(1);
    });
    srv.listen(config.lockPort, "127.0.0.1", resolve);
  });

  // 后台模式(开机自启的隐藏窗口)下没法扫码，直接退出留日志
  if (!ilink.loadToken() && !process.stdout.isTTY) {
    console.error("[✗] 无登录态且处于后台模式，无法显示二维码。请在终端手动 npm start 扫码一次。");
    process.exit(1);
  }

  await snapshot.ensure();

  await ilink.login(async (qrUrl) => {
    console.log("\n请用微信扫码授权（本地生成，不经第三方）：\n");
    qrcode.generate(qrUrl, { small: true });
    console.log("\n二维码链接（扫不出时手动打开）:", qrUrl);
  });
  console.log(`[✓] 已连接微信 (bot_id: ${ilink.tokenData.bot_id || "N/A"})`);
  console.log("[i] 长轮询接收消息中…\n");

  startDailyPush();

  try {
    await ilink.pollLoop((msg) => {
      queue = queue.then(() => handleMessage(msg)).catch((e) => console.error(e));
      return queue;
    });
  } catch (err) {
    if (err.code === "SESSION_EXPIRED") {
      rmSync(path.join(dataDir, "bot_token.json"), { force: true });
      console.error("\n[✗] 微信登录态失效，token 已清除。请在终端重新 npm start 扫码。");
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
