// video-shorts [5] 字幕スタイル登録 — 選択式プリセット + 自由カスタマイズ(G-EDIT-CAPTION-STYLE)。
// エフェクト(apply-effect.mjs)と同じ「プリセット選択」流儀。
// 将来の Web UI の「字幕スタイル」ドロップダウンも、この登録表をそのまま読む（単一正本）。
//
// 色は ASS 形式 &HAABBGGRR（例: 白=&H00FFFFFF / 黄=&H0000FFFF）。
// mode が描画方式を決める。現在の値は "line"（行単位でまとめて表示）だけである:
//   "line"    語のまとまり（1枚の字幕）ごとに1イベント。行はそのまま出続ける
//
// 2026-08-17 マスター指示「1語ずつポンポン出すな！と指示したぞ。なぜいう事を聞かない。
// こんな機能削除しろ」により、1語ずつ出す描画方式（"pop" プリセット＝1単語だけ画面中央に
// 大きく出しては消す／"karaoke" mode＝語ごとに Dialogue を出して現在語だけ色を変える）を
// 両方とも削除した。語が1つずつ切り替わる見え方を、選択肢としても実装としても残さない。
//
// 2026-08-14 追加: 書体(font)・文字色(fill)・外側縁取り色(outlineColor)・内側縁取り
// (innerOutline)・背景帯(box) を、上のプリセット(見た目の骨格=mode/fontSize/marginV等)とは
// 独立した「上乗せカスタマイズ」として resolveCaptionStyle() で合成できるようにする。
// フォント実体は system font に頼らず ./fonts/ 配下に同梱した ttf を fontsdir 経由で読む
// （2026-08-14 以前、Windows専用フォント名を指定していて存在しない環境で無言のまま
// 中国語フォントへ代替された事故の再発防止。詳細は docs/failures.md）。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 同梱フォントファイルを置くディレクトリ（ffmpeg drawtext/ass の fontsdir に渡す） */
export const FONTS_DIR = join(__dirname, "fonts");

/**
 * 選べる書体のカタログ（正）。key はヒアリング・CLI・state.json で使う識別子。
 * family は各 ttf の name table に実際に書き込まれているフォントファミリー名
 * （video-shorts/src/fonts/THIRD_PARTY.json の登録と対応）。
 */
