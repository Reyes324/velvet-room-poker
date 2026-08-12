// server/__tests__/feedbackReporter.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  createFeedbackIssue, isConfigured,
  listFeedbackIssues, listFeedbackComments, listFeedbackWithComments, addFeedbackComment,
} = require('../feedbackReporter');

function fakeResponse(ok, status, jsonBody) {
  return { ok, status, json: async () => jsonBody };
}

describe('feedbackReporter — isConfigured', () => {
  it('返回 false 当 token 没配置', () => {
    expect(isConfigured({ token: undefined })).toBe(false);
  });
  it('返回 true 当 token 存在', () => {
    expect(isConfigured({ token: 'ghp_fake' })).toBe(true);
  });
});

describe('feedbackReporter — createFeedbackIssue', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('没有 token 时直接抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue({ text: '有问题' }, { fetchImpl, token: undefined, repo }))
      .rejects.toThrow(/FEEDBACK_GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('text 是空字符串（或只有空白）时抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue({ text: '   ' }, { fetchImpl, token, repo }))
      .rejects.toThrow(/反馈内容/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('无图片：只调用一次 Issues API，body 里带文字，没有图片 markdown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(true, 201, { number: 42, html_url: 'https://github.com/x/y/issues/42' })
    );
    const result = await createFeedbackIssue({ text: '结算的时候少算了一个底池' }, { fetchImpl, token, repo });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${repo}/issues`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(opts.body);
    expect(body.labels).toEqual(['feedback']);
    expect(body.body).toContain('结算的时候少算了一个底池');
    expect(body.body).not.toContain('![');
    expect(result).toEqual({ issueNumber: 42, issueUrl: 'https://github.com/x/y/issues/42' });
  });

  it('带图片：先调 Contents API 上传，再调 Issues API，body 里带图片 markdown 用的是返回的 download_url', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(true, 201, {
        content: { download_url: 'https://raw.githubusercontent.com/x/y/main/feedback-attachments/abc.png' },
      }))
      .mockResolvedValueOnce(fakeResponse(true, 201, { number: 43, html_url: 'https://github.com/x/y/issues/43' }));

    const result = await createFeedbackIssue(
      { text: '气泡卡住了', image: { base64: 'ZmFrZQ==', mimeType: 'image/png' } },
      { fetchImpl, token, repo },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [contentsUrl, contentsOpts] = fetchImpl.mock.calls[0];
    expect(contentsUrl).toMatch(new RegExp(`^https://api.github.com/repos/${repo}/contents/feedback-attachments/.+\\.png$`));
    expect(contentsOpts.method).toBe('PUT');
    const contentsBody = JSON.parse(contentsOpts.body);
    expect(contentsBody.content).toBe('ZmFrZQ==');
    // 必须落在 feedback-attachments 分支，不能进 main——否则触发 Render
    // 自动重新部署，清空所有正在进行的牌局内存状态。
    expect(contentsBody.branch).toBe('feedback-attachments');

    const [, issueOpts] = fetchImpl.mock.calls[1];
    const issueBody = JSON.parse(issueOpts.body);
    expect(issueBody.body).toContain('https://raw.githubusercontent.com/x/y/main/feedback-attachments/abc.png');
    expect(result.issueNumber).toBe(43);
  });

  // 用户反馈 #3（2026-08-03）：只能上传一张图不够用
  it('多图：逐张上传后按顺序全部出现在 Issue 正文里', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(true, 201, { content: { download_url: 'https://cdn/1.png' } }))
      .mockResolvedValueOnce(fakeResponse(true, 201, { content: { download_url: 'https://cdn/2.jpg' } }))
      .mockResolvedValueOnce(fakeResponse(true, 201, { content: { download_url: 'https://cdn/3.webp' } }))
      .mockResolvedValueOnce(fakeResponse(true, 201, { number: 44, html_url: 'https://github.com/x/y/issues/44' }));

    await createFeedbackIssue(
      {
        text: '三张图',
        images: [
          { base64: 'YQ==', mimeType: 'image/png' },
          { base64: 'Yg==', mimeType: 'image/jpeg' },
          { base64: 'Yw==', mimeType: 'image/webp' },
        ],
      },
      { fetchImpl, token, repo },
    );

    // 3 次上传 + 1 次建 Issue
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const issueBody = JSON.parse(fetchImpl.mock.calls[3][1].body).body;
    for (const url of ['https://cdn/1.png', 'https://cdn/2.jpg', 'https://cdn/3.webp']) {
      expect(issueBody).toContain(url);
    }
    // 顺序要跟用户选图的顺序一致
    expect(issueBody.indexOf('1.png')).toBeLessThan(issueBody.indexOf('2.jpg'));
    expect(issueBody.indexOf('2.jpg')).toBeLessThan(issueBody.indexOf('3.webp'));
  });

  it('images 为空数组时不上传任何图片（等价于无图）', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(true, 201, { number: 45, html_url: 'https://github.com/x/y/issues/45' }));
    await createFeedbackIssue({ text: '没图', images: [] }, { fetchImpl, token, repo });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('不支持的图片格式直接抛错，不发任何请求', async () => {
    const fetchImpl = vi.fn();
    await expect(createFeedbackIssue(
      { text: '文字', image: { base64: 'ZmFrZQ==', mimeType: 'image/gif' } },
      { fetchImpl, token, repo },
    )).rejects.toThrow(/不支持的图片格式/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GitHub API 返回非 2xx 时抛错，错误信息带状态码', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(false, 422, { message: 'Validation Failed' }));
    await expect(createFeedbackIssue({ text: '文字' }, { fetchImpl, token, repo }))
      .rejects.toThrow(/422/);
  });
});

