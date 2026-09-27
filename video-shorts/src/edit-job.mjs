// video-shorts [固定手順] .runtime/chat-inbox.jsonl（ジョブ台帳。`new` が追記する）の1ジョブを、実際に編集して
// .runtime/outputs/<jobId>/result.mp4 へ書き出し、.runtime/results.jsonl へ完了を記録する。
//
// 【2026-08-19 マスター指示】「UIに素材を投げる→文字起こしする→お前が内容を決める→
// FFmpegで書き出し」にしろ。以前は区間選定を別プロセスの claude -p（毎回まっさらな
// 使い捨てのOpus5呼び出し。この対話の文脈も虎の巻も合格条件も持たない）に丸投げしており、
// それが「その名も、コズム」が「も、コズム」になるような、意味の通らない断片を生む
// 直接原因だった（docs/failures.md 参照）。「内容を決める」のは、この対話をしている
// セッション自身にする。そのため工程を分けた:
//
//   node src/edit-job.mjs prepare <jobId>
//     文字起こし→無音実測→文節化（BudouX）までを自動実行する。
//     チャットで動画を受け取ったら `new <動画パス>` が登録してから呼ぶ（2026-09-27 に UI・ワーカーを廃止）。
//     結果は work/<jobId>/units.json（番号付き文節一覧）・silences.json に残る。
//     ★ここで自動処理は止まる。区間選定はしない。★
//
//   （このセッションが units.json を全文読み、work/<jobId>/editorial_plan.json を直接書く。
//     形は src/editorial/plan-schema.mjs。旧形式の keep.json も受け付ける）
//
//   node src/edit-job.mjs plan <jobId>
//     編集案を検査し、採用する文節の本文を動画の順番どおりに並べた台本案を表示する。
//   node src/edit-job.mjs approve <jobId>
//     台本案をマスターに見せて承認をもらったら、その承認を記録する。
//
//   node src/edit-job.mjs render <jobId>
//     承認済みの編集案を EDL（edl.json）に直し（無音スナップ・言い淀み除去）、
//     切り出し・縦型変換・字幕・出力までを実行する。承認後に編集案が変わっていたら止まる。
//
// 手順（render 側。固定・この順で必ず実行する）:
//   1. 無音スナップ（実測した無音の内側へ寄せる）
//   2. 言い淀みを切る（母音性フィラーのみ。消せないものは消さない）
//   3. 切り出し・結合（短いクロスフェード付き）
//   4. 縦型変換（settings.aspect==="portrait" のときのみ。letterbox 方式）
//   5. 字幕（caption:true のときのみ。白文字＋黒縁だけで焼く＝黒帯は敷かない。
//      BudouX の文節を最小単位に詰めるので語の途中で折れない。接続助詞で終わるカードは次へ送る。
//      文字サイズ・縁の太さ・余白はすべて実際の映像サイズから算出する）
//   → 出力・完了記録

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomically } from "./atomic-json.mjs";
import { wordsInRange, assTime } from "./srt-builder.mjs";
import { FONT_CATALOG, fontSizeForHeight } from "./subtitle-styles.mjs";
import { approvalProblem, writeApproval } from "./editorial/approval.mjs";
import { loadPlan, renderScript, validatePlan } from "./editorial/plan-schema.mjs";
import { resolveEdl } from "./editorial/resolve-edl.mjs";
import { chooseSilenceThresholdDb } from "./editorial/silence-threshold.mjs";
import { alignToFrames, probeFps, renderFinal } from "./render/render-edl.mjs";
import { groupIntoPhrases } from "./script/phrases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VIDEO_SHORTS_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, ".runtime");
const CHAT_INBOX = path.join(RUNTIME_DIR, "chat-inbox.jsonl");
const RESULTS_JSONL = path.join(RUNTIME_DIR, "results.jsonl");

function usage() {
  console.error("使い方: node src/edit-job.mjs doctor         （必要な物がそろっているか確かめる）");
  console.error("       node src/edit-job.mjs new <動画のパス> [--portrait] [--caption] [--instruction <指示>]");
  console.error("                                               （ジョブを登録して prepare まで実行。既定は横型・字幕なし）");
  console.error("       node src/edit-job.mjs prepare <jobId>  （文字起こし〜文節化）");
  console.error("       node src/edit-job.mjs plan <jobId>     （編集案を検査し、台本案を表示）");
  console.error("       node src/edit-job.mjs approve <jobId>  （マスターの承認を記録）");
  console.error("       node src/edit-job.mjs render <jobId>   （承認済みの編集案を書き出し）");
  console.error("         切り分け用: --no-snap（無音スナップしない） --no-filler（言い淀みを切らない） --no-caption（字幕を焼かない）");
  console.error("                     --out <名前>（outputs/<jobId>/<名前>.mp4 へ書き、完了記録は書かない）");
  process.exit(1);
}

// マスター指示(2026-08-18)「中止機能が欲しい」: サーバー(server/job-cancel.mjs)が
// work/<jobId>/.cancel を置くと、次の工程の合間でここに引っかかって打ち切る。
// 実行中の1コマンド（ffmpeg・claude -p 等）の途中では止めない（工程の切れ目という
// 安全な粒度でしか打ち切らない）。
class CancelledError extends Error {}

// 編集案の不備・未承認で render を始められないとき。ジョブの失敗ではなく、このセッションが
// 直せば進められる状態なので、results.jsonl には書かない（書くと UI とジョブの見張りが「失敗」と表示する）。
class NotReadyError extends Error {}

function checkCancelled(workDir) {
  if (fs.existsSync(path.join(workDir, ".cancel"))) {
    throw new CancelledError("中止されました");
  }
}

