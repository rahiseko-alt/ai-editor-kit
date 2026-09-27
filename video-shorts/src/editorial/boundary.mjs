// video-shorts src/editorial/boundary.mjs — 区間の端を、実測した無音の内側へ寄せる。
// 2026-09-26 に src/edit-job.mjs から中身を変えずに移した（責務ごとにファイルを分けるため）。

/** マスター指示（2026-08-18）: 語尾の余韻として無音へ最大0.3秒だけ食い込ませる
 * （旧実装 trim-plan.mjs の AFTER_SPEECH_MARGIN_SEC を踏襲）。無音自体より長くは伸ばさない
 * （虎の巻 原則4: 元々そこにあった無音だけを使う。合成しない）。 */
export const AFTER_SPEECH_MARGIN_SEC = 0.3;

/**
 * ffmpeg silencedetect が語中の子音の破裂音などを誤検出することがある。
 *
 * 【2026-08-19 実測した3連鎖の事故】
 * (1) 「きれいに」の"き"と"れ"の間に 0.15 秒の無音を検出し、語の途中で切れた。
 * (2) (1) の対策として「0.2秒未満は無視」という長さの閾値を入れたところ、
 *     今度は「動画」という語の内部にある 0.308 秒の誤検出無音（閾値を通過してしまう）
 *     にスナップし、"今日は"ごと語の先頭が削れた。長さの閾値は対症療法で、
 *     閾値をどこに引いても新しい誤検出が閾値の内側に来れば同じ事故が形を変えて起きる。
 * (3) 根本原因を「無音が語の内部にあるか」に切り替え、word-level timestamp と
 *     突き合わせる判定に直したが、まだ (1) が再発した。原因は Groq の日本語
 *     word timestamp が文字単位に近い部分語で返ること（既知の仕様。「きれいに」が
 *     "き""れ""い""に"の4語に分かれている）。無音がその**2つの部分語の境界**に
 *     またがっていたため、「1語に完全内包」の判定をすり抜けた。
 * → 判定対象を部分語ではなく **BudouX の文節（groupIntoPhrases の結果）** にする。
 *   文節は「意味のある1つの単位」なので、その内部にまたがる無音は誤検出とみなせる。
 */
export function isInsideAnyWord(silence, phraseUnits) {
  const EPS = 0.005;
  return phraseUnits.some((u) => silence.start >= u.start - EPS && silence.end <= u.end + EPS);
}

/**
 * t に最も近い無音区間を探し、kind に応じて余韻/助走ぶんだけ寄せた時刻を返す。
 * 見つからなければ t をそのまま返す（切らない安全側）。
 * @param {"start"|"end"} kind "end"=区間の終わり(語尾。無音の頭から0.3秒残す)、
 *   "start"=区間の始まり(語頭。無音の尾から0.3秒遡って助走を付ける)
 * @param {{start:number,end:number,w:string}[]} phraseUnits 文節の内部の誤検出無音を除外するために使う
 */
