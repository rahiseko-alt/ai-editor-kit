// video-shorts [5] 字幕生成 — 区間内の word-level を読みやすい字幕行にまとめ、
// 背景ボックス付き ASS 字幕を生成する。9:16(1080x1920)前提。
//
// 既製SaaSの「全ユーザー同一字幕」を避け自前デザインを握る（差別化・RB FORKOFF）。
// スタイルは選択式（subtitle-styles.mjs の登録を参照）。
//
// 【2026-08-17 マスター指示「1語ずつポンポン出すな」】字幕は必ず**行単位**で出す。
// 1枚の字幕（＝語のまとまり）につき Dialogue イベントは1つだけで、その行は
// 話し終わるまで出っぱなしになる。語ごとにイベントを刻む描画（旧 karaoke mode）も、
// 1語だけ画面中央に出しては消す描画（旧 pop プリセット）も、両方とも削除した。

import { DEFAULT_SUBTITLE_STYLE, computeSubtitleScale, scaleToken, resolveCaptionStyle } from "./subtitle-styles.mjs";

// 既定フォント（2026-08-14 是正）。旧既定 "Yu Gothic UI" はWindows専用で、この製品が
// 動く環境（客のPC。Linux/macOSも含む想定）に存在しないことがあり、fontconfig が
// 黙って別言語のフォントへ代替していた（docs/failures.md 2026-08-14）。IPAGothicは
// パブリックドメイン相当のライセンスでOS横断の日本語フォントとして広く使われており、
// 配布物にも同梱しやすい。実在の確認は src/font-check.mjs が担う（このモジュールは
// 「どのフォント名を使うか」だけを持ち、「実在するか」の判定は持たない）。
export const DEFAULT_FONT = "IPAGothic";

/** 区間 [start,end] に重なる words の、元配列での添字一覧。 */
function indexesInRange(words, start, end) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end > start && w.start < end) out.push(i);
  }
  return out;
}

/** 区間 [start,end] に入る words を抜き出し、相対時間(区間先頭=0)に変換 */
export function wordsInRange(words, start, end) {
  return indexesInRange(words, start, end).map((i) => {
    const w = words[i];
    return { w: w.w, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) };
  });
}

// 1枚の字幕が使う幅の下限（可用幅に対する割合）。最後の1語だけが取り残されて
// 「today」のような極端に短い字幕になるのを防ぐために使う（G-CAP-FIT-NOWRAP の (3)）。
const CAPTION_MIN_FILL = 0.6;

/** 語の配列を1本の文字列にする（半角どうしの間には空白を入れる）。 */
function joinWords(words) {
  let out = "";
  for (const w of words) out += (needsSpace(out, w.w) ? " " : "") + w.w;
  return out;
}