/**
 * 中止の旗を下ろす。
 *
 * 【2026-08-19 実際に踏んだ罠】`.cancel` を作るコード（server/job-cancel.mjs）はあるのに、
 * **消すコードがリポジトリのどこにも無かった。** そのため一度中止したジョブは二度と render
 * できず、prepare 済みで文字起こしも終わっているジョブが永久に死ぬ（実際に 62bce4ac… が
 * この状態になった）。
 *
 * 規則:
 *   - **中止として記録した時点で下ろす**（旗の役目はそこで終わる）。これで「記録は cancelled なのに
 *     旗が残っていて二度と render できない」状態が消える。
 *   - **`render` の開始時は下ろす。ただし黙って下ろさず、下ろしたことを必ず表示する。**
 *     render はセッションが明示的に叩くコマンドなので、過去の中止指示より新しい意思である。
 *     ただし「中止を押した直後に render が走って、中止が無言で消える」ことは避けたいので、
 *     消したという事実を画面に出す。
 *   - **`prepare` の開始時は下ろさない。** 当初は下ろしていたが、それが穴だった（敵対検証で発見）:
 *     ワーカーは直列に処理するので、投入したジョブは前のジョブが終わるまでキューで待つ。
 *     待っている間にマスターが中止を押しても、prepare 開始時に旗を下ろしてしまうと
 *     **中止が黙って無効化され、そのジョブは最後まで走ってしまう。** キュー待ち中の中止を
 *     尊重するため、prepare は旗を見つけたら（既存の checkCancelled で）そのまま打ち切る。
 */
function clearCancel(workDir) {
  try {
    fs.unlinkSync(path.join(workDir, ".cancel"));
    return true;
  } catch (_err) {
    return false; // 無ければ何もしない（存在しないのが通常）
  }
}

/**
 * doctor: 動かすのに必要な物がそろっているかを確かめ、足りない物と入れ方を表示する。
 * 他の人の PC で最初に動かすときに使う。戻り値は終了コード（0=すべてそろっている）。
 */
function runDoctor() {
  const lines = [];
  let ok = true;
  const check = (name, pass, fix) => {
    lines.push(`${pass ? "OK" : "NG"}  ${name}${pass ? "" : `\n    → ${fix}`}`);
    if (!pass) ok = false;
  };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  check(`Node.js ${process.versions.node}`, nodeMajor >= 20, "Node.js 20 以上を https://nodejs.org から入れてください");
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" });
  check("ffmpeg", ff.status === 0, "ffmpeg を入れて PATH を通してください（Windows: winget install Gyan.FFmpeg）");
  const fp = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" });
  check("ffprobe", fp.status === 0, "ffmpeg と一緒に入ります（上と同じ）");
  let py = null;
  try {
    py = resolvePython();
  } catch {
    /* 下で NG にする */
  }
  check(`Python${py ? `（${py}）` : ""}`, !!py, "Python 3.10 以上を https://www.python.org から入れてください");
  if (py) {
    const mods = spawnSync(py, ["-c", "import importlib.util as u;print(bool(u.find_spec('groq')), bool(u.find_spec('faster_whisper')))"], { encoding: "utf-8" });
    const [hasGroq, hasWhisper] = (mods.stdout ?? "").trim().split(/\s+/).map((s) => s === "True");
    const envFile = path.join(VIDEO_SHORTS_DIR, ".env");
    const hasKey = !!process.env.GROQ_API_KEY || (fs.existsSync(envFile) && /^\s*GROQ_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(envFile, "utf-8")));
    const groqReady = hasGroq && hasKey;
    check(
      `文字起こし（Groq: ${groqReady ? "使える" : "使えない"} / ローカル: ${hasWhisper ? "使える" : "使えない"}）`,
      groqReady || hasWhisper,
      `次のどちらかを用意してください:\n      (速い) pip install groq を実行し、video-shorts/.env に GROQ_API_KEY=... を書く（キーは https://console.groq.com で無料発行）\n      (キー不要・遅い) ${py} -m pip install -r video-shorts/requirements.txt`
    );
  }
  console.log(lines.join("\n"));
  console.log(ok ? "\nすべてそろっています。" : "\n足りない物があります。上の → の手順で入れてから、もう一度 doctor を実行してください。");
  return ok ? 0 : 1;
}

function readInboxJob(jobId) {
  const text = fs.readFileSync(CHAT_INBOX, "utf-8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj && obj.id === jobId) return obj;
  }
  throw new Error(`chat-inbox.jsonl に jobId=${jobId} が見つかりません`);
}

function appendResult(record) {
  fs.appendFileSync(RESULTS_JSONL, JSON.stringify(record) + "\n", "utf-8");
}

/** python3 が Windows Store のスタブを指す環境があるため、実体の python を優先的に探す。 */
function resolvePython() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const programsDir = path.join(localAppData, "Programs", "Python");
    if (fs.existsSync(programsDir)) {
      for (const entry of fs.readdirSync(programsDir)) {
        const exe = path.join(programsDir, entry, "python.exe");
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    }
  }
  candidates.push("python3", "python");
  for (const cand of candidates) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf-8" });
    if (r.status === 0 && !/WindowsApps/i.test(cand)) return cand;
  }
  throw new Error("実行可能な python が見つかりません");
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (r.status !== 0) {
    throw new Error(`コマンド失敗: ${cmd} ${args.join(" ")}\n${r.stderr ?? r.stdout ?? ""}`);
  }
  return r.stdout ?? "";
}

// ---------- 1. 文字起こし ----------
function transcribe(videoPath, workDir) {
  const py = resolvePython();
  const out = path.join(workDir, "transcript.json");
  console.log("[1/8] 文字起こし中（Groqがあれば自動使用）…");
  runSync(py, [path.join(VIDEO_SHORTS_DIR, "src", "transcribe.py"), videoPath, out, "--lang", "ja", "--backend", "auto"], {
    cwd: VIDEO_SHORTS_DIR,
  });
  return JSON.parse(fs.readFileSync(out, "utf-8"));
}

