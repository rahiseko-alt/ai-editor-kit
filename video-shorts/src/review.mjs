// 人間の目線チェック（review）
//
// 書き出した動画を「人間の目で見る」ための材料と、機械で拾える
// 問題への修正案を、1つのフォルダに束ねて出す工程。判定そのものは
// マスター／セッションが画像を開いて行う（この工程は合否を出さない）。
//
// 束ねるもの:
// - コンタクトシート: 採用区間ごとに 開始・中間・終了 の3コマ（出力動画から）
// - 修正案リスト（review.txt）:
// * 文字起こし検証（verify）の要確認（未実施なら自動で先に回す）
// * 境界検品（boundaries）の「疑い」
// * 字幕の行頭禁則（、等で始まる行）・3行以上のカード
// * 音量ピーク（クリップ疑い／小さすぎ）
// 出力: outputs/<jobId>/review[-<outName>]/ に sheet-*.png と review.txt。

import { spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { verifyJob} from "./verify.mjs";
import { analyzeTempo } from "./tempo.mjs";

const NO_LINE_START_RE = /^[、。，．！？!?:：;；・…‥」』）)】］〉》ー]/;

function runSync(cmd, args, opts = {}) {
const r = spawnSync(cmd, args, { encoding: "utf-8",...opts});
if (r.status!== 0) throw new Error(`${cmd} が失敗しました: ${(r.stderr?? "").slice(-400)}`);
return r.stdout?? "";
}

export function captionViolations(assText) {
const out = [];
for (const line of assText.split(/\r?\n/)) {
if (!line.startsWith("Dialogue:")) continue;
const parts = line.split(",");
const start = parts[1]?? "";
const text = parts.slice(9).join(",");
const rows = text.split("\\N");
if (rows.length > 2) out.push({ start, kind: "3行以上", text});
rows.forEach((row, i) => {
if (i > 0 && NO_LINE_START_RE.test(row)) out.push({ start, kind: "行頭禁則", text: row});
});
}
return out;
}

