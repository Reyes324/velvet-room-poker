// Turns a server action label ({ type, amount }) into the text + style flags
// shown in a seat's action bubble (GameTable.jsx). Shared by every socket
// handler that reacts to 'action:happened' (RoomPage.jsx, PvePage.jsx) so
// the mapping only lives in one place.
export function describeActionLabel(label) {
  if (label.type === 'fold') return { text: '弃牌', folded: true, allIn: false, raise: false };
  if (label.type === 'allin') return { text: `ALL IN ¥${label.amount.toLocaleString()}`, folded: false, allIn: true, raise: false };
  if (label.type === 'raise') return { text: `加注 ¥${label.amount.toLocaleString()}`, folded: false, allIn: false, raise: true };
  if (label.type === 'call') return { text: `跟注 ¥${label.amount.toLocaleString()}`, folded: false, allIn: false, raise: false };
  return { text: '过牌', folded: false, allIn: false, raise: false }; // check
}