export const FONT_CATALOG = {
  kaku: {
    key: "kaku",
    label: "角ゴシック",
    description: "太く力強い、Reels/TikTokで最も見慣れた定番書体",
    family: "Noto Sans JP Black",
    file: "NotoSansJP-Black.ttf",
    // 【実測値・2026-08-16】tests/caption-fit-check.mjs が同じ手順で測り直して照合する。
    // wideRatio/narrowRatio: 全角・半角1文字の送り幅 ÷ 文字サイズ。折り返しの見積りに使う。
    // outlineRatio: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い縁取り ÷ 文字サイズ。
    wideRatio: 0.69,
    narrowRatio: 0.473,
    outlineRatio: 0.09,
  },
  maru: {
    key: "maru",
    label: "丸ゴシック",
    description: "角の取れた柔らかい印象。Vlog・ライフスタイル系向け",
    family: "M PLUS Rounded 1c Black",
    file: "MPLUSRounded1c-Black.ttf",
    // 【実測値・2026-08-16】tests/caption-fit-check.mjs が同じ手順で測り直して照合する。
    // wideRatio/narrowRatio: 全角・半角1文字の送り幅 ÷ 文字サイズ。折り返しの見積りに使う。
    // outlineRatio: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い縁取り ÷ 文字サイズ。
    wideRatio: 0.72,
    narrowRatio: 0.479,
    outlineRatio: 0.09,
  },
  mincho: {
    key: "mincho",
    label: "明朝体",
    description: "縦線が太く横線が細い、上品・フォーマルな印象",
    family: "Noto Serif JP Black",
    file: "NotoSerifJP-Black.ttf",
    // 【実測値・2026-08-16】tests/caption-fit-check.mjs が同じ手順で測り直して照合する。
    // wideRatio/narrowRatio: 全角・半角1文字の送り幅 ÷ 文字サイズ。折り返しの見積りに使う。
    // outlineRatio: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い縁取り ÷ 文字サイズ。
    wideRatio: 0.693,
    narrowRatio: 0.521,
    outlineRatio: 0.09,
  },
  hand: {
    key: "hand",
    label: "手書き風",
    description: "親しみやすい手書き風。上流にBlackウェイトが無くRegular相当の太さ",
    family: "Kosugi Maru",
    file: "KosugiMaru-Regular.ttf",
    // 【実測値・2026-08-16】tests/caption-fit-check.mjs が同じ手順で測り直して照合する。
    // wideRatio/narrowRatio: 全角・半角1文字の送り幅 ÷ 文字サイズ。折り返しの見積りに使う。
    // outlineRatio: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い縁取り ÷ 文字サイズ。
    wideRatio: 1.0,
    narrowRatio: 0.5,
    outlineRatio: 0.06,
  },
  marker: {
    key: "marker",
    label: "マーカー風",
    description: "マーカーで書いたようなカジュアルな書体。上流にBlackウェイトが無くRegular相当の太さ",
    family: "Yusei Magic",
    file: "YuseiMagic-Regular.ttf",
    // 【実測値・2026-08-16】tests/caption-fit-check.mjs が同じ手順で測り直して照合する。
    // wideRatio/narrowRatio: 全角・半角1文字の送り幅 ÷ 文字サイズ。折り返しの見積りに使う。
    // outlineRatio: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い縁取り ÷ 文字サイズ。
    wideRatio: 0.598,
    narrowRatio: 0.417,
    outlineRatio: 0.09,
  },
};

export const DEFAULT_FONT_KEY = "kaku";

/**
 * 字幕の文字の大きさは「画面の高さに対する割合」で決める（2026-08-16 / G-CAP-FIT-SIZE）。
 *
 * 【なぜ指定値をそのまま使わないか】字幕エンジン(libass)の Fontsize は「文字そのものの大きさ」
 * ではなく「上下の余白を含めた高さ(ascent+descent)」に効く。同梱書体でこの比は 0.598〜1.000 と
 * バラバラなので、Fontsize を固定すると**書体を変えた瞬間に字の大きさが変わる**。
 * 実際、直す前は Fontsize:84 に対し漢字の高さが 54px（画面の2.8%）しかなかった。
 *
 * マスターが選んだ案C＝実際の文字の高さを画面の高さの 5.2% にする。
 * 実物のショート動画（Opus Clip 公式サイトの実例8本）と同じ「大きい字を短い行で積む」見た目。
 */
export const CAPTION_EM_RATIO = 0.052;

/** 画面の高さと書体から、その書体で狙いの大きさになる Fontsize を出す。 */
export function fontSizeForHeight(canvasH, font, emRatio = CAPTION_EM_RATIO) {
  const targetEm = canvasH * emRatio;
  const perUnit = font?.wideRatio || 1; // Fontsize 1 あたりの実 em（＝全角の送り幅の比）
  return Math.max(1, Math.round(targetEm / perUnit));
}

/** 書体キーの正引き。未知なら null（__proto__ 等の継承プロパティは自前キーとして扱わない） */
export function getFont(key) {
  return typeof key === "string" && Object.hasOwn(FONT_CATALOG, key) ? FONT_CATALOG[key] : null;
}

/** ヒアリング・CLIヘルプ用：選べる書体の一覧 */
export function listFonts() {
  return Object.values(FONT_CATALOG).map(({ key, label, description, family }) => ({
    key,
    label,
    description,
    family,
  }));
}

/** 書体キーに対応する同梱ttfの絶対パス。未知キーなら null */
export function fontFilePath(key) {
  const font = getFont(key);
  return font ? join(FONTS_DIR, font.file) : null;
}

