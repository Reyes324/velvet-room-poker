// server/__tests__/feedbackReporter.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFeedbackIssue, isConfigured } = require('../feedbackReporter');

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
    expect(JSON.parse(contentsOpts.body).content).toBe('ZmFrZQ==');

    const [, issueOpts] = fetchImpl.mock.calls[1];
    const issueBody = JSON.parse(issueOpts.body);
    expect(issueBody.body).toContain('https://raw.githubusercontent.com/x/y/main/feedback-attachments/abc.png');
    expect(result.issueNumber).toBe(43);
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
