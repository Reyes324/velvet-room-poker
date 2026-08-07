// 判断"我存着的那个牌局还在不在"，以及如果没了，该怎么跟玩家说。
//
// 服务器每次连接都会发 server:hello（见 server/serverIdentity.js）带上
// bootId + version。bootId 每次进程启动都变，所以"存的 bootId ≠ 收到的
// bootId" ⇔ 服务器进程换过了 ⇔ 内存里的房间/PVE 会话必然已经没了。
//
// 拆成纯函数是为了能独立测——判断分支比它看起来多，而触发条件（服务器重
// 启）在测试里很难真的复现。

export const IDENTITY_KEY = 'vr_serverIdentity';

/**
 * @param {{bootId: string, version: string}|null} stored   上次记下的服务器身份
 * @param {{bootId: string, version: string}} incoming      本次 server:hello 带来的
 * @param {boolean} hasActiveSession                        本地是否有进行中的房间/PVE
 * @returns {null | {kind: 'version'|'restart'}}            null = 什么都不用做
 */
export function classifyServerChange(stored, incoming, hasActiveSession) {
  // 首次访问，没有可比对的基准——记下来就行，没什么可告诉玩家的。
  if (!stored?.bootId) return null;

  // 同一个进程：普通重连、网络抖动、切后台回来。房间还在，别打扰。
  if (stored.bootId === incoming.bootId) return null;

  // 进程确实换过了，但这个人本来就没有在玩——他什么都没丢，不该弹窗。
  if (!hasActiveSession) return null;

  // commit 变了才是真的"发布了新版本"；否则只是重启（免费档休眠冷启动、
  // 实例迁移、崩溃）。两者对玩家的意义不同，文案也不同。
  return { kind: stored.version !== incoming.version ? 'version' : 'restart' };
}

export function readStoredIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // 手改坏的/残缺的值 —— 当成首次访问，别让它把连接流程卡死
  }
}

export function writeStoredIdentity(identity) {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // localStorage 写不进去（隐私模式/配额满）——下次连接会当成首次访问，
    // 顶多是少弹一次提示，不值得为此中断任何事情。
  }
}

// 进行中的会话标记，跟 App.jsx / HomePage.jsx 里写入的是同一批 key。
export const SESSION_KEYS = ['vr_roomCode', 'vr_pveActive', 'vr_pveLastActive', 'vr_pveSeatCount'];

export function hasActiveSession() {
  return Boolean(localStorage.getItem('vr_roomCode') || localStorage.getItem('vr_pveActive'));
}

// 牌局已经不存在了，本地这些标记全是过期的——留着只会让下次进站又去
// rejoin 一个不存在的房间，正是这次要堵掉的那条死路。
export function clearSessionMarkers() {
  for (const k of SESSION_KEYS) localStorage.removeItem(k);
}
