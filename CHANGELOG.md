# Changelog

## v0.3.0 (2026-07-13)

- ✨ 图片入库：微信发图 → 桥下载微信 CDN → 必要时 AES-128-ECB 解密 → 存进库 `attachmentsDir` → Agent 用 `![[路径]]` 智能插入到相关笔记
  - 「魔数自纠正」下载：先判是否已是合法图片，否则尝试多种密钥编码(hex/base64)与 padding 解密，再验字节头；原图失败自动回退缩略图
  - 密钥只按长度记日志，不落明文
- 🔧 非文字消息提示更新为「文字和图片都能处理」

## v0.2.0 (2026-07-11)

- ✨ 流式回复：Agent 边想边回（iLink `message_state` GENERATING→FINISH，同 client_id 原地更新），失败自动降级整段发送
- ✨ 工具过程可视化：Agent 干活时微信里显示「⏳ 查资料 / 写笔记…」
- ✨ 后悔药：外置 git 快照（库目录零污染），微信发「撤销」回滚上一轮 Agent 改动，只回滚 `agent:` 提交
- ✨ 公众号链接自动入库：playwright 预抓正文 → Agent 按库规范写来源笔记 → 可选跑索引脚本
- ✨ 日报伪推送：利用 24h 被动回复窗口，每天定时用最近会话推送摘要
- ✨ 白名单：`autoLockFirstUser` 首个用户自动锁定为 owner
- ✨ 常驻化：开机自启（隐藏窗口）、单实例端口锁、文件日志 `data/bridge.log`
- 🐛 大陆网络下 claude 子进程 403：自动注入本地代理（`config.proxy`）

## v0.1.0 (2026-07-11)

- 🎉 首个可用版本：iLink 扫码登录（token 持久化）、35s 长轮询收消息、typing 指示器
- 🤖 Claude Code headless 桥接：cwd=库根、per-user `--resume` 会话隔离、persona 注入
- 🔒 写入红线：工具权限层 deny 敏感目录；回复按段落分片适配微信
