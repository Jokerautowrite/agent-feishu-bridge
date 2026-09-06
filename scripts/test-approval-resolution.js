const assert = require('assert/strict');
const { applyApprovalDecision } = require('../src/domain/approval/approval-service');
async function main() {
  const calls = [];
  const approval = { requestId: 'r', method: 'item/commandExecution/requestApproval', commandTokens: ['echo'] };
  const runtime = {
    inFlightApprovalRequestKeys: new Set(),
    pendingApprovalByThreadId: new Map([['t', approval]]),
    rememberApprovalPrefixForWorkspace: () => calls.push('remember'),
    codex: { sendResponse: async () => { calls.push('send'); throw Error('transport failed'); } },
  };
  const input = { threadId: 't', approval, command: 'approve', scope: 'workspace', workspaceRoot: '/synthetic' };
  const failed = await applyApprovalDecision(runtime, input);
  assert(failed.error);
  assert.deepEqual(calls, ['send'], 'failed reply must not persist authorization');
  assert(runtime.pendingApprovalByThreadId.has('t'));
  calls.length = 0;
  runtime.codex.sendResponse = async () => calls.push('send');
  const success = await applyApprovalDecision(runtime, input);
  assert.equal(success.error, null);
  assert.deepEqual(calls, ['send', 'remember']);
  assert(!runtime.pendingApprovalByThreadId.has('t'));
  console.log('Approval resolution tests passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
