import { describe, it, expect } from 'vitest';
import { getServerIdentity } from '../serverIdentity.js';

describe('serverIdentity', () => {
  it('同一进程内 bootId 恒定', () => {
    // 客户端"存的 bootId ≠ 收到的 bootId ⇒ 进程换过了"这个判断，完全建立
    // 在这条性质上。如果 bootId 每次调用都变，每个玩家每次重连都会被告知
    // 牌局重置了——比现在的静默还糟。
    expect(getServerIdentity().bootId).toBe(getServerIdentity().bootId);
  });

  it('报出 bootId 和 version 两个字段', () => {
    const identity = getServerIdentity();
    expect(typeof identity.bootId).toBe('string');
    expect(identity.bootId.length).toBeGreaterThan(0);
    expect(typeof identity.version).toBe('string');
  });

  it('本地没有 RENDER_GIT_COMMIT 时 version 回退成 dev', () => {
    // 本地 version 恒为 'dev'，于是本地重启被判成"服务器重启了"而不是
    // "发布了新版本"——正是本地想要的语义。
    expect(getServerIdentity().version).toBe('dev');
  });
});
