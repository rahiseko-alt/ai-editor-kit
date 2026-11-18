// video-shorts tests/reference.mjs — 2026-11-18 追加機能（参考動画の型）のテスト。
//   拍とカットの重なり（cutsOnBeat）、型のまとめ（referenceProfile）、
//   teardown の取り出し（pickTeardown）、場面の長さ合わせ（applyReferencePace）。
//   純粋関数のみを対象にする（実検出は合成の試験動画で実走して確認）。
// 実行: node tests/reference.mjs（失敗時は終了コード 1）。

import assert from "node:assert/strict";

import { cutsOnBeat, referenceProfile, pickTeardown, applyReferencePace } from "../src/reference.mjs";
import { tempoStats } from "../src/tempo.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

const beats120 = Array.from({ length: 37 }, (_, i) => i * 0.5); // 120 BPM・18秒

check("cutsOnBeat: 拍から許容幅以内のカットだけを数える", () => {
  const r = cutsOnBeat([3.0, 6.02, 10.23, 14.0], beats120);
  assert.equal(r.onBeat, 3);
  assert.equal(r.total, 4);
  assert.equal(r.pct, 75);
});

check("cutsOnBeat: カットか拍が無ければ割合は出さない", () => {
  assert.equal(cutsOnBeat([], beats120).pct, null);
  assert.equal(cutsOnBeat([3], []).pct, null);
});

const scenes = [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 10 }, { start: 10, end: 14 }, { start: 14, end: 18 }];
const tempo = { duration: 18, scenes, stats: tempoStats(scenes) };

check("referenceProfile: テンポだけでも型を出し、測れなかった項目を書く", () => {
  const p = referenceProfile({ tempo });
  assert.equal(p.pace.cuts, 4);
  assert.equal(p.pace.cutsPer10s, 2.22);
  assert.deepEqual(p.pace.shotDurations, [3, 3, 4, 4, 4]);
  assert.deepEqual(p.pace.cutTimes, [3, 6, 10, 14]);
  assert.equal(p.beat, null);
  assert.equal(p.suggest.bgmSync, null);
  assert.equal(p.notMeasured.length, 2);
});

check("referenceProfile: カットが拍に乗っていれば bgmSync を提案する", () => {
  const p = referenceProfile({ tempo, beat: { tempo: 120, beats: beats120 } });
  assert.equal(p.beat.cutsOnBeat.pct, 100);
  assert.equal(p.beat.syncedToBeat, true);
  assert.equal(p.suggest.bgmSync, true);
});

check("referenceProfile: 拍から外れたカットが多ければ bgmSync を提案しない", () => {
  const off = { duration: 18, scenes: [{ start: 0, end: 3.23 }, { start: 3.23, end: 6.27 }, { start: 6.27, end: 18 }] };
  off.stats = tempoStats(off.scenes);
  const p = referenceProfile({ tempo: off, beat: { tempo: 120, beats: beats120 } });
  assert.equal(p.beat.cutsOnBeat.pct, 0);
  assert.equal(p.suggest.bgmSync, false);
});

check("pickTeardown: ズーム・フラッシュ・遷移の種類を取り出す", () => {
  const td = pickTeardown({
    edit: { cuts: [{ t: 3, kind: "hard", conf: 0.8 }, { t: 5, kind: "flash", through: "white", conf: 0.6 }] },
    style: { zoom: { pushes: [{ start: 7.017, duration_s: 1, direction: "in", scale_from: 1, scale_to: 1.496, ease: "none" }] }, captions: { present: false } },
    sound: { sfx: [{ t: 2.49, kind: "whoosh" }] },
  });
  assert.deepEqual(td.flashes, [{ t: 5, through: "white" }]);
  assert.equal(td.zooms[0].scaleTo, 1.496);
  assert.equal(td.cutKinds.length, 2);
  assert.deepEqual(td.soundEffects, [{ t: 2.49, kind: "whoosh" }]);
  assert.equal(pickTeardown(null), null);
});

check("applyReferencePace: 場面の長さを参考のカット長の順に当て、足りなければ繰り返す", () => {
  const clips = [0, 1, 2].map(() => ({ start: 1, duration: 5, sourceDuration: 20 }));
  const out = applyReferencePace(clips, [2.5, 1.2]);
  assert.deepEqual(out.map((o) => o.duration), [2.5, 1.2, 2.5]);
  assert.ok(out.every((o) => o.paced && o.start === 1));
});

check("applyReferencePace: 素材の残りが足りなければ開始秒を前へずらす", () => {
  const out = applyReferencePace([{ start: 8, duration: 1, sourceDuration: 9 }], [3]);
  assert.equal(out[0].start, 6);
  assert.equal(out[0].duration, 3);
});

check("applyReferencePace: 素材そのものが短ければ素材の尺までに留める", () => {
  const out = applyReferencePace([{ start: 0, duration: 1, sourceDuration: 2 }], [3]);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].duration, 2);
  assert.equal(out[0].target, 3);
});

check("applyReferencePace: カット長が無ければ何もしない", () => {
  const out = applyReferencePace([{ start: 0, duration: 4, sourceDuration: 10 }], []);
  assert.equal(out[0].paced, false);
  assert.equal(out[0].duration, 4);
});

console.log(`\n${passed} 件すべて合格`);
