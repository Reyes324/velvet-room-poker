import { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import './HomePage.css';

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export default function HomePage({ onJoined, onPve, initialCode }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialCode ?? '');
  const [mode, setMode] = useState(initialCode ? 'join' : null);
  const [error, setError] = useState('');
  const [inviterName, setInviterName] = useState(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // 路由重构（2026-08-02，用户反馈"主域名不要静默自动恢复"）：裸域名不再
  // 自动带你回上一个会话，而是这里异步 peek 一次确认会话还在，确认了才
  // 展示"继续上局"卡片，由用户自己点进去。null = 还没查/查完发现没有；
  // 有会话时是 { type: 'room', code } 或 { type: 'pve', handNumber, seatCount }。
  const [resumeCard, setResumeCard] = useState(null);

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode);
      setMode('join');
    }
  }, [initialCode]);

  // iOS Safari doesn't shrink the layout viewport (what 100dvh in
  // HomePage.css tracks) when the software keyboard opens — only the
  // visual viewport shrinks — so the vertically-centered card stayed
  // centered against the full, keyboard-including height and the keyboard
  // could cover the lower fields/buttons entirely, worse in join mode
  // (name + code + buttons is taller) (user feedback, 2026-07-29).
  // visualViewport is the one API that actually reports the keyboard-
  // shrunk height; drop out of centered layout once it shrinks enough to
  // mean the keyboard is up, rather than a random resize/rotation.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const baseline = vv.height;
    function onResize() {
      setKeyboardOpen(vv.height < baseline * 0.75);
    }
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // The visualViewport resize (keyboardOpen flipping true) and the OS
  // keyboard's own open animation don't land in the same frame — a short
  // delay lets the keyboard actually finish opening before scrolling, or
  // this races and can scroll to where the field will be, not where it
  // currently is.
  function scrollFieldIntoView(e) {
    const el = e.target;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  }

  const { emit, socket } = useSocket({
    'room:joined': ({ code: roomCode, playerId }) => {
      localStorage.setItem('vr_playerId', playerId);
      localStorage.setItem('vr_roomCode', roomCode);
      onJoined(roomCode, playerId, name, mode !== 'join');
    },
    'game:error': (msg) => setError(msg),
  });

  // Deep-link arrival ("XXX invited you") — read-only peek, doesn't join.
  useEffect(() => {
    if (!initialCode) return;
    function peek() {
      socket.emit('room:peek', { code: initialCode }, (res) => {
        if (res && !res.error) setInviterName(res.hostName);
      });
    }
    if (socket.connected) peek(); else socket.once('connect', peek);
  }, [initialCode]);

  // "继续上局"卡片——确认存在才展示，不存在就静默清掉本地标记。房间/PVE
  // 在本地始终互斥（同一时间最多一个标记），所以最多查一个、最多展示一
  // 张卡片。跟上面的邀请链接 peek 是同一个只读查询模式，不影响服务端状态。
  useEffect(() => {
    if (initialCode) return; // 邀请链接场景走的是加入流程，不需要"继续上局"
    const savedRoomCode = localStorage.getItem('vr_roomCode');
    const pveActive = localStorage.getItem('vr_pveActive');
    if (!savedRoomCode && !pveActive) return;

    function peekResume() {
      if (savedRoomCode) {
        socket.emit('room:peek', { code: savedRoomCode }, (res) => {
          if (res && !res.error) {
            setResumeCard({ type: 'room', code: savedRoomCode });
          } else {
            localStorage.removeItem('vr_roomCode');
          }
        });
        return;
      }
      const pveId = localStorage.getItem('vr_playerId');
      socket.emit('pve:peek', { pveId }, (res) => {
        if (res?.exists) {
          setResumeCard({ type: 'pve', handNumber: res.handNumber, seatCount: res.seatCount });
        } else {
          localStorage.removeItem('vr_pveActive');
          localStorage.removeItem('vr_pveLastActive');
          localStorage.removeItem('vr_pveSeatCount');
        }
      });
    }
    if (socket.connected) peekResume(); else socket.once('connect', peekResume);
  }, [initialCode]);

  function handleResumeClick() {
    if (resumeCard?.type === 'room') {
      const playerId = localStorage.getItem('vr_playerId');
      onJoined(resumeCard.code, playerId);
    } else if (resumeCard?.type === 'pve') {
      onPve('', resumeCard.seatCount);
    }
  }

  function getPlayerId() {
    let id = localStorage.getItem('vr_playerId');
    if (!id) { id = genId(); localStorage.setItem('vr_playerId', id); }
    return id;
  }

  function handleCreate() {
    if (!name.trim()) return setError('请输入昵称');
    emit('room:create', { playerId: getPlayerId(), playerName: name.trim() });
  }

  function handleJoin() {
    if (!name.trim()) return setError('请输入昵称');
    if (!code.trim()) return setError('请输入房间码');
    emit('room:join', { code: code.trim().toUpperCase(), playerId: getPlayerId(), playerName: name.trim() });
  }

  return (
    <div className={`home${keyboardOpen ? ' home--keyboard-open' : ''}`}>
      <div className="home-bg" />
      <div className="home-card">
        <div className="home-logo">翡翠厅</div>
        <p className="home-tagline">Texas Hold'em · No Limit</p>

        {mode === 'join' && initialCode && (
          <p className="home-invite">
            {inviterName ? <>「<strong>{inviterName}</strong>」邀请你加入战局</> : '受邀加入战局'}
          </p>
        )}

        {mode === null && resumeCard && (
          <button className="home-resume-card" onClick={handleResumeClick}>
            {resumeCard.type === 'room'
              ? `继续上局：房间 ${resumeCard.code}`
              : `继续上局：人机对战（第 ${resumeCard.handNumber} 手）`}
          </button>
        )}

        <div className="home-form">
          {mode !== 'pve' && (
            // 人机对战不需要昵称——服务端 pve:start 本来就在没收到名字时
            // 回退到"玩家"（server/index.js），只是之前这个输入框对 PVE
            // 场景也一直显示，让人以为要填。用户反馈（2026-08-02）："人机
            // 对战，不用写昵称，选择人数就可以了"。
            <input
              className="home-input"
              placeholder="你的昵称"
              value={name}
              maxLength={16}
              onChange={e => { setName(e.target.value); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && mode === 'join' && handleJoin()}
              onFocus={scrollFieldIntoView}
            />
          )}

          {mode === 'join' && (
            <input
              className="home-input home-input--code"
              placeholder="房间码（6位）"
              value={code}
              maxLength={6}
              onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              onFocus={scrollFieldIntoView}
              autoFocus
            />
          )}

          {error && <p className="home-error">{error}</p>}

          {mode === null && (
            <div className="home-buttons">
              <button className="btn-primary" onClick={handleCreate}>创建房间</button>
              <button className="btn-secondary" onClick={() => setMode('join')}>加入房间</button>
            </div>
          )}

          {mode === 'join' && (
            <div className="home-buttons">
              <button className="btn-primary" onClick={handleJoin}>加入</button>
              <button className="btn-ghost" onClick={() => setMode(null)}>返回</button>
            </div>
          )}
        </div>
      </div>
      {mode === null && (
        // 找不到真人对战时自己练练手——刻意放在卡片外面、页面下方，跟"创建/
        // 加入房间"这两个正式入口在视觉上分开一层，不经过任何房间码/邀请链接。
        // 见 design.md「新增：单人人机对战（PVE）模式」，MVP 不跟多人房间混用。
        // 点了不直接开局，先切到 mode==='pve' 选桌形（2026-08-02 新增：支持
        // 多电脑同桌，不再只有单挑）。
        <div className="home-pve-link" onClick={() => setMode('pve')}>人机对战</div>
      )}
      {mode === 'pve' && (
        // 风格是随机分配、对玩家不可见的（design.md 已确认），所以这里只
        // 需要选人数，不需要选风格/难度。四档固定卡片，不开放任意数字。
        <div className="home-pve-picker">
          <div className="home-pve-picker-title">选择桌形</div>
          <div className="home-pve-picker-grid">
            {/* 不再用 `name` 输入框的值——那个字段在 PVE 模式下已经不显示
                了，即使之前在其他 mode 下打过字也不该带进来（服务端
                pve:start 收到空名字会自动回退到"玩家"）。 */}
            <button className="home-pve-seat-btn" onClick={() => onPve('', 2)}>单挑</button>
            <button className="home-pve-seat-btn" onClick={() => onPve('', 4)}>4 人</button>
            <button className="home-pve-seat-btn" onClick={() => onPve('', 6)}>6 人</button>
            <button className="home-pve-seat-btn" onClick={() => onPve('', 8)}>8 人</button>
          </div>
          <div className="home-pve-picker-back" onClick={() => setMode(null)}>返回</div>
        </div>
      )}
      {/* 用户反馈（2026-07-31）：加到 iOS 主屏幕的书签是"独立 App"模式打开的
          （见 index.html 的 apple-mobile-web-app-capable），没有 Safari 那套
          地址栏/下拉刷新——切到后台再切回来，系统很多时候只是把原来那个
          网页视图原样唤醒，不会重新请求，停留在上次冷启动时加载的版本。
          用户不知道怎么"刷新"，这里给一个明确的手动入口。放在最外层、不受
          mode 影响，任何界面状态下都能点到。GameTable 里游戏进行中也有一个
          对应的菜单项，同一个诉求。 */}
      <div className="home-refresh-link" onClick={() => window.location.reload()}>刷新</div>
    </div>
  );
}
