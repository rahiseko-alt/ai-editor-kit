// video-shorts src/inspect/boundary-view.mjs — 書き出し後の「境界の画像化検品」。
//
// 【出所】方式は video-use（https://github.com/browser-use/video-use 、MIT License、
// Copyright (c) 2026 Browser Use）の helpers/timeline_view.py と SKILL.md の
// self-eval 手順を下敷きに、このキットの流れ（render → 検品 → 合格するまで見せない）
// へ合わせて書き直したもの。コードの複写ではなく、方式の取り込みである。
// video-use 側の要点（実物で確認済み、2026-11-14）:
//   - timeline_view は「フィルムストリップ＋波形＋単語ラベル」の合成 PNG を作る道具。
//   - 元の用途は判断に迷う箇所への単発の掘り下げで、全件走査は想定していない。
//   - ただし self-eval では「書き出した動画（素材ではない）」の全カット境界に
//     ±1.5 秒の窓でこれを当て、画の飛び・波形の跳ね（プツッ）・字幕の隠れを見て、
//     合格するまで利用者へ見せない、としている。
// このキットでの違い:
//   - 走査対象は全境界（区間の繋ぎ目＋言い淀み除去の繋ぎ目）。合格条件 共通項目9
//     （つなぎ目にプツッというノイズ・完全な無音の断絶・頭切れ／尻切れが無いか）を
//     画像で判定するために使う。項目9以外（内容の良し悪し）はこの画像では判定しない。
//   - 新規依存は入れない。画像の合成はすべて ffmpeg のフィルタ（hstack / vstack /
//     showwavespic / drawtext）で行い、波形の数値解析は Node だけで行う
//     （video-use は Python + Pillow + numpy を使うが、このキットの配布先に無い）。
//   - 数値の「疑い」は目安として画像と boundaries.json に出すだけで、合否は出さない。
//     合格条件の正本どおり、判定は画像を見た検品者が行う。数値が静かでも合格ではない。
//
// 1枚の画像の構成（上から）:
//   1. フィルムストリップ: 境界の前後から等間隔に抜いた 6 コマ（相対秒を焼く）。
//      中央の赤線が境界。
//   2. 波形: 境界 ±1.5 秒（窓）の波形。無音区間（10ms 窓 RMS が -40dB 未満、
//      0.15 秒以上続くもの）を青く塗り、窓内にある語のラベルを上に置く。
//   3. ラベル帯: 境界番号・出力時刻・繋ぎ目の種類、前の文節→次の文節、
//      数値の目安（境界を含む無音の長さ／波形の跳ね上がり／語尾・語頭までの余白）、
//      数値から見た「疑い」。
//
// 使い方（edit-job.mjs 経由）:
//   node src/edit-job.mjs inspect <jobId>   （render の直後にも自動で生成する）
// 出力: .runtime/outputs/<jobId>/boundaries/boundary-<番号>.png と boundaries.json

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { FONTS_DIR } from "../subtitle-styles.mjs";

const FONT_FILE = "NotoSansJP-Black.ttf";
/** 境界の前後に取る窓の片側の長さ（秒）。video-use の self-eval と同じ ±1.5 秒。 */
export const BOUNDARY_WINDOW_SEC = 1.5;
/** フィルムストリップのコマの相対位置（秒）。境界を中央に置く。 */
const FRAME_OFFSETS_SEC = [-1.25, -0.75, -0.25, 0.25, 0.75, 1.25];
/** 「完全な無音」とみなす振幅の上限（正規化）。AAC 化後の床ノイズより十分に低く置く。 */
const DIGITAL_SILENCE_AMP = 64 / 32768; // ≒ -54dB
/** 波形の陰影に使う無音の判定（10ms 窓の RMS がこの値未満）。 */
const SHADE_SILENCE_RMS = 0.01; // -40dB

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    const err = (r.stderr ? r.stderr.toString() : "") || (r.stdout ? r.stdout.toString() : "");
    throw new Error(`コマンド失敗: ${cmd} ${args.join(" ")}\n${err}`);
  }
  return r.stdout;
}

