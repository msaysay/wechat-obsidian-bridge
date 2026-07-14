/**
 * 公众号链接自动入库：微信里甩一个 mp.weixin.qq.com 链接 →
 * 桥先用 playwright 脚本预抓正文（绕微信反爬）→ 再交给 Agent 按库规范写成来源笔记。
 * 抓取是确定性步骤放在桥里做，Agent 只负责写笔记。
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function findWechatLinks(text) {
  const m = String(text).match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s，。、；！？"'「」『』<>（）()\]]*/g);
  return [...new Set(m || [])];
}

export function runProcess(exe, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("子进程超时"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`退出码${code}: ${(err || out).slice(0, 200)}`));
    });
  });
}

/** 预抓取文章，返回 {ok,title,author,publish,content,note} */
export async function fetchWechatArticle(config, url) {
  const outFile = path.join(os.tmpdir(), `wx_ingest_${crypto.randomUUID()}.json`);
  try {
    await runProcess(config.fetchPython, [config.fetchScript, url, "--out", outFile], 180_000);
    return JSON.parse(readFileSync(outFile, "utf-8"));
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** 默认入库指令；可用 config.ingestInstructions 按自己库的规范覆盖 */
const DEFAULT_INGEST_INSTRUCTIONS = [
  "任务：把这篇文章消化成一篇「来源笔记」存进库里。库内如有 AGENTS.md / CLAUDE.md 之类的规范就严格遵守；没有就存到合适的目录，文件名带发布日期和标题关键词。要求：",
  "1. 关键事实逐条做可信度标注（🟢一手可验证 / 🟡传闻观点 / 🔴软文夸大），软文绝不写成事实",
  "2. 提炼至少 1 条对我有用的「可转化内容」",
  "3. 最后回我，纯文本 120 字内：存哪了 + 一句话速读 + 最有价值的 1 条",
].join("\n");

export function buildIngestPrompt(url, article, userNote, instructions) {
  return [
    "我在微信里发了一篇公众号文章链接，系统已经用 playwright 抓好正文，你不用再抓。",
    `URL: ${url}`,
    `标题: ${article.title}`,
    `公众号: ${article.author}   发布: ${article.publish}`,
    "正文（<<<正文 与 正文>>> 之间）:",
    "<<<正文",
    article.content,
    "正文>>>",
    "",
    instructions || DEFAULT_INGEST_INSTRUCTIONS,
    userNote ? `\n另外我说：${userNote}` : "",
  ].filter(Boolean).join("\n");
}
