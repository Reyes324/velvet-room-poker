// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// The action bubble (bet amount + category label, e.g. "加注 ¥40"/"小盲 ¥10")
// is this seat's only "what did they put in, and why" indicator — there's no
// separate bare-number bet-chip anymore, that duplicated the same info
// without the label (confirmed on a real device). Opponents' hole cards are
// never shown face-down pre-showdown (removed — they carried no information
// and only ate into the tight center-strip space); they only appear at real
// showdown.
import { useEffect, useRef, useState } from 'react';
import { useThinkSeconds, useTurnClock } from '../hooks/useThinkSeconds';
import Card from './Card';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// Preset reactions for 拍一拍 (GitHub #19's "最好还能拍的时候选表情动画效果"
// ask) — must match server/index.js's POKE_EMOJI allowlist, since the
// server re-validates whatever it receives against its own copy rather than
// trusting the client.
const POKE_EMOJI = ['😄', '😢', '👍', '😡', '❤️', '😂'];

// The showdown reveal always renders to the side of the seat (toward
// whichever direction GameTable's cardsSide picks — the center strip, per
// column). Rows sit close enough together that anything rendered
// above/below a seat overlaps the neighboring row's card/footer — side
// placement is the only direction with real room to spare, confirmed on a
// real device. The "above" fallback below is unreachable in normal play
// (GameTable always passes a side now) — kept only as a safe default if
// this component is ever rendered without one.
// Every branch fully specifies all four of left/right/top/bottom (using
// 'auto' for the unused ones) rather than only the properties it cares
// about — .action-bubble's own CSS class sets `left:50%` and `bottom:...`
// at rest, and an inline style that only overrides `right`/`top` leaves
// that `left:50%` still active alongside the new `right`, which makes the
// browser treat both edges as constraints and squash the element's width
// down to whatever's between them (confirmed via computed-style inspection
// on a real render, not guessed).
function sideStyle(cardsSide) {
  if (cardsSide === 'left') return { position: 'absolute', left: 'auto', right: 'calc(100% + 3px)', top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 3px)', right: 'auto', top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
  return { position: 'absolute', left: '50%', right: 'auto', bottom: 'calc(100% + 4px)', top: 'auto', transform: 'translateX(-50%)' };
}

