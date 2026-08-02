import changelog from '../changelog.json';

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
