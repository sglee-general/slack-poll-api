const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. Redis 설정 (REST 방식)
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 2. Receiver 설정 (Vercel 최적화)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [리스너 로직] **/

app.command('/설문', async ({ ack, body, client }) => {
  await ack(); // 즉시 응답
  try {
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `option_block_${num}`,
      optional: num > 2,
      element: { type: 'plain_text_input', action_id: `option_input_${num}` },
      label: { type: 'plain_text', text: `선택지 ${num}` }
    }));

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'poll_modal',
        private_metadata: body.channel_id,
        title: { type: 'plain_text', text: '📊 설문조사' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: { type: 'plain_text_input', action_id: 'topic_input' },
            label: { type: 'plain_text', text: '주제' }
          },
          ...optionBlocks
        ],
        submit: { type: 'plain_text', text: '시작' }
      }
    });
  } catch (e) { console.error("Modal Open Error:", e); }
});

app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
  try {
    const channelId = view.private_metadata;
    const topic = view.state.values.topic_block.topic_input.value;
    const options = [];
    for (let i = 1; i <= 5; i++) {
      const val = view.state.values[`option_block_${i}`][`option_input_${i}`].value;
      if (val && val.trim() !== '') options.push(val.trim());
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문: ${topic}*` } },
      ...options.map((opt, i) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opt}*` },
        accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `vote_${i}` }
      })),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기' }, style: 'danger', action_id: 'end_poll' }] }
    ];

    await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
  } catch (e) { console.error("Post Message Error:", e); }
});

app.action(/^vote_/, async ({ ack, body, action }) => {
  await ack();
  await redis.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
});

app.action('end_poll', async ({ ack, body, client }) => {
  await ack();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes) return;
  const tally = {};
  Object.values(votes).forEach(c => tally[c] = (tally[c] || 0) + 1);
  let res = `📊 *설문 결과*\n\n`;
  for (const [c, count] of Object.entries(tally)) res += `• *${c}*: ${count}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [Vercel 메인 핸들러] **/
module.exports = async (req, res) => {
  // Bolt가 요청을 처리하도록 넘김 (Challenge 등 모든 것을 Bolt가 알아서 함)
  try {
    return await receiver.requestHandler(req, res);
  } catch (error) {
    console.error("Receiver Error:", error);
    res.status(500).send("Internal Server Error");
  }
};

// Vercel 설정: Bolt가 직접 파싱하도록 bodyParser 비활성화
module.exports.config = {
  api: { bodyParser: false },
};