describe('feedbackReporter — listFeedbackIssues', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('没有 token 时直接抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(listFeedbackIssues({ fetchImpl, token: undefined, repo })).rejects.toThrow(/FEEDBACK_GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('请求带 feedback 标签过滤 + state=all，过滤掉混进来的 PR，字段映射正确', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(true, 200, [
      {
        number: 23, title: '断线问题', body: '正文', state: 'closed',
        labels: [{ name: 'feedback' }, { name: 'accepted' }],
        created_at: '2026-08-11T19:06:50Z', html_url: 'https://github.com/x/y/issues/23',
      },
      { number: 99, title: '一个 PR', pull_request: {}, labels: [], state: 'open', created_at: '2026-08-12T00:00:00Z' },
    ]));
    const result = await listFeedbackIssues({ fetchImpl, token, repo });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toContain(`/repos/${repo}/issues?`);
    expect(url).toContain('labels=feedback');
    expect(url).toContain('state=all');
    expect(opts.headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toHaveLength(1); // PR 被滤掉
    expect(result[0]).toEqual({
      number: 23, title: '断线问题', body: '正文', state: 'closed',
      labels: ['feedback', 'accepted'], createdAt: '2026-08-11T19:06:50Z',
      url: 'https://github.com/x/y/issues/23',
    });
  });

  it('GitHub API 返回非 2xx 时抛错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(false, 500, {}));
    await expect(listFeedbackIssues({ fetchImpl, token, repo })).rejects.toThrow(/500/);
  });
});

describe('feedbackReporter — listFeedbackComments', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('返回精简后的评论字段', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(true, 200, [
      { id: 1, body: '**评估结论：...**', created_at: '2026-08-11T19:06:53Z', user: { login: 'bot' } },
    ]));
    const result = await listFeedbackComments(23, { fetchImpl, token, repo });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.github.com/repos/${repo}/issues/23/comments?per_page=100`);
    expect(result).toEqual([{ id: 1, body: '**评估结论：...**', createdAt: '2026-08-11T19:06:53Z' }]);
  });
});

describe('feedbackReporter — listFeedbackWithComments', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('每条 issue 都带上自己的评论，不同 issue 的评论不串', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(true, 200, [
        { number: 1, title: 'A', body: '', state: 'open', labels: [], created_at: 't1', html_url: 'u1' },
        { number: 2, title: 'B', body: '', state: 'open', labels: [], created_at: 't2', html_url: 'u2' },
      ]))
      .mockImplementation(async (url) => {
        if (url.includes('/issues/1/comments')) return fakeResponse(true, 200, [{ id: 10, body: '评论A', created_at: 't' }]);
        if (url.includes('/issues/2/comments')) return fakeResponse(true, 200, [{ id: 20, body: '评论B', created_at: 't' }]);
        throw new Error('unexpected url ' + url);
      });
    const result = await listFeedbackWithComments({ fetchImpl, token, repo });
    expect(result).toHaveLength(2);
    const a = result.find(i => i.number === 1);
    const b = result.find(i => i.number === 2);
    expect(a.comments).toEqual([{ id: 10, body: '评论A', createdAt: 't' }]);
    expect(b.comments).toEqual([{ id: 20, body: '评论B', createdAt: 't' }]);
  });
});

describe('feedbackReporter — addFeedbackComment', () => {
  const token = 'ghp_fake_token';
  const repo = 'someone/somerepo';

  it('没有 token 时直接抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(addFeedbackComment(23, 'Alice', '我也遇到了', { fetchImpl, token: undefined, repo }))
      .rejects.toThrow(/FEEDBACK_GITHUB_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('空文本抛错，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(addFeedbackComment(23, 'Alice', '   ', { fetchImpl, token, repo })).rejects.toThrow(/评论内容/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('评论正文自动带上作者名字前缀，POST 到正确的 issue', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(true, 201, { id: 99, body: '**Alice**：我也遇到了', created_at: 't' })
    );
    const result = await addFeedbackComment(23, 'Alice', '我也遇到了', { fetchImpl, token, repo });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${repo}/issues/23/comments`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.body).toBe('**Alice**：我也遇到了');
    expect(result).toEqual({ id: 99, body: '**Alice**：我也遇到了', createdAt: 't' });
  });

  it('没有提供作者名字时回退成"匿名"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(true, 201, { id: 100, body: '**匿名**：随便说说', created_at: 't' }));
    await addFeedbackComment(23, '', '随便说说', { fetchImpl, token, repo });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.body).toBe('**匿名**：随便说说');
  });

  it('GitHub API 返回非 2xx 时抛错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(false, 403, {}));
    await expect(addFeedbackComment(23, 'Alice', '文字', { fetchImpl, token, repo })).rejects.toThrow(/403/);
  });
});