function probe(videoPath) {
  const out = runSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration", "-show_entries", "format=duration",
    "-of", "json", videoPath,
  ], { encoding: "utf-8" });
  const j = JSON.parse(out);
  const st = j.streams?.[0] ?? {};
  // コマを抜く上限は映像の長さで決める。BGM を載せた書き出しは音の方が長く、
  // 全体の長さ（format）の末尾近くを指すとコマが無く、境界画像の生成が止まる（2026-11-18 発見）。
  const formatDur = Number(j.format?.duration ?? 0);
  const videoDur = Number(st.duration ?? 0);
  return { width: st.width ?? 0, height: st.height ?? 0, duration: videoDur > 0 ? Math.min(videoDur, formatDur || videoDur) : formatDur };
}

// ---------- 境界の一覧（純粋な計算。テスト対象） ----------

/**
 * 書き出した区間の並びから、繋ぎ目（境界）の一覧を作る。
 * 境界は「区間どうしの繋ぎ目」と「言い淀み除去で1区間が割れた繋ぎ目」の両方を含む
 * （合格条件 共通項目9 の「つなぎ目」はどちらにも掛かる）。
 *
 * @param {{start:number,end:number,segment?:number,fromUnit?:number,toUnit?:number}[]} ranges
 *   実際に切り出した区間（フレーム境界に揃えたもの。edl.json の renderedRanges）。
 * @param {{w:string,start:number,end:number}[]} units 文節一覧（units.json）
 * @returns at は出力動画の中での境界時刻。tailGapSec は前の文節の語尾から切り点まで、
 *   headGapSec は切り点から次の文節の語頭まで（どちらも素材側の秒数）。
 *   小さいほど頭切れ／尻切れの疑いが強い。
 */
export function buildBoundaries(ranges, units = []) {
  const out = [];
  let outStart = 0;
  for (let i = 0; i < ranges.length - 1; i++) {
    const before = ranges[i];
    const after = ranges[i + 1];
    const at = outStart + (before.end - before.start);
    outStart = at;
    const beforeUnit = before.toUnit != null ? units[before.toUnit] : null;
    const afterUnit = after.fromUnit != null ? units[after.fromUnit] : null;
    out.push({
      index: i,
      at: +at.toFixed(3),
      kind: before.segment != null && before.segment === after.segment ? "filler" : "segment",
      beforeUnit: beforeUnit?.w ?? null,
      afterUnit: afterUnit?.w ?? null,
      tailGapSec: beforeUnit ? +(before.end - beforeUnit.end).toFixed(3) : null,
      headGapSec: afterUnit ? +(afterUnit.start - after.start).toFixed(3) : null,
    });
  }
  return out;
}

