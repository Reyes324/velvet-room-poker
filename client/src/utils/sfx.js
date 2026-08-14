import chipsCall from '../assets/sounds/chips-handle-3.ogg';
import chipsRaise from '../assets/sounds/raise.mp3';
import chipsAllIn from '../assets/sounds/all-in.mp3';
import dealSound from '../assets/sounds/deal.mp3';
import heroFlip from '../assets/sounds/card-slide-6.ogg';
import knock from '../assets/sounds/knock.mp3';

const SOURCES = {
  call: chipsCall,
  raise: chipsRaise,
  allin: chipsAllIn,
  deal: dealSound,
  heroFlip,
  knock,
};

// Kept only for playDealSfx below, which needs a stable reference to fade
// and pause the same element. Everything else uses a fresh `new Audio()`
// per play (see playSfx) so rapid-fire actions layer instead of one
// retrigger cutting off the previous play's tail.
const pool = {};

export function playSfx(name) {
  const src = SOURCES[name];
  if (!src) return;
  new Audio(src).play().catch(() => {}); // autoplay can be blocked before any user gesture — not worth surfacing
}

export function playActionSfx(type) {
  playSfx(type);
}

const KNOCK_GAP_MS = 220; // two raps read as one "check" gesture, not two separate actions

// Check reads as two short knocks, not one — two independent Audio
// instances (not the shared pool) so the second knock doesn't cut the
// first one's tail off by rewinding a shared element.
export function playCheckSfx() {
  const src = SOURCES.knock;
  if (!src) return;
  new Audio(src).play().catch(() => {});
  setTimeout(() => new Audio(src).play().catch(() => {}), KNOCK_GAP_MS);
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
