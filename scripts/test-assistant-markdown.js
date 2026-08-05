#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  formatCardKitAssistantMarkdown,
  splitAssistantReplyForDisplay,
} = require("../src/shared/assistant-markdown");

function testThinkTagsAreRemoved() {
  const output = formatCardKitAssistantMarkdown("<think>private draft</think>Visible answer");
  assert.strictEqual(output, "private draftVisible answer");
  assert.doesNotMatch(output, /<\/?think>/);
}

function testFinalAnswerCanBeSeparatedWithGenericMarker() {
  const input = [
    "I am checking the repository and collecting public-safe context.",
    "",
    "结论是：",
    "",
    "- Main answer only",
    "- Process stays outside the final body",
  ].join("\n");

  const output = splitAssistantReplyForDisplay(input);
  assert.match(output.answerText, /^结论是：/);
  assert.doesNotMatch(output.answerText, /checking the repository/);
  assert.match(output.preAnswerText, /collecting public-safe context/);
}

testThinkTagsAreRemoved();
testFinalAnswerCanBeSeparatedWithGenericMarker();
console.log("assistant markdown fixtures ok");
