import express from 'express';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { logRuleChange } from './logger.js';

export function startWebhookServer({ client, governanceChannelId, secret }) {
  const app = express();
  app.use(express.json());

  // Verify GitHub webhook signature
  function verifySignature(req, res, next) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).send('No signature');

    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

    if (sig !== digest) return res.status(401).send('Invalid signature');
    next();
  }

  app.post('/webhook', verifySignature, async (req, res) => {
    const { action, pull_request } = req.body;

    // Only act on merged PRs
    if (action !== 'closed' || !pull_request?.merged) {
      return res.status(200).send('ignored');
    }

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
  });

  const PORT = process.env.WEBHOOK_PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[Webhook] Listening on port ${PORT}`);
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