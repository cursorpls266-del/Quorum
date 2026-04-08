import express from 'express';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { logRuleChange } from './logger.js';

// ── Config ─────────────────────────────────────────────
const GITHUB_PAT = process.env.GITHUB_PAT;
const VOTING_PERIOD_MS = parseInt(process.env.VOTING_PERIOD_MS || '60000');
const REPO_OWNER = 'Hari19hk';
const REPO_NAME = 'Quorum';

export function startWebhookServer({ client, governanceChannelId, secret }) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Verify GitHub webhook signature
  function verifySignature(req, res, next) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).send('No signature');

    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    if (sig !== digest) {
      console.log('[Webhook] Signature mismatch! Check your .env GITHUB_WEBHOOK_SECRET');
      return res.status(401).send('Invalid signature');
    }
    next();
  }

  // ── GitHub API helpers ─────────────────────────────────
  async function fetchPRDiff(prNumber) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `token ${GITHUB_PAT}`,
          Accept: 'application/vnd.github.v3.diff',
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return await res.text();
  }

  async function mergePR(prNumber) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_PAT}`,
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          commit_title: `Merge community-approved PR #${prNumber}`,
          merge_method: 'merge',
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Merge failed: ${res.status} — ${err}`);
    }
    return await res.json();
  }

  async function closePR(prNumber) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${GITHUB_PAT}`,
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({ state: 'closed' }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Close failed: ${res.status} — ${err}`);
    }
    return await res.json();
  }

  // ── Webhook handler ────────────────────────────────────
  app.post('/webhook', verifySignature, async (req, res) => {
    const { action, pull_request } = req.body;

    // ── STEP 1: PR Opened → Post vote to #governance ───
    if (action === 'opened' && pull_request) {
      const pr = pull_request;
      console.log(`[Webhook] PR #${pr.number} opened by ${pr.user.login} — starting vote`);

      try {
        // Fetch the diff from GitHub API
        const diff = await fetchPRDiff(pr.number);
        const diffPreview = diff.length > 1200
          ? diff.substring(0, 1200) + '\n...(truncated)'
          : diff;

        // Post the proposal to #governance
        const governanceChannel = await client.channels.fetch(governanceChannelId);
        const voteMsg = await governanceChannel.send(
          `📜 **Rule Amendment Proposed — PR #${pr.number}** by **${pr.user.login}**\n\n` +
          `**${pr.title}**\n\n` +
          `\`\`\`diff\n${diffPreview}\n\`\`\`\n\n` +
          `React with ✅ to **support** or ❌ to **oppose**.\n` +
          `Vote closes in **${VOTING_PERIOD_MS / 1000} seconds**.`
        );

        // Add the voting reactions
        await voteMsg.react('✅');
        await voteMsg.react('❌');

        console.log(`[Vote] Poll posted in #governance — closing in ${VOTING_PERIOD_MS / 1000}s`);

        // ── STEP 3: Wait and tally votes ───────────────
        setTimeout(async () => {
          try {
            // Re-fetch the message to get updated reaction counts
            const updatedMsg = await governanceChannel.messages.fetch(voteMsg.id);

            // Find reactions by iterating (Discord cache keys don't always match Unicode)
            let yesCount = 0;
            let noCount = 0;
            updatedMsg.reactions.cache.forEach((reaction) => {
              const emoji = reaction.emoji.name;
              if (emoji === '✅') yesCount = reaction.count;
              if (emoji === '❌') noCount = reaction.count;
            });

            // Subtract 1 from each to remove the bot's own seed reaction
            const yesVotes = Math.max(0, yesCount - 1);
            const noVotes = Math.max(0, noCount - 1);

            console.log(`[Vote] Raw counts: ✅ ${yesCount} ❌ ${noCount} | Human votes: ✅ ${yesVotes} ❌ ${noVotes}`);

            console.log(`[Vote] Results for PR #${pr.number}: ✅ ${yesVotes} vs ❌ ${noVotes}`);

            if (yesVotes > noVotes) {
              // ── STEP 4a: Community approved → Merge ──
              console.log(`[Vote] PR #${pr.number} APPROVED — merging via GitHub API`);
              await mergePR(pr.number);

              await governanceChannel.send(
                `✅ **PR #${pr.number} APPROVED** by community vote (${yesVotes} yes / ${noVotes} no).\n` +
                `The amendment has been merged. Quorum's rules are now updated.`
              );
            } else if (noVotes > yesVotes) {
              // ── STEP 4b: Community rejected → Close ──
              console.log(`[Vote] PR #${pr.number} REJECTED — closing via GitHub API`);
              await closePR(pr.number);

              await governanceChannel.send(
                `❌ **PR #${pr.number} REJECTED** by community vote (${yesVotes} yes / ${noVotes} no).\n` +
                `The proposed amendment has been closed.`
              );
            } else {
              // ── STEP 4c: Tie → Leave open for human review ──
              console.log(`[Vote] PR #${pr.number} TIED — leaving open for moderator review`);

              await governanceChannel.send(
                `⚖️ **PR #${pr.number} TIED** (${yesVotes} yes / ${noVotes} no).\n` +
                `The vote is inconclusive. A moderator must review and decide manually.\n` +
                `https://github.com/Hari19hk/Quorum/pull/${pr.number}`
              );
            }
          } catch (err) {
            console.error(`[Vote] Failed to process vote for PR #${pr.number}:`, err);
          }
        }, VOTING_PERIOD_MS);

        return res.status(200).send('vote started');

      } catch (err) {
        console.error('[Webhook] Failed to start vote:', err);
        return res.status(500).send('error');
      }
    }

    // ── STEP 5: PR Merged → git pull and announce ──────
    if (action === 'closed' && pull_request?.merged) {
      const pr = pull_request;
      console.log(`[Webhook] PR #${pr.number} merged — pulling latest rules`);

      try {
        // Pull latest RULES.md
        execSync('git pull origin main', { cwd: process.cwd() });

        // Get the diff for this PR
        const diff = execSync(
          `git diff ${pr.base.sha} ${pr.merge_commit_sha} -- RULES.md`
        ).toString();

        // Get new commit hash
        const newCommit = execSync('git rev-parse HEAD').toString().trim();

        // Post diff to #governance channel
        const governanceChannel = await client.channels.fetch(governanceChannelId);
        if (governanceChannel && diff) {
          const diffPreview = diff.length > 1500
            ? diff.substring(0, 1500) + '\n...(truncated)'
            : diff;

          await governanceChannel.send(
            `📜 **Community Rules Updated — PR #${pr.number}**\n` +
            `Proposed by: **${pr.user.login}**\n` +
            `Commit: \`${newCommit}\`\n\n` +
            `\`\`\`diff\n${diffPreview}\n\`\`\``
          );
        }

        // Log rule change
        logRuleChange({
          date: new Date().toISOString(),
          pr: `#${pr.number}`,
          proposedBy: pr.user.login,
          summary: pr.title,
          commit: newCommit,
        });

        console.log(`[Webhook] Rules updated to commit ${newCommit}`);
        res.status(200).send('ok');

      } catch (err) {
        console.error('[Webhook] Failed to process PR merge:', err);
        res.status(500).send('error');
      }

      return;
    }

    // Ignore all other events
    return res.status(200).send('ignored');
  });

  const PORT = process.env.WEBHOOK_PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[Webhook] Listening on port ${PORT}`);
    console.log(`[Webhook] Voting period: ${VOTING_PERIOD_MS / 1000}s`);
  });
}

// Polling fallback — pulls every 60s in case webhook fails
export function startPollingFallback() {
  setInterval(() => {
    try {
      execSync('git pull origin main', { cwd: process.cwd() });
      console.log('[Polling] Rules synced');
    } catch (err) {
      console.error('[Polling] git pull failed:', err);
    }
  }, 60000);
}