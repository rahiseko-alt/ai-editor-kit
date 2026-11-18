// 参考動画の型を測る（reference）
//
// 参考動画（真似したい完成品）を渡すと、編集の型を実測して残す。
//   - テンポ: カット位置・カット長の並び（PySceneDetect。tempo と同じ検出）
//   - 拍: BGM の拍位置と、カットのうち拍の上にあるものの割合（librosa。beat.py と同じ検出）
//   - 深掘り（任意）: ズーム・フラッシュ・遷移の種類・色・効果音
//     （video-understanding-skill の teardown。入っていなければ飛ばす）
// 出力: .runtime/outputs/reference/<動画名>.json と .txt。
// assemble の指示ファイルに "pace": "<この json>" を書くと、場面の長さを参考動画の並びに合わせる。
// 判定はしない。材料のみ（測った値と、測れなかった項目を区別して書く）。
//
// 2026-11-18 マスター指示「動画分析エージェントと AI Editor を合体」で追加。
// 純粋部分（cutsOnBeat / referenceProfile / applyReferencePace）は tests/reference.mjs で単体テストする。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTempo } from "./tempo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

function resolvePython() {
  for (const cand of ["python3", "python"]) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return cand;
  }
  throw new Error("実行可能な python が見つかりません");
}

// カット秒のうち、拍から tol 秒以内にあるものの数と割合（純粋関数）。
export function cutsOnBeat(cutTimes, beats, tol = 0.07) {
  if (!cutTimes.length || !beats.length) return { onBeat: 0, total: cutTimes.length, pct: null };
  const sorted = [...beats].sort((a, b) => a - b);
  let onBeat = 0;
  for (const t of cutTimes) {
    let best = Infinity;
    for (const b of sorted) {
      const d = Math.abs(b - t);
      if (d < best) best = d;
      if (b > t + tol) break;
    }
    if (best <= tol) onBeat++;
  }
  return { onBeat, total: cutTimes.length, pct: Math.round((onBeat / cutTimes.length) * 100) };
}

// teardown の出力から、使う項目だけを取り出す（純粋関数）。無ければ null。
export function pickTeardown(td) {
  if (!td) return null;
  const edit = td.edit ?? {};
  const style = td.style ?? {};
  const cuts = Array.isArray(edit.cuts) ? edit.cuts : [];
  return {
    cutKinds: cuts.map((c) => ({ t: c.t, kind: c.kind, ...(c.through ? { through: c.through } : {}), conf: c.conf ?? null })),
    flashes: cuts.filter((c) => c.kind === "flash").map((c) => ({ t: c.t, through: c.through ?? null })),
    zooms: (style.zoom?.pushes ?? []).map((z) => ({
      start: z.start ?? z.t, duration: z.duration_s ?? null, direction: z.direction ?? null,
      scaleFrom: z.scale_from ?? null, scaleTo: z.scale_to ?? null, ease: z.ease ?? null,
    })),
    camera: style.camera ?? null,
    palette: style.deep?.palette?.overall ?? null,
    grade: style.deep?.grade?.reads ?? null,
    captions: style.captions ?? null,
    soundEffects: (td.sound?.sfx ?? []).map((s) => ({ t: s.t, kind: s.kind })),
  };
}

