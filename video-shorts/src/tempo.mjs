// テンポ計測（tempo）
//
// 動画のカット位置を PySceneDetect で検出し、シーン一覧と統計
// （カット数、平均・中央値のカット長、冒頭シーンの長さ、最長シーン）を出す。
// 競合動画のテンポを実数で測る用途と、自作の書き出しの自己点検用
// （2026-11-14 マスター承認で取り込み）。判定はしない。材料のみ。
// 出力: .runtime/outputs/tempo/<動画名>.json と .txt。
//
// 検出は src/scenedetect.py（scenedetect の薄いラッパー）に任せ、
// 統計の計算（tempoStats）は純粋関数として単体テストする。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePython() {
  for (const cand of ["python3", "python"]) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return cand;
  }
  throw new Error("実行可能な python が見つかりません");
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

// シーン一覧（[{start, end}]）から統計を計算する純粋関数。
export function tempoStats(scenes) {
  if (!Array.isArray(scenes) || !scenes.length) throw new Error("シーンがありません");
  const durations = scenes.map((s) => round2(s.end - s.start));
  const total = durations.reduce((a, b) => a + b, 0);
  const longestIdx = durations.indexOf(Math.max(...durations));
  return {
    count: scenes.length,
    cuts: scenes.length - 1,
    durations,
    average: round2(total / scenes.length),
    median: round2(median(durations)),
    firstScene: durations[0],
    longest: {
      index: longestIdx,
      start: scenes[longestIdx].start,
      end: scenes[longestIdx].end,
      duration: durations[longestIdx],
    },
  };
}

export function formatTempoText(videoPath, { duration, scenes, stats }) {
  const lines = [];
  lines.push(`テンポ計測: ${videoPath}`);
  lines.push(`尺 ${duration.toFixed(1)} 秒 / シーン ${stats.count}（カット ${stats.cuts}）`);
  lines.push(`カット長: 平均 ${stats.average} 秒 / 中央値 ${stats.median} 秒`);
  lines.push(`冒頭シーン: ${stats.firstScene} 秒`);
  lines.push(`最長シーン: シーン${stats.longest.index + 1}（${stats.longest.start}〜${stats.longest.end} 秒）${stats.longest.duration} 秒`);
  lines.push("シーン一覧:");
  scenes.forEach((s, i) => {
    lines.push(` ${i + 1}: ${s.start}〜${s.end}（${stats.durations[i]} 秒）`);
  });
  return lines.join("\n");
}

// PySceneDetect で検出して { duration, scenes, stats } を返す。
export function analyzeTempo(videoPath) {
  if (!fs.existsSync(videoPath)) throw new Error(`動画がありません: ${videoPath}`);
  const py = resolvePython();
  const script = path.join(__dirname, "tempo_detect.py");
  const r = spawnSync(py, [script, videoPath], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`テンポ計測ができませんでした: ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
  }
  const { duration, scenes } = JSON.parse(r.stdout.trim().split("\n").pop());
  return { duration, scenes, stats: tempoStats(scenes) };
}

export function tempoMain({ videoPath, runtimeDir }) {
  const abs = path.resolve(videoPath);
  const result = analyzeTempo(abs);
  const outDir = path.join(runtimeDir, "outputs", "tempo");
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(abs).replace(/\.[^.]+$/, "");
  const jsonPath = path.join(outDir, `${base}.json`);
  const txtPath = path.join(outDir, `${base}.txt`);
  fs.writeFileSync(jsonPath, JSON.stringify({ video: abs, ...result }, null, 2) + "\n", "utf-8");
  const text = formatTempoText(abs, result);
  fs.writeFileSync(txtPath, text + "\n", "utf-8");
  console.log(text);
  console.log(`出力: ${jsonPath} / ${txtPath}`);
  return result;
}
