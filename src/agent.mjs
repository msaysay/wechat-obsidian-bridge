/**
 * Agent 桥：可插拔后端分发器。
 * config.agentBackend 选择：
 *   "claude-code" (默认) → 本机 Claude Code CLI，带工具的真 Agent
 *   "openai"            → 任何 OpenAI 兼容 Chat API(Kimi/DeepSeek/GLM/OpenAI/Ollama…)，
 *                          由桥内置的 Agent 工具循环操作库
 * 两种后端对上层暴露同样的接口：run(userId, prompt, onEvent) / resetSession(userId)。
 */
import { ClaudeCodeBackend } from "./backends/claudeCode.mjs";
import { OpenAIBackend } from "./backends/openai.mjs";

/** 工具名 → 微信里显示的人话（两种后端的工具名都覆盖） */
export const TOOL_LABELS = {
  // Claude Code
  Read: "查资料", Glob: "找文件", Grep: "搜内容", Write: "写笔记",
  Edit: "改笔记", Bash: "跑脚本", TodoWrite: "列计划", WebFetch: "看网页", WebSearch: "搜网页",
  // OpenAI 后端
  read_file: "查资料", write_file: "写笔记", append_file: "记一笔",
  edit_file: "改笔记", list_dir: "翻目录", search_notes: "搜内容",
};

export class AgentBridge {
  constructor(config, persona, dataDir) {
    const kind = config.agentBackend || "claude-code";
    if (kind === "claude-code") {
      this.backend = new ClaudeCodeBackend(config, persona, dataDir);
    } else if (kind === "openai") {
      this.backend = new OpenAIBackend(config, persona, dataDir);
    } else {
      throw new Error(`未知 agentBackend: ${kind}（可选 "claude-code" 或 "openai"）`);
    }
    console.log(`[agent] 后端: ${kind}` + (kind === "openai" ? ` (${config.openai?.model || "未配model"})` : ""));
  }

  run(userId, prompt, onEvent) {
    return this.backend.run(userId, prompt, onEvent);
  }

  resetSession(userId) {
    return this.backend.resetSession(userId);
  }
}

/** 微信单条消息别太长：按段落边界切片 */
export function splitMessage(text, size = 1800) {
  const chunks = [];
  let rest = String(text).trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.4) cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.4) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
