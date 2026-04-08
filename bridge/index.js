import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { execSync } from 'child_process';
import { query } from 'gitclaw';
import { logModerationAction } from './logger.js';
import {
  loadValidRules,
  loadRuleDates,
  isValidRule,
  isRuleInCooldown,
} from './ruleValidator.js';
import { startWebhookServer, startPollingFallback } from './webhook.js';

// ── Config ────────────────────────────────────────────────
const SHADOW_MODE = process.env.SHADOW_MODE === 'true';
const COOLDOWN_HOURS = parseInt(process.env.RULE_COOLDOWN_HOURS || '0');
import path from 'path';
const AGENT_DIR = process.env.AGENT_DIR || path.resolve('..');
const CONFIDENCE_THRESHOLD = 0.75;

// ── Discord client ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ── Rate limiting — per user cooldown ────────────────────
const cooldowns = new Map();

function isRateLimited(userId) {
  if (cooldowns.has(userId)) return true;
  cooldowns.set(userId, true);
  setTimeout(() => cooldowns.delete(userId), 2000);
  return false;
}

// ── Safe JSON parser ──────────────────────────────────────
function safeParse(raw) {
  try {
    // Strip any text outside JSON object
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');
    return JSON.parse(match[0]);
  } catch {
    return {
      action: 'ESCALATE',
      reason: 'Agent returned invalid JSON — human review required',
      confidence: 0,
    };
  }
}

// ── Build decision pathway string ────────────────────────
function buildPathway(result) {
  if (result.action === 'APPROVE') return 'No rule matched → APPROVE';
  if (result.action === 'ESCALATE') return `Ambiguous → ESCALATE: ${result.reason}`;
  return `Matched ${result.rule} → ${result.reason} → confidence ${result.confidence} → DELETE`;
}

