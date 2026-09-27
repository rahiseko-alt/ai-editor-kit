# セットアップ手順（Claude 向け）

ユーザーが「使えるようにして」「セットアップして」「動かない」と言ったら、この手順を上から実行する。
ユーザーは人間向けの `取扱説明書.pdf` しか読んでいない。**コマンドはすべてあなたが実行し、ユーザーに黒い画面の操作を頼まない。**
ユーザーに頼んでよいのは、あなたにしかできないこと（インストーラーや Windows の許可画面の「はい」、API キーの取得）だけ。

## ゴール

`video-shorts` フォルダで `node src/edit-job.mjs doctor` を実行し、すべて `OK` になること。

## 手順

### 1. 今の状態を調べる

PowerShell で次を実行し、何が足りないかを把握する。

```powershell
node -v; python --version; ffmpeg -version | Select-Object -First 1; winget --version
```

- `python` が Microsoft Store を開こうとする／`WindowsApps` のものしか無い場合は「Python は入っていない」とみなす。
- Node.js がある場合は、`cd video-shorts; node src/edit-job.mjs doctor` を先に実行して、足りない物の一覧を得る。

### 2. 足りないソフトを入れる

**入れる前に、何を入れるかをユーザーに1行ずつ伝えて了承を得る。** 了承を得たら winget で入れる。
途中で Windows の「このアプリがデバイスに変更を加えることを許可しますか？」が出たら、ユーザーに「はい」を押してもらう。

| 足りない物 | コマンド |
|---|---|
| Node.js | `winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements` |
| Python | `winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements` |
| ffmpeg | `winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements` |

- winget が無い（古い Windows 10 など）場合は、ユーザーに次のサイトから入れてもらう：Node.js は https://nodejs.org（LTS）、
  Python は https://www.python.org/downloads/（**最初の画面で「Add python.exe to PATH」にチェック**）、ffmpeg は https://www.gyan.dev/ffmpeg/builds/ 。
- **入れた直後は、今のシェルからは新しいソフトが見えない（PATH が古いまま）。** 次のどちらかで対処する。
  - 各コマンドの前で PATH を読み直す（シェルの状態は呼び出しごとに消えるので、毎回付ける）：
    `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
  - それでも見えなければ、ユーザーに「Claude のアプリを一度完全に終了して開き直し、もう一度『使えるようにして』と送ってください」と頼む。

### 3. 文字起こしの部品を入れる

Python が使えるようになったら、`video-shorts` フォルダで次を実行する（`python` が見つからなければ
`%LOCALAPPDATA%\Programs\Python\Python312\python.exe` を直接使う）。

```powershell
python -m pip install groq==1.6.0
```

- Groq のキーを用意しない（アカウントを作りたくない）とユーザーが言った場合だけ、代わりに
  `python -m pip install -r requirements.txt` でローカルの文字起こし（faster-whisper）を入れる。
  **文字起こしがかなり遅くなる**ことを先に伝える。

### 4. Groq のキーを設定する

ユーザーにキーを取ってきてもらう：https://console.groq.com でアカウントを作り、「API Keys」→「Create API Key」。
キー（`gsk_` で始まる文字列）がチャットに貼られたら、`video-shorts/.env` に次の1行を書く（ファイルが無ければ作る）。

```
GROQ_API_KEY=<貼られたキー>
```

- **キーの値を返信に書かない。** 「設定しました」とだけ伝える。
- `.env` は Git に入らない（`.gitignore` 済み）。

### 5. 確かめて報告する

```powershell
cd video-shorts; node src/edit-job.mjs doctor
```

すべて `OK` なら、ユーザーに次のように伝えて終える。

> 準備ができました。編集したい動画をこのチャット欄にドラッグして、「この動画を編集して」と送ってください。

`NG` が残っていれば、表示された「→」の内容に沿って直し、もう一度 doctor を実行する。
