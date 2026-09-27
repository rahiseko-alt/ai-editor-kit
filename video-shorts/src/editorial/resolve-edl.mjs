// video-shorts src/editorial/resolve-edl.mjs — 編集案（文節番号）を、書き出し用の EDL（秒）へ直す。
//
// ここは判断をしない。やるのは決定論的な変換だけ:
//   1. 文節番号 → 文字起こし上の時刻（units.json の start/end）
//   2. 無音スナップ（boundary.mjs。捨てると決めた隣の文節は越えない）
//   3. 言い淀みの除去（filler-cut.mjs。1区間が複数の破片に分かれることがある）
// 同じ入力からは常に同じ EDL が出る。書き出し（renderFinal）は EDL だけを見る。
//
// EDL（edl.json, version 2）:
//   {
//     "version": 2,
//     "source": "<元動画のパス>",
//     "ranges": [ { "start": 12.382, "end": 18.744, "segment": 0, "fromUnit": 12, "toUnit": 18, "role": "HOOK" }, ... ],
//     "fillerCuts": [...], "fillerSkipped": [...], "fillerAborted": false,
//     "options": { "noSnap": false, "noFiller": false }
//   }
// ranges の並び順が動画での順番。1つの segment から複数の range が出ることがある（言い淀み除去）。

import { planFillerCuts, subtractCuts } from "../filler-cut.mjs";
import { groupIntoPhrases } from "../script/phrases.mjs";
import { snapRanges } from "./boundary.mjs";

/** 区間どうしの繋ぎ目で、片側に残す元の無音の上限（秒）。両側で最大 1.2 秒の間になる。
 * 繋ぎ目は話題の変わり目なので、文中の間より長く取る（合格条件 共通8・虎の巻 §3-4）。
 * 2026-09-27、一律 0.3 秒だと繋ぎ目の間が文中の間（0.5〜1秒）と区別できず不合格になった。 */
export const JOIN_MARGIN_SEC = 0.6;

/**
 * @param {{plan:object, units:{start:number,end:number}[], silences:{start:number,end:number}[],
 *   words:{w:string,start:number,end:number}[], source:string, noSnap?:boolean, noFiller?:boolean}} args
 */
export function resolveEdl({ plan, units, silences, words, source, noSnap = false, noFiller = false }) {
  const raw = plan.segments.map((seg) => ({ start: units[seg.fromUnit].start, end: units[seg.toUnit].end }));
  const snapped = noSnap ? raw : snapRanges(raw, silences, groupIntoPhrases(words, silences), { joinMarginSec: JOIN_MARGIN_SEC });

  const filler = noFiller ? { cuts: [], skipped: [], aborted: false } : planFillerCuts(words, silences);
  const cuts = filler.aborted ? [] : filler.cuts;

  const ranges = [];
  snapped.forEach((r, i) => {
    const seg = plan.segments[i];
    for (const piece of subtractCuts([r], cuts)) {
      ranges.push({
        start: piece.start,
        end: piece.end,
        // 字幕に出してよい語の範囲。無音スナップで区間が捨てた隣の文節へ広がっても、
        // その語を字幕に出さないため（2026-09-27、「ね、今日は」「いてSNS用の」が字幕に出た）。
        textStart: Math.max(piece.start, units[seg.fromUnit].start),
        textEnd: Math.min(piece.end, units[seg.toUnit].end),
        segment: i,
        fromUnit: seg.fromUnit,
        toUnit: seg.toUnit,
        ...(seg.role ? { role: seg.role } : {}),
      });
    }
  });

  return {
    version: 2,
    source,
    ranges,
    fillerCuts: filler.cuts,
    fillerSkipped: filler.skipped,
    fillerAborted: filler.aborted,
    options: { noSnap, noFiller },
  };
}
