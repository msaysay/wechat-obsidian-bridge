/**
 * 后端：OpenAI 兼容 Chat API + 内置 Agent 工具循环。
 * 让任何"裸大模型"（Kimi/DeepSeek/智谱GLM/OpenAI/本地Ollama…）也能真正操作 Obsidian 库。
 *
 * 裸对话模型不会读写文件——所以这里自己实现一个最小 Agent：
 *   给模型定义 库文件工具(读/写/追加/改/列目录/搜索) → 模型决定调哪个 →
 *   桥在库里安全执行(路径不越界、红线目录禁写) → 结果回给模型 → 循环到出最终回复。
 *
 * 兼容任何暴露 /chat/completions 且支持 function-calling 的服务。
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  readdirSync, statSync,
} from "node:fs";
import path from "node:path";

// ---------- 库文件工具（在 vaultPath 内安全执行） ----------

function makeVaultTools(vaultPath, protectedDirs, onEvent) {
  const root = path.resolve(vaultPath);

  const resolve = (rel) => {
    const abs = path.resolve(root, rel || ".");
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`路径越出库范围: ${rel}`);
    }
    return abs;
  };
  const relOf = (abs) => path.relative(root, abs).replace(/\\/g, "/") || ".";
  const assertWritable = (rel) => {
    const norm = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
    for (const p of protectedDirs || []) {
      const pp = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
      if (norm === pp || norm.startsWith(pp + "/")) {
        throw new Error(`「${pp}」是只读红线目录，不能写`);
      }
    }
  };

  return {
    read_file({ path: rel }) {
      const abs = resolve(rel);
      if (!existsSync(abs) || statSync(abs).isDirectory()) throw new Error("文件不存在: " + rel);
      const txt = readFileSync(abs, "utf-8");
      return txt.length > 40000 ? txt.slice(0, 40000) + "\n…(已截断)" : txt;
    },
    write_file({ path: rel, content }) {
      assertWritable(rel);
      const abs = resolve(rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content ?? "", "utf-8");
      return `已写入 ${relOf(abs)}（${Buffer.byteLength(content ?? "")} 字节）`;
    },
    append_file({ path: rel, content }) {
      assertWritable(rel);
      const abs = resolve(rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      appendFileSync(abs, (content ?? "") + "\n", "utf-8");
      return `已追加到 ${relOf(abs)}`;
    },
    edit_file({ path: rel, old_string, new_string }) {
      assertWritable(rel);
      const abs = resolve(rel);
      if (!existsSync(abs)) throw new Error("文件不存在: " + rel);
      const txt = readFileSync(abs, "utf-8");
      const n = txt.split(old_string).length - 1;
      if (n === 0) throw new Error("没找到要替换的原文");
      if (n > 1) throw new Error(`原文出现 ${n} 次，不唯一，请给更长的上下文`);
      writeFileSync(abs, txt.replace(old_string, new_string ?? ""), "utf-8");
      return `已修改 ${relOf(abs)}`;
    },
    list_dir({ path: rel } = {}) {
      const abs = resolve(rel || ".");
      if (!existsSync(abs)) throw new Error("目录不存在: " + rel);
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      return entries.join("\n") || "(空目录)";
    },
    search_notes({ query, max = 20 }) {
      const hits = [];
      const walk = (dir) => {
        if (hits.length >= max) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (/\.(md|txt|markdown)$/i.test(e.name)) {
            let txt;
            try { txt = readFileSync(abs, "utf-8"); } catch { continue; }
            const lines = txt.split("\n");
            for (let i = 0; i < lines.length && hits.length < max; i++) {
              if (lines[i].toLowerCase().includes(String(query).toLowerCase())) {
                hits.push(`${relOf(abs)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              }
            }
          }
        }
      };
      try { walk(root); } catch {}
      return hits.length ? hits.join("\n") : "(没搜到)";
    },
  };
}

// function-calling 工具定义（OpenAI schema）
const TOOL_SCHEMAS = [
  { name: "read_file", desc: "读取库里某个文件的内容", props: { path: { type: "string", description: "相对库根的路径" } }, required: ["path"] },
  { name: "write_file", desc: "新建或覆盖写入一个文件", props: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  { name: "append_file", desc: "在文件末尾追加内容（不存在则新建）", props: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  { name: "edit_file", desc: "把文件里某段原文替换成新内容（原文需唯一）", props: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] },
  { name: "list_dir", desc: "列出某个目录下的文件和子目录", props: { path: { type: "string", description: "相对库根的目录，留空为库根" } }, required: [] },
  { name: "search_notes", desc: "在库里全文搜索关键词，返回 文件:行号:内容", props: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
];

function toolsPayload() {
  return TOOL_SCHEMAS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.desc,
      parameters: { type: "object", properties: t.props, required: t.required },
    },
  }));
}

/** 工具名 → 微信状态提示用的人话 */
const LABELS = {
  read_file: "查资料", write_file: "写笔记", append_file: "记一笔",
  edit_file: "改笔记", list_dir: "翻目录", search_notes: "搜内容",
};

