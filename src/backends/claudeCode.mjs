/**
 * 后端：Claude Code CLI（默认）。
 * spawn 本机 claude.exe，headless -p --output-format stream-json，cwd=库根。
 * 每个微信用户一条持久会话（--resume），与桌面端会话隔离。
 * 这是"带工具的真 Agent"：读写改笔记、搜索都由 Claude Code 内置工具完成。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class ClaudeCodeBackend {
  constructor(config, persona, dataDir) {
    this.config = config;
    this.persona = persona;
    this.sessionsFile = path.join(dataDir, "sessions.json");
    try {
      this.sessions = JSON.parse(readFileSync(this.sessionsFile, "utf-8"));
    } catch {
      this.sessions = {};
    }
  }

  #saveSessions() {
    writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  resetSession(userId) {
    delete this.sessions[userId];
    this.#saveSessions();
  }

  async run(userId, prompt, onEvent) {
    const sessionId = this.sessions[userId];
    try {
      return await this.#invoke(userId, prompt, sessionId, onEvent);
    } catch (err) {
      if (sessionId) {
        console.log("[agent] resume 失败，改用新会话重试:", err.message.slice(0, 200));
        this.resetSession(userId);
        return await this.#invoke(userId, prompt, null, onEvent);
      }
      throw err;
    }
  }

  #invoke(userId, prompt, sessionId, onEvent) {
    const c = this.config;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt", this.persona,
      "--allowedTools", c.allowedTools,
      "--max-turns", String(c.maxTurns),
    ];
    if (c.disallowedTools?.length) {
      args.push("--disallowedTools", c.disallowedTools.join(","));
    }
    if (c.model) args.push("--model", c.model);
    if (sessionId) args.push("--resume", sessionId);

    return new Promise((resolve, reject) => {
      // 大陆网络直连 Anthropic 会被 403 区域拦截，claude 子进程必须走本地代理
      const env = { ...process.env };
      if (c.proxy) {
        env.HTTP_PROXY = c.proxy;
        env.HTTPS_PROXY = c.proxy;
        env.NO_PROXY = "localhost,127.0.0.1,::1,.local";
      }
      const child = spawn(c.claudeExe, args, {
        cwd: c.vaultPath,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let buf = "";
      let stderr = "";
      let resultEvent = null;
      const textParts = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, c.agentTimeoutMs);

      const handleLine = (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "assistant" && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
              try { onEvent?.({ kind: "text", text: block.text }); } catch {}
            } else if (block.type === "tool_use") {
              try {
                onEvent?.({ kind: "tool", name: block.name, detail: summarizeToolInput(block.input) });
              } catch {}
            }
          }
        } else if (ev.type === "result") {
          resultEvent = ev;
        }
      };

      child.stdout.on("data", (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        handleLine(buf);
        if (timedOut) {
          return reject(new Error(`Agent 超时(${Math.round(c.agentTimeoutMs / 1000)}s)被终止`));
        }
        if (resultEvent) {
          if (resultEvent.session_id) {
            this.sessions[userId] = resultEvent.session_id;
            this.#saveSessions();
          }
          if (resultEvent.is_error) {
            return reject(new Error(resultEvent.result || "agent 返回错误"));
          }
          return resolve(resultEvent.result || textParts.join("\n\n") || "(空回复)");
        }
        if (code !== 0) {
          return reject(new Error(`claude 退出码 ${code}: ${(stderr || buf).slice(0, 300)}`));
        }
        resolve(textParts.join("\n\n") || "(空回复)");
      });

      child.stdin.write(prompt, "utf-8");
      child.stdin.end();
    });
  }
}

/** 把工具入参浓缩成一小段可展示的提示（文件名/关键词） */
function summarizeToolInput(input = {}) {
  const raw = input.file_path || input.path || input.pattern || input.query || "";
  if (!raw) return "";
  return String(raw).split(/[\\/]/).slice(-1)[0].slice(0, 40);
}
