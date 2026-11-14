# BGM の拍位置の材料作り（librosa の薄いラッパー）
#
# 使い方: python3 src/beat.py <曲ファイル>
# 標準出力へ JSON を1行で出す: {"tempo": BPM, "beats": [秒, ...]}
# 拍への吸着計算は src/assemble.mjs 側（純粋部分はそちらで単体テストする）。
# librosa が無い環境では、入れ方を添えて終了コード 2 で終わる。

import json
import sys


def main(argv):
    if len(argv) != 1:
        sys.stderr.write("使い方: python3 src/beat.py <曲ファイル>\n")
        return 2
    try:
        import librosa
    except ImportError:
        sys.stderr.write(
            "librosa が入っていません。pip install librosa を実行してください。\n"
        )
        return 2
    y, sr = librosa.load(argv[0])
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beats = librosa.frames_to_time(beat_frames, sr=sr)
    import numpy as np
    tempo_val = float(np.atleast_1d(tempo)[0])
    print(json.dumps({"tempo": round(tempo_val, 2), "beats": [round(float(b), 3) for b in beats]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
