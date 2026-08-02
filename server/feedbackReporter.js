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
    body: JSON.stringify({ message: `feedback: add attachment ${filename}`, content: base64 }),
  });
  if (!res.ok) throw new Error(`图片上传失败（GitHub ${res.status}）`);
  const data = await res.json();
  return data.content.download_url;
}

async function createFeedbackIssue(
  { text, image = null },
  { fetchImpl = fetch, token = process.env.FEEDBACK_GITHUB_TOKEN, repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO } = {},
) {
  if (!token) throw new Error('FEEDBACK_GITHUB_TOKEN 未配置');
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('缺少反馈内容');

  let imageMarkdown = '';
  if (image) {
    const downloadUrl = await uploadImage(image, { fetchImpl, token, repo });
    imageMarkdown = `\n\n![反馈图片](${downloadUrl})`;
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

module.exports = { createFeedbackIssue, isConfigured };
