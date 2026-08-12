import { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { extractImages, extractAuthor, parseComment, statusOf, formatTime } from '../utils/feedbackFormat';

// 一条评论——只读展示，app 里不支持加评论（用户明确不需要）。自动评估
// 显示"自动评估"小标签，视觉上跟其他评论区分开。
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

// 单条反馈——提交人、提交时间、处理状态、原始内容、全部评论，都在这一
// 张卡片里；不再是"点进去才看详情"的两级导航（用户明确要求）。
function FeedbackCard({ issue, index }) {
  const { author, rest } = extractAuthor(issue.body);
  const { text, images } = extractImages(rest);
  const status = statusOf(issue);

  return (
    <div className="fb-card">
      <div className="fb-card-head">
        <span className="fb-card-who">
          <span className="fb-card-index">{index}</span>
          {author && <span className="fb-card-author">{author}</span>}
          <span className="fb-card-time">{formatTime(issue.createdAt)}</span>
        </span>
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

  return (
    <div className="hh-panel-overlay" onClick={onClose}>
      <div className="hh-panel" onClick={e => e.stopPropagation()}>
        <div className="hh-panel-header">
          <div className="hh-panel-back" onClick={onClose}>‹</div>
          <div className="hh-panel-title">反馈进展</div>
          <div className="hh-panel-count">{issues ? `共 ${issues.length} 条` : ''}</div>
        </div>
        <div className="fb-list-content">
          {issues === null && !error && (
            <div className="fb-loading">
              <div className="fb-spinner" />
              <span>加载中…</span>
            </div>
          )}
          {error && <div className="hh-empty">{error}</div>}
          {issues?.length === 0 && <div className="hh-empty">还没有人提过反馈</div>}
          {issues?.map((issue, i) => (
            <FeedbackCard key={issue.number} issue={issue} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
