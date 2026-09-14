// Turns a server action label ({ type, amount }) into the text + style flags
// shown in a seat's action bubble (GameTable.jsx). Shared by every socket
// handler that reacts to 'action:happened' (RoomPage.jsx, PvePage.jsx) so
// the mapping only lives in one place.
//
// Amount-bearing actions return `text: null` plus `amountPrefix`/`amount`
// instead of a single pre-joined string — this file is plain .js (no JSX
// loader), so it can't render the shared <ChipIcon/> itself. PlayerSeat.jsx
// (the only place that ever displays bubble.text) assembles the actual
// "prefix + icon + number" JSX from these two fields; fold/check have no
// amount and keep going through the plain `text` field unchanged.
export function describeActionLabel(label) {
  if (label.type === 'fold') return { text: '弃牌', folded: true, allIn: false, raise: false };
  if (label.type === 'allin') return { text: null, amountPrefix: 'ALL IN ', amount: label.amount, folded: false, allIn: true, raise: false };
  if (label.type === 'raise') return { text: null, amountPrefix: '加注 ', amount: label.amount, folded: false, allIn: false, raise: true };
  if (label.type === 'call') return { text: null, amountPrefix: '跟注 ', amount: label.amount, folded: false, allIn: false, raise: false };
  return { text: '过牌', folded: false, allIn: false, raise: false }; // check
}
