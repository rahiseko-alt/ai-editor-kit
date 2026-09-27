---
name: video-edit-checklist
description: Use for the whole video-shorts editing loop in this repo, which runs entirely inside this Claude Code chat (no UI, no server). Trigger when the user hands over a video to edit (a file path, a dragged-in file, 「この動画を編集して」「編集して」「ダイジェストにして」「切り抜いて」「動画を渡すので」), when setting it up on a new PC (「使えるようにして」「セットアップ」「動かない」), when writing work/<jobId>/editorial_plan.json or keep.json for video-shorts/src/edit-job.mjs, before running "node src/edit-job.mjs new/plan/approve/render", and before reporting any edited video as finished, done, or 合格. Also triggers on 「区間を決めて」「検品して」「完成した」「レンダーして」「動画できた」. Covers four mandatory phases: checking the environment and registering the video, selecting segments by reading units.json in full, getting the user's approval of the script, and inspecting the rendered output against docs/合格条件.md. A clean process exit from edit-job.mjs is not evidence of anything — do not skip this skill because a command succeeded.
---

# 動画編集：チャットだけで完結する編集と、出力前検品

このスキルは `video-shorts`（このリポジトリ）専用。**UI・サーバー・ワーカー・見張りは無い。**
（2026-09-27 マスター指示「デスクトップ版の Claude Code だけで完結する形に。UIは不要。チャット欄の操作だけで完結」）
ユーザーはこのチャットに動画を渡し、台本案に返事をし、完成した動画の場所を受け取るだけ。
コマンドはすべてこのセッションが叩く。**ユーザーにターミナル操作を頼まない。**

正本は次の3ファイルで、このスキルは要点の地図でしかない。判断に迷ったら必ず原本を読むこと。

- **手順の正本**: `CLAUDE.md`
- **合否判定の正本**: `docs/合格条件.md`（唯一の正。動画を通しで見て判定する）
- **切り方の物理の正本**: `docs/編集についての虎の巻.md`

コマンドはすべて `video-shorts/` で実行する（`cd <リポジトリ>/video-shorts`）。

## フェーズ0：受け取りと準備

1. **動画のパスを受け取る。** ユーザーがファイルをチャット欄へドラッグすると、パスが入る。
   パスが無ければ「編集したい動画をこのチャット欄へドラッグしてください」とだけ頼む。
   向き（縦型か横型か）・字幕の有無・指示（「3分のダイジェストに」等）が言われていれば控える。
   **既定は横型・字幕なし**（2026-09-27 マスター決定「字幕無し状態で良い感じにする、を最初の目標に」）。
2. **そのPCで初めて動かすときは `node src/edit-job.mjs doctor` を実行する。**
   NG があれば、表示された「→」の手順をこのセッションが代わりに実行してよい（pip install・.env の作成など）。
   API キーだけはユーザー本人に取ってきてもらう（キーの値をチャットに貼ってもらい、このセッションが
   `video-shorts/.env` に書く。値を会話の中で繰り返さない）。
3. `node src/edit-job.mjs new "<動画のパス>" [--portrait] [--caption] [--instruction "<指示>"]` を実行する。
   文字起こし〜文節化まで進み、最後に `JOB_ID=<jobId>` が出る。数分かかるので、実行前に
   「文字起こし中です（数分かかります）」と一言伝える。

## フェーズ1：区間選定（台本案づくり）

`.runtime/work/<jobId>/units.json`（番号付き文節一覧）を**実際に全文読む**。「だいたいこの辺」で済ませない。

`docs/編集についての虎の巻.md`（どこで切るか）と `docs/合格条件.md`（何を残すか・何を捨てるか）
の基準に照らして、**このセッション自身が** `.runtime/work/<jobId>/editorial_plan.json` を直接書く。

`editorial_plan.json` の形式（正は `src/editorial/plan-schema.mjs`）:
`{"version": 1, "segments": [{"fromUnit": 開始文節番号, "toUnit": 終了文節番号, "role": "HOOK", "reason": "選んだ理由"}, ...], "applied": ["反映した指示"], "notApplied": ["反映できなかった指示とその理由"]}`
segments の並び順が動画での順番。**時刻は書かない**（書くと止まる）。

書いたら `node src/edit-job.mjs plan <jobId>` を実行する。台本案（採用する文節の本文を順番どおりに並べたもの）が出る。
問題があれば理由が出るので直す。

## フェーズ2：承認

**台本案をユーザーに見せ、承認をもらう。**（マスター指示原文「ユーザーに提示→ユーザー承認を経て編集作業の開始」）
見せるのは、ブロックごとの本文・捨てた部分・判断した点。読みやすさのため句読点を補ってよい。
返事が「承認」「OK」等なら `node src/edit-job.mjs approve <jobId>` → `node src/edit-job.mjs render <jobId>`。
直してほしいと言われたら編集案を直して `plan` からやり直す。**承認の前に render しない。**
承認後に編集案を書き換えると render は止まる（もう一度承認をもらう）。

字幕を付けない指定なのにジョブが字幕ありで登録されている場合は `render <jobId> --no-caption`。
音声が欠落する不具合の切り分けには `render <jobId> --no-snap --no-filler --out <名前>` などを使う
（完了記録を書かない試しの書き出し。承認は不要）。

## フェーズ3：出力前検品（完成報告の前・必須3点）

render が終わっても、それを「完成」としてユーザーに報告してはいけない。次の a〜c を**すべて**行う。
判断だけして出力を見ない、は禁止。出力は `.runtime/outputs/<jobId>/result.mp4`。

**a. 実際にコマを抜いて目で見る**
```
ffmpeg -ss <秒> -i <result.mp4> -frames:v 1 -y frame.png
```
その後 Read ツールで画像を確認する。文字起こしの結果を読むだけで済ませない。

**b. 完成した動画をもう一度文字起こしし直して、実際に焼かれた音声・話の繋がりを確認する**
```
python src/transcribe.py <result.mp4> <出力.json> --lang ja --backend auto
```
事前の判断（編集案）が正しく実現されているとは限らない。無音スナップ・フィラー除去は
判断のあとに動くので、最終結果は別工程で検証しないと、判断と実物のズレに気づけない。
繋ぎ目の前後（EDL の `renderedRanges` から位置を出す）は、数秒だけ切り出して単独でも文字起こしする。

**c. `docs/合格条件.md` の共通チェックリスト10項目＋該当するモード別追加チェックに、
実際に見た内容で1つずつ照合する**
コードの内部状態やログを根拠にしない。字幕なしなら項目10は対象外。
セッションは音を聴けないので、プツッというノイズの有無は「未確認」と正直に書き、ユーザーに実聴を頼む。

## 不合格の扱い

**1つでも NO があれば、直して a〜c を最初からやり直す。** 「直したはず」で終わらせない。
編集案を直した場合は、もう一度ユーザーの承認をもらってから render する。

## 報告

合格したら、完成した動画の**フルパス**と、長さ・残した内容・捨てた内容・照合結果（未確認の項目を含む）を短く伝える。
新しい作業を次々に提案しない（マスター指摘 2026-09-27「永遠に仕事を提案してるの？」）。

## サブエージェントへの委任は禁止（マスター指示 2026-08-19）

**フェーズ1・フェーズ3とも、サブエージェントに委任してはいけない。**
区間選定も検品も、この対話をしているセッション自身が、自分の目で行う。
丸投げ先はこの対話の文脈を持たないので、実物を見れば一瞬で気づけるミスを素通しする。
