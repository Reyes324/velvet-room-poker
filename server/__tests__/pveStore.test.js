import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPveStore, MAX_HAND_HISTORY } = require('../pveStore');

// Each test gets its own throwaway file under the OS temp dir — never
// touches the real server/data/pveProfiles.json.
function tempFile() {
  return path.join(os.tmpdir(), `pveStore.test.${Date.now()}.${Math.random().toString(36).slice(2)}.json`);
}

let cleanup = [];
afterEach(() => {
  for (const f of cleanup) { try { fs.unlinkSync(f); } catch {} }
  cleanup = [];
});

describe('pveStore — loadProfile/saveProfile', () => {
  it('从未存过的 pveId 加载应返回 null（调用方据此回退到默认初始值）', () => {
    const file = tempFile(); cleanup.push(file);
    const store = createPveStore(file);
    expect(store.loadProfile('nobody')).toBeNull();
  });

  it('保存后能原样读回同一个 pveId 的 oppStats/handHistory', () => {
    const file = tempFile(); cleanup.push(file);
    const store = createPveStore(file);
    const oppStats = { totalActions: 12, raises: 4, raiseFacedCount: 3, foldsFacingRaise: 1 };
    const handHistory = [{ handNumber: 1 }, { handNumber: 2 }];
    store.saveProfile('alice-device', { oppStats, handHistory });
    expect(store.loadProfile('alice-device')).toEqual({ oppStats, handHistory });
  });

  it('不同 pveId 的画像互不覆盖，各自独立存取', () => {
    const file = tempFile(); cleanup.push(file);
    const store = createPveStore(file);
    store.saveProfile('a', { oppStats: { totalActions: 1, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 }, handHistory: [] });
    store.saveProfile('b', { oppStats: { totalActions: 2, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 }, handHistory: [] });
    expect(store.loadProfile('a').oppStats.totalActions).toBe(1);
    expect(store.loadProfile('b').oppStats.totalActions).toBe(2);
  });

  it('saveProfile 只在磁盘上保留最近 MAX_HAND_HISTORY 手，超出的旧记录不落盘', () => {
    const file = tempFile(); cleanup.push(file);
    const store = createPveStore(file);
    const handHistory = Array.from({ length: MAX_HAND_HISTORY + 50 }, (_, i) => ({ handNumber: i }));
    store.saveProfile('me', { oppStats: { totalActions: 0, raises: 0, raiseFacedCount: 0, foldsFacingRaise: 0 }, handHistory });
    const loaded = store.loadProfile('me');
    expect(loaded.handHistory.length).toBe(MAX_HAND_HISTORY);
    expect(loaded.handHistory[0].handNumber).toBe(50); // oldest 50 dropped
  });

  it('目标目录不存在时，saveProfile 应自动创建目录', () => {
    const dir = path.join(os.tmpdir(), `pveStore-test-dir-${Date.now()}`);
    const file = path.join(dir, 'nested', 'profiles.json');
    cleanup.push(file);
    const store = createPveStore(file);
    expect(() => store.saveProfile('me', { oppStats: {}, handHistory: [] })).not.toThrow();
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件内容损坏（非法 JSON）时 loadProfile 应回退到 null，而不是抛异常', () => {
    const file = tempFile(); cleanup.push(file);
    fs.writeFileSync(file, '{not valid json');
    const store = createPveStore(file);
    expect(store.loadProfile('me')).toBeNull();
  });
});
