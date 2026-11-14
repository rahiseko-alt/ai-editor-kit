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
//   "fit": "crop",                     // 省略時 "crop"（画面いっぱいに拡大して切る）。
//                                      // "blur" はピラーボックス（中央に切らずに置き、
//                                      // 両脇を同じ映像のぼかし背景で埋める）。
//                                      // 縦素材を landscape で使うときに選ぶ
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
import { combineVideos, probeClip, videoFitChains, FIT_MODES } from "./combine.mjs";
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
  if (spec.bgm != null && typeof spec.bgm !== "string") throw new Error("bgm は曲ファイルのパスで書いてください");
  if (spec.fit != null && !FIT_MODES.includes(spec.fit)) throw new Error('fit は "crop" か "blur" で書いてください');
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
    fit: spec.fit ?? "crop",
    audio: spec.audio ?? "mute",
    bgm: spec.bgm ?? null,
    bgmSync: spec.bgmSync === true,
    clips: spec.clips.map((c) => ({
      file: c.file,
      start: Number(c.start),
      duration: Number(c.duration),
      label: c.label ?? null,
      telop: c.telop ?? null,
    })),
  };
}

// 拍への吸着計算（純粋関数）。clips は [{start, duration, sourceDuration}]、
// beats は秒の配列。場面ごとの終わり（出力タイムラインの累計秒）を一番近い拍へ
// 寄せ、ずれた分はその場面の duration を伸縮して吸収する。素材の尺を超える
// 場合は start を前へずらして収め、それでも無理ならその境界は吸着しない。
// 戻り値: [{start, duration, snapped, target}]（target は狙った境界秒）。
export function snapDurations(clips, beats) {
  let cum = 0;
  return clips.map((clip) => {
    let { start, duration } = clip;
    let snapped = false;
    const end = cum + duration;
    let target = end;
    if (Array.isArray(beats) && beats.length) {
      const beat = beats.reduce((best, b) => (Math.abs(b - end) < Math.abs(best - end) ? b : best), beats[0]);
      const d2 = duration + (beat - end);
      if (Math.abs(beat - end) > 0.01 && d2 >= 1.0) {
        if (start + d2 <= clip.sourceDuration + 0.05) {
          duration = d2; snapped = true; target = beat;
        } else {
          const start2 = round3(clip.sourceDuration - d2);
          if (start2 >= 0) { start = start2; duration = d2; snapped = true; target = beat; }
        }
      }
    }
    cum += duration;
    return { start: round3(start), duration: round3(duration), snapped, target: round3(target) };
  });
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// librosa で曲の拍位置を取る（src/beat.py 経由）。librosa が無い環境では例外。
export function getBeats(bgmPath) {
  const script = path.join(__dirname, "beat.py");
  let py = null;
  for (const cand of ["python3", "python"]) {
    if (spawnSync(cand, ["--version"], { encoding: "utf-8" }).status === 0) { py = cand; break; }
  }
  if (!py) throw new Error("実行可能な python が見つかりません");
  const r = spawnSync(py, [script, bgmPath], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`拍の取得ができませんでした: ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

function buildSegment(clip, { segPath, W, H, audio, fit = "crop" }) {
  // 画の揃え方（crop / blur ピラーボックス）は combine と共通のチェーン。
  // ラベルとテロップは揃えた後の画面全体に対して描く。
  const chains = videoFitChains("[0:v]", W, H, fit, "s", "[vb]");
  const draw = [];
  if (clip.label) {
    draw.push(`drawtext=fontfile='${FONT_PATH}':text='${escapeDrawtext(clip.label)}':fontsize=72:fontcolor=white:borderw=3:bordercolor=black@0.6:x=60:y=120`);
  }
  if (clip.telop) {
    draw.push(`drawtext=fontfile='${FONT_PATH}':text='${escapeDrawtext(clip.telop)}':fontsize=54:fontcolor=white:borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=h-260`);
  }
  chains.push(`[vb]${draw.length ? draw.join(",") : "null"}[vout]`);
  const args = ["-y", "-v", "error", "-ss", String(clip.start), "-t", String(clip.duration), "-i", clip.file,
    "-filter_complex", chains.join(";"), "-map", "[vout]"];
  if (audio === "keep") {
    args.push("-map", "0:a", "-af", "aresample=48000,aformat=channel_layouts=stereo", "-c:a", "aac", "-b:a", "160k");
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
  // BGM（任意）。ファイルが無い場合は警告して BGM なしで続ける。
  let bgmPath = null;
  if (s.bgm) {
    const resolvedBgm = path.isAbsolute(s.bgm) ? s.bgm : path.resolve(specDir, s.bgm);
    if (fs.existsSync(resolvedBgm)) bgmPath = resolvedBgm;
    else console.error(`[警告] BGM が見つからないため、BGM なしで続行します: ${resolvedBgm}`);
  }
  // 拍同期（任意）。librosa が無い環境では警告して同期なしで続ける。
  let beatInfo = null;
  if (s.bgmSync && bgmPath) {
    try {
      beatInfo = getBeats(bgmPath);
    } catch (err) {
      console.error(`[警告] ${err.message} 拍同期なしで続行します。`);
    }
  }
  const resolvedClips = s.clips.map((clip) => {
    const resolved = path.isAbsolute(clip.file) ? clip.file : path.resolve(specDir, clip.file);
    if (!fs.existsSync(resolved)) throw new Error(`素材がありません: ${resolved}`);
    return { ...clip, file: resolved, sourceDuration: probeClip(resolved).duration };
  });
  const applied = beatInfo ? snapDurations(resolvedClips, beatInfo.beats) : resolvedClips.map((c) => ({ start: c.start, duration: c.duration, snapped: false, target: null }));
  const segPaths = resolvedClips.map((clip, i) => {
    const segPath = path.join(workDir, `seg${i + 1}.mp4`);
    buildSegment({ ...clip, start: applied[i].start, duration: applied[i].duration }, { segPath, W, H, audio: s.audio, fit: s.fit });
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
    // BGM を載せる場合は、最終の loudnorm はミックス側で1回だけかける。
    ({ ranges, totalDuration } = combineVideos({ inputs: segPaths, outPath, landscape: s.landscape, fit: s.fit, loudnorm: s.audio === "keep" && !bgmPath }));
  }
  return { outPath, ranges, totalDuration, segPaths, bgmPath, beatInfo, applied };
}

// BGM を載せる最終ミックス。mute: BGM のみ。keep: 会話を主、BGM は -18dB 目安で下に敷く。
// 全体の音量は loudnorm（I=-16）で揃える（キットの既存方針）。
function muxBgm(videoPath, bgmPath, mode) {
  const { duration } = probeClip(videoPath);
  const tmp = videoPath.replace(/\.mp4$/, ".bgm.mp4");
  const dur = duration.toFixed(3);
  const filter = mode === "keep"
    ? `[1:a]aresample=48000,volume=-18dB,atrim=0:${dur},asetpts=PTS-STARTPTS[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`
    : `[1:a]aresample=48000,atrim=0:${dur},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
  runSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-stream_loop", "-1", "-i", bgmPath,
    "-filter_complex", filter, "-map", "0:v", "-map", "[out]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
  fs.renameSync(tmp, videoPath);
}

export function assembleMain({ specPath, runtimeDir }) {
  const abs = path.resolve(specPath);
  if (!fs.existsSync(abs)) throw new Error(`指示ファイルがありません: ${abs}`);
  const spec = JSON.parse(fs.readFileSync(abs, "utf-8"));
  const { outPath, ranges, totalDuration, bgmPath, beatInfo, applied } = assembleFromSpec({ spec, specDir: path.dirname(abs), runtimeDir });
  if (beatInfo) {
    console.log(`拍同期: テンポ ${beatInfo.tempo} BPM / 拍 ${beatInfo.beats.length} 件`);
    let cum = 0;
    applied.forEach((a, i) => {
      cum += a.duration;
      if (a.snapped) console.log(` 場面${i + 1}の終わり ${cum.toFixed(2)} 秒（拍 ${a.target} 秒に吸着）`);
    });
  }
  if (bgmPath) {
    muxBgm(outPath, bgmPath, spec.audio ?? "mute");
    console.log(`BGM を載せました: ${bgmPath}（${(spec.audio ?? "mute") === "keep" ? "会話主・BGM -18dB" : "BGM のみ"}）`);
  }
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