/** words を「1枚の字幕」ごとの語の配列へ割る（fits があれば幅で、無ければ文字数で判定）。 */
function groupWordArrays(words, maxChars, fits) {
  const groups = [];
  let cur = [];
  let text = "";
  for (const word of words) {
    const next = text + (needsSpace(text, word.w) ? " " : "") + word.w;
    if ((fits ? !fits(next) : next.length > maxChars) && cur.length > 0) {
      groups.push(cur);
      cur = [word];
      text = word.w;
    } else {
      cur.push(word);
      text = next;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * 短すぎる字幕を、直前の字幕から語を借りて埋める。
 *
 * 【なぜ要るか】貪欲に詰めると最後の1枚に端数だけが残る。英語の例では
 * 「Hello everyone welcome back to my channel」で1枚を使い切り、次の字幕が「today」1語だけ＝
 * 画面の3割しか使わない見た目になった（2026-08-16 実測 30.5%）。直前の字幕の末尾の語を
 * 移せば、どちらも読める幅になる（借りた側が上限行数を超える／貸した側が短くなりすぎる
 * ときは移さない）。語の並び順は変わらないので、字幕の順序も話した順のまま。
 */
function rebalanceShortCaptions(groups, measure, budgetPx, fits) {
  if (!measure || !Number.isFinite(budgetPx) || groups.length < 2) return groups;
  const floor = budgetPx * CAPTION_MIN_FILL;
  const textOf = (g) => joinWords(g);
  for (let i = groups.length - 1; i > 0; i--) {
    while (measure(textOf(groups[i])) < floor) {
      const prev = groups[i - 1];
      if (prev.length < 2) break;
      const cand = [prev[prev.length - 1], ...groups[i]];
      if (fits && !fits(textOf(cand))) break; // 借りた側が上限行数を超える
      if (measure(textOf(prev.slice(0, -1))) < floor) break; // 貸した側が短くなりすぎる
      prev.pop();
      groups[i] = cand;
    }
  }
  return groups;
}

/** words を maxChars 程度の字幕行（キャプション）にまとめる */
export function groupCaptions(words, maxChars = 18, fits = null, measure = null, budgetPx = Infinity) {
  const groups = rebalanceShortCaptions(groupWordArrays(words, maxChars, fits), measure, budgetPx, fits);
  return groups.map((g) => ({
    text: joinWords(g),
    start: g[0].start,
    end: g[g.length - 1].end,
  }));
}

/**
 * 秒 → ASS タイム形式 h:mm:ss.cc
 *
 * 【P2-3 のバグと直し方】旧実装は h/m/s を先に切り捨ててから、centisecond を
 * 別途 `Math.round((sec - Math.floor(sec)) * 100)` で出していた。99.xx センチ秒台の
 * 値を四捨五入すると 100 になりうる（例: 59.996秒 → 整数秒部分は59のまま・小数部
 * 0.996*100=99.6 を round すると100）が、繰り上げ先の秒(s)側はすでに切り捨て済みで
 * 更新されないため `0:00:59.100` のような3桁のcentisecond（ASSとして不正な時刻）を
 * 吐いてしまい、字幕の表示タイミングがずれる（実際には59.996秒は次の1分00秒0.00秒に
 * 繰り上がるべき）。
 *
 * 直し方は「先に全体を100分の1秒単位の整数へ丸めてから、その整数１つを
 * h/m/s/cs に分解する」。丸めを1回・最後に整数だけで行うため、centisecondが
 * 100になる余地そのものが無くなり、繰り上がりは自動的に h/m/s 側へ伝播する。
 */
export function assTime(sec) {
  const totalCs = Math.round(sec * 100); // 100分の1秒単位の整数へ丸める（ここでしか丸めない）
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** ASS の特殊文字をエスケープ */
function escAss(text) {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "（").replace(/\}/g, "）").replace(/\n/g, "\\N");
}

// ── AUD-P2-22: canvasに収まる表示幅(全角=2/半角=1カラム)を基準にした折り返し ──────────
//
// 文字「数」ベースの既存グルーピング(groupCaptions の maxChars)だけでは、
// canvasが小さい（拡大ガードで縮小された場合等）ときや、1語が極端に長い（伸ばし語・URL等）
// ときに、その1トークンだけで canvas の横幅からはみ出しうる（groupCaptions* は「既に中身が
// ある行に足すと超える」場合しか改行しないため、単独の長い1語はそのまま素通りする）。
// ここでは実際の canvas 幅・スケール後フォントサイズ・スケール後余白から「1行に収まる
// 幅の予算(px)」を求め、それでも収まらないものだけを ASS の強制改行(\N)で分割する。
// 2026-08-16 に「カラム数」方式から「書体ごとの実測送り幅(px)を積む」方式へ全面差し替え
// （旧方式は全角1文字を実測の1.88倍に見積もっており、字幕が画面の横幅を半分しか
// 使わない主因だった。lineBudgetPx のコメントと docs/failures.md 2026-08-16 を参照）。

/** 全角相当(East Asian Wide/Fullwidth・ハングル音節等)なら2カラム、それ以外(半角)は1カラム。 */
function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  const WIDE_RANGES = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2e80, 0xa4cf], // CJK Radicals..Yi（漢字・ひらがな・カタカナを含む）
    [0xac00, 0xd7a3], // Hangul Syllables
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0xff00, 0xff60], // Fullwidth Forms
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd], // CJK Extension B以降
  ];
  return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}

