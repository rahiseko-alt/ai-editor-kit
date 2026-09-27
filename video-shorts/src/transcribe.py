#!/usr/bin/env python3
"""video-shorts [3] 文字起こし — faster-whisper で word-level transcript を出力する。

使い方:
    python src/transcribe.py <input.mp4> <out_transcript.json> [--model small] [--lang ja]

出力 JSON 形式（word-level・逆マッチングの真実の源）:
    {
      "language": "ja",
      "duration": 1234.5,
      "words": [ {"w": "こんにちは", "start": 0.12, "end": 0.65}, ... ],
      "segments": [ {"start": 0.0, "end": 4.2, "text": "..." }, ... ]
    }

秒数は LLM に出させず、この words[] に対してテキスト逆マッチングして確定する
（reverse-match.mjs）。落とし穴#1 の対策。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone


def parse_args(argv):
    p = argparse.ArgumentParser(description="faster-whisper word-level transcriber")
    p.add_argument("input", help="入力 mp4/音声ファイル")
    p.add_argument("output", help="出力 transcript.json パス")
    p.add_argument("--model", default="small",
                   help="whisper モデル (tiny/base/small/medium/large-v3)。既定 small")
    p.add_argument("--lang", default=None, help="言語コード (例: ja)。未指定で自動判定")
    p.add_argument("--device", default="auto", help="cpu / cuda / auto")
    p.add_argument("--compute-type", default="int8",
                   help="cpu は int8 推奨 / cuda は float16")
    p.add_argument("--backend", default="auto", choices=["auto", "local", "groq"],
                   help="文字起こしバックエンド。auto=鍵あれば groq・無ければ local")
    return p.parse_args(argv)


def load_model(model_name, device, compute_type):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "[ERROR] faster-whisper 未インストール。`pip install faster-whisper` を実行してください。\n"
        )
        sys.exit(3)
    if device == "auto":
        # CUDA 判定は失敗しても cpu に落とす（実験環境は GPU 無しが多い）
        try:
            model = WhisperModel(model_name, device="cuda", compute_type="float16")
            return model, "cuda"
        except Exception:
            pass
        device = "cpu"
    if device == "cpu" and compute_type == "float16":
        compute_type = "int8"  # cpu で float16 は不可
    return WhisperModel(model_name, device=device, compute_type=compute_type), device


def transcribe(model, input_path, lang):
    # word_timestamps=True が逆マッチングの肝（落とし穴#1）
    segments_iter, info = model.transcribe(
        input_path,
        language=lang,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    segments = []
    for seg in segments_iter:
        segments.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
        })
        for word in (seg.words or []):
            words.append({
                "w": word.word.strip(),
                "start": round(word.start, 3),
                "end": round(word.end, 3),
            })
    return {
        "language": info.language,
        "duration": round(info.duration, 3),
        "words": words,
        "segments": segments,
    }


def load_corrections():
    """同ディレクトリの term-corrections.json を読み、誤→正マップを返す（不在/空/壊れは {}）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "term-corrections.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # _ 始まりキー（コメント等）と非文字列値は除外
        return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, str)}
    except Exception:
        return {}


def fix_words(words, corrections):
    """words[] へ誤変換辞書を適用する。語をまたいで分割された誤変換にも効かせる。

    素朴に1語ずつ置換すると、誤変換語が複数トークンへ分割されたとき
    （例 words=[追][患][版]）どの語もキー全体を含まないので直らない。
    字幕は words[].w から作られるので、これだと画面には誤変換が残ったままになる。
    そこで全語を連結した文字列で探し、見つかった範囲の語を1語へまとめて置き換える。

    まとめた語の時刻は「最初の語の開始」〜「最後の語の終了」にする。
    直すのは綴りであって喋った時刻ではないので、範囲は元のまま保つ。
    範囲の前後にはみ出した文字（語の途中で一致した場合）はそのまま残す。
    """
    if not corrections or not words:
        return words

    out = [dict(w) for w in words]
    # 置換のたびに連結文字列が変わるので、変化が無くなるまで繰り返す。
    # 上限は暴走よけ（辞書の件数ぶん回れば足りる）。
    for _ in range(len(corrections) * len(out) + 1):
        starts = []
        pos = 0
        for w in out:
            t = w.get("w") if isinstance(w.get("w"), str) else ""
            starts.append(pos)
            pos += len(t)
        text = "".join(
            (w.get("w") if isinstance(w.get("w"), str) else "") for w in out
        )

        hit = None
        for wrong, right in corrections.items():
            at = text.find(wrong)
            if at >= 0:
                # 置換後の語がそのまま同じ誤変換を含むと、無限に見つかり続ける。
                if wrong in right:
                    continue
                hit = (at, wrong, right)
                break
        if hit is None:
            return out

        at, wrong, right = hit
        end = at + len(wrong)
        first = _owner_index(starts, out, at)
        last = _owner_index(starts, out, end - 1)
        head = out[first].get("w", "")[: at - starts[first]]
        tail = out[last].get("w", "")[end - starts[last]:]
        merged = dict(out[first])
        merged["w"] = head + right + tail
        if "end" in out[last]:
            merged["end"] = out[last]["end"]
        out = out[:first] + [merged] + out[last + 1:]

    return out


def _owner_index(starts, words, char_pos):
    """連結文字列の char_pos が、何番目の語に属するかを返す。"""
    for i in range(len(words) - 1, -1, -1):
        if starts[i] <= char_pos:
            return i
    return 0


