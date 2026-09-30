/**
 * qwenwork/envStore.ts — .env 安全读写单点。
 *
 * 约定（沿用 capture-key 的安全基线）：
 * - 任何写入前必须通过 `git check-ignore .env` 守卫（防密钥进 git）
 * - 单行 upsert：只替换目标键所在行，其余行原样保留
 * - 文件权限 mode 0o600
 *
 * 消费方：QWEN_KEYS（refresh token 灾备/自举）、QWEN_MACHINE_ID（device-flow 设备标识）。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function envFilePath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), '.env');
}

/** git check-ignore .env 守卫：未被忽略返回 false（并打印原因）。所有写入操作的前置条件 */
export function assertEnvGitIgnored(repoRoot?: string): boolean {
  const root = repoRoot ?? process.cwd();
  try {
    execSync(`cd "${root}" && git check-ignore .env`, { stdio: 'ignore' });
    return true;
  } catch {
    console.error('❌ .env 未被 git 忽略！为防止泄露已中止写入。请先把 .env 加入 .gitignore');
    return false;
  }
}

/** 读 .env 中某个键（文件不存在 / 键缺失 / 空值 → null） */
export function readEnvValue(key: string, repoRoot?: string): string | null {
  try {
    const parsed = dotenv.parse(fs.readFileSync(envFilePath(repoRoot), 'utf8'));
    const v = parsed[key]?.trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 单行 upsert 某键（保留其他行，mode 600）。未通过 git-ignore 守卫返回 false */
export function writeEnvValue(key: string, value: string, repoRoot?: string): boolean {
  if (!assertEnvGitIgnored(repoRoot)) return false;
  const p = envFilePath(repoRoot);
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  const content = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n');
  fs.writeFileSync(p, content + '\n', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return true;
}
