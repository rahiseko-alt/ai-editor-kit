// 文字起こし検証（verify）
//
// 文字起こしの誤りは、そのまま字幕の誤りになる。書き出しの前に、
// 認識が怪しい箇所を機械的に拾い上げ、「どこを・どう直すか」の修正案として
// 並べるのがこの工程。合否の判定そのものはしない（聞き直しと辞書登録は
// マスター／セッションの仕事）。出典の考え方は docs 参照:
// - 確信度（faster-whisper の word.probability）が低い語は誤認識の候補。
// - 「音があるのに語が無い区間」は、環境音（救急車・BGM等）を拾っているか、
// 発話を取りこぼしている疑い。無音実測（silences.json）と突き合わせて出す。
// - 句読点だけの語は、字幕で行頭に孤立して「、」だけの行を作る事故の元。
//
// 出力: work/<jobId>/verify.json（機械可読）と verify.txt（人間可読・修正案つき）。
// 修正の反映は、誤→正を term-corrections.json へ登録して prepare をやり直す
// （transcribe.py の誤変換辞書が文字起こし直後に適用される）。

import fs from "node:fs";
import path from "node:path";

export const LOW_CONFIDENCE = 0.5; // これ未満の確信度は「要確認」
export const SOUND_GAP_MIN_SEC = 3; // 音があるのに語が無い区間の最小長（秒）
const PUNCT_ONLY_RE = /^[、。，．！？!?:：;；・…‥「」『』（）()\[\]〜~ー]+$/;

