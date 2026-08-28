function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 文字聊天回溯（用户反馈 2026-08-28，issue #52 拆分出的文字部分）——气泡本
// 身只停 6 秒（见 chatText），错过了就彻底没了，这里给一个能翻回去看的常
// 驻列表。复用 HandHistoryModal 那套 overlay/header/empty 视觉语言（同一
// 套 hh-panel-* class），但面板本身用独立的 .ch-panel，不是 .hh-panel——
// 用户反馈（2026-08-29）"只出来一半就好，不用全页面，临时看一眼的东西"，
// 牌局记录是要坐下来慢慢翻的数据密集页面，配得上接近全屏宽度；聊天记录
// 是随手扫一眼的轻量东西，两者故意不共用同一个宽度。内容也简单得多，不
// 需要牌局记录那套双栏 rail+scrollspy——就是一条按时间顺序往下排的列表。
//
// `messages` 是服务端 chatLog 的原样（`{ fromId, text, at }`），发送者名
// 字不在这里存副本，用 `players` 现查——跟牌桌其余地方（比如聊天气泡本
// 身）解析 fromId 的方式一致，房间的 players 数组从不真正删行，历史消息
// 里哪怕对应的人已经离开，也还能查到名字。
export default function ChatHistoryModal({ messages, players, myId, onClose }) {
  const nameOf = id => {
    if (id === myId) return '我';
    return players.find(p => p.id === id)?.name ?? '（已离开）';
  };

  return (
    <div className="hh-panel-overlay" onClick={onClose}>
      <div className="ch-panel" onClick={e => e.stopPropagation()}>
        <div className="hh-panel-header">
          <div className="hh-panel-back" onClick={onClose}>‹</div>
          <div className="hh-panel-title">聊天记录</div>
          <div className="hh-panel-count">{messages.length > 0 ? `共 ${messages.length} 条` : ''}</div>
        </div>
        {messages.length === 0 ? (
          <div className="hh-empty">还没有人发过消息</div>
        ) : (
          <div className="ch-list">
            {messages.map((m, i) => (
              <div key={i} className={`ch-row${m.fromId === myId ? ' ch-row--me' : ''}`}>
                <div className="ch-row-meta">
                  <span className="ch-row-name">{nameOf(m.fromId)}</span>
                  <span className="ch-row-time">{formatTime(m.at)}</span>
                </div>
                <div className="ch-row-bubble">{m.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
