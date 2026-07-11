/**
 * 后悔药：Obsidian 库的 git 快照。
 * git 仓库放在桥的 data/vault.git（外置 GIT_DIR），库目录里不出现 .git，
 * 不影响 Remotely Save 的 WebDAV 同步。
 * 每轮 Agent 前后各提交一次；微信发「撤销」只回滚最近一次 agent: 提交，绝不误伤用户自己的改动。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class VaultSnapshot {
  constructor(vaultPath, gitDir) {
    this.vaultPath = vaultPath;
    this.gitDir = gitDir;
    this.enabled = false;
  }

  async #git(...args) {
    const { stdout } = await execFileP(
      "git",
      ["-c", "user.name=obsidian-bridge", "-c", "user.email=bridge@local", "-c", "core.quotepath=false", ...args],
      {
        cwd: this.vaultPath,
        env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.vaultPath },
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    return String(stdout).trim();
  }

  /** 初始化外置仓库并打启动基线。git 不可用时优雅降级（不影响主功能）。 */
  async ensure() {
    try {
      if (!existsSync(this.gitDir)) {
        mkdirSync(path.dirname(this.gitDir), { recursive: true });
        await this.#git("init");
      }
      await this.#git("rev-parse", "--git-dir");
      // .obsidian 工作区文件天天变，不进快照
      writeFileSync(path.join(this.gitDir, "info", "exclude"), ".obsidian/\n.trash/\n.git\n", "utf-8");
      this.enabled = true;
      const did = await this.commitAll("snapshot: bridge 启动基线");
      console.log(did ? "[snapshot] 启动基线已提交" : "[snapshot] 库无变化，快照就绪");
    } catch (err) {
      console.error("[snapshot] git 快照不可用(主功能不受影响):", err.message.slice(0, 200));
      this.enabled = false;
    }
  }

  /** 有变更才提交。返回是否真的提交了。 */
  async commitAll(message) {
    if (!this.enabled) return false;
    try {
      await this.#git("add", "-A");
      try {
        await this.#git("diff", "--cached", "--quiet"); // exit 0 = 无变更
        return false;
      } catch {
        await this.#git("commit", "-m", message, "--no-verify");
        return true;
      }
    } catch (err) {
      console.error("[snapshot] 提交失败:", err.message.slice(0, 200));
      return false;
    }
  }

  /** 撤销最近一次 Agent 改动。只在 HEAD 是 agent: 提交时执行，防止误伤。 */
  async undoLastAgent() {
    if (!this.enabled) return { ok: false, reason: "快照功能未启用，没法撤销" };
    try {
      const subject = await this.#git("log", "-1", "--format=%s");
      if (!subject.startsWith("agent:")) {
        return { ok: false, reason: "最近一次库改动不是我做的，没什么可撤销的" };
      }
      await this.#git("rev-parse", "HEAD~1");
      const files = await this.#git("show", "--stat", "--format=", "HEAD");
      await this.#git("reset", "--hard", "HEAD~1");
      return {
        ok: true,
        detail: subject.slice(6).trim(),
        files: files.split("\n").filter(Boolean).slice(0, 8).join("\n"),
      };
    } catch (err) {
      return { ok: false, reason: "撤销失败: " + err.message.slice(0, 150) };
    }
  }
}
