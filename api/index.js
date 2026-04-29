const { App, ExpressReceiver } = require('@slack/bolt');
const { Redis } = require('@upstash/redis');

// 1. 전역 변수로 선언하여 연결 재사용 (Cold Start 방지)
let appInstance;
let redisInstance;

function getRedis() {
  if (!redisInstance) {
    redisInstance = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return redisInstance;
}

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: false, // Vercel에서 즉각 응답을 보내기 위해 false로 변경
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** [리스너 로직 - 처리 속도 최우선] **/

app.command('/설문', async ({ ack, body, client }) => {
  await ack(); // 일단 대답부터!
  
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
            block_id: 'topic',
            element: { type: 'plain_text_input', action_id: 'i' },
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
  await ack(); // [확인] 누르자마자 슬랙을 안심시킴

  // 무거운 작업(메시지 전송)은 ack 이후에 비동기로 처리
  setTimeout(async () => {
    try {
      const channelId = view.private_metadata;
      const topic = view.state.values.topic.i.value;
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
    } catch (e) { console.error(e); }
  }, 0);
});

app.action(/^v_/, async ({ ack, body, action }) => {
  await ack();
  const redis = getRedis();
  await redis.hset(`poll:${body.message.ts}`, { [body.user.id]: action.value });
});

app.action('end', async ({ ack, body, client }) => {
  await ack();
  const redis = getRedis();
  const votes = await redis.hgetall(`poll:${body.message.ts}`);
  if (!votes) return;
  const tally = {};
  Object.values(votes).forEach(v => tally[v] = (tally[v] || 0) + 1);
  let res = `📊 *결과*\n\n`;
  for (const [o, c] of Object.entries(tally)) res += `• *${o}*: ${c}표\n`;
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: res } }], text: "종료" });
});

/** [Vercel 핸들러 - 가장 가벼운 구조] **/
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');
  
  // Bolt에게 핸들링을 넘기되 에러를 잡아서 200이라도 보냄
  try {
    return await receiver.requestHandler(req, res);
  } catch (e) {
    console.error("Handler Error:", e);
    if (!res.writableEnded) res.status(200).end(); 
  }
};

module.exports.config = { api: { bodyParser: false } };
