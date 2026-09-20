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

function DecisionRow({ decision, communityCards }) {
  const { street, action, toCall, verdict, evLoss, equity, requiredEquity } = decision;
  const isMistake = verdict === 'mistake';
  const amount = action === 'call' || action === 'fold' ? toCall : null;

  return (
    <div className={`rv-step${isMistake ? ' rv-step--mistake' : ''}`}>
      <div className="rv-step-main">
        <span className="rv-step-street">{STREET_LABEL[street] ?? street}</span>
        <span className="rv-step-action">
          {ACTION_LABEL[action] ?? action}
          {amount > 0 ? ` ¥${amount}` : ''}
        </span>
        <span className="rv-step-mark">
          {isMistake ? <span className="rv-loss">亏 ¥{Math.round(evLoss)}</span> : null}
          {verdict === 'ok' ? <span className="rv-ok">✓</span> : null}
        </span>
      </div>
      {isMistake && (
        <div className="rv-step-why">
          <div className="rv-why-board">
            {boardAt(street, communityCards).map((c, i) => <Card key={i} card={c} size="xs" />)}
            {street === 'preflop' ? <span className="rv-why-preflop">翻牌前</span> : null}
          </div>
          <div className="rv-why-text">
            {action === 'call'
              ? `这一注要跟 ¥${toCall}，底池 ¥${decision.pot}，需要 ${pct(requiredEquity)} 胜率才划算，你当时只有 ${pct(equity)}。`
              : `这里跟 ¥${toCall} 是划算的（需要 ${pct(requiredEquity)} 胜率，你有 ${pct(equity)}），弃掉等于把赢面让了出去。`}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HandReviewModal({
  hand, review, position, canPrev, canNext, onPrev, onNext, onClose,
}) {
  const decisions = review?.decisions ?? [];
  const mistakes = decisions.filter(d => d.verdict === 'mistake');
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

            <div className="rv-verdict">
              {mistakes.length === 0
                ? '这一手没有明显失误'
                : `这一手有 ${mistakes.length} 步亏了，合计 ¥${Math.round(review.totalEvLoss)}`}
            </div>

            <div className="rv-steps">
              {decisions.map((d, i) => (
                <DecisionRow key={i} decision={d} communityCards={hand?.communityCards ?? []} />
              ))}
            </div>

            {/* 只评价跟/弃是刻意的范围自律（见 design.md）。不说清楚的话，玩家
                会以为"没标红=这步打对了"，而主动下注那些步其实根本没被评价过。 */}
            <div className="rv-footnote">
              只评价面对下注时的跟牌和弃牌——这类决策的对错能由底池赔率算清楚。
              主动下注、加注下多少这些要看长远规划，暂时不下判断。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
