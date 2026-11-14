// video-shorts tests/combine-fit.mjs — 2026-11-14 追加機能のテスト。
//   combine / assemble の fit オプション（"crop" 既定 / "blur" ピラーボックス）。
//   純粋部分（指示ファイル検査・不正な fit の拒否）と、短い縦型テスト動画を
//   実際に combine する実走（寸法と画素の確認）を含む。
// 実行: node tests/combine-fit.mjs（失敗時は終了コード 1）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { combineVideos } from "../src/combine.mjs";
import { validateSpec } from "../src/assemble.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`OK  ${name}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} が失敗しました: ${(r.stderr ?? Buffer.alloc(0)).toString().slice(-400)}`);
  return r.stdout;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combine-fit-"));
const clipA = path.join(dir, "a.mp4"); // 縦型 144x256（9:16）・音あり
const clipB = path.join(dir, "b.mp4"); // 縦型 144x256・音なし（無音トラック補完の確認も兼ねる）
run("ffmpeg", ["-y", "-v", "error",
  "-f", "lavfi", "-i", "testsrc2=size=144x256:rate=30:duration=3",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipA]);
run("ffmpeg", ["-y", "-v", "error",
  "-f", "lavfi", "-i", "testsrc2=size=144x256:rate=30:duration=3",
  "-vf", "hue=h=90", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipB]);

check("assemble: fit の検査（既定 crop / blur 可 / それ以外は拒否）", () => {
  const base = { out: "x", clips: [{ file: "a", start: 0, duration: 1 }] };
  assert.equal(validateSpec(base).fit, "crop");
  assert.equal(validateSpec({ ...base, fit: "blur" }).fit, "blur");
  assert.throws(() => validateSpec({ ...base, fit: "wide" }), /fit/);
});

check("combine: 不正な fit は実行前に拒否する", () => {
  assert.throws(
    () => combineVideos({ inputs: [clipA, clipB], outPath: path.join(dir, "x.mp4"), landscape: true, fit: "wide" }),
    /fit/
  );
});

function probeSize(videoPath) {
  const out = run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", videoPath]).toString();
  const s = JSON.parse(out).streams[0];
  return { width: s.width, height: s.height };
}

check("combine --landscape --fit blur: 出力は 1920x1080 で、脇は黒帯でなく中央と異なる", () => {
  const out = path.join(dir, "blur.mp4");
  combineVideos({ inputs: [clipA, clipB], outPath: out, landscape: true, fit: "blur" });
  assert.deepEqual(probeSize(out), { width: 1920, height: 1080 });
  const W = 1920, H = 1080;
  const raw = run("ffmpeg", ["-v", "error", "-ss", "1.5", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.equal(raw.length, W * H * 3);
  const px = (x, y) => {
    const o = (y * W + x) * 3;
    return [raw[o], raw[o + 1], raw[o + 2]];
  };
  const left = px(30, 540), center = px(960, 540), right = px(1890, 540);
  const sum = (p) => p[0] + p[1] + p[2];
  assert.ok(sum(left) > 30, `左脇が黒帯です: ${left}`);
  assert.ok(sum(right) > 30, `右脇が黒帯です: ${right}`);
  assert.notDeepEqual(left, center, "左脇と中央が同じ画素です（ぼかし背景になっていません）");
  assert.notDeepEqual(right, center, "右脇と中央が同じ画素です（ぼかし背景になっていません）");
});

check("combine --landscape（fit 既定 crop）: 出力は 1920x1080 のまま", () => {
  const out = path.join(dir, "crop.mp4");
  combineVideos({ inputs: [clipA, clipB], outPath: out, landscape: true });
  assert.deepEqual(probeSize(out), { width: 1920, height: 1080 });
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} 件すべて合格`);