export function reviewJob({ workDir, outDir, outName = null}) {
const videoPath = path.join(outDir, outName? `${outName}.mp4`: "result.mp4");
if (!fs.existsSync(videoPath)) throw new Error(`書き出し済みの動画がありません: ${videoPath}（先に render してください）`);
const edlPath = path.join(workDir, outName? `edl-${outName}.json`: "edl.json");
if (!fs.existsSync(edlPath)) throw new Error(`EDL がありません: ${edlPath}`);
const edl = JSON.parse(fs.readFileSync(edlPath, "utf-8"));
const ranges = (edl.ranges?? []).map((r, i) => ({
start: edl.renderedRanges?.[i]?.start?? r.start,
end: edl.renderedRanges?.[i]?.end?? r.end,
}));
if (!ranges.length) throw new Error("EDL に区間がありません");

const reviewDir = path.join(outDir, outName? `review-${outName}`: "review");
fs.mkdirSync(reviewDir, { recursive: true});

// 出力タイムライン上の区間位置を求め、各区間から3コマ抜く。
const stamps = [];
let base = 0;
ranges.forEach((r, i) => {
const dur = r.end - r.start;
for (const off of [0.3, dur / 2, Math.max(0.3, dur - 0.3)]) stamps.push({ t: base + Math.min(off, Math.max(dur - 0.05, 0.05)), seg: i + 1});
base += dur;
});
const frameFiles = [];
stamps.forEach((s, i) => {
const f = path.join(reviewDir, `frame-${String(i).padStart(2, "0")}-seg${s.seg}.png`);
runSync("ffmpeg", ["-y", "-v", "error", "-ss", String(s.t.toFixed(2)), "-i", videoPath, "-frames:v", "1", "-vf", "scale=360:-1", f]);
frameFiles.push(f);
});
// コンタクトシート（3列タイル、最大9コマ/枚）
const sheets = [];
for (let i = 0; i < frameFiles.length; i += 9) {
const group = frameFiles.slice(i, i + 9);
const sheet = path.join(reviewDir, `sheet-${sheets.length + 1}.png`);
const args = ["-y", "-v", "error"];
for (const f of group) args.push("-i", f);
const cols = Math.min(3, group.length);
const rowsN = Math.ceil(group.length / cols);
args.push("-filter_complex", `xstack=inputs=${group.length}:layout=${Array.from({ length: group.length}, (_, k) => `${(k % cols) * 360}_${Math.floor(k / cols) * 640}`).join("|")}`, "-frames:v", "1", sheet);
runSync("ffmpeg", args);
sheets.push(sheet);
}

// 修正案の材料を集める。
const proposals = [];
let verify = null;
try {
verify = verifyJob(workDir);
} catch { /* transcript が無い等は材料なしとして続行 */}
if (verify) {
if (verify.issues.lowConfidence.length) proposals.push(`文字起こし: 確信度の低い語 ${verify.issues.lowConfidence.length} 件（verify.txt の時刻を聞き直し、誤りは辞書登録→prepare やり直し）`);
if (verify.issues.soundGaps.length) proposals.push(`音声: 音があるのに文字起こしが無い区間 ${verify.issues.soundGaps.length} 件（環境音か取りこぼしかを確認）`);
if (verify.issues.punctOnly.length) proposals.push(`文字起こし: 句読点だけの語 ${verify.issues.punctOnly.length} 件（字幕側で結合済み。元データの確認を推奨）`);
if (verify.issues.repeats.length) proposals.push(`文字起こし: 同じ語の繰り返し ${verify.issues.repeats.length} 件`);
if (verify.issues.dictHits.length) proposals.push(`文字起こし: 辞書登録済みの誤変換が残っています（prepare のやり直し）`);
} else {
proposals.push("文字起こし検証（verify）が未実施です。先に verify を実行してください。");
}
const bDir = path.join(outDir, outName? `boundaries-${outName}`: "boundaries");
const bJson = path.join(bDir, "boundaries.json");
if (fs.existsSync(bJson)) {
const bj = JSON.parse(fs.readFileSync(bJson, "utf-8"));
for (const b of bj.boundaries?? []) {
if (b.flags?.length) proposals.push(`繋ぎ目 ${b.index + 1}（出力 ${b.at} 秒）: ${b.flags.join(" / ")} → 境界画像を開いて判定`);
}
} else {
proposals.push("境界検品の画像がありません。inspect を実行してください。");
}
const assPath = path.join(workDir, "captions.ass");
if (fs.existsSync(assPath)) {
const v = captionViolations(fs.readFileSync(assPath, "utf-8"));
for (const it of v.slice(0, 20)) proposals.push(`字幕 ${it.start}: ${it.kind}「${it.text}」`);
if (!v.length) proposals.push("字幕: 行頭禁則・3行以上の違反は見つかりませんでした。");
}
// 音量（全体の平均と最大。astats のフレーム単位ピークは末尾の静かなコマを
// 拾って誤判定した実績があるため、volumedetect の全体値で判定する）
try {
const err = spawnSync("ffmpeg", ["-i", videoPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf-8" }).stderr ?? "";
const mean = Number(err.match(/mean_volume:\s*(-?[\d.]+)/)?.[1]);
const max = Number(err.match(/max_volume:\s*(-?[\d.]+)/)?.[1]);
if (Number.isFinite(mean) && mean < -32) proposals.push(`音量: 平均 ${mean} dB（全体に小さい。音量を上げて書き直し）`);
if (Number.isFinite(max) && max > -0.3) proposals.push(`音量: 最大 ${max} dB（0dBに張り付き。クリップの疑い）`);
} catch { /* 音量が取れなくても材料作りは続行 */ }

// テンポ（材料のみ。合否は出さない）。scenedetect が無い環境では未計測と書く。
try {
const t = analyzeTempo(videoPath);
proposals.push(`テンポ: シーン ${t.stats.count}（カット ${t.stats.cuts}）/ カット長 平均 ${t.stats.average} 秒・中央値 ${t.stats.median} 秒 / 冒頭シーン ${t.stats.firstScene} 秒 / 最長シーン ${t.stats.longest.duration} 秒`);
} catch {
proposals.push("テンポ: 未計測（scenedetect が無い環境では計測できません）");
}

const lines = [];
lines.push("人間の目線チェック（review）: 修正案リスト");
lines.push("判定はこのファイルでは出しません。sheet 画像と境界画像を1枚ずつ開き、合格条件で判定してください。");
lines.push("");
lines.push("■ 修正案");
if (proposals.length) for (const p of proposals) lines.push(` ・${p}`);
else lines.push(" ・機械で拾える問題はありませんでした（目視判定は別途必要）。");
lines.push("");
lines.push(`■ 材料: コンタクトシート ${sheets.length} 枚（区間 ${ranges.length} 件 × 3コマ）、境界画像 ${bDir}`);
fs.writeFileSync(path.join(reviewDir, "review.txt"), lines.join("\n") + "\n", "utf-8");
return { reviewDir, sheets, proposals};
}
