// video-shorts src/script/phrases.mjs — 語の並びを、意味の単位（文節）にまとめる。
// 2026-09-26 に src/edit-job.mjs から中身を変えずに移した（責務ごとにファイルを分けるため）。

import { Parser as BudouxParser } from "../vendor/budoux/parser.mjs";
import { model as BUDOUX_JA_MODEL } from "../vendor/budoux/ja-model.mjs";

/** BudouX のパーサは状態を持たないので1個を使い回す（モデルの読み込みは1回だけ）。 */
let _budoux = null;
function budouxParser() {
  if (!_budoux) _budoux = new BudouxParser(BUDOUX_JA_MODEL);
  return _budoux;
}

// ---------- 2.5 台本化（文節の切れ目を取る） ----------
//
// 【2026-08-19】ここは最初 LLM に「文と文節の切れ目の添字」を返させていたが、実測して捨てた。
//   - 遅い（かたまりごとに claude -p の往復が増える）
//   - 精度が出ない（複合語を割るなと指示しても「ラッシュ/カット」を割った）
// 代わりに BudouX（Google, Apache-2.0, src/vendor/budoux）を同梱して使う。辞書も外部通信も
// 不要で 0.03ms/回、同じ入力なら常に同じ出力になる。
//
// 実測（同じ素材・同じ採用区間で比較）:
//   カード末が語の途中で終わる   縦型 85% → 0% / 横型 75% → 0%
//   行の中で語が割れる           縦型 29箇所 → 0 / 横型 6箇所 → 0
// 残る欠陥（助詞・接続助詞で終わるカード）は句読点が無い限り解けない。docs/caption-plan.md 参照。

/**
 * BudouX は文字列しか見ないので、文節（意味の単位）の内部に実測した無音の「間」が
 * またがっていても、それを1つの塊として繋いでしまうことがある。
 * 【実測した事故】「まとめてくれるんですよ」+「えーっと」が1文節に融合（語間 1.54秒、
 * その間に実測無音 95.399955–96.282494 / 96.369615–96.858231、gapとの重なり 0.8825秒）。
 * 「助かりますよね」+「あ、」も同様（語間 1.32秒、実測無音 193.134354–194.158753、
 * gapとの重なり 0.6936秒）。「です」+「うーん」も同様（語間 0.72秒、
 * 実測無音 138.281315–138.992698、gapとの重なり 0.4067秒）。
 * これを文の切れ目として扱わないと、捨てたいフィラーが直前の文末表現に糊付けされ、
 * keep.json 側で独立に選べなくなる（2026-08-19、実際にダイジェストの最後が「あ、」で
 * 終わる事故になった）。
 *
 * 一方、無音の内側判定（isInsideAnyWord、上のコメント参照）が扱っている通り、
 * Groq の日本語 word timestamp は部分語（文字単位）に割れることがあり、そこに乗る
 * silencedetect の誤検出は 0.15〜0.308 秒で観測されている（同じ「切り分けてくれちゃう」
 * 直前にも 0.152秒・0.157秒の誤検出が実測されている）。0.2 秒の閾値は既に試して
 * 事故を起こした（上のコメント参照）。本物の間として観測された重なりの最小値は
 * 0.4067 秒で、既知の誤検出上限 0.308 秒との間は 0.1 秒しかない狭い窓だが、
 * マスター指示により閾値を 0.3 秒とする（過去最大の誤検出 0.308 秒をわずかに
 * 下回るため、その特定の誤検出パターンが再度観測された場合は取りこぼさず分割して
 * しまう可能性が残る。実測で問題が出た場合はここを見直すこと）。
 */
const SILENT_GAP_SPLIT_MIN_SEC = 0.3;

/** [gapStart, gapEnd) と silences の各区間との重なり幅の合計（秒）。
 * detectSilences() の区間は互いに重ならない前提（生成順が単調増加）なので、
 * 単純に足し合わせても gap の幅を超えない。 */
function silenceOverlapSec(gapStart, gapEnd, silences) {
  if (gapEnd <= gapStart) return 0;
  let total = 0;
  for (const s of silences) {
    const ov = Math.min(s.end, gapEnd) - Math.max(s.start, gapStart);
    if (ov > 0) total += ov;
  }
  return total;
}

/** 語の並びから、BudouX の文節境界で区切った塊を作る。塊は {w,start,end} を持つので、
 * packWordsIntoLines / buildCaptionCards がそのまま1トークンとして扱える。
 *
 * 【時刻の戻し方】BudouX は文字列しか見ないので、語を連結した文字列の「文字位置」で
 * 元の語へ逆写像し、塊の start = 先頭語の start、end = 末尾語の end とする。
 * （文字を足し引きしないので、この対応は必ず一致する）
 *
 * @param {{w:string,start:number,end:number}[]} words
 * @param {{start:number,end:number}[]} [silences] 実測無音（省略時は今までと出力が完全一致する）
 */
export function groupIntoPhrases(words, silences = []) {
  if (!words.length) return [];
  const text = words.map((w) => w.w).join("");
  const phrases = budouxParser().parse(text);

  const units = [];
  let wordIdx = 0;
  let consumedInWord = 0; // いま見ている語のうち、すでに塊へ配った文字数
  for (const phrase of phrases) {
    let need = phrase.length;
    const first = wordIdx;
    let charsConsumed = 0;
    // 語をまたがない（＝曖昧さの無い）分割候補点。文節の境界が語の内側に来た場合
    // （次の文節と共有される部分語）は、境界の帰属が曖昧なので候補にしない。
    const candidates = []; // {afterWordIdx, charOffset}
    while (need > 0 && wordIdx < words.length) {
      const remain = words[wordIdx].w.length - consumedInWord;
      if (remain > need) {
        // 文節の境界が語の内側に来た場合（部分語をまたがず割った場合）。
        // 語は分割せず、この語まで塊に含める（欠けさせない＝虎の巻 原則3）。
        consumedInWord += need;
        charsConsumed += need;
        need = 0;
      } else {
        need -= remain;
        charsConsumed += remain;
        consumedInWord = 0;
        if (need > 0) candidates.push({ afterWordIdx: wordIdx, charOffset: charsConsumed });
        wordIdx += 1;
      }
    }
    const last = Math.max(first, (consumedInWord > 0 ? wordIdx : wordIdx - 1));

    // 候補のうち、語の間に実測した無音が SILENT_GAP_SPLIT_MIN_SEC 秒以上重なるものだけを
    // 実際の分割点として採用する（無音が複数見つかった場合も自然に3個以上へ分かれる）。
    const splits = candidates.filter(({ afterWordIdx }) => {
      const gapStart = words[afterWordIdx].end;
      const gapEnd = words[afterWordIdx + 1].start;
      return silenceOverlapSec(gapStart, gapEnd, silences) >= SILENT_GAP_SPLIT_MIN_SEC;
    });

    let subFirst = first;
    let subCharStart = 0;
    for (const { afterWordIdx, charOffset } of splits) {
      units.push({
        w: phrase.slice(subCharStart, charOffset),
        start: words[subFirst].start,
        end: words[afterWordIdx].end,
        br: null,
      });
      subCharStart = charOffset;
      subFirst = afterWordIdx + 1;
    }
    units.push({
      w: phrase.slice(subCharStart),
      start: words[subFirst].start,
      end: words[Math.min(last, words.length - 1)].end,
      br: null,
    });
  }
  return units;
}
