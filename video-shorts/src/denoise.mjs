// 音の掃除（DeepFilterNet / deep-filter）の受け口
//
// prepare --denoise のときに使う。動画から音声を取り出し、deep-filter で
// 掃除した音声を返す。掃除済み音声は文字起こしにだけ使い、動画本体と
// 無音実測は元の動画のまま（時刻の対応をずらさないため）。
// deep-filter は任意の部品: 無い環境では doctor でも必須にせず、
// prepare 側は警告を出して通常の文字起こしへ進む。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} が失敗しました: ${(r.stderr ?? "").slice(-400)}`);
  return r.stdout ?? "";
}

// deep-filter の実行ファイル名を返す（無ければ null）。Windows は .exe も見る。
export function findDeepFilter() {
  for (const cand of ["deep-filter", "deep-filter.exe"]) {
    const r = spawnSync(cand, ["--help"], { encoding: "utf-8" });
    if (r.status === 0) return cand;
  }
  return null;
}

// 動画 → 48kHz wav 抽出 → deep-filter → 掃除済み wav のパスを返す。
// deep-filter は 48kHz の wav のみ対応のため、抽出時点で 48kHz に揃える。
export function denoiseAudio({ videoPath, workDir, deepFilter }) {
  const rawWav = path.join(workDir, "audio-raw.wav");
  runSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "48000", rawWav]);
  const outDir = path.join(workDir, "denoised");
  fs.mkdirSync(outDir, { recursive: true });
  runSync(deepFilter, [rawWav, "-o", outDir]);
  const cleaned = path.join(outDir, path.basename(rawWav));
  if (!fs.existsSync(cleaned)) throw new Error(`deep-filter の出力が見つかりません: ${cleaned}`);
  return cleaned;
}
