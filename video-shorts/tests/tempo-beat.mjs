// video-shorts tests/tempo-beat.mjs — 2026-11-14 追加機能のテスト。
//   tempo の統計計算（tempoStats）と assemble の拍吸着計算（snapDurations）。
//   どちらも純粋関数のみを対象にする（実検出・実レンダリングは実走で確認）。
// 実行: node tests/tempo-beat.mjs（失敗時は終了コード 1）。

import assert from "node:assert/strict";

import { tempoStats } from "../src/tempo.mjs";
import { snapDurations } from "../src/assemble.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

check("tempo: シーン一覧から統計（数・平均・中央値・冒頭・最長）を計算する", () => {
  const scenes = [
    { start: 0, end: 3 }, { start: 3, end: 9 }, { start: 9, end: 17 },
    { start: 17, end: 25 }, { start: 25, end: 37 }, { start: 37, end: 44 },
  ];
  const st = tempoStats(scenes);
  assert.equal(st.count, 6);
  assert.equal(st.cuts, 5);
  assert.deepEqual(st.durations, [3, 6, 8, 8, 12, 7]);
  assert.equal(st.average, 7.33);
  assert.equal(st.median, 7.5);
  assert.equal(st.firstScene, 3);
  assert.equal(st.longest.index, 4);
  assert.equal(st.longest.duration, 12);
});

check("tempo: シーンが1つだけでも壊れない", () => {
  const st = tempoStats([{ start: 0, end: 10 }]);
  assert.equal(st.count, 1);
  assert.equal(st.cuts, 0);
  assert.equal(st.median, 10);
});

check("beat: 境界を一番近い拍へ吸着し、場面の長さで吸収する", () => {
  const beats = Array.from({ length: 21 }, (_, i) => i * 0.5); // 120 BPM
  const clips = [
    { start: 0, duration: 3.2, sourceDuration: 10 },
    { start: 0, duration: 4.1, sourceDuration: 10 },
  ];
  const out = snapDurations(clips, beats);
  assert.equal(out[0].snapped, true);
  assert.equal(out[0].duration, 3.0);
  assert.equal(out[0].target, 3.0);
  assert.equal(out[1].snapped, true);
  assert.equal(out[1].duration, 4.0);
  assert.equal(out[1].target, 7.0);
});

check("beat: 素材の尺を超える場合は開始秒を前へずらして収める", () => {
  const beats = Array.from({ length: 21 }, (_, i) => i * 0.5);
  const out = snapDurations([{ start: 6, duration: 3.4, sourceDuration: 9 }], beats);
  assert.equal(out[0].snapped, true);
  assert.equal(out[0].duration, 3.5);
  assert.equal(out[0].start, 5.5);
});

check("beat: どうしても収まらない境界は吸着しない", () => {
  const out = snapDurations([{ start: 0.2, duration: 3.2, sourceDuration: 3.4 }], [10]);
  assert.equal(out[0].snapped, false);
  assert.equal(out[0].duration, 3.2);
  assert.equal(out[0].start, 0.2);
});

check("beat: 拍が無い場合は何もしない", () => {
  const out = snapDurations([{ start: 0, duration: 3.2, sourceDuration: 10 }], []);
  assert.equal(out[0].snapped, false);
  assert.equal(out[0].duration, 3.2);
});

console.log(`\n${passed} 件すべて合格`);