// Hero's own bubble is the one case that still defaults to "above" (no
// bubbleSide passed) — hero sits centered at the bottom of the canvas with
// clear room above toward the community cards, confirmed via a real render;
// every other seat always gets an explicit side from GameTable now.
function bubbleStyle(bubbleSide) {
  return bubbleSide ? sideStyle(bubbleSide) : undefined;
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, cardsSide = null, bubbleSide = null, onPoke, poked = false, pokeEmoji = null, pokeFromName = null, revealedCards = null, bestCardRaws = null, turnEndsAt = null, turnStartedAt = null, isSpeaking = false, getVoiceVolume = null, paused = false, disconnected = false, isHost = false, onFoldForDisconnected = null }) {
  const isShowdown = gamePhase === 'showdown';
  const folded = player.status === 'folded';
  const allin = player.status === 'allin';
  const badge = player.isDealer ? '庄家' : player.isSB ? '小盲' : player.isBB ? '大盲' : null;
  const avClass = isMe ? 'av-gold' : AV[color % AV.length];
  // 有服务端下发的截止时刻就显示倒计时；没有（人机对战、或还没收到状态）就
  // 回退到原来那个正数计时，行为跟改动前一致。
  // 秒数和走线环以前是两个独立 hook，各自异步 resolve，回合刚开始那一两帧
  // 会有一个先备好、另一个还没，期间误判成"非计时状态"从而闪出旧版 UI——
  // 现在统一由 useTurnClock 一次性算出，不会再有这种半新半旧的过渡帧。
  const thinkSeconds = useThinkSeconds(isAction);
  const clock = useTurnClock(isAction, turnStartedAt, turnEndsAt);
  const timed = !!clock;
  const countdown = clock?.secondsLeft ?? 0;
  const urgent = timed && countdown <= 5;

  // Issue #17：走线环曾经跟数字倒计时对不上（环走完时数字还剩 10 秒）。根因
  // 不是环的动画本身错，而是这里以前直接把 clock.elapsedMs（每 250ms 随
  // useTurnClock 的 interval 刷新一次，给数字倒计时用的）喂给 SVG 的
  // animationDelay：animation-delay 是相对"动画本身已经自然播放了多久"
  // 叠加的，而这条 CSS 动画从挂载起就已经在自己往前走——每次 React 用一个
  // 更大的负 elapsedMs 重新赋值 animationDelay，等于把"已经自然播放的时长"
  // 和"手动喂进去的已流逝时长"重复计了一遍，环实际推进速度变成约 2 倍，
  // 20 秒的回合大约在真实过了 10 秒时就已经视觉走空——跟用户反馈的"倒数还
  // 有 10 秒边框就走完了"精确对应（2026-08-11 用 Playwright 实测轮询
  // animationDelay/strokeDashoffset 随时间的变化率确认，不是猜的）。
  // 修复：animationDelay/animationDuration 只应该在这一回合开始时算一次、
  // 定死，之后交给 CSS 动画自己按真实挂钟时间播放（这也是代码里原有注释
  // 说的意图："走线环本身靠 CSS animation-delay 走时间，不依赖这个
  // interval"——之前没做到，因为 style 直接绑的是每 250ms 变化的
  // clock.elapsedMs）。冻结值本身由 useTurnClock 提供（ringStyle），跟
  // clock.key 同一次渲染期分支里算好，不会再被之后的 250ms tick 覆盖。
  const ringStyle = clock?.ringStyle ?? null;

  // 说话波纹的强度（0..1）来自 useVoiceMesh 的实时音量表，故意不通过 props
  // 传数值再让 React 重渲染——那张表每帧都在变，真做成 props/state 会在整
  // 段说话期间持续触发这个组件（以及它的 turn-ring/svg 子树）重渲染。改成
  // rAF 里直接读、直接写 DOM 节点的 CSS 变量，React 完全不知道这件事发生
  // 过，只有 isSpeaking 这个离散的开关走一次正常渲染。
  // 节流到约 12fps（~80ms 一次）——波纹是缓慢扩散的效果，肉眼分辨不出跟
  // 60fps 的差别，但把 JS 写 style 的频率降下来能明显减轻它和 CSS 自身
  // keyframe 动画抢重绘造成的卡顿（这条是真机反馈之后加的，之前是每帧都写）。
  // 拍一拍表情选择器：单击头像弹出一小排表情，点其中一个才真正发送（选中
  // 的表情会带进 player:poke 的 payload，见 RoomPage.poke）。点到面板以
  // 外的地方视为放弃，不发送。
  const [pokePickerOpen, setPokePickerOpen] = useState(false);
  const pokePickerRef = useRef(null);
  useEffect(() => {
    if (!pokePickerOpen) return;
    function onOutside(e) {
      if (!pokePickerRef.current?.contains(e.target)) setPokePickerOpen(false);
    }
    document.addEventListener('pointerdown', onOutside, true);
    return () => document.removeEventListener('pointerdown', onOutside, true);
  }, [pokePickerOpen]);

  // 单击/双击分流：单击弹出表情面板，双击直接发一个不带表情的"拍一拍"，
  // 跳过面板（用户反馈，2026-08-11——想要一个比"点开面板再点✋"更快的路
  // 径）。原生的单击事件在双击时也会先各打一次，所以单击这边不能立刻执
  // 行，要等一小段时间确认"这不是双击的前半部分"才真正弹面板——这是双
  // 击/单击互斥的标准做法，不是多余的延迟。
  // 人机对战（PvePage.jsx）根本没接 onPoke——拍电脑对手没有意义，没人会
  // 收到。以前点了照样弹表情面板，选完却 onPoke?.() 静默什么都不做，看
  // 起来像"点了没反应的 bug"（用户反馈，2026-08-11："人机对战的时候没有
  // 看到效果"）。改成 onPoke 不存在时压根不接点击/双击，也不再显示成可
  // 点的样子——诚实地表达"这里没有这个功能"，而不是给一个会静默失败的
  // 死交互。
  const canPoke = !isMe && !!onPoke;
  const avatarClickTimerRef = useRef(null);
  function handleAvatarClick() {
    if (!canPoke) return;
    clearTimeout(avatarClickTimerRef.current);
    avatarClickTimerRef.current = setTimeout(() => {
      setPokePickerOpen(o => !o);
    }, 220);
  }
  function handleAvatarDoubleClick() {
    if (!canPoke) return;
    clearTimeout(avatarClickTimerRef.current);
    setPokePickerOpen(false);
    sendPoke();
  }
  useEffect(() => () => clearTimeout(avatarClickTimerRef.current), []);

  function sendPoke(emoji) {
    setPokePickerOpen(false);
    onPoke?.(emoji);
  }

  const rippleRef = useRef(null);
  useEffect(() => {
    if (!isSpeaking || !getVoiceVolume) return;
    let raf;
    let lastWrite = 0;
    const tick = now => {
      if (now - lastWrite >= 80) {
        lastWrite = now;
        const vol = getVoiceVolume(player.id);
        rippleRef.current?.style.setProperty('--speak-intensity', vol.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isSpeaking, getVoiceVolume, player.id]);

  const seatClass = [
    'seat',
    isWinner && 'is-winner',
    // 有倒计时环的时候不要 is-active——那是个金色呼吸边框，跟环叠在一起就
    // 是两圈边同时动。环本身已经在表达"轮到你了"，比呼吸更明确。
    isAction && !isWinner && !timed && 'is-active',
    isAction && timed && !isWinner && 'is-timed',
    isAction && timed && urgent && !isWinner && 'is-timed-urgent',
    folded && 'is-folded',
    allin && 'is-allin',
    poked && 'is-poked',
  ].filter(Boolean).join(' ');

  return (
    <div className={seatClass}>
      <div className="seat-name-row">
        <div className="seat-name">{player.name}</div>
        {badge && <span className="pos-badge">{badge}</span>}
        {/* 断线指示：以前是页面顶部的一条 toast，只覆盖"轮到TA行动却断线"这
            一种情况，其它断线玩家完全没有任何视觉提示（用户反馈 #20，中文：
            "不同玩家断线中...放顶部是不是太重了"）。现在改成挂在头像名字行
            的小徽标，任何 connected === false 的座位都会显示，跟顶部大面积
            通知比起来轻得多，且离对应玩家更近、一眼能对上人。
            "帮TA弃牌"这个操作本身只在断线的人恰好是当前行动玩家时才有意
            义（弃的是TA正卡住的这一手），所以仍然只在 isAction 时出现——
            直接做成徽标本身可点击，而不是另开一个独立提示框，房主不用在
            两个地方之间找。 */}
        {disconnected && (
          <span
            className={`disconnect-badge${isHost && isAction ? ' disconnect-badge--actionable' : ''}`}
            onClick={isHost && isAction ? () => onFoldForDisconnected?.(player.id) : undefined}
            role={isHost && isAction ? 'button' : undefined}
            title={isHost && isAction ? '点击帮TA弃牌' : undefined}
          >
            {isHost && isAction ? '断线中·帮TA弃牌' : '断线中'}
          </span>
        )}
      </div>
      <div className={`avatar-card ${avClass}`} onClick={handleAvatarClick} onDoubleClick={handleAvatarDoubleClick} role={canPoke ? 'button' : undefined} aria-label={canPoke ? '单击选表情拍一拍，双击直接拍一拍' : undefined}>
        {/* 说话中指示：独立于 avatar-card 自身 border/box-shadow 的叠加层
            （做法跟下面的 turn-ring 一样是并列的兄弟节点），刻意不占用那两
            个属性——is-active/is-timed/is-allin/is-winner 都在用它们，抢占
            的话谁盖过谁全看样式表书写顺序，是脆弱的巧合而不是设计。绿色
            （--state-safe）跟回合倒计时/获胜光效的金色区分开，脉冲比
            is-active 的呼吸更快更亮，两者可以同时出现互不覆盖。 */}
        {isSpeaking && <div className="speak-glow" aria-hidden="true" />}
        {/* 波纹环：发光本身只表示"触发了语音"（离散状态），波纹的扩散幅度
            实时跟音量走（连续量），两者叠在一起才是"在说话+说多大声"。
            --speak-intensity 由上面的 rAF 循环直接写在这个节点上，不经过
            React state。 */}
        {isSpeaking && <div ref={rippleRef} className="speak-ripple" aria-hidden="true" />}
        {isSpeaking && <div className="speak-badge" aria-hidden="true">🎤</div>}
        {/* 回合倒计时：沿卡片轮廓走线的描边，满环起始、匀速走空。取代了原来
            那个盖住整张脸的数字方块——那个方块跟 is-active 的金色呼吸边框、
            以及动作气泡三者同时变化，信息全糊在一起。
            负的 animation-delay 让环从"已经过去多久"的位置接着走，所以中途
            重连或点了延时之后都不会跳回满格。key 保证换回合时动画重播。 */}
        {timed && (
          <svg
            key={clock.key}
            className={`turn-ring${urgent ? ' turn-ring--urgent' : ''}`}
            viewBox="0 0 56 60"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* 淡色底环画出完整轮廓，亮色描边在它上面走空——没有底环时，
                走掉的那一段只是"卡片边缘"，看不出"已经走了多少"，两条环
                叠在一起对比才够明显（真机截图确认过）。 */}
            <rect className="turn-ring-track" x="1" y="1" width="54" height="58" rx="9" ry="9" />
            <rect
              className="turn-ring-progress"
              x="1" y="1" width="54" height="58" rx="9" ry="9"
              style={ringStyle}
            />
          </svg>
        )}
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {/* 数字缩成右上角标，不再盖脸。没有倒计时（人机对战）时退回原来的
              正数计时显示，行为与改动前一致。
              暂停时（paused）两种都不显示——暂停会把 turnEndsAt 清成 null，
              如果不特判会掉进"没有倒计时"分支，显示成还在自己走的
              think-overlay 正数计时，看起来像时间根本没冻结，跟"暂停"这
              件事本身矛盾（真机/e2e 实测抓到的问题，2026-08-11，不是猜
              的）。牌桌中央已经有暂停遮罩说明状态，这里保持空白就够了。 */}
          {isAction && !paused && (
            timed
              ? <div className={`turn-secs${urgent ? ' turn-secs--urgent' : ''}`}>{countdown}</div>
              : <div className="think-overlay">{thinkSeconds}s</div>
          )}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {pokePickerOpen && (
        <div ref={pokePickerRef} className="poke-picker" style={bubbleStyle(bubbleSide)} onClick={e => e.stopPropagation()}>
          {/* 纯"拍一拍"（不带表情）——表情选择器加进来之后，原来"点头像直接
              拍一下"这个最快路径不能丢，不是所有人每次都想停下来挑表情
              （用户反馈，2026-08-11）。放在表情最前面，一个手掌图标，跟后
              面的表情视觉上明显是"同一排里的一个选项"，不是弹窗外的另一
              个入口。 */}
          <button type="button" className="poke-picker-emoji poke-picker-plain" onClick={() => sendPoke()} aria-label="拍一拍（不带表情）">✋</button>
          {POKE_EMOJI.map(e => (
            <button key={e} type="button" className="poke-picker-emoji" onClick={() => sendPoke(e)}>{e}</button>
          ))}
        </div>
      )}

      {bubble && (
        <div
          key={bubble.key}
          className={`action-bubble${bubble.folded ? ' action-bubble--folded' : ''}${bubble.allIn ? ' action-bubble--allin' : ''}`}
          style={bubbleStyle(bubbleSide)}
        >
          {bubble.text}
        </div>
      )}
      {/* 谁拍的要写出来——之前只显示"拍了拍"，同桌好几个人都在拍，看不出
          是谁拍的自己（用户反馈，2026-08-11）。样式也不再复用 .action-
          bubble——那套是给下注/弃牌这类严肃的牌局动作用的暗金配色，拍一
          拍是社交性质的调侃动作，用户反馈"跟下注气泡太像"，改成独立的
          .poke-bubble 暖色系样式，不再继承 .action-bubble。
          带表情和不带表情是两种文案/两种排版，不是同一个模板套两种内容：
          带表情时读作"XX 给你一个 😂"——重点是表情本身，文案缩小、表情
          放大（用户反馈，2026-08-11："突出的是表情不是那个样式框"）；不
          带表情（✋纯拍一拍/双击）时还是"XX 拍了拍"这句纯文字，没有大图
          形可突出，维持原来的胶囊样式就够。 */}
      {poked && (
        pokeEmoji ? (
          <div className="poke-bubble poke-bubble--emoji" style={bubbleStyle(bubbleSide)}>
            <span className="poke-bubble__label">{pokeFromName ? `${pokeFromName} 给你` : '给你'}</span>
            <span className="poke-bubble__glyph">{pokeEmoji}</span>
          </div>
        ) : (
          <div className="poke-bubble poke-bubble--plain" style={bubbleStyle(bubbleSide)}>
            {pokeFromName ? `${pokeFromName} ` : ''}拍了拍
          </div>
        )
      )}

      {/* GameEngine.getStateForPlayer masks other seats' cards as [null, null]
          (same length as a real 2-card hand) whenever the viewer themselves
          folded this hand, even at real showdown — deliberate, matching
          earlier feedback that a folded player shouldn't keep watching
          others' hands resolve. `.length === 2` alone can't tell that apart
          from real revealed cards, and used to crash here trying to read
          `.raw` off `null` (2026-08-02 production crash: 4-seat PVE, human
          folds, AI-vs-AI showdown renders for the folded viewer, blank
          screen — root-caused from an on-screen error report after adding
          the error boundary's copy-to-clipboard). */}
      {isShowdown && !folded && !isMe && player.holeCards?.length === 2 && player.holeCards[0] != null && (
        <div className="reveal" style={sideStyle(cardsSide)}>
          {player.holeCards.map((c, i) => (
            <Card
              key={i}
              card={c}
              // All showdown reveals are the same size ('sm') — the winner
              // doesn't need a bigger card too, the gold highlight already
              // reads clearly on its own (user feedback), and keeping size
              // uniform avoids the extra vertical clearance a bigger 'md'
              // card would otherwise force everywhere it might land.
              size="sm"
              highlight={bestCardRaws ? bestCardRaws.has(c.raw) : false}
              dim={bestCardRaws ? !bestCardRaws.has(c.raw) : false}
            />
          ))}
        </div>
      )}

      {revealedCards && revealedCards.length === 2 && (
        <div className="reveal-fold-show" style={sideStyle(cardsSide)}>
          <div className="reveal-showoff-tag">亮牌炫耀</div>
          <div className="reveal-showoff-cards">
            {revealedCards.map((c, i) => (
              <Card key={i} card={c} size="xs" animate="flip-reveal" delay={i * 0.1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