def apply_corrections(result, corrections):
    """words[].w と segments[].text の両方へ誤変換辞書を適用する。
    字幕(words)と区間選定(segments.text→LLM提示)の双方に一貫して効かせるのが目的。"""
    if not corrections:
        return result

    def fix(s):
        for wrong, right in corrections.items():
            if wrong in s:
                s = s.replace(wrong, right)
        return s

    result["words"] = fix_words(result.get("words", []), corrections)
    for seg in result.get("segments", []):
        if isinstance(seg.get("text"), str):
            seg["text"] = fix(seg["text"])
    return result


def write_timing(output_path, stage_name, start_dt, end_dt):
    """出力先(transcript.json)と同じディレクトリの timing.json に stages.<stage_name> を
    read-modify-write で追記する。スキーマは timing.mjs 側が正:
    {stages: {<name>: {start: ISO, end: ISO, sec: number}}}
    書込み失敗は WARN のみで本処理の成功(exit 0)を維持する（サイレントフェイル方針: 計測は補助）。

    2026-08-17: 書き込みは「同じディレクトリの一時ファイルへ書く→os.replace」の原子的な作法に
    する（timing.mjs / state.json と同じ）。timing.json は server・pipeline.mjs・このスクリプトが
    read-modify-write で書き足していく共有ファイルなので、途中で落ちて壊れると、それまでの
    全工程の記録がまとめて読めなくなる。
    """
    timing_path = os.path.join(os.path.dirname(os.path.abspath(output_path)), "timing.json")
    try:
        timing = {"stages": {}}
        if os.path.isfile(timing_path):
            try:
                with open(timing_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("stages"), dict):
                    timing = data
            except Exception:
                timing = {"stages": {}}
        sec = round((end_dt - start_dt).total_seconds())
        timing["stages"][stage_name] = {
            "start": start_dt.isoformat().replace("+00:00", "Z"),
            "end": end_dt.isoformat().replace("+00:00", "Z"),
            "sec": sec,
        }
        tmp_path = f"{timing_path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(timing, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, timing_path)
    except Exception as e:
        sys.stderr.write(f"[WARN] timing.json 書込み失敗（計測スキップ）: {type(e).__name__}: {e}\n")


def resolve_backend(choice):
    """auto の場合は GROQ_API_KEY の有無で groq/local を決める。"""
    if choice in ("local", "groq"):
        return choice
    try:
        from transcribe_groq import load_key
        return "groq" if load_key() else "local"
    except Exception:
        return "local"


def run_backend(backend, args):
    """指定 backend で文字起こしし、共通スキーマの result dict を返す。"""
    if backend == "groq":
        from transcribe_groq import transcribe_groq as _tg
        sys.stderr.write(f"[INFO] Groq backend 文字起こし開始: {args.input}\n")
        return _tg(args.input, args.lang)
    sys.stderr.write(f"[INFO] モデル {args.model} を読み込み中...\n")
    model, used_device = load_model(args.model, args.device, args.compute_type)
    sys.stderr.write(f"[INFO] device={used_device} 文字起こし開始: {args.input}\n")
    return transcribe(model, args.input, args.lang)


def main(argv):
    args = parse_args(argv)
    if not os.path.isfile(args.input):
        sys.stderr.write(f"[ERROR] 入力が見つかりません: {args.input}\n")
        return 2
    start_dt = datetime.now(timezone.utc)
    backend = resolve_backend(args.backend)
    # 【この2行の文言は server/pipeline-runner.mjs が読む契約】
    #   "[INFO] backend=<groq|local>"        … 実際に使うバックエンド
    #   "[WARN] Groq 失敗→local フォールバック" … 途中で local へ落ちた事実
    # サーバーはこの stderr から「実際に使った側」を判定し、画面の Turbo バッジへ流す
    # （鍵の有無からの先読みで出すと、Groq が落ちた回にも Turbo が出たままになり、
    #   表示と実態が食い違う）。文言を変えるときは pipeline-runner.mjs の
    #   parseBackendFromLog() を同時に直すこと。
    sys.stderr.write(f"[INFO] backend={backend}\n")
    try:
        result = run_backend(backend, args)
    except Exception as e:
        # auto かつ Groq 失敗時のみローカルへ無料退避。明示 --backend groq は落とす（サイレントフェイル禁止）。
        if backend == "groq" and args.backend == "auto":
            sys.stderr.write(f"[WARN] Groq 失敗→local フォールバック: {type(e).__name__}: {e}\n")
            try:
                result = run_backend("local", args)
            except Exception as e2:
                sys.stderr.write(f"[ERROR] local フォールバックも失敗: {type(e2).__name__}: {e2}\n")
                return 4
        else:
            sys.stderr.write(f"[ERROR] 文字起こし失敗: {type(e).__name__}: {e}\n")
            return 4
    # 用語後補正: transcript.json はパイプラインの単一真実源。ここで一括補正すれば
    # 字幕(words)・区間選定(segments.text)・逆マッチング(words.w)の全下流に一貫適用される。
    corrections = load_corrections()
    if corrections:
        result = apply_corrections(result, corrections)
        sys.stderr.write(f"[INFO] 用語後補正 {len(corrections)}件を words/segments に適用\n")
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    end_dt = datetime.now(timezone.utc)
    write_timing(args.output, "transcribe", start_dt, end_dt)
    sys.stderr.write(
        f"[OK] words={len(result['words'])} segments={len(result['segments'])} "
        f"duration={result['duration']}s → {args.output}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
