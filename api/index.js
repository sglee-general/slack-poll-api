const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. Redis 설정 (아까 만든 KV 변수 사용)
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

/** [1] /설문 명령어: 창 띄우기 (성공한 부분) **/
app.command('/설문', async ({ ack, body, client }) => {
  await ack();
  try {
    const optionBlocks = [1, 2, 3, 4, 5].map(num => ({
      type: 'input',
      block_id: `b${num}`,
      optional: num > 2,
      element: { type: 'plain_text_input', action_id: `i${num}` },
      label: { type: 'plain_text', text: `선택지 ${num}` }
    }));

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'poll_modal',
        private_metadata: body.channel_id,
        title: { type: 'plain_text', text: '📊 설문조사 생성' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: { type: 'plain_text_input', action_id: 'topic_input' },
            label: { type: 'plain_text', text: '설문 주제' }
          },
          ...optionBlocks
        ],
        submit: { type: 'plain_text', text: '설문 시작' }
      }
    });
  } catch (e) { console.error(e); }
});

/** [2] 창에서 '시작(확인)'을 눌렀을 때 처리 (지금 안 되던 부분) **/
app.view('poll_modal', async ({ ack, body, view, client }) => {
  await ack(); // 슬랙에게 "확인 받았어!"라고 즉시 대답
  
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

    await client.chat.postMessage({ channel: channelId, blocks, text: `설문 시작: ${topic}` });
  } catch (e) { console.error(e); }
});

/** [3] 투표 버튼 및 종료 처리 **/
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
  let res = `📊 *최종 결과*\n\n`;
  for (const [o, c] of Object.entries(tally)) res += `• *${o}*: ${c}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [Vercel 핸들러] **/
module.exports = async (req, res) => {
  if (req.method === 'POST') return await receiver.requestHandler(req, res);
  res.status(200).send('API Online');
};
module.exports.config = { api: { bodyParser: false } };