// ── Main message handler ──────────────────────────────────
client.on('messageCreate', async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // Ignore DMs
  if (!message.guild) return;

  console.log(`[Bot] Received message from ${message.author.tag}: ${message.content}`);

  // Rate limit check
  if (isRateLimited(message.author.id)) {
    console.log(`[Bot] Rate limited user ${message.author.tag}`);
    return;
  }

  // Moderator exemption — defense in depth
  const isMod = message.member?.roles.cache.has(process.env.MOD_ROLE_ID);
  if (isMod) {
    console.log(`[Bot] Ignored moderator ${message.author.tag}`);
    return;
  }

  try {
    // Get current commit hash — version lock
    const commitHash = execSync('git rev-parse HEAD').toString().trim();

    // Load valid rules and dates for validation
    const validRules = loadValidRules();
    const ruleDates = loadRuleDates();

    // Call gitclaw agent
    let rawVerdict = '';
    for await (const msg of query({
      prompt: `
        RULES_COMMIT: ${commitHash}
        AUTHOR_ROLE: ${isMod ? 'moderator' : 'member'}
        MESSAGE: "${message.content}"

        Evaluate this Discord message against RULES.md.
        Return strict JSON only.
      `,
      dir: AGENT_DIR,
      model: 'ollama:gemma3:4b@http://127.0.0.1:11434/v1',
      allowedTools: [],
    })) {
      if (msg.type === 'delta' || msg.type === 'text') rawVerdict += msg.content || msg.text || '';
      if (msg.content && !msg.type) rawVerdict += msg.content; // fallback
    }

    // Safe parse
    const result = safeParse(rawVerdict);
    console.log('[Debug] Parsed Action:', result.action, '| Rule:', result.rule);
    
    const timestamp = new Date().toISOString();
    const pathway = buildPathway(result);
    console.log('[Debug] Pathway determined:', pathway);

    // Confidence check — escalate if below threshold
    if (
      result.action === 'DELETE' &&
      result.confidence !== undefined &&
      result.confidence < CONFIDENCE_THRESHOLD
    ) {
      result.action = 'ESCALATE';
      result.reason = `Low confidence (${result.confidence}) — escalated for human review`;
    }

    // Rule ID validation — catch hallucinations
    if (result.action === 'DELETE' && !isValidRule(result.rule, validRules)) {
      result.action = 'ESCALATE';
      result.reason = `Agent returned invalid rule ID "${result.rule}" — human review required`;
    }

    // Rule cooldown check
    if (result.action === 'DELETE' && isRuleInCooldown(result.rule, ruleDates, COOLDOWN_HOURS)) {
      result.action = 'ESCALATE';
      result.reason = `${result.rule} was added less than ${COOLDOWN_HOURS}h ago — human review required`;
    }

    console.log('[Debug] Final Action before execute:', result.action, '| Reason:', result.reason);

    // ── ATOMIC LOG FIRST — then act ──────────────────────
    logModerationAction({
      timestamp,
      userId: message.author.id,
      channelId: message.channel.id,
      message: message.content.substring(0, 100),
      verdict: result.action,
      rule: result.rule,
      reason: result.reason,
      commit: result.commit || commitHash,
      confidence: result.confidence,
      pathway,
    });

    // ── Act on verdict ────────────────────────────────────
    if (result.action === 'APPROVE') {
      // Do nothing
      return;
    }

    if (result.action === 'DELETE') {
      if (SHADOW_MODE) {
        console.log(`[SHADOW] Would delete: "${message.content}" — ${result.rule}`);
        return;
      }

      // Delete message
      await message.delete();

      // DM the user
      try {
        await message.author.send(
          `**Your message in #${message.channel.name} was removed.**\n\n` +
          `**Rule violated:** ${result.rule}\n` +
          `**Reason:** ${result.reason}\n` +
          `**Rules version:** \`${result.commit || commitHash}\`\n\n` +
          `This rule was approved by your community. ` +
          `You can verify it existed at this commit by running:\n` +
          `\`git show ${result.commit || commitHash}\`\n\n` +
          `**Think this rule is wrong?** Propose an amendment:\n` +
          `https://github.com/Hari19hk/Quorum/pulls\n` +
          `Open a PR titled: \`Amend ${result.rule}: [your proposed change]\``
        );
      } catch {
        console.log(`[DM] Could not DM user ${message.author.id}`);
      }
    }

    if (result.action === 'ESCALATE') {
      const modChannel = await client.channels.fetch(process.env.MOD_CHANNEL_ID);
      if (modChannel) {
        await modChannel.send(
          `⚠️ **Escalation Required**\n` +
          `**User:** <@${message.author.id}>\n` +
          `**Channel:** <#${message.channel.id}>\n` +
          `**Message:** "${message.content.substring(0, 200)}"\n` +
          `**Reason:** ${result.reason}\n` +
          `**Rules version:** \`${commitHash}\``
        );
      }
    }

  } catch (err) {
    console.error('[Bot] Error processing message:', err);

    // Fail safe — escalate to mods on any error
    try {
      const modChannel = await client.channels.fetch(process.env.MOD_CHANNEL_ID);
      if (modChannel) {
        await modChannel.send(
          `🚨 **Agent Error**\n` +
          `Failed to process message from <@${message.author.id}>.\n` +
          `Error: ${err.message}\n` +
          `Manual review required.`
        );
      }
    } catch {
      console.error('[Bot] Could not reach mod channel');
    }
  }
});

// ── Bot ready ─────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`[Quorum] Online as ${client.user.tag}`);
  console.log(`[Quorum] Shadow mode: ${SHADOW_MODE}`);
  console.log(`[Quorum] Agent dir: ${AGENT_DIR}`);

  // Start webhook server for GitHub PR merges
  startWebhookServer({
    client,
    governanceChannelId: process.env.GOVERNANCE_CHANNEL_ID,
    secret: process.env.GITHUB_WEBHOOK_SECRET,
  });

  // Start polling fallback
  startPollingFallback();
});

client.login(process.env.DISCORD_TOKEN);