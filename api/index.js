const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');
const getRawBody = require('raw-body');

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

/** [설문 로직 - 이전과 동일하지만 더 간결하게] **/
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
  } catch (e) { console.error(e); }
});

app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack();
  const channelId = view.private_metadata;
  const topic = view.state.values.topic_block.topic_input.value;
  const options = [];
  for (let i = 1; i <= 5; i++) {
    const val = view.state.values[`b${i}`][`i${i}`].value;
    if (val) options.push(val);
  }

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔔 *새 설문: ${topic}*` } },
    ...options.map((opt, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${opt}*` },
      accessory: { type: 'button', text: { type: 'plain_text', text: '투표' }, value: opt, action_id: `v_${i}` }
    })),
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '종료' }, style: 'danger', action_id: 'end' }] }
  ];
  await client.chat.postMessage({ channel: channelId, blocks, text: topic });
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
  for (const [opt, count] of Object.entries(tally)) res += `• *${opt}*: ${count}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [Vercel 전용 하이재킹 핸들러] **/
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('API is Online');

  // 핵심: raw-body를 사용하여 슬랙이 보낸 데이터를 직접 추출
  const rawBody = await getRawBody(req);
  
  // Bolt가 데이터를 읽을 수 있도록 가공해서 다시 넣어줌
  req.rawBody = rawBody;
  req.body = require('querystring').parse(rawBody.toString());

  // 슬랙 챌린지 대응
  if (req.body.challenge) return res.status(200).send(req.body.challenge);

  // Bolt에게 최종 전달
  return await receiver.requestHandler(req, res);
};

module.exports.config = { api: { bodyParser: false } };
