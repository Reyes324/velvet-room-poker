import changelog from '../changelog.json';

// entry.date 是精确到秒的时间戳字符串（"YYYY-MM-DD HH:mm:ss"，不只是日
// 期）——用户反馈（2026-08-03）："最好能显示每次更新的秒数，因为我这个是
// 为了方便玩家看到什么时候又更新了一版"，直接原样渲染即可，不用额外解析
// /格式化。
export default function ChangelogModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal changelog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">最近更新</div>
        <div className="changelog-list">
          {changelog.map((entry, i) => (
            <div key={i} className="changelog-entry">
              <div className="changelog-date">{entry.date}</div>
              <div className="changelog-text">{entry.text}</div>
            </div>
          ))}
        </div>
        <div className="modal-btn" onClick={onClose}>关闭</div>
      </div>
    </div>
  );
}
