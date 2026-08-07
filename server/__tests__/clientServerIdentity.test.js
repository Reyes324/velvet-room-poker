// 客户端的判断逻辑，跑在服务端这套 vitest 里——客户端目前没有单元测试设
// 施（client 只有 eslint + vite build），而这个纯函数的分支比它看起来多，
// 且真实触发条件（服务器进程重启）在测试里很难复现，值得单独测。
import { describe, it, expect } from 'vitest';
import { classifyServerChange } from '../../client/src/utils/serverIdentity.js';

const A = { bootId: 'boot-a', version: 'abc1234' };
const B_SAME_VERSION = { bootId: 'boot-b', version: 'abc1234' };
const B_NEW_VERSION = { bootId: 'boot-b', version: 'def5678' };

describe('classifyServerChange', () => {
  it('首次访问不提示', () => {
    expect(classifyServerChange(null, A, true)).toBeNull();
  });

  it('同一进程重连不提示', () => {
    // 普通网络抖动、切后台回来——房间还在，不该打扰。
    expect(classifyServerChange(A, A, true)).toBeNull();
  });

  it('进程换了但本地没有进行中的会话，不提示', () => {
    // 坐在首页的人什么都没丢。
    expect(classifyServerChange(A, B_NEW_VERSION, false)).toBeNull();
  });

  it('进程换了 + 有会话 + commit 变了 → 新版本', () => {
    expect(classifyServerChange(A, B_NEW_VERSION, true)).toEqual({ kind: 'version' });
  });

  it('进程换了 + 有会话 + commit 没变 → 只是重启', () => {
    // 免费档闲置休眠后的冷启动走这条。这条存在的意义就是不让休眠被谎报成
    // "开发者发布了新版本"——免费档休眠大概率比推送更频繁。
    expect(classifyServerChange(A, B_SAME_VERSION, true)).toEqual({ kind: 'restart' });
  });

  it('存量数据缺 bootId 时当成首次访问，不误报', () => {
    expect(classifyServerChange({ version: 'abc1234' }, B_NEW_VERSION, true)).toBeNull();
  });
});
