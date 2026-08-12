// GitHub Issue 作为反馈存储层——Render 免费档没有持久化磁盘，本地文件在
// 每次 git push 触发的重新部署时都会被清空重置（这正是"人机对战牌局重
// 置"那个 bug 的根因）。见 docs/superpowers/specs/2026-08-02-user-feedback-
// system-design.md 的"关键约束"一节。fetchImpl/token/repo 都可注入，跟
// PveSession 的 strategy/store 参数是同一个"方便测试、不用真的打
// GitHub"的模式。

const API_BASE = 'https://api.github.com';
const DEFAULT_REPO = 'Reyes324/velvet-room-poker';

// 只接受这几种格式——限制格式既是安全考虑（不接受任意扩展名拼进 URL 路
// 径），也是因为浏览器 canvas.toBlob 只会产出这几种。
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function isConfigured({ token = process.env.FEEDBACK_GITHUB_TOKEN } = {}) {
  return Boolean(token);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function uploadImage({ base64, mimeType }, { fetchImpl, token, repo }) {
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) throw new Error(`不支持的图片格式: ${mimeType}`);
  const filename = `feedback-attachments/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/contents/${filename}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({
      message: `feedback: add attachment ${filename}`,
      content: base64,
      // 落在独立的 feedback-attachments 分支，不进 main——push 到 main 会触发
      // Render 自动重新部署，重部署会清空所有正在进行的牌局内存状态（69.15
      // 那个"打着打着牌局重置了"的根因）。raw.githubusercontent.com 按分支
      // 提供文件访问，所以 download_url 不受影响，图片 markdown 逻辑不用变。
      branch: 'feedback-attachments',
    }),
  });
  if (!res.ok) throw new Error(`图片上传失败（GitHub ${res.status}）`);
  const data = await res.json();
  return data.content.download_url;
}

async function createFeedbackIssue(
  // image（单张）保留为兼容入口——见 index.js 里同一处的说明：线上可能有缓
  // 存着旧前端的浏览器，而这个模块本身也已经有一批只传 image 的测试。
  { text, image = null, images = null },
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('缺少反馈内容');

  const imageList = Array.isArray(images) ? images.filter(Boolean) : (image ? [image] : []);
  let imageMarkdown = '';
  for (const img of imageList) {
    // 串行上传而不是 Promise.all：GitHub Contents API 对同一分支的连续写入
    // 有并发限制（同时提交多个文件到同一分支会撞上 409 冲突），而张数上限
    // 只有 4，串行的额外耗时可以忽略。
    const downloadUrl = await uploadImage(img, { fetchImpl, token, repo });
    imageMarkdown += `\n\n![反馈图片](${downloadUrl})`;
  }

  const title = trimmed.slice(0, 60).replace(/\n/g, ' ');
  const body = `${trimmed}${imageMarkdown}`;
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/issues`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title, body, labels: ['feedback'] }),
  });
  if (!res.ok) throw new Error(`GitHub Issue 创建失败（${res.status}）`);
  const data = await res.json();
  return { issueNumber: data.number, issueUrl: data.html_url };
}

// 反馈进展可见 + 批注（用户反馈，2026-08-12）：不新建一套独立存储——已经
// 在用 GitHub Issue 存反馈了，连自动评估（打 accepted/design 标签、发评
// 论、关闭）也是直接读写这些 issue。app 里展示的"反馈列表"就是把这些
// issue 原样读出来，两边数据天然一致，不会各说各话。

// issues 接口会把 PR 也混进来（PR 底层也是 issue），用 `pull_request` 字
// 段过滤掉——这个仓库不会真的有 PR 打 feedback 标签，但防御性地滤掉更
// 诚实，不依赖"恰好没人这么做"。
async function listFeedbackIssues(
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/issues?labels=feedback&state=all&per_page=100&sort=created&direction=desc`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`获取反馈列表失败（GitHub ${res.status}）`);
  const data = await res.json();
  return data.filter(i => !i.pull_request).map(i => ({
    number: i.number,
    title: i.title,
    body: i.body || '',
    state: i.state, // 'open' | 'closed'
    labels: i.labels.map(l => (typeof l === 'string' ? l : l.name)),
    createdAt: i.created_at,
    url: i.html_url,
  }));
}

async function listFeedbackComments(
  issueNumber,
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`获取评论失败（GitHub ${res.status}）`);
  const data = await res.json();
  return data.map(c => ({ id: c.id, body: c.body, createdAt: c.created_at }));
}

// 一次性把所有反馈 issue 连同各自的评论一起返回——用户要求整页一次性展
// 示"原始内容+提交时间+处理结果+评论"，不做"点进去才看详情"的两级导
// 航，所以评论要跟 issue 列表一起备好，客户端不用再逐条请求。反馈条数
// 在朋友局规模下不会很多，并发拉每条的评论比串行更快，可以接受。
async function listFeedbackWithComments(opts = {}) {
  const issues = await listFeedbackIssues(opts);
  return Promise.all(issues.map(async (issue) => ({
    ...issue,
    comments: await listFeedbackComments(issue.number, opts),
  })));
}

// authorName 拼进评论正文最前面——这条评论最终是用同一个服务端 token（同
// 一个 GitHub 账号身份）发出去的，GitHub 上看不出真实是谁写的，得自己在
// 文字里带上名字。跟自动评估留言的格式（"**评估结论：...**"）不冲突，
// 客户端负责把两种格式都渲染成看得懂的样子。
async function addFeedbackComment(
  issueNumber, authorName, text,
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('缺少评论内容');
  const name = (authorName || '').trim().slice(0, 30) || '匿名';
  const body = `**${name}**：${trimmed}`;
  const res = await fetchImpl(`${API_BASE}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`评论发送失败（GitHub ${res.status}）`);
  const data = await res.json();
  return { id: data.id, body: data.body, createdAt: data.created_at };
}

module.exports = {
  createFeedbackIssue, isConfigured,
  listFeedbackIssues, listFeedbackComments, listFeedbackWithComments, addFeedbackComment,
};
