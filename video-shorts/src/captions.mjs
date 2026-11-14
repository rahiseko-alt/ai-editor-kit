// video-shorts src/captions.mjs — 字幕校正の工程（生成・読みやすさ検証・校正記録の照合・門番）。
//
// 字幕の精度は「モデル依存度を最小にする」設計で上げる。
// 分担は次のとおりで、プログラムが決められることはプログラムに寄せる:
// - 時刻はプログラムが持つ（文節番号と単語時刻から算出。AI は時刻を編集しない）。
// - 決定的に直せる誤変換は、用語辞書（term-corrections.json）でプログラムが直す。
// - 読みやすさは数値で機械検証する（Netflix 日本語 SDH 公式基準:
// 1行16字まで / 1秒あたり7字（CPS）まで / 最大2行 / 最短表示0.5秒）。
// - AI（運用者）の担当は「証拠のある意味レベルの修正」だけ。用語リストに無い語は
// 推測で直さず、校正記録（proof.json）に残す。
// - 工程を飛ばせないよう、render は校正の照合（checkProof）が通らないと字幕を焼けない。
//
// 校正の手順そのものは docs/字幕校正の手順.md（AI 一般向け・命令形）が正。
// このファイルは、その手順が済んだことを機械的に照合する側だけを持つ。

import fs from "node:fs";
import path from "node:path";

import { sha256} from "./editorial/approval.mjs";

export const CAPTIONS_FILE = "captions.ass";
export const CAPTIONS_META_FILE = "captions.json";
export const CAPTIONS_TXT_FILE = "captions.txt";
export const PROOF_FILE = "proof.json";

// 読みやすさの基準（Netflix 日本語字幕 SDH 公式。出典は docs/字幕校正の手順.md）。
export const READABILITY = {
MAX_CPS: 7, // 1秒あたりの文字数（全角=1字として数える）
MAX_LINE_CHARS: 16, // 1行の文字数（同上）
MAX_LINES: 2,
MIN_DURATION: 0.5, // 最短の表示時間（秒）
};

const RULE_LABEL = {
cps: "CPS超過（1秒あたり7字まで）",
lineLength: "行の文字数超過（1行16字まで）",
lines: "行数超過（最大2行）",
duration: "表示時間が短すぎる（最短0.5秒）",
};

/** 全角相当なら2、半角なら1（srt-builder.mjs / edit-job.mjs の charDisplayWidth と同じ判定）。 */
function charDisplayWidth(ch) {
const cp = ch.codePointAt(0);
const WIDE_RANGES = [
[0x1100, 0x115f],
[0x2e80, 0xa4cf],
[0xac00, 0xd7a3],
[0xf900, 0xfaff],
[0xff00, 0xff60],
[0xffe0, 0xffe6],
[0x20000, 0x3fffd],
];
return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b)? 2: 1;
}

/** 字幕の文字数（全角=1、半角=0.5 として数える。\N は数えない）。 */
export function countTextChars(text) {
let n = 0;
for (const ch of String(text).replace(/\\N/g, "")) n += charDisplayWidth(ch) / 2;
return n;
}

/** キューの行（\N で分割）。 */
export function cueLines(text) {
return String(text).split("\\N");
}

/** 1キューの CPS（文字数÷表示秒数）。 */
export function cueCps(cue) {
const dur = cue.end - cue.start;
if (!(dur > 0)) return Infinity;
return countTextChars(cue.text) / dur;
}

/**
* 読みやすさの機械検証（純粋関数）。
* @param {{start:number,end:number,text:string}[]} cues
* @returns {{cue:number, rule:string, detail:string}[]} cue は1始まりの字幕番号。
*/
export function checkReadability(cues) {
const violations = [];
cues.forEach((cue, i) => {
const n = i + 1;
const lines = cueLines(cue.text);
if (lines.length > READABILITY.MAX_LINES) {
violations.push({ cue: n, rule: "lines", detail: `${lines.length}行あります`});
}
lines.forEach((line, li) => {
const chars = countTextChars(line);
if (chars > READABILITY.MAX_LINE_CHARS) {
violations.push({ cue: n, rule: "lineLength", detail: `${li + 1}行目が${chars}字あります`});
}
});
const dur = cue.end - cue.start;
if (dur < READABILITY.MIN_DURATION) {
violations.push({ cue: n, rule: "duration", detail: `表示時間が${dur.toFixed(2)}秒しかありません`});
}
const cps = cueCps(cue);
if (cps > READABILITY.MAX_CPS) {
violations.push({ cue: n, rule: "cps", detail: `CPS が ${cps.toFixed(1)} です`});
}
});
return violations;
}

