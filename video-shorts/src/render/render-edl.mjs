// video-shorts src/render/render-edl.mjs — EDL の区間を切り出して繋ぎ、縦型変換・字幕を掛けて書き出す。
//
// 【2026-09-26 作り直し（再開発 Phase 2）】以前は全区間を1本の filter_complex（trim/atrim/concat）で
// 処理していた。そのやり方には次の問題があった（docs/再開発計画_Phase0-2.md §2-1、合成音で実測）:
//   - 映像の trim はフレーム単位、音声の atrim はサンプル単位で切れるため、区間ごとに長さがずれ、
//     concat が音声の末尾を無音で埋める＝繋ぎ目ごとに最大1フレーム（30fps で 33ms）の、素材に無い
//     無音が挟まる（虎の巻 原則4 違反）。
//   - 1区間だけを取り出して確かめる手段が無く、音声の不具合をどの区間で起きたか切り分けられない。
//
// 今の手順:
//   1. 区間の端を映像のフレーム境界へ揃える（開始は切り下げ・終了は切り上げ＝広く取る側。虎の巻 原則3）。
//      これで各区間の映像と音声の長さが一致し、繋ぎ目に余分な無音が入らない。
//   2. 区間ごとに1本ずつ中間ファイルへ切り出す。映像は可逆（x264 qp0）、音声は無圧縮（PCM）。
//      中間で劣化も AAC の先頭の無音（priming）も生じないので、繋ぎ目に何も足されない。
//      中間ファイルは work/<jobId>/segments/ に残るので、1区間だけ聞いて確かめられる。
//   3. 中間ファイルを無劣化で繋ぐ（concat demuxer の -c copy）。
//   4. 繋いだものに縦型変換・字幕を掛け、ここで1回だけ H.264 / AAC に変換する。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { FONTS_DIR } from "../subtitle-styles.mjs";

/** 繋ぎ目のフェードの長さ（秒）。docs/合格条件.md §4「クロスフェード 5〜10ms」の上限。
 * 長いほど語頭が痩せる（虎の巻 §3-5）。実聴で詰める余地あり。 */
export const EDGE_FADE_SEC = 0.01;

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) {
    throw new Error(`コマンド失敗: ${cmd} ${args.join(" ")}\n${r.stderr ?? r.stdout ?? ""}`);
  }
  return r.stdout ?? "";
}

/** 映像のフレームレート（fps）を分数のまま読んで数値にする（29.97 = 30000/1001 等）。 */
export function probeFps(videoPath) {
  const out = runSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", videoPath,
  ]);
  const st = JSON.parse(out).streams?.[0] ?? {};
  for (const s of [st.avg_frame_rate, st.r_frame_rate]) {
    const [n, d] = String(s ?? "").split("/").map(Number);
    if (n > 0 && d > 0) return n / d;
  }
  throw new Error(`フレームレートを取得できませんでした: ${videoPath}`);
}

/**
 * 区間の端をフレーム境界に揃える。開始は切り下げ、終了は切り上げ（広く取る側）。
 * 揃えた結果、隣の区間と重なる・長さ0になるものは作らない。
 */
export function alignToFrames(ranges, fps) {
  const EPS = 1e-6;
  return ranges
    .map((r) => {
      const f0 = Math.floor(r.start * fps + EPS);
      const f1 = Math.ceil(r.end * fps - EPS);
      return { start: f0 / fps, end: f1 / fps, frames: f1 - f0 };
    })
    .filter((r) => r.frames > 0);
}

/** 1区間を中間ファイルへ切り出す。長さはフレーム数ぴったりにする（映像・音声とも）。 */
function extractSegment(videoPath, r, fps, outFile) {
  const dur = r.frames / fps;
  const fade = Math.min(EDGE_FADE_SEC, dur / 4);
  runSync("ffmpeg", [
    "-v", "error", "-y",
    // 入力側で位置合わせ（再エンコードするので、映像・音声ともその時刻から正確に始まる）
    "-ss", r.start.toFixed(6), "-i", videoPath, "-t", dur.toFixed(6),
    "-map", "0:v:0", "-map", "0:a:0",
    "-vf", "setpts=PTS-STARTPTS",
    "-af", `asetpts=PTS-STARTPTS,apad,atrim=end=${dur.toFixed(6)},afade=t=in:st=0:d=${fade},afade=t=out:st=${(dur - fade).toFixed(6)}:d=${fade}`,
    "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "pcm_s16le", "-ar", "48000",
    outFile,
  ]);
}

/**
 * @param {{videoPath:string, ranges:{start:number,end:number}[], portrait:boolean,
 *   assPath:string|null, workDir:string, outPath:string, fps?:number}} args
 * @returns {{start:number,end:number}[]} 実際に切り出した（フレーム境界に揃えた）区間
 */
export function renderFinal({ videoPath, ranges, portrait, assPath, workDir, outPath, fps }) {
  console.log("[6/8] 切り出し・結合中…");
  const rate = fps ?? probeFps(videoPath);
  const aligned = alignToFrames(ranges, rate);
  if (aligned.length === 0) throw new Error("切り出す区間がありません");

  const segDir = path.join(workDir, "segments");
  // 前回の中間ファイルを1つずつ消す。fs.rmSync の再帰削除は、Node.js v24 の Windows で OneDrive 配下・
  // 日本語パス上だとネイティブクラッシュした実測がある（video-shorts/AGENTS.md）。配布先は今の LTS（v24）を
  // 入れるので、再帰削除を使わない。segments/ は平らなフォルダ（中にフォルダを作らない）。
  if (fs.existsSync(segDir)) {
    for (const name of fs.readdirSync(segDir)) fs.unlinkSync(path.join(segDir, name));
  }
  fs.mkdirSync(segDir, { recursive: true });
  const listLines = [];
  aligned.forEach((r, i) => {
    const name = `seg-${String(i).padStart(3, "0")}.mkv`;
    extractSegment(videoPath, r, rate, path.join(segDir, name));
    listLines.push(`file '${name}'`);
  });
  const listPath = path.join(segDir, "list.txt");
  fs.writeFileSync(listPath, `${listLines.join("\n")}\n`, "utf-8");
  const joined = path.join(segDir, "joined.mkv");
  runSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", joined]);

  const vf = [];
  if (portrait) {
    console.log("[7/8] 縦型変換中（letterbox）…");
    vf.push("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1");
  }
  if (assPath) {
    console.log("[8/8] 字幕を焼き込み中…");
    // ffmpeg の subtitles フィルタは Windows のドライブレター(C:)をオプション区切りと誤認するため、
    // 作業ディレクトリからの相対パスで渡す（絶対パスのコロンを回避する）。
    const relAss = path.relative(workDir, assPath).split(path.sep).join("/");
    const relFonts = path.relative(workDir, FONTS_DIR).split(path.sep).join("/");
    vf.push(`subtitles=${relAss}:fontsdir=${relFonts}`);
  }
  runSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-i", joined,
      ...(vf.length ? ["-vf", vf.join(",")] : []),
      "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      outPath,
    ],
    { cwd: workDir }
  );
  return aligned.map(({ start, end }) => ({ start, end }));
}
