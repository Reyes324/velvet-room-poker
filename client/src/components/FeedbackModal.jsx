import { useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import { compressImage } from '../utils/compressImage';
import FeedbackListPanel from './FeedbackListPanel';
import './FeedbackModal.css';

const MAX_TEXT_LENGTH = 2000;
// 跟服务端 FEEDBACK_MAX_IMAGES 保持一致（用户反馈 #3：只能传一张不够用）。
// 这里再挡一道不是重复劳动——本地就能给出即时提示，不用等一次失败的往返。
const MAX_IMAGES = 4;

export default function FeedbackModal({ onClose }) {
  const { socket } = useSocket({});
  const [text, setText] = useState('');
  // 一张图 = { url: 预览用的 object URL, payload: { base64, mimeType } 真正发出去的 }
  // 两者放在同一个对象里而不是两个平行数组：删除某一张时只要按下标删一次，
  // 不会出现两个数组错位、预览和实际发送的图对不上的经典 bug。
  const [images, setImages] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | submitting | done | error
  const [error, setError] = useState('');
  // 用户反馈（2026-08-12）：提交完全是单向的，看不到自己/别人提的反馈后
  // 续处理到什么程度了。默认还是这个提交表单（不改变入口习惯），加一个
  // 不起眼的小入口进反馈列表——列表本身是独立的全屏面板（见
  // FeedbackListPanel），不是这个弹窗内部的另一个 tab。
  const [showList, setShowList] = useState(false);

  async function handleImageChange(e) {
    const files = Array.from(e.target.files ?? []);
    // 同一个 input 连续选同一批文件时 onChange 不会再触发，选完就清空 value
    e.target.value = '';
    if (!files.length) return;
    setError('');
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return setError(`最多上传 ${MAX_IMAGES} 张图片`);
    const accepted = files.slice(0, room);
    try {
      const compressed = await Promise.all(accepted.map(async (file) => ({
        url: URL.createObjectURL(file),
        payload: await compressImage(file),
      })));
      setImages(prev => [...prev, ...compressed]);
      if (files.length > room) setError(`最多上传 ${MAX_IMAGES} 张，多选的已忽略`);
    } catch {
      setError('有图片没法上传，换一张试试');
    }
  }

  function removeImage(idx) {
    setImages((prev) => {
      // 撤销 object URL，否则每选一张就漏一份内存，反复增删会越积越多
      URL.revokeObjectURL(prev[idx]?.url);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function handleSubmit() {
    if (!text.trim()) return setError('请输入反馈内容');
    setStatus('submitting');
    setError('');
        // 15s 是单张图时定的；多图要串行上传到 GitHub，按张数放宽超时，
    // 否则传满 4 张几乎必然在服务端还没传完时就被判超时。
    const timeoutMs = 15000 + images.length * 10000;
    socket.timeout(timeoutMs).emit('feedback:submit', { text: text.trim(), images: images.map(i => i.payload) }, (err, res) => {
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

  // FeedbackListPanel 渲染在这个组件自己的 overlay 外面（兄弟节点，不是
  // 子节点）——它有自己的背景点击关闭逻辑，嵌在里面的话，点它的背景会
  // 冒泡触发外层这个 overlay 的 onClick，把两层一起关掉。
  if (showList) return <FeedbackListPanel onClose={() => setShowList(false)} />;

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
            <div className="feedback-image-list">
              {images.map((img, i) => (
                <div key={img.url} className="feedback-image-thumb">
                  <img src={img.url} alt={`预览 ${i + 1}`} />
                  <div
                    className="feedback-image-remove"
                    onClick={() => removeImage(i)}
                    role="button"
                    aria-label={`删除第 ${i + 1} 张图片`}
                  >×</div>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <label className="feedback-image-picker">
                  <span>+ 图片</span>
                  <span className="feedback-image-count">{images.length}/{MAX_IMAGES}</span>
                  <input type="file" accept="image/*" multiple onChange={handleImageChange} hidden />
                </label>
              )}
            </div>
            <p className="feedback-image-notice">图片会公开发布在 GitHub 上，注意不要包含隐私信息</p>
            {error && <p className="home-error">{error}</p>}
            <div className="feedback-list-link" onClick={() => setShowList(true)}>查看反馈进展 ›</div>
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
