import fs from 'fs';
import path from 'path';

const AGENT_DIR = process.env.AGENT_DIR || path.resolve('..');
const RULES_PATH = path.join(AGENT_DIR, 'RULES.md');

// Parse all valid RULE IDs from RULES.md
// Looks for lines matching ### RULE-XXX pattern
export function loadValidRules() {
  try {
    const content = fs.readFileSync(RULES_PATH, 'utf-8');
    const matches = content.match(/###\s+(RULE-\d+)/g);
    if (!matches) return [];
    return matches.map(m => m.replace(/###\s+/, '').trim());
  } catch (err) {
    console.error('[RuleValidator] Failed to parse RULES.md:', err);
    return [];
  }
}

// Check if a rule ID returned by agent actually exists
export function isValidRule(ruleId, validRules) {
  return validRules.includes(ruleId);
}

// Parse rule addition dates for cooldown enforcement
// Returns map of { RULE-XXX: Date }
export function loadRuleDates() {
  try {
    const content = fs.readFileSync(RULES_PATH, 'utf-8');
    const sections = content.split(/###\s+RULE-\d+/);
    const ruleIds = content.match(/###\s+(RULE-\d+)/g) || [];

    const ruleDates = {};
    ruleIds.forEach((idMatch, i) => {
      const id = idMatch.replace(/###\s+/, '').trim();
      const section = sections[i + 1] || '';
      const dateMatch = section.match(/Added:\s+(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        ruleDates[id] = new Date(dateMatch[1]);
      }
    });

    return ruleDates;
  } catch (err) {
    console.error('[RuleValidator] Failed to parse rule dates:', err);
    return {};
  }
}

// Check if rule is within cooldown period (default 24h)
export function isRuleInCooldown(ruleId, ruleDates, cooldownHours = 24) {
  if (cooldownHours <= 0) return false;

  const addedDate = ruleDates[ruleId];
  if (!addedDate) return false;

  const now = new Date();
  const diffMs = now - addedDate;
  const diffHours = diffMs / (1000 * 60 * 60);

  return diffHours < cooldownHours;
}