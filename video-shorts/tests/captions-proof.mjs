// video-shorts tests/captions-proof.mjs — 2026-11-14 追加機能のテスト。
//   字幕校正の工程: captions 生成（キュー生成・用語辞書の適用）/
//   読みやすさ検証（CPS・行長・行数・表示時間）/ 校正記録の照合（門番）/
//   時刻改変の検出 / render の門番関数 assertCaptionsProofed（renderMain が呼ぶものそのもの）。
// 実行: node tests/captions-proof.mjs（失敗時は終了コード 1）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkReadability,
  parseAssDialogues,
  collectVerifyFlags,
  checkProof,
  assertCaptionsProofed,
  cueProvenance,
  formatCaptionsTxt,
} from "../src/captions.mjs";
import { applyTermCorrections, buildCaptionCues, renderAssText } from "../src/edit-job.mjs";
import { sha256 } from "../src/editorial/approval.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

// ---------- 生成（固定データ） ----------
check("captions生成: 固定データからキューができ、時刻が単調で本文が入る", () => {
  const words = [];
  const texts = ["今日は", "椎間板の", "話を", "します。", "よろしく", "お願い", "します。"];
  texts.forEach((w, i) => words.push({ w, start: i * 0.5, end: i * 0.5 + 0.45 }));
  const { cues } = buildCaptionCues({ words }, [{ start: 0, end: 3.5 }], { width: 1080, height: 1920 }, null);
  assert.ok(cues.length >= 1);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].start);
  assert.ok(cues.map((c) => c.text).join("").replace(/\\N/g, "").includes("椎間板の話をします"));
});

check("用語辞書: 決定的な誤変換はプログラムが置換する", () => {
  assert.equal(applyTermCorrections("追患版と追間板"), "椎間板と椎間板");
  assert.equal(applyTermCorrections("関係ない文"), "関係ない文");
});

check("ASS往復: renderAssText で書いた字幕を parseAssDialogues で同じに読み戻せる", () => {
  const cues = [
    { start: 0, end: 2, text: "こんにちは" },
    { start: 2.5, end: 5.25, text: "二行に\\N分かれる字幕" },
  ];
  const back = parseAssDialogues(renderAssText(cues, { width: 1080, height: 1920 }));
  assert.deepEqual(back, cues);
});

// ---------- 読みやすさ検証 ----------
check("読みやすさ: CPS・行長・行数・表示時間の違反をそれぞれ数える", () => {
  const cues = [
    { start: 0, end: 2, text: "短い字幕" }, // 正常（5字/2秒）
    { start: 2, end: 3, text: "あ".repeat(10) }, // CPS 10 → cps
    { start: 3, end: 9, text: "あ".repeat(17) }, // 1行17字 → lineLength
    { start: 9, end: 15, text: "あ\\Nい\\Nう" }, // 3行 → lines（行長・CPSは正常）
    { start: 15, end: 15.3, text: "あ" }, // 0.3秒 → duration
  ];
  const v = checkReadability(cues);
  const byRule = {};
  for (const x of v) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
  assert.deepEqual(byRule, { cps: 1, lineLength: 1, lines: 1, duration: 1 });
  assert.deepEqual(checkReadability([cues[0]]), []);
});

// ---------- 検証フラグの範囲判定 ----------
const plan = { segments: [{ fromUnit: 0, toUnit: 1 }] };
const units = [
  { start: 0, end: 2, w: "こんにちは" },
  { start: 2, end: 4, w: "世界" },
];
const planText = JSON.stringify(plan);
const verifyReport = {
  issues: {
    lowConfidence: [
      { index: 0, word: "かんしょく", p: 0.3, start: 1.0, end: 1.4, context: "前後" },
      { index: 9, word: "範囲外", p: 0.2, start: 100, end: 101, context: "外" },
    ],
    punctOnly: [],
    longTokens: [],
    repeats: [],
    soundGaps: [],
    dictHits: [{ wrong: "追患版", right: "椎間板" }],
  },
};

check("検証フラグ: 使用範囲内だけを集め、dictHits は常に対象にする", () => {
  const flags = collectVerifyFlags(verifyReport, plan, units);
  assert.deepEqual(flags.map((f) => f.id), ["lowConfidence:0", "dictHits:0"]);
});

check("由来: キューの文節範囲を区間対応表から決める", () => {
  const spans = [
    { outStart: 0, outEnd: 4, srcStart: 0, srcEnd: 4, segment: 0, fromUnit: 0, toUnit: 1 },
  ];
  const p = cueProvenance({ start: 2.1, end: 3.9 }, spans, units);
  assert.deepEqual(p, { segment: 0, fromUnit: 1, toUnit: 1 });
});