/** 素材側の語を、出力動画の時刻へ写す（区間ごとにずらして繋ぐ）。 */
export function mapWordsToOutput(ranges, words = []) {
  const out = [];
  let outStart = 0;
  for (const r of ranges) {
    for (const w of words) {
      if (w.end <= r.start || w.start >= r.end) continue;
      out.push({
        w: w.w,
        start: +(outStart + (w.start - r.start)).toFixed(3),
        end: +(outStart + (w.end - r.start)).toFixed(3),
      });
    }
    outStart += r.end - r.start;
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- 波形の数値解析（純粋な計算。テスト対象） ----------

/**
 * 境界を含む窓の PCM から、合格条件 共通項目9 を見るための目安を出す。
 * 合否は出さない。ここが出すのは「画像のどこをよく見るべきか」だけである。
 *
 * @param {Int16Array} samples モノラル PCM（窓の先頭から）
 * @param {number} sampleRate
 * @param {number} boundaryOffsetSec 窓の先頭から境界までの秒数
 */
export function analyzeBoundaryAudio(samples, sampleRate, boundaryOffsetSec) {
  const n = samples.length;
  const atIdx = Math.min(n - 1, Math.max(0, Math.round(boundaryOffsetSec * sampleRate)));
  const amp = (i) => Math.abs(samples[i]) / 32768;

  // 跳ね上がり: 境界の前後 25ms での標本間の最大の段差と、窓全体の段差の 95 パーセンタイル。
  const jumps = new Float32Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) jumps[i - 1] = Math.abs(samples[i] - samples[i - 1]) / 32768;
  const sorted = Float32Array.from(jumps).sort();
  const p95Jump = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  let maxJumpNear = 0;
  const jFrom = Math.max(1, atIdx - Math.round(0.025 * sampleRate));
  const jTo = Math.min(n - 1, atIdx + Math.round(0.025 * sampleRate));
  for (let i = jFrom; i <= jTo; i++) {
    maxJumpNear = Math.max(maxJumpNear, Math.abs(samples[i] - samples[i - 1]) / 32768);
  }

  // 境界を含む「完全な無音」の続き。境界の標本自体が無音でなければ長さ 0。
  // 左右の長さを分けて持つのは、「境界にだけ挟まった短い無音の切れ込み」
  // （過去に繋ぎ目へ最大1フレームの合成無音が挟まった事故の形）と、
  // 「素材にもともとあった長い間」を区別するため。
  let digitalSilenceSec = 0;
  let silenceLeftSec = 0;
  let silenceRightSec = 0;
  if (n > 0 && amp(atIdx) <= DIGITAL_SILENCE_AMP) {
    let lo = atIdx;
    while (lo > 0 && amp(lo - 1) <= DIGITAL_SILENCE_AMP) lo--;
    let hi = atIdx;
    while (hi < n - 1 && amp(hi + 1) <= DIGITAL_SILENCE_AMP) hi++;
    digitalSilenceSec = (hi - lo + 1) / sampleRate;
    silenceLeftSec = (atIdx - lo + 1) / sampleRate;
    silenceRightSec = (hi - atIdx + 1) / sampleRate;
  }

  // 波形の陰影用: 10ms 窓の RMS が閾値未満の区間（0.15 秒以上）。
  const bin = Math.max(1, Math.round(0.01 * sampleRate));
  const bins = Math.floor(n / bin);
  const silentBin = new Array(bins).fill(false);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let i = b * bin; i < (b + 1) * bin; i++) sum += (samples[i] / 32768) ** 2;
    silentBin[b] = Math.sqrt(sum / bin) < SHADE_SILENCE_RMS;
  }
  const shadeSilences = [];
  for (let b = 0; b < bins;) {
    if (!silentBin[b]) { b++; continue; }
    let e = b;
    while (e + 1 < bins && silentBin[e + 1]) e++;
    const startSec = (b * bin) / sampleRate;
    const endSec = ((e + 1) * bin) / sampleRate;
    if (endSec - startSec >= 0.15) shadeSilences.push({ start: +startSec.toFixed(3), end: +endSec.toFixed(3) });
    b = e + 1;
  }

  return {
    maxJumpNearBoundary: +maxJumpNear.toFixed(4),
    p95Jump: +p95Jump.toFixed(4),
    digitalSilenceAtBoundarySec: +digitalSilenceSec.toFixed(3),
    digitalSilenceLeftSec: +silenceLeftSec.toFixed(3),
    digitalSilenceRightSec: +silenceRightSec.toFixed(3),
    shadeSilences,
  };
}

/** 数値から「疑い」を立てる。疑いは不合格の宣告ではなく、見るべき場所の指定である。 */
export function suspectFlags(boundary, analysis) {
  const flags = [];
  const run = analysis.digitalSilenceAtBoundarySec;
  const isNotch =
    run >= 0.02 && run < 0.5 &&
    analysis.digitalSilenceLeftSec <= 0.2 && analysis.digitalSilenceRightSec <= 0.2;
  if (isNotch) {
    flags.push(`境界にだけ完全な無音の切れ込みが ${run.toFixed(2)} 秒ある（断絶の疑い）`);
  } else if (run >= 0.5) {
    flags.push(`境界を含む完全な無音が ${run.toFixed(2)} 秒ある（素材の間がそのまま残っているか画像で確認）`);
  }
  if (analysis.maxJumpNearBoundary >= 0.3 && analysis.maxJumpNearBoundary >= 4 * Math.max(analysis.p95Jump, 1e-6)) {
    flags.push("境界付近の波形の跳ね上がりが周囲より突出している（プツッの疑い）");
  }
  if (boundary.tailGapSec != null && boundary.tailGapSec < 0.08) {
    flags.push(`前の文節の語尾から切り点まで ${boundary.tailGapSec.toFixed(2)} 秒しかない（尻切れの疑い）`);
  }
  if (boundary.headGapSec != null && boundary.headGapSec < 0.08) {
    flags.push(`切り点から次の文節の語頭まで ${boundary.headGapSec.toFixed(2)} 秒しかない（頭切れの疑い）`);
  }
  return flags;
}

// ---------- 画像の生成（ffmpeg のみ） ----------

