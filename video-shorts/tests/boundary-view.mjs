// video-shorts tests/boundary-view.mjs — 境界の画像化検品（src/inspect/boundary-view.mjs）の
// 純粋な計算部分のテスト。実行: node tests/boundary-view.mjs（失敗時は終了コード 1）。
// 画像生成そのものの確認は合成素材での実走で行う（このファイルでは行わない）。

import assert from "node:assert/strict";

import {
  analyzeBoundaryAudio,
  buildBoundaries,
  mapWordsToOutput,
  suspectFlags,
} from "../src/inspect/boundary-view.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

// 境界一覧: 区間の繋ぎ目と、言い淀み除去で割れた繋ぎ目（同じ segment）を区別し、
// 出力時刻は区間の長さの累積で出す。
check("buildBoundaries は出力時刻・種類・語尾/語頭の余白を出す", () => {
  const units = [
    { w: "最初の文節です", start: 0.0, end: 2.0 },
    { w: "次の話題です", start: 3.0, end: 5.0 },
    { w: "続きです", start: 5.4, end: 7.0 },
  ];
  const ranges = [
    { start: 0.2, end: 2.5, segment: 0, fromUnit: 0, toUnit: 0 },
    { start: 2.8, end: 5.5, segment: 1, fromUnit: 1, toUnit: 1 },
    { start: 5.6, end: 7.3, segment: 1, fromUnit: 2, toUnit: 2 },
  ];
  const b = buildBoundaries(ranges, units);
  assert.equal(b.length, 2);
  assert.equal(b[0].at, 2.3);
  assert.equal(b[0].kind, "segment");
  assert.equal(b[0].beforeUnit, "最初の文節です");
  assert.equal(b[0].afterUnit, "次の話題です");
  assert.equal(b[0].tailGapSec, 0.5);
  assert.equal(b[0].headGapSec, 0.2);
  assert.equal(b[1].at, 5.0);
  assert.equal(b[1].kind, "filler");
});

// 語の写像: 区間ごとにずらし、区間外の語は含めない。
check("mapWordsToOutput は区間ごとに時刻をずらす", () => {
  const ranges = [
    { start: 10, end: 12 },
    { start: 20, end: 21 },
  ];
  const words = [
    { w: "あ", start: 10.5, end: 11.0 },
    { w: "外", start: 15.0, end: 15.5 },
    { w: "い", start: 20.2, end: 20.6 },
  ];
  const out = mapWordsToOutput(ranges, words);
  assert.deepEqual(out.map((w) => w.w), ["あ", "い"]);
  assert.equal(out[1].start, 2.2);
});

// 波形解析: 境界に完全な無音が続く場合は、その長さと左右を返す。
check("analyzeBoundaryAudio は境界の完全な無音を測る", () => {
  const sr = 48000;
  const samples = new Int16Array(sr * 3);
  // 境界（1.5秒）を含む 1.2〜1.8 秒だけを無音にし、他は発話らしい振幅にする。
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    samples[i] = t >= 1.2 && t < 1.8 ? 0 : Math.round(12000 * Math.sin(i / 7));
  }
  const a = analyzeBoundaryAudio(samples, sr, 1.5);
  assert.ok(a.digitalSilenceAtBoundarySec >= 0.55, `無音の長さが短すぎる: ${a.digitalSilenceAtBoundarySec}`);
  assert.ok(a.digitalSilenceLeftSec >= 0.25 && a.digitalSilenceRightSec >= 0.25,
    `左右の無音が取れていない: ${a.digitalSilenceLeftSec}/${a.digitalSilenceRightSec}`);
  assert.ok(a.shadeSilences.some((s) => s.start <= 1.5 && s.end >= 1.5), "陰影用の無音区間に境界が含まれない");
});

// 疑い: 境界にだけ挟まった短い完全な無音は「切れ込み」として立つ。
// 長い無音は、素材の間が残っている可能性として別の文面で立つ。
check("suspectFlags は短い切れ込みと長い無音を区別する", () => {
  const base = { maxJumpNearBoundary: 0.05, p95Jump: 0.04 };
  const notch = suspectFlags(
    { tailGapSec: 0.5, headGapSec: 0.5 },
    { ...base, digitalSilenceAtBoundarySec: 0.1, digitalSilenceLeftSec: 0.05, digitalSilenceRightSec: 0.05 }
  );
  assert.ok(notch.some((f) => f.includes("切れ込み")), `切れ込みが立っていない: ${notch.join(" / ")}`);
  const long = suspectFlags(
    { tailGapSec: 0.5, headGapSec: 0.5 },
    { ...base, digitalSilenceAtBoundarySec: 1.2, digitalSilenceLeftSec: 0.6, digitalSilenceRightSec: 0.6 }
  );
  assert.ok(long.some((f) => f.includes("素材の間")), `長い無音の文面が違う: ${long.join(" / ")}`);
  assert.ok(!long.some((f) => f.includes("切れ込み")), "長い無音を切れ込みと誤表示している");
});

// 波形解析: 境界で振幅が不連続に跳ねる場合は、段差として拾う。
check("analyzeBoundaryAudio は境界の跳ね上がりを測る", () => {
  const sr = 48000;
  const samples = new Int16Array(sr);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(3000 * Math.sin(i / 9));
  const at = Math.round(0.5 * sr);
  samples[at] = 30000; // 境界の標本だけ跳ねさせる（プツッの模擬）
  const a = analyzeBoundaryAudio(samples, sr, 0.5);
  assert.ok(a.maxJumpNearBoundary > 0.8, `跳ね上がりが取れていない: ${a.maxJumpNearBoundary}`);
  const flags = suspectFlags({ tailGapSec: 0.5, headGapSec: 0.5 }, a);
  assert.ok(flags.some((f) => f.includes("プツッ")), `プツッの疑いが立っていない: ${flags.join(" / ")}`);
});

// 疑い: 語尾・語頭の余白が小さい場合にだけ立つ。余白が十分なら立たない。
check("suspectFlags は余白の小さい境界だけを疑う", () => {
  const quiet = {
    digitalSilenceAtBoundarySec: 0, digitalSilenceLeftSec: 0, digitalSilenceRightSec: 0,
    maxJumpNearBoundary: 0.05, p95Jump: 0.04,
  };
  assert.equal(suspectFlags({ tailGapSec: 0.5, headGapSec: 0.4 }, quiet).length, 0);
  const flags = suspectFlags({ tailGapSec: 0.02, headGapSec: 0.01 }, quiet);
  assert.equal(flags.length, 2);
});

console.log(`\n${passed} 件すべて通りました。`);
