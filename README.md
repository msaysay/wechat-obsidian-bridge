# wechat-obsidian-bridge

> 📱 把 Obsidian 变成你微信里的随身第二大脑。
>
> 基于**微信官方 iLink Bot 协议**（2026 年 3 月腾讯正式开放的个人号 Bot API）+ 你本机已登录的 **Claude Code**。不依赖 OpenClaw，不依赖任何第三方框架，核心就几个文件。
>
> Turn WeChat into a mobile gateway to your local Obsidian vault — powered by the official WeChat iLink bot protocol and Claude Code. No OpenClaw required.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![Protocol](https://img.shields.io/badge/protocol-WeChat%20iLink%20(official)-07C160)

在地铁上、饭桌上、半夜床上——掏出手机给微信发条消息，你电脑上的 Agent 就会读你的库、写你的笔记、回答你记过的一切。**数据全程在你自己机器上。**

```
你:  记一下：给老张寄两瓶酒，下周三之前
Bot: ⏳ 写笔记 2026-07-11.md…
Bot: 已记到今天的 Journal：给老张寄两瓶酒（下周三前）。

你:  我之前研究竞品定价时记过什么结论？
Bot: ⏳ 搜内容 定价…
Bot: 你在 6 月的复盘里记过两条：1. 对手中端款锚定 299 …

你:  https://mp.weixin.qq.com/s/xxxx
Bot: 识别到公众号文章，抓取正文中（约30-60秒）…
Bot: 已存入 03_Wiki/articles/。一句话速读：… 最有价值的一条：…

你:  撤销
Bot: 已撤销上一次改动（记一下：给老张寄两瓶酒…）。回滚的文件：…
```

## ✨ 特性

| | 能力 | 说明 |
|---|---|---|
| 🟢 | **官方协议** | 走微信官方 `ilinkai.weixin.qq.com`（iLink / ClawBot），扫码授权，不是 iPad 协议那类封号路线 |
| 🧠 | **真 Agent，不是关键词机器人** | 内核是本机 Claude Code：自己判断"这是要记下来还是要查库"，遵守你库里的 CLAUDE.md/AGENTS.md 规范 |
| ⚡ | **流式回复** | Agent 边想边回，消息在微信里实时生长（iLink `GENERATING→FINISH` 态），干活时显示「⏳ 查资料 / 写笔记…」 |
| 🩹 | **后悔药** | 每轮改动自动 git 快照（仓库外置，**你的库里不出现 .git**，云同步无感知）。发「撤销」一键回滚，且只回滚 Agent 的提交、绝不误伤你手动的修改 |
| 🔒 | **敢放手的权限设计** | 工具白名单只给读写笔记（无 Bash/联网）；敏感目录在权限层硬 deny，不是靠嘱咐 |
| 🖼 | **图片入库** | 微信发图 → 桥下载并(按需 AES-128-ECB)解密 → 存进库附件夹 → Agent 用 `![[路径]]` 智能插入到相关笔记 |
| 📰 | **公众号链接自动入库** | 甩个链接进去 → playwright 绕开"环境异常"抓正文 → 按你库的规范写成来源笔记 → 回你摘要（可选功能） |
| 📮 | **日报伪推送** | iLink 不允许 Bot 主动发起，但收到消息后 24h 内可回——只要你每天用它，到点就能收到你库里的日报摘要 |
| 👤 | **会话隔离 + 白名单** | 微信会话与桌面端会话互不污染；首个扫码后发消息的人自动锁定为 owner，其他人一律忽略 |
| 🔁 | **常驻** | token 持久化断线免重扫、单实例锁、开机自启（Windows）、文件日志 |

## 🚀 快速开始

**前提**
1. Node.js ≥ 18
2. [Claude Code](https://claude.com/claude-code) 已安装且已登录（`claude` 命令能用即可，订阅版/API 版都行）
3. 一个 Obsidian 库（其实任何 Markdown 目录都行）
4. 中国大陆网络需要一个本地 HTTP 代理（Clash 等），让 claude 子进程能连上 Anthropic

**安装**

```bash
git clone https://github.com/<you>/wechat-obsidian-bridge.git
cd wechat-obsidian-bridge
npm install

# 配置：改成你自己的库路径、claude 路径、代理端口
cp config.example.json config.json
cp persona.example.md persona.md   # 微信端人设，按喜好改

npm start   # 弹出二维码 → 手机微信扫码授权 → 完事
```

之后直接在微信里给这个 Bot 发消息。**暗号**：

| 你发 | 效果 |
|---|---|
| 随便说话 / 记一下：… | Agent 自己判断：记笔记 or 查库回答 or 闲聊 |
| 一张图片（可带文字） | 下载存进库附件夹，Agent 插入到相关笔记 |
| 公众号文章链接 | 自动抓正文入库（需配置，见下） |
| `撤销` | 回滚 Agent 上一轮对库的改动 |
| `新话题` | 清空对话上下文 |

`npm run logout` 删除登录态重新扫码。

## ⚙️ 配置

所有配置在 `config.json`（模板 [config.example.json](config.example.json) 内含逐项注释）。关键项：

| 键 | 说明 |
|---|---|
| `vaultPath` | 你的库根目录，Agent 的工作目录 |
| `claudeExe` | claude 可执行文件绝对路径（npm 装的在 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`） |
| `proxy` | claude 子进程走的本地代理。**大陆必填**（直连 Anthropic 会 403 Request not allowed）；海外留空。微信链路不走代理 |
| `allowedTools` / `disallowedTools` | Agent 权限。默认只能读写笔记；把你库的模板/脚本目录加进 deny |
| `streaming` / `toolStatus` | 流式回复与工具状态，**默认关**（iLink 的 GENERATING 更新在部分网络下会残留中间气泡）。关掉后每次是一个干净的最终回复，靠"对方正在输入…"表示在干活 |
| `fetchPython` / `fetchScript` | 链接入库功能（可选）：装好 playwright 的 python + 本仓库 `scripts/fetch_wechat.py` |
| `ingestInstructions` | 入库时给 Agent 的指令，按你库的笔记规范写 |
| `dailyPush` | 日报伪推送的时间与提示词 |

微信端说话风格、意图判断规则、写入红线，都在 `persona.md` 里用自然语言改。

**开机自启（Windows）**：在 `shell:startup` 文件夹里创建一个指向 `start-hidden.vbs` 的快捷方式（隐藏窗口运行，日志见 `data/bridge.log`）。macOS/Linux 可用 launchd/systemd 跑 `node index.mjs`。

## 🏗 工作原理

```
手机微信
  │  iLink 官方协议（HTTPS 长轮询 35s，纯 HTTP/JSON）
  ▼
index.mjs 主循环 + StreamSender（流式态收口/降级）
  ├─ src/ilink.mjs     扫码登录 · 收发消息 · typing · GENERATING/FINISH
  ├─ src/snapshot.mjs  外置 git 快照（GIT_DIR 在 data/，库零污染）+「撤销」
  ├─ src/ingest.mjs    公众号链接检测 + playwright 预抓正文
  ▼
src/agent.mjs → spawn claude -p --output-format stream-json
  │   cwd = 你的库根 · persona 注入 system prompt
  │   每个微信用户独立 session（--resume），与桌面端会话隔离
  ▼
Obsidian 库（工具权限层限定可写目录）
```

设计取舍：
- **抓取等确定性步骤放桥里做，Agent 只做判断和写作**——省 token、行为可控。
- **消息串行队列**——同一时刻只有一轮 Agent 在跑，避免并发写库。
- **快照 git 仓库外置**（`GIT_DIR=data/vault.git`）——库目录不出现 `.git`，Remotely Save 等云同步完全无感知。

## ❓ FAQ

**会封号吗？**
走的是腾讯 2026-03 正式开放的官方 Bot 协议（ClawBot / iLink），扫码授权、官方域名，与逆向 iPad 协议有本质区别。但腾讯条款保留限流/终止权，重度依赖请知悉。

**为什么 Agent 回复 `403 Request not allowed`？**
你在大陆网络直连 Anthropic 被区域拦截了。在 `config.json` 里把 `proxy` 指向本地代理（如 `http://127.0.0.1:7890`）并保持代理软件常开。

**Bot 能主动给我发消息吗？**
协议限制：只能在收到你消息后的 24h 窗口内回复。日报伪推送就是利用这个窗口实现的"每天用 = 每天能收到推送"。

**支持群聊 / 图片 / 语音吗？**
群聊：协议侧未开放。图片：✅ 已支持（v0.3，下载+按需 AES-128-ECB 解密+落库+插入笔记）。语音：若微信带了官方转写字段会直接当文字处理，不做本地 ASR——实测手机输入法的语音转文字比 60 秒语音条好用得多。文件/视频：暂未处理。

**跟 OpenClaw 官方微信插件什么关系？**
无依赖。本项目直接实现 iLink 协议（请求格式对齐官方 `@tencent-weixin/openclaw-weixin`），比整套 OpenClaw 轻两个数量级，且 Agent 内核是为"操作你的笔记库"专门调教的 Claude Code。

**Claude 之外的模型？**
Agent 层就是 spawn 一个 CLI 子进程，理论上任何兼容 headless `-p --output-format stream-json` 的 Agent CLI 都能换（欢迎 PR）。

## ⚠️ 免责声明

- 本项目与腾讯、Anthropic 均无关联。iLink 协议字段来自公开拆解，腾讯升级协议可能导致失效。
- Agent 拥有对你配置目录的写权限。请务必配置 `disallowedTools` 红线、保持快照开启，重要库先备份。
- 使用产生的一切后果自负，遵守微信软件许可及服务协议。

## 🙏 致谢

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — 官方通道插件，协议对齐的参照
- [hao-ji-xing/openclaw-weixin 协议拆解](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md) 与 [x1ah/wechat-ilink-demo](https://github.com/x1ah/wechat-ilink-demo) — 证明了 iLink 可独立调用
- 公众号「老码小张」的 Obsidian-CC 系列文章 — "第二大脑要跟着人走"的产品洞察
- [Claude Code](https://claude.com/claude-code) — Agent 内核

## 📄 License

[MIT](LICENSE)
