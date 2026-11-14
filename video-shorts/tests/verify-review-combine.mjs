// video-shorts tests/verify-review-combine.mjs — 2026-11-14 追加機能のテスト。
//   verify（文字起こし検証）/ 字幕の行頭禁則（packWordsIntoLines）/
//   review の字幕違反検出 / combine の区間計算（純粋部分）。
// 実行: node tests/verify-review-combine.mjs（失敗時は終了コード 1）。

import assert from "node:assert/strict";

import { verifyTranscript, findSoundGaps, findRepeats } from "../src/verify.mjs";
import { captionViolations } from "../src/review.mjs";
import { packWordsIntoLines } from "../src/edit-job.mjs";
import { validateSpec, escapeDrawtext } from "../src/assemble.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

check("verify: 確信度の低い語・句読点だけの語・繰り返し・長い語を拾う", () => {
  const words = [
    { w: "今日は", start: 0, end: 0.5, p: 0.99 },
    { w: "とりいとめんと", start: 0.5, end: 1.2, p: 0.21 },
    { w: "、", start: 1.2, end: 1.3, p: 0.9 },
    { w: "はい", start: 1.4, end: 1.6, p: 0.95 },
    { w: "はい", start: 1.7, end: 1.9, p: 0.95 },
    { w: "はい", start: 2.0, end: 2.2, p: 0.95 },
    { w: "あ".repeat(16), start: 2.3, end: 3.0, p: 0.9 },
  ];
  const { issues, total } = verifyTranscript({ words, silences: [], duration: 3 });
  assert.equal(issues.lowConfidence.length, 1);
  assert.equal(issues.lowConfidence[0].word, "とりいとめんと");
  assert.equal(issues.punctOnly.length, 1);
  assert.equal(issues.repeats.length, 1);
  assert.equal(issues.longTokens.length, 1);
  assert.ok(total >= 4);
});

check("verify: 音があるのに語が無い区間を拾う（無音区間は拾わない）", () => {
  const words = [{ w: "こんにちは", start: 0, end: 1, p: 0.9 }];
  // 0-10秒のうち 2-5秒だけが無音。5-10秒は音があるのに語が無い。
  const gaps = findSoundGaps(words, [{ start: 2, end: 5 }], 10, 3);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].start, 5);
  assert.deepEqual(findRepeats([{ w: "あ", start: 0, end: 1 }, { w: "あ", start: 1, end: 2 }]), []);
});

check("字幕: 行頭禁則（、で始まる行）を作らない", () => {
  const words = [{ w: "やったんですけど" }, { w: "、" }, { w: "そうですね" }];
  // 狭い予算で必ず折り返しが起きる条件にする
  const lines = packWordsIntoLines(words, 10, 100);
  for (const line of lines) assert.ok(!/^[、。，．！？」』）]/.test(line), `行頭禁則: ${line}`);
  assert.equal(lines.join(""), "やったんですけど、そうですね");
});

check("字幕: 長い語の文字単位分割でも行頭禁則を作らない", () => {
  const words = [{ w: "ああああああ、あああ" }];
  const lines = packWordsIntoLines(words, 250, 100);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(!line.startsWith("、"), `行頭禁則: ${line}`);
  assert.equal(lines.join(""), "ああああああ、あああ");
});

check("review: 字幕の行頭禁則と3行以上を検出する", () => {
  const ass = [
    "Dialogue: 0,0:00:01.00,0:00:03.00,Caption,,0,0,0,,やったんですけど\\N、",
    "Dialogue: 0,0:00:04.00,0:00:06.00,Caption,,0,0,0,,1行目\\N2行目\\N3行目",
    "Dialogue: 0,0:00:07.00,0:00:09.00,Caption,,0,0,0,,問題ない字幕です",
  ].join("\n");
  const v = captionViolations(ass);
  assert.equal(v.length, 2);
  assert.equal(v[0].kind, "行頭禁則");
  assert.equal(v[1].kind, "3行以上");
});

check("assemble: 指示ファイルの検査と drawtext のエスケープ", () => {
  const ok = validateSpec({ out: "test-reel", clips: [{ file: "a.mp4", start: 1, duration: 3, label: "Before" }] });
  assert.equal(ok.audio, "mute");
  assert.equal(ok.clips[0].telop, null);
  assert.throws(() => validateSpec({ out: "x", clips: [] }), /1つ以上/);
  assert.throws(() => validateSpec({ out: "x", audio: "loud", clips: [{ file: "a", start: 0, duration: 1 }] }), /"mute" か "keep"/);
  assert.throws(() => validateSpec({ out: "x", clips: [{ file: "a", start: 0, duration: 0 }] }), /duration/);
  assert.equal(escapeDrawtext("a:b'c"), "a\\:b\\'c");
});

console.log(`\n${passed} 件すべて合格`);
