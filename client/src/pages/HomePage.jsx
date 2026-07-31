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

        <div className="home-form">
          <input
            className="home-input"
            placeholder="你的昵称"
            value={name}
            maxLength={16}
            onChange={e => { setName(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && mode === 'join' && handleJoin()}
            onFocus={scrollFieldIntoView}
          />

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
        // 加入房间"这两个正式入口在视觉上分开一层，不经过任何房间码/邀请链接，
        // 点了直接开局。见 design.md「新增：单人人机对战（PVE）模式」，MVP 不
        // 跟多人房间混用。
        <div className="home-pve-link" onClick={() => onPve(name.trim())}>人机对战</div>
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