// 1行に使ってよい幅の上限（可用幅に対する割合）。可用幅いっぱい(1.0)まで詰めると、
// 1行が画面の端から端まで伸びて「短い行を積む」形にならない（実物のショート動画の作法。
// G-CAP-FIT-NOWRAP の (1)）。0.90 は、受入の上限 92% に対して測定のばらつきぶんを見た値。
const CAPTION_LINE_FILL_MAX = 0.9;

/**
 * 1行に収める幅の予算(px)を出す。canvas幅から左右の余白を引いた「可用幅」そのもの。
 *
 * 【2026-08-16 全面差し替え（G-CAP-FIT）】旧実装は「全角=2カラム／半角=1カラム」と数えたうえで
 * 1カラム = 0.65 × fontSize としていた。つまり全角1文字を 1.30 × fontSize と見積もっていたが、
 * 同梱フォントで実際に焼いて測った送り幅は 0.598〜1.000 × fontSize（書体による）で、
 * 既定書体では 0.690。**1.88倍ぶん多く見積もっていた**。その結果、横960pxに実際は16文字
 * 入るのに8文字で折り返し、字幕が画面の横幅を半分しか使わず、単語の途中で切れていた
 * （マスター指摘「字幕は縦動画にした時に酷すぎる」の主因。docs/failures.md 2026-08-16）。
 *
 * 新方式は「カラム数」を捨て、**書体ごとに実測した1文字あたりの送り幅(px)を積む**。
 * 実測値は FONT_CATALOG の wideRatio / narrowRatio（tests/caption-fit-check.mjs が
 * 同じ手順で測り直して照合するので、書体を差し替えれば必ず気付ける）。
 */
function lineBudgetPx(canvasW, marginLR) {
  const available = Number(canvasW) - marginLR * 2;
  return available > 0 ? available * CAPTION_LINE_FILL_MAX : Infinity;
}


// 同梱していない書体（システムのフォールバック等）で使う既定の比。
// 全角は 1.0（CJK の全角送りは em と同じ）。半角は 0.65 で、これは旧実装が
// 1カラム=0.65×fontSize としていた値と同じ＝未知の書体では従来どおりの安全側に倒す
// （DejaVu Sans Bold の大文字が実測 0.613 で、0.55 では足りずはみ出す。
//  tests/subtitle-canvas-fit-check.mjs がこの経路を押さえている）。
const FALLBACK_WIDE_RATIO = 1.0;
const FALLBACK_NARROW_RATIO = 0.65;

// 1枚の字幕に積む行数の上限（2026-08-16 / G-CAP-FIT）。実物のショート動画は
// 「短い行を2〜3行に積んだ塊」で出す（Opus Clip 公式サイトの実例8本で確認）。
// 1行しか出さないと、同じ文字サイズでも情報が細切れになり読みづらい。
export const CAPTION_MAX_LINES = 3;

/** 1文字の送り幅(px)。全角か半角かで実測比を使い分ける。 */
function charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio) {
  const wide = charDisplayWidth(ch) === 2;
  const ratio = wide ? (wideRatio ?? FALLBACK_WIDE_RATIO) : (narrowRatio ?? FALLBACK_NARROW_RATIO);
  return scaledFontSize * ratio;
}

/** 文字列の描画幅(px)の見積り。 */
function textWidthPx(text, scaledFontSize, wideRatio, narrowRatio) {
  return Array.from(text).reduce(
    (sum, ch) => sum + charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio),
    0,
  );
}

/** その文字の直前で行を折ってよいか（空白、または全角が絡む境目なら折れる）。 */
function canBreakBefore(cur, c) {
  if (c.ch === " ") return true;
  if (!cur.length) return false;
  const prev = cur[cur.length - 1].ch;
  return charDisplayWidth(c.ch) === 2 || charDisplayWidth(prev) === 2;
}

/**
 * 文字の並び（{ch, wordIndex}）を行へ割る。3つのことを同時にやる。
 *
 * 1. **語の途中で切らない**：半角の語（英単語・URL 等）は空白で折る。2026-08-16 の
 *    basis-reviewer 指摘。旧実装は文字単位で積むだけだったので 'everyone' が
 *    'everyon|e' に割れていた（マスターの最初の指摘「単語の途中で切れる」そのもの）。
 *    日本語は語の切れ目に空白が無いので、従来どおり文字単位で折る。
 * 2. **行数を先に決めて均す**：必要な行数 n = ceil(全体の幅 ÷ 予算) を先に求め、
 *    1行の目安を「全体の幅 ÷ n」にする。予算いっぱいまで貪欲に詰めると最後の行に
 *    端数だけが残る（実測: 82.7% / 82.8% / 20.0%）。
 * 3. **予算は絶対に超えない**：目安は均すための目標で、上限はあくまで予算。
 */
