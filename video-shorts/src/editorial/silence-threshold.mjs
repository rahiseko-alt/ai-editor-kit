// video-shorts src/editorial/silence-threshold.mjs — 無音検出（silencedetect）の閾値を、素材の環境音から決める。
//
// 【なぜ要るか】2026-09-27、会見場で撮った素材（環境音の底が高い）で、固定 -30dB の無音検出が
// 1件も取れなかった。無音が無いと、文節が文や話者をまたいで繋がり（最大 28 秒の文節）、
// 切る位置も文字起こしの時刻のままになる（虎の巻 §8-E・§3-2）。
//
// 【何を測るか】silencedetect は RMS ではなく1サンプルごとの振幅で判定する。だから閾値は
// 短い窓（50ms）ごとの**ピーク値**の分布から決める。RMS で決めると、同じ素材でも
// 4〜6dB 低く出て、検出が0件のまま変わらなかった（実測）。
//
// 実測（50ms 窓のピーク値, dB）:
//   会見（騒がしい）  p10 -24.0 / p50 -17.0 → 閾値 -22.0（無音 426 件）
//   フリノバ（静か）  p10 -60.2 / p50 -11.6 → 閾値 -30.0（今までどおり）

/** 今までの固定値。静かな素材ではこれを使い続ける（閾値を下げると間の検出が減るため）。 */
export const BASE_SILENCE_DB = -30;
/** 環境音（ピークの下位10%）より何 dB 上を無音とみなすか。 */
export const NOISE_MARGIN_DB = 2;

/** 昇順に並べた配列の q パーセンタイル。 */
function percentile(sorted, q) {
  return sorted[Math.floor((q / 100) * (sorted.length - 1))];
}

/**
 * 50ms 窓ごとのピーク値（dB。無音は -Infinity でもよい）から、silencedetect の閾値（dB）を決める。
 * - 環境音 = ピークの下位10%。閾値はその NOISE_MARGIN_DB 上。
 * - ただし BASE_SILENCE_DB より低くはしない（静かな素材は今までどおり）。
 * - 発話の中央値との中間より上にはしない（話し声そのものを無音とみなさない）。
 * @param {number[]} peaksDb
 */
export function chooseSilenceThresholdDb(peaksDb) {
  const v = peaksDb.map((x) => (Number.isFinite(x) ? x : -120)).sort((a, b) => a - b);
  if (v.length === 0) return BASE_SILENCE_DB;
  const noise = percentile(v, 10);
  const median = percentile(v, 50);
  const raised = Math.min(noise + NOISE_MARGIN_DB, (noise + median) / 2);
  return Math.max(BASE_SILENCE_DB, +raised.toFixed(1));
}
