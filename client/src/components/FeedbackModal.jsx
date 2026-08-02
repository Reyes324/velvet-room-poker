import { useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { compressImage } from '../utils/compressImage';
import './FeedbackModal.css';

const MAX_TEXT_LENGTH = 2000;

export default function FeedbackModal({ onClose }) {
  const { socket } = useSocket({});
  const [text, setText] = useState('');
  const [imagePreview, setImagePreview] = useState(null); // object URL, for on-screen preview only
  const [imagePayload, setImagePayload] = useState(null); // { base64, mimeType }, actually sent
  const [status, setStatus] = useState('idle'); // idle | submitting | done | error
  const [error, setError] = useState('');

  async function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const compressed = await compressImage(file);
      setImagePayload(compressed);
      setImagePreview(URL.createObjectURL(file));
    } catch {
      setError('这张图片没法上传，换一张试试');
    }
  }

  function handleSubmit() {
    if (!text.trim()) return setError('请输入反馈内容');
    setStatus('submitting');
    setError('');
    socket.timeout(15000).emit('feedback:submit', { text: text.trim(), image: imagePayload }, (err, res) => {
      if (err) {
        setStatus('error');
        setError('提交超时，请重试');
        return;
      }
      if (res?.error) {
        setStatus('error');
        setError(res.error);
        return;
      }
      setStatus('done');
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(e) => e.stopPropagation()}>
        {status === 'done' ? (
          <>
            <div className="modal-title">已收到，谢谢反馈！</div>
            <div className="modal-btn" onClick={onClose}>关闭</div>
          </>
        ) : (
          <>
            <div className="modal-title">问题反馈</div>
            <textarea
              className="feedback-textarea"
              placeholder="说说遇到的问题或想法…"
              value={text}
              maxLength={MAX_TEXT_LENGTH}
              onChange={(e) => setText(e.target.value)}
            />
            <label className="feedback-image-picker">
              {imagePreview ? <img src={imagePreview} alt="预览" className="feedback-image-preview" /> : '+ 上传图片（可选）'}
              <input type="file" accept="image/*" onChange={handleImageChange} hidden />
            </label>
            <p className="feedback-image-notice">图片会公开发布在 GitHub 上，注意不要包含隐私信息</p>
            {error && <p className="home-error">{error}</p>}
            <div className="modal-btns">
              <div className="modal-btn modal-btn--secondary" onClick={onClose}>取消</div>
              <div
                className={`modal-btn${status === 'submitting' ? ' modal-btn--waiting' : ''}`}
                onClick={status === 'submitting' ? undefined : handleSubmit}
              >
                {status === 'submitting' ? '提交中…' : '提交'}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
