// Single place that decides "which DiceBear style is our avatar look" — swap
// the import/style here and every seat (table + settlement modal) picks it up,
// no per-component changes needed (user explicitly wants this easy to change
// later — see openspec design.md「玩家头像：micah 人像风格，本地确定性生成」).
import { createAvatar } from '@dicebear/core';
import { micah } from '@dicebear/collection';

const STYLE = micah;

// Seeded purely by playerId — same id always produces the same image on
// every client, so "the avatar I see for myself" and "the avatar everyone
// else sees of me" are guaranteed identical (user requirement) without any
// server-side assignment/storage at all. Memoized because PlayerSeat
// re-renders on every game:state tick; regenerating the SVG from scratch
// each time would be wasted work for a value that can never change for a
// given id.
const cache = new Map();

export function avatarUri(playerId) {
  let uri = cache.get(playerId);
  if (!uri) {
    uri = createAvatar(STYLE, { seed: String(playerId), size: 64 }).toDataUri();
    cache.set(playerId, uri);
  }
  return uri;
}
