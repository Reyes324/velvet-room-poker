// 服务器进程的身份标识，用来让客户端分辨"我的牌局为什么没了"。
//
// Render 免费档全内存、无持久化磁盘：进程一重启，所有进行中的房间和 PVE
// 会话就没了（见 docs/superpowers/specs/2026-08-02-user-feedback-system-
// design.md 的"关键约束"）。而进程重启有两种原因，对玩家的意义完全不同：
//
//   - 开发者推送代码 → Render 重新部署 → commit 变了
//   - 免费档闲置休眠后冷启动 / 实例迁移 / 崩溃 → commit 没变
//
// 免费档休眠大概率比推送更频繁，所以不能一律说"发布了新版本"——那是在骗
// 玩家。两个值分开报，让客户端自己判断该说哪句话。

const crypto = require('crypto');

// 每次进程启动都不同。模块只会被 require 一次，所以同一进程内恒定——这
// 正是"客户端存的值和现在不一样 ⇒ 进程换过了"这个判断成立的前提。
const bootId = crypto.randomUUID();

// Render 在构建时注入 RENDER_GIT_COMMIT。本地开发没有这个变量，回退成
// 'dev'：本地重启时 version 恒为 'dev' 不变，于是判定成"服务器重启了"而
// 不是"发布了新版本"，正是本地想要的语义。
const version = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'dev';

function getServerIdentity() {
  return { bootId, version };
}

module.exports = { getServerIdentity };