// ---------- 2. 無音実測 ----------
/** 50ms 窓ごとのピーク値（dB）を測る。閾値を素材の環境音から決めるため（silence-threshold.mjs）。 */
function measurePeaksDb(videoPath) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-i", videoPath, "-vn", "-af",
      "aresample=16000,asetnsamples=n=800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-",
      "-f", "null", "-",
    ],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
  );
  const peaks = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = line.match(/Peak_level=(-?inf|-?[\d.]+)/);
    if (m) peaks.push(m[1].endsWith("inf") ? -Infinity : Number(m[1]));
  }
  return peaks;
}

export function detectSilences(videoPath) {
  console.log("[3/8] 無音区間を実測中…");
  const noiseDb = chooseSilenceThresholdDb(measurePeaksDb(videoPath));
  console.log(`  無音とみなす音量: ${noiseDb}dB 以下（素材の環境音から決定）`);
  const r = spawnSync("ffmpeg", ["-i", videoPath, "-af", `silencedetect=noise=${noiseDb}dB:d=0.15`, "-f", "null", "-"], {
    encoding: "utf-8",
  });
  const text = r.stderr ?? "";
  const silences = [];
  let pendingStart = null;
  for (const line of text.split("\n")) {
    const sm = line.match(/silence_start:\s*([\d.]+)/);
    if (sm) pendingStart = Number(sm[1]);
    const em = line.match(/silence_end:\s*([\d.]+)/);
    if (em && pendingStart != null) {
      silences.push({ start: pendingStart, end: Number(em[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

// ---------- 5〜8. 切り出し・結合・縦型変換・字幕焼き込み ----------
/** 映像の実寸(幅・高さ)を取得する。字幕の PlayResX/Y・帯の座標を実寸に追従させるために使う。
 * 縦型出力時は renderFinal 内で固定で 1080x1920 にするため、このprobeは横型のときだけ使う。 */
function probeDimensions(videoPath) {
  const out = runSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    videoPath,
  ]).trim();
  const [width, height] = out.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`映像の実寸を取得できませんでした: ${out}`);
  }
  return { width, height };
}

// ---------- 7. 字幕 ----------
//
// 2026-08-18 マスター指示「字幕は調べろ。2行で収まるにはどうするか？をGithubから。サブ使え」
// を受けて、自己流の場当たり的な修正（文字数で割る→単語途中分断／無音でのみ区切る→はみ出し／
// \N追加→カード重複、の3連続事故）をやめ、GitHub上の実績あるショート動画自動字幕ツール
// unconv/captacity（word-timestamp から TikTok/Shorts 風の字幕を焼く定番OSS）の設計を読み、
// 考え方だけを移植した（パッケージとしては導入していない。requirements: 新規npm依存なし）。
//
// captacity の要点（captacity/text_drawer.py の calculate_lines()/fits_frame()、
// captacity/segment_parser.py の parse()）:
//   - 「カード（表示単位）をどこで区切るか」と「1カード内でどう行分割するか」を、
//     同じ1つの判定関数（fits_frame = 実測幅で行数を数える）で統一する。
//     行分割用の関数を先に作り、カード分割はその行分割関数を使い回して
//     「次の語を足しても行数の上限に収まるか」だけを条件に貪欲に語を積む
//     （segment_parser.parse: fit_function が false を返すまで words を1つずつ足す）。
//   - 語は空白区切りの1トークンとして扱い、行分割は語の"境界"でしか折らない
//     （calculate_lines: `line += word + " "` → 測って超えたら直前の行を確定。
//     1語だけで幅を超える場合だけ、割らずにそのまま1行に置く＝はみ出しより分断しないことを優先）。
//   - 無音ギャップや句読点には一切依存しない。行数の上限（＝幅）だけが唯一の必須条件なので、
//     Groq のように単語間ギャップがほとんど取れないバックエンドでも、カードは必ず上限行数で
//     区切られる（今回の事故4の直接の原因＝ギャップ依存を解消する）。
//
// このプロジェクトの制約に合わせて追加した点（captacityそのままではない部分）:
//   - 幅の見積りは自作（video-shorts/src/subtitle-styles.mjs の FONT_CATALOG.kaku の実測比
//     wideRatio/narrowRatio。buildAssFile が実際に焼く書体 "Noto Sans JP Black" と一致させる）。
//     captacity は Pillow で実レンダリングして測るが、こちらは他の字幕コード（srt-builder.mjs）
//     と同じ「実測比を文字数に掛ける」方式に合わせた（依存追加なし・既存資産と一貫させるため）。
//   - 句点(。！？」)・実測ギャップ（無音）は、行数の上限を破らない範囲でだけ使う「早期区切りの
//     ヒント」として残した（カードが行数いっぱいまで毎回詰め込まれ、文の切れ目を無視して
//     次の文と同じカードに同居するのを防ぐ。ただしカードが十分埋まっているときだけ効かせ、
///    極端に短いカードが乱発しないようにする）。この早期区切りは常に「必須条件（行数の上限）」
//     より弱いので、外れても2行以内という保証そのものは揺らがない。

const CAPTION_FONT = FONT_CATALOG.kaku; // buildAssFile が実際に焼く書体(Noto Sans JP Black)と一致させる
const CAPTION_MAX_LINES = 2; // マスター指示「2行で収まるには」
// 左右の余白（画面幅に対する割合）。以前は 60px 固定だったが、それは縦型(幅1080)を前提にした値で、
// 横型(幅1920)では端に寄りすぎていた。フォントサイズと同じく解像度に追従させる。
const CAPTION_MARGIN_LR_RATIO = 60 / 1080;
// 字幕を画面下からどれだけ浮かせるか（映像高に対する割合）。
const CAPTION_MARGIN_V_RATIO = 95 / 1080;
// 1行に使ってよい幅の上限（可用幅に対する割合）。1.0いっぱいまで詰めると測定誤差で
// 画面端に接するので、srt-builder.mjs の CAPTION_LINE_FILL_MAX と同じ 0.9 を使う。
const LINE_FILL_MAX = 0.9;

/**
 * その映像に焼く字幕の寸法を、映像の実寸から1箇所で決める。
 *
 * 【2026-08-19】以前は Fontsize を 64 に固定していた。libass の Fontsize は「文字そのものの
 * 大きさ」ではなく上下の余白を含む高さに効くので、64 は実際の字の高さにすると
 * 64 × 0.69 = 44px ＝ 1920px 高に対して 2.3% しかなく、マスターが選んだ 5.2%（案C・
 * subtitle-styles.mjs の CAPTION_EM_RATIO）の半分以下だった。しかも解像度に追従しない。
 * `fontSizeForHeight()` は subtitle-styles.mjs に既にあったのに、どこからも呼ばれていなかった。
 * 縁取りも 4 固定だったが、書体ごとの実測値 outlineRatio から出す（黒帯を外したので、
 * 背景から字を切り離すのは縁取りだけが担う）。
 */
function captionMetrics(dims) {
  const fontSize = fontSizeForHeight(dims.height, CAPTION_FONT);
  const marginLR = Math.round(dims.width * CAPTION_MARGIN_LR_RATIO);
  const available = dims.width - marginLR * 2;
  return {
    fontSize,
    marginLR,
    marginV: Math.round(dims.height * CAPTION_MARGIN_V_RATIO),
    outline: Math.max(1, Math.round(fontSize * CAPTION_FONT.outlineRatio)),
    budgetPx: available > 0 ? available * LINE_FILL_MAX : Infinity,
  };
}

/** 全角相当(CJK等)なら2、半角なら1（srt-builder.mjs の charDisplayWidth と同じ判定）。 */
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
  return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}

/** 文字列の描画幅(px)の見積り（実測比 wideRatio/narrowRatio × フォントサイズを積む）。 */
function textWidthPx(text, fontSize) {
  let px = 0;
  for (const ch of text) {
    const wide = charDisplayWidth(ch) === 2;
    px += fontSize * (wide ? CAPTION_FONT.wideRatio : CAPTION_FONT.narrowRatio);
  }
  return px;
}

/**
 * 語配列を、画面幅に収まる行へ貪欲に詰める（captacity の calculate_lines() 相当）。
 * 語(w.w)は原則、語と語の境界でしか折らない（単語の途中では絶対に割らない＝マスター制約）。
 * ただし1語だけで1行の予算を超える場合は例外で、下記 breakLongToken により文字単位で
 * さらに折り返す（日本語のBudouX融合語で実際に発生することを確認したため。英単語・URL等の
 * 半角語も同じ経路で文字単位に割れるが、書き起こしにURLが出てくることは無く実害は無い）。
 */
/** 1トークンだけで budgetPx を超える場合に、文字単位でさらに複数行へ分割する。
 * 日本語(CJK)は文字間にスペースが要らないため、文字単位で折れても不自然にならない。
 * 句読点・無音が検出されない発話区間ではBudouXの文節認識だけで長い塊が1語に融合することがあり
 * （例：「ありますよねあれ該当する」）、割らずに1行として置く既定動作（英単語・URL向け）のままだと
 * 縦型（幅が狭い）で画面端からはみ出す事故になる。実際に c5b1f1f7 ジョブで確認した。 */
function breakLongToken(token, budgetPx, fontSize) {
  const lines = [];
  let cur = "";
  for (const ch of token) {
    const candidate = cur + ch;
    if (cur && textWidthPx(candidate, fontSize) > budgetPx) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function packWordsIntoLines(words, budgetPx, fontSize) {
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? cur + w.w : w.w;
    if (cur && textWidthPx(candidate, fontSize) > budgetPx) {
      lines.push(cur);
      cur = w.w;
    } else {
      cur = candidate;
    }
    // ここに来た時点で cur が w.w 単体のままなら（＝直前の分岐で単語がそのまま入った場合のみ）、
    // その1語だけで既に budgetPx を超えていないか確認し、超えていれば文字単位で追加分割する。
    if (textWidthPx(cur, fontSize) > budgetPx) {
      const broken = breakLongToken(cur, budgetPx, fontSize);
      lines.push(...broken.slice(0, -1));
      cur = broken[broken.length - 1] ?? "";
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** その塊が文の終わりか。行数の上限を破らない範囲でだけ使う早期区切りのヒント。
 *
 * 【2026-08-19 実測】Groq の日本語文字起こしには句読点が一切付かないため、この判定は
 * 一度も成立していない＝早期区切りは事実上死んでいる。カードは「2行いっぱいまで詰める」
 * だけになる。ここを本当に効かせるには文の切れ目（句読点）が要る。docs/caption-plan.md 参照。 */
function endsSentence(unit) {
  return unit.br === "文" || /[。！？」]$/.test(unit.w);
}

// 末尾がこれで終わるカードは、次へ続く途中で切れている（虎の巻 §2-4「接続助詞・言い差しで
// 終わるのは禁止」）。文の終わりと判定された塊には適用しない（「〜から。」等は文として閉じている）。
const DANGLING_TAIL_RE = /(?:って|て|で|けど|けれど|けれども|が|し|から|ので|のに|たら|れば|なら|ながら|つつ|ものの|とか|や|に|を|は|も|の|と)$/;

/**
 * 接続助詞・言い差しで終わっているカードの末尾の文節を、次のカードへ送る（虎の巻 §2-4）。
 * 送った結果カードが空になるなら送らない（欠けさせるより、途中で切れている方がまし＝原則3）。
 */
export function fixDanglingCardTails(cards, budgetPx, fontSize) {
  for (let i = 0; i < cards.length - 1; i++) {
    const cur = cards[i];
    while (cur.length >= 2) {
      const last = cur[cur.length - 1];
      if (endsSentence(last) || !DANGLING_TAIL_RE.test(last.w)) break;
      // 送り先が2行に収まらなくなるなら送らない。2行以内という保証の方が優先で、
      // これを破ると字幕が画面外へ積み上がる（この見張りが無くて実際に3行のカードが出た）。
      if (packWordsIntoLines([last, ...cards[i + 1]], budgetPx, fontSize).length > CAPTION_MAX_LINES) break;
      cards[i + 1].unshift(cur.pop());
    }
  }
  return cards.filter((c) => c.length > 0);
}

/**
 * カードの区切りを決める（captacity の segment_parser.parse() 相当）。
 * 必須条件は1つだけ：**次の語を足すと2行に収まらなくなったら、そこで区切る**。
 * これだけで「単語の途中で割れない」「必ず2行以内に収まる」の両方が、音声認識バックエンドの
 * ギャップ検出精度に関係なく常に成り立つ（Groqでギャップがほぼ取れない場合でも、幅の判定は
 * 語が積まれるたびに毎回効くため、事故4のような無制限に伸びるカードが発生しない）。
 * 加えて、カードが十分埋まっている（半行以上使っている）ときに限り、文末や大きな無音
 * ギャップでの早期区切りを許す（無くても2行保証は揺らがない、読みやすさのための上乗せ）。
 */
export function buildCaptionCards(relWords, budgetPx, fontSize) {
  const GAP_BREAK = 0.3; // 実測ギャップがこれ以上なら早期区切りの候補にしてよい
  const MIN_FILL_FOR_EARLY_BREAK = 0.35; // 半行未満で毎回切ると極端に短いカードが乱発する
  const cards = [];
  let cur = [];
  for (const w of relWords) {
    if (cur.length) {
      const candidateLines = packWordsIntoLines([...cur, w], budgetPx, fontSize);
      const mustBreak = candidateLines.length > CAPTION_MAX_LINES; // 唯一の必須条件
      let preferBreak = false;
      if (!mustBreak) {
        const gapBefore = +(w.start - cur[cur.length - 1].end).toFixed(3);
        const prevEndsSentence = endsSentence(cur[cur.length - 1]);
        if (prevEndsSentence || gapBefore >= GAP_BREAK) {
          const curLines = packWordsIntoLines(cur, budgetPx, fontSize);
          const usedWidth = textWidthPx(curLines[curLines.length - 1] ?? "", fontSize);
          preferBreak = usedWidth >= budgetPx * MIN_FILL_FOR_EARLY_BREAK;
        }
      }
      if (mustBreak || preferBreak) {
        cards.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) cards.push(cur);
  return cards;
}

/** カード内の語を、画面幅に収まるよう\Nで行分割する（単語の途中では絶対に割らない）。
 * buildCaptionCards がすでに「2行以内に収まる」ことを保証した語の集まりだけを渡す前提
 * だが、行分割そのものは独立した関数として持つ（captacity が calculate_lines と
 * fits_frame を分けているのと同じ構成）。 */
export function wrapCardText(words, budgetPx, fontSize) {
  return packWordsIntoLines(words, budgetPx, fontSize).join("\\N");
}

/**
 * @param {{start:number,end:number}[]} ranges 実際に切り出す区間
 * @param {{start:number,end:number}[]} [textWindows] ranges と同じ並びの「字幕に出してよい語」の範囲。
 *   語は開始時刻がこの範囲に入るものだけを使う（区間と少し重なるだけの、捨てた文節の語を出さない）。
 */
export function buildAssFile(transcript, ranges, assPath, dims, textWindows = null) {
  const PLAY_RES_X = dims.width;
  const PLAY_RES_Y = dims.height;
  const { fontSize, marginLR, marginV, outline, budgetPx } = captionMetrics(dims);

  let relWords = [];
  let newBase = 0;
  for (const [k, r] of ranges.entries()) {
    const tw = textWindows?.[k];
    const TOL = 0.02;
    const rel = wordsInRange(transcript.words, r.start, r.end).filter(
      (w) => !tw || (w.start + r.start >= tw.start - TOL && w.start + r.start < tw.end)
    );
    for (const w of rel) relWords.push({ w: w.w, start: w.start + newBase, end: w.end + newBase });
    newBase += r.end - r.start;
  }
  // 語ではなく文節を最小単位にしてから、幅で詰める（語の途中で折れないようにする）。
  // 切れ目が1つも取れなかった場合は、従来どおり語のまま扱う（編集は止めない）。
  const units = groupIntoPhrases(relWords);
  const cards = fixDanglingCardTails(buildCaptionCards(units, budgetPx, fontSize), budgetPx, fontSize);
  const LEAD = 0.05;
  const MAXHOLD = 0.6;
  // 終了時刻は「次のカードの表示開始より前」を絶対条件にする（最低表示時間の底上げより優先。
  // 底上げを先に適用すると、間隔の詰まったカード同士で重なって縦に積み上がる事故が起きる）。
  const events = cards
    .map((c, i) => {
      const text = wrapCardText(c, budgetPx, fontSize).replace(/[{}]/g, "");
      const start = Math.max(0, c[0].start - LEAD);
      const naturalEnd = c[c.length - 1].end + 0.15;
      const hardLimit = i + 1 < cards.length ? cards[i + 1][0].start - LEAD : Infinity;
      const desiredEnd = Math.min(naturalEnd + MAXHOLD, hardLimit);
      const end = Number.isFinite(hardLimit) ? Math.min(Math.max(desiredEnd, start + 0.05), hardLimit) : desiredEnd;
      return { start, end, text };
    })
    .filter((e) => e.end > e.start) // 直後のカードと間隔が無さすぎて潰れた場合は表示しない（重複させない）
    .map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Caption,,0,0,0,,${e.text}`);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PLAY_RES_X}
PlayResY: ${PLAY_RES_Y}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${CAPTION_FONT.family},${fontSize},&H00FFFFFF,&H00000000,&H00000000,1,1,${outline},0,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  fs.writeFileSync(assPath, header + events.join("\n") + "\n", "utf-8");
}

// ---------- メイン ----------
//
// 【2026-08-19 マスター指示】「UIに素材を投げる→文字起こしする→お前が内容を決める→
// FFmpegで書き出し」にしろ。区間選定を別プロセスの claude -p（毎回まっさらな使い捨ての
// Opus5呼び出し）に丸投げしていたのが、意味の通らない断片を出す原因だった
// （「その名も、コズム」が「も、コズム」になる等。docs/failures.md 参照）。
// 「内容を決める」のはこのセッション（虎の巻・合格条件・過去の失敗を全部知っている）。
// 2コマンドに分割する:
//   node src/edit-job.mjs prepare <jobId>  文字起こし〜文節化まで（ワーカーが自動実行）
//   node src/edit-job.mjs render <jobId>   work/<jobId>/keep.json を読んで書き出しまで
//                                          （keep.json はこのセッションが直接書く）

/** prepare: 文字起こし・無音実測・文節化までを行い、判断材料を work/<jobId> に残す。 */
async function prepareMain(jobId) {
  const job = readInboxJob(jobId);
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const outDir = path.join(RUNTIME_DIR, "outputs", jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // ここで clearCancel はしない。キュー待ち中に押された中止を尊重するため（clearCancel の説明参照）。

  try {
    if (!job.video || !job.video.path) {
      throw new Error("このジョブには動画がありません（instructionのみのテスト送信の可能性）");
    }
    console.log(`[0/4] 受け取った指示: ${job.instruction ? job.instruction : "（指示なし）"}`);
    checkCancelled(workDir);
    transcribe(job.video.path, workDir);
    checkCancelled(workDir);
    // 誤字直し（裏で claude -p を呼ぶ工程）は 2026-09-27 に外した（マスター決定）。他の人の PC では
    // claude コマンドが無い・認証が切れている可能性が高く、実際に認証切れで失敗していた。台本を読んで
    // 内容を理解するのはこのセッション自身なので、字幕なしなら仕上がりに影響しない。
    const transcript = JSON.parse(fs.readFileSync(path.join(workDir, "transcript.json"), "utf-8"));
    const silences = detectSilences(job.video.path);
    writeJsonAtomically(path.join(workDir, "silences.json"), silences);

    console.log("[4/4] 文節に分けています…");
    const units = groupIntoPhrases(transcript.words || [], silences);
    // 原子的に書く（一時ファイル→rename）。見張り（server/watch-jobs.mjs）は units.json の
    // 出現を「選定待ち」の合図として読むので、書き込み途中の中途半端な内容を読ませない。
    //
    // 【2026-08-19】pretty-print(indent:2)だと1文節あたり6行に膨れ、長尺動画（数千文節）だと
    // このセッションが units.json を読み切るだけで長時間かかっていた。中身は変えず、1文節1行に
    // 詰めた配列として書く（JSON.parse する側は空白の違いを気にしないのでrenderMain・
    // watch-jobs.mjs は無変更で動く）。
    writeJsonAtomically(
      path.join(workDir, "units.json"),
      units.map((u, i) => ({ i, start: +u.start.toFixed(3), end: +u.end.toFixed(3), w: u.w })),
      (data) => `[\n${data.map((u) => JSON.stringify(u)).join(",\n")}\n]`
    );
    console.log(`  文節 ${units.length} 個。work/${jobId}/units.json を全文読んで、editorial_plan.json を書いてください。`);
    console.log(`  書いたら: node src/edit-job.mjs plan ${jobId}`);
  } catch (err) {
    if (err instanceof CancelledError) {
      appendResult({ id: jobId, status: "cancelled", message: err.message, at: new Date().toISOString() });
      clearCancel(workDir); // 中止として記録した時点で旗の役目は終わり（残すと次の render が即死する）
      console.log(`中止: ${jobId}`);
    } else {
      appendResult({ id: jobId, status: "error", message: err.message, at: new Date().toISOString() });
      console.error(`失敗: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

/**
 * new: チャットで渡された動画を1ジョブとして登録し、そのまま prepare まで実行する。
 * 2026-09-27 マスター指示「デスクトップ版の Claude Code だけで完結する形に。UI は不要。チャット欄の操作だけで完結」。
 * 以前は UI → サーバー → ワーカーがジョブを登録していた。いまはこのセッションが直接登録する。
 */
async function newMain(videoArg, { portrait = false, caption = false, instruction = "" } = {}) {
  const videoPath = path.resolve(videoArg.replace(/^["']|["']$/g, ""));
  if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
    console.error(`動画が見つかりません: ${videoPath}`);
    process.exitCode = 1;
    return;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const job = {
    id,
    at: new Date().toISOString(),
    instruction,
    video: { path: videoPath, originalName: path.basename(videoPath) },
    settings: { aspect: portrait ? "portrait" : "landscape", caption, outputCount: 1 },
  };
  fs.appendFileSync(CHAT_INBOX, JSON.stringify(job) + "\n", "utf-8");
  console.log(`ジョブを登録しました: ${id}（${job.settings.aspect} / 字幕${caption ? "あり" : "なし"}）`);
  await prepareMain(id);
  if (!process.exitCode) console.log(`JOB_ID=${id}`);
}

/** 区間を決めるための材料（prepare の結果）と、このセッションが書いた編集案をまとめて読む。 */
function loadJudgmentInputs(workDir) {
  const unitsPath = path.join(workDir, "units.json");
  if (!fs.existsSync(unitsPath)) throw new Error(`prepare を先に実行してください: ${unitsPath} がありません`);
  const units = JSON.parse(fs.readFileSync(unitsPath, "utf-8"));
  const silences = JSON.parse(fs.readFileSync(path.join(workDir, "silences.json"), "utf-8"));
  const transcript = JSON.parse(fs.readFileSync(path.join(workDir, "transcript.json"), "utf-8"));
  const { plan, file: planFile, text: planText } = loadPlan(workDir);
  return { units, silences, transcript, plan, planFile, planText };
}

/** plan: 編集案を検査し、採用する文節の本文を動画の順番どおりに並べた台本案を表示・保存する。 */
function planMain(jobId) {
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const { units, plan, planFile } = loadJudgmentInputs(workDir);
  const problems = validatePlan(plan, units.length);
  if (problems.length) {
    console.error(`編集案に問題があります（${path.basename(planFile)}）:`);
    for (const p of problems) console.error(`- ${p}`);
    process.exitCode = 1;
    return;
  }
  const script = renderScript(plan, units);
  fs.writeFileSync(path.join(workDir, "script.txt"), `${script}\n`, "utf-8");
  console.log(`台本案（${path.basename(planFile)} / ${plan.segments.length}ブロック）:\n`);
  console.log(script);
  console.log(`\nこの台本案をマスターに見せ、承認をもらったら: node src/edit-job.mjs approve ${jobId}`);
}

/** approve: いまの編集案をマスターが承認したことを記録する。 */
function approveMain(jobId) {
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const { units, plan, planFile, planText } = loadJudgmentInputs(workDir);
  const problems = validatePlan(plan, units.length);
  if (problems.length) throw new Error(`問題のある編集案は承認できません:\n- ${problems.join("\n- ")}`);
  const rec = writeApproval(workDir, planFile, planText);
  console.log(`承認を記録しました（${rec.planFile} sha256=${rec.sha256.slice(0, 12)}…）。次: node src/edit-job.mjs render ${jobId}`);
}

/**
 * render: 承認済みの編集案（editorial_plan.json、無ければ旧形式の keep.json）を読み、
 * EDL（edl.json）に直してから書き出しまで実行する。
 *
 * 切り分け用の指定（2026-09-26。音声が欠落する不具合を、どの工程で起きているか突き止めるため）:
 *   noSnap   … 無音スナップを飛ばす（文節の時刻そのままで切る）
 *   noFiller … 言い淀み除去を飛ばす
 *   outName  … outputs/<jobId>/<outName>.mp4 と work/<jobId>/decision-<outName>.json へ書く。
 *              試しの書き出しなので results.jsonl には何も書かない（UI を「完了」にしない）。
 * keep.json の形式: {"keep": [[開始文節番号, 終了文節番号], ...],
 *                     "applied": ["反映した指示"], "notApplied": ["反映できなかった指示"]}
 * keep はこのセッションが units.json を読んで直接決める（区間選定の自動化はしない）。
 */
async function renderMain(jobId, { noSnap = false, noFiller = false, noCaption = false, outName = null } = {}) {
  const job = readInboxJob(jobId);
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const outDir = path.join(RUNTIME_DIR, "outputs", jobId);
  fs.mkdirSync(outDir, { recursive: true });
  // render は明示的に叩かれたコマンド＝過去の中止指示より新しい意思なので旗を下ろす。
  // ただし黙って下ろすと「中止したのに完走した」が誰にも伝わらないので、必ず表示する。
  if (clearCancel(workDir)) {
    console.log("[注意] 中止の旗が立っていましたが、render の明示的な実行として下ろしました。");
    console.log("       中止したままにしたい場合は、いま Ctrl+C で止めてください。");
  }

  try {
    const { units, silences, transcript, plan, planFile, planText } = loadJudgmentInputs(workDir);
    const problems = validatePlan(plan, units.length);
    if (problems.length) throw new NotReadyError(`編集案に問題があります:\n- ${problems.join("\n- ")}`);
    // 試しの書き出し（--out）は完了記録を書かず UI にも出ないので、承認を待たずに回せる
    // （音声欠落の切り分けのような、成果物ではない確認用）。成果物の書き出しは承認が必須。
    if (!outName) {
      const why = approvalProblem(workDir, planFile, planText);
      if (why) throw new NotReadyError(why);
    }
    const decision = { applied: plan.applied ?? [], notApplied: plan.notApplied ?? [] };

    checkCancelled(workDir);
    if (noSnap) console.log("[切り分け] 無音スナップを飛ばしました（--no-snap）");
    console.log("[5/8] 言い淀みを切っています…");
    const edl = resolveEdl({
      plan,
      units,
      silences,
      words: transcript.words || [],
      source: job.video.path,
      noSnap,
      noFiller,
    });
    if (noFiller) {
      console.log("[切り分け] 言い淀み除去を飛ばしました（--no-filler）");
    } else if (edl.fillerAborted) {
      console.log("  フィラー判定が半数を超えたため、判定が壊れているとみなして1つも切りません");
    } else {
      const cutSec = edl.fillerCuts.reduce((acc, c) => acc + (c.end - c.start), 0);
      console.log(`  ${edl.fillerCuts.length}箇所 / 計${cutSec.toFixed(1)}秒を除去（見送り ${edl.fillerSkipped.length}箇所）`);
      for (const c of edl.fillerCuts) console.log(`    切: ${c.start.toFixed(2)}s 「${c.word}」`);
      for (const k of edl.fillerSkipped) console.log(`    残: ${k.start.toFixed(2)}s 「${k.word}」← ${k.reason}`);
    }
    // 書き出しは区間の端を映像のフレーム境界に揃えて切る（render-edl.mjs）。字幕の時刻も
    // 実際に切る区間に合わせるため、ここで先に揃えておく（renderFinal 側で揃え直しても変わらない）。
    const fps = probeFps(job.video.path);
    // 1区間ずつ揃える（フレーム数0で消えた区間があっても、字幕の語の範囲と並びがずれないように）。
    const aligned = edl.ranges.map((r) => ({ r, a: alignToFrames([r], fps)[0] })).filter((p) => p.a);
    const ranges = aligned.map(({ a }) => ({ start: a.start, end: a.end }));
    const textWindows = aligned.map(({ r, a }) => ({ start: r.textStart ?? a.start, end: r.textEnd ?? a.end }));
    // 書き出しは EDL だけを見る。記録として残す（以前の decision.json はこれに統合した）。
    writeJsonAtomically(path.join(workDir, outName ? `edl-${outName}.json` : "edl.json"), {
      ...edl,
      instruction: job.instruction ?? "",
      applied: decision.applied,
      notApplied: decision.notApplied,
      // 実際に切り出す区間（フレーム境界に揃えたもの）。検品で時刻を照合するときはこちらを使う。
      fps,
      renderedRanges: ranges,
    });
    for (const line of decision.applied) console.log(`  [反映] ${line}`);
    for (const line of decision.notApplied) console.log(`  [未反映] ${line}`);
    checkCancelled(workDir);

    const portrait = job.settings?.aspect === "portrait";
    // 縦型は letterbox 先が常に1080x1920なのでprobe不要。横型は元動画の実寸を使う
    // （trim/concatは解像度を変えないため、書き出し後も同じ実寸になる）。
    const dims = portrait ? { width: 1080, height: 1920 } : probeDimensions(job.video.path);

    const resultPath = path.join(outDir, outName ? `${outName}.mp4` : "result.mp4");
    let assPath = null;
    if (job.settings?.caption && !noCaption) {
      assPath = path.join(workDir, "captions.ass");
      buildAssFile(transcript, ranges, assPath, dims, textWindows);
      checkCancelled(workDir);
    }
    renderFinal({ videoPath: job.video.path, ranges, portrait, assPath, workDir, outPath: resultPath, fps });
    checkCancelled(workDir);

    if (outName) {
      console.log(`[切り分け] 書き出しました（完了記録は書きません）: ${resultPath}`);
      return;
    }
    console.log("[完了] 完了記録を書き込み中…");
    appendResult({
      id: jobId,
      status: "done",
      output: resultPath,
      instruction: job.instruction ?? "",
      applied: decision.applied,
      notApplied: decision.notApplied,
      at: new Date().toISOString(),
    });
    console.log(`完了: ${resultPath}`);
  } catch (err) {
    if (err instanceof NotReadyError) {
      console.error(`まだ書き出せません: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof CancelledError) {
      appendResult({ id: jobId, status: "cancelled", message: err.message, at: new Date().toISOString() });
      clearCancel(workDir); // 中止として記録した時点で旗の役目は終わり（残すと次の render が即死する）
      console.log(`中止: ${jobId}`);
    } else {
      appendResult({ id: jobId, status: "error", message: err.message, at: new Date().toISOString() });
      console.error(`失敗: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// 以前ここで定義していた関数は、import していた側のために同じ名前で出し続ける。
export { groupIntoPhrases, renderFinal };

async function main() {
  const [, , cmd, jobId, ...rest] = process.argv;
  if (cmd === "doctor") {
    process.exitCode = runDoctor();
    return;
  }
  if (cmd === "new") {
    if (!jobId) usage();
    const opts = { portrait: false, caption: false, instruction: "" };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--portrait") opts.portrait = true;
      else if (rest[i] === "--caption") opts.caption = true;
      else if (rest[i] === "--instruction" && rest[i + 1] != null) opts.instruction = rest[++i];
      else usage();
    }
    await newMain(jobId, opts);
    return;
  }
  if (!cmd || !jobId || !["prepare", "plan", "approve", "render"].includes(cmd)) usage();
  if (cmd !== "render") {
    if (rest.length) usage();
    if (cmd === "prepare") {
      await prepareMain(jobId);
      return;
    }
    try {
      if (cmd === "plan") planMain(jobId);
      else approveMain(jobId);
    } catch (err) {
      console.error(`失敗: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const opts = { noSnap: false, noFiller: false, noCaption: false, outName: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--no-snap") opts.noSnap = true;
    else if (rest[i] === "--no-filler") opts.noFiller = true;
    // 字幕なしで書き出す（2026-09-27 マスター指示「字幕無し状態で良い感じにする、を最初の目標に」）。
    // 字幕は仕上がりの判定対象から外すだけなので、--out 無しでも使える。
    else if (rest[i] === "--no-caption") opts.noCaption = true;
    else if (rest[i] === "--out" && /^[A-Za-z0-9_-]+$/.test(rest[i + 1] ?? "")) opts.outName = rest[++i];
    else usage();
  }
  // 切り分けの書き出しで result.mp4 と完了記録を上書きしないよう、飛ばす指定には --out を必須にする。
  if ((opts.noSnap || opts.noFiller) && !opts.outName) usage();
  await renderMain(jobId, opts);
}

// 検証スクリプト等からこのファイルを import して buildCaptionCards/wrapCardText/buildAssFile を
// 単体で叩けるように、直接実行されたときだけ main() を走らせる。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
