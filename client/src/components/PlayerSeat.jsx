// Rail seat: avatar + unified position badge + platinum stack (styled by shared velvet.css).
// The action bubble (bet amount + category label, e.g. "加注 ¥40"/"小盲 ¥10")
// is this seat's only "what did they put in, and why" indicator — there's no
// separate bare-number bet-chip anymore, that duplicated the same info
// without the label (confirmed on a real device). Opponents' hole cards are
// never shown face-down pre-showdown (removed — they carried no information
// and only ate into the tight center-strip space); they only appear at real
// showdown.
import { useEffect, useRef } from 'react';
import { useThinkSeconds, useTurnClock } from '../hooks/useThinkSeconds';
import Card from './Card';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

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

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, cardsSide = null, bubbleSide = null, onPoke, poked = false, revealedCards = null, bestCardRaws = null, turnEndsAt = null, turnStartedAt = null, isSpeaking = false, getVoiceVolume = null }) {
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

  // 说话波纹的强度（0..1）来自 useVoiceMesh 的实时音量表，故意不通过 props
  // 传数值再让 React 重渲染——那张表每帧都在变，真做成 props/state 会在整
  // 段说话期间持续触发这个组件（以及它的 turn-ring/svg 子树）重渲染。改成
  // rAF 里直接读、直接写 DOM 节点的 CSS 变量，React 完全不知道这件事发生
  // 过，只有 isSpeaking 这个离散的开关走一次正常渲染。
  const rippleRef = useRef(null);
  useEffect(() => {
    if (!isSpeaking || !getVoiceVolume) return;
    let raf;
    const tick = () => {
      const vol = getVoiceVolume(player.id);
      rippleRef.current?.style.setProperty('--speak-intensity', vol.toFixed(3));
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
      </div>
      <div className={`avatar-card ${avClass}`} onClick={!isMe ? onPoke : undefined} role={!isMe ? 'button' : undefined}>
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
              style={{
                animationDuration: `${clock.totalMs}ms`,
                animationDelay: `-${clock.elapsedMs}ms`,
              }}
            />
          </svg>
        )}
        <div className="avatar-photo">
          {player.name[0].toUpperCase()}
          {/* 数字缩成右上角标，不再盖脸。没有倒计时（人机对战）时退回原来的
              正数计时显示，行为与改动前一致。 */}
          {isAction && (
            timed
              ? <div className={`turn-secs${urgent ? ' turn-secs--urgent' : ''}`}>{countdown}</div>
              : <div className="think-overlay">{thinkSeconds}s</div>
          )}
        </div>
        <div className="stack-chip-footer">¥{player.chips.toLocaleString()}</div>
      </div>

      {bubble && (
        <div
          key={bubble.key}
          className={`action-bubble${bubble.folded ? ' action-bubble--folded' : ''}`}
          style={bubbleStyle(bubbleSide)}
        >
          {bubble.text}
        </div>
      )}
      {poked && <div className="action-bubble poke-bubble" style={bubbleStyle(bubbleSide)}>戳了戳</div>}

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
