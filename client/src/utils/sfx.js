import chipsCall from '../assets/sounds/chips-handle-3.ogg';
import chipsRaise from '../assets/sounds/raise.mp3';
import chipsAllIn from '../assets/sounds/all-in.mp3';
import dealSound from '../assets/sounds/deal.mp3';
import knock from '../assets/sounds/knock.mp3';

const SOURCES = {
  call: chipsCall,
  raise: chipsRaise,
  allin: chipsAllIn,
  deal: dealSound,
  knock,
};

// `pool.deal` below is playDealSfx's own single stable element (it fades
// and pauses that exact instance, so it can't rotate). Everything else uses
// playSfx's rotating pools, built by getPool.
const pool = {};

// playSfx used to do `new Audio(src).play()` on every call — fixed the
// "retriggering cuts off the previous play's tail" bug (rapid actions all
// shared one reused element), but traded it for a different, less visible
// one: a brand-new Audio element hasn't decoded anything yet, so `.play()`
// returns immediately while the browser is still fetching/decoding —
// measured 6-32ms of real silence between the `.play()` call and the sound
// actually becoming audible (Chrome's `playing` event), consistently
// landing AFTER the action bubble (itself driven by a separate, faster
// path — see server/index.js's action:happened) already rendered. User
// feedback: "现在是声音后置出来的，甚至是气泡出来了才出声音" — confirmed by
// instrumenting HTMLMediaElement.prototype.play + the `playing` event in a
// real two-browser Playwright run, not assumed.
//
// Fix: a small round-robin pool of Audio elements per sound, created and
// preloaded eagerly at module load (this file is imported well before
// anyone can act — during room/lobby setup, seconds before the first
// action is possible) — so the decode cost is paid in the background,
// off the critical path of an actual play, while overlapping plays still
// land on different elements and don't cut each other off.
const POOL_SIZE = 4;
const sfxPools = {};

function getSfxPool(name) {
  let p = sfxPools[name];
  if (p) return p;
  const src = SOURCES[name];
  p = { elements: Array.from({ length: POOL_SIZE }, () => {
    const audio = new Audio(src);
    audio.preload = 'auto';
    return audio;
  }), next: 0 };
  sfxPools[name] = p;
  return p;
}

export function playSfx(name) {
  const src = SOURCES[name];
  if (!src) return;
  const p = getSfxPool(name);
  const audio = p.elements[p.next];
  p.next = (p.next + 1) % p.elements.length;
  audio.currentTime = 0;
  audio.play().catch(() => {}); // autoplay can be blocked before any user gesture — not worth surfacing
}

// Warms every non-deal sound's pool as soon as this module loads (deal's
// own pool.deal element preloads itself the first time playDealSfx runs,
// which is fine — there's only ever one deal-in per hand, no rapid-fire
// concern, and it's a much bigger file not worth eagerly fetching before
// anyone's even in a game). By the time a player can actually click
// something, the browser has had the entire room/lobby setup to finish
// decoding these in the background.
for (const name of Object.keys(SOURCES)) {
  if (name !== 'deal') getSfxPool(name);
}

export function playActionSfx(type) {
  playSfx(type);
}

// Maps a server action label ({ type, amount }) straight to its sfx —
// shared by RoomPage and PvePage's own `action:happened` socket handlers
// (see server/index.js's actionHappenedPayload) so the branch (call/raise/
// allin get a chip sound, check gets its own two-knock sound, fold stays
// silent) isn't duplicated between them.
export function playActionFeedbackSfx(label) {
  if (!label) return;
  if (label.type === 'call' || label.type === 'raise' || label.type === 'allin') playActionSfx(label.type);
  else if (label.type === 'check') playCheckSfx();
}

const KNOCK_GAP_MS = 220; // two raps read as one "check" gesture, not two separate actions

// Check reads as two short knocks, not one — two playSfx('knock') calls
// 220ms apart, each landing on a different pooled element (see playSfx)
// so the second knock doesn't cut the first one's tail off.
export function playCheckSfx() {
  playSfx('knock');
  setTimeout(() => playSfx('knock'), KNOCK_GAP_MS);
}

const DEAL_FADE_MS = 150;

// The deal-in animation's own duration (GameTable's totalDealTime) varies
// with player count, but the source clip is a fixed 4s recording — this cuts
// it off at whatever the real animation duration is instead of always
// playing the full clip, with a short fade so the cut isn't audibly abrupt.
// Clips shorter than the requested duration just play out naturally (the
// clip's own baked-in tail fade handles that case).
export function playDealSfx(durationSeconds) {
  const src = SOURCES.deal;
  if (!src) return;
  let audio = pool.deal;
  if (!audio) {
    audio = new Audio(src);
    pool.deal = audio;
  }
  audio.currentTime = 0;
  audio.volume = 1;
  audio.play().catch(() => {});

  const cutMs = Math.max(0, durationSeconds * 1000 - DEAL_FADE_MS);
  const fadeStart = setTimeout(() => {
    const steps = 10;
    let i = 0;
    const fade = setInterval(() => {
      i += 1;
      audio.volume = Math.max(0, 1 - i / steps);
      if (i >= steps) {
        clearInterval(fade);
        audio.pause();
      }
    }, DEAL_FADE_MS / steps);
  }, cutMs);

  // Let the caller cancel the scheduled cutoff (e.g. component unmounts
  // mid-deal, or a new hand's effect re-fires before this one's timer land).
  return () => clearTimeout(fadeStart);
}