function fmtTime(sec) {
const m = Math.floor(sec / 60);
const s = sec - m * 60;
return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** 無音区間リストから「音がある区間」を返す（duration まで）。 */
export function soundSpans(silences, duration) {
const spans = [];
let cur = 0;
for (const s of [...silences].sort((a, b) => a.start - b.start)) {
if (s.start > cur) spans.push({ start: cur, end: Math.min(s.start, duration)});
cur = Math.max(cur, s.end);
}
if (cur < duration) spans.push({ start: cur, end: duration});
return spans.filter((s) => s.end - s.start > 0.05);
}

/** 音があるのに語が1つも無い区間を返す（環境音・取りこぼしの疑い）。 */
export function findSoundGaps(words, silences, duration, minSec = SOUND_GAP_MIN_SEC) {
const gaps = [];
for (const span of soundSpans(silences, duration)) {
let cur = span.start;
const inSpan = words.filter((w) => w.end > span.start && w.start < span.end).sort((a, b) => a.start - b.start);
for (const w of inSpan) {
if (w.start - cur >= minSec) gaps.push({ start: cur, end: w.start, sec: +(w.start - cur).toFixed(2)});
cur = Math.max(cur, w.end);
}
if (span.end - cur >= minSec) gaps.push({ start: cur, end: span.end, sec: +(span.end - cur).toFixed(2)});
}
return gaps;
}

/** 同じ語の3連続以上（言い淀みの残り・誤認識の繰り返しの疑い）。 */
export function findRepeats(words) {
const out = [];
let run = 1;
for (let i = 1; i <= words.length; i++) {
if (i < words.length && words[i].w === words[i - 1].w && words[i].w) run++;
else {
if (run >= 3) out.push({ word: words[i - 1].w, count: run, start: words[i - run].start, end: words[i - 1].end});
run = 1;
}
}
return out;
}

export function verifyTranscript({ words = [], silences = [], duration = 0, corrections = {}}) {
const issues = { lowConfidence: [], punctOnly: [], repeats: [], longTokens: [], soundGaps: [], dictHits: []};
words.forEach((w, i) => {
// 低確信度は「内容のある語」だけを要確認にする。1文字の助詞・断片は素の確率が低く
// 出るのが普通で、全部並べると本当の誤りが埋もれる（実測: 131件の大半が断片だった）。
// ただし確率が極端に低い断片（<0.25）は誤りの可能性があるので残す。
const isContent = (w.w ?? "").length >= 2 && /[一-龯ァ-ヶーA-Za-z0-9]/.test(w.w);
if (typeof w.p === "number" && w.p < LOW_CONFIDENCE && (isContent || w.p < 0.25)) {
issues.lowConfidence.push({
index: i, word: w.w, p: w.p, start: w.start, end: w.end,
context: words.slice(Math.max(0, i - 3), i + 4).map((x) => x.w).join(""),
});
}
if (PUNCT_ONLY_RE.test(w.w?? "")) issues.punctOnly.push({ index: i, word: w.w, start: w.start});
if ((w.w?? "").length >= 15) issues.longTokens.push({ index: i, word: w.w, start: w.start});
});
issues.repeats = findRepeats(words);
if (duration > 0) issues.soundGaps = findSoundGaps(words, silences, duration);
// 辞書に登録済みの誤変換がまだ残っていないか（適用漏れの検出）。
const joined = words.map((w) => w.w).join("");
for (const wrong of Object.keys(corrections)) {
if (wrong && joined.includes(wrong)) issues.dictHits.push({ wrong, right: corrections[wrong]});
}
const total = Object.values(issues).reduce((n, a) => n + a.length, 0);
return { issues, total, hasConfidence: words.some((w) => typeof w.p === "number")};
}

export function verifyJob(workDir) {
const transcriptPath = path.join(workDir, "transcript.json");
if (!fs.existsSync(transcriptPath)) throw new Error(`transcript.json がありません: ${transcriptPath}（先に prepare してください）`);
const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
const silencesPath = path.join(workDir, "silences.json");
const silences = fs.existsSync(silencesPath)? JSON.parse(fs.readFileSync(silencesPath, "utf-8")): [];
let corrections = {};
try {
const dictPath = path.join(workDir, "..", "..", "..", "video-shorts", "src", "term-corrections.json");
const raw = JSON.parse(fs.readFileSync(dictPath, "utf-8"));
corrections = Object.fromEntries(Object.entries(raw).filter(([k, v]) =>!k.startsWith("_") && typeof v === "string"));
} catch { /* 辞書が無ければ検査だけ省略 */}
const { issues, total, hasConfidence} = verifyTranscript({
words: transcript.words?? [], silences, duration: transcript.duration?? 0, corrections,
});
const report = { jobWorkDir: workDir, generatedAt: new Date().toISOString(), total, hasConfidence, issues};
fs.writeFileSync(path.join(workDir, "verify.json"), JSON.stringify(report, null, 2), "utf-8");
const lines = [];
lines.push("文字起こし検証（verify）: 修正案つきの要確認リスト");
lines.push(`要確認 ${total} 件${hasConfidence? "": "（確信度の記録が無い文字起こしのため、低確信度の検査は未実施）"}`);
lines.push("");
if (issues.lowConfidence.length) {
lines.push(`■ 認識の確信度が低い語 ${issues.lowConfidence.length} 件（聞き直して、誤りなら term-corrections.json へ誤→正を登録し prepare をやり直す）`);
for (const it of issues.lowConfidence) lines.push(` ${fmtTime(it.start)} 「${it.word}」(確信度 ${it.p}) …前後: ${it.context}`);
lines.push("");
}
if (issues.soundGaps.length) {
lines.push(`■ 音があるのに文字起こしが無い区間 ${issues.soundGaps.length} 件（環境音だけなら問題なし。発話があるなら取りこぼし）`);
for (const g of issues.soundGaps) lines.push(` ${fmtTime(g.start)}〜${fmtTime(g.end)}（${g.sec}秒）`);
lines.push("");
}
if (issues.punctOnly.length) {
lines.push(`■ 句読点だけの語 ${issues.punctOnly.length} 件（字幕で行頭に孤立する事故の元。字幕生成側で直前の語へ結合する対策済みだが、元データにも注意）`);
for (const it of issues.punctOnly) lines.push(` ${fmtTime(it.start)} 「${it.word}」`);
lines.push("");
}
if (issues.repeats.length) {
lines.push(`■ 同じ語の繰り返し ${issues.repeats.length} 件（言い淀みか誤認識の疑い）`);
for (const it of issues.repeats) lines.push(` ${fmtTime(it.start)} 「${it.word}」×${it.count}`);
lines.push("");
}
if (issues.longTokens.length) {
lines.push(`■ 異常に長い語 ${issues.longTokens.length} 件（文節の融合・誤認識の疑い）`);
for (const it of issues.longTokens) lines.push(` ${fmtTime(it.start)} 「${it.word}」`);
lines.push("");
}
if (issues.dictHits.length) {
lines.push(`■ 辞書登録済みの誤変換の残り ${issues.dictHits.length} 件（prepare のやり直しが必要）`);
for (const it of issues.dictHits) lines.push(` 「${it.wrong}」→「${it.right}」`);
lines.push("");
}
if (!total) lines.push("要確認はありませんでした。");
fs.writeFileSync(path.join(workDir, "verify.txt"), lines.join("\n") + "\n", "utf-8");
return report;
}
