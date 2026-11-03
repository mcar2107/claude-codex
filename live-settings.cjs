const { readSettings, validate } = require('./lib.cjs');
module.exports = class LiveSettings {
  name = 'local-codex-settings';
  async transformRequestIn(body) {
    const stored = readSettings();
    const settings = validate({
      model: process.env.CLAUDE_GPT_MODEL || stored.model,
      reasoningEffort: process.env.CLAUDE_GPT_EFFORT || stored.reasoningEffort
    });
    return {
      ...body,
      model: settings.model,
      reasoning: { ...body.reasoning, effort: settings.reasoningEffort, enabled: settings.reasoningEffort !== 'none' }
    };
  }
};