export const SUBTITLE_STYLES = {
  karaoke: {
    label: "標準",
    description: "白1色。行は出っぱなしで、話の進みに合わせて切り替わる",
    // 2026-08-17: 旧 mode "karaoke"（語ごとに Dialogue を出す）を廃止し "line" に統一した。
    // 語ごとの色替えは 2026-08-16 の指示で既に無くなっており、出していた Dialogue は
    // どれも同じ行の文面（実測: 150語で 150 イベント・文面は 18 種類）だったため、
    // 見た目を変えずに「1枚の字幕＝1イベント」へ畳める。
    mode: "line",
    fontSize: 84,
    base: "&H00FFFFFF", // 白
    // outline はここでは決めない。resolveCaptionStyle() が「書体ごとに実測した比 ×
    // fontSize」で上書きする（2026-08-16 / G-CAP-FIT-OUTLINE）。2026-08-14 に太くした
    // 値(14=16.7%)は、隣の文字の黒とくっついて字が黒い塊に埋もれる太さだった。
    outline: 14,
    outlineColor: "&H00000000", // 既定=黒。背景の対照を得るための既定値（カスタマイズ可）
    shadow: 8,
    // 2026-08-16 マスターが選んだ案C の位置。文字が大きくなり3行に積むようになったぶん、
    // 下からの余白を 360→420 へ上げる（下端に寄りすぎないようにする）。
    marginV: 420, // 画面下からの余白（固定値。区間の行数が変わってもこの値は動かない）
  },
  bold: {
    label: "太字ライン",
    description: "行単位の白・太字・黒縁（最小変更・安定）",
    mode: "line",
    fontSize: 88,
    base: "&H00FFFFFF",
    outline: 13,
    outlineColor: "&H00000000",
    shadow: 7,
    marginV: 400,
  },
};

export const DEFAULT_SUBTITLE_STYLE = "karaoke";

/**
 * 字幕スタイルの設計基準解像度（AUD-P2-22）。
 * 上の SUBTITLE_STYLES の fontSize/outline/shadow/marginV（絶対px値）は、この解像度で
 * 見て自然な大きさになるよう決めてある。実際の出力canvasがこれより小さい場合
 * （render-vertical.mjs の拡大ガードで縮小された場合等）、そのままの絶対値を焼くと
 * 相対的に大きすぎて長い単語が画面の左右端からはみ出す。computeSubtitleScale/scaleToken で
 * 実canvas寸法に比例縮小してから使う。
 */
export const REFERENCE_CANVAS = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

/**
 * 実際の出力canvas寸法に対する、字幕トークンの縮小率を求める。
 *
 * canvas が基準どおり（拡大ガードが効いていない通常サイズ＝1080x1920 or 1920x1080）なら
 * scale=1（無変化・従来どおりの見た目を維持）。canvas がそれより小さい場合だけ、
 * その比率ぶん縮小する。向きは canvas の縦横比から判定する（h>=w なら縦=portrait基準、
 * それ以外は横=landscape基準）。幅・高さ両方の比の小さいほう（min）を取るのは、
 * どちらの軸で見てもトークンが canvas をはみ出さないようにするため。
 */
