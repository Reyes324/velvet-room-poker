const fs = require('fs');
const path = require('path');

// PVE 对手画像/牌局历史的跨会话持久化（用户反馈"AI 应该记住我怎么打"，
// 2026-07-30）。之前 PveSession.oppStats/handHistory 只活在内存里，进程重
// 启或换个 session 对象就清零——剥削效果没法跨局累积。存储层刻意做成最简
// 单文件 JSON（不是 sqlite）：数据量本来就小（单玩家画像几百字节 + 最多
// 200 手历史），量级远够不上上数据库的必要性；`createPveStore(filePath)`
// 是工厂函数而不是单例模块状态，方便测试注入临时文件路径，不用碰真实数据
// 文件。

const MAX_HAND_HISTORY = 200; // 只保留最近 N 手的详细历史，避免文件随时间线性增长；聚合的 oppStats 本身体积恒定，不受此限制

function createPveStore(filePath) {
  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {}; // 文件不存在/损坏都视为"还没有任何画像"，不是一个需要抛出的错误
    }
  }

  function writeAll(all) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(all));
  }

  return {
    // 返回 null 表示这个 pveId 从没存过（新对手，调用方应回退到默认初始值）。
    loadProfile(pveId) {
      return readAll()[pveId] ?? null;
    },

    saveProfile(pveId, { oppStats, handHistory }) {
      const all = readAll();
      all[pveId] = { oppStats, handHistory: handHistory.slice(-MAX_HAND_HISTORY) };
      writeAll(all);
    },
  };
}

const DEFAULT_FILE = path.join(__dirname, 'data', 'pveProfiles.json');

module.exports = { createPveStore, defaultStore: createPveStore(DEFAULT_FILE), MAX_HAND_HISTORY };
