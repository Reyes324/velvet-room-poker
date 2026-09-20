import Card from './Card';

// 逐手复盘面板（扑克教练，2026-09-20，形态由用户在方案对比里选定：逐手翻页
// 而不是"只挑亏得最多的几手"）。判定本身全部在服务端 handReview.js 算好，
// 这里只负责把结论讲成人话——不在客户端重算任何牌理。
//
// 复用 hh-panel-* 那套面板外壳（牌局记录已经在用），只新增内部的 rv-* 类，
// 避免同一个产品里出现两种不同风格的全屏面板。

const STREET_LABEL = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
const ACTION_LABEL = { fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: '全下' };
const BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 };

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

// 按街切出决策当时看得到的桌面——复盘的重点是"你当时知道什么"，把河牌那张
// 提前摆出来会让转牌的判断显得莫名其妙。
function boardAt(street, communityCards = []) {
  return communityCards.slice(0, BOARD_SIZE[street] ?? 0);
}

// 每一步都要有话说（用户反馈 2026-09-20："为什么复盘只讲亏的呀？其他呢？"）。
// 之前打得好的那些只给一个静默的对勾——需要 25% 胜率你有 61% 的漂亮跟注，和
// 需要 32% 你有 33% 的勉强跟注，长得一模一样；该弃就弃明明省下了真金白银，
// 也完全看不见。更麻烦的是主动下注那些行整行空白，人会读成"没标红就是没问
// 题"，而实际含义是"这一步根本没评价过"——所以未评价必须**显式写出来**。
function markOf(decision) {
  const { verdict, action, evLoss, evSaved } = decision;
  if (verdict === 'mistake') return { cls: 'rv-loss', text: `亏 ¥${Math.round(evLoss)}` };
  if (verdict === 'ok') {
    if (action === 'fold' && evSaved > 0) return { cls: 'rv-good', text: `省下 ¥${Math.round(evSaved)}` };
    return { cls: 'rv-good', text: '✓ 划算' };
  }
  return { cls: 'rv-unjudged', text: '未评价' };
}

function DecisionRow({ decision, communityCards, detailed }) {
  const { street, action, toCall, verdict, equity, requiredEquity } = decision;
  const isMistake = verdict === 'mistake';
  const judged = verdict === 'mistake' || verdict === 'ok';
  const amount = action === 'call' || action === 'fold' ? toCall : null;
  const mark = markOf(decision);

  return (
    <div className={`rv-step${isMistake ? ' rv-step--mistake' : ''}`}>
      <div className="rv-step-main">
        <span className="rv-step-street">{STREET_LABEL[street] ?? street}</span>
        <span className="rv-step-action">
          {ACTION_LABEL[action] ?? action}
          {amount > 0 ? ` ¥${amount}` : ''}
        </span>
        <span className={`rv-step-mark ${mark.cls}`}>{mark.text}</span>
      </div>

      {/* 判定过的每一步都把两个胜率摆出来——差多少个百分点，是"这步有多对/
          多错"唯一能量化的东西，只有失误才配看到它没有道理。
          没判定的也给出当时的胜率：这是事实不是判断，不违反"算不清就不下结
          论"那条自律，却能让全程过牌那种一手也看得到牌力是怎么走的——否则
          整屏四行"未评价"，等于什么都没说。 */}
      <div className="rv-step-margin">
        {judged
          ? `需要 ${pct(requiredEquity)} 胜率，你有 ${pct(equity)}`
          : `当时胜率 ${pct(equity)}`}
      </div>

      {/* 完整解释只给这一手里亏得最多的那一步（detailed）。一手牌连着三次
          胜率不够还跟，每行都贴一遍牌面、再念一遍同样那句"长期打下去是净亏
          的"，读起来像念经，真正该被看见的那一步反而淹在重复里——其余失误
          行有上面的"亏 ¥X"和两个胜率就够说明问题了。 */}
      {isMistake && detailed && (
        <div className="rv-step-why">
          <div className="rv-why-board">
            {boardAt(street, communityCards).map((c, i) => <Card key={i} card={c} size="xs" />)}
            {street === 'preflop' ? <span className="rv-why-preflop">翻牌前</span> : null}
          </div>
          <div className="rv-why-text">
            {action === 'call'
              ? `这一注要跟 ¥${toCall}，底池 ¥${decision.pot}，胜率不够还是跟了，长期打下去这种跟注是净亏的。`
              : `这里跟 ¥${toCall} 其实是划算的，弃掉等于把赢面让了出去。`}
          </div>
        </div>
      )}
    </div>
  );
}

