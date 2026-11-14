# テンポ計測の材料作り（PySceneDetect の薄いラッパー）
#
# 使い方: python3 src/tempo_detect.py <動画パス>
# 標準出力へ JSON を1行で出す: {"duration": 秒, "scenes": [{"start": 秒, "end": 秒}, ...]}
# 統計の計算は src/tempo.mjs 側（純粋部分はそちらで単体テストする）。
# scenedetect が無い環境では、入れ方を添えて終了コード 2 で終わる。

import json
import sys


def main(argv):
    if len(argv) != 1:
        sys.stderr.write("使い方: python3 src/tempo_detect.py <動画パス>\n")
        return 2
    try:
        from scenedetect import SceneManager, open_video
        from scenedetect.detectors import ContentDetector
    except ImportError:
        sys.stderr.write(
            "scenedetect が入っていません。pip install scenedetect を実行してください。\n"
        )
        return 2
    video = open_video(argv[0])
    manager = SceneManager()
    manager.add_detector(ContentDetector())
    manager.detect_scenes(video)
    scenes = [
        {"start": round(start.seconds, 3), "end": round(end.seconds, 3)}
        for start, end in manager.get_scene_list()
    ]
    duration = round(video.duration.seconds, 3)
    if not scenes:
        scenes = [{"start": 0.0, "end": duration}]
    print(json.dumps({"duration": duration, "scenes": scenes}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
