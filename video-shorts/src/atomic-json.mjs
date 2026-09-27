// video-shorts 状態JSON の原子的書き込み共通ヘルパー — P2-1
//
// state.json 等は、書き込み中にプロセスが強制終了すると壊れる恐れがある。
// 直接最終pathへ `fs.writeFileSync(p, ...)` する実装は内部で O_TRUNC 付きで open するため、
// open した時点でファイルが0バイトへ切り詰められる。書き終える前に落ちると、元あった
// 内容ごと失われ、以後 JSON.parse できなくなる（ジョブの進捗が読めず再開できなくなる）。
//
// caption-store.mjs の writeEditsAtomically と同じ「同じディレクトリの一時ファイルへ書く→
// rename で置き換える」作法に、fsync（tmpファイルの内容をディスクへ確定させてから rename
// する）を加えて共通化する。rename は同一ファイルシステム内であれば POSIX 上 atomic なので、
// 置き換え途中の状態が外部から観測されることはない（旧内容のまま か 新内容のまま のどちらか）。
import fs from "node:fs";
import path from "node:path";

/**
 * オブジェクトを JSON 化して同じディレクトリの一時ファイルへ書き、fsync でディスクへ
 * 確定させてから最終pathへ rename する。
 * @param {string} filePath 書き込み先の最終パス
 * @param {object} data JSON化するオブジェクト
 * @param {(data: object) => string} [serialize] JSON文字列化の方法。省略時は従来どおり
 *   pretty-print（2スペースインデント）。行数を抑えたい大きな配列（例: units.json）向けに
 *   差し替え可能にしてある（他の呼び出し元の既定挙動は一切変わらない）。
 */
export function writeJsonAtomically(filePath, data, serialize = (d) => JSON.stringify(d, null, 2)) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const buf = Buffer.from(`${serialize(data)}\n`, "utf-8");
  const fd = fs.openSync(tmp, "w");
  try {
    // fs.writeSync は要求したバイト数を全部書き切るとは限らない（部分書き込みが起こりうる）。
    // 戻り値(実際に書けたバイト数)を無視すると、未完成のJSONをfsync/renameしてしまい、
    // 「一時ファイルへ書く→fsync→rename」という原子性の前提が崩れる。書き切るまでループする。
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(fd, buf, written, buf.length - written);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);

  // POSIXでは、rename の永続化(ディレクトリエントリの更新)自体もfsyncしないと、電源喪失時に
  // renameが巻き戻りうる（ファイル内容のfsyncだけでは不十分）。親ディレクトリをreadで開いて
  // fsyncする。
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (_) {
    // Windows等、ディレクトリをopen/fsyncできない環境がある。ファイル自体のfsyncは既に
    // 済んでおり、ここは「rename巻き戻り防止」という追加の堅牢化のためのベストエフォートなので、
    // 失敗しても処理全体は成功として扱う(握りつぶす)。
  }
}
