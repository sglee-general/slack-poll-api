const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');
const getRawBody = require('raw-body');

// Redis 설정
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

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
  await ack();
  try {
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
          ...[1, 2, 3, 4, 5].map(n => ({
            type: 'input',
            block_id: `b${n}`,
            optional: n > 2,
            element: { type: 'plain_text_input', action_id: `i${n}` },
            label: { type: 'plain_text', text: `선택지 ${n}` }
          }))
        ],
        submit: { type: 'plain_text', text: '시작' }
      }
    });
  } catch (e) { console.error("Modal Open Error:", e); }
});

app.view('poll_modal', async ({ ack, body, view, client }) => {
  // ★ 여기서 실패하면 안 되므로 ack()를 최우선 실행!
  await ack(); 
  
  try {
    const channelId = view.private_metadata;
    const topic = view.state.values.topic_block.topic_input.value;
    const options = [];
    for (let i = 1; i <= 5; i++) {
      const val = view.state.values[`b${i}`][`i${i}`].value;
      if (val) options.push(val);
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새로운 설문: ${topic}*` } },
      ...options.map((opt, i) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opt}*` },
        accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `v_${i}` }
      })),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '결과 보기' }, style: 'danger', action_id: 'end' }] }
    ];

    await client.chat.postMessage({ channel: channelId, blocks, text: topic });
  } catch (e) { console.error("Submission Error:", e); }
});

app.action(/^v_/, async ({ ack, body, action }) => {
  await ack();
  await redis.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
});

app.action('end', async ({ ack, body, client }) => {
  await ack();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes) return;
  const tally = {};
  Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
  let res = `📊 *결과*\n\n`;
  for (const [o, c] of Object.entries(tally)) res += `• *${o}*: ${c}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [Vercel 전용 하이재킹 핸들러] **/
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Server Active');

  try {
    // 슬랙이 보낸 원본 데이터를 가로채서 Bolt에게 직접 전달합니다.
    const rawBody = await getRawBody(req);
    req.rawBody = rawBody;
    req.body = require('querystring').parse(rawBody.toString());

    // 챌린지 응답 (필요 시)
    if (req.body.challenge) return res.status(200).send(req.body.challenge);

    // Bolt의 리시버에게 넘김
    return await receiver.requestHandler(req, res);
  } catch (error) {
    console.error("Handler Error:", error);
    return res.status(500).send("Internal Server Error");
  }
};

module.exports.config = { api: { bodyParser: false } };
