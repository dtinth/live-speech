/** Prompts for pointing an AI agent at a room's transcript over HTTP. */

export function agentReadPrompt(base: string) {
  return `The live transcript of a talk is at ${base}/transcript.txt (plain text, one segment per line). For structured data with segment ids and timings, GET ${base}/transcript.json. To follow along without re-reading everything, GET ${base}/events?after=<seq> with the last seq you saw.`;
}

/** Includes the room password, so only show it to people who have it. */
export function agentEditPrompt(base: string, password: string) {
  return `You can read and correct the live transcript of a talk over HTTP.

Read:
GET ${base}/transcript.json  — segments with id, startMs, endMs, text
GET ${base}/events?after=<seq>  — only what changed since <seq>

Correct a segment:
curl -X PATCH ${base}/segments/<id> \\
  -H "authorization: Bearer ${password}" \\
  -H "content-type: application/json" \\
  -d '{"text": "corrected text", "author": "<your name>"}'

Every edit is kept. GET ${base}/segments/<id> lists its versions; to undo, PATCH with {"revertTo": <version seq>} instead of text.

Keep the speaker's words; fix misrecognized words, technical terms and Thai/English spelling. Change only segments that are wrong.`;
}