// ---------- 校正の照合（門番） ----------
function makeWorkDir({ assCues, genCues, proof }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "captions-proof-"));
  fs.writeFileSync(
    path.join(dir, "captions.json"),
    JSON.stringify({ planHash: sha256(planText), generatedAt: "2026-11-14T00:00:00.000Z", cues: genCues })
  );
  fs.writeFileSync(path.join(dir, "captions.ass"), renderAssText(assCues, { width: 1080, height: 1920 }));
  fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(verifyReport));
  if (proof !== undefined) fs.writeFileSync(path.join(dir, "proof.json"), JSON.stringify(proof));
  return dir;
}
const baseCue = { start: 0, end: 2, text: "こんにちは" };
const fullAnswers = [
  { flag: "lowConfidence:0", action: "そのまま", note: "聞き直して正しいことを確認" },
  { flag: "dictHits:0", action: "そのまま", note: "使用範囲には現れない" },
];
const gate = (dir) => checkProof({ workDir: dir, planText, plan, units });

check("門番: proof.json が無ければ拒否する（render は焼けない）", () => {
  const dir = makeWorkDir({ assCues: [baseCue], genCues: [baseCue] });
  const problems = gate(dir);
  assert.ok(problems.some((p) => p.includes("proof.json")));
  assert.throws(() => assertCaptionsProofed({ workDir: dir, planText, plan, units }), /字幕校正が完了していません/);
});

check("門番: フラグへの回答が欠けていれば拒否する", () => {
  const dir = makeWorkDir({
    assCues: [baseCue],
    genCues: [baseCue],
    proof: { planHash: sha256(planText), checkedFlags: [fullAnswers[0]], corrections: [], waivers: [] },
  });
  const problems = gate(dir);
  assert.ok(problems.some((p) => p.includes("dictHits:0")));
});

check("門番: 校正が揃えば通る", () => {
  const dir = makeWorkDir({
    assCues: [baseCue],
    genCues: [baseCue],
    proof: { planHash: sha256(planText), checkedFlags: fullAnswers, corrections: [], waivers: [] },
  });
  assert.deepEqual(gate(dir), []);
  assertCaptionsProofed({ workDir: dir, planText, plan, units }); // 投げなければ合格
});

check("門番: 記録の無い書き換えは拒否し、corrections があれば通る", () => {
  const edited = { start: 0, end: 2, text: "こんにちわ" };
  const dir1 = makeWorkDir({
    assCues: [edited],
    genCues: [baseCue],
    proof: { planHash: sha256(planText), checkedFlags: fullAnswers, corrections: [], waivers: [] },
  });
  assert.ok(gate(dir1).some((p) => p.includes("corrections")));
  const dir2 = makeWorkDir({
    assCues: [edited],
    genCues: [baseCue],
    proof: {
      planHash: sha256(planText),
      checkedFlags: fullAnswers,
      corrections: [{ cue: 1, from: "こんにちは", to: "こんにちわ", reason: "話者の言い回しに合わせた" }],
      waivers: [],
    },
  });
  assert.deepEqual(gate(dir2), []);
});

check("門番: 時刻の改変を検出する", () => {
  const moved = { start: 0.5, end: 2, text: "こんにちは" };
  const dir = makeWorkDir({
    assCues: [moved],
    genCues: [baseCue],
    proof: { planHash: sha256(planText), checkedFlags: fullAnswers, corrections: [], waivers: [] },
  });
  assert.ok(gate(dir).some((p) => p.includes("時刻")));
});

check("門番: 読みやすさ違反は理由つきの免除でのみ通る", () => {
  const fast = { start: 0, end: 1, text: "あ".repeat(10) }; // CPS 10
  const dir1 = makeWorkDir({
    assCues: [fast],
    genCues: [fast],
    proof: { planHash: sha256(planText), checkedFlags: fullAnswers, corrections: [], waivers: [] },
  });
  assert.ok(gate(dir1).some((p) => p.includes("読みやすさ")));
  const dir2 = makeWorkDir({
    assCues: [fast],
    genCues: [fast],
    proof: {
      planHash: sha256(planText),
      checkedFlags: fullAnswers,
      corrections: [],
      waivers: [{ cue: 1, rule: "cps", reason: "相槌の短い発話のため" }],
    },
  });
  assert.deepEqual(gate(dir2), []);
});

check("校正用一覧: CPS・行数・フラグIDが載る", () => {
  const txt = formatCaptionsTxt({
    jobId: "test",
    planHash: "abc",
    cues: [baseCue],
    violations: checkReadability([baseCue]),
    flags: collectVerifyFlags(verifyReport, plan, units),
  });
  assert.ok(txt.includes("CPS"));
  assert.ok(txt.includes("lowConfidence:0"));
});

console.log(`\n${passed} 件すべて合格`);