export class OpenAIBackend {
  constructor(config, persona, dataDir) {
    this.config = config;
    this.o = config.openai || {};
    this.persona = persona;
    this.vaultPath = config.vaultPath;
    this.sessionsFile = path.join(dataDir, "openai_sessions.json");
    try { this.sessions = JSON.parse(readFileSync(this.sessionsFile, "utf-8")); }
    catch { this.sessions = {}; }
    this.dispatcher = undefined; // 懒加载代理
    this.protectedDirs = this.o.protectedDirs || [];
  }

  #saveSessions() {
    // 每用户只留最近 40 条，且保证开头是完整的 user 轮次
    for (const k of Object.keys(this.sessions)) {
      let h = this.sessions[k].slice(-40);
      while (h.length && h[0].role !== "user") h = h.slice(1);
      this.sessions[k] = h;
    }
    writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  resetSession(userId) {
    delete this.sessions[userId];
    this.#saveSessions();
  }

  #systemPrompt() {
    let structure = "";
    try {
      const top = readdirSync(this.vaultPath, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      structure = "库根目录结构：\n" + top.join("  ");
    } catch {}
    return [
      this.persona,
      "",
      "【你的工作方式】你通过工具操作用户的 Obsidian 笔记库（本地文件夹）。所有路径都相对库根。",
      "先想清楚要干什么，再调工具：记东西用 append_file/write_file；查东西先 search_notes/list_dir 再 read_file；改用 edit_file。",
      "做完之后，用一句纯文本口语告诉用户你干了什么、存到哪个文件了。不要把工具调用过程念给用户听。",
      this.protectedDirs.length ? `只读红线目录（禁止写入）：${this.protectedDirs.join("、")}` : "",
      structure,
    ].filter(Boolean).join("\n");
  }

  async #dispatcherFor() {
    if (this.dispatcher !== undefined) return this.dispatcher;
    this.dispatcher = null;
    if (this.o.proxy) {
      try {
        const { ProxyAgent } = await import("undici");
        this.dispatcher = new ProxyAgent(this.o.proxy);
      } catch {
        console.warn("[openai] 配了 proxy 但缺 undici（npm i undici）。国产模型多为直连、通常不用代理。");
      }
    }
    return this.dispatcher;
  }

  async #chat(messages) {
    const base = (this.o.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const dispatcher = await this.#dispatcherFor();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.agentTimeoutMs || 120000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.o.apiKey || ""}`,
        },
        body: JSON.stringify({
          model: this.o.model,
          messages,
          tools: toolsPayload(),
          tool_choice: "auto",
          temperature: this.o.temperature ?? 0.3,
          stream: false,
        }),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async run(userId, prompt, onEvent) {
    if (!this.o.apiKey || !this.o.model) {
      throw new Error("openai 后端缺少 apiKey 或 model，检查 config.json 的 openai 段");
    }
    const tools = makeVaultTools(this.vaultPath, this.protectedDirs, onEvent);
    const history = this.sessions[userId] || [];
    const messages = [{ role: "system", content: this.#systemPrompt() }, ...history, { role: "user", content: prompt }];

    const maxIters = this.o.maxIterations || 12;
    let finalText = "";
    for (let i = 0; i < maxIters; i++) {
      const data = await this.#chat(messages);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("模型没有返回 message");
      messages.push(msg);

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          try { onEvent?.({ kind: "tool", name, detail: args.path || args.query || "" }); } catch {}
          let result;
          try {
            result = tools[name] ? String(tools[name](args)) : `未知工具: ${name}`;
          } catch (e) {
            result = "工具出错: " + e.message;
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 8000) });
        }
        continue; // 把工具结果喂回模型，继续
      }

      finalText = (msg.content || "").trim();
      break;
    }
    if (!finalText) finalText = "（我处理了一轮但没给出明确回复，可能任务太复杂，回电脑上看看）";

    // 存会话（去掉 system，只留对话与工具轮次）
    this.sessions[userId] = messages.slice(1);
    this.#saveSessions();
    try { onEvent?.({ kind: "text", text: finalText }); } catch {}
    return finalText;
  }
}

export { LABELS as OPENAI_TOOL_LABELS };