export function formatViolation(v) {
return `字幕${v.cue}: ${RULE_LABEL[v.rule]}（${v.detail}）`;
}

/** ASS の時刻（H:MM:SS.cc）を秒へ直す。 */
export function parseAssTime(text) {
const m = String(text).trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
if (!m) return null;
return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

/**
* ASS ファイルの Dialogue 行をキューとして読み戻す（純粋関数）。
* 校正で編集された captions.ass の本文・時刻を、生成時の記録と照合するために使う。
* @returns {{start:number,end:number,text:string}[]}
*/
export function parseAssDialogues(assText) {
const cues = [];
for (const line of String(assText).split(/\r?\n/)) {
if (!line.startsWith("Dialogue:")) continue;
// Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
// Text にはカンマが含まれうるので、先頭9フィールドだけを切り離す。
const parts = line.slice("Dialogue:".length).split(",");
if (parts.length < 10) continue;
const start = parseAssTime(parts[1]);
const end = parseAssTime(parts[2]);
if (start == null || end == null) continue;
cues.push({ start, end, text: parts.slice(9).join(",").trim()});
}
return cues;
}

function fmtClock(sec) {
const m = Math.floor(sec / 60);
const s = sec - m * 60;
return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
* 校正用一覧（captions.txt）の本文を作る（純粋関数）。
* 各キューに CPS と行数を併記し、末尾に違反一覧と、使用範囲内の検証フラグ
* （proof.json で全件回答が要るもの）を並べる。
*/
export function formatCaptionsTxt({ jobId, planHash, cues, violations, flags}) {
const lines = [];
lines.push(`字幕校正用一覧（job ${jobId}）`);
lines.push(`編集案ハッシュ: ${planHash}`);
lines.push("校正は docs/字幕校正の手順.md の手順で行い、captions.ass の本文だけを直すこと。時刻は直さないこと。");
lines.push("直したら proof.json に校正記録を書くこと（書式は docs/字幕校正の手順.md）。");
lines.push("");
cues.forEach((cue, i) => {
const ls = cueLines(cue.text);
lines.push(
`${i + 1} [${fmtClock(cue.start)}-${fmtClock(cue.end)}] CPS ${cueCps(cue).toFixed(1)} / ${ls.length}行`
);
for (const l of ls) lines.push(` ${l}`);
});
lines.push("");
lines.push(`■ 読みやすさの違反 ${violations.length} 件（基準: 1行16字 / CPS 7 / 最大2行 / 最短0.5秒）`);
if (violations.length) for (const v of violations) lines.push(` ${formatViolation(v)}`);
else lines.push(" 違反はありません。");
lines.push("");
lines.push(`■ 検証フラグ（使用範囲内） ${flags.length} 件（proof.json の checkedFlags で全件に回答すること）`);
if (flags.length) for (const f of flags) lines.push(` ${f.id}: ${f.detail}`);
else lines.push(" 使用範囲内のフラグはありません。");
lines.push("");
return lines.join("\n") + "\n";
}

const FLAG_TIME_CATEGORIES = ["lowConfidence", "punctOnly", "longTokens", "repeats", "soundGaps"];

/**
* verify の要確認フラグのうち、編集案の使用範囲（文節の時刻範囲）に入るものを返す。
* フラグ ID は「カテゴリ:そのカテゴリ内での連番（0始まり）」で、verify.json の並びで決まる。
* dictHits は位置を持たないため、使用範囲内外を問わず常に回答対象にする。
* @param {object} verifyReport verify.json の中身
* @param {object} plan 編集案
* @param {{start:number,end:number}[]} units 文節一覧
* @returns {{id:string, category:string, detail:string}[]}
*/
export function collectVerifyFlags(verifyReport, plan, units) {
const issues = verifyReport?.issues?? {};
const spans = (plan?.segments?? []).map((seg) => ({
start: units[seg.fromUnit]?.start?? Infinity,
end: units[seg.toUnit]?.end?? -Infinity,
}));
const inRange = (t) => typeof t === "number" && spans.some((s) => t >= s.start && t <= s.end);
const flags = [];
for (const cat of FLAG_TIME_CATEGORIES) {
(issues[cat]?? []).forEach((item, idx) => {
if (!inRange(item.start)) return;
let detail;
if (cat === "lowConfidence") detail = `確信度の低い語「${item.word}」（確信度 ${item.p}）…前後: ${item.context}`;
else if (cat === "punctOnly") detail = `句読点だけの語「${item.word}」`;
else if (cat === "longTokens") detail = `異常に長い語「${item.word}」`;
else if (cat === "repeats") detail = `同じ語の繰り返し「${item.word}」×${item.count}`;
else detail = `音があるのに文字起こしが無い区間（${item.sec}秒）`;
flags.push({ id: `${cat}:${idx}`, category: cat, detail});
});
}
(issues.dictHits?? []).forEach((item, idx) => {
flags.push({
id: `dictHits:${idx}`,
category: "dictHits",
detail: `辞書登録済みの誤変換の残り「${item.wrong}」→「${item.right}」（使用範囲内外を問わず回答対象）`,
});
});
return flags;
}

/**
 * キューが出力タイムラインのどこ・元のどの文節から来たかを、区間の対応表から決める（純粋関数）。
 * @param {{start:number,end:number}} cue 出力タイムライン上のキュー
 * @param {{outStart:number,outEnd:number,srcStart:number,srcEnd:number,segment:number,fromUnit:number,toUnit:number}[]} spans
 *   書き出し区間ごとの、出力側の開始・終了と素材側の開始・終了と文節範囲。
 * @param {{start:number,end:number}[]} units 文節一覧
 * @returns {{segment:number, fromUnit:number, toUnit:number}}
 */
export function cueProvenance(cue, spans, units) {
  const span =
    spans.find((s) => cue.start >= s.outStart && cue.start < s.outEnd) ??
    spans[spans.length - 1] ?? { segment: 0, fromUnit: 0, toUnit: 0, outStart: 0, srcStart: 0, srcEnd: 0 };
  const srcFrom = span.srcStart + Math.max(0, cue.start - span.outStart);
  const srcTo = Math.min(span.srcEnd, span.srcStart + Math.max(0, cue.end - span.outStart));
  let from = null;
  let to = null;
  for (let u = span.fromUnit; u <= span.toUnit; u++) {
    const unit = units[u];
    if (!unit) continue;
    if (unit.end > srcFrom && unit.start < srcTo) {
      if (from === null) from = u;
      to = u;
    }
  }
  return {
    segment: span.segment,
    fromUnit: from ?? span.fromUnit,
    toUnit: to ?? span.toUnit,
  };
}

function readJsonIfExists(p) {
if (!fs.existsSync(p)) return null;
try {
return JSON.parse(fs.readFileSync(p, "utf-8"));
} catch {
return undefined; // 読めたが壊れている
}
}

/**
* 校正が完了しているかを照合する（門番）。不足は日本語の理由の配列で返す（空なら合格）。
* 検査項目:
* (a) captions.json の planHash が現在の編集案と一致する
* (b) proof.json が存在し planHash が一致する
* (c) 使用範囲内の verify フラグ全件に proof.checkedFlags の回答がある
* (d) proof.corrections の from が生成時本文と、to が現在の captions.ass 本文と一致する。
* 記録の無い書き換え（生成時と現在の差分で、corrections に無いもの）も不足とする
* (e) 現在の字幕の読みやすさ違反が 0、または proof.waivers で理由つきで免除されている
* (f) captions.ass の時刻が生成時から改変されていない（キュー数・開始・終了の照合）
*/
export function checkProof({ workDir, planText, plan, units}) {
const problems = [];
const planHash = sha256(planText);

const meta = readJsonIfExists(path.join(workDir, CAPTIONS_META_FILE));
if (meta === null) {
problems.push("字幕がまだ生成されていません（captions.json がありません）。先に captions コマンドで字幕を生成してください");
return problems;
}
if (meta === undefined) {
problems.push("captions.json が読めません。captions コマンドで生成し直してください");
return problems;
}
// (a)
if (meta.planHash!== planHash) {
problems.push("字幕が古い編集案で生成されています（編集案が変わっています）。captions コマンドで生成し直し、校正をやり直してください");
return problems;
}
const genCues = meta.cues?? [];

const assPath = path.join(workDir, CAPTIONS_FILE);
if (!fs.existsSync(assPath)) {
problems.push("captions.ass がありません。captions コマンドで生成し直してください");
return problems;
}
const curCues = parseAssDialogues(fs.readFileSync(assPath, "utf-8"));

// (f) 時刻の改変検出
if (curCues.length!== genCues.length) {
problems.push(`字幕の数が生成時と違います（生成時 ${genCues.length} 件 / 現在 ${curCues.length} 件）。時刻と数はプログラムの管理下にあるため、captions.ass の行を増減させないでください`);
} else {
genCues.forEach((g, i) => {
const c = curCues[i];
if (Math.abs(c.start - g.start) > 0.001 || Math.abs(c.end - g.end) > 0.001) {
problems.push(`字幕${i + 1} の時刻が生成時から変わっています（生成時 ${g.start}-${g.end} / 現在 ${c.start}-${c.end}）。時刻は直さないでください`);
}
});
}

// (b) proof.json
const proof = readJsonIfExists(path.join(workDir, PROOF_FILE));
if (proof === null) {
problems.push("校正記録（proof.json）がありません。docs/字幕校正の手順.md の手順で字幕を全文校正し、記録を書いてください");
return problems;
}
if (proof === undefined) {
problems.push("proof.json が読めません（JSON として壊れています）。書き直してください");
return problems;
}
if (proof.planHash!== planHash) {
problems.push("proof.json の planHash が現在の編集案と一致しません。校正をやり直して記録を書き直してください");
}

// (c) verify フラグへの全件回答
const verifyReport = readJsonIfExists(path.join(workDir, "verify.json"));
if (verifyReport === null || verifyReport === undefined) {
problems.push("verify.json がありません。prepare を実行して検証を先に済ませてください");
} else {
const flags = collectVerifyFlags(verifyReport, plan, units);
const answered = new Set(
(Array.isArray(proof.checkedFlags)? proof.checkedFlags: []).map((f) =>
typeof f === "string"? f: f?.flag
)
);
for (const f of flags) {
if (!answered.has(f.id)) {
problems.push(`検証フラグ ${f.id} への回答が proof.json の checkedFlags にありません（${f.detail}）`);
}
}
}

// (d) corrections の差分照合
const corrections = Array.isArray(proof.corrections)? proof.corrections: [];
const corrByCue = new Map();
for (const c of corrections) {
if (!c ||!Number.isInteger(c.cue)) {
problems.push("proof.json の corrections に、cue（字幕番号）が無い項目があります");
continue;
}
corrByCue.set(c.cue, c);
}
const n = Math.min(genCues.length, curCues.length);
for (let i = 0; i < n; i++) {
const gen = genCues[i].text;
const cur = curCues[i].text;
const corr = corrByCue.get(i + 1);
if (gen === cur) {
if (corr) problems.push(`字幕${i + 1} は生成時から変わっていないのに、corrections に記録があります（from/to を実際の本文に合わせてください）`);
continue;
}
if (!corr) {
problems.push(`字幕${i + 1} が生成時から書き換わっていますが、proof.json の corrections に記録がありません（「${gen}」→「${cur}」）`);
} else {
if (corr.from!== gen) problems.push(`字幕${i + 1} の corrections.from が生成時の本文と一致しません（生成時: 「${gen}」/ 記録: 「${corr.from}」）`);
if (corr.to!== cur) problems.push(`字幕${i + 1} の corrections.to が現在の本文と一致しません（現在: 「${cur}」/ 記録: 「${corr.to}」）`);
}
}
for (const c of corrections) {
if (c && Number.isInteger(c.cue) && (c.cue < 1 || c.cue > genCues.length)) {
problems.push(`proof.json の corrections に、存在しない字幕番号 ${c.cue} の記録があります`);
}
}

// (e) 読みやすさ違反と免除
const waivers = Array.isArray(proof.waivers)? proof.waivers: [];
const waived = new Set(
waivers.filter((w) => w && w.reason && String(w.reason).trim()).map((w) => `${w.cue}:${w.rule}`)
);
for (const v of checkReadability(curCues)) {
if (!waived.has(`${v.cue}:${v.rule}`)) {
problems.push(`読みやすさの違反が残っています: ${formatViolation(v)}（直すか、proof.json の waivers に理由を書いて免除してください）`);
}
}

return problems;
}

/** render の門番。通らなければ理由を並べた Error を投げる。 */
export function assertCaptionsProofed({ workDir, planText, plan, units}) {
const problems = checkProof({ workDir, planText, plan, units});
if (problems.length) {
throw new Error(
`字幕校正が完了していません（このままでは字幕を焼けません）:\n- ${problems.join("\n- ")}\n` +
"手順: captions コマンドで字幕を生成 → docs/字幕校正の手順.md の手順で校正 → proof.json を書く → render"
);
}
}
