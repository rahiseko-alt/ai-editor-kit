// 短尺の組み立て（assemble）
//
// 複数の素材動画から場面を切り出し、文字（ラベル／テロップ）を入れて
// 1本に繋ぐ。来店時→施術→仕上がりのような複数素材のリールは、会話編集
// （prepare〜render）ではなくこちらで作る（2026-11-14 マスター指示
// 「ツールだけでやる」に応えるための機能。手作業の ffmpeg では、
// キットを受け取った本人が同じ物を作れない）。
//
// 指示ファイル（JSON）の形:
// {
//   "out": "fizze-ba-reel",            // 出力名（outputs/combined/<out>.mp4）
//   "landscape": false,                // 省略時 false（縦型 1080x1920）
//   "audio": "mute",                   // "mute"（既定。BGM は投稿時に付ける前提）
//                                      // または "keep"（素材の音を残し loudnorm で揃える）
//   "clips": [
//     { "file": "素材.mp4", "start": 2, "duration": 6,
//       "label": "Before",             // 左上の大きな文字（任意）
//       "telop": "顔周りが扱いづらい" } // 下部の文字（任意）
//   ]
// }
// file は指示ファイルのあるフォルダからの相対でも、絶対パスでもよい。
// 出力と境界検品の画像は combine と同じ置き場・同じ方式。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combineVideos, probeClip } from "./combine.mjs";
import { generateBoundaryViews } from "./inspect/boundary-view.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, "fonts", "NotoSansJP-Black.ttf");

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} が失敗しました: ${(r.stderr ?? "").slice(-500)}`);
  return r.stdout ?? "";
}

// drawtext に渡す文字列のエスケープ（記号類で壊れないように）
export function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

// 指示ファイルの検査。問題があれば例外（メッセージは直し方が分かる形で）。
export function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("指示ファイルは JSON オブジェクトで書いてください");
  if (!/^[A-Za-z0-9_-]+$/.test(spec.out ?? "")) throw new Error("out（出力名）は英数字と - _ だけで書いてください");
  if (spec.audio != null && !["mute", "keep"].includes(spec.audio)) throw new Error('audio は "mute" か "keep" で書いてください');
  if (!Array.isArray(spec.clips) || spec.clips.length < 1) throw new Error("clips に場面を1つ以上書いてください");
  spec.clips.forEach((c, i) => {
    const at = `clips[${i}]`;
    if (!c.file) throw new Error(`${at}: file（素材のパス）がありません`);
    if (!(Number(c.start) >= 0)) throw new Error(`${at}: start は0以上の秒で書いてください`);
    if (!(Number(c.duration) > 0)) throw new Error(`${at}: duration は0より大きい秒で書いてください`);
  });
  return {
    out: spec.out,
    landscape: spec.landscape === true,
    audio: spec.audio ?? "mute",
    clips: spec.clips.map((c) => ({
      file: c.file,
      start: Number(c.start),
      duration: Number(c.duration),
      label: c.label ?? null,
      telop: c.telop ?? null,
    })),
  };
}

function buildSegment(clip, { segPath, W, H, audio }) {
  const vfilters = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, "setsar=1", "fps=30"];
  if (clip.label) {
    vfilters.push(`drawtext=fontfile='${FONT_PATH}':text='${escapeDrawtext(clip.label)}':fontsize=72:fontcolor=white:borderw=3:bordercolor=black@0.6:x=60:y=120`);
  }
  if (clip.telop) {
    vfilters.push(`drawtext=fontfile='${FONT_PATH}':text='${escapeDrawtext(clip.telop)}':fontsize=54:fontcolor=white:borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h-260`);
  }
  const args = ["-y", "-v", "error", "-ss", String(clip.start), "-t", String(clip.duration), "-i", clip.file, "-vf", vfilters.join(",")];
  if (audio === "keep") {
    args.push("-af", "aresample=48000,aformat=channel_layouts=stereo", "-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-an");
  }
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", segPath);
  runSync("ffmpeg", args);
}

export function assembleFromSpec({ spec, specDir, runtimeDir }) {
  const s = validateSpec(spec);
  const W = s.landscape ? 1920 : 1080;
  const H = s.landscape ? 1080 : 1920;
  const workDir = path.join(runtimeDir, "work", `assemble-${s.out}`);
  fs.mkdirSync(workDir, { recursive: true });
  const segPaths = s.clips.map((clip, i) => {
    const resolved = path.isAbsolute(clip.file) ? clip.file : path.resolve(specDir, clip.file);
    if (!fs.existsSync(resolved)) throw new Error(`素材がありません: ${resolved}`);
    const segPath = path.join(workDir, `seg${i + 1}.mp4`);
    buildSegment({ ...clip, file: resolved }, { segPath, W, H, audio: s.audio });
    return segPath;
  });
  const outDir = path.join(runtimeDir, "outputs", "combined");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${s.out}.mp4`);
  let ranges;
  let totalDuration;
  if (segPaths.length === 1) {
    fs.copyFileSync(segPaths[0], outPath);
    ranges = [{ start: 0, end: probeClip(segPaths[0]).duration }];
    totalDuration = ranges[0].end;
  } else {
    ({ ranges, totalDuration } = combineVideos({ inputs: segPaths, outPath, landscape: s.landscape, loudnorm: s.audio === "keep" }));
  }
  return { outPath, ranges, totalDuration, segPaths };
}

export function assembleMain({ specPath, runtimeDir }) {
  const abs = path.resolve(specPath);
  if (!fs.existsSync(abs)) throw new Error(`指示ファイルがありません: ${abs}`);
  const spec = JSON.parse(fs.readFileSync(abs, "utf-8"));
  const { outPath, ranges, totalDuration } = assembleFromSpec({ spec, specDir: path.dirname(abs), runtimeDir });
  console.log(`組み立てました: ${outPath}（${ranges.length} 場面 / 合計 ${totalDuration.toFixed(1)} 秒）`);
  if (ranges.length > 1) {
    try {
      const dest = path.join(runtimeDir, "outputs", "combined", `boundaries-combined-${spec.out}`);
      const { boundaries } = generateBoundaryViews({ videoPath: outPath, ranges, units: [], words: [], outDir: dest });
      console.log(`[検品] 境界画像 ${boundaries.length} 枚を生成しました: ${dest}`);
      for (const b of boundaries) console.log(` 境界${b.index + 1}（出力 ${b.at} 秒）: ${b.image}${b.flags.length ? ` 要確認: ${b.flags.join(" / ")}` : ""}`);
      if (boundaries.length) console.log(" → 画像を1枚ずつ開いて判定するまで、「完成」として伝えないでください。");
    } catch (err) {
      console.error(`[検品] 境界画像の生成に失敗しました: ${err.message}`);
    }
  }
  return outPath;
}