function extractPcm(videoPath, start, dur) {
  const buf = runSync("ffmpeg", [
    "-v", "error", "-ss", start.toFixed(3), "-i", videoPath, "-t", dur.toFixed(3),
    "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
  ], { encoding: "buffer" });
  const count = Math.floor(buf.byteLength / 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** drawtext に同梱フォントを渡す。絶対パスは Windows のドライブレターのコロンで壊れるため、
 * 作業フォルダからの相対パス（スラッシュ区切り）にして、ffmpeg の cwd を作業フォルダにする。 */
function fontfileArg(cwd) {
  const rel = path.relative(cwd, path.join(FONTS_DIR, FONT_FILE)).split(path.sep).join("/");
  return `fontfile=${rel}`;
}

function truncate(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : String(text);
}

function fmtSec(v) {
  return v == null ? "不明" : `${v.toFixed(2)}秒`;
}

function renderBoundaryImage({ videoPath, outPath, tmpDir, dims, winStart, winEnd, at, boundary, wordsOut, analysis, flags, total }) {
  const portrait = dims.height > dims.width;
  const tileW = portrait ? 200 : 288;
  const tileH = portrait ? 356 : 162;
  const W = tileW * FRAME_OFFSETS_SEC.length;
  const waveH = 220;
  const bandH = 208;
  const winDur = winEnd - winStart;
  const font = fontfileArg(tmpDir);
  const run = (args) => runSync("ffmpeg", args, { encoding: "utf-8", cwd: tmpDir });

  // 1. フィルムストリップ（各コマに境界からの相対秒を焼く）
  const frameFiles = [];
  FRAME_OFFSETS_SEC.forEach((off, i) => {
    const t = Math.min(Math.max(at + off, 0), Math.max(0, dims.duration - 0.05));
    const name = `f${i}.png`;
    const label = `${off >= 0 ? "+" : ""}${off.toFixed(2)}s`;
    run(["-v", "error", "-y", "-ss", t.toFixed(3), "-i", videoPath, "-frames:v", "1",
      "-vf", `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=${font}:text='${label}':x=8:y=8:fontsize=22:fontcolor=white:borderw=2:bordercolor=black`,
      name]);
    frameFiles.push(name);
  });
  run(["-v", "error", "-y", ...frameFiles.flatMap((f) => ["-i", f]),
    "-filter_complex", "[0][1][2][3][4][5]hstack=inputs=6", "-frames:v", "1", "strip.png"]);

  // 2. 波形（無音の陰影＋語ラベル）
  const drawOps = [];
  for (const s of analysis.shadeSilences) {
    const x = Math.round((s.start / winDur) * W);
    const w = Math.max(2, Math.round(((s.end - s.start) / winDur) * W));
    drawOps.push(`drawbox=x=${x}:y=0:w=${w}:h=${waveH}:color=0x3C78C8@0.35:t=fill`);
  }
  let lastX = -9999;
  let row = 0;
  for (const w of wordsOut) {
    const mid = (w.start + w.end) / 2;
    if (mid < winStart || mid > winEnd) continue;
    const text = String(w.w).replace(/\s+/g, "");
    if (!text) continue;
    const estW = [...text].reduce((acc, ch) => acc + (ch.codePointAt(0) > 0xff ? 20 : 11), 0);
    const cx = Math.round(((mid - winStart) / winDur) * W);
    if (cx - lastX < 34) continue;
    const x = Math.max(0, Math.min(W - estW, cx - Math.round(estW / 2)));
    const y = row % 2 === 0 ? 6 : 34;
    row++;
    const txtName = `w${row}.txt`;
    fs.writeFileSync(path.join(tmpDir, txtName), text, "utf-8");
    drawOps.push(`drawtext=${font}:textfile=${txtName}:x=${x}:y=${y}:fontsize=20:fontcolor=white:borderw=2:bordercolor=black`);
    lastX = cx;
  }
  const waveFilter = drawOps.length
    ? `[0:a]showwavespic=s=${W}x${waveH}:colors=0x8CB4FF[wave];[wave]${drawOps.join(",")}[wout]`
    : `[0:a]showwavespic=s=${W}x${waveH}:colors=0x8CB4FF[wout]`;
  run(["-v", "error", "-y", "-ss", winStart.toFixed(3), "-i", videoPath, "-t", winDur.toFixed(3),
    "-filter_complex", waveFilter, "-map", "[wout]", "-frames:v", "1", "wave.png"]);

  // 3. ラベル帯
  const kindLabel = boundary.kind === "filler" ? "言い淀み除去の繋ぎ目" : "区間の繋ぎ目";
  const lines = [
    `境界 ${boundary.index + 1} / ${total}   出力 ${at.toFixed(2)} 秒   ${kindLabel}`,
    `前: ${truncate(boundary.beforeUnit ?? "（文節なし）", 30)}   →   次: ${truncate(boundary.afterUnit ?? "（文節なし）", 30)}`,
    // drawtext では % が特殊文字として展開され、この行だけ消える事故になるため「%」は書かない。
    `無音(境界) ${analysis.digitalSilenceAtBoundarySec.toFixed(2)}秒 / 跳ね ${analysis.maxJumpNearBoundary.toFixed(2)}（周囲の目安 ${analysis.p95Jump.toFixed(2)}） / 語尾まで ${fmtSec(boundary.tailGapSec)} / 語頭まで ${fmtSec(boundary.headGapSec)}`,
    flags.length
      ? `要確認: ${truncate(flags.length > 1 ? `${flags[0]} / ほか${flags.length - 1}件は boundaries.json を見る` : flags[0], 62)}`
      : "数値上の疑い: なし（合否はこの画像を見て判定すること）",
  ];
  const bandDraw = lines.map((line, i) => {
    const name = `line${i}.txt`;
    fs.writeFileSync(path.join(tmpDir, name), line, "utf-8");
    return `drawtext=${font}:textfile=${name}:x=16:y=${14 + i * 48}:fontsize=27:fontcolor=${i === 3 && flags.length ? "0xFFB340" : "white"}`;
  }).join(",");
  run(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x121216:s=${W}x${bandH}`,
    "-vf", bandDraw, "-frames:v", "1", "band.png"]);

  // 4. 縦に繋ぎ、境界の赤線を引く
  run(["-v", "error", "-y", "-i", "strip.png", "-i", "wave.png", "-i", "band.png",
    "-filter_complex", `[0][1][2]vstack=inputs=3,drawbox=x=iw/2-1:y=0:w=3:h=${tileH + waveH}:color=0xFF3B30@1:t=fill`,
    "-frames:v", "1", outPath]);
}

/**
 * 書き出した動画の全境界について、検品画像と boundaries.json を生成する。
 * @returns {{boundaries: object[], outDir: string}}
 */
export function generateBoundaryViews({ videoPath, ranges, units = [], words = [], outDir }) {
  const dims = probe(videoPath);
  if (!dims.duration) throw new Error(`動画の長さを取得できませんでした: ${videoPath}`);
  const boundaries = buildBoundaries(ranges, units);
  const wordsOut = mapWordsToOutput(ranges, words);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const b of boundaries) {
    const winStart = Math.max(0, b.at - BOUNDARY_WINDOW_SEC);
    const winEnd = Math.min(dims.duration, b.at + BOUNDARY_WINDOW_SEC);
    const samples = extractPcm(videoPath, winStart, winEnd - winStart);
    const analysis = analyzeBoundaryAudio(samples, 48000, b.at - winStart);
    const flags = suspectFlags(b, analysis);
    const file = `boundary-${String(b.index + 1).padStart(2, "0")}.png`;
    // 中間ファイル置き場。render-edl.mjs と同じ理由で再帰削除は使わず、平らに置いて1つずつ消す。
    const tmpDir = path.join(outDir, `.tmp-${b.index + 1}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      renderBoundaryImage({
        videoPath, outPath: path.join(outDir, file), tmpDir,
        dims, winStart, winEnd, at: b.at, boundary: b, wordsOut, analysis, flags, total: boundaries.length,
      });
    } finally {
      for (const name of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, name));
      fs.rmdirSync(tmpDir);
    }
    results.push({
      ...b, image: file,
      window: { start: +winStart.toFixed(3), end: +winEnd.toFixed(3) },
      metrics: analysis, flags,
    });
  }

  const report = {
    video: videoPath,
    generatedAt: new Date().toISOString(),
    source: "video-use (MIT) の timeline_view 方式を取り込んだ境界検品。合否は画像を見た検品者が合格条件 共通項目9 で判定する。数値は目安であり、合否ではない。",
    boundaries: results,
  };
  fs.writeFileSync(path.join(outDir, "boundaries.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  return { boundaries: results, outDir };
}
