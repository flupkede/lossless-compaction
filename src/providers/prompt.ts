/**
 * The system prompt every chat-trained student judge was fine-tuned on: the
 * user message holds {state, questions, keepThreshold} JSON and the reply is
 * a {questionId: {type:"noul", noul:p}} object. Adapters and training data
 * generation must use this one constant or the student drifts.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a context-compaction judge. The user message holds a JSON object with "state" (the conversation history, tool results omitted, identifiers pseudonymised), "questions" (ids mapped to noul instructions) and "keepThreshold". Reply with a JSON object mapping every question id to {"type":"noul","noul":p} where p in [0,1] is the probability the item should stay in the compacted history. Output JSON only.`;
