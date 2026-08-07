// 服务器进程换过了，玩家正在进行的牌局已经随内存一起没了。在此之前这种
// 情况是完全静默的：客户端拿着过期的房间号去 rejoin，服务器回一句"未找到
// 房间"，人就卡在那儿不知道发生了什么（App.jsx 里那段 PVE 恢复的注释描述
// 的是同一个洞的另一面）。
//
// 没有 backdrop 点击关闭，也没有关闭叉——牌局是真的没了，这个消息不该被
// 误触划掉，唯一的出口就是"知道了"，顺带把过期的本地标记清干净。
export default function ServerResetModal({ kind, onDismiss }) {
  const isNewVersion = kind === 'version';

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">
          {isNewVersion ? '开发者刚发布了新版本' : '服务器重启了'}
        </div>
        <div className="modal-body">
          你正在进行的牌局已经重置了，抱歉打断。
        </div>
        <div className="modal-btns">
          <div className="modal-btn modal-btn--paired" onClick={onDismiss}>知道了</div>
        </div>
      </div>
    </div>
  );
}
