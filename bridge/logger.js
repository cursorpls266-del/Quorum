import fs from 'fs';
import path from 'path';

const AGENT_DIR = process.env.AGENT_DIR || path.resolve('..');
const LOG_PATH = path.join(AGENT_DIR, 'memory/runtime/moderation-log.md');
const CHANGELOG_PATH = path.join(AGENT_DIR, 'memory/runtime/rule-changelog.md');

// Atomic append — always write BEFORE any Discord action
export function logModerationAction({
  timestamp,
  userId,
  channelId,
  message,
  verdict,
  rule,
  reason,
  commit,
  confidence,
  pathway,
}) {
  const entry = `| ${timestamp} | ${userId} | ${channelId} | ${verdict} | ${rule || '—'} | ${reason || '—'} | ${confidence || '—'} | ${commit} |\n`;
  const pathwayEntry = pathway
    ? `\n**Decision pathway:** ${pathway}\n`
    : '';

  try {
    fs.appendFileSync(LOG_PATH, entry + pathwayEntry);
    return true;
  } catch (err) {
    console.error('[Logger] Failed to write moderation log:', err);
    return false;
  }
}

export function logRuleChange({ date, pr, proposedBy, summary, commit }) {
  const entry = `| ${date} | ${pr} | ${proposedBy} | ${summary} | ${commit} |\n`;

  try {
    fs.appendFileSync(CHANGELOG_PATH, entry);
    return true;
  } catch (err) {
    console.error('[Logger] Failed to write rule changelog:', err);
    return false;
  }
}