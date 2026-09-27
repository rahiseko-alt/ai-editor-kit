// video-shorts src/filler-cut.mjs — 言い淀み（フィラー）を切る区間を決める。
//
// 【なぜ作ったか】2026-08-19 マスター指摘「えーっと/あっ などの言いよどみが一切消えていない」。
// 調べたら消す工程が1つも無かった（区間を選んで繋ぐだけだった）。文字起こしには実際に
// 残っている（実測: 149秒の素材で13回 = 5.2回/分）ので、Whisper が落としているのではない。
//
// 【設計の根拠】docs/合格条件.md §4。フィラーは2種類あり、難易度が1桁違う。
//   クラスA（母音性: えー/あー/んー/うー/おー）— 実質語と衝突しないので機械的に切れる。
//     CSJ の実測分類では え系だけで約58%。**まずこれだけ作る。**
//   クラスB（語彙的: あの/その/まあ/なんか/こう）— 連体詞・副詞と同形。文脈判断が必須。
//     国語研の転記仕様書に「あの/その に関して、フィラーと連体詞とで迷う場合には、
//     原則(F)を付与した上で迷った旨をコメント」とある＝専門家が音声を聞いても迷う。
//     **ここでは扱わない。** 扱うなら承認制にする（合格条件 §4）。
//
// 【判定の単位は「文節」（2026-09-26）】Groq の日本語の語は1文字単位に近い部分語で返る
// （「くれちゃうんです」が「く」「れ」「ちゃ」「う」「ん」「で」「す」になる）。以前は語ごとに判定して
// いたため、1文字の「ん」「あ」「え」が CLASS_A に一致し、前後に語の内部の無音の誤検出があると、
// 「くれちゃ[ん]です」の「ん」をフィラーとして切っていた（合成データで再現。tests/filler-cut.mjs）。
// 無音スナップで既に踏んだのと同じ誤り（edit-job.mjs の isInsideAnyWord の経緯）なので、同じく
// BudouX の文節（groupIntoPhrases）を単位にし、**文節まるごとが母音性フィラーのときだけ**候補にする。
// 「えーまず」のように文節がくっついたものは切らない（迷ったら消さない＝虎の巻 §4-1）。
//
// 【消せないものは消さない】Descript の "Avoid harsh cuts" と同じ降参の実装。
// 隣の語を削らずに切り出せないフィラーは、そのまま残す。無理に消すと
// 「カットが harsh」（Descript のフィードバックで他要望より400票多い最多の不満）になる。

import { groupIntoPhrases } from "./script/phrases.mjs";

/** クラスA（母音性フィラー）。CSJ 前川2012 の表層形リストに基づく。 */
const CLASS_A = /^(?:え[ーぇえ]*(?:っ?と[ーぉ]*)?|あ[ーぁっ]*|ん[ーっ]*(?:と[ーぉ]*)?|う[ーぅ]+|お[ーぉ]+)$/;

/**
 * 消してはいけない語。
 * - 応答詞（はい/うん/ええ/いや）: CSJ は独話では応答詞に (F) を付けない＝フィラーではない。
 * - 感情表出（あーあ/うわ/えっ）: フィラーではなく感情表現そのもの。消すと意味が壊れる。
 */
const NEVER_CUT = new Set([
  "はい", "うん", "ううん", "ええ", "いえ", "いいえ", "いや", "そう", "うわ", "あーあ", "えっ",
]);

/** フィラー1個の長さの上限（秒）。これより長いものは、語の伸ばしや別の発話とみなして触らない。 */
const MAX_FILLER_SEC = 1.2;
/** 前後の無音をどこまで探すか（秒）。この範囲に無音が無ければ「消せない」と判断する。 */
const SILENCE_SEARCH_SEC = 0.15;
/** ひと塊の中でフィラー判定がこの割合を超えたら、判定が壊れているとみなして全部却下する。 */
const SANITY_MAX_RATIO = 0.5;

function isClassA(word) {
  const w = (word.w ?? "").trim();
  if (!w || NEVER_CUT.has(w)) return false;
  return CLASS_A.test(w);
}