// 実測の材料から、参考動画の型をまとめる（純粋関数）。
// tempo: { duration, scenes, stats }（tempo.mjs の analyzeTempo の戻り値）
// beat: { tempo, beats } または null（取れなかった）
// teardown: pickTeardown の戻り値 または null（入っていない・失敗）
export function referenceProfile({ tempo, beat = null, teardown = null }) {
  const { duration, scenes, stats } = tempo;
  const cutTimes = scenes.slice(1).map((s) => s.start);
  const sync = beat ? cutsOnBeat(cutTimes, beat.beats) : null;
  const measured = ["テンポ（カット位置・カット長）"];
  const notMeasured = [];
  if (beat) measured.push("拍とカットの重なり"); else notMeasured.push("拍とカットの重なり（librosa が無い、または音が無い）");
  if (teardown) measured.push("ズーム・フラッシュ・遷移の種類・色・効果音（teardown）");
  else notMeasured.push("ズーム・フラッシュ・遷移の種類・色・効果音（video-understanding-skill が入っていない）");
  // 拍の上のカットが半分以上なら、BGM 同期の型とみなす目安（合否ではなく、指示ファイルの提案）。
  const syncedToBeat = sync && sync.pct != null ? sync.pct >= 50 : null;
  return {
    duration: round3(duration),
    pace: {
      cuts: stats.cuts,
      cutsPer10s: duration > 0 ? round2((stats.cuts / duration) * 10) : null,
      medianShot: stats.median,
      averageShot: stats.average,
      firstScene: stats.firstScene,
      shotDurations: stats.durations,
      cutTimes: cutTimes.map(round3),
    },
    beat: beat ? { bpm: beat.tempo, cutsOnBeat: sync, syncedToBeat } : null,
    teardown,
    suggest: {
      pace: "assemble の指示ファイルに \"pace\": \"<この json のパス>\" を書くと、場面の長さを shotDurations の順に合わせる",
      bgmSync: syncedToBeat,
    },
    measured,
    notMeasured,
  };
}

// 場面の長さを参考動画のカット長の並びに合わせる（純粋関数）。
// clips: [{start, duration, sourceDuration}]、shotDurations: 参考動画のカット長（秒）の並び。
// i 番目の場面に i 番目のカット長を当てる（足りなければ先頭から繰り返す）。
// 素材の残りが足りないときは開始秒を前へずらし、それでも足りなければ素材の尺までに留める。
// 戻り値: [{start, duration, paced, target}]（target は当てたかったカット長）。
export function applyReferencePace(clips, shotDurations) {
  const shots = (shotDurations ?? []).filter((d) => d > 0);
  if (!shots.length) return clips.map((c) => ({ start: c.start, duration: c.duration, paced: false, target: null }));
  return clips.map((clip, i) => {
    const target = shots[i % shots.length];
    let start = clip.start;
    let duration = target;
    const src = clip.sourceDuration ?? Infinity;
    if (start + duration > src) start = Math.max(0, src - duration);
    if (start + duration > src) duration = src - start;
    return { start: round3(start), duration: round3(duration), paced: true, target: round3(target) };
  });
}

// 参考動画の音から拍を取る（beat.py を使う）。取れなければ null と理由。
function detectBeats(videoPath, py) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reference-"));
  const wav = path.join(tmp, "audio.wav");
  try {
    const ff = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "22050", wav], { encoding: "utf-8" });
    if (ff.status !== 0 || !fs.existsSync(wav)) return { beat: null, why: "音声を取り出せませんでした（音の無い動画の可能性）" };
    const r = spawnSync(py, [path.join(__dirname, "beat.py"), wav], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return { beat: null, why: (r.stderr ?? "").trim().split("\n").pop() || "拍を取れませんでした" };
    return { beat: JSON.parse(r.stdout.trim().split("\n").pop()), why: null };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// video-understanding-skill の置き場（環境変数 VU_HOME、無ければ .runtime/tools/video-understanding-skill）。
export function findVideoUnderstanding(runtimeDir) {
  const home = process.env.VU_HOME || path.join(runtimeDir, "tools", "video-understanding-skill");
  const script = path.join(home, "skills", "video-understanding", "scripts", "vu.py");
  return fs.existsSync(script) ? { home, script } : null;
}

// teardown（深掘り）を回し、edit / style / sound の json を読む。入っていなければ null と理由。
function runTeardown(videoPath, runtimeDir, py) {
  const vu = findVideoUnderstanding(runtimeDir);
  if (!vu) return { teardown: null, why: "video-understanding-skill が入っていません（SETUP-CLAUDE.md の任意部品）" };
  const env = { ...process.env, VU_CACHE: path.join(runtimeDir, "cache", "video-understanding") };
  if (!env.VU_DEEP_PY) env.VU_DEEP_PY = py;
  const r = spawnSync(py, [vu.script, "teardown", videoPath, "--level", "deep"], { encoding: "utf-8", env, maxBuffer: 64 * 1024 * 1024 });
  const m = /^style\s+(.+style\.json)\s*$/m.exec(r.stdout ?? "");
  if (r.status !== 0 || !m) return { teardown: null, why: `teardown が失敗しました: ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}` };
  const dir = path.dirname(m[1].trim());
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")); } catch { return null; }
  };
  return { teardown: pickTeardown({ edit: read("edit.json"), style: read("style.json"), sound: read("sound.json") }), why: null, dir };
}