// 把"这手输赢多少"和"决策对不对"摆在一起讲。德扑最要紧的一课就是这两件事
// 不是一回事——只给判定不给结果，人会本能地拿输赢反推自己打得好不好；只给
// 结果不给判定，那就只是记账，不是教练。
function summarize(net, judged, mistakeList, totalEvLoss) {
  const mistakes = mistakeList.length;
  const money = `¥${Math.abs(Math.round(net))}`;
  const outcome = net > 0 ? `这手你赢了 ${money}` : net < 0 ? `这手你输了 ${money}` : '这手你没输没赢';
  if (judged === 0) return `${outcome}。这手没有需要判断的跟牌或弃牌。`;
  if (mistakes === 0) {
    return net < 0
      ? `${outcome}——但决策没有问题，是牌不好，不是你打错了。`
      : `${outcome}，${judged} 步决策也都是对的。`;
  }
  const lost = `¥${Math.round(totalEvLoss)}`;
  // 点名亏得最多的那条街。一手里连着几步都打错时，"哪一步最要命"比"错了几
  // 步"更有指导意义——要改也是先改那一步。
  const worst = mistakeList.reduce((a, b) => (b.evLoss > a.evLoss ? b : a));
  const where = `主要亏在${STREET_LABEL[worst.street] ?? worst.street}圈那次${ACTION_LABEL[worst.action] ?? '决策'}`;
  return net > 0
    ? `${outcome}——不过有 ${mistakes} 步其实是亏的（约 ${lost}），${where}，这次是运气帮了忙。`
    : `${outcome}，其中约 ${lost} 是打错了亏的，${where}。`;
}

export default function HandReviewModal({
  hand, review, position, canPrev, canNext, onPrev, onNext, onClose,
}) {
  const decisions = review?.decisions ?? [];
  const mistakes = decisions.filter(d => d.verdict === 'mistake');
  // 亏得最多的那一步：顶部点名它，行内也只有它展开完整解释。
  const worstMistake = mistakes.length
    ? mistakes.reduce((a, b) => (b.evLoss > a.evLoss ? b : a))
    : null;
  const myCards = hand?.reveals?.find(r => r.id === review?.playerId)?.holeCards
    ?? hand?.reveals?.[0]?.holeCards;

  return (
    <div className="hh-panel-overlay" onClick={onClose}>
      <div className="hh-panel" onClick={e => e.stopPropagation()}>
        <div className="hh-panel-header">
          <div className="hh-panel-back" onClick={onClose}>‹</div>
          <div className="hh-panel-title">复盘</div>
          <div className="hh-panel-count">{position}</div>
        </div>

        <div className="rv-pager">
          <button className="rv-pager-btn" disabled={!canPrev} onClick={onPrev}>‹ 上一手</button>
          <button className="rv-pager-btn" disabled={!canNext} onClick={onNext}>下一手 ›</button>
        </div>

        {!review ? (
          <div className="hh-empty">正在算…</div>
        ) : !review.reviewable ? (
          // 多人桌里早早弃牌又没进摊牌时，记录里可能没留下自己的底牌。如实说
          // 明，不猜牌、也不假装复盘过了。
          <div className="hh-empty">这一手没有记录到你的底牌，没法复盘</div>
        ) : (
          <div className="rv-body">
            <div className="rv-context">
              <div className="rv-context-row">
                <span className="rv-context-label">你的牌</span>
                <span className="rv-cards">
                  {(myCards ?? []).map((c, i) => <Card key={i} card={c} size="sm" />)}
                </span>
              </div>
              <div className="rv-context-row">
                <span className="rv-context-label">桌面</span>
                <span className="rv-cards">
                  {(hand?.communityCards ?? []).map((c, i) => <Card key={i} card={c} size="sm" />)}
                </span>
              </div>
            </div>

            <div className={`rv-verdict${mistakes.length === 0 ? ' rv-verdict--clean' : ''}`}>
              {summarize(
                review.net ?? 0,
                decisions.filter(d => d.verdict === 'mistake' || d.verdict === 'ok').length,
                mistakes,
                review.totalEvLoss ?? 0,
              )}
            </div>

            <div className="rv-steps">
              {decisions.map((d, i) => (
                <DecisionRow
                  key={i}
                  decision={d}
                  communityCards={hand?.communityCards ?? []}
                  detailed={d === worstMistake}
                />
              ))}
            </div>

            {/* 只评价跟/弃是刻意的范围自律（见 design.md）。行内已经把未评价的
                步骤显式标出来了，这里补一句为什么，免得看起来像漏算。 */}
            <div className="rv-footnote">
              标"未评价"的是主动下注、加注这类——下多少、什么时候诈唬要看长远规划，
              算不清楚就不下判断。跟牌和弃牌的对错能由底池赔率算准，所以只评价这两种。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
