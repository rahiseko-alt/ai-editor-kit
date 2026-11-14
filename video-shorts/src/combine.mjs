// 複数短尺の合算（combine）
//
// 別々に作った短い動画を、1本に繋ぐ。来店時・施術・仕上がりのような
// 複数素材の組み立てや、書き出し済み短尺の連結に使う（2026-11-14 マスター要望）。
// 仕様:
// - 画は全て同じ寸法へ揃える（既定は縦型 1080x1920。--landscape で 1920x1080）。
// 揃え方は「画面いっぱいに拡大してはみ出しを切る」（cover）。fps は 30 に統一。
// - 音は必ず残す（無音の素材には無音トラックを補う）。最後に loudnorm で
// 音量を揃える（--no-loudnorm で無効）。
// - 繋ぎ目ごとに境界検品の画像も自動生成する（方式は inspect と同じ）。
// 合否は画像を開いて判定すること（生成できたことは合格の根拠にならない）。
// 出力:.runtime/outputs/combined/<名前>.mp4 と boundaries-combined-<名前>/。

import { spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateBoundaryViews} from "./inspect/boundary-view.mjs";

function runSync(cmd, args, opts = {}) {
const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,...opts});
if (r.status!== 0) throw new Error(`${cmd} が失敗しました: ${(r.stderr?? "").slice(-500)}`);
return r.stdout?? "";
}

export function probeClip(videoPath) {
const out = runSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type", "-of", "json", videoPath]);
const j = JSON.parse(out);
return {
duration: Number(j.format?.duration?? 0),
hasAudio: (j.streams?? []).some((s) => s.codec_type === "audio"),
};
}

export function combineVideos({ inputs, outPath, landscape = false, loudnorm = true}) {
if (!inputs || inputs.length < 2) throw new Error("合算には2本以上の動画が必要です");
for (const f of inputs) if (!fs.existsSync(f)) throw new Error(`動画がありません: ${f}`);
const W = landscape? 1920: 1080;
const H = landscape? 1080: 1920;
const clips = inputs.map((f) => ({ path: f,...probeClip(f)}));
const args = ["-y", "-v", "error"];
for (const c of clips) args.push("-i", c.path);
const chains = [];
clips.forEach((c, i) => {
chains.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[v${i}]`);
chains.push(c.hasAudio
? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
: `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${c.duration.toFixed(3)}[a${i}]`);
});
const concatIn = clips.map((_, i) => `[v${i}][a${i}]`).join("");
chains.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[cv][ca]`);
if (loudnorm) chains.push("[ca]loudnorm=I=-16:TP=-1.5:LRA=11[fa]");
const audioLabel = loudnorm? "[fa]": "[ca]";
args.push("-filter_complex", chains.join(";"), "-map", "[cv]", "-map", audioLabel,
"-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
"-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outPath);
runSync("ffmpeg", args);
// 繋ぎ目の位置（出力タイムライン）と、各素材を出力タイムラインの区間として返す。
let base = 0;
const ranges = clips.map((c) => {
const r = { start: base, end: base + c.duration};
base += c.duration;
return r;
});
return { ranges, totalDuration: base};
}

export function combineMain({ inputs, outName, landscape, loudnorm, runtimeDir}) {
const outDir = path.join(runtimeDir, "outputs", "combined");
fs.mkdirSync(outDir, { recursive: true});
const outPath = path.join(outDir, `${outName}.mp4`);
const { ranges, totalDuration} = combineVideos({ inputs, outPath, landscape, loudnorm});
console.log(`合算しました: ${outPath}（${inputs.length} 本 / 合計 ${totalDuration.toFixed(1)} 秒）`);
try {
const dest = path.join(outDir, `boundaries-combined-${outName}`);
const { boundaries} = generateBoundaryViews({ videoPath: outPath, ranges, units: [], words: [], outDir: dest});
console.log(`[検品] 境界画像 ${boundaries.length} 枚を生成しました: ${dest}`);
for (const b of boundaries) console.log(` 境界${b.index + 1}（出力 ${b.at} 秒）: ${b.image}${b.flags.length? ` 要確認: ${b.flags.join(" / ")}`: ""}`);
if (boundaries.length) console.log(" → 画像を1枚ずつ開いて合格条件 共通項目9を判定するまで、「完成」として伝えないでください。");
} catch (err) {
console.error(`[検品] 境界画像の生成に失敗しました: ${err.message}`);
}
return outPath;
}