// 幅の足し算の丸め誤差で等分点をまたいだと誤判定しないための許容値(px)。
const EPS_PX = 1e-6;

// 1語だけで1行に入りきらないときに、折ってよい位置として扱う記号（URL 等）。
const BREAKABLE_MARKS = new Set(["/", "-", "_", ".", "?", "&", "=", ":", ","]);

function wrapChars(chars, budgetPx, advance) {
  if (!Number.isFinite(budgetPx) || chars.length === 0) return [chars];
  const widthOf = (ln) => ln.reduce((sum, c) => sum + advance(c.ch), 0);
  const total = widthOf(chars);
  // 必要な行数を先に決め、その等分点を境目の目安にする。1行ぶんの目安を毎行使い回すと、
  // 端数が積もって行数が1つ増えてしまうので、**累計**で比べる。
  const lineCount = Math.max(1, Math.ceil(total / budgetPx));
  const lines = [];
  let cur = [];
  let curPx = 0;
  let doneP = 0; // 確定した行の合計幅
  for (const c of chars) {
    const w = advance(c.ch);
    if (c.ch === " " && cur.length === 0) continue; // 行頭の空白は落とす
    if (curPx > 0 && curPx + w > budgetPx) {
      // 語の途中で予算を超えたら、直前の空白まで戻って折り直す。
      // 空白が無い＝その語だけで1行に入りきらない場合（URL・長い識別子）は、
      // **画面からはみ出さないことを優先して**折る（G-CAP-FIT-WRAP / -ROUTES は
      // 「はみ出さない」を無条件で要求する。1語を伸ばし続ける選択肢は無い）。
      // その場合も、区切り記号（/ - _ . ? & = :）の直後を優先して折り、
      // 英字の途中でぶつ切りにするのは記号が1つも無いときだけにする。
      let cut = -1;
      for (let i = cur.length - 1; i > 0; i--)
        if (cur[i].ch === " ") {
          cut = i;
          break;
        }
      if (cut < 0) {
        for (let i = cur.length - 1; i > 0; i--)
          if (BREAKABLE_MARKS.has(cur[i - 1].ch)) {
            cut = i; // 記号の直後で折る（記号は前の行の末尾に残す）
            break;
          }
        if (cut > 0) {
          const rest = cur.slice(cut);
          const head = cur.slice(0, cut);
          lines.push(head);
          doneP += widthOf(head);
          cur = rest;
          curPx = widthOf(rest);
          cur.push(c);
          curPx += w;
          continue;
        }
      }
      if (cut > 0) {
        const rest = cur.slice(cut + 1);
        const head = cur.slice(0, cut); // 行末の空白は落とす
        lines.push(head);
        doneP += widthOf(head);
        cur = rest;
        curPx = widthOf(rest);
      } else {
        lines.push(cur);
        doneP += curPx;
        cur = [];
        curPx = 0;
      }
    } else if (
      curPx > 0 &&
      // 決めた行数より多く折らない（最後の行は残り全部。等分点の丸め誤差で
      // 1行増えるのを防ぐ）
      lines.length + 1 < lineCount &&
      doneP + curPx + w > ((lines.length + 1) * total) / lineCount + EPS_PX &&
      canBreakBefore(cur, c)
    ) {
      // 目安を超える手前で「折ってよい位置」に来たら、そこで折る（超えてから折ると
      // 目安ぶんだけ最後の行が痩せる）。
      // 日本語はどこでも折れる。半角の語は空白でしか折らない（空白は区切りに使い切る）。
      lines.push(cur);
      doneP += curPx;
      cur = [];
      curPx = 0;
      if (c.ch === " ") continue;
    }
    cur.push(c);
    curPx += w;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** 語と語の間に空白が要るか（半角どうしなら要る。日本語は要らない）。 */
function needsSpace(prevText, nextText) {
  if (!prevText || !nextText) return false;
  const a = prevText[prevText.length - 1];
  const b = nextText[0];
  if (a === " " || b === " ") return false;
  return charDisplayWidth(a) === 1 && charDisplayWidth(b) === 1;
}

/**
 * 文字列を、1行の幅の予算(px)を超えないよう分割する（超えないならそのまま1要素の配列）。
 * グラフィム単位ではなくコードポイント単位（サロゲートペア対応）で切る。
 * 予算は「実際に描いたら何pxになるか」の見積りなので、収まるものは折り返さない。
 */
function splitByDisplayWidth(text, budgetPx, scaledFontSize, wideRatio, narrowRatio) {
  if (!Number.isFinite(budgetPx)) return [text];
  if (textWidthPx(text, scaledFontSize, wideRatio, narrowRatio) <= budgetPx) return [text];
  const advance = (ch) => charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio);
  const chars = Array.from(text).map((ch) => ({ ch, wordIndex: 0 }));
  const out = wrapChars(chars, budgetPx, advance).map((ln) => ln.map((c) => c.ch).join(""));
  return out.length ? out : [text];
}

/** スタイルに応じた ASS ヘッダ（[Script Info]+[V4+ Styles]+[Events] 見出し）を作る
 *  @param {number} captionMarginV Caption スタイルの MarginV（px・スケール適用済み） */
function buildHeader(W, H, font, st, align, scale, captionMarginV, scaledFontSize, scaledOutline) {
  // AUD-P2-22: Caption/Hook の絶対px値（フォントサイズ・縁取り・影・余白）を canvas に応じて
  // 比例縮小する。scale=1（canvasが基準どおり）のときは全て元の値のまま＝従来どおりの見た目。
  const captionMarginLR = scaleToken(60, scale);
  const hookFontSize = scaleToken(66, scale);
  const hookOutline = scaleToken(7, scale);
  const hookShadow = scaleToken(4, scale);
  const hookMarginLR = scaleToken(40, scale);
  const hookMarginV = scaleToken(150, scale);
  // 縁取り色: 既定は黒(&H00000000)。resolveCaptionStyle() で上乗せされていればそれを使う
  // （2026-08-14 追加。旧実装は縁取り色が常に固定で、Style行に書かず単に未指定=黒だった）。
  const outlineColor = st.outlineColor ?? "&H00000000";
  // 背景帯(box)は Style行(BorderStyle=3)では実装しない。この環境のffmpeg(6.1.1)同梱libassで
  // BorderStyle=3が塗りつぶされた矩形ではなく右下だけの細い縁(恐らくshadowの残骸)しか描かず、
  // 「背景帯」としての見た目を満たさないことが実装後の目視確認で判明した(2026-08-14。
  // docs/failures.md参照)。代わりに buildBackgroundBand() が ASS の描画コマンド(\p1)で
  // 直接矩形を描く(BorderStyle=1のまま・下のイベントで別Dialogueとして重ねる)。
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${scaledFontSize},${st.base},${outlineColor},&H00000000,1,1,${scaledOutline},${st.shadow > 0 ? scaleToken(st.shadow, scale) : 0},${align},${captionMarginLR},${captionMarginLR},${captionMarginV},1
Style: Hook,${font},${hookFontSize},&H0000FFFF,&H00111111,&H00000000,1,1,${hookOutline},${hookShadow},8,${hookMarginLR},${hookMarginLR},${hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/**
 * 背景帯(box)を、ASSの描画コマンド(\p1〜\p0のベクター描画)で塗りつぶした矩形として直接描く。
 * BorderStyle=3(不透明ボックス)には頼らない(buildHeader()のコメント参照。この環境では
 * 塗りつぶしにならなかったため)。矩形は字幕の安全エリア(左右余白=captionMarginLR)いっぱいの
 * 横幅・フォントサイズ基準の高さを持つ帯として、区間の全長(duration)ぶん1本だけ描く
 * (字幕は行ごとに複数のCaptionイベントに分かれるが、帯の位置はどれも同じなので1本で足りる)。
 * Layer -1(他のCaptionイベントより小さい)にして、文字より必ず背面に描かれるようにする。
 * @param {object} st resolveCaptionStyle() が返すスタイル
 * @param {number} W canvas幅
 * @param {number} H canvas高さ
 * @param {number} duration 区間長(秒)
 * @param {number} captionMarginLR Captionスタイルの左右余白(スケール後)
 * @param {number} scaledFontSize Captionスタイルのフォントサイズ(スケール後)
 * @param {number} captionMarginV Captionスタイルの MarginV(px・スケール適用済み)
 * @returns {string[]}
 */
function buildBackgroundBand(st, W, H, duration, captionMarginLR, scaledFontSize, captionMarginV) {
  if (!st.box?.enabled) return [];
  const bandHeight = Math.round(scaledFontSize * 1.3);
  const x1 = captionMarginLR;
  const w = Math.max(1, W - captionMarginLR * 2);
  // 帯の縦位置は文字と同じ下端基準(Alignment=2)で決める。画面中央基準(Alignment=5)の
  // 分岐は pop プリセット専用だったので、プリセットごと削除した（2026-08-17）。
  const y1 = Math.max(0, H - captionMarginV - bandHeight);
  const draw = `m 0 0 l ${w} 0 ${w} ${bandHeight} 0 ${bandHeight}`;
  return [
    `Dialogue: -1,${assTime(0)},${assTime(duration)},Caption,,0,0,0,,` +
      `{\\an7\\pos(${x1},${y1})\\bord0\\shad0\\1c${st.box.color}\\p1}${draw}{\\p0}`,
  ];
}

/**
 * 内側縁取り(二重縁取り)を、Captionスタイルの各Dialogue行を2枚重ねに複製することで実現する。
 * ASSの1つのStyleは縁取りを1色しか持てないため、以下の「重ね貼り」技法を使う:
 *   Layer 0（背面・外側）: 幅=st.outline(スケール後)・色=st.outlineColor で、文字色も
 *     outlineColorと同じ単色にして塗りつぶす（外側の縁だけが輪として見える下地）。
 *   Layer 1（前面・内側）: 幅=st.innerOutline.width(スケール後)・色=st.innerOutline.color で、
 *     文字色は元のまま。
 * ASSはLayer番号が大きいほど後から(上に)描画されるため、Layer1がLayer0の上に重なり、
 * 外側の縁の輪だけが内側の縁の外にリングとして残る。
 * @param {string[]} events "Dialogue: 0,...,Caption,,0,0,0,,text" 形式の行の配列(Hookを含む)
 * @param {object} st resolveCaptionStyle() が返すスタイル
 * @param {number} scale computeSubtitleScale() の結果
 * @returns {string[]}
 */
function applyInnerOutline(events, st, scale) {
  if (!st.innerOutline?.enabled) return events;
  const re = /^Dialogue: 0,([^,]+),([^,]+),Caption,,0,0,0,,(.*)$/;
  const outerW = scaleToken(st.outline, scale);
  const innerW = scaleToken(st.innerOutline.width, scale);
  const outerColor = st.outlineColor ?? "&H00000000";
  const innerColor = st.innerOutline.color;
  const out = [];
  for (const line of events) {
    const m = re.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, start, end, text] = m;
    const outerText = text.replace(/\{\\c[^}]*\}/g, "");
    out.push(
      `Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\bord${outerW}\\shad0\\3c${outerColor}\\1c${outerColor}}${outerText}`,
    );
    out.push(`Dialogue: 1,${start},${end},Caption,,0,0,0,,{\\bord${innerW}\\3c${innerColor}}${text}`);
  }
  return out;
}

/**
 * 行単位でまとめて表示する（唯一の描画方式）。
 *
 * 1枚の字幕（groupCaptions がまとめた語のかたまり）につき Dialogue は**1つだけ**。
 * 表示は先頭の語が始まる時刻から最後の語が終わる時刻まで続くので、読んでいる途中で
 * 文字が入れ替わらない。
 *
 * 【2026-08-17 の是正】旧 karaoke mode はここを語の数だけ刻んでいた（1語につき1イベント。
 * 実測: 60秒・150語のクリップで Caption イベント 150 個／文面は 18 種類）。文面はどの
 * イベントも同じ行全体で、語ごとに色を変える処理も 2026-08-16 に外れていたため、
 * 「同じ絵を 150 回描き直す」だけの状態だった。マスター指示「1語ずつポンポン出すな」に
 * 従い、語ごとに刻む経路そのものを削除した。
 */
function lineEvents(relWords, maxChars, budgetPx, fs, st, fits) {
  const measure = (t) => textWidthPx(t, fs, st.wideRatio, st.narrowRatio);
  const captions = groupCaptions(relWords, maxChars, fits, measure, budgetPx);
  return captions.map((c) => {
    const text = splitByDisplayWidth(c.text, budgetPx, fs, st.wideRatio, st.narrowRatio)
      .map(escAss)
      .join("\\N");
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${text}`;
  });
}

/**
 * 区間ぶんの ASS 字幕全文を生成。hook 文は画面上部に常時表示、本文字幕は選択スタイルで描画。
 * @param {{w:string,start:number,end:number}[]} relWords 区間先頭基準の相対 words
 * @param {string} hook 冒頭煽り文
 * @param {number} duration 区間長(秒)
 * @param {object} opts { style, width, height, fontMain, maxChars }
 */
export function buildAss(relWords, hook, duration, opts = {}) {
  const W = opts.width ?? 1080;
  const H = opts.height ?? 1920;
  const styleRef = opts.style ?? DEFAULT_SUBTITLE_STYLE;
  // スタイルを「キー名の文字列」で渡された場合も、必ず resolveCaptionStyle() を通す。
  //
  // 【2026-08-16 の欠陥と直し方】旧実装はここで getStyle() を呼び、素のプリセット
  // （fontSize 84 / outline 14 / shadow 8。書体ごとの実測比 wideRatio・emRatio・
  // outlineRatio を持たない）をそのまま使っていた。resolveCaptionStyle() が付ける
  // これらの比が無いと、下の scaledFontSize / scaledOutline が「従来どおり」の枝へ落ちるため、
  // G-CAP-FIT で直した字の大きさ・折り返し・縁取り・影が**まるごと元に戻る**。
  // 実際、caption-* フラグを1つも付けない CLI 実行（pipeline.mjs の
  // `style: resolvedCaptionStyle ?? subStyle`）と、画面の「字幕を直して焼き直す」
  // （recaption-stage.mjs、state に subStyle が無いので undefined）が、この枝を通っていた。
  // 直したのに直っていない経路が2つ残っていたので、入口を1つに寄せる。
  const st = typeof styleRef === "object" ? styleRef : resolveCaptionStyle(styleRef, {});
  // resolveCaptionStyle() 由来のスタイルは st.fontFamily を持つ（書体選択・G-EDIT-CAPTION-STYLE）。
  // 持たない場合(旧来のプリセットそのまま・テスト等)は opts.fontMain / DEFAULT_FONT にフォールバック。
  const fontMain = st.fontFamily ?? opts.fontMain ?? DEFAULT_FONT;
  // 字幕は常に画面下端基準(Alignment=2)。画面中央基準(Alignment=5)は 1語だけ中央に出す
  // pop プリセット専用だったが、そのプリセットごと削除した（2026-08-17）。Alignment=5 は
  // ASS の仕様上 MarginV を無視するため、残しておくと「位置を選べるのに効かない」状態を
  // 作ってしまう。古い state.json（align:5 や mode:"pop" を持つ）を焼き直すときも、
  // ここで下端基準に揃える。
  const align = 2;
  // 語のまとまり方は「実際に描いたときの幅」で決めるのが既定（下の fitsLine）。
  // maxChars は opts.maxChars を明示したときだけ効く（既存検査の互換のため残している）。
  const maxChars = opts.maxChars ?? 18;

  // AUD-P2-22: canvasに応じてstyleの絶対px値を比例縮小し、実際に収まる見た目カラム数を求める。
  const scale = computeSubtitleScale(W, H);
  // 文字の大きさは「画面の高さに対する割合」で決める（2026-08-16 / G-CAP-FIT-SIZE）。
  // Fontsize は「文字そのもの」ではなく「上下の余白を含めた高さ」に効き、その比は書体ごとに
  // 0.598〜1.000 と違う。固定の Fontsize を使うと書体を変えた瞬間に字の大きさが変わり、
  // 実際、直す前は Fontsize:84 でも漢字の高さが画面の 2.8% しかなかった。
  // 狙いの実 em（画面の高さの 5.2%）から Fontsize を逆算する。emRatio を持たないスタイル
  // （古い呼び出し）は従来どおり fontSize をそのまま使う。
  const scaledFontSize =
    st.emRatio && st.wideRatio
      ? Math.max(1, Math.round((H * st.emRatio) / st.wideRatio))
      : scaleToken(st.fontSize, scale);
  // 縁取りも実 em に対する比で決める（Fontsize 基準だと書体で太さが変わる）。
  const scaledOutline =
    st.emRatio && st.outlineRatio
      ? Math.max(1, Math.round(scaledFontSize * st.outlineRatio))
      : scaleToken(st.outline, scale);
  const captionMarginLR = scaleToken(60, scale);
  const budgetPx = lineBudgetPx(W, captionMarginLR);

  // 見出し(Hook)は本文(Caption)と別スタイル（フォントサイズ66・左右余白40）なので、
  // 折り返し幅も別に計算する。従来はここを一切折り返しておらず、区間の見出し文が
  // 画面の左右へ大きくはみ出したまま区間の全長にわたって表示され続けていた
  // （実素材で横幅40カラム・画面に入るのは32カラム。docs/failures.md 2026-08-14）。
  const hookFontSize = scaleToken(66, scale);
  const hookMarginLR = scaleToken(40, scale);
  const hookBudgetPx = lineBudgetPx(W, hookMarginLR);

  // Caption の MarginV(px)。位置を明示していれば「canvas高さに対する割合」から実pxを求め、
  // 未指定なら従来どおりプリセットの絶対px値を canvas 比で縮小する（＝挙動を変えない）。
  const captionMarginV =
    st.marginVRatio != null
      ? Math.max(0, Math.round(H * st.marginVRatio))
      : scaleToken(st.marginV, scale);

  const header = buildHeader(W, H, fontMain, st, align, scale, captionMarginV, scaledFontSize, scaledOutline);
  let events = [];
  events = events.concat(
    buildBackgroundBand(st, W, H, duration, captionMarginLR, scaledFontSize, captionMarginV),
  );
  if (hook) {
    const hookLines = splitByDisplayWidth(hook, hookBudgetPx, hookFontSize, st.wideRatio, st.narrowRatio)
      .map(escAss)
      .join("\\N");
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\an8}${hookLines}`);
  }
  // 行のまとめ方も「文字数」ではなく「実際に描いたときの幅」で決める（2026-08-16 / G-CAP-FIT）。
  // 幅の見積りだけ直しても、行を作る段が 14文字/18文字 で切っていては画面の横幅を使い切れない
  // （basis-reviewer 2巡目の指摘。全角なら 14文字=84%だが、半角中心の字幕は 14文字=38%しか
  //  使わない）。opts.maxChars が明示されたときだけ従来どおり文字数で切る（既存検査の互換）。
  // 1枚の字幕には「1行ぶん」ではなく「最大3行ぶん」の言葉を入れる。そのうえで
  // splitByDisplayWidth が1行の幅で折り返すので、結果として3行の塊になる。
  // 幅の合計で見ると、行末の余りぶんだけ実際の行数が増えて4行になることがある。
  // 実際に折り返してみて、行数が上限以内かで判定する。
  const fitsLine =
    opts.maxChars != null
      ? null
      : (text) =>
          splitByDisplayWidth(text, budgetPx, scaledFontSize, st.wideRatio, st.narrowRatio).length <=
          CAPTION_MAX_LINES;
  // 本文字幕は行単位で出す（唯一の描画方式）。スタイルによる分岐は無い＝どのスタイルを
  // 選んでも「1枚の字幕＝1イベント」で、語が1つずつ切り替わることはない（2026-08-17）。
  events = events.concat(lineEvents(relWords, maxChars, budgetPx, scaledFontSize, st, fitsLine));

  events = applyInnerOutline(events, st, scale);

  return `${header}\n${events.join("\n")}\n`;
}
