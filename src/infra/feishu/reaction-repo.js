async function createReaction(feishuAdapter, { messageId, emojiType }) {
  const response = await feishuAdapter.createReaction({ messageId, emojiType });
  const reactionId = response?.data?.reaction_id || "";
  if (!reactionId) {
    throw new Error("Failed to add reaction: no reaction_id returned");
  }
  return { reactionId };
}

async function deleteReaction(feishuAdapter, { messageId, reactionId }) {
  if (!messageId || !reactionId) {
    return;
  }
  await feishuAdapter.deleteReaction({ messageId, reactionId });
}

module.exports = {
  createReaction,
  deleteReaction,
};
