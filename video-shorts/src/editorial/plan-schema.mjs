// video-shorts src/editorial/plan-schema.mjs — 編集案（editorial_plan.json）の形と検査。
//
// 編集案は、このセッションが units.json（番号付き文節一覧）を全文読んで直接書く。
// **時刻は書かない。** 書くのは文節番号だけで、時刻は resolve-edl.mjs が文字起こしから決める。
// AI が「だいたいこの辺」の秒数を書く経路を、形の段階で塞ぐため（虎の巻 §3-2）。
//
// 形（version 1）:
//   {
//     "version": 1,
//     "mode": "digest",                       … 任意。docs/合格条件.md のモード名
//     "instruction": "…",                     … 任意。受け取った指示の写し
//     "segments": [
//       { "fromUnit": 12, "toUnit": 18, "role": "HOOK", "reason": "…" },   … 並び順＝動画での順番
//       ...
//     ],
//     "applied": ["反映した指示"],
//     "notApplied": ["反映できなかった指示とその理由"]
//   }
//
// 移行期間は旧形式の keep.json（{"keep":[[開始,終了],...],"applied":[],"notApplied":[]}）も受け付け、
// keepToPlan で同じ形に直してから使う。

import fs from "node:fs";
import path from "node:path";

export const PLAN_FILE = "editorial_plan.json";
export const LEGACY_KEEP_FILE = "keep.json";

/** 時刻を表す名前。編集案にこれがあったら、AI が秒数を書いたとみなして止める。 */
const TIME_KEYS = ["start", "end", "startSec", "endSec", "time", "from", "to"];

const asLines = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : []);

/** 旧形式の keep.json を編集案の形へ直す。keep の [a,b] は小さい方を開始とする（旧 render と同じ）。 */
export function keepToPlan(keepDoc) {
  if (!keepDoc || !Array.isArray(keepDoc.keep)) throw new Error("keep.json に keep 配列がありません");
  return {
    version: 1,
    segments: keepDoc.keep.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`keep の要素が [開始, 終了] ではありません: ${JSON.stringify(pair)}`);
      const [a, b] = pair;
      return { fromUnit: Math.min(a, b), toUnit: Math.max(a, b) };
    }),
    applied: asLines(keepDoc.applied),
    notApplied: asLines(keepDoc.notApplied),
  };
}

/**
 * 編集案を検査する。問題があれば日本語の理由を並べた配列を返す（空なら合格）。
 * @param {object} plan
 * @param {number} unitCount units.json の文節数
 */
export function validatePlan(plan, unitCount) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["編集案が JSON オブジェクトではありません"];
  if (plan.version !== 1) errors.push(`version は 1 にしてください（今: ${JSON.stringify(plan.version)}）`);
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) {
    errors.push("segments が空です（採用する文節が1つもありません）");
    return errors;
  }
  plan.segments.forEach((seg, i) => {
    const where = `segments[${i}]`;
    if (!seg || typeof seg !== "object") {
      errors.push(`${where} がオブジェクトではありません`);
      return;
    }
    for (const k of TIME_KEYS) {
      if (k in seg) errors.push(`${where} に時刻（${k}）が書かれています。編集案には文節番号だけを書き、時刻はコードに決めさせてください`);
    }
    for (const k of ["fromUnit", "toUnit"]) {
      if (!Number.isInteger(seg[k]) || seg[k] < 0 || seg[k] >= unitCount) {
        errors.push(`${where}.${k} が文節番号として不正です（0〜${unitCount - 1} の整数）: ${JSON.stringify(seg[k])}`);
      }
    }
    if (Number.isInteger(seg.fromUnit) && Number.isInteger(seg.toUnit) && seg.fromUnit > seg.toUnit) {
      errors.push(`${where} の fromUnit（${seg.fromUnit}）が toUnit（${seg.toUnit}）より後ろです`);
    }
  });
  // 同じ文節を2回使うと、同じ発言が動画に2回出る（合格条件 S5）。並べ替えは許すが重複は許さない。
  const used = new Map();
  plan.segments.forEach((seg, i) => {
    if (!Number.isInteger(seg?.fromUnit) || !Number.isInteger(seg?.toUnit)) return;
    for (let u = seg.fromUnit; u <= seg.toUnit; u++) {
      if (used.has(u)) {
        errors.push(`文節${u} が segments[${used.get(u)}] と segments[${i}] の両方に入っています`);
        break;
      }
      used.set(u, i);
    }
  });
  return errors;
}

/**
 * work/<jobId> から編集案を読む。editorial_plan.json があればそれ、無ければ keep.json を変換する。
 * @returns {{plan: object, file: string, text: string}} text は承認の照合に使う元ファイルの中身
 */
export function loadPlan(workDir) {
  const planPath = path.join(workDir, PLAN_FILE);
  if (fs.existsSync(planPath)) {
    const text = fs.readFileSync(planPath, "utf-8");
    return { plan: JSON.parse(text), file: planPath, text };
  }
  const keepPath = path.join(workDir, LEGACY_KEEP_FILE);
  if (fs.existsSync(keepPath)) {
    const text = fs.readFileSync(keepPath, "utf-8");
    return { plan: keepToPlan(JSON.parse(text)), file: keepPath, text };
  }
  throw new Error(`編集案がありません（このセッションが直接書きます）: ${planPath}`);
}

/** 採用する文節の本文を、動画での順番どおりに並べた「台本案」を作る（承認を取るための表示用）。 */
export function renderScript(plan, units) {
  const lines = [];
  plan.segments.forEach((seg, i) => {
    const text = units.slice(seg.fromUnit, seg.toUnit + 1).map((u) => u.w).join("");
    const head = [`[${i + 1}]`, `文節${seg.fromUnit}-${seg.toUnit}`, seg.role ? `(${seg.role})` : ""].filter(Boolean).join(" ");
    lines.push(`${head}\n  ${text}`);
    if (seg.reason) lines.push(`  理由: ${seg.reason}`);
  });
  return lines.join("\n");
}
