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
import eggSplatImg from '../assets/egg-splat.png';

const AV = ['av-green', 'av-purple', 'av-teal', 'av-rust', 'av-olive', 'av-blue', 'av-magenta', 'av-gold'];

// Full allowlist — must match server/index.js's POKE_EMOJI, since the
// server re-validates whatever it receives against its own copy rather
// than trusting the client. 🥚 additionally triggers the "egg splat"
// special effect below (GitHub #26) — same broadcast, just a richer
// render for this one glyph.
const POKE_EMOJI = ['😄', '😢', '👍', '😡', '❤️', '😂', '🥚', '☕️', '😈'];

// 两版纯 CSS 手画的"蛋壳裂开"（径向碎片版、两半壳分开版）用户都不满意，
// 换成用户直接找来的透明背景 PNG 素材（client/src/assets/egg-splat.png，
// 原图 1254×1254，本地用 sips 压到 320×320 再进仓库——原图 1.4MB 对一个
// 只在 56px 座位卡上短暂出现的特效来说太重，压完 140KB）。所以 🥚 重新
// 放回选择器。
const POKE_PICKER_EMOJI = POKE_EMOJI;

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
// anchorTop：顶排座位（TOP_ZONE 内，见 GameTable.jsx）离视口顶部很近，
// 真机上常常正好卡在浏览器自己的地址栏/导航条下面——原来的
// top:50%+translateY(-50%) 是"以座位为中心上下对称展开"，气泡/选择器
// 有一半的高度会往上探出视口，被导航栏遮住一截（用户反馈 2026-08-13，
// 真机截图确认过）。顶排座位改成从座位顶部往下长（top:0，不再居中），
// 气泡整体只会往座位下方展开，不会再往上探出视口。
function sideStyle(cardsSide, anchorTop) {
  const vAlign = anchorTop ? { top: '0', bottom: 'auto', transform: 'translateY(0)' } : { top: '50%', bottom: 'auto', transform: 'translateY(-50%)' };
  if (cardsSide === 'left') return { position: 'absolute', left: 'auto', right: 'calc(100% + 3px)', ...vAlign };
  if (cardsSide === 'right') return { position: 'absolute', left: 'calc(100% + 3px)', right: 'auto', ...vAlign };
  return { position: 'absolute', left: '50%', right: 'auto', bottom: 'calc(100% + 4px)', top: 'auto', transform: 'translateX(-50%)' };
}

// Hero's own bubble is the one case that still defaults to "above" (no
// bubbleSide passed) — hero sits centered at the bottom of the canvas with
// clear room above toward the community cards, confirmed via a real render;
// every other seat always gets an explicit side from GameTable now.
function bubbleStyle(bubbleSide, anchorTop) {
  return bubbleSide ? sideStyle(bubbleSide, anchorTop) : undefined;
}

