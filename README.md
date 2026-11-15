# ai-editor-kit

AI エージェント（Claude Code など）に渡して使う動画編集エージェント。素材動画と要望を渡すと、文字起こし、編集、字幕付け、検品までをエージェントが実行する。

- 使う人向けの説明: [`取扱説明書.pdf`](取扱説明書.pdf)（A4 1枚）
- エージェント向けの指示: セットアップは [`SETUP-CLAUDE.md`](SETUP-CLAUDE.md)、編集規則は [`CLAUDE.md`](CLAUDE.md)

## 機能

- **ダイジェスト編集**: 会話動画を文字起こしし、要点区間だけを残して1本化する
- **組み立て（assemble）**: 複数素材から場面を切り出し、テロップ付きで1本化する。縦横混在はぼかし背景のピラーボックスでそろえる
- **合算（combine）**: 複数動画を寸法と音量をそろえてつなぎ、つなぎ目の検品画像を生成する
- **字幕校正ゲート**: 校正記録がない字幕は焼き付けできない。基準は Netflix 日本語 SDH（1行16字、1秒7字、最大2行）、機械検証する
- **用語辞書**: 決まった誤変換（例: 感色系→寒色系）を文字起こし直後に自動修正する
- **境界検品**: 全カットの境界画像を自動生成し、頭切れ、尻切れの判定材料にする
- **テンポ計測**: PySceneDetect でカット位置を検出し、シーン長、平均、中央値を出す
- **音声クリーニング**: DeepFilterNet で環境音を抑えた音声を作り、文字起こしに使う（本編の音声は不変）
- **BGM ビート同期**: librosa で拍を取り、場面の切り替わりを拍に合わせる
- **バージョン固定と照合**: 道具とバージョンは正本で指定し、`doctor` が実物と照合する。不一致は失敗として停止する

## 必要な環境

| 道具 | 指定 | 入手先 |
|---|---|---|
| Node.js | 24 系 | nodejs.org |
| Python | 3.12 系 | python.org |
| ffmpeg / ffprobe | 8.1 系 | ffmpeg.org |
| Python パッケージ | `video-shorts/requirements.txt` の固定版 | PyPI |
| deep-filter（任意） | 0.5.6 | Rikorose/DeepFilterNet の GitHub リリース |

バージョンの正本は `video-shorts/toolchain.json` と `video-shorts/requirements.txt`。AI エージェント側に、ファイル操作とコマンド実行の権限が要る。

## 導入

```bash
git clone https://github.com/rahiseko-alt/ai-editor-kit.git
cd ai-editor-kit/video-shorts
pip install -r requirements.txt
node src/edit-job.mjs doctor
```

`doctor` の全項目が OK になるまで編集を始めない。残りの段取りは [`SETUP-CLAUDE.md`](SETUP-CLAUDE.md)。

## 使い方

初回のみ、キット一式をエージェントに渡す。以後は次の繰り返し。

1. 素材動画を渡す
2. 要望を言葉で伝える（長さ、場面、BGM の有無）
3. エージェントが編集し、動画を出す
4. 動画を見て、修正を言葉で指示する（BGM 追加、場面差し替え、長さ調整、字幕修正）
5. エージェントが直して出し直す

主なコマンド（エージェントが実行する）:

| コマンド | 役割 |
|---|---|
| `doctor` | 道具とバージョンの点検 |
| `prepare` | 文字起こしと検証材料の作成 |
| `plan` / `approve` | 編集案の作成と承認 |
| `captions` | 字幕の生成と校正の照合 |
| `render` | 動画の書き出し（境界画像つき） |
| `inspect` | 境界画像の作り直し |
| `review` | 目視チェック材料（代表コマのシートと修正案） |
| `combine` | 複数動画の合算 |
| `assemble` | 複数素材の切り出しと組み立て |
| `tempo` | カット位置とテンポの計測 |

## 文書

- [`CLAUDE.md`](CLAUDE.md): 編集規則と合格条件の運用
- [`docs/編集についての虎の巻.md`](docs/編集についての虎の巻.md): 編集の型
- [`docs/合格条件.md`](docs/合格条件.md): 完成の判定基準
- [`docs/字幕校正の手順.md`](docs/字幕校正の手順.md): 字幕校正の手順
- [`docs/バージョン点検の手順.md`](docs/バージョン点検の手順.md): 月1回のバージョン点検の手順

## バージョン指定と点検

- 使用できるバージョンは正本の指定だけである
- エージェントが道具を更新、ダウングレード、代替することは禁止である
- 点検は月1回。正本に最終点検日を持ち、30日経過で `doctor` が点検時期を表示する。新版はテスト一式の合格時のみ指定を書き換える

## ライセンス

本体は MIT License。本文は [`LICENSE`](LICENSE)。

部品は各ライセンスに従う。本体と統一されていない。部品のコードと実行ファイルは同梱しておらず、導入時に使う側の環境へ取得される。部品を再配布する場合は、各ライセンスの条件（著作権表示とライセンス文を残すこと）に従うこと。

| 部品 | ライセンス |
|---|---|
| faster-whisper、ctranslate2、onnxruntime | MIT |
| av（PyAV）、PySceneDetect、numpy | BSD-3-Clause |
| librosa | ISC |
| groq、tokenizers | Apache-2.0 |
| DeepFilterNet | MIT / Apache-2.0（デュアル） |
| ffmpeg | LGPL-2.1 以降または GPL（ビルドによる。外部の道具として各自が導入する） |