export function computeSubtitleScale(canvasW, canvasH) {
  if (!(canvasW > 0) || !(canvasH > 0)) return 1;
  const ref = canvasH >= canvasW ? REFERENCE_CANVAS.portrait : REFERENCE_CANVAS.landscape;
  const scale = Math.min(canvasW / ref.width, canvasH / ref.height);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** 数値トークン(px)を scale 倍し、整数へ丸める。0 にはしない（完全に消えるのを防ぐ）。 */
export function scaleToken(n, scale) {
  return Math.max(1, Math.round(n * scale));
}

/**
 * スタイル名の正引き。未知なら null（呼出側で利用可能一覧を提示してエラーにする）。
 * getFont() と同じく Object.hasOwn で確認する（2026-08-15 修正）。修正前は `SUBTITLE_STYLES[name]`
 * という素朴なプロパティアクセスだったため、name="__proto__" のとき継承された Object.prototype
 * が返り（truthy）、未知スタイルとして弾かれずに通過していた。resolveCaptionStyle() はこれを
 * ベーススタイルとして `{ ...base, ... }` へ展開するため、Object.prototype の列挙可能な
 * 自前プロパティは無く空オブジェクトへ潰れ、mode/fontSize等が全て undefined のまま描画され
 * 壊れる（G-EDIT-UI-SETTINGS-VALIDATE：意地悪な値でジョブを失敗させない、を満たせなくなる）。
 */
export function getStyle(name) {
  return typeof name === "string" && Object.hasOwn(SUBTITLE_STYLES, name) ? SUBTITLE_STYLES[name] : null;
}

/** Web UI / CLI ヘルプ用：選択肢の一覧（key・label・description） */
export function listStyles() {
  return Object.entries(SUBTITLE_STYLES).map(([key, v]) => ({
    key,
    label: v.label,
    description: v.description,
  }));
}

// ── 自由カスタマイズ(G-EDIT-CAPTION-STYLE): 文字色・縁取り色・内側縁取り・背景帯 ──────

/** 背景帯(box)の既定値。off のときは従来どおり(BorderStyle=1・背景なし)。 */
export const DEFAULT_BOX = { enabled: false, color: "&H80000000" };

/** 内側縁取り(二重縁取り)の既定値。off のときは従来どおり(単一の縁取りのみ)。 */
export const DEFAULT_INNER_OUTLINE = { enabled: false, color: "&H0000FFFF", width: 4 };

/**
 * 字幕の縦位置(G-UI-CAPPOS)として受け付ける範囲。単位は「画面の高さに対する％」で、
 * 0＝画面の一番下、90＝画面のほぼ上。上限を100にしないのは、100だと文字の下端が画面の
 * 上端と一致して文字全体が画面外へ出るため（選べるのに何も映らない位置を作らない）。
 */
export const CAPTION_POS_MIN = 0;
export const CAPTION_POS_MAX = 90;

/**
 * "#RRGGBB" または "#RRGGBBAA" 形式の色を ASS の &HAABBGGRR 形式へ変換する。
 * ASSのAAは「不透明度の逆」（00=不透明・FF=透明）なので、入力のAA(通常表記=不透明度)は反転する。
 * 不正な形式なら null（呼出側はfail-fastでエラーにする。既定色へ黙って落とさない）。
 * @param {string} hex
 * @returns {string | null}
 */
export function hexToAss(hex) {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) return null;
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  const alphaIn = m[2] ? parseInt(m[2], 16) : 255; // 省略時は不透明(255)
  const assAlpha = (255 - alphaIn).toString(16).padStart(2, "0");
  return `&H${assAlpha}${bb}${gg}${rr}`.toUpperCase();
}

/**
 * ベースのプリセット(karaoke/bold＝mode・fontSize・marginV等の骨格)に、
 * 書体・文字色・縁取り色・内側縁取り・背景帯の「上乗せカスタマイズ」を合成する。
 * overrides の各キーは省略可（省略した項目はプリセットの既定のまま）。
 * @param {string} styleKey SUBTITLE_STYLES のキー
 * @param {{fontKey?: string, fillHex?: string, outlineColorHex?: string,
 *          innerOutline?: {enabled: boolean, colorHex?: string, width?: number},
 *          box?: {enabled: boolean, colorHex?: string}}} overrides
 */
