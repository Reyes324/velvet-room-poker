import { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { extractImages, parseComment, statusOf, formatTime } from '../utils/feedbackFormat';

function getFeedbackName() {
  return localStorage.getItem('vr_feedbackName') || '';
}

// 一条评论：真人发的显示名字，自动评估显示"自动评估"小标签，视觉上跟
// 普通留言区分开（不是要抢眼，只是让人一眼看出这条不是另一个朋友说的）。
function CommentRow({ comment }) {
  const { author, isAuto, text } = parseComment(comment.body);
  return (
    <div className={`fb-comment${isAuto ? ' fb-comment--auto' : ''}`}>
      <div className="fb-comment-head">
        <span className="fb-comment-author">{isAuto ? '🤖 自动评估' : author}</span>
        <span className="fb-comment-time">{formatTime(comment.createdAt)}</span>
      </div>
      <div className="fb-comment-text">{text}</div>
    </div>
  );
}

// 单条反馈——原始内容、提交时间、处理状态、全部评论，都在这一张卡片
// 里；不再是"点进去才看详情"的两级导航（用户明确要求）。
function FeedbackCard({ issue, onComment }) {
  const { text, images } = extractImages(issue.body);
  const status = statusOf(issue);
  const [name, setName] = useState(getFeedbackName());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');

  function submit() {
    if (!draft.trim()) return;
    if (!name.trim()) return setErr('先填一下你的称呼');
    setSending(true);
    setErr('');
    localStorage.setItem('vr_feedbackName', name.trim());
    onComment(issue.number, name.trim(), draft.trim(), (ok, error) => {
      setSending(false);
      if (ok) setDraft('');
      else setErr(error || '发送失败，请重试');
    });
  }

  return (
    <div className="fb-card">
      <div className="fb-card-head">
        <span className="fb-card-time">{formatTime(issue.createdAt)}</span>
        <span className={`fb-status fb-status--${status.tone}`}>{status.text}</span>
      </div>
      <div className="fb-card-body">{text}</div>
      {images.length > 0 && (
        <div className="fb-card-images">
          {images.map(url => <img key={url} src={url} alt="反馈图片" />)}
        </div>
      )}
      {issue.comments.length > 0 && (
        <div className="fb-comment-list">
          {issue.comments.map(c => <CommentRow key={c.id} comment={c} />)}
        </div>
      )}
      <div className="fb-comment-form">
        <input
          className="fb-comment-name"
          placeholder="你的称呼"
          value={name}
          maxLength={20}
          onChange={e => setName(e.target.value)}
        />
        <div className="fb-comment-input-row">
          <input
            className="fb-comment-input"
            placeholder="补充说明…"
            value={draft}
            maxLength={500}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
          />
          <button className="fb-comment-send" disabled={sending || !draft.trim()} onClick={submit}>
            {sending ? '…' : '发送'}
          </button>
        </div>
        {err && <p className="home-error">{err}</p>}
      </div>
    </div>
  );
}

export default function FeedbackListPanel({ onClose }) {
  const { socket } = useSocket({});
  const [issues, setIssues] = useState(null); // null = 加载中
  const [error, setError] = useState('');

  useEffect(() => {
    socket.timeout(15000).emit('feedback:list', {}, (err, res) => {
      if (err) return setError('加载超时，请重试');
      if (res?.error) return setError(res.error);
      setIssues(res.issues);
    });
  }, [socket]);

  function handleComment(issueNumber, authorName, text, cb) {
    socket.timeout(10000).emit('feedback:comment', { issueNumber, authorName, text }, (err, res) => {
      if (err) return cb(false, '发送超时，请重试');
      if (res?.error) return cb(false, res.error);
      // 直接把刚发的评论插进对应卡片，不用整页重新拉一次列表。
      setIssues(prev => prev.map(i => i.number === issueNumber ? { ...i, comments: [...i.comments, res.comment] } : i));
      cb(true);
    });
  }

  return (
    <div className="hh-panel-overlay" onClick={onClose}>
      <div className="hh-panel" onClick={e => e.stopPropagation()}>
        <div className="hh-panel-header">
          <div className="hh-panel-back" onClick={onClose}>‹</div>
          <div className="hh-panel-title">反馈进展</div>
          <div className="hh-panel-count">{issues ? `共 ${issues.length} 条` : ''}</div>
        </div>
        <div className="fb-list-content">
          {issues === null && !error && <div className="hh-empty">加载中…</div>}
          {error && <div className="hh-empty">{error}</div>}
          {issues?.length === 0 && <div className="hh-empty">还没有人提过反馈</div>}
          {issues?.map(issue => (
            <FeedbackCard key={issue.number} issue={issue} onComment={handleComment} />
          ))}
        </div>
      </div>
    </div>
  );
}