export default function PlayerSeat({ player, isMe, isAction, isWinner, gamePhase, color = 0, bubble, cardsSide = null, bubbleSide = null, bubbleAnchorTop = false, onPoke, poked = false, pokeKey = null, pokeEmoji = null, pokeFromName = null, pokeThrowFrom = null, chatText = null, chatKey = null, revealedCards = null, bestCardRaws = null, turnEndsAt = null, turnStartedAt = null, isSpeaking = false, getVoiceVolume = null, paused = false, disconnected = false }) {
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

  // 座位震动（eggImpactShake，由 .seat.is-egg-hit .avatar-card 这条 CSS
  // 规则驱动）是三处"蛋特效"里唯一一个不能靠 key={pokeKey} 强制重挂来解决
  // 重播问题的——.poke-bubble/.egg-splat 是"poked 为真才整个挂载"的节点，
  // key 一变就直接换一个全新节点；但 is-egg-hit 只是加在始终挂载着的
  // .seat 外层 div 上的一个 class，同一个人短时间内被连续拍两下时这个
  // class 字符串本身没有任何变化（poked 全程为真），React 根本不会去碰
  // 这个 DOM 属性，浏览器自然也不会重播已经播完/仍在播的 CSS 动画。用
  // ref 直接在 --avatar-card 上把 animation 先置空再清空这个标准重播手法
  // （2026-08-13 真机 Playwright 实测确认过原因）：强制触发一次 reflow，
  // 让浏览器重新从 CSS 规则里读一遍 animation，等于每次拍都能拿到一次
  // 全新播放，不需要真的卸载重挂这个大节点（那样连带 speak-glow/turn-ring
  // 这些兄弟节点也会跟着重挂，代价更大）。
  const avatarCardRef = useRef(null);
  useEffect(() => {
    if (!(poked && pokeEmoji === '🥚')) return;
    const el = avatarCardRef.current;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pokeKey]);

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
    poked && pokeEmoji === '🥚' && 'is-egg-hit',
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
            纯展示，不带"帮TA弃牌"这个操作了——用户反馈（2026-08-12）：
            回合本身有 20 秒行动倒计时兜底（不看是否在线，到点自动弃牌/
            过牌），断线满一手未恢复还会被自动移出牌桌（见"断线跨手自动
            离座"），这两条已经解决了"一直卡着大家"的问题，房主手动帮TA
            弃牌顶多省 20 秒，却让标签显得莫名其妙。 */}
        {disconnected && <span className="disconnect-badge">断线中</span>}
      </div>
      {/* avatar-card-wrap：拍一拍蛋特效（.egg-splat）以前是 avatar-card 的
          直接子节点，弃牌玩家的 .is-folded .avatar-card 会给整块头像加
          grayscale/brightness 的 filter——filter 是按渲染出来的像素整体
          处理的，不是靠 CSS 继承传下去的，子节点没法用自己的 filter:none
          "撤销"父节点已经加上的效果，所以砸在弃牌玩家头上的蛋连同蛋壳图
          一起被染灰、变暗了（用户反馈，2026-08-13："为啥对弃牌玩家扔，
          鸡蛋也是灰的"）。拍一拍是独立于牌局折叠状态的社交反馈，不该被
          "这个人弃牌了所以画面变灰"的规则连带影响。修法是结构性的，不是
          给 .egg-splat 加一堆"取消变灰"的样式去对抗一个没法对抗的机制：
          把 .egg-splat 挪到 avatar-card 外面、作为它的兄弟节点，两者一起
          包在这层新的 avatar-card-wrap 里——wrap 跟 avatar-card 同宽
          （见 velvet.css），.egg-splat 的 inset:0 现在是相对 wrap 定位，
          视觉上完全贴合原来的头像区域，只是不再落在被弄灰的那棵子树里。 */}
      <div className="avatar-card-wrap">
      <div ref={avatarCardRef} className={`avatar-card ${avClass}`} onClick={handleAvatarClick} onDoubleClick={handleAvatarDoubleClick} role={canPoke ? 'button' : undefined} aria-label={canPoke ? '单击选表情拍一拍，双击直接拍一拍' : undefined}>
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
        {/* 表情特效（GitHub #26）——叠在目标座位头像上播一次的定点动画，
            跟 .poke-bubble 复用同一条 poked/pokeEmoji 触发信号。
            两版纯 CSS 手画的蛋壳裂开（径向碎片版、两半壳分开版）用户都
            不满意，2026-08-12 改成用户直接找的透明背景 PNG 素材
            （egg-splat.png）——落地瞬间蛋图标挤压消失（squash+闪光+座位
            震动，物理反馈这部分手感是对的，保留），紧接着淡入这张真实
            的蛋壳+蛋黄+蛋液图，比继续手画更可信。
            2026-08-13：蛋图标原本是"从正上方掉落"，先改成"从桌子中心被
            扔过去"，用户又反馈想要"真的从发起人头像扔到接收人头像"的抛
            物线。GameTable.jsx 现在按【发起人 pokedSeat.fromId 的座位坐
            标】（查不到才退回桌子中心）算 pokeThrowFrom，同样是"起点是
            反向偏移、终点是 (0,0)"这套跟发牌动画共用的技术，只是原点从
            固定的 DEAL_ORIGIN 换成了动态的发起人座位。--throw-arc 是抛
            物线弧顶高度（随距离缩放，GameTable.jsx 算好传下来），真正
            的弧线路径在 velvet.css 的 eggFall 关键帧里用 --throw-dx/
            --throw-dy/--throw-arc 三个变量算出来，不是简单直线位移。
            key={pokeKey}（同一个目标短时间内被连续拍第二下时才会显形的
            bug，2026-08-13 用户反馈"第一次点鸡蛋会卡住"排查确认）：拍同
            一个人两次、间隔小于 1.6s（pokedSeat 还没被上一次的 setTimeout
            清空）时，`poked` 这个布尔值全程为 true 没有变过 false 的间
            隙，React 不会卸载重挂载这个 div，只是 style 里的 --throw-dx
            等变量换了新值——但 CSS 动画只在元素被"新插入"DOM 时才会重新
            播放，同一个还在的节点第二次根本不会重播 keyframes，只会停在
            上一次动画播完/eggSquashVanish 收尾后的最终帧（挤扁、透明度
            0），看起来就是"卡住不动"。真机 Playwright 实测过：不加 key
            时，紧接着拍第二下，.egg-splat 节点确认是同一个 DOM 实例
            （reused: true），transform 全程停在 matrix(0.3,0,0,0.15,0,0)
            纹丝不动；加上 key={pokeKey}（pokedSeat.key，每次广播一个新
            的 Date.now()）后，每次拍都能拿到一个新节点，动画必定从头播。
            跟 .action-bubble 用 key={bubble.key}、turn-ring 用
            key={clock.key} 强制重播是同一个套路，不是新发明的写法。
            .egg-splat__icon 内层多包一个 .egg-splat__spin：旋转本来跟
            "沿抛物线移动/缩放"、跟"落地挤压"完全是两件不相干的事，之前
            把它们硬塞进同一个元素的同一个 transform 里（还要跟撞击挤压
            共用同一个旋转基准点），改一次牵连一次，越改越绕。拆开之后
            .egg-splat__icon 只管沿抛物线走的位置和缩放（不再有 rotate），
            .egg-splat__spin 只管原地转两圈，两者互不干扰，也不用再关心
            "旋转基准点跟撞击挤压那个基准点是不是打架"这种问题——见
            velvet.css 里 eggFall/eggSpin 各自的注释。 */}
      </div>
      {poked && pokeEmoji === '🥚' && (
        <div key={pokeKey} className="egg-splat" aria-hidden="true">
          <div className="egg-splat__flash" />
          <img className="egg-splat__img" src={eggSplatImg} alt="" />
          <div
            className="egg-splat__icon"
            style={pokeThrowFrom ? { '--throw-dx': `${pokeThrowFrom.dx}px`, '--throw-dy': `${pokeThrowFrom.dy}px`, '--throw-arc': `${pokeThrowFrom.arc ?? 42}px` } : undefined}
          ><span className="egg-splat__spin">🥚</span></div>
        </div>
      )}
      </div>

      {pokePickerOpen && (
        <div ref={pokePickerRef} className="poke-picker" style={bubbleStyle(bubbleSide, bubbleAnchorTop)} onClick={e => e.stopPropagation()}>
          {/* 纯"拍一拍"（不带表情）原来在这里也有个 ✋ 按钮，用户反馈
              （2026-08-12）：双击头像本身就能触发不带表情的拍一拍
              （handleAvatarDoubleClick，见上方），选择器里再放一个重复
              入口没必要，去掉后 8 个表情正好排成规整的 4×2 网格。 */}
          {POKE_PICKER_EMOJI.map(e => (
            <button key={e} type="button" className="poke-picker-emoji" onClick={() => sendPoke(e)}>{e}</button>
          ))}
        </div>
      )}

      {bubble && (
        <div
          key={bubble.key}
          className={`action-bubble${bubble.folded ? ' action-bubble--folded' : ''}${bubble.allIn ? ' action-bubble--allin' : ''}`}
          style={bubbleStyle(bubbleSide, bubbleAnchorTop)}
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
          形可突出，维持原来的胶囊样式就够。
          key={pokeKey}：跟上面 .egg-splat 同一个 bug、同一个原因——连续
          拍同一个人两下、间隔小于 1.6s 时 `poked` 不会经过 false，这个
          节点不会被卸载重挂，pokeBubbleIn/pokeBubbleOut 那套入场淡出动画
          第二次根本不会重播。 */}
      {/* z-index 直接拿 pokeKey/chatKey（两个都是 Date.now() 时间戳）当
          值——拍一拍和聊天气泡共用 .poke-bubble 这套视觉语言，同一个座位
          上偶尔会前后脚都有（比如拍了一下又立刻打字），"最近发生的盖在
          上面"应该按真实发生时间来，不是写死"聊天永远压表情"或者反过来
          （用户反馈明确要求这条）。时间戳本身就是天然递增的，直接当
          z-index 用比另外维护一套"谁在谁上面"的规则简单。 */}
      {poked && (
        pokeEmoji ? (
          <div key={pokeKey} className="poke-bubble poke-bubble--emoji" style={{ ...bubbleStyle(bubbleSide, bubbleAnchorTop), zIndex: pokeKey }}>
            <span className="poke-bubble__label">{pokeFromName ? `${pokeFromName} 给你` : '给你'}</span>
            <span className="poke-bubble__glyph">{pokeEmoji}</span>
          </div>
        ) : (
          <div key={pokeKey} className="poke-bubble poke-bubble--plain" style={{ ...bubbleStyle(bubbleSide, bubbleAnchorTop), zIndex: pokeKey }}>
            {pokeFromName ? `${pokeFromName} ` : ''}拍了拍
          </div>
        )
      )}

      {/* 打字聊天气泡（2026-08-15）——复用拍一拍这套 bubbleStyle 定位逻辑
          （同一个锚点系统），不是另起一套。跟拍一拍不同的是聊天没有
          "谁发给你"这个指向性，就是这个人自己说的话，直接显示文本，
          不需要发送者名字前缀（座位名字本身已经在头像上方显示）。 */}
      {chatText && (
        // 尾巴方向要跟着气泡实际贴在座位哪一侧走，不能写死指向正下方——
        // 只有本人（没传 bubbleSide，走"正上方"锚点）尾巴才朝下；对手座
        // 位的气泡是贴在座位左边或右边（bubbleSide 由 cardsSide 决定），
        // 尾巴要指向座位那一侧，不然"尾巴指向说话人"这个语义就反了（用
        // 户反馈发现的：一开始只测过本人视角，没看对手气泡）。
        // 外层（poke-bubble-anchor--chat）只管定位，不带任何动画/视觉样
        // 式；真正的气泡外观 + 弹出动画全放在内层（poke-bubble--chat）。
        // 分成两层是因为踩过坑：如果动画和"贴着座位居中"的定位共用同一
        // 个元素，定位靠的是 CSS `transform:translateX(-50%)`（本人视角）
        // 或者内联 `transform:translateY(...)`（对手视角，sideStyle() 塞
        // 进来的），动画本来想用独立的 scale/translate 属性去避免覆盖掉
        // 这个定位 transform——理论上两者能共存，但真机上表现不一致（用
        // 户反馈：本人视角看着像从右下角冒出来，对手视角干脆看不出动
        // 画）。分层之后外层只负责"贴在哪"，内层只负责"怎么弹出来"，两
        // 件事各自的 transform 互不相干，不用再赌浏览器怎么组合它们。
        <div
          key={chatKey}
          className="poke-bubble-anchor--chat"
          style={{ ...bubbleStyle(bubbleSide, bubbleAnchorTop), zIndex: chatKey }}
        >
          <div className={`poke-bubble--chat poke-bubble--chat-tail-${bubbleSide === 'left' ? 'right' : bubbleSide === 'right' ? 'left' : 'bottom'}`}>
            {/* 引号改用 CSS 画的装饰图形（.poke-bubble--chat 的 ::before），
                不再是文本里字面拼的“”字符——用户反馈"能否用设计做一下，
                而不是用文字"（2026-08-15）。文本节点这里只放纯文字。 */}
            <span className="poke-bubble__chat-text">{chatText}</span>
          </div>
        </div>
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
