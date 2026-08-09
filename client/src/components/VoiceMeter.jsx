// 实时音量条。/voice-check 和 /voice-pair 共用——两页对"有没有声音"必须用
// 同一个门槛判定（SOUND_THRESHOLD），否则会出现同一段声音一页说有、一页说没有。
import { SOUND_THRESHOLD } from '../utils/voice';

export default function VoiceMeter({ title, hint, level, peak }) {
  return (
    <div className="vc-meter">
      <div className="vc-meter-title">{title}</div>
      <div className="vc-meter-bar">
        <div className="vc-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        <div className="vc-meter-peak" style={{ left: `${Math.round(peak * 100)}%` }} />
      </div>
      <div className="vc-meter-hint">
        {hint}
        {peak > SOUND_THRESHOLD
          ? <strong className="vc-ok-text vc-meter-flag">已经检测到声音 ✓</strong>
          : <strong className="vc-warn vc-meter-flag">还没检测到声音</strong>}
      </div>
    </div>
  );
}
