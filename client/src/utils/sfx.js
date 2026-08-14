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

// Plain <audio>.volume tops out at 1 (its default — nothing here ever
// lowers it), which is already the loudest a pool element can go on its
// own. Knock's source recording just sits quieter than the other clips
// (user feedback, 2026-08-14: "过牌的声音...比较小"), and there's no audio
// tooling available to re-master the file itself, so getting it louder
// than its own native level takes routing it through a Web Audio GainNode
// instead — a gain node CAN multiply the signal past 1x, unlike the plain
// element property.
//
// Wiring this up is deliberately LAZY — done on the first real
// playSfx('knock') call, not up front when the pool is warmed at module
// load. An AudioContext constructed outside a user gesture starts (and on
// some browsers — notably WeChat's embedded browser, a very real target
// for a Chinese friend-group app — can get permanently stuck) 'suspended';
// resume() called later from a genuine click doesn't reliably recover it
// on every engine. Building the whole graph inside the first real click
// instead means the AudioContext is created in direct response to a
// gesture, the well-supported pattern every Web Audio guide recommends —
// not resumed after the fact. First version did this eagerly and the
// knock sfx went completely silent for the user in production (2026-08-14:
// "过牌声音怎么没了") — not a quieter-than-expected regression, a total
// silent failure, exactly what this eager-AudioContext trap causes.
const KNOCK_GAIN = 1.6;
let audioCtx = null;
let knockBoosted = false;

function ensureKnockBoost() {
  if (knockBoosted) return;
  knockBoosted = true;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const p = getSfxPool('knock');
  for (const audio of p.elements) {
    const source = audioCtx.createMediaElementSource(audio);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = KNOCK_GAIN;
    source.connect(gainNode).connect(audioCtx.destination);
  }
}

export function playSfx(name) {
  const src = SOURCES[name];
  if (!src) return;
  if (name === 'knock') {
    ensureKnockBoost();
    audioCtx.resume().catch(() => {}); // resolves immediately once already running
  }
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
// decoding these in the background. Just the plain elements — knock's
// Web Audio wiring (ensureKnockBoost) deliberately stays gesture-gated,
// see its own comment.
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