export function resolveCaptionStyle(styleKey, overrides = {}) {
  const base = getStyle(styleKey) || getStyle(DEFAULT_SUBTITLE_STYLE);
  const fontKey = overrides.fontKey ?? DEFAULT_FONT_KEY;
  const font = getFont(fontKey);
  if (!font) {
    throw new Error(
      `字幕の書体キー「${fontKey}」は存在しません。選べる書体: ${Object.keys(FONT_CATALOG).join(", ")}`,
    );
  }

  const style = { ...base, fontKey, fontFamily: font.family };

  // 2026-08-16 マスター指摘「字幕は縦動画にした時に酷すぎる」への対応（G-CAP-FIT）。
  // 折り返しと縁取りは書体ごとに実測した比で決める。プリセット側に固定 px で持たせると、
  // 書体を変えたときに必ずどちらかがずれる（幅の広い書体では早すぎる折り返し、
  // 細い書体では太すぎる縁取り）。
  style.wideRatio = font.wideRatio;
  style.narrowRatio = font.narrowRatio;
  style.emRatio = CAPTION_EM_RATIO;
  // 縁取り: 「文字の帯の中に地が20%以上残る」を満たす範囲で最も太い比（書体ごとに実測）。
  style.outlineRatio = font.outlineRatio;
  style.outline = Math.max(1, Math.round(base.fontSize * font.outlineRatio));
  // 影は重ねない（2026-08-16 / G-CAP-FIT-NOSHADOW）。縁取りと影が二重にかかると
  // 黒が右下にだけ伸びて輪郭が非対称ににじみ、文字が黒い塊に沈む。実物のショート動画は
  // 縁取りのみで影を重ねていない。
  style.shadow = 0;

  if (overrides.fillHex !== undefined) {
    const ass = hexToAss(overrides.fillHex);
    if (!ass) throw new Error(`文字色の指定「${overrides.fillHex}」が不正です(#RRGGBB形式で指定)。`);
    style.base = ass;
  }
  if (overrides.outlineColorHex !== undefined) {
    const ass = hexToAss(overrides.outlineColorHex);
    if (!ass) throw new Error(`縁取り色の指定「${overrides.outlineColorHex}」が不正です(#RRGGBB形式で指定)。`);
    style.outlineColor = ass;
  }

  style.box = { ...DEFAULT_BOX };
  if (overrides.box?.enabled) {
    const colorHex = overrides.box.colorHex ?? "#00000080";
    const ass = hexToAss(colorHex);
    if (!ass) throw new Error(`背景帯の色指定「${colorHex}」が不正です(#RRGGBB(AA)形式で指定)。`);
    style.box = { enabled: true, color: ass };
  }

  style.innerOutline = { ...DEFAULT_INNER_OUTLINE };
  if (overrides.innerOutline?.enabled) {
    const colorHex = overrides.innerOutline.colorHex ?? "#FFFF00";
    const ass = hexToAss(colorHex);
    if (!ass) throw new Error(`内側縁取りの色指定「${colorHex}」が不正です(#RRGGBB形式で指定)。`);
    style.innerOutline = {
      enabled: true,
      color: ass,
      width: overrides.innerOutline.width ?? DEFAULT_INNER_OUTLINE.width,
    };
  }

  // 字幕の縦位置（G-UI-CAPPOS。画面プレビュー上でつまみを動かして決める）。
  // 絶対px(marginV)ではなく「canvas高さに対する割合」で持つ。縦(1080x1920)と横(1920x1080)で
  // 基準になる高さが違うため、％を絶対pxへ畳むのはここではできない。実pxへの換算は出力canvas
  // の高さを知っている srt-builder.buildAss() が行う。
  if (overrides.posPercent !== undefined) {
    const p = Number(overrides.posPercent);
    if (!Number.isFinite(p) || p < CAPTION_POS_MIN || p > CAPTION_POS_MAX) {
      throw new Error(
        `字幕の位置の指定「${overrides.posPercent}」が不正です(${CAPTION_POS_MIN}〜${CAPTION_POS_MAX}の数値で指定)。`,
      );
    }
    style.marginVRatio = p / 100;
  }

  return style;
}