export function formatReferenceText(videoPath, p, notes = []) {
  const L = [];
  L.push(`参考動画の型: ${videoPath}`);
  L.push(`尺 ${p.duration} 秒 / カット ${p.pace.cuts}（10秒あたり ${p.pace.cutsPer10s}）`);
  L.push(`カット長: 中央値 ${p.pace.medianShot} 秒 / 平均 ${p.pace.averageShot} 秒 / 冒頭 ${p.pace.firstScene} 秒`);
  L.push(`カット長の並び: ${p.pace.shotDurations.join(" / ")}`);
  if (p.beat) {
    const s = p.beat.cutsOnBeat;
    L.push(`拍: ${p.beat.bpm} BPM / 拍の上のカット ${s.onBeat}/${s.total}${s.pct != null ? `（${s.pct}%）` : ""}`);
  }
  const td = p.teardown;
  if (td) {
    if (td.zooms.length) L.push(`ズーム: ${td.zooms.map((z) => `${z.start}秒から${z.duration}秒 ${z.scaleFrom}→${z.scaleTo}倍（${z.ease}）`).join(" / ")}`);
    else L.push("ズーム: 検出なし");
    L.push(`フラッシュ: ${td.flashes.length ? td.flashes.map((f) => `${f.t}秒（${f.through ?? "?"}）`).join(" / ") : "検出なし"}`);
    L.push(`遷移の種類（推定）: ${td.cutKinds.map((c) => `${c.t}秒 ${c.kind}`).join(" / ") || "なし"}`);
    if (td.grade) L.push(`色の傾向: ${td.grade}`);
    if (td.palette) L.push(`配色: ${td.palette.map((c) => (typeof c === "string" ? c : c.hex ?? JSON.stringify(c))).slice(0, 6).join(" ")}`);
  }
  L.push(`測った項目: ${p.measured.join("、")}`);
  if (p.notMeasured.length) L.push(`測れなかった項目: ${p.notMeasured.join("、")}`);
  for (const n of notes) L.push(`注記: ${n}`);
  L.push("注意: 遷移の種類・ズームの作り方は推定。完成動画だけでは元の編集の手順は確定できない");
  if (p.suggest.bgmSync != null) L.push(`提案: assemble で "pace" にこの json を指定${p.suggest.bgmSync ? "、bgmSync: true（参考動画はカットが拍に乗っている）" : ""}`);
  return L.join("\n");
}

export function referenceMain({ videoPath, runtimeDir, deep = true }) {
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error(`動画がありません: ${abs}`);
  const py = resolvePython();
  const tempo = analyzeTempo(abs);
  const notes = [];
  const { beat, why: beatWhy } = detectBeats(abs, py);
  if (beatWhy) notes.push(`拍: ${beatWhy}`);
  let teardown = null;
  let teardownDir = null;
  if (deep) {
    const r = runTeardown(abs, runtimeDir, py);
    teardown = r.teardown;
    teardownDir = r.dir ?? null;
    if (r.why) notes.push(`深掘り: ${r.why}`);
  } else {
    notes.push("深掘り: --no-deep のため飛ばしました");
  }
  const profile = referenceProfile({ tempo, beat, teardown });
  const outDir = path.join(runtimeDir, "outputs", "reference");
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(abs).replace(/\.[^.]+$/, "");
  const jsonPath = path.join(outDir, `${base}.json`);
  const txtPath = path.join(outDir, `${base}.txt`);
  fs.writeFileSync(jsonPath, JSON.stringify({ video: abs, teardownDir, notes, ...profile }, null, 2) + "\n", "utf-8");
  const text = formatReferenceText(abs, profile, notes);
  fs.writeFileSync(txtPath, text + "\n", "utf-8");
  console.log(text);
  console.log(`出力: ${jsonPath} / ${txtPath}${teardownDir ? `\n根拠の画像と一覧: ${teardownDir}` : ""}`);
  return profile;
}