export function snapToSilence(t, silences, kind, phraseUnits, maxDistance = 1.0, margin = AFTER_SPEECH_MARGIN_SEC) {
  let best = null;
  let bestDist = Infinity;
  for (const s of silences) {
    if (isInsideAnyWord(s, phraseUnits)) continue;
    const dist = t >= s.start && t <= s.end ? 0 : Math.min(Math.abs(t - s.start), Math.abs(t - s.end));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (!best || bestDist > maxDistance) return t;
  const edgeMargin = Math.min(0.05, (best.end - best.start) / 4);
  if (kind === "end") {
    return Math.min(best.start + margin, best.end - edgeMargin);
  }
  return Math.max(best.end - margin, best.start + edgeMargin);
}

// ---------- 4. 無音スナップ ----------
/**
 * 無音へ寄せる。ただし **採用範囲の外にある発話へは絶対に食い込ませない。**
 *
 * 【2026-08-19 実測した欠陥】snapToSilence は「最寄りの無音」へ寄せるだけで、その先に何が
 * あるかを見ていない（虎の巻 §8-E が警告している問題）。実際に次が起きた:
 *   - 区間の開始を 0.586 秒巻き戻し、**接続詞だから外すと決めた文節121「続いて」を戻した**
 *     → カット冒頭が接続詞で始まり、合格条件 項目4 に違反した。
 *   - 区間の終端を 1.019 秒はみ出させ、**捨てると決めた余談の頭（文節139「なんか」140「最近って」）
 *     を飲み込んだ** → 「なんか最近」という無意味な断片が繋ぎ目に残った。
 * どちらも「区間選定は正しいのに、後工程が黙って上書きする」という壊れ方で、選定側をいくら
 * 慎重にやっても防げない。よってスナップ側に歯止めを置く。
 *
 * 歯止め: 範囲の直前・直後にある文節（＝捨てると決めたもの）の境界を越えない。
 * 無音の中で寄せる自由は保ちつつ、隣の発話は絶対に含めない（虎の巻 原則1）。
 */
export function snapRanges(ranges, silences, phraseUnits, { joinMarginSec = AFTER_SPEECH_MARGIN_SEC } = {}) {
  const EPS = 0.01;
  return ranges.map((r, i) => {
    // 区間どうしの繋ぎ目の側だけ、元の無音を長めに残せるようにする（動画の頭と尻は今までどおり）。
    // 無音そのものより長くはならない（snapToSilence が無音の内側に収める＝虎の巻 原則4）。
    const startMargin = i > 0 ? joinMarginSec : AFTER_SPEECH_MARGIN_SEC;
    const endMargin = i < ranges.length - 1 ? joinMarginSec : AFTER_SPEECH_MARGIN_SEC;
    // 範囲の直前・直後にある発話（＝捨てると決めた文節）の境界。ここを越えてはいけない。
    let prevEnd = 0;
    let nextStart = Infinity;
    for (const u of phraseUnits) {
      if (u.end <= r.start + EPS) prevEnd = Math.max(prevEnd, u.end);
      if (u.start >= r.end - EPS) nextStart = Math.min(nextStart, u.start);
    }

    // 【2026-08-20 修正】以前は無音区間の両端が窓に完全内包されることを要求していたが、
    // 実測の無音は窓のすぐ外まで伸びていることがあり（例:助かりますよね→あ、の間の無音は
    // 193.134〜194.159秒で、nextStart=193.828をわずかに超える）、その場合に正しい無音が
    // 丸ごと除外され、snapToSilenceが単語の途中の別の無音へスナップする事故が実際に起きた
    // （文節「コズム」「助かりますよね」がそれぞれ音声から欠落した）。
    // 無音の「入り口側」が窓に触れてさえいれば候補にし、実際に使う値は下でクランプして
    // 隣の発話を絶対に越えないようにする（歯止めは維持したまま、除外条件だけ緩める）。
    const usable = silences.filter((s) => s.end >= prevEnd - EPS && s.start <= nextStart + EPS);

    // 使える無音が無い場合の既定値。**終端と開始で扱いを変える。**
    //
    // 終端は「間」の中央まで伸ばす。語尾の余韻になり、かつ次の語の立ち上がりからも
    // 等しく離れる（タイムスタンプは音響境界と 100〜400ms ずれる＝虎の巻 §3-2）。
    //
    // 開始は伸ばさない（文節の頭のまま）。当初こちらも中央へ寄せたが、実測すると
    // **前の発話の語尾を拾った**（区間の頭に「で、」という断片が残った）。捨てると決めた
    // 発話の尻尾を拾うのは、区間の頭に無意味な音を置くことになる。無音が無い＝2つの発話が
    // 実質つながっているので、そこに助走を取る余地は元から無い。
    const midStart = r.start;
    const midEnd = Number.isFinite(nextStart) ? r.end + (nextStart - r.end) / 2 : r.end;

    const rawSnappedStart = snapToSilence(r.start, usable, "start", phraseUnits, 1.0, startMargin);
    const rawSnappedEnd = snapToSilence(r.end, usable, "end", phraseUnits, 1.0, endMargin);
    // snapToSilence は候補が無いと引数をそのまま返す。その場合だけ中央へ寄せる。
    const foundStart = rawSnappedStart !== r.start;
    const foundEnd = rawSnappedEnd !== r.end;
    // usable をオーバーラップ基準に緩めたぶん、返り値側で「捨てると決めた発話は絶対に越えない」
    // という歯止めを掛け直す（虎の巻 原則1）。
    const start = foundStart ? Math.max(rawSnappedStart, prevEnd) : midStart;
    const end = foundEnd ? Math.min(rawSnappedEnd, nextStart) : midEnd;

    return end > start ? { start, end } : { start: r.start, end: r.end };
  });
}
