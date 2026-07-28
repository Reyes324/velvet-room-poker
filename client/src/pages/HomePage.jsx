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

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode);
      setMode('join');
    }
  }, [initialCode]);

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
    <div className="home">
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
          />

          {mode === 'join' && (
            <input
              className="home-input home-input--code"
              placeholder="房间码（6位）"
              value={code}
              maxLength={6}
              onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
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
    </div>
  );
}
