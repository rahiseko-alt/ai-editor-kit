// video-shorts src/editorial/approval.mjs — 編集案に対するマスターの承認を記録し、照合する。
//
// マスター指示原文の編集フロー「…ユーザーに提示→ユーザー承認を経て編集作業の開始」を、
// 手順の約束ではなくコードで守るためのもの。render は、承認した時点の編集案と
// 今の編集案が1文字でも違えば止まる（承認した内容と違う動画を出さない）。
//
// 承認の流れ:
//   node src/edit-job.mjs plan <jobId>     … 台本案を表示し work/<jobId>/script.txt に保存
//   （セッションが台本案をマスターに見せ、承認をもらう）
//   node src/edit-job.mjs approve <jobId>  … 承認を work/<jobId>/approval.json に記録
//   node src/edit-job.mjs render <jobId>   … 承認が今の編集案と一致するときだけ書き出す

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomically } from "../atomic-json.mjs";

export const APPROVAL_FILE = "approval.json";

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/** 承認を記録する。planFile は承認した編集案のファイル名、planText はその中身。 */
export function writeApproval(workDir, planFile, planText) {
  const record = { planFile: path.basename(planFile), sha256: sha256(planText), at: new Date().toISOString() };
  writeJsonAtomically(path.join(workDir, APPROVAL_FILE), record);
  return record;
}

/**
 * 承認が今の編集案と一致しているか。一致しなければ理由を返す（一致なら null）。
 */
export function approvalProblem(workDir, planFile, planText) {
  const p = path.join(workDir, APPROVAL_FILE);
  if (!fs.existsSync(p)) {
    return "編集案がまだ承認されていません。plan で台本案を見せ、承認をもらってから approve してください";
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    return `approval.json が読めません: ${err.message}`;
  }
  if (rec.planFile !== path.basename(planFile)) {
    return `承認したのは ${rec.planFile} ですが、今の編集案は ${path.basename(planFile)} です。もう一度承認をもらってください`;
  }
  if (rec.sha256 !== sha256(planText)) {
    return "承認したあとで編集案が書き換えられています。もう一度 plan で見せて承認をもらってください";
  }
  return null;
}