/** t が無音区間の中に入っているか。入っていればその区間を返す。 */
function silenceAt(t, silences) {
  for (const s of silences) {
    if (t >= s.start - 1e-6 && t <= s.end + 1e-6) return s;
  }
  return null;
}

/** t の近く（distance 以内）にある無音区間の端を返す。無ければ null。 */
function nearestSilenceEdge(t, silences, distance) {
  let best = null;
  let bestDist = Infinity;
  for (const s of silences) {
    for (const edge of [s.start, s.end]) {
      const d = Math.abs(edge - t);
      if (d <= distance && d < bestDist) {
        bestDist = d;
        best = edge;
      }
    }
  }
  return best;
}

/**
 * 切り落とすべきフィラー区間を決める。
 *
 * @param {{w:string,start:number,end:number}[]} words 文字起こしの語（素材の時刻）。内部で文節にまとめてから判定する
 * @param {{start:number,end:number}[]} silences ffmpeg silencedetect の実測値
 * @returns {{cuts:{start:number,end:number,word:string}[], skipped:{word:string,start:number,reason:string}[], aborted:boolean}}
 */
export function planFillerCuts(rawWords, silences) {
  // 判定は文節単位（冒頭のコメント参照）。以下の words は文節の並び。
  const words = groupIntoPhrases(rawWords, silences);
  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    if (isClassA(words[i])) candidates.push(i);
  }
  // 判定が壊れているときの歯止め（合格条件 §4）。まともな素材でフィラーが半数を超えることはない。
  if (words.length > 0 && candidates.length / words.length > SANITY_MAX_RATIO) {
    return { cuts: [], skipped: [], aborted: true };
  }

  const cuts = [];
  const skipped = [];
  for (const i of candidates) {
    const w = words[i];
    const dur = w.end - w.start;
    if (!(dur > 0) || dur > MAX_FILLER_SEC) {
      skipped.push({ word: w.w, start: w.start, reason: `長さが範囲外(${dur.toFixed(2)}秒)` });
      continue;
    }

    // 切り口は「無音の内側」でなければならない（虎の巻 §3-1）。
    // 語の前後それぞれについて、無音の中に居るか・近くに無音の端があるかを見る。
    const headSil = silenceAt(w.start, silences);
    const tailSil = silenceAt(w.end, silences);
    const from = headSil ? Math.max(headSil.start, w.start - SILENCE_SEARCH_SEC)
      : nearestSilenceEdge(w.start, silences, SILENCE_SEARCH_SEC);
    const to = tailSil ? Math.min(tailSil.end, w.end + SILENCE_SEARCH_SEC)
      : nearestSilenceEdge(w.end, silences, SILENCE_SEARCH_SEC);

    if (from == null || to == null || !(to > from)) {
      // 隣の語を削らずには消せない＝消さない（Descript "Avoid harsh cuts" と同じ判断）。
      skipped.push({ word: w.w, start: w.start, reason: "前後に無音が無く、隣の語を削らずには消せない" });
      continue;
    }
    cuts.push({ start: from, end: to, word: w.w });
  }

  // 重なり・隣接をまとめる（同じ場所を2回切らない）。
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, c.end);
      last.word += "+" + c.word;
    } else {
      merged.push({ ...c });
    }
  }
  return { cuts: merged, skipped, aborted: false };
}

/**
 * 採用区間から、フィラー区間を抜いた区間列を作る。
 * 抜いた結果が極端に短い破片になった場合は捨てる（1フレーム未満の区間を ffmpeg へ渡さない）。
 */
export function subtractCuts(ranges, cuts, minPieceSec = 0.08) {
  const out = [];
  for (const r of ranges) {
    let pieces = [{ start: r.start, end: r.end }];
    for (const c of cuts) {
      const next = [];
      for (const p of pieces) {
        if (c.end <= p.start || c.start >= p.end) {
          next.push(p);
          continue;
        }
        if (c.start > p.start) next.push({ start: p.start, end: c.start });
        if (c.end < p.end) next.push({ start: c.end, end: p.end });
      }
      pieces = next;
    }
    for (const p of pieces) {
      if (p.end - p.start >= minPieceSec) out.push(p);
    }
  }
  return out;
}
