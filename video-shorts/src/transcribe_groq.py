#!/usr/bin/env python3
"""video-shorts [3] 文字起こし — Groq バックエンド。

Groq Whisper (whisper-large-v3-turbo) をクラウドで叩き、ローカル faster-whisper と
同一スキーマの transcript.json を返す（reverse-match.mjs 互換）。§0「外部AIを束ねる」の実装。

出力 JSON はローカル版（transcribe.py）と完全一致:
    {
      "language": "ja",
      "duration": 1234.5,
      "words": [ {"w": "こんにちは", "start": 0.12, "end": 0.65}, ... ],
      "segments": [ {"start": 0.0, "end": 4.2, "text": "..." }, ... ]
    }

単体 CLI:
    python src/transcribe_groq.py <input.mp4> <out_transcript.json> [--lang ja] [--model whisper-large-v3-turbo]

鍵は .env の GROQ_API_KEY か環境変数から読む。値はログに出さない。

Groq audio API のファイルサイズ上限（無料枠 25MB / 有料 100MB）は、送信前に
16kHz モノラル mp3 へ音声抽出することで回避する（extract_audio_16k）。32kbps なら
100 分でも 25MB 未満に収まるため、この長さまでは分割不要。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

DEFAULT_MODEL = "whisper-large-v3-turbo"

# ── Groq を待つ時間の上限（2026-08-17 見直し）─────────────────────────────
# 旧設定は timeout=600 秒 × max_retries=3（SDK 内蔵リトライ）だった。認証エラーでも回線断でも
# 同じ扱いで待ち切るため、最悪 40 分ちかく **stderr に何も出さないまま** 溶かしたうえで、
# そこからローカル whisper を頭から回していた（マスター指摘「遅い」の主因のひとつ）。
#
# どこまで待つのが妥当か（この値の根拠）:
#   * 送るのは extract_audio_16k が作る 16kHz モノラル mp3 / 32kbps ＝ 1 分あたり約 240KB。
#     このファイルの前提である 100 分の素材でも約 24MB。
#   * httpx の timeout は「1回の入出力操作」ごとの上限であって合計時間ではない。したがって
#     write=90 秒は「送信が1分半のあいだ1バイトも進まない」＝実質的な回線断のときだけ効く。
#     家庭用の上り 1Mbps でも 24MB は約 200 秒で送り切れるが、その 200 秒は細かい write に
#     分割されるので 90 秒には掛からない。
#   * Groq の whisper-large-v3-turbo は実時間の 100 倍以上速く、100 分の音声でも応答は数十秒。
#     read=90 秒はその 3 倍前後の余裕がある。
#   * 締切 240 秒（4 分）: 同じ素材をローカル whisper（CPU）で回すと数十分かかる。4 分で
#     見切れば「Groq を待った分の損」はその程度に収まり、かつ上の見積り（最悪でもおおよそ
#     3.5 分）を上回るので、遅いだけで健全な回線を途中で切ることはない。
#     ※ httpx には「1リクエストの合計時間」の上限が無いため、この締切が縛るのは
#       **新しい試行を始めてよい期限**。実際の最悪値は「締切＋試行1回分（約190秒）」で
#       おおよそ 7 分。旧設定の最悪 40 分（しかも無言）からは大幅に短くなる。
GROQ_CONNECT_TIMEOUT = 10.0   # 接続が張れない（DNS/到達不能）ならすぐ諦める
GROQ_WRITE_TIMEOUT = 90.0     # 送信が止まったまま動かない状態の上限
GROQ_READ_TIMEOUT = 90.0      # 送信後、応答が1バイトも来ない状態の上限
GROQ_MAX_ATTEMPTS = 3         # 最初の1回＋再試行2回
GROQ_TOTAL_DEADLINE = 240.0   # 新しい試行を始めてよい期限（超えたら local へ譲る）
GROQ_RETRY_BACKOFF = (3.0, 8.0)  # 再試行の前に待つ秒数（回数ぶん）

# 再試行しても直らない失敗の HTTP ステータス。鍵が違う(401/403)・ファイルが大きすぎる(413)・
# 要求が不正(400/422)等は、何度投げても同じ答えが返るだけなので即座に諦めて local へ落とす。
# ここに載らない一時的な失敗（408/409/429/5xx・接続断）だけを再試行の対象にする。
NON_RETRYABLE_STATUS = frozenset({400, 401, 403, 404, 405, 413, 415, 422})
# Groq audio API のファイルサイズ上限（無料枠 25MB / 有料 100MB）を回避するため、
# 送信前に必ず 16kHz モノラル mp3 へ音声抽出する。whisper は内部で 16kHz に
# ダウンサンプルするため ASR 精度への影響は無視できる。32kbps なら 100 分でも
# 25MB 未満に収まり、長尺でも分割不要（元 mp4 直送だと数百 MB で 413 になる）。
AUDIO_SAMPLE_RATE = "16000"
AUDIO_BITRATE = "32k"


def load_key(explicit=None):
    """GROQ_API_KEY を 環境変数 → .env（video-shorts 直下）の順で取得。値は返すのみ・出力しない。

    優先順位は server/pipeline-runner.mjs の groqKeyAvailable() と同一に保つこと
    （並列制御の判定と実働バックエンドの不一致防止）。.env の空値行（GROQ_API_KEY=）は
    「未設定」として読み飛ばす（古い空行が残っていても環境変数へフォールバックする）。"""
    if explicit:
        return explicit.strip()
    env_val = (os.environ.get("GROQ_API_KEY") or "").strip()
    if env_val:
        return env_val
    # VS_ENV_FILE があれば既定の video-shorts/.env の代わりにそれを読む（テストが実運用の
    # .env を汚さずに検証するための差し替え口。src/env-file.mjs の envFilePath() と同じ規約）。
    override = os.environ.get("VS_ENV_FILE")
    if override:
        env_path = os.path.abspath(override)
    else:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # src/ の親 = video-shorts/
        env_path = os.path.join(here, ".env")
    if os.path.isfile(env_path):
        with open(env_path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GROQ_API_KEY="):
                    # クォート囲み（"gsk_..." 等）で貼られた場合に備えクォートも除去
                    v = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if v:
                        return v
    return ""


def _to_schema(data):
    """Groq verbose_json 応答をローカル版と同一スキーマへ変換。"""
    words = []
    for w in (data.get("words") or []):
        if w.get("start") is None or w.get("end") is None:
            continue
        words.append({
            "w": (w.get("word") or "").strip(),
            "start": round(float(w["start"]), 3),
            "end": round(float(w["end"]), 3),
        })
    segments = []
    for s in (data.get("segments") or []):
        segments.append({
            "start": round(float(s.get("start", 0.0)), 3),
            "end": round(float(s.get("end", 0.0)), 3),
            "text": (s.get("text") or "").strip(),
        })
    return {
        "language": data.get("language"),
        "duration": round(float(data.get("duration") or 0.0), 3),
        "words": words,
        "segments": segments,
    }


def extract_audio_16k(input_path):
    """動画/大容量ファイルを Groq 上限内に収めるため 16kHz モノラル mp3 に抽出する。
    一時ファイルのパスを返す（呼び出し側が finally で削除する責務を持つ）。
    ffmpeg が無い/失敗した場合は RuntimeError（サイレントフェイル禁止）。"""
    fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="groq-audio-")
    os.close(fd)
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vn", "-ac", "1", "-ar", AUDIO_SAMPLE_RATE,
        "-c:a", "libmp3lame", "-b:a", AUDIO_BITRATE,
        tmp,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        os.path.exists(tmp) and os.remove(tmp)
        raise RuntimeError("ffmpeg が見つかりません。音声抽出に必須です。")
    except subprocess.CalledProcessError as e:
        os.path.exists(tmp) and os.remove(tmp)
        tail = (e.stderr or b"")[-400:].decode("utf-8", "replace")
        raise RuntimeError(f"ffmpeg 音声抽出に失敗: {tail}")
    return tmp


def _status_of(exc):
    """例外から HTTP ステータスを取り出す（取れなければ None）。"""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def is_retryable(exc):
    """もう一度投げれば直る見込みがある失敗か。

    分からないものは「直らない」側に倒す。待って直らない失敗を待ち続けるより、
    すぐローカルへ落ちた方が利用者にとって速いため（この判断が無かったせいで、
    鍵が違うだけの回でも十数分待たされていた）。
    """
    status = _status_of(exc)
    if status is not None:
        if status in NON_RETRYABLE_STATUS:
            return False
        return status in (408, 409, 429) or status >= 500
    # ステータスが無い＝HTTP応答まで届いていない（接続断・送受信の停止）。回線側の一時障害
    # なので再試行の価値がある。groq SDK では APITimeoutError も APIConnectionError の一種。
    try:
        from groq import APIConnectionError
    except ImportError:
        return False
    return isinstance(exc, APIConnectionError)


def _build_timeout():
    """httpx の粒度別 timeout を組み立てる（httpx が無ければ合計秒数へフォールバック）。"""
    try:
        import httpx
        return httpx.Timeout(
            connect=GROQ_CONNECT_TIMEOUT,
            write=GROQ_WRITE_TIMEOUT,
            read=GROQ_READ_TIMEOUT,
            pool=GROQ_CONNECT_TIMEOUT,
        )
    except Exception:
        return GROQ_READ_TIMEOUT + GROQ_WRITE_TIMEOUT


def transcribe_groq(input_path, lang=None, model=DEFAULT_MODEL, api_key=None):
    """Groq で文字起こしし、ローカル版と同一スキーマの dict を返す。
    送信前に 16kHz モノラル mp3 へ抽出し、上限超過（413）と帯域浪費を避ける。

    再試行は SDK 任せ（max_retries）にせず、ここで明示的に回す。SDK 内蔵の再試行は
    **stderr に何も出さない**ため、「無言で十数分待っている」状態が外から見えなかった。
    自前で回せば、何回目の再試行か・なぜ諦めたかを stderr へ出せる（サーバー経路では
    stderr がそのまま SSE の log に載り、画面から見える）。
    """
    key = load_key(api_key)
    if not key:
        raise RuntimeError("GROQ_API_KEY が未設定です（.env または環境変数）。")
    try:
        from groq import Groq
    except ImportError:
        raise RuntimeError("groq 未インストール。`pip install groq` を実行してください。")

    # max_retries=0: 再試行は下のループが担う（SDK に任せると無言で待つ時間が増えるだけ）。
    client = Groq(api_key=key, timeout=_build_timeout(), max_retries=0)
    audio_path = extract_audio_16k(input_path)
    deadline = time.monotonic() + GROQ_TOTAL_DEADLINE
    try:
        for attempt in range(1, GROQ_MAX_ATTEMPTS + 1):
            try:
                with open(audio_path, "rb") as f:
                    resp = client.audio.transcriptions.create(
                        file=(os.path.basename(audio_path), f.read()),
                        model=model,
                        response_format="verbose_json",
                        timestamp_granularities=["word", "segment"],
                        language=lang,
                    )
                break
            except Exception as e:
                status = _status_of(e)
                where = f"HTTP {status}" if status is not None else type(e).__name__
                if not is_retryable(e):
                    sys.stderr.write(
                        f"[WARN] Groq 再試行しても直らない失敗のため即座に諦めます（{where}）: {e}\n"
                    )
                    raise
                if attempt >= GROQ_MAX_ATTEMPTS:
                    sys.stderr.write(
                        f"[WARN] Groq 一時的な失敗が {GROQ_MAX_ATTEMPTS} 回続いたため諦めます（{where}）: {e}\n"
                    )
                    raise
                wait = GROQ_RETRY_BACKOFF[min(attempt - 1, len(GROQ_RETRY_BACKOFF) - 1)]
                remaining = deadline - time.monotonic()
                if remaining <= wait:
                    sys.stderr.write(
                        f"[WARN] Groq を待つ上限 {int(GROQ_TOTAL_DEADLINE)} 秒に達したため"
                        f"再試行せず諦めます（{where}）: {e}\n"
                    )
                    raise
                sys.stderr.write(
                    f"[WARN] Groq 一時的な失敗（{where}）。{wait:.0f} 秒後に再試行します "
                    f"（{attempt}/{GROQ_MAX_ATTEMPTS - 1} 回目・残り {int(remaining)} 秒）: {e}\n"
                )
                time.sleep(wait)
    finally:
        os.path.exists(audio_path) and os.remove(audio_path)
    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    return _to_schema(data)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Groq Whisper word-level transcriber")
    p.add_argument("input", help="入力 mp4/音声ファイル")
    p.add_argument("output", help="出力 transcript.json パス")
    p.add_argument("--lang", default=None, help="言語コード (例: ja)。未指定で自動判定")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Groq モデル。既定 {DEFAULT_MODEL}")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if not os.path.isfile(args.input):
        sys.stderr.write(f"[ERROR] 入力が見つかりません: {args.input}\n")
        return 2
    sys.stderr.write(f"[INFO] Groq backend model={args.model} 文字起こし開始: {args.input}\n")
    try:
        result = transcribe_groq(args.input, args.lang, args.model)
    except Exception as e:
        # 認証・ネットワーク等はここで分かりやすく落とす（サイレントフェイル禁止）
        sys.stderr.write(f"[ERROR] Groq 文字起こし失敗: {type(e).__name__}: {e}\n")
        return 4
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    sys.stderr.write(
        f"[OK] words={len(result['words'])} segments={len(result['segments'])} "
        f"duration={result['duration']}s → {args.output}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
